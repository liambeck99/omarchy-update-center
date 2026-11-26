import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
const Model = require("../Model.js")

// Service.qml and Panel.qml need the shell to run, but their properties,
// functions and handlers are plain JavaScript: these lift them out of the
// files and run them against stand-ins for the shell's objects.
const read = file => readFileSync(join(import.meta.dir, "..", file), "utf8")
const ID = "liambeck99.update-center"
const NOW = Math.floor(Date.now() / 1000)

const overdueStatus = JSON.stringify({
  checkedAt: NOW,
  lastUpdate: NOW - 10 * 86400,
  busy: false,
  sources: { system: { enabled: true, available: true, ok: true, error: "", packages: [{ name: "linux", from: "1-1", to: "2-1" }] } },
})

// One QML engine: one copy of ServiceLink.js (a .pragma library) for every
// file, and the notifications sent.
function engine() {
  const link = read("ServiceLink.js").replace(".pragma library", "")
  const env = {
    Model,
    ServiceLink: new Function(`${link}\nreturn { current, register, unregister, subscribe, unsubscribe }`)(),
    Qt: { resolvedUrl: () => `file:///plugins/${ID}/` },
    notifications: [],
    Quickshell: {
      env: () => "/home/me",
      execDetached: argv => { if (argv[0] === "omarchy-notification-send") env.notifications.push(argv) },
    },
  }
  return env
}

// A QML root object: properties, bindings as getters, functions and handlers.
// settle() runs the onXChanged handlers whose property changed.
const QmlObject = {}
function instantiate(env, qml, locals = {}, base = {}) {
  const root = Object.assign(Object.create(QmlObject), base)
  locals.root = root
  const run = code => new Function("env", "locals", "root", `with (env) with (locals) with (root) { ${code} }`)(env, locals, root)
  const lines = qml.split("\n")
  const handlers = {}
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}(?:(readonly )?property \w+ (\w+)|(Component\.on\w+|on\w+Changed)): (.*)$/)
    if (!m) continue
    let expr = m[4]
    if (/\{$/.test(expr)) {
      while (!/^ {2}\}\)?$/.test(lines[i])) expr += "\n" + lines[++i]
      expr = expr.replace(/^ {2}\}/m, "}")
    }
    const body = expr.startsWith("{") ? `(function() ${expr})()` : `(${expr})`
    if (m[3]) handlers[m[3]] = () => run(body)
    else if (m[1]) Object.defineProperty(root, m[2], { get: () => run(`return ${body}`) })
    else root[m[2]] = run(`return ${body}`)
  }
  for (const [, name, args, body] of qml.matchAll(/^ {2}function (\w+)\(([^)]*)\) \{([\s\S]*?)\n {2}\}$/gm)) {
    root[name] = run(`return function(${args}) {${body}\n}`)
  }

  // Bindings rebuild plain objects, so those compare by content.
  const value = name => {
    const v = root[name]
    return v && Object.getPrototypeOf(v) === Object.prototype ? JSON.stringify(v) : v
  }
  const watched = Object.keys(handlers).filter(h => h.startsWith("on")).map(h => [h, h[2].toLowerCase() + h.slice(3, -7)])
  const seen = Object.fromEntries(watched.map(([, name]) => [name, value(name)]))
  root.settle = () => {
    for (let changed = true; changed;) {
      changed = false
      for (const [handler, name] of watched) {
        if (value(name) === seen[name]) continue
        seen[name] = value(name)
        handlers[handler]()
        changed = true
      }
    }
  }
  root.destroy = () => handlers["Component.onDestruction"]?.()
  handlers["Component.onCompleted"]?.()
  root.settle()
  return root
}

// Counts every time the code starts it.
const fakeProcess = () => ({
  starts: 0,
  on: false,
  get running() { return this.on },
  set running(on) { if (on) this.starts++; this.on = on },
})

function createService(env) {
  const procs = { statusProc: fakeProcess(), busyProc: fakeProcess(), saveProc: fakeProcess() }
  const service = Object.assign(instantiate(env, read("Service.qml"), procs), procs)
  service.loadReminderState("") // no state file yet
  return service
}

// A monitor's widget. A replacement bar's shell answers serviceFor() with null.
function createWidget(env, { serviceFor = () => null, settings = {} } = {}) {
  return instantiate(env, read("Panel.qml"), {}, {
    bar: { shell: { serviceFor }, run() {} },
    moduleName: ID,
    settings,
    opened: false,
    setting(name, fallback) { return this.settings[name] ?? fallback },
    close() { this.opened = false },
  })
}

function finishCheck(service) {
  service.statusProc.running = false
  service.applyStatus(overdueStatus)
}

describe("one service for every monitor", () => {
  test("two widgets cause one check and one reminder", () => {
    const env = engine()
    const service = createService(env)
    const widgets = [1, 2].map(() => createWidget(env, { serviceFor: id => (id === ID ? service : null) }))
    // Both panels open, and one gets a right-click.
    for (const widget of widgets) {
      widget.opened = true
      widget.settle()
    }
    widgets[1].check()
    expect(service.statusProc.starts).toBe(1)

    finishCheck(service)
    for (const widget of widgets) expect(widget.overdue).toBe(true)
    service.evaluateReminder() // the ten-minute look finds it already sent
    expect(env.notifications).toHaveLength(1)
  })

  test("under a replacement bar the widget follows the service through ServiceLink.js", () => {
    const env = engine()
    const widget = createWidget(env, { settings: { checkAur: false } })
    expect(widget.service).toBeNull()

    // A service that loads later is picked up and gets the widget's settings.
    const first = createService(env)
    widget.settle()
    expect(widget.service).toBe(first)
    expect(first.configured).toBe(true)
    expect(first.skip).toBe("aur")
    widget.check()
    finishCheck(first)
    expect(widget.pending).toBe(1)

    // A reload: the new service may load before the old one goes away.
    const second = createService(env)
    first.destroy()
    widget.settle()
    expect(widget.service).toBe(second)
    expect(second.configured).toBe(true)

    // Without a service the widget shows nothing checked and doesn't throw.
    second.destroy()
    widget.settle()
    expect(widget.service).toBeNull()
    expect(widget.pending).toBe(0)
    widget.check()
    widget.updateNow()
  })
})
