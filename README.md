# agentspace-win-smoke

Windows install smoke test for AgentSpace.

It downloads a published installer from
[agentspace-releases](https://github.com/muratbaskicioglu/agentspace-releases),
checks its sha256, then installs, launches, closes and uninstalls it on a
throwaway GitHub-hosted Windows runner.

- No account, no sign-in, no secrets. The app stops at its sign-in screen.
- Manual runs only (`workflow_dispatch`).

```
gh workflow run smoke.yml -R muratbaskicioglu/agentspace-win-smoke \
  -f tag=v0.3.3 -f asset=AgentSpace-Setup-0.3.3.exe -f sha256=<sha256>
```

Do not run the scripts on your own PC: the uninstall step removes any AgentSpace
installation for the current user.
