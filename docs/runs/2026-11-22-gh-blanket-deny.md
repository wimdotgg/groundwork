# Bare gh blanket deny run 2026-11-22

Issue #229, epic #169. Session e84cc4c3-371e-4914-a727-fc131558986f, `sonnet/claude-code`, Node 24.22.3 on Windows, gh 2.102.0. Probes ran one at a time; the harness reloads `.claude/settings.json` in the same session.

## Harness probes (AC1, AC2)

Before the change, on `879c2d4` plus the claim commit:

```
$ gh --version
gh version 2.102.0 (2026-09-30)
$ gh at --help
Download and verify artifact attestations.
$ node scripts/agent/token.mjs exec -- gh pr view 1 --json number
GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)
$ node scripts/agent/token.mjs exec -- gh pr view 230 --json number
{"number":230}
```

PR 1 does not exist in this repo, so the AC2 command ends in a GraphQL error whatever the harness does. The probe uses PR 230 (this PR); the wrapped read ran and returned its JSON.

After the change:

```
$ gh --version
Permission to use Bash with command gh --version 2>&1 has been denied.
$ gh at --help
Permission to use Bash with command gh at --help 2>&1 has been denied.
$ gh
Permission to use Bash with command gh has been denied.
$ gh.exe --version
Permission to use Bash with command gh.exe --version has been denied.
$ "/c/Program Files/GitHub CLI/gh.exe" --version
Permission to use Bash with command "/c/Program Files/GitHub CLI/gh.exe" --version has been denied.
$ node scripts/agent/token.mjs exec -- gh pr view 230 --json number
{"number":230}
$ node scripts/agent/token.mjs exec -- gh at --help
Download and verify artifact attestations.
$ node scripts/agent/token.mjs exec -- gh auth token --help
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh auth token --help 2>&1 has been denied.
$ node scripts/agent/token.mjs exec -- gh copilot --help
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh copilot --help 2>&1 has been denied.
```

The probes ended in `2>&1 | head -3`; the harness echoes the `2>&1` in the denial text. A bare `gh` with no arguments is denied, so `Bash(gh)` is needed next to `Bash(gh *)`. The wrapped `gh at --help` ran. The wrapped `gh attestation*` rule is gone too, so `gh attestation` runs wrapped as well.

Not probed: the wrapped `gh aw`, `gh stack` and `gh webhook` denies (the stubs may start an extension install when gh can prompt or `CI` is set). Their rules have the same shape as the probed `gh copilot` rule.

## Which wrapped denies stay (AC3)

Under the wrapper gh runs with `GH_TOKEN` set (`scripts/agent/token.mjs` env block) and `GH_CONFIG_DIR=.claude/gh-agent`. `gh help environment` documents that `GH_TOKEN` "takes precedence over previously stored credentials" for `github.com`, so a wrapped command aimed at `github.com` does not reach the owner's keyring token. That decides each rule by what the command does beyond one API call:

| Wrapped form | Decision | Reason |
|---|---|---|
| `gh auth token`, `gh auth git-credential` | stay | print the installation token into the transcript |
| `gh auth login`, `refresh`, `switch` | stay | change credential state; no agent task needs them |
| `gh auth setup-git` | stay | writes the global Git config; the helper would outlive the wrapper (`gh help auth setup-git`) |
| `gh config set` | stay | writes `hosts.yml` or settings that later runs read without the wrapper |
| `gh alias set`, `gh alias import` | stay | a `!` alias is a shell command no Bash rule sees (`gh help alias set`) |
| `gh extension`, `gh ext`, `gh extensions` | stay | install and run foreign code with `GH_TOKEN` |
| `gh copilot` | stay | can offer to download a binary |
| `gh aw`, `gh stack`, `gh webhook` | added | hidden stubs for official extensions; they run the install that `gh extension install` is denied for (gh v2.102.0 source, review of #228, not executed) |
| `gh release download`, `gh attestation` (`gh at`) | dropped | wrapped they use `GH_TOKEN` like a read; bare they skip the auth check, which the blanket deny now covers; no script uses either |

```
$ git grep -n -E "release download|gh attestation|gh copilot|gh aw|gh stack|gh webhook" -- . ":!docs/runs" ":!docs/spec.md" ":!docs/setup.md" ":!.claude/settings.json"
(no output)
```

The `GH_HOST` case stays open (spec 17): `GH_HOST` makes gh use stored credentials for that host, and command text cannot match an environment variable.

## Spec diff (AC3, AC4)

`git diff origin/main -- docs/spec.md` removes five lines and changes none inside an earlier section 21 entry: the 2.1 `wianvdm` row, 6.3 step 1, the two 15 deny-rule bullets and the 17 credentials bullet. It adds the entry "2026-11-22: bare gh denied outright (#229)" above the #227 entry. The 2.1 row, 17 and `docs/setup.md` name the same wrapped list as `.claude/settings.json`.

## Bare agent scripts (AC5)

```
$ sed -n 358p docs/spec.md | cut -c1-90
1. `node scripts/agent/token.mjs exec -- node scripts/agent/next.mjs` returns the next eli
$ git grep -n -E "node scripts/agent/(next|claim|resume|checkpoint|release|review-queue|plan-lint)" -- docs/workflow.md docs/spec.md | grep -v "token.mjs exec"
(no output)
```

`docs/workflow.md:38` now reads "runs these as `node scripts/agent/token.mjs exec -- node scripts/agent/<name>.mjs`" and says every GitHub call, reads included, goes through the wrapper.

## Gotchas

- `Bash(*/gh *)` and `Bash(*/gh.exe *)` need the `/` right before `gh`, so they do not match `token.mjs exec -- gh ...`. The old `Bash(*gh.exe *)` became `*/gh.exe *`; `Bash(gh.exe *)` covers the bare form.
- Not covered: `gh` behind another command (`env gh`, `command gh`, `xargs gh`), `GH_HOST`, an overridden `GH_CONFIG_DIR`. Spec 21 lists them.
