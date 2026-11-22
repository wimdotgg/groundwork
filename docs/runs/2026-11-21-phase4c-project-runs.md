# Phase 4c: kit-update and deploy rollback on gw-p4-b

Dates: 2026-11-21 to 2026-11-22. Epic #168, task #198. Target: `wimdotgg/gw-p4-b`, on kit `v0.5.0` at the start, `groundwork` release `v0.7.0` (`1ee8291`) as the update target.

Final `.github/groundwork/kit-version.txt` on `gw-p4-b` main (read 2026-11-22T07:07:52Z): `v0.7.0`.

Owner decisions on epic #168 `## Decisions` ([issue 168](https://github.com/wimdotgg/groundwork/issues/168)): 2026-11-21 (the owner script approves the `production` deployment on `gw-p4-b` for the forced-smoke-failure rollback test, #198), 2026-11-22 (release merges and `size-exception` on `gw-p4-b`), 2026-11-22 (that approval covers both the `v0.1.0` and the `v0.2.0` deploy, cap of 2). Both production approvals came after those entries: GitHub deployment status `queued` at 2026-11-22T06:53:49Z (deployment 7975215884) and 07:05:54Z (deployment 7975330706); owner script log times 06:54:07Z and 07:06:12Z. Epic #168 was last updated 2026-11-22T06:36:42Z (read 07:12:43Z), before both.

## Runs and PRs

| Step | Link | Result |
|---|---|---|
| Chore issue for the update | [gw-p4-b#11](https://github.com/wimdotgg/gw-p4-b/issues/11) | closed by PR 12 |
| `kit-update` PR | [gw-p4-b#12](https://github.com/wimdotgg/gw-p4-b/pull/12) | merged 2026-11-21T22:08:50Z (`a9e5b5f`); `kit-version.txt` `v0.5.0` to `v0.7.0`; `ci.yml` pins `1ee8291` |
| Setup task 03, Dependabot | [gw-p4-b#13](https://github.com/wimdotgg/gw-p4-b/pull/13) | merged |
| Setup task 04, hotspots and README | [gw-p4-b#14](https://github.com/wimdotgg/gw-p4-b/pull/14) | merged |
| Setup task 05, deploy scripts | [gw-p4-b#15](https://github.com/wimdotgg/gw-p4-b/pull/15) | merged |
| Pass-2 rerun record | [gw-p4-b#16](https://github.com/wimdotgg/gw-p4-b/pull/16) | merged |
| Throwaway task 17, smoke-fail-tags | [gw-p4-b#18](https://github.com/wimdotgg/gw-p4-b/pull/18) | merged |
| Release PR `v0.1.0` | [gw-p4-b#9](https://github.com/wimdotgg/gw-p4-b/pull/9) | merged |
| Release PR `v0.2.0` | [gw-p4-b#19](https://github.com/wimdotgg/gw-p4-b/pull/19) | merged |
| First `bootstrap-pass2` run | [groundwork run 44902909578](https://github.com/wimdotgg/groundwork/actions/runs/44902909578) | first pass 2 |
| `bootstrap-pass2` rerun | [groundwork run 44994970845](https://github.com/wimdotgg/groundwork/actions/runs/44994970845) | closing check 83 rows, all match or deferred; `DEPLOY_ENABLED` set |
| `deploy` run, `v0.1.0` | [run 44995716553](https://github.com/wimdotgg/gw-p4-b/actions/runs/44995716553) | approved 06:53:49Z (owner script log 06:54:07Z); deployed, smoke passed; record `Result: deployed`, `Previous: none` |
| `deploy` run, `v0.2.0` | [run 44996594461](https://github.com/wimdotgg/gw-p4-b/actions/runs/44996594461) | approved 07:05:54Z (owner script log 07:06:12Z); smoke failed, rollback to `v0.1.0`, second smoke passed, job failed |
| Release notes `v0.2.0` | [release](https://github.com/wimdotgg/gw-p4-b/releases/tag/v0.2.0) | `Result: rolled-back`, `Tag: v0.2.0`, `Previous: v0.1.0` |
| Failure alert | [gw-p4-b#20](https://github.com/wimdotgg/gw-p4-b/issues/20) | opened by `failure-alert` |

The `v0.2.0` run log reads: `deployed v0.2.0`, `smoke: v0.2.0 is listed in scripts/smoke-fail-tags`, `rolled back to v0.1.0`, `smoke ok for v0.1.0`, then the `Fail the job` step ends the job in failure.

## Findings

- `v0.5.0` has no `scripts/kit-update.mjs`, so the project cannot run the script it needs. The PR seeds it from the `v0.7.0` tag in a first commit; the run then overwrites it with the same bytes.
- `kit-update` delivers `scripts/ci/deploy-record.test.mjs` but not `.github/workflows/deploy.yml` (a project path, spec 13.1), and the test reads that workflow. Without it `Check` fails, so the PR adds `deploy.yml` from the tag by hand. Folded into groundwork #200.
- The update is 940 added and 122 removed lines in 10 files; it cannot be split below the 400-line limit and needed the owner's `size-exception`.
- Stubs for deploy exist only in projects bootstrapped from `v0.7.0` or later (`scripts/stubs/deploy/`); `gw-p4-b` has none, so the deploy setup task writes the scripts directly.
- The kit test `scripts/lib/config.test.mjs` fails any project whose `hotspots.json` lists a hotspot, so `gw-p4-b` keeps an empty list. Folded into groundwork #200.
- Fable review round 1 on gw-p4-b#13: `dependabot.yml` drifts from the kit copy. Accepted.
- `plan-lint` on gw-p4-b epic 1 reports `no-integration-task` after the throwaway task 17; a dated Decision on that epic records it.
- Every `deploy` run shares the concurrency group `production` with no cancel, and the owner script caps approvals at 2, so the two deploys left no slack.
- `claim.mjs` reads the repository from the current directory and refuses a second draft claim under one session id; the project runs use session `w198-20261121-b`.
