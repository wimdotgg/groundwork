# Phase 5 bootstrap run 2026-11-22

Issue #217, epic #169. Session 64f1702a-d9ac-4e9e-a6bc-cfef09005dd0, `sonnet/claude-code`, Node 24.22.3 on Windows. Target: `gw-acceptance` (owner `wimdotgg`), created from `groundwork` v0.9.0. `gw-acceptance` is deleted by the owner once epic #242 closes (#242 Decisions), so this note is the record: every reference to it is a name, number, run ID or quoted value, not a link. `{owner}` in a path or quoted output stands for `wimdotgg`.

## Release (AC5)

v0.9.0 (published 2026-11-22T11:36:25Z) is the first release after v0.8.0. #225 closed #216; its merge commit is `4f9a73a`, and the tag contains it:

```
$ git merge-base --is-ancestor 4f9a73a v0.9.0
exit 0
```

## Bootstrap run (AC1, AC2)

Request: `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap --repo gw-acceptance --args '{"description":"groundwork acceptance project: small Node stack, deploy none (throwaway)"}'`, dispatched 2026-11-22T11:45:01Z. Before it, `GET /repos/{owner}/gw-acceptance` returned 404.

Run: [groundwork run 45018831414](https://github.com/wimdotgg/groundwork/actions/runs/45018831414), `plan` and `apply` both success, finished 11:52:20Z. The only bootstrap request. Bootstrap commit on `gw-acceptance` `main` is `5b949fe` `chore: bootstrap from groundwork v0.9.0`; the setup epic is gw-acceptance#1 with 6 sub-issues (7 issues in all).

Closing `check`, from the `apply` log:

```
check {owner}/gw-acceptance: 83 rows, all match or deferred
match: 80, differ: 0, missing: 0, extra: 0, unreadable: 0, deferred: 3
```

Zero mismatching rows. The summary lists counts and mismatches only, so the log does not name the 3 deferred rows, and this run has no replay that does. On `groundwork`, a `check` before pass 2 showed the same 3 deferred, named by a read-only replay: `security code_scanning_default_setup.state`, `variables DEPLOY_ENABLED`, `rulesets main.rules.code_scanning` ([phase 4b note](2026-11-21-phase4b-groundwork-pass2.md)). Unconfirmed for `gw-acceptance`.

## Owner actions

One: the owner login `wianvdm` approved the pending `admin` deployment of run 45018831414 (approvals API: `state: approved`, environment `admin`). No other manual step.

## Config (AC4)

`GET /repos/{owner}/gw-acceptance/contents/.github/groundwork/config.json` on `main` declares `"deploy": "none"`. `.github/groundwork/kit-version.txt` reads `v0.9.0`.

The small Node stack is not in the bootstrap output: the stub `scripts/verify` stays until the setup tasks (next task).

## Push probe (AC3)

Agent App, through `token.mjs exec`:

```
$ node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs probe --repo gw-acceptance
push probe rejected: main is protected
exit 0
```

`request.mjs probe` creates an unreferenced empty commit whose parent is `main`'s head (`POST /git/commits`), then sends `PATCH /git/refs/heads/main` with `force: false`. A 409 or 422 counts as rejected only if `main` is unchanged on a re-read (`scripts/admin/request.mjs:151-154`; spec 13). `main` stayed at `5b949fe`.

Rerun with `--json`, same wrapper:

```
{"op":"probe","targetRepo":"gw-acceptance","protected":true,"status":422,"probeSha":"6341334ee38f4a0e0f61fcc4366c3e744a90308c"}
```

The probe commit is not on any ref. A clone `git push origin main` is not part of spec 14.2; the harness denies `git push` naming `main`.
