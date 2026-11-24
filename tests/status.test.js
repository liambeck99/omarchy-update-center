import { describe, expect, test, beforeAll } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs"
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
  for (const tool of ["bash", "jq", "date", "tac", "grep", "sed", "cut", "cat", "rm", "mktemp", "timeout", "flock", "env", "git", "basename", "head", "paste"]) {
    symlinkSync(Bun.which(tool), join(binDir, tool))
  }
})

function run(env = {}, args = [], { withTools = ["checkupdates", "yay", "mise", "flatpak", "pacman"] } = {}) {
  for (const tool of withTools) {
    try { symlinkSync(join(stubs, tool), join(binDir, tool)) } catch {}
  }
  const proc = Bun.spawnSync([script, ...args], {
    env: {
      PATH: binDir,
      UPDATE_CENTER_PACMAN_LOG: log,
      UPDATE_CENTER_PACMAN_LOCK: join(dir, "db.lck"),
      UPDATE_CENTER_UPDATE_LOCK: join(dir, "update.lock"),
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

  test("mise tools that were never installed don't count as pending", () => {
    const { json } = run({
      STUB_MISE_OUT:
        '{"node":{"current":"26.12.1","latest":"26.13.0","requested":"latest"},' +
        '"amp":{"current":null,"latest":"0.0.1","requested":"latest"},' +
        '"crush":{"current":"","latest":"1.2.0","requested":"latest"},' +
        '"qwen":{"latest":"0.9.0","requested":"latest"}}',
    })
    expect(json.sources.mise.ok).toBe(true)
    expect(json.sources.mise.packages).toEqual([{ name: "node", from: "26.12.1", to: "26.13.0" }])
  })

  test("nothing pending is ok everywhere, including yay's exit 1", () => {
    const { json } = run()
    for (const key of ["system", "aur", "mise", "flatpak", "omarchy"]) {
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

  test("flatpak updates pair the new version with the installed one", () => {
    const { json } = run({
      STUB_FLATPAK_UPDATES: "com.bambulab.BambuStudio\tstable\t2.9.0.10\norg.gnome.Platform\t50\t\norg.freedesktop.Platform.GL.default\t25.08\t26.2.5\n",
      STUB_FLATPAK_LIST: "com.bambulab.BambuStudio\tstable\t2.8.2.61\norg.gnome.Platform\t50\t\norg.freedesktop.Platform.GL.default\t25.08\t26.2.5\n",
    })
    expect(json.sources.flatpak).toMatchObject({ enabled: true, available: true, ok: true })
    expect(json.sources.flatpak.packages).toEqual([
      { name: "com.bambulab.BambuStudio", from: "2.8.2.61", to: "2.9.0.10" },
      { name: "org.gnome.Platform", from: "50", to: "new build" },
      { name: "org.freedesktop.Platform.GL.default", from: "26.2.5", to: "new build" },
    ])
  })

  test("a failing flatpak check reports its error", () => {
    const { json } = run({ STUB_FLATPAK_EXIT: "1", STUB_FLATPAK_ERR: "error: Unable to load summary from remote flathub" })
    expect(json.sources.flatpak.ok).toBe(false)
    expect(json.sources.flatpak.error).toContain("Unable to load summary")
    expect(json.sources.system.ok).toBe(true)
  })

  test("--skip disables sources without running them", () => {
    const { json } = run({ STUB_MISE_EXIT: "1", STUB_FLATPAK_EXIT: "1" }, ["--skip", "aur,mise,flatpak"])
    expect(json.sources.aur.enabled).toBe(false)
    expect(json.sources.mise).toMatchObject({ enabled: false, ok: true })
    expect(json.sources.flatpak).toMatchObject({ enabled: false, ok: true })
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
    expect(json.sources.flatpak).toMatchObject({ available: false, ok: true })
    expect(json.sources.omarchy.available).toBe(false)
    expect(json.sources.plugins).toMatchObject({ available: false, ok: true })
  })

  test("busy follows pacman's lock and a held omarchy-update lock", () => {
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
  })

  test("a missing pacman log gives a null last update", () => {
    expect(run({ UPDATE_CENTER_PACMAN_LOG: join(dir, "nope.log") }).json.lastUpdate).toBeNull()
  })

  describe("plugins", () => {
    const gitEnv = {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    }
    function git(cwd, ...args) {
      const proc = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv })
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
    }
    function commit(repo, file, text) {
      writeFileSync(join(repo, file), text)
      git(repo, "add", ".")
      git(repo, "commit", "-qm", file)
    }
    // An upstream repo and a plugin cloned from it, as omarchy plugin add does.
    function plugin(root, id, manifest = '{"version":"1.2.3"}') {
      const upstream = join(root, "upstream", id)
      mkdirSync(upstream, { recursive: true })
      git(upstream, "init", "-q", "-b", "main")
      commit(upstream, "manifest.json", manifest)
      git(root, "clone", "-q", upstream, join(root, "plugins", id))
      return { upstream, checkout: join(root, "plugins", id) }
    }
    function pluginsRoot() {
      const root = mkdtempSync(join(tmpdir(), "update-center-plugins-"))
      mkdirSync(join(root, "plugins"))
      return root
    }
    const check = (root, args) => run({ UPDATE_CENTER_PLUGINS_DIR: join(root, "plugins") }, args).json.sources.plugins

    test("lists only plugins that are behind, with their version and change count", () => {
      const root = pluginsRoot()
      plugin(root, "current")
      const one = plugin(root, "one.behind")
      commit(one.upstream, "a", "1")
      const two = plugin(root, "two.behind")
      commit(two.upstream, "a", "1")
      commit(two.upstream, "b", "2")
      const source = check(root)
      expect(source).toMatchObject({ enabled: true, available: true, ok: true })
      expect(source.packages).toEqual([
        { name: "one.behind", from: "1.2.3", to: "1 new change" },
        { name: "two.behind", from: "1.2.3", to: "2 new changes" },
      ])
    })

    test("a plugin's manifest name comes along as its title; the folder id stays its name", () => {
      const root = pluginsRoot()
      const named = plugin(root, "io.github.someone.start-menu", '{"name":"Simple Start Menu","version":"1.2.3"}')
      const spaced = plugin(root, "spaced", '{"name":"  Two\\nLines\\t ","version":"1.2.3"}')
      // A right-to-left override and a zero-width space: invisible format characters.
      const hidden = plugin(root, "hidden", '{"name":"Start\\u200bMenu\\u202e","version":"1.2.3"}')
      const nameless = plugin(root, "nameless")
      const same = plugin(root, "same", '{"name":"same","version":"1.2.3"}')
      const blank = plugin(root, "blank", '{"name":" ","version":"1.2.3"}')
      const notText = plugin(root, "not-text", '{"name":{"en":"x"},"version":"1.2.3"}')
      const broken = plugin(root, "broken", "{not json")
      for (const p of [named, spaced, hidden, nameless, same, blank, notText, broken]) commit(p.upstream, "a", "1")
      const byName = Object.fromEntries(check(root).packages.map(p => [p.name, p]))

      expect(byName["io.github.someone.start-menu"]).toEqual(
        { name: "io.github.someone.start-menu", title: "Simple Start Menu", from: "1.2.3", to: "1 new change" })
      // One line of plain text: whitespace runs and control characters become one space.
      expect(byName.spaced.title).toBe("Two Lines")
      // Invisible format characters can't make a name look odd or mimic another plugin.
      expect(byName.hidden.title).toBe("Start Menu")
      // No usable name, or the same as the id: no title, the panel shows the id.
      for (const id of ["nameless", "same", "blank", "not-text"]) expect(byName[id]).not.toHaveProperty("title")
      // An unreadable manifest still lists the plugin, under its id.
      expect(byName.broken).toEqual({ name: "broken", from: "installed", to: "1 new change" })
    })

    test("checking does not change the plugin's files or commit", () => {
      const root = pluginsRoot()
      const p = plugin(root, "behind")
      commit(p.upstream, "new-file", "1")
      expect(check(root).packages).toHaveLength(1)
      expect(existsSync(join(p.checkout, "new-file"))).toBe(false)
    })

    test("checking leaves FETCH_HEAD alone, so a plugin update in progress merges what it showed", () => {
      const root = pluginsRoot()
      const p = plugin(root, "behind")
      commit(p.upstream, "a", "1")
      git(p.checkout, "fetch", "-q", "origin", "HEAD")
      const fetchHead = () => readFileSync(join(p.checkout, ".git", "FETCH_HEAD"), "utf8")
      const shown = fetchHead()
      commit(p.upstream, "b", "2")
      expect(check(root).packages).toEqual([{ name: "behind", from: "1.2.3", to: "2 new changes" }])
      expect(fetchHead()).toBe(shown)
    })

    test("a plugin with local edits says so", () => {
      const root = pluginsRoot()
      const p = plugin(root, "edited")
      commit(p.upstream, "a", "1")
      writeFileSync(join(p.checkout, "manifest.json"), '{"version":"1.2.3","local":true}')
      expect(check(root).packages[0]).toMatchObject({ to: "1 new change, has local edits", localEdits: true })
    })

    test("an unreachable plugin is named without hiding the others", () => {
      const root = pluginsRoot()
      const gone = plugin(root, "gone")
      git(gone.checkout, "remote", "set-url", "origin", join(root, "does-not-exist"))
      const p = plugin(root, "behind")
      commit(p.upstream, "a", "1")
      const source = check(root)
      expect(source.ok).toBe(false)
      expect(source.partial).toBe(true)
      expect(source.error).toBe("Couldn't reach: gone")
      expect(source.packages.map(x => x.name)).toEqual(["behind"])
    })

    test("when no plugin can be reached the result is not partial", () => {
      const root = pluginsRoot()
      const gone = plugin(root, "gone")
      git(gone.checkout, "remote", "set-url", "origin", join(root, "does-not-exist"))
      const source = check(root)
      expect(source).toMatchObject({ ok: false, error: "Couldn't reach: gone", packages: [] })
      expect(source.partial).toBeUndefined()
    })

    test("a plugin with commits of its own says so and is flagged", () => {
      const root = pluginsRoot()
      const p = plugin(root, "forked")
      commit(p.upstream, "a", "1")
      commit(p.checkout, "mine", "local")
      const pkg = check(root).packages[0]
      expect(pkg).toMatchObject({ name: "forked", to: "1 new change, has local commits", localCommits: true })
      expect(pkg.localEdits).toBeUndefined()
    })

    test("a plugin without an origin remote is checked against its other remote, but flagged", () => {
      // omarchy plugin update only fetches origin, so Update now can't apply it.
      const root = pluginsRoot()
      const p = plugin(root, "renamed")
      commit(p.upstream, "a", "1")
      git(p.checkout, "remote", "rename", "origin", "upstream")
      const pkg = check(root).packages[0]
      expect(pkg).toMatchObject({ name: "renamed", to: "1 new change, no origin remote", noOrigin: true })
      expect(pkg.localEdits).toBeUndefined()
      expect(pkg.localCommits).toBeUndefined()
    })

    test("a missing origin remote is noted alongside local edits", () => {
      const root = pluginsRoot()
      const p = plugin(root, "renamed")
      commit(p.upstream, "a", "1")
      git(p.checkout, "remote", "rename", "origin", "upstream")
      writeFileSync(join(p.checkout, "manifest.json"), '{"version":"1.2.3","local":true}')
      expect(check(root).packages[0]).toMatchObject({
        to: "1 new change, has local edits, no origin remote", localEdits: true, noOrigin: true,
      })
    })

    test("a plugin with no remotes has nothing to check and is not an error", () => {
      const root = pluginsRoot()
      const p = plugin(root, "local")
      git(p.checkout, "remote", "remove", "origin")
      const source = check(root)
      expect(source).toMatchObject({ ok: true, error: "", packages: [] })
    })

    test("an untracked file alone is not a local edit", () => {
      const root = pluginsRoot()
      const p = plugin(root, "cached")
      commit(p.upstream, "a", "1")
      mkdirSync(join(p.checkout, "__pycache__"))
      writeFileSync(join(p.checkout, "__pycache__", "x.pyc"), "")
      expect(check(root).packages).toEqual([{ name: "cached", from: "1.2.3", to: "1 new change" }])
    })

    test("folders that are not git checkouts are ignored", () => {
      const root = pluginsRoot()
      mkdirSync(join(root, "plugins", "local-only"))
      expect(check(root)).toMatchObject({ available: false, ok: true, packages: [] })
    })

    test("a missing plugins folder is unavailable rather than failing", () => {
      const root = mkdtempSync(join(tmpdir(), "update-center-plugins-"))
      expect(check(root)).toMatchObject({ available: false, ok: true, packages: [] })
    })

    test("--skip plugins does not fetch", () => {
      const root = pluginsRoot()
      const p = plugin(root, "behind")
      commit(p.upstream, "a", "1")
      expect(check(root, ["--skip", "plugins"])).toMatchObject({ enabled: false, ok: true, packages: [] })
    })
  })
})
