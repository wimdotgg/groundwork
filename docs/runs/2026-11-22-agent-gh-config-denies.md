# gh config and alias denies run 2026-11-22

Issue #227, epic #169. Session 35c52011-69dd-4584-a2fa-ab98e58cf553, `sonnet/claude-code`, Node 24.22.3 on Windows. Every probe is a `--help` form, so a miss prints no token and writes no `hosts.yml`.

## Harness probes (AC1)

Before the change, on `4f9a73a` plus the claim commit, all six forms ran:

```
$ gh config set --help                                                  -> usage printed
$ gh alias set --help                                                   -> usage printed
$ gh alias import --help                                                -> usage printed
$ node scripts/agent/token.mjs exec -- gh config set --help             -> usage printed
$ node scripts/agent/token.mjs exec -- gh alias set --help              -> usage printed
$ node scripts/agent/token.mjs exec -- gh alias import --help           -> usage printed
```

After the `.claude/settings.json` change the harness denied all six (it reloaded the file in the same session):

```
$ gh config set --help
Permission to use Bash with command gh config set --help 2>&1 has been denied.
$ gh alias set --help
Permission to use Bash with command gh alias set --help 2>&1 has been denied.
$ gh alias import --help
Permission to use Bash with command gh alias import --help 2>&1 has been denied.
$ node scripts/agent/token.mjs exec -- gh config set --help
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh config set --help 2>&1 has been denied.
$ node scripts/agent/token.mjs exec -- gh alias set --help
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh alias set --help 2>&1 has been denied.
$ node scripts/agent/token.mjs exec -- gh alias import --help
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh alias import --help 2>&1 has been denied.
```

The probes ended in `2>&1 | head -3`; the harness echoes the `2>&1` in the denial text.

## Widened denies (AC7)

The owner widened #227 on 2026-11-22 to the commands that skip gh's auth check. Before the change, on `0020158`, the bare and wrapped `--help` forms of `gh extension`, `gh ext`, `gh extensions`, `gh release download` and `gh attestation` printed usage. `gh copilot` was not probed before: bare `gh copilot` can offer to download a binary.

After the change the harness denied all twelve forms: `gh extension`, `gh ext`, `gh extensions`, `gh release download`, `gh attestation` and `gh copilot`, each bare and under `node scripts/agent/token.mjs exec -- `. The first run of four bare forms printed usage because the harness had not reloaded the file yet; the rerun was denied. Example:

```
$ gh extension --help
Permission to use Bash with command gh extension --help 2>&1 has been denied.
$ node scripts/agent/token.mjs exec -- gh copilot --help
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh copilot --help 2>&1 has been denied.
```

## AGENTS.md (AC8)

```
$ git grep -n -E "scripts/agent/(next|resume|review-queue|plan-lint).mjs" -- AGENTS.md
AGENTS.md:84:1. `node scripts/agent/token.mjs exec -- node scripts/agent/next.mjs`: ...
AGENTS.md:91:3. ... `node scripts/agent/token.mjs exec -- node scripts/agent/resume.mjs N --session <id>` ...
```

Line 82 now says every script runs under `token.mjs exec`, reads included. No bare agent script is left in `AGENTS.md`.

## Ignore rule (AC2)

```
$ git check-ignore -v .claude/gh-agent/hosts.yml scripts/.claude/gh-agent/hosts.yml
.gitignore:9:**/.claude/gh-agent/	.claude/gh-agent/hosts.yml
.gitignore:9:**/.claude/gh-agent/	scripts/.claude/gh-agent/hosts.yml
```

The `**/` prefix covers a `gh` call from a subdirectory, which writes `<cwd>/.claude/gh-agent/` because `GH_CONFIG_DIR` is relative. Review round 1 found the root-only first form missed it.

The `.gitignore` line and the denies are in one commit.

## Bare reads and examples (AC4)

`permissions.allow` now holds `node scripts/agent/*`, `node scripts/human/*` and `node --test *`. No `gh` entry is left:

```
$ git grep -n '"Bash(gh [a-z]* [a-z]* \*)"' -- .claude/settings.json
(no output)
```

Every remaining `gh issue`, `gh pr`, `request.mjs` and `kit-update.mjs` mention under `.claude/skills/`, `docs/setup.md` and `README.md` sits behind `node scripts/agent/token.mjs exec --`, or is prose that names the script (`docs/setup.md:110`) or tells the reader to run reads under the wrapper.

## Spec diff (AC3, AC5, AC6, AC9)

`git diff origin/main -- docs/spec.md` changes the 2.1 `wianvdm` row, 14.1 step 3, the 15 allow-rules line and the credentials bullet of section 17, and adds the entry "2026-11-22: gh config and alias denies (#227)" above the #216 entry. No line inside an earlier section 21 entry changes.

## Gotchas

- `gh release download`, `gh extension install`, installed extensions, `gh copilot`, `gh attestation trusted-root` and `gh attestation verify --bundle` skip gh's auth check. The first three send the keyring token with no host listed (gh v2.102.0 source, review round 1); the last three were not traced to a request. AC7 denies them.
- `GH_HOST` and an overridden `GH_CONFIG_DIR` are environment, not command text: no deny rule matches them. Spec 17 states the limit.
- The `gh config set` write itself was not run: it would create `hosts.yml` and expose the owner's keyring token to the next `gh` call.
