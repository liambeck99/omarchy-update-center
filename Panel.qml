import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Update Center: one bar icon and popup for every pending update.
//
// All checking happens in bin/update-center-status, which prints one JSON
// document; this file schedules it, keeps the last good result per source,
// decides when to remind (Model.reminderPlan), and draws the panel.
Panel {
  id: root
  moduleName: "liambeck99.update-center"
  ipcTarget: "liambeck99.update-center"
  // Own the IpcHandler so `refresh` can sit next to open/close/toggle.
  manageIpc: false

  readonly property string pluginDir: decodeURIComponent(String(Qt.resolvedUrl(".")).replace(/^file:\/\//, ""))
  readonly property string statusScript: pluginDir + "bin/update-center-status"
  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/liambeck99.update-center"
  readonly property string updateScript: pluginDir + "bin/update-all"
  // With nothing pending (no reminder fires then) fall back to a plain system update.
  readonly property var updateArgs: {
    var a = Model.updateArgs(status)
    return a.length > 0 ? a : ["--system"]
  }
  readonly property string updateCommand: "omarchy-launch-floating-terminal-with-presentation " + updateScript + " " + updateArgs.join(" ")

  readonly property int reminderDays: Math.max(1, setting("reminderDays", 7))
  readonly property int checkIntervalHours: Math.max(1, setting("checkIntervalHours", 6))
  readonly property int reminderRepeatHours: Math.max(1, setting("reminderRepeatHours", 24))
  readonly property string skip: Model.skipList(settings)
  readonly property bool showCount: setting("showCount", true) !== false
  readonly property bool highlightOverdue: setting("highlightOverdue", true) !== false
  readonly property bool barCount: showCount && pending > 0

  property var status: null
  property bool checking: false
  property bool busy: false
  property real lastCheckStartedAt: 0
  property var lastReminderAt: null
  property bool reminderStateLoaded: false
  // Set by "Update now": poll the update lock quickly until the update starts
  // and finishes, then check again.
  property bool awaitingUpdate: false
  property real awaitingSince: 0
  property var expanded: ({})

  // Seconds; ticks so relative times stay true while the panel is open.
  property real now: Date.now() / 1000

  readonly property var groups: Model.groups(status)
  readonly property int pending: Model.pendingCount(status)
  readonly property var lastUpdate: status ? status.lastUpdate : null
  readonly property var plan: Model.reminderPlan(now, lastUpdate, lastReminderAt, pending, reminderDays, reminderRepeatHours)
  readonly property bool overdue: plan.state === "overdue"

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color muted: Qt.darker(foreground, 1.4)

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
    if (!root.plan.notifyNow) return
    // Errors could mean the counts are stale; only nag on a clean read.
    if (Model.hasErrors(root.status)) return

    Quickshell.execDetached([
      "omarchy-notification-send", "-g", "", "-u", "normal",
      "Time to update",
      Model.notificationBody(root.now, root.lastUpdate, root.pending),
      "--exec", "omarchy-launch-floating-terminal-with-presentation", root.updateScript
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

  function updateNow() {
    if (root.busy) return
    if (root.bar) root.bar.run(root.updateCommand)
    else Quickshell.execDetached(["sh", "-c", root.updateCommand])
    root.awaitingUpdate = true
    root.awaitingSince = Date.now() / 1000
    close()
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

  function toggleGroup(key) {
    var next = Object.assign({}, root.expanded)
    next[key] = !next[key]
    root.expanded = next
  }

  onOpenedChanged: {
    if (!opened) return
    root.now = Date.now() / 1000
    checkIfStale()
  }

  onSkipChanged: if (root.status) check()

  IpcHandler {
    target: "liambeck99.update-center"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
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
  Timer { interval: 45000; running: true; onTriggered: root.check() }

  Timer {
    interval: root.checkIntervalHours * 3600 * 1000
    running: true
    repeat: true
    onTriggered: root.check()
  }

  // Cheap, offline: is an update running? Fast while one is expected.
  Timer {
    interval: root.awaitingUpdate || root.busy ? 3000 : 60000
    running: true
    repeat: true
    onTriggered: if (!busyProc.running) busyProc.running = true
  }

  // Reminders are due at a moment, not on a check; look every ten minutes
  // using the last result, no network needed.
  Timer { interval: 600000; running: true; repeat: true; onTriggered: root.evaluateReminder() }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.now = Date.now() / 1000
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barCount && !vertical ? " " + root.pending : ""
    slotSize: Style.bar.iconSlot * (root.barCount && !vertical ? (root.pending > 9 ? 2 : 1.6) : 1)
    opacity: root.pending > 0 || root.busy ? 1 : 0.55
    active: root.overdue && root.highlightOverdue
    tooltipText: root.opened ? "" : Model.tooltip(root.plan, root.pending, root.busy)
    onPressed: function(b) {
      if (b === Qt.RightButton) root.check()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onActivateRequested: root.updateNow()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        // ---------- Hero: icon · title/status · check now ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            text: ""
            color: root.overdue ? root.urgent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter

            RotationAnimation on rotation {
              running: root.checking || root.busy
              loops: Animation.Infinite
              from: 0; to: 360; duration: 1400
              onRunningChanged: if (!running) heroIcon.rotation = 0
            }
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: checkButton.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Update Center"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              textFormat: Text.PlainText
              text: (root.busy ? "Updating…" : (root.status ? Model.headline(root.plan, root.pending) : "Checking…")).toUpperCase()
              color: root.overdue && !root.busy ? root.urgent : root.muted
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }

          PanelActionButton {
            id: checkButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: ""
            tooltipText: root.checking ? "Checking…" : "Check now"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: !root.checking
            opacity: enabled ? 1 : 0.4
            onClicked: root.check()
          }
        }

        // ---------- When: last update and next reminder ----------
        Column {
          width: parent.width
          spacing: Style.spacing.labelGap

          InfoPair { label: "Last updated"; value: Model.ago(root.now, root.lastUpdate) }
          InfoPair {
            readonly property var row: Model.reminderRow(root.now, root.plan)
            label: row.label
            value: row.value
          }
        }

        PanelSeparator { foreground: root.foreground }

        // ---------- Pending updates, per source ----------
        Column {
          width: parent.width
          spacing: Style.space(4)

          PanelSectionHeader {
            text: "PENDING"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Text {
            visible: root.groups.length === 0
            width: parent.width
            text: root.status ? "Every source is switched off in settings." : "Looking for updates…"
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.Wrap
          }

          Repeater {
            model: root.groups

            Column {
              id: group
              required property var modelData
              readonly property bool canExpand: modelData.packages.length > 0
              readonly property bool isOpen: canExpand && root.expanded[modelData.key] === true
              readonly property int shown: Math.min(modelData.packages.length, 15)
              width: parent.width
              spacing: Style.space(2)

              Rectangle {
                width: parent.width
                implicitHeight: groupRow.implicitHeight + Style.space(8)
                radius: Style.space(4)
                color: groupMouse.containsMouse && group.canExpand
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                  : "transparent"

                Row {
                  id: groupRow
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.leftMargin: Style.space(4)
                  anchors.rightMargin: Style.space(4)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(6)

                  Text {
                    id: chevron
                    width: Style.space(12)
                    text: group.canExpand ? (group.isOpen ? "▾" : "▸") : ""
                    color: root.muted
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }

                  Text {
                    id: groupLabel
                    text: group.modelData.label
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: group.canExpand
                  }

                  Text {
                    width: parent.width - chevron.width - groupLabel.implicitWidth - parent.spacing * 2
                    horizontalAlignment: Text.AlignRight
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    text: {
                      var g = group.modelData
                      if (!g.ok) return (g.packages.length > 0 ? g.packages.length + " · " : "") + "couldn't check"
                      return g.packages.length > 0 ? String(g.packages.length) : "up to date"
                    }
                    color: !group.modelData.ok ? root.urgent : (group.canExpand ? root.foreground : root.muted)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                }

                MouseArea {
                  id: groupMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: group.canExpand ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: if (group.canExpand) root.toggleGroup(group.modelData.key)
                }
              }

              // The reason a source couldn't be checked, in full.
              Text {
                visible: !group.modelData.ok && group.modelData.error !== ""
                width: parent.width
                leftPadding: Style.space(22)
                rightPadding: Style.space(4)
                wrapMode: Text.Wrap
                maximumLineCount: 3
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: group.modelData.error
                color: root.urgent
                opacity: 0.85
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Repeater {
                model: group.isOpen ? group.modelData.packages.slice(0, group.shown) : []

                Row {
                  required property var modelData
                  width: group.width
                  spacing: Style.space(8)
                  leftPadding: Style.space(22)

                  Text {
                    id: pkgName
                    // Plugins carry a link to their new changes; older cached
                    // results and other sources have none.
                    readonly property string link: typeof modelData.url === "string" ? modelData.url : ""
                    width: Math.min(implicitWidth, (group.width - Style.space(22)) * 0.5)
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    text: modelData.name
                    color: pkgLink.containsMouse ? Commons.Color.accent : root.foreground
                    font.underline: pkgLink.containsMouse
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall

                    MouseArea {
                      id: pkgLink
                      anchors.fill: parent
                      enabled: pkgName.link !== ""
                      hoverEnabled: enabled
                      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                      onClicked: {
                        Quickshell.execDetached(["xdg-open", pkgName.link])
                        root.close()
                      }
                    }
                  }

                  Text {
                    width: group.width - Style.space(22) - pkgName.width - parent.spacing - Style.space(4)
                    horizontalAlignment: Text.AlignRight
                    elide: Text.ElideMiddle
                    textFormat: Text.PlainText
                    text: modelData.from + " → " + modelData.to
                    color: root.muted
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                }
              }

              Text {
                visible: group.isOpen && group.modelData.packages.length > group.shown
                leftPadding: Style.space(22)
                text: "and " + (group.modelData.packages.length - group.shown) + " more"
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }
          }
        }

        PanelSeparator { foreground: root.foreground }

        // ---------- Footer: last checked · update now ----------
        Item {
          width: parent.width
          implicitHeight: updateButton.implicitHeight

          Text {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.checking ? "Checking…"
              : (root.status ? "Last checked " + Model.when(root.now, root.status.checkedAt).replace(/^today /, "") : "Not checked yet")
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Button {
            id: updateButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: ""
            text: root.busy ? "Updating…" : "Update now"
            tooltipText: root.busy ? "An update is already running" : "Update everything listed"
            fontSize: Style.font.bodySmall
            foreground: root.foreground
            fontFamily: root.fontFamily
            bordered: true
            active: root.pending > 0 && !root.busy
            opacity: root.busy ? 0.5 : 1
            onClicked: root.updateNow()
          }
        }
      }
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""

    width: parent.width
    spacing: Style.space(8)

    Text {
      id: pairLabel
      textFormat: Text.PlainText
      text: label
      color: root.foreground
      opacity: 0.6
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      width: parent.width - pairLabel.implicitWidth - parent.spacing
      horizontalAlignment: Text.AlignRight
      elide: Text.ElideRight
      textFormat: Text.PlainText
      text: value
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }
}
