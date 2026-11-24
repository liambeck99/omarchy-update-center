import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Panel.qml needs the shell to run, so these only read its wiring.
const qml = readFileSync(join(import.meta.dir, "../Panel.qml"), "utf8")

describe("Panel wiring", () => {
  test("the busy poll runs as soon as the widget loads", () => {
    // Updating plugins (Update Center included) reloads the widget mid-update;
    // a fresh one must not wait a minute to show "Updating…".
    const timer = qml.match(/Timer \{[^}]*busyProc\.running = true[^}]*\}/)
    expect(timer).not.toBeNull()
    expect(timer[0]).toMatch(/triggeredOnStart:\s*true/)
  })

  test("the reminder plan counts without plugins", () => {
    expect(qml).toMatch(/Model\.reminderPlan\(now, lastUpdate, lastReminderAt, remindable,/)
    expect(qml).toMatch(/property int remindable: Model\.reminderCount\(status\)/)
  })

  test("a package name with a url opens it and closes the panel; without one it is plain text", () => {
    const name = qml.match(/id: pkgName[\s\S]*?\n {18}\}\n/)
    expect(name).not.toBeNull()
    expect(name[0]).toMatch(/link: typeof modelData\.url === "string" \? modelData\.url : ""/)
    expect(name[0]).toMatch(/cursorShape: pkgName\.link !== "" \? Qt\.PointingHandCursor/)
    expect(name[0]).toMatch(/font\.underline: pkgLink\.containsMouse && link !== ""/)
    expect(name[0]).toMatch(/if \(pkgName\.link === ""\) return\s*Quickshell\.execDetached\(\["xdg-open", pkgName\.link\]\)\s*root\.close\(\)/)
  })

  test("a package row shows the plugin's manifest name, with its folder id on hover", () => {
    const name = qml.match(/id: pkgName[\s\S]*?\n {18}\}\n/)
    expect(name).not.toBeNull()
    expect(name[0]).toMatch(/text: Model\.displayName\(modelData\)\n/)
    expect(name[0]).toMatch(/hasTitle: text !== modelData\.name/)
    // Hover works for a renamed row even when it has no link.
    expect(name[0]).toMatch(/enabled: pkgName\.link !== "" \|\| pkgName\.hasTitle/)
    expect(name[0]).toMatch(/PanelToolTip \{\s*visible: pkgLink\.containsMouse && pkgName\.hasTitle\s*text: String\(modelData\.name\)/)
  })

  test("the reminder decision is the model's, not a check of every source's errors", () => {
    const fn = qml.match(/function evaluateReminder\(\)[\s\S]*?\n  \}\n/)
    expect(fn).not.toBeNull()
    expect(fn[0]).toMatch(/if \(!Model\.shouldNotify\(root\.plan, root\.status\)\) return/)
    expect(fn[0]).not.toMatch(/hasErrors/)
  })

  test("group rows show the model's count, not every listed package", () => {
    expect(qml).toMatch(/text: Model\.groupSummary\(group\.modelData\)/)
    expect(qml).not.toMatch(/String\(g\.packages\.length\)/)
  })
})
