# Phase 5 contract run 2026-11-22

Issue #216, epic #169. Session 0dacb6f5-65c9-4dca-9249-7f86e9fafff9, `sonnet/claude-code`, Node 24.22.3 on Windows.

## Probe evidence (AC5)

- Issues #214 (`probe`, created 09:00:45Z, closed 09:04:08Z) and #215 (`probe2`, created 09:06:15Z, closed 09:07:04Z) were created on `groundwork` by the owner login with the owner's GitHub CLI OAuth token (`gho_` prefix) from the agent machine.
- At that time the org's third-party application access restriction was on and no OAuth app was approved. GitHub still accepted the writes. The restriction does not keep the owner's `gh` login out of `groundwork`, so the separation is enforced by the client (epic #169 Decisions, 2026-11-22).

## Fail-closed probe (AC2)

Settings env as in `.claude/settings.json`; `GH_DEBUG=api` was set, and the bare runs printed no API traffic, so no `gh` call started. `<id>` is the session id above.

```
$ node scripts/agent/claim.mjs 216 --session <id> --agent sonnet/claude-code
refusing to call GitHub without the agent token: run this through `node scripts/agent/token.mjs exec -- <command>`
exit 1

$ node scripts/agent/token.mjs exec -- node scripts/agent/claim.mjs 216 --session <id> --agent sonnet/claude-code
claimed #216 on issue/216, PR #225
exit 0
```

The second run is a rerun by the claiming session; it reached GitHub and found nothing missing. `resume.mjs` and `review-queue.mjs` call `currentRepo()` before `createClient`, so `currentRepo` refuses the same way:

```
$ node scripts/agent/resume.mjs 216 --session <id>
refusing to call GitHub without the agent token: run this through `node scripts/agent/token.mjs exec -- <command>`
exit 1
```

Also exit 1 with the same line: `next`, `checkpoint`, `plan-lint`, `review-queue`, `scripts/human/inbox.mjs`, `scripts/admin/request.mjs` and `scripts/kit-update.mjs`. `claim` and `release` first report their own usage errors when `--agent` or the mode flag is missing; with valid arguments `claim` refuses as above.

## Settings probe (AC3)

`.claude/settings.json` sets `GH_CONFIG_DIR=.claude/gh-agent` and `GCM_INTERACTIVE=never`. It denies `gh auth token`, `gh auth git-credential`, `gh auth login`, `gh auth setup-git`, `gh auth refresh` and `gh auth switch`, each as a bare and a `token.mjs exec` form, plus `Bash(gh api graphql*)` and `Bash(*gh.exe *)`.

```
$ GH_CONFIG_DIR=.claude/gh-agent GCM_INTERACTIVE=never gh auth status
You are not logged into any GitHub hosts. To log in, run: gh auth login
exit 1
```

The directory has no `hosts.yml`, so `gh` lists no host and its auth check refuses every command outside `gh auth`. That does not hide the owner's keyring token: gh v2.102.0 falls back to the keyring entry `gh:github.com` (found in review), and `gh auth token` and `gh auth git-credential` can print it. The deny rules cover those commands. The harness denied each probe below before it ran. The first host is invalid and the second has no stdin, so a miss would print no token:

```
$ gh auth token --hostname invalid.example
Permission to use Bash with command gh auth token --hostname invalid.example has been denied.

$ gh auth git-credential get
Permission to use Bash with command gh auth git-credential get has been denied.

$ node scripts/agent/token.mjs exec -- gh auth token --hostname invalid.example
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh auth token --hostname invalid.example has been denied.

$ node scripts/agent/token.mjs exec -- gh.exe --version
Permission to use Bash with command node scripts/agent/token.mjs exec -- gh.exe --version has been denied.
```

## Gotchas

- The bare read-only commands in `permissions.allow` (`gh issue view` and the like) now find no login and need `token.mjs exec`. The worker skill still says reads run bare; it lives under `.claude/skills/`, outside this task's Touches.
- `GH_TOKEN` set by anything other than `token.mjs exec` passes the check. The rule stops accidental ambient use, not a deliberate bypass.
