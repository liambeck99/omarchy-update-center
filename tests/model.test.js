import { describe, expect, test } from "bun:test"
const Model = require("../Model.js")

const DAY = 86400
const HOUR = 3600
const NOW = 1_800_000_000

describe("reminderPlan", () => {
  const plan = (lastUpdate, lastReminder, pending) =>
    Model.reminderPlan(NOW, lastUpdate, lastReminder, pending, 7, 24)

  test("nothing waiting is current and never reminds, however old the last update", () => {
    const p = plan(NOW - 30 * DAY, null, 0)
    expect(p.state).toBe("current")
    expect(p.notifyNow).toBe(false)
    expect(p.nextReminderAt).toBeNull()
  })

  test("updates waiting but not yet overdue schedule the reminder for the due date", () => {
    const p = plan(NOW - 3 * DAY, null, 5)
    expect(p.state).toBe("pending")
    expect(p.notifyNow).toBe(false)
    expect(p.nextReminderAt).toBe(NOW + 4 * DAY)
  })

  test("overdue with nothing sent yet reminds now and again a day later", () => {
    const p = plan(NOW - 8 * DAY, null, 5)
    expect(p.state).toBe("overdue")
    expect(p.overdueSeconds).toBe(DAY)
    expect(p.notifyNow).toBe(true)
    expect(p.nextReminderAt).toBe(NOW + DAY)
  })

  test("a reminder sent within the repeat window holds off until it elapses", () => {
    const p = plan(NOW - 9 * DAY, NOW - 2 * HOUR, 5)
    expect(p.notifyNow).toBe(false)
    expect(p.nextReminderAt).toBe(NOW + 22 * HOUR)
  })

  test("a reminder from a previous update cycle does not suppress the new one", () => {
    // Reminded 20 days ago, then updated 8 days ago: that old reminder is stale.
    const p = plan(NOW - 8 * DAY, NOW - 20 * DAY, 2)
    expect(p.notifyNow).toBe(true)
  })

  test("repeats once the repeat window has passed", () => {
    expect(plan(NOW - 10 * DAY, NOW - 25 * HOUR, 1).notifyNow).toBe(true)
  })

  test("an unknown last update never reminds", () => {
    expect(plan(null, null, 3)).toMatchObject({ state: "pending", notifyNow: false, nextReminderAt: null })
    expect(plan(null, null, 0).state).toBe("unknown")
  })
})

describe("status handling", () => {
  const source = (packages, extra = {}) => ({ enabled: true, available: true, ok: true, error: "", packages, ...extra })
  const pkg = (name) => ({ name, from: "1", to: "2" })
  const status = {
    sources: {
      system: source([pkg("a"), pkg("b")]),
      aur: source([pkg("c")]),
      mise: source([], { available: false }),
      omarchy: source([], { enabled: false })
    }
  }

  test("groups skips disabled and unavailable sources and keeps display order", () => {
    expect(Model.groups(status).map((g) => g.key)).toEqual(["system", "aur"])
    expect(Model.pendingCount(status)).toBe(3)
  })

  test("a failed source keeps its previous packages and is marked stale", () => {
    const next = { sources: { ...status.sources, aur: source([], { ok: false, error: "offline" }) } }
    const merged = Model.mergeStatus(status, next)
    expect(merged.sources.aur).toMatchObject({ ok: false, error: "offline", stale: true })
    expect(merged.sources.aur.packages.map((p) => p.name)).toEqual(["c"])
    expect(Model.hasErrors(merged)).toBe(true)
  })

  test("a partial failure uses its fresh packages and keeps the error shown", () => {
    // One plugin unreachable for good must not freeze the list: after a.widget
    // was updated, it drops off even though gone.widget still fails.
    const prev = { sources: { ...status.sources, plugins: source([pkg("a.widget"), pkg("b.widget")]) } }
    const plugins = source([pkg("b.widget")], { ok: false, error: "Couldn't reach: gone.widget", partial: true })
    const merged = Model.mergeStatus(prev, { sources: { ...status.sources, plugins } })
    expect(merged.sources.plugins.packages.map((p) => p.name)).toEqual(["b.widget"])
    expect(merged.sources.plugins).toMatchObject({ ok: false, error: "Couldn't reach: gone.widget" })
    expect(merged.sources.plugins.stale).toBeUndefined()
    expect(Model.hasErrors(merged)).toBe(true)
    // The error alone never reminds: plugins are out of the reminder count.
    expect(Model.reminderCount(merged)).toBe(3)
    expect(Model.pendingCount(merged)).toBe(4)
  })

  test("parseStatus rejects junk", () => {
    expect(Model.parseStatus("not json")).toBeNull()
    expect(Model.parseStatus("{}")).toBeNull()
    expect(Model.parseStatus(JSON.stringify(status))).not.toBeNull()
  })

  test("skipList follows the per-source settings", () => {
    expect(Model.skipList({ checkAur: false, checkMise: false, checkSystem: true })).toBe("aur,mise")
    expect(Model.skipList({ checkFlatpak: false })).toBe("flatpak")
    expect(Model.skipList({})).toBe("")
  })

  test("skipList includes plugins when turned off", () => {
    expect(Model.skipList({ checkPlugins: false })).toBe("plugins")
  })
})

