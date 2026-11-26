import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model
import "ServiceLink.js" as ServiceLink

// The shell makes one widget (Panel.qml) per monitor but one service, so the
// work that must happen once lives here: the checks and their timers, the busy
// probe, the reminder and its state file, and the IPC target.
Scope {
  id: root

  // Set by the shell.
  property var shell: null

  readonly property string pluginId: "liambeck99.update-center"
  readonly property string pluginDir: decodeURIComponent(String(Qt.resolvedUrl(".")).replace(/^file:\/\//, ""))
  readonly property string statusScript: pluginDir + "bin/update-center-status"
  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/liambeck99.update-center"
  readonly property string updateScript: pluginDir + "bin/update-all"
  // With nothing pending (no reminder fires then) fall back to a plain system update.
  readonly property var updateArgs: {
    var a = Model.updateArgs(status)
    return a.length > 0 ? a : ["--system"]
  }
  readonly property string updateCommand: "omarchy-launch-floating-terminal-with-presentation " + Model.shellQuote(Model.shellQuote(updateScript)) + " " + updateArgs.join(" ")

  // The shell gives the bar entry's settings to the widgets only, so they pass
  // them in with configure(). The timers wait for them, so no check runs a
  // source that's switched off.
  property bool configured: false
  property int reminderDays: 7
  property int checkIntervalHours: 6
  property int reminderRepeatHours: 24
  property string skip: ""

  property var status: null
  property bool checking: false
  property bool busy: false
  property real lastCheckStartedAt: 0
  property var lastReminderAt: null
  property bool reminderStateLoaded: false
  // Set by "Update now" (expectUpdate): poll the update lock quickly until the
  // update starts and finishes, then check again.
  property bool awaitingUpdate: false
  property real awaitingSince: 0

  // Seconds, as of the last check or reminder evaluation. The panel keeps its
  // own clock for what it shows.
  property real now: Date.now() / 1000

  readonly property int pending: Model.pendingCount(status)
  // Plugins count in the badge but never make the reminder fire.
  readonly property int remindable: Model.reminderCount(status)
  readonly property var lastUpdate: status ? status.lastUpdate : null
  readonly property var plan: Model.reminderPlan(now, lastUpdate, lastReminderAt, remindable, reminderDays, reminderRepeatHours)

  function configure(settings) {
    root.reminderDays = settings.reminderDays
    root.checkIntervalHours = settings.checkIntervalHours
    root.reminderRepeatHours = settings.reminderRepeatHours
    root.skip = settings.skip
    root.configured = true
  }

  // Every caller (each monitor's panel, the timers, IPC) shares one run.
  function check() {
    if (statusProc.running) return
    root.checking = true
    root.lastCheckStartedAt = Date.now() / 1000
    statusProc.command = root.skip === "" ? [root.statusScript] : [root.statusScript, "--skip", root.skip]
    statusProc.running = true
  }

  // Opening the panel checks again, but not more than every couple of minutes.
  function checkIfStale() {
    if (Date.now() / 1000 - root.lastCheckStartedAt > 120) check()
  }

  // "Update now" was pressed in a panel.
  function expectUpdate() {
    root.awaitingUpdate = true
    root.awaitingSince = Date.now() / 1000
  }

  function applyStatus(text) {
    var next = Model.parseStatus(text)
    root.checking = false
    if (!next) return
    root.status = Model.mergeStatus(root.status, next)
    root.busy = next.busy === true
    root.now = Date.now() / 1000
    evaluateReminder()
  }

  function evaluateReminder() {
    if (!root.status || !root.reminderStateLoaded || root.busy) return
    root.now = Date.now() / 1000
    // Due, and a check that just worked found something to remind about.
    if (!Model.shouldNotify(root.plan, root.status)) return

    Quickshell.execDetached([
      "omarchy-notification-send", "-g", "", "-u", "normal",
      "Time to update",
      Model.notificationBody(root.now, root.lastUpdate, root.pending),
      "--exec", "omarchy-launch-floating-terminal-with-presentation", Model.shellQuote(root.updateScript)
    ].concat(root.updateArgs))
    rememberReminder(Math.floor(root.now))
  }

  function rememberReminder(at) {
    root.lastReminderAt = at
    saveProc.command = ["sh", "-c", 'mkdir -p "$1" && printf \'{"lastReminderAt":%s}\\n\' "$2" > "$1/state.json"', "sh", root.stateDir, String(at)]
    saveProc.running = true
  }

  function loadReminderState(text) {
    try {
      var state = JSON.parse(String(text || "{}"))
      root.lastReminderAt = typeof state.lastReminderAt === "number" ? state.lastReminderAt : null
    } catch (e) {
      root.lastReminderAt = null
    }
    root.reminderStateLoaded = true
    evaluateReminder()
  }

  function applyBusy(text) {
    var wasBusy = root.busy
    var isBusy = false
    try { isBusy = JSON.parse(String(text || "{}")).busy === true } catch (e) {}
    root.busy = isBusy

    if (wasBusy && !isBusy) {
      // An update just finished (from here, a terminal, or anywhere else).
      root.awaitingUpdate = false
      check()
    } else if (root.awaitingUpdate && !isBusy && Date.now() / 1000 - root.awaitingSince > 120) {
      // The terminal never took the update lock; stop polling fast.
      root.awaitingUpdate = false
    }
  }

  onSkipChanged: if (root.status) check()

  Component.onCompleted: ServiceLink.register(root)
  Component.onDestruction: ServiceLink.unregister(root)

  // The shell routes the panel's methods to the focused monitor's widget.
  IpcHandler {
    target: root.pluginId

    function open(): void { root.shell.summon(root.pluginId) }
    function close(): void { root.shell.hide(root.pluginId) }
    function show(): void { root.shell.summon(root.pluginId) }
    function hide(): void { root.shell.hide(root.pluginId) }
    function toggle(): void { root.shell.toggle(root.pluginId) }
    function refresh(): void { root.check() }
  }

  Process {
    id: statusProc
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.applyStatus(text) }
    onExited: function(exitCode) { if (exitCode !== 0) root.checking = false }
  }

  Process {
    id: busyProc
    command: [root.statusScript, "busy"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.applyBusy(text) }
  }

  Process { id: saveProc }

  FileView {
    path: root.stateDir + "/state.json"
    printErrors: false
    onLoaded: root.loadReminderState(text())
    onLoadFailed: root.loadReminderState("")
  }

  // First check shortly after login, once the network has had a moment.
  Timer { interval: 45000; running: root.configured; onTriggered: root.check() }

  Timer {
    interval: root.checkIntervalHours * 3600 * 1000
    running: root.configured
    repeat: true
    onTriggered: root.check()
  }

  // Cheap, offline: is an update running? Fast while one is expected. Also
  // asks right away on load: updating plugins (Update Center included)
  // reloads this plugin mid-update, and it should say "Updating…" at once.
  Timer {
    interval: root.awaitingUpdate || root.busy ? 3000 : 60000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: if (!busyProc.running) busyProc.running = true
  }

  // Reminders are due at a moment, not on a check; look every ten minutes
  // using the last result, no network needed.
  Timer { interval: 600000; running: true; repeat: true; onTriggered: root.evaluateReminder() }
}
