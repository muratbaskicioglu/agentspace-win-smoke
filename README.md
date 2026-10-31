# agentspace-win-smoke

Install smoke tests for the public AgentSpace releases (Windows and macOS).

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
| `smoke.yml` | windows-latest | Windows install → launch → close → uninstall |
| `engines.yml` | windows-latest | engine panes (Codex, OpenCode, Claude Code) with the installed app's own modules |

```
gh workflow run clean-profile.yml -R muratbaskicioglu/agentspace-win-smoke \
  -f tag=v0.4.8 -f mac_arm64_sha256=<sha256> -f mac_x64_sha256=<sha256> -f win_sha256=<sha256>

gh workflow run smoke.yml -R muratbaskicioglu/agentspace-win-smoke \
  -f tag=v0.3.3 -f asset=AgentSpace-Setup-0.3.3.exe -f sha256=<sha256>
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
