import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Plugins that are behind upstream carry a `url` the panel opens on click.
// Each fake plugin is a real clone one commit behind a local "upstream" repo;
// a git wrapper sends every fetch to that repo, so the checkout can keep a
// GitHub (or other) remote URL without touching the network.

const script = join(import.meta.dir, "../bin/update-center-status")
const realGit = Bun.which("git")
let dir, plugins, binDir, upstream

function git(cwd, ...args) {
  const p = Bun.spawnSync([realGit, "-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`)
  return p.stdout.toString().trim()
}

function plugin(id, remoteUrl) {
  const d = join(plugins, id)
  Bun.spawnSync([realGit, "clone", "--quiet", upstream, d])
  git(d, "reset", "--quiet", "--hard", "HEAD~1")
  git(d, "remote", "set-url", "origin", remoteUrl)
  return d
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "update-center-links-"))
  upstream = join(dir, "upstream")
  mkdirSync(upstream)
  git(upstream, "init", "--quiet")
  writeFileSync(join(upstream, "manifest.json"), '{"version":"1.0.0"}\n')
  git(upstream, "add", ".")
  git(upstream, "commit", "--quiet", "-m", "one")
  writeFileSync(join(upstream, "manifest.json"), '{"version":"1.1.0"}\n')
  git(upstream, "commit", "--quiet", "-am", "two")

  plugins = join(dir, "plugins")
  mkdirSync(plugins)
  plugin("a.github-ssh", "git@github.com:owner/plugin-a.git")
  plugin("b.github-https", "https://user:secret@github.com/owner/plugin-b.git")
  plugin("c.codeberg", "https://codeberg.org/owner/plugin-c.git")
  plugin("d.local", "/srv/plugins/d")

  binDir = join(dir, "bin")
  mkdirSync(binDir)
  const wrapper = join(binDir, "git")
  writeFileSync(wrapper, `#!/bin/bash
# git -C <dir> fetch --quiet <remote> HEAD  ->  fetch from the test upstream
if [[ $3 == fetch ]]; then exec "${realGit}" -C "$2" fetch --quiet "${upstream}" HEAD; fi
exec "${realGit}" "$@"
`)
  chmodSync(wrapper, 0o755)
})

function run(skip = "system,aur,mise,omarchy", env = {}, path = `${binDir}:${process.env.PATH}`) {
  const proc = Bun.spawnSync([script, "--skip", skip], {
    env: {
      ...env,
      PATH: path,
      HOME: dir,
      TMPDIR: process.env.TMPDIR || "/tmp",
      UPDATE_CENTER_PLUGINS_DIR: plugins,
      UPDATE_CENTER_PACMAN_LOG: join(dir, "none.log"),
      UPDATE_CENTER_PACMAN_LOCK: join(dir, "db.lck"),
      UPDATE_CENTER_UPDATE_LOCK: join(dir, "update.lock"),
    },
  })
  if (proc.exitCode !== 0 || proc.stdout.length === 0) throw new Error(`status script failed (${proc.exitCode}): ${proc.stderr}`)
  return JSON.parse(proc.stdout.toString())
}

describe("plugin change links", () => {
  test("GitHub plugins link to a compare of exactly the new commits; others to the repo; unknown to nothing", () => {
    const json = run()
    const byName = Object.fromEntries(json.sources.plugins.packages.map(p => [p.name, p]))
    const base = git(join(plugins, "a.github-ssh"), "rev-parse", "HEAD")
    const head = git(upstream, "rev-parse", "HEAD")

    expect(json.sources.plugins.ok).toBe(true)
    expect(byName["a.github-ssh"]).toEqual({
      name: "a.github-ssh", from: "1.0.0", to: "1 new change",
      url: `https://github.com/owner/plugin-a/compare/${base}...${head}`,
    })
    // Credentials in the remote never reach the link.
    expect(byName["b.github-https"].url).toBe(`https://github.com/owner/plugin-b/compare/${base}...${head}`)
    expect(byName["c.codeberg"].url).toBe("https://codeberg.org/owner/plugin-c")
    expect(byName["d.local"].url).toBe("")
  })

  test("AUR packages link to their AUR page; system and mise rows have no link", () => {
    // Stubbed checkupdates, yay and mise first on PATH; real tools after them.
    const stubBin = join(dir, "stub-bin")
    mkdirSync(stubBin, { recursive: true })
    for (const tool of ["checkupdates", "yay", "mise", "pacman"]) {
      try { symlinkSync(join(import.meta.dir, "stubs", tool), join(stubBin, tool)) } catch {}
    }
    const json = run("plugins,omarchy", {
      STUB_CHECKUPDATES_EXIT: "0",
      STUB_CHECKUPDATES_OUT: "librewolf 158.0.1_1-1 -> 159.0_1-1\\n",
      STUB_YAY_EXIT: "0",
      STUB_YAY_OUT: "zen-browser-bin 1.17-1 -> 1.18-1\\nlib32-gcc+libs 1-1 -> 2-1\\n",
      STUB_MISE_OUT: '{"node":{"current":"26.12.1","latest":"26.13.0","requested":"latest"}}',
    }, `${stubBin}:${process.env.PATH}`)

    expect(json.sources.aur.packages).toEqual([
      { name: "zen-browser-bin", from: "1.17-1", to: "1.18-1", url: "https://aur.archlinux.org/packages/zen-browser-bin" },
      { name: "lib32-gcc+libs", from: "1-1", to: "2-1", url: "https://aur.archlinux.org/packages/lib32-gcc%2Blibs" },
    ])
    expect(json.sources.system.packages).toEqual([{ name: "librewolf", from: "158.0.1_1-1", to: "159.0_1-1" }])
    expect(json.sources.mise.packages).toEqual([{ name: "node", from: "26.12.1", to: "26.13.0" }])
  })
})