describe("wording", () => {
  test("durations", () => {
    expect(Model.duration(30)).toBe("under a minute")
    expect(Model.duration(HOUR)).toBe("1 hour")
    expect(Model.duration(10 * DAY + 5)).toBe("10 days")
    expect(Model.ago(NOW, NOW - 2 * DAY)).toBe("2 days ago")
    expect(Model.ago(NOW, null)).toBe("unknown")
  })

  test("when() names nearby days", () => {
    const base = new Date(2026, 9, 30, 12, 0).getTime() / 1000
    expect(Model.when(base, base + 2 * HOUR)).toBe("today 14:00")
    expect(Model.when(base, base + DAY)).toBe("tomorrow 12:00")
    expect(Model.when(base, base + 5 * DAY)).toBe("Wed 4 Nov 12:00")
  })

  test("headline reflects the state", () => {
    const plan = (s, o = 0) => ({ state: s, overdueSeconds: o })
    expect(Model.headline(plan("current"), 0)).toBe("Up to date")
    expect(Model.headline(plan("pending"), 1)).toBe("1 update waiting")
    expect(Model.headline(plan("overdue", 3 * DAY), 4)).toBe("Overdue by 3 days")
  })
})

describe("reminderRow", () => {
  const base = new Date(2026, 9, 30, 12, 0).getTime() / 1000
  const row = (lastUpdate, pending, lastReminder = null) =>
    Model.reminderRow(base, Model.reminderPlan(base, lastUpdate, lastReminder, pending, 7, 24))

  test("scheduled reminder", () => {
    expect(row(base - 3 * DAY, 2)).toEqual({ label: "Next reminder", value: "Tue 3 Nov 12:00" })
  })
  test("up to date and not yet due says when reminders could start", () => {
    expect(row(base - 6 * DAY, 0)).toEqual({ label: "Reminders from", value: "tomorrow 12:00" })
  })
  test("up to date past the due date needs no reminder", () => {
    expect(row(base - 9 * DAY, 0).value).toBe("none, nothing waiting")
  })
  test("unknown last update", () => {
    expect(row(null, 2).value).toBe("off, last update unknown")
  })
})

describe("updateArgs", () => {
  const source = (packages) => ({ enabled: true, available: true, ok: true, error: "", packages })
  const pkg = [{ name: "x", from: "1", to: "2" }]
  const status = (sources) => ({
    sources: { system: source([]), aur: source([]), mise: source([]), flatpak: source([]), omarchy: source([]), plugins: source([]), ...sources },
  })

  test("nothing waiting asks for nothing", () => {
    expect(Model.updateArgs(status({}))).toEqual([])
  })
  test("only plugins waiting skips the system update", () => {
    expect(Model.updateArgs(status({ plugins: source(pkg) }))).toEqual(["--plugins"])
  })
  test("any non-plugin source means a system update", () => {
    for (const key of ["system", "aur", "mise", "omarchy"]) {
      expect(Model.updateArgs(status({ [key]: source(pkg) }))).toEqual(["--system"])
    }
  })
  test("both waiting asks for both", () => {
    expect(Model.updateArgs(status({ mise: source(pkg), plugins: source(pkg) }))).toEqual(["--system", "--plugins"])
  })
  test("only Flatpak waiting updates Flatpak, not the system", () => {
    expect(Model.updateArgs(status({ flatpak: source(pkg) }))).toEqual(["--flatpak"])
  })
  test("Flatpak waiting alongside the rest asks for each", () => {
    expect(Model.updateArgs(status({ aur: source(pkg), flatpak: source(pkg), plugins: source(pkg) }))).toEqual(["--system", "--plugins", "--flatpak"])
  })
})

