import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = join(import.meta.dir, "../bin/update-center-status")
const stubs = join(import.meta.dir, "stubs")
let dir, log, binDir

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "update-center-test-"))
  log = join(dir, "pacman.log")
  writeFileSync(log, [
    "[2026-10-01T09:00:00+0000] [PACMAN] starting full system upgrade",
    "[2026-10-20T10:15:00+0000] [PACMAN] starting full system upgrade",
    "[2026-10-21T08:00:00+0000] [ALPM] installed foo (1-1)",
  ].join("\n") + "\n")
  // Only the stubbed tools plus what the script itself needs, so a missing
  // stub reads as "tool not installed".
  binDir = join(dir, "bin")
  mkdirSync(binDir)
  for (const tool of ["bash", "jq", "date", "tac", "grep", "sed", "cut", "cat", "rm", "mktemp", "timeout", "flock", "env"]) {
    symlinkSync(Bun.which(tool), join(binDir, tool))
  }
})

function run(env = {}, args = [], { withTools = ["checkupdates", "yay", "mise", "pacman"] } = {}) {
  for (const tool of withTools) {
    try { symlinkSync(join(stubs, tool), join(binDir, tool)) } catch {}
  }
  const proc = Bun.spawnSync([script, ...args], {
    env: {
      PATH: binDir,
      UPDATE_CENTER_PACMAN_LOG: log,
      UPDATE_CENTER_PACMAN_LOCK: join(dir, "db.lck"),
      UPDATE_CENTER_UPDATE_LOCK: join(dir, "update.lock"),
      UPDATE_CENTER_PLUGIN_LOCK: join(dir, "plugin.lock"),
      UPDATE_CENTER_PLUGINS_DIR: join(dir, "plugins"),
      ...env,
    },
  })
  return { status: proc.exitCode, json: JSON.parse(proc.stdout.toString()), stderr: proc.stderr.toString() }
}

