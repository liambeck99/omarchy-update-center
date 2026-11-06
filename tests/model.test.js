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

  test("parseStatus rejects junk", () => {
    expect(Model.parseStatus("not json")).toBeNull()
    expect(Model.parseStatus("{}")).toBeNull()
    expect(Model.parseStatus(JSON.stringify(status))).not.toBeNull()
  })

  test("skipList follows the per-source settings", () => {
    expect(Model.skipList({ checkAur: false, checkMise: false, checkSystem: true })).toBe("aur,mise")
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
    sources: { system: source([]), aur: source([]), mise: source([]), omarchy: source([]), plugins: source([]), ...sources },
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
})