describe("shell plugins", () => {
  const source = (packages) => ({ enabled: true, available: true, ok: true, error: "", packages })
  const pkg = (name, extra = {}) => ({ name, from: "1", to: "2", ...extra })
  const edited = (name) => pkg(name, { to: "1 new change, has local edits", localEdits: true })
  const status = (sources) => ({
    sources: { system: source([]), aur: source([]), mise: source([]), omarchy: source([]), plugins: source([]), ...sources },
  })
  // As the panel does it: plan on the reminder count, not the badge count.
  const plan = (s) => Model.reminderPlan(NOW, NOW - 30 * DAY, null, Model.reminderCount(s), 7, 24)

  test("waiting plugins count in the badge but never make you overdue", () => {
    const s = status({ plugins: source([pkg("a.widget"), pkg("b.widget")]) })
    expect(Model.pendingCount(s)).toBe(2)
    expect(Model.reminderCount(s)).toBe(0)
    expect(plan(s)).toMatchObject({ state: "current", notifyNow: false, nextReminderAt: null })
  })

  test("system updates waiting still remind, with plugins waiting too", () => {
    const s = status({ system: source([pkg("linux")]), plugins: source([pkg("a.widget")]) })
    expect(Model.pendingCount(s)).toBe(2)
    expect(Model.reminderCount(s)).toBe(1)
    expect(plan(s)).toMatchObject({ state: "overdue", notifyNow: true })
  })

  test("a plugin with local edits is listed but not counted", () => {
    const s = status({ plugins: source([pkg("a.widget"), edited("b.widget")]) })
    expect(Model.groups(s).find((g) => g.key === "plugins").packages).toHaveLength(2)
    expect(Model.pendingCount(s)).toBe(1)
  })

  test("a plugin with commits of its own is listed but not counted, nor updated", () => {
    const diverged = pkg("c.widget", { to: "1 new change, has commits not on upstream", localCommits: true })
    const s = status({ plugins: source([pkg("a.widget"), diverged]) })
    expect(Model.groups(s).find((g) => g.key === "plugins").packages).toHaveLength(2)
    expect(Model.pendingCount(s)).toBe(1)
    expect(Model.updateArgs(status({ plugins: source([diverged]) }))).toEqual([])
  })

  test("a plugin without an origin remote is listed but not counted, nor updated", () => {
    const noOrigin = pkg("d.widget", { to: "1 new change, no origin remote", noOrigin: true })
    const s = status({ plugins: source([pkg("a.widget"), noOrigin]) })
    expect(Model.groups(s).find((g) => g.key === "plugins").packages).toHaveLength(2)
    expect(Model.pendingCount(s)).toBe(1)
    expect(Model.updateArgs(status({ plugins: source([noOrigin]) }))).toEqual([])
  })

  test("a plugin with local files in the way is listed but not counted, nor updated", () => {
    const blocked = pkg("e.widget", { to: "1 new change, local files in the way", localFiles: true })
    const s = status({ plugins: source([pkg("a.widget"), blocked]) })
    expect(Model.groups(s).find((g) => g.key === "plugins").packages).toHaveLength(2)
    expect(Model.pendingCount(s)).toBe(1)
    expect(Model.updateArgs(status({ plugins: source([blocked]) }))).toEqual([])
  })

  test("the Plugins group's own number matches the badge", () => {
    const diverged = pkg("c.widget", { localCommits: true })
    const s = status({ plugins: source([pkg("a.widget"), edited("b.widget"), diverged]) })
    const group = Model.groups(s).find((g) => g.key === "plugins")
    expect(group.packages).toHaveLength(3)
    expect(group.count).toBe(1)
    expect(Model.groupSummary(group)).toBe("1")
    expect(Model.pendingCount(s)).toBe(1)
    const none = Model.groups(status({ plugins: source([edited("b.widget")]) })).find((g) => g.key === "plugins")
    expect(Model.groupSummary(none)).toBe("0")
    const failed = { ...group, ok: false }
    expect(Model.groupSummary(failed)).toBe("1 · couldn't check")
    expect(Model.groupSummary({ ...group, packages: [], count: 0 })).toBe("up to date")
    expect(Model.groupSummary({ ...group, packages: [], count: 0, ok: false })).toBe("couldn't check")
  })

  test("a plugin row shows its manifest name, else its folder id", () => {
    expect(Model.displayName(pkg("io.github.someone.start-menu", { title: "Simple Start Menu" }))).toBe("Simple Start Menu")
    expect(Model.displayName(pkg("io.github.someone.start-menu"))).toBe("io.github.someone.start-menu")
    expect(Model.displayName(pkg("a.widget", { title: "  " }))).toBe("a.widget")
    expect(Model.displayName(pkg("a.widget", { title: 7 }))).toBe("a.widget")
    expect(Model.displayName(pkg("linux"))).toBe("linux")
    expect(Model.displayName(null)).toBe("")
  })

  test("only edited plugins waiting: nothing counts and Update now has nothing to do", () => {
    const s = status({ plugins: source([edited("b.widget")]) })
    expect(Model.pendingCount(s)).toBe(0)
    expect(Model.updateArgs(s)).toEqual([])
    expect(Model.updateArgs(status({ system: source([pkg("linux")]), plugins: source([edited("b.widget")]) }))).toEqual(["--system"])
  })
})

