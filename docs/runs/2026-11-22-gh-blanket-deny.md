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

## Review round 1 probes (R1, R3, R5)

Review round 1 found the first version let a wrapped `gh.exe` past every wrapped deny: it had narrowed `Bash(*gh.exe *)` to `gh.exe *` and `*/gh.exe *`. The fix restores `Bash(*gh.exe *)` (plus `Bash(gh.exe)` for no arguments), drops the two narrower rules and replaces the six wrapped `gh auth` rules with `Bash(*token.mjs* exec -- gh auth*)`. Probed after the fix:

```
$ node scripts/agent/token.mjs exec -- gh.exe --version
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh.exe --version has been denied.
$ node scripts/agent/token.mjs exec -- gh.exe auth token --help
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh.exe auth token --help has been denied.
$ node scripts/agent/token.mjs exec -- "C:\Program Files\GitHub CLI\gh.exe" --version
Permission to use Bash with command node scripts/agent/token.mjs exec -- "C:\Program Files\GitHub CLI\gh.exe" --version has been denied.
$ node scripts/agent/token.mjs exec -- gh pr view 230 --json number
{"number":230}
$ env gh --version
Permission to use Bash with command env gh --version has been denied.
$ command gh --version
Permission to use Bash with command command gh --version has been denied.
$ echo token.mjs exec -- gh auth status --show-token
Permission to use Bash with command echo token.mjs exec -- gh auth status --show-token has been denied.
$ echo token.mjs exec -- gh aw --help
Permission to use Bash with command echo token.mjs exec -- gh aw --help has been denied.
$ echo token.mjs exec -- gh stack --help       (denied, same text)
$ echo token.mjs exec -- gh webhook --help     (denied, same text)
```

The `echo` probes only print the command text, so they exercise the wrapped rules (which start with a wildcard) without risking a token print or an extension install.

## Review round 2 probes (R7, R9)

```
$ echo --version | xargs gh
Permission to use Bash with command xargs gh has been denied.
$ node scripts/agent/token.mjs exec -- "C:\Program Files\GitHub CLI\gh" --version      (before the rule)
gh version 2.102.0 (2026-09-30)
$ node scripts/agent/token.mjs exec -- "C:\Program Files\GitHub CLI\gh" --version      (rule written *\gh *, still ran)
gh version 2.102.0 (2026-09-30)
$ node scripts/agent/token.mjs exec -- "C:\Program Files\GitHub CLI\gh" --version      (rule written *\\gh *)
Permission to use Bash with command node scripts/agent/token.mjs exec -- "C:\Program Files\GitHub CLI\gh" --version has been denied.
$ node scripts/agent/token.mjs exec -- gh pr view 230 --json number
{"number":230}
$ gh --version
Permission to use Bash with command gh --version has been denied.
```

No `node --test` case can exercise harness rule matching, so there is no failing test first: the before and after probes stand in.

## Which wrapped denies stay (AC3)

Under the wrapper gh runs with `GH_TOKEN` set (`scripts/agent/token.mjs` env block) and `GH_CONFIG_DIR=.claude/gh-agent`. `gh help environment` documents that `GH_TOKEN` "takes precedence over previously stored credentials" for `github.com`, so a wrapped command aimed at `github.com` does not reach the owner's keyring token. That decides each rule by what the command does beyond one API call:

| Wrapped form | Decision | Reason |
|---|---|---|
| `gh auth` (one rule, every subcommand) | stay | `token`, `git-credential` and `status --show-token` print the installation token into the transcript; `login`, `refresh`, `switch` change credential state; `setup-git` writes the global Git config, so the helper would outlive the wrapper (`gh help auth setup-git`). No script calls `gh auth` |
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

- `Bash(*/gh *)` needs a `/` right before `gh`, `Bash(*\\gh *)` a backslash and `Bash(*gh.exe *)` needs `gh.exe`, so none matches `token.mjs exec -- gh ...`. The first backslash rule, `Bash(*\gh *)`, did not match: rule syntax needs the backslash escaped, and the JSON file spells it `"Bash(*\\\\gh *)"`. A command whose text contains `gh.exe` and a space is denied, even inside an `echo` or a heredoc; write such text with the Write or Edit tool. The separator rules match any command text with a `/` or `\` right before `gh `, not only a path to `gh`: `grep -c "x/gh y" docs/spec.md` was denied in the #224 session. Search such text with the Grep tool.
- Open cases, listed in spec 17 and 21: a case variant (`GH --version` ran at review round 1), `bash -c "gh ..."`, `sh -c`, `eval`, `GH_HOST`, an overridden `GH_CONFIG_DIR`. `env gh`, `command gh` and `xargs gh` are denied (probed above and in round 2).
- Review round 1 R6 (`AGENTS.md:14` and the `groundwork-*` skills still describe bare `gh` as "forbidden" or "exits 4") is outside #229's Touches and goes to #224.
