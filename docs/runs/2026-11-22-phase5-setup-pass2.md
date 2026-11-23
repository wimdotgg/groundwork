# Phase 5 setup epic and pass 2 run 2026-11-22

Issue #218, epic #169. Session 072fed1f-b809-42ec-8760-10a1e2453923, `sonnet/claude-code`. Separate worker sessions built the setup tasks as the agent App, each in its own clone; this session surveyed the epic, posted the acceptance comment and wrote this note. Target: `gw-acceptance` (owner `wimdotgg`), bootstrapped from `groundwork` v0.9.0 by run [45018831414](https://github.com/wimdotgg/groundwork/actions/runs/45018831414) (#217, [bootstrap note](2026-11-22-phase5-bootstrap.md)). `gw-acceptance` is deleted by the owner once epic #242 closes (#242 Decisions), so this note is the record: every reference to it is a name, number, run ID or quoted value, not a link. `{owner}` in a path or quoted output stands for `wimdotgg`.

## Setup epic

gw-acceptance#1 "Project setup: gw-acceptance", six sub-issues. The owner applied `accepted` at 2026-11-22T12:27:45Z. `plan-lint 1` passes (lane width 4); the report comment is refreshed. Lanes: #2 first, then #3 to #6 concurrently, then #7.

## Tasks (AC1)

| Issue | Task | Closed by | Merge commit | CODEOWNERS approval |
|---|---|---|---|---|
| gw-acceptance#2 | Choose the stack and fill scripts/verify | gw-acceptance PR #8, merge queue, 12:51:45Z | `b45b9bb` | 12:50:54Z |
| gw-acceptance#3 | Add Dependabot ecosystems | gw-acceptance PR #10, merge queue, 13:11:59Z | `96db496` | 13:11:06Z |
| gw-acceptance#4 | Define hotspots and write the README | gw-acceptance PR #11, merge queue, 13:11:59Z | `d3176ff` | 13:11:18Z |
| gw-acceptance#5 | Decide deploy: scripts or none | evidence comment, no PR | none | none |
| gw-acceptance#6 | Confirm the code_scanning rule | evidence comment, no PR | none | none |
| gw-acceptance#7 | Request bootstrap-pass2 | gw-acceptance PR #12, merge queue, 13:36:16Z | `0799d58` | none needed |

All six are closed as completed. Each PR timeline shows `added_to_merge_queue` then `merged` by the agent App; the owner's `wianvdm` approval precedes the enqueue on #8, #10 and #11.

#5 and #6 had nothing to change. Under `"deploy": "none"` task 04 leaves `config.json` and the stubs alone, and the v0.9.0 template already carries the `code_scanning` rule, so task 05 only confirms it. Both were closed as completed by an evidence comment (gw-acceptance#5 comment 7079473138, gw-acceptance#6 comment 7079474413) on an owner decision of 2026-11-22, with dated lines in the epic's `## Decisions`. AC1 is read that way for these two: closed by evidence, not by a merged PR. This is the one deviation from the AC1 wording.

## Task 04 under deploy none

`.github/groundwork/config.json` on `main` has `"deploy": "none"`. `scripts/` holds no `deploy*`, `smoke*` or `rollback*`, and `scripts/stubs/deploy/` is untouched. `settings.json` lists no production secrets.

## Pass 2 (AC2)

Request: `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap-pass2 --repo gw-acceptance`, issued by the #7 worker after #2 to #6 were closed.

Run: [groundwork run 45026736246](https://github.com/wimdotgg/groundwork/actions/runs/45026736246), created 13:17:58Z, finished 13:22:45Z, `plan` and `apply` both success. One approval: the owner login `wianvdm` on the `admin` environment (approvals API, `state: approved`). Steps from the log: CodeQL default setup, first CodeQL run on `main` gw-acceptance run 45027036802 success, `code_scanning` rule added to the live ruleset. No `DEPLOY_ENABLED` step, since deploy is `none`.

Closing check, from the `apply` log:

```
## check {owner}/gw-acceptance
Result: **pass** (83 rows, all match or deferred).
- match: 82
- differ: 0
- missing: 0
- extra: 0
- unreadable: 0
- deferred: 1
```

Zero mismatching rows. The README "Setup" line from PR #12 links this run and states the same counts.

## Owner actions (AC3)

Bootstrap to the end of pass 2:

1. Approved the `admin` deployment of bootstrap run 45018831414.
2. Applied `accepted` to gw-acceptance#1 (12:27:45Z).
3. Approved CODEOWNERS review on PR #8 (12:50:54Z), PR #10 (13:11:06Z) and PR #11 (13:11:18Z).
4. Approved the `admin` deployment of pass-2 run 45026736246.
5. Decided on 2026-11-22 that #5 and #6 close by evidence comment, not by PR, relayed through the orchestrator. A scope decision made off GitHub: no GitHub write, no admin or settings action. #5 and #6 closed at 12:58:09Z and 12:58:16Z, between the approvals on PR #8 and PR #10.

Nothing else: no secret entered, no ruleset or setting edited by hand, no merge. Actions 1 to 4 are the setup epic acceptance, CODEOWNERS approvals and the two admin approvals that AC3 allows. Action 5 is a decision, not a GitHub write, and no admin or settings path is involved, so AC3 is read to allow it, as AC1 is read for #5 and #6.

## Acceptance and close

The agent App posted the acceptance comment on gw-acceptance#1 (comment 7080025812), mapping E1 to E6 to the evidence above. `plan-lint 1 --close`, run against `{owner}/gw-acceptance` through `GITHUB_REPOSITORY`:

```
Epic close #1: pass
```

Epic close: the owner (`wianvdm`) closed gw-acceptance#1 as completed at 2026-11-22T13:46:38Z (issue events).

## Gap

The deferred row is unnamed: the `check` summary lists counts and mismatches only, and this run has no replay that names rows. It is not a mismatch (0 differ). The bootstrap `check` had 3 deferred rows; on `groundwork` those were `security code_scanning_default_setup.state`, `variables DEPLOY_ENABLED` and `rulesets main.rules.code_scanning`. Pass 2 leaves one. `DEPLOY_ENABLED` stays `deferred` under `"deploy": "none"` (spec 10, `deployReady`), which would fit, but this is unconfirmed for `gw-acceptance`.
