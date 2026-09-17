import { test, expect } from "@playwright/test"
import { normalizeDotfilesRepo, rootSshConfigFor } from "../../lib/dotfiles"

// Cloning a private dotfiles repo over SSH — the two gaps in `buildSetupScript` that Lite fills.
//
// Pure functions, imported directly: no database, no Docker, no HTTP. They exist as their own
// module precisely so this file can exercise them, since what they produce is shell text that
// only fails at the far end of a worker boot, in a step that is deliberately non-fatal.

test.describe("dotfiles over SSH", () => {
  test("an ssh:// URL is rewritten to the form the generator accepts", () => {
    // Left alone it would come out as `https://github.com/ssh://git@…`, which clones nothing.
    expect(normalizeDotfilesRepo("ssh://git@github.com/me/dotfiles.git")).toBe("git@github.com:me/dotfiles.git")
    expect(normalizeDotfilesRepo("ssh://gitlab.com/me/dotfiles.git")).toBe("git@gitlab.com:me/dotfiles.git")
  })

  test("every other form is passed through untouched", () => {
    // The generator already handles these, and rewriting them would be the bug in reverse.
    for (const url of [
      "git@github.com:me/dotfiles.git",
      "https://github.com/me/dotfiles",
      "http://example.test/me/dotfiles.git",
      "me/dotfiles",
      // A port has no scp-like equivalent — see the note in lib/dotfiles.ts.
      "ssh://git@example.test:2222/me/dotfiles.git",
    ]) {
      expect(normalizeDotfilesRepo(url)).toBe(url)
    }
  })

  test("blank settings mean no dotfiles at all, not an empty clone", () => {
    expect(normalizeDotfilesRepo(null)).toBeUndefined()
    expect(normalizeDotfilesRepo(undefined)).toBeUndefined()
    expect(normalizeDotfilesRepo("   ")).toBeUndefined()
  })

  test("root is given an identity when there is a key, and nothing when there isn't", () => {
    const withKey = rootSshConfigFor("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----")
    expect(withKey).toContain("/root/.ssh/config")
    // The key the generator writes for `vscode` one step earlier — root borrows it rather than
    // getting a second copy of a private key inside the container.
    expect(withKey).toContain("IdentityFile /home/vscode/.ssh/mp_user_key")
    expect(withKey).toContain("chmod 600 /root/.ssh/config")
    // Prepended to a script that runs under `set -e`: a `printf` of literal escapes, nothing that
    // can fail and take the whole boot down with it.
    expect(withKey).not.toContain("$(")

    // No key configured: the clone is left exactly as the generator wrote it.
    expect(rootSshConfigFor(undefined)).toBe("")
    expect(rootSshConfigFor("")).toBe("")
  })
})