describe("update-center-status", () => {
  test("reports pending updates per source and splits Omarchy out of system", () => {
    const { json } = run({
      STUB_CHECKUPDATES_EXIT: "0",
      STUB_CHECKUPDATES_OUT: "librewolf 158.0.1_1-1 -> 159.0_1-1\\nomarchy 4.0.6-1 -> 4.0.7-1\\n",
      STUB_YAY_EXIT: "0",
      STUB_YAY_OUT: "zen-browser-bin 1.17-1 -> 1.18-1\\n",
      STUB_MISE_OUT: '{"node":{"current":"26.12.1","latest":"26.13.0","requested":"latest"}}',
    })
    expect(json.lastUpdate).toBe(Date.parse("2026-10-20T10:15:00Z") / 1000)
    expect(json.busy).toBe(false)
    expect(json.sources.system.packages).toEqual([{ name: "librewolf", from: "158.0.1_1-1", to: "159.0_1-1" }])
    expect(json.sources.omarchy.packages).toEqual([{ name: "omarchy", from: "4.0.6-1", to: "4.0.7-1" }])
    expect(json.sources.aur.packages[0].name).toBe("zen-browser-bin")
    expect(json.sources.mise.packages).toEqual([{ name: "node", from: "26.12.1", to: "26.13.0" }])
  })

  test("nothing pending is ok everywhere, including yay's exit 1", () => {
    const { json } = run()
    for (const key of ["system", "aur", "mise", "omarchy"]) {
      expect(json.sources[key]).toMatchObject({ ok: true, packages: [] })
    }
  })

  test("a failing source reports its error without affecting the others", () => {
    const { json } = run({
      STUB_CHECKUPDATES_EXIT: "1",
      STUB_CHECKUPDATES_ERR: "==> ERROR: Cannot fetch updates",
      STUB_YAY_ERR: "error: failed to get AUR data: dial tcp: lookup aur.archlinux.org: no such host",
    })
    expect(json.sources.system.ok).toBe(false)
    expect(json.sources.system.error).toContain("Cannot fetch updates")
    expect(json.sources.omarchy.ok).toBe(false)
    expect(json.sources.aur.ok).toBe(false)
    expect(json.sources.aur.error).toContain("failed to get AUR data")
    expect(json.sources.mise.ok).toBe(true)
  })

  test("--skip disables sources without running them", () => {
    const { json } = run({ STUB_MISE_EXIT: "1" }, ["--skip", "aur,mise"])
    expect(json.sources.aur.enabled).toBe(false)
    expect(json.sources.mise).toMatchObject({ enabled: false, ok: true })
    expect(json.sources.system.enabled).toBe(true)
  })

  test("tools that are not installed are unavailable rather than failing", () => {
    const fresh = mkdtempSync(join(tmpdir(), "update-center-bare-"))
    const bare = join(fresh, "bin")
    mkdirSync(bare)
    for (const tool of ["bash", "jq", "date", "tac", "grep", "sed", "cut", "cat", "rm", "mktemp", "timeout", "flock", "env"]) {
      symlinkSync(Bun.which(tool), join(bare, tool))
    }
    symlinkSync(join(stubs, "checkupdates"), join(bare, "checkupdates"))
    const proc = Bun.spawnSync([script], { env: { PATH: bare, UPDATE_CENTER_PACMAN_LOG: log, STUB_NO_OMARCHY: "1" } })
    const json = JSON.parse(proc.stdout.toString())
    expect(json.sources.aur).toMatchObject({ available: false, ok: true })
    expect(json.sources.mise).toMatchObject({ available: false, ok: true })
    expect(json.sources.omarchy.available).toBe(false)
  })

  test("busy follows pacman's lock, omarchy-update lock, and plugin lock", () => {
    expect(run({}, ["busy"]).json.busy).toBe(false)
    writeFileSync(join(dir, "db.lck"), "")
    expect(run({}, ["busy"]).json.busy).toBe(true)
    Bun.spawnSync(["rm", join(dir, "db.lck")])

    const lock = join(dir, "update.lock")
    writeFileSync(lock, "")
    const holder = Bun.spawn(["flock", lock, "sleep", "5"])
    Bun.sleepSync(200)
    expect(run({}, ["busy"]).json.busy).toBe(true)
    holder.kill()

    const pluginLock = join(dir, "plugin.lock")
    writeFileSync(pluginLock, "")
    const pHolder = Bun.spawn(["flock", pluginLock, "sleep", "5"])
    Bun.sleepSync(200)
    expect(run({}, ["busy"]).json.busy).toBe(true)
    pHolder.kill()
  })

  test("checks git-managed plugins and detects fast-forward updates", () => {
    try { symlinkSync(Bun.which("git"), join(binDir, "git")) } catch {}
    const pRoot = mkdtempSync(join(tmpdir(), "update-center-plugins-"))
    const remoteRepo = join(pRoot, "remote")
    const pluginsDir = join(pRoot, "plugins")
    const cloneDir = join(pluginsDir, "demo.widget")
    mkdirSync(remoteRepo, { recursive: true })
    mkdirSync(pluginsDir, { recursive: true })

    const gitEnv = {
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@e.st",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@e.st"
    }
    Bun.spawnSync(["git", "init", "-b", "main", remoteRepo])
    writeFileSync(join(remoteRepo, "manifest.json"), JSON.stringify({ id: "demo.widget", version: "1.0.0" }))
    Bun.spawnSync(["git", "-C", remoteRepo, "add", "manifest.json"])
    Bun.spawnSync(["git", "-C", remoteRepo, "commit", "-m", "v1"], { env: { ...process.env, ...gitEnv } })

    Bun.spawnSync(["git", "clone", remoteRepo, cloneDir])

    writeFileSync(join(remoteRepo, "manifest.json"), JSON.stringify({ id: "demo.widget", version: "1.1.0" }))
    Bun.spawnSync(["git", "-C", remoteRepo, "add", "manifest.json"])
    Bun.spawnSync(["git", "-C", remoteRepo, "commit", "-m", "v2"], { env: { ...process.env, ...gitEnv } })

    const { json } = run({ UPDATE_CENTER_PLUGINS_DIR: pluginsDir })
    expect(json.sources.plugins).toMatchObject({
      enabled: true,
      available: true,
      ok: true,
      packages: [{ name: "demo.widget", from: "1.0.0", to: "1.1.0" }]
    })
  })

  test("a missing pacman log gives a null last update", () => {
    expect(run({ UPDATE_CENTER_PACMAN_LOG: join(dir, "nope.log") }).json.lastUpdate).toBeNull()
  })
})