describe("shouldNotify", () => {
  // Overdue for 30 days, never reminded: the reminder is due on timing alone.
  const source = (packages, extra = {}) => ({ enabled: true, available: true, ok: true, error: "", packages, ...extra })
  const pkg = (name) => ({ name, from: "1", to: "2" })
  const failed = (error, extra = {}) => source([], { ok: false, error, ...extra })
  const status = (sources) => ({
    sources: { system: source([]), aur: source([]), mise: source([]), flatpak: source([]), omarchy: source([]), plugins: source([]), ...sources },
  })
  const notify = (s, plan = Model.reminderPlan(NOW, NOW - 30 * DAY, null, Model.reminderCount(s), 7, 24)) =>
    Model.shouldNotify(plan, s)

  test("updates found by a clean check remind", () => {
    expect(notify(status({ system: source([pkg("linux")]) }))).toBe(true)
  })
  test("an unreachable plugin doesn't stop a reminder for system updates", () => {
    const plugins = failed("Couldn't reach: gone.widget")
    expect(notify(status({ system: source([pkg("linux")]), plugins }))).toBe(true)
    const partial = source([pkg("b.widget")], { ok: false, error: "Couldn't reach: gone.widget", partial: true })
    expect(notify(status({ system: source([pkg("linux")]), plugins: partial }))).toBe(true)
  })
  test("a source that keeps failing doesn't stop a reminder for the others", () => {
    expect(notify(status({ system: source([pkg("linux")]), flatpak: failed("Unable to load summary from remote flathub") }))).toBe(true)
  })
  test("updates only known from a failed check don't remind: they may already be installed", () => {
    const before = status({ system: source([pkg("linux")]) })
    const merged = Model.mergeStatus(before, status({ system: failed("offline") }))
    expect(Model.reminderCount(merged)).toBe(1)
    expect(notify(merged)).toBe(false)
  })
  test("nothing reminds when every check failed", () => {
    const before = status({ system: source([pkg("linux")]), aur: source([pkg("yay")]) })
    const offline = { sources: Object.fromEntries(Object.keys(before.sources).map((k) => [k, failed("offline")])) }
    expect(notify(Model.mergeStatus(before, offline))).toBe(false)
  })
  test("plugins alone never remind, fresh or not", () => {
    expect(notify(status({ plugins: source([pkg("a.widget")]) }))).toBe(false)
  })
  test("never before the reminder is due", () => {
    const s = status({ system: source([pkg("linux")]) })
    expect(notify(s, Model.reminderPlan(NOW, NOW - 2 * DAY, null, 1, 7, 24))).toBe(false)
    expect(notify(s, Model.reminderPlan(NOW, NOW - 30 * DAY, NOW - HOUR, 1, 7, 24))).toBe(false)
  })
})

describe("shellQuote", () => {
  test("survives one shell per quoting, spaces and quotes included", () => {
    const path = "/home/a b/it's/bin/update-all"
    const once = Bun.spawnSync(["bash", "-c", "printf %s " + Model.shellQuote(path)]).stdout.toString()
    expect(once).toBe(path)
    const twice = Model.shellQuote(Model.shellQuote(path))
    const inner = Bun.spawnSync(["bash", "-c", "printf %s " + twice]).stdout.toString()
    const outer = Bun.spawnSync(["bash", "-c", "printf %s " + inner]).stdout.toString()
    expect(outer).toBe(path)
  })
})
