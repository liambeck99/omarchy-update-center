import QtQuick
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model
import "ServiceLink.js" as ServiceLink

// Update Center: one bar icon and popup for every pending update.
//
// All checking happens in bin/update-center-status, which prints one JSON
// document. The shell makes one of these widgets per monitor and one service
// (Service.qml), which schedules the checks, keeps the last good result per
// source and reminds; this file passes it the settings and draws the panel.
Panel {
  id: root
  moduleName: "liambeck99.update-center"
  // The IPC target is the service's.
  manageIpc: false

  // A replacement bar's shell has no service for its widgets (null), so the
  // widget also follows the one registered in ServiceLink.js.
  readonly property var shellService: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
  property var linkedService: null
  property var serviceListener: null
  readonly property var service: shellService || linkedService

  readonly property int reminderDays: Math.max(1, setting("reminderDays", 7))
  readonly property int checkIntervalHours: Math.max(1, setting("checkIntervalHours", 6))
  readonly property int reminderRepeatHours: Math.max(1, setting("reminderRepeatHours", 24))
  readonly property string skip: Model.skipList(settings)
  readonly property bool showCount: setting("showCount", true) !== false
  readonly property bool highlightOverdue: setting("highlightOverdue", true) !== false
  readonly property bool barCount: showCount && pending > 0

  readonly property var serviceSettings: ({
    reminderDays: reminderDays,
    checkIntervalHours: checkIntervalHours,
    reminderRepeatHours: reminderRepeatHours,
    skip: skip
  })

  // Until there is a service, nothing is checked yet.
  readonly property var status: service ? service.status : null
  readonly property bool checking: service ? service.checking : false
  readonly property bool busy: service ? service.busy : false
  readonly property var lastReminderAt: service ? service.lastReminderAt : null
  property var expanded: ({})

  // Seconds; ticks so relative times stay true while the panel is open.
  property real now: Date.now() / 1000

  readonly property var groups: Model.groups(status)
  readonly property int pending: Model.pendingCount(status)
  // Plugins count in the badge but never make the reminder fire.
  readonly property int remindable: Model.reminderCount(status)
  readonly property var lastUpdate: status ? status.lastUpdate : null
  readonly property var plan: Model.reminderPlan(now, lastUpdate, lastReminderAt, remindable, reminderDays, reminderRepeatHours)
  readonly property bool overdue: plan.state === "overdue"

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color muted: Qt.darker(foreground, 1.4)

  function configureService() {
    if (root.service) root.service.configure(root.serviceSettings)
  }

  function check() {
    if (root.service) root.service.check()
  }

  function updateNow() {
    if (root.busy || !root.service) return
    if (root.bar) root.bar.run(root.service.updateCommand)
    else Quickshell.execDetached(["sh", "-c", root.service.updateCommand])
    root.service.expectUpdate()
    close()
  }

  function toggleGroup(key) {
    var next = Object.assign({}, root.expanded)
    next[key] = !next[key]
    root.expanded = next
  }

  Component.onCompleted: {
    root.serviceListener = function(service) { root.linkedService = service }
    ServiceLink.subscribe(root.serviceListener)
    root.linkedService = ServiceLink.current()
    configureService()
  }
  Component.onDestruction: ServiceLink.unsubscribe(root.serviceListener)
  onServiceChanged: configureService()
  onServiceSettingsChanged: configureService()

  onOpenedChanged: {
    if (!opened) return
    root.now = Date.now() / 1000
    if (root.service) root.service.checkIfStale()
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.now = Date.now() / 1000
  }

  // The count sits after the icon. BarIconButton can only draw a label before
  // its glyph, and anything in `text` is fitted into the icon box (shrinking
  // both, #12), so the count is its own bar button. The bar routes clicks to
  // whichever registered button is under the pointer, so both act the same.
  readonly property string countText: root.barCount && !button.vertical ? String(root.pending) : ""
  // Gap between the glyph and the count. The count repeats the icon slot's
  // side padding after itself, so the widget stays balanced.
  readonly property real countGap: Style.space(4)
  readonly property real iconPad: (Style.bar.iconSlot - Style.bar.iconCanvas) / 2

  implicitWidth: countText !== "" ? countButton.x + countButton.width : button.implicitWidth
  implicitHeight: button.implicitHeight

  function press(b) {
    if (b === Qt.RightButton) root.check()
    else root.toggle()
  }

  TextMetrics {
    id: countMetrics
    font.family: countButton.fontFamily
    font.pixelSize: countButton.fontSize
    text: root.countText
  }

  BarIconButton {
    id: button
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    bar: root.bar
    text: ""
    opacity: root.pending > 0 || root.busy ? 1 : 0.55
    active: root.overdue && root.highlightOverdue
    tooltipText: root.opened ? "" : Model.tooltip(root.plan, root.pending, root.busy)
    onPressed: function(b) { root.press(b) }
  }

  WidgetButton {
    id: countButton
    // The text is centred in the button, so with iconPad on both sides of it
    // the button starts iconPad before where the count should begin: a gap
    // after the glyph, which ends at iconPad + iconCanvas.
    x: Style.bar.iconCanvas + root.countGap
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    bar: root.bar
    text: root.countText
    fontSize: Style.bar.iconFont
    fixedWidth: countMetrics.advanceWidth + root.iconPad * 2
    active: button.active
    tooltipText: button.tooltipText
    onPressed: function(b) { root.press(b) }
  }

  KeyboardPanel {
    id: panel
    // The whole widget, icon and count, as when the count was a label.
    anchorItem: root
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
                    text: Model.groupSummary(group.modelData)
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
                    // A plugin shows the name from its manifest; its folder id
                    // is the tooltip.
                    readonly property bool hasTitle: text !== modelData.name
                    width: Math.min(implicitWidth, (group.width - Style.space(22)) * 0.5)
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    text: Model.displayName(modelData)
                    color: pkgLink.containsMouse && link !== "" ? Commons.Color.accent : root.foreground
                    font.underline: pkgLink.containsMouse && link !== ""
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall

                    MouseArea {
                      id: pkgLink
                      anchors.fill: parent
                      enabled: pkgName.link !== "" || pkgName.hasTitle
                      hoverEnabled: enabled
                      cursorShape: pkgName.link !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor
                      onClicked: {
                        if (pkgName.link === "") return
                        Quickshell.execDetached(["xdg-open", pkgName.link])
                        root.close()
                      }
                    }

                    PanelToolTip {
                      visible: pkgLink.containsMouse && pkgName.hasTitle
                      text: String(modelData.name)
                      fontFamily: root.fontFamily
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
