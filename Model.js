// Pure logic for Update Center: no QML, no clock reads (callers pass `now`
// in epoch seconds), so it runs unchanged under the shell and under bun test.

var SOURCES = [
  { key: "system", label: "System", setting: "checkSystem" },
  { key: "aur", label: "AUR", setting: "checkAur" },
  { key: "mise", label: "mise", setting: "checkMise" },
  { key: "omarchy", label: "Omarchy", setting: "checkOmarchy" },
  { key: "plugins", label: "Plugins", setting: "checkPlugins" }
]

var DAY = 86400
var HOUR = 3600

function parseStatus(text) {
  try {
    var status = JSON.parse(String(text || ""))
    return status && typeof status === "object" && status.sources ? status : null
  } catch (e) {
    return null
  }
}

// Fold a fresh check into the previous one: a source that failed this time
// keeps the packages it last reported, so a flaky network never makes pending
// updates look like they vanished.
function mergeStatus(previous, next) {
  if (!next) return previous
  if (!previous || !previous.sources) return next
  var merged = Object.assign({}, next, { sources: {} })
  for (var key in next.sources) {
    var fresh = next.sources[key]
    var old = previous.sources[key]
    merged.sources[key] = !fresh.ok && old && old.packages
      ? Object.assign({}, fresh, { packages: old.packages, stale: true })
      : fresh
  }
  return merged
}

// The sources to draw, in display order, with their pending packages.
function groups(status) {
  if (!status || !status.sources) return []
  var rows = []
  for (var i = 0; i < SOURCES.length; i++) {
    var source = status.sources[SOURCES[i].key]
    if (!source || !source.enabled || !source.available) continue
    rows.push({
      key: SOURCES[i].key,
      label: SOURCES[i].label,
      ok: source.ok,
      error: source.error || "",
      packages: source.packages || []
    })
  }
  return rows
}

function pendingCount(status) {
  var rows = groups(status)
  var total = 0
  for (var i = 0; i < rows.length; i++) total += rows[i].packages.length
  return total
}

function hasErrors(status) {
  var rows = groups(status)
  for (var i = 0; i < rows.length; i++) if (!rows[i].ok) return true
  return false
}

// Which sources the status script should skip, from the panel's settings.
function skipList(settings) {
  var skip = []
  for (var i = 0; i < SOURCES.length; i++) {
    if (settings && settings[SOURCES[i].setting] === false) skip.push(SOURCES[i].key)
  }
  return skip.join(",")
}

// When to nag. A reminder is only ever sent while updates are waiting and the
// last full upgrade is older than reminderDays; after the first it repeats
// every repeatHours until an upgrade happens.
//
//   state: "unknown" | "current" | "pending" | "overdue"
//   dueAt: when the last update turns overdue (null if unknown)
//   nextReminderAt: when the next notification would fire, or null when none
//                   is scheduled (nothing waiting, or last update unknown)
//   notifyNow: send a notification on this evaluation
function reminderPlan(now, lastUpdate, lastReminder, pending, reminderDays, repeatHours) {
  if (lastUpdate === null || lastUpdate === undefined) {
    return { state: pending > 0 ? "pending" : "unknown", dueAt: null, overdueSeconds: 0, nextReminderAt: null, notifyNow: false }
  }

  var dueAt = lastUpdate + reminderDays * DAY
  var repeat = repeatHours * HOUR
  var overdue = now >= dueAt

  if (pending === 0) {
    return { state: "current", dueAt: dueAt, overdueSeconds: 0, nextReminderAt: null, notifyNow: false }
  }

  if (!overdue) {
    return { state: "pending", dueAt: dueAt, overdueSeconds: 0, nextReminderAt: dueAt, notifyNow: false }
  }

  // A reminder sent before this overdue stretch began belongs to an older
  // update cycle and doesn't count.
  var remindedThisCycle = lastReminder !== null && lastReminder !== undefined && lastReminder >= dueAt
  var notifyNow = !remindedThisCycle || now - lastReminder >= repeat
  return {
    state: "overdue",
    dueAt: dueAt,
    overdueSeconds: now - dueAt,
    nextReminderAt: notifyNow ? now + repeat : lastReminder + repeat,
    notifyNow: notifyNow
  }
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s")
}

// "just now", "5 minutes", "3 hours", "10 days": the size of a duration.
function duration(seconds) {
  seconds = Math.max(0, Math.floor(seconds))
  if (seconds < 60) return "under a minute"
  if (seconds < HOUR) return plural(Math.floor(seconds / 60), "minute")
  if (seconds < DAY) return plural(Math.floor(seconds / HOUR), "hour")
  return plural(Math.floor(seconds / DAY), "day")
}

function ago(now, then) {
  if (then === null || then === undefined) return "unknown"
  if (now - then < 60) return "just now"
  return duration(now - then) + " ago"
}

var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function pad(n) { return n < 10 ? "0" + n : String(n) }

function clock(date) { return pad(date.getHours()) + ":" + pad(date.getMinutes()) }

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() }

// A future or past moment as people say it: "14:02", "tomorrow 09:14",
// "Tue 4 Nov 09:14". Uses local time.
function when(now, at) {
  var nowDate = new Date(now * 1000)
  var atDate = new Date(at * 1000)
  var days = Math.round((startOfDay(atDate) - startOfDay(nowDate)) / (DAY * 1000))
  if (days === 0) return "today " + clock(atDate)
  if (days === 1) return "tomorrow " + clock(atDate)
  if (days === -1) return "yesterday " + clock(atDate)
  return WEEKDAYS[atDate.getDay()] + " " + atDate.getDate() + " " + MONTHS[atDate.getMonth()] + " " + clock(atDate)
}

function headline(plan, pending) {
  if (plan.state === "overdue") return "Overdue by " + duration(plan.overdueSeconds)
  if (pending > 0) return plural(pending, "update") + " waiting"
  if (plan.state === "unknown") return "No updates waiting"
  return "Up to date"
}

// The panel's reminder row as {label, value}; short enough for one line.
function reminderRow(now, plan) {
  if (plan.nextReminderAt !== null) return { label: "Next reminder", value: when(now, plan.nextReminderAt) }
  if (plan.state === "current" && plan.dueAt !== null && now < plan.dueAt)
    return { label: "Reminders from", value: when(now, plan.dueAt) }
  if (plan.state === "current") return { label: "Reminder", value: "none, nothing waiting" }
  return { label: "Reminder", value: "off, last update unknown" }
}

function notificationBody(now, lastUpdate, pending) {
  return plural(pending, "update") + " waiting · last updated " + ago(now, lastUpdate) + ". Click to update."
}

// Flags for bin/update-all: which kinds of update are actually waiting.
function updateArgs(status) {
  var rows = groups(status)
  var system = false, plugins = false
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].packages.length === 0) continue
    if (rows[i].key === "plugins") plugins = true
    else system = true
  }
  var args = []
  if (system) args.push("--system")
  if (plugins) args.push("--plugins")
  return args
}

function tooltip(plan, pending, busy) {
  if (busy) return "Updating…"
  return headline(plan, pending)
}

if (typeof module !== "undefined") {
  module.exports = {
    SOURCES: SOURCES, parseStatus: parseStatus, mergeStatus: mergeStatus, groups: groups,
    pendingCount: pendingCount, hasErrors: hasErrors, skipList: skipList, reminderPlan: reminderPlan,
    duration: duration, ago: ago, when: when, headline: headline, reminderRow: reminderRow,
    notificationBody: notificationBody, tooltip: tooltip, updateArgs: updateArgs
  }
}
