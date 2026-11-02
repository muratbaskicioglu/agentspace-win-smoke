# agentspace-win-smoke

Install smoke tests for the public AgentSpace releases (Windows, macOS and Linux).

Each workflow downloads a published file from
[agentspace-releases](https://github.com/muratbaskicioglu/agentspace-releases),
checks its sha256, then installs, launches, closes and uninstalls it on a
throwaway GitHub-hosted runner.

- No account, no sign-in, no secrets. The app stops at its sign-in screen.
- **Repo rule:** no app source code and no unreleased build ever goes into this
  repo, not even minified. Only a published installer (downloaded from
  agentspace-releases, sha256 checked) and test scripts. Tests that need
  unreleased code run in the private repo.
- Manual runs only (`workflow_dispatch`).

| Workflow | Runners | What it checks |
|---|---|---|
| `clean-profile.yml` | macos-15, macos-26, xcode-27 (macOS 27 preview), macos-15-intel, windows-11-arm, windows-2025 | clean profile: install → first launch to the sign-in screen → close → uninstall, a frame per window step; the Antigravity hook command and the memory brake, run with the installed app's own code |
| `linux-clean-profile.yml` | ubuntu-22.04, ubuntu-24.04, ubuntu-26.04, ubuntu-24.04-arm, ubuntu-26.04-arm | Linux AppImage clean profile: copy to ~/Applications + chmod +x → first launch to the sign-in screen → close → nothing left 60 s later → delete; records FUSE 2 and the user-namespace sandbox on each Ubuntu, and runs the app's own modules |
| `smoke.yml` | windows-latest | Windows install → launch → close → uninstall |
| `engines.yml` | windows-latest | engine panes (Codex, OpenCode, Claude Code) with the installed app's own modules |
| `seal.yml` | macos-15, macos-26, windows-2025 | bundle seal: does the running app write into its own bundle / install folder? macOS: codesign + spctl + file list before and after walking every page in the app window, relaunch, launch with the quarantine flag; Windows: a read-only (Program Files style) copy must run without write errors. `expect=broken` is the control for a release known to have the problem |
| `close-console.yml` | windows-2022, windows-2025, windows-11-arm | close console: does a visible console window open when the app closes? Window list every 25 ms + process creation audit (4688) during a real close (WM_CLOSE), then the app's own spawn code in Node mode with the shipped options (control) and with the fix's options. Captures are of the new console window only |
| `acp-shadow.yml` | windows-2025, windows-2022, macos-15 | ACP shadow recorder: ten scripted scenarios through the official Claude Code CLI in a pseudo terminal AND through the published ACP adapter, against a local fake model (no key, no network model calls). Records only event names and milliseconds; the decisions are made elsewhere |

```
gh workflow run clean-profile.yml -R muratbaskicioglu/agentspace-win-smoke \
  -f tag=v0.4.8 -f mac_arm64_sha256=<sha256> -f mac_x64_sha256=<sha256> -f win_sha256=<sha256>

gh workflow run linux-clean-profile.yml -R muratbaskicioglu/agentspace-win-smoke \
  -f tag=v0.4.4 -f x64_sha256=<sha256> -f arm64_sha256=<sha256>

gh workflow run smoke.yml -R muratbaskicioglu/agentspace-win-smoke \
  -f tag=v0.3.3 -f asset=AgentSpace-Setup-0.3.3.exe -f sha256=<sha256>
```

```
gh workflow run seal.yml -R muratbaskicioglu/agentspace-win-smoke \
  -f tag=v0.4.8 -f expect=broken -f mac_arm64_sha256=<sha256> -f win_sha256=<sha256>
```

`clean-profile.yml` is the release gate: the AgentSpace release script starts it
before a release becomes "Latest", and Latest does not move while it is red.
`mac_x64_sha256` and `win_sha256` are optional (empty = that platform is
skipped, for a mac-only release). `version` is for beta tags, whose files carry
the bare version (`v0.4.9-beta` → `AgentSpace-0.4.9-arm64.dmg`). `request_id`
only goes into the run name.

Do not run the scripts on your own computer: the uninstall steps remove any
AgentSpace installation (and on macOS its data folders) for the current user.
`scripts/macSmoke.sh` refuses to run outside a GitHub-hosted runner.
