# Phase 5 bootstrap run 2026-11-22

Issue #217, epic #169. Session 64f1702a-d9ac-4e9e-a6bc-cfef09005dd0, `sonnet/claude-code`, Node 24.22.3 on Windows. Target: `wimdotgg/gw-acceptance`, created from `groundwork` v0.9.0.

## Release (AC5)

v0.9.0 (published 2026-11-22T11:36:25Z) is the first release after v0.8.0. #216's merge commit is `4f9a73a`, and the tag contains it:

```
$ git merge-base --is-ancestor 4f9a73a v0.9.0
exit 0
```

## Bootstrap run (AC1, AC2)

Request: `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap --repo gw-acceptance --args '{"description":"groundwork acceptance project: small Node stack, deploy none (throwaway)"}'`, dispatched 2026-11-22T11:45:01Z. Before it, `GET /repos/wimdotgg/gw-acceptance` returned 404.

Run: [groundwork run 45018831414](https://github.com/wimdotgg/groundwork/actions/runs/45018831414), `plan` and `apply` both success, finished 11:52:20Z. The only bootstrap request. Bootstrap commit on `gw-acceptance` `main` is `5b949fe` `chore: bootstrap from groundwork v0.9.0`; the setup epic is [gw-acceptance#1](https://github.com/wimdotgg/gw-acceptance/issues/1) with 6 sub-issues (7 issues in all).

Closing `check`, last line of the `apply` log:

```
check wimdotgg/gw-acceptance: 83 rows, all match or deferred
```

Zero mismatching rows.

## Owner actions

One: the owner login `wianvdm` approved the pending `admin` deployment of run 45018831414 (approvals API: `state: approved`, environment `admin`). No other manual step.

## Config (AC4)

`GET /repos/wimdotgg/gw-acceptance/contents/.github/groundwork/config.json` on `main` declares `"deploy": "none"`. `.github/groundwork/kit-version.txt` reads `v0.9.0`.

The small Node stack is not in the bootstrap output: the stub `scripts/verify` stays until the setup tasks (next task).

## Push probe (AC3)

Agent App, through `token.mjs exec`:

```
$ node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs probe --repo gw-acceptance
push probe rejected: main is protected
exit 0
```

`request.mjs probe` creates a dangling empty commit on `main` with `POST /git/commits`, then moves `refs/heads/main` to it with `PATCH` and no `force`. A 422 or 409 means rejected (spec 13). `main` stayed at `5b949fe`.

A second probe, `git push origin main` from a clone (`gw-agents/gw-acceptance-217`) with an empty `chore(check): probe` commit, did not run. `.claude/settings.json` denies every `git push` that names `main`, wrapped or not, and the harness refused the call. The local commit was reset away and never left the clone.
