# Phase 5 G7 audit run 2026-11-22

Issue #223, epic #169. Session 8e0dccc3-fc8d-43ad-8445-30d8a4a74318, `sonnet/claude-code`, Node 24.22.3 on Windows. Audited tree: `main` at `77564a3`.

## Script and test pairing (AC1)

Every `.mjs` under `scripts/` and `admin-ops/`, tests excluded, with its test file. No script lacks a test, so no Bug sub-issue was opened.

| Script | Test file |
|---|---|
| `admin-ops/repo-info.mjs` | `scripts/groundwork/script.test.mjs` |
| `scripts/admin/request.mjs` | `scripts/admin/request.test.mjs` |
| `scripts/agent/checkpoint.mjs` | `scripts/agent/checkpoint.test.mjs` |
| `scripts/agent/claim.mjs` | `scripts/agent/claim.test.mjs` |
| `scripts/agent/next.mjs` | `scripts/agent/next.test.mjs` |
| `scripts/agent/plan-lint.mjs` | `scripts/agent/plan-lint.test.mjs` |
| `scripts/agent/release.mjs` | `scripts/agent/release.test.mjs` |
| `scripts/agent/resume.mjs` | `scripts/agent/resume.test.mjs` |
| `scripts/agent/review-queue.mjs` | `scripts/agent/review-queue.test.mjs` |
| `scripts/agent/token.mjs` | `scripts/agent/token.test.mjs` |
| `scripts/ci/check-results.mjs` | `scripts/ci/check-results.test.mjs` |
| `scripts/ci/deploy-record.mjs` | `scripts/ci/deploy-record.test.mjs` |
| `scripts/ci/failure-alert.mjs` | `scripts/ci/failure-alert.test.mjs` |
| `scripts/ci/issue-format.mjs` | `scripts/ci/issue-format.test.mjs` |
| `scripts/ci/pr-metadata.mjs` | `scripts/ci/pr-metadata.test.mjs` |
| `scripts/ci/pr-size.mjs` | `scripts/ci/pr-size.test.mjs` |
| `scripts/ci/protected-labels.mjs` | `scripts/ci/protected-labels.test.mjs` |
| `scripts/ci/settings-plan.mjs` | `scripts/ci/settings-plan.test.mjs` |
| `scripts/ci/test-integrity.mjs` | `scripts/ci/test-integrity.test.mjs` |
| `scripts/groundwork/admin-run.mjs` | `scripts/groundwork/admin-run.test.mjs` |
| `scripts/groundwork/app-token.mjs` | `scripts/groundwork/app-token.test.mjs` |
| `scripts/groundwork/apply-settings.mjs` | `scripts/groundwork/apply-settings.test.mjs` |
| `scripts/groundwork/bootstrap-pass2.mjs` | `scripts/groundwork/bootstrap-pass2.test.mjs` |
| `scripts/groundwork/bootstrap-repo.mjs` | `scripts/groundwork/bootstrap-repo.test.mjs` |
| `scripts/groundwork/bootstrap-tree.mjs` | `scripts/groundwork/bootstrap-tree.test.mjs` |
| `scripts/groundwork/bootstrap.mjs` | `scripts/groundwork/bootstrap.test.mjs` |
| `scripts/groundwork/check.mjs` | `scripts/groundwork/check.test.mjs` |
| `scripts/groundwork/create-issue-types.mjs` | `scripts/groundwork/create-issue-types.test.mjs` |
| `scripts/groundwork/script.mjs` | `scripts/groundwork/script.test.mjs` |
| `scripts/groundwork/selftest-probes.mjs` | `scripts/groundwork/selftest-probes.test.mjs` |
| `scripts/groundwork/selftest.mjs` | `scripts/groundwork/selftest.test.mjs` |
| `scripts/groundwork/setup-epic.mjs` | `scripts/groundwork/setup-epic.test.mjs` |
| `scripts/human/inbox.mjs` | `scripts/human/inbox.test.mjs` |
| `scripts/kit-update.mjs` | `scripts/kit-update.test.mjs` |
| `scripts/lib/ci.mjs` | `scripts/lib/ci.test.mjs` |
| `scripts/lib/config.mjs` | `scripts/lib/config.test.mjs` |
| `scripts/lib/github.mjs` | `scripts/lib/github.test.mjs` |
| `scripts/lib/issue-model.mjs` | `scripts/lib/issue-model.test.mjs` |
| `scripts/lib/markdown.mjs` | `scripts/lib/markdown.test.mjs` |
| `scripts/lib/settings.mjs` | `scripts/lib/settings.test.mjs` |
| `scripts/lib/trust.mjs` | `scripts/lib/trust.test.mjs` |

Notes:

- `admin-ops/repo-info.mjs` is the example for the `script` op. `scripts/groundwork/script.test.mjs` imports it and checks its source.
- Two test files have no matching script: `scripts/lib/templates.test.mjs` (the template twins under `.github/groundwork/templates/`) and `scripts/groundwork/stubs/setup.test.mjs` (the setup stubs).
- No other `.mjs` file is tracked outside `scripts/` and `admin-ops/`.

## The `scripts` job (AC2)

`scripts` in `.github/workflows/ci.yml` (Node 24) runs:

```
node --test "scripts/**/*.test.mjs"
```

Run [45030743887](https://github.com/wimdotgg/groundwork/actions/runs/45030743887) on `main` (`77564a3`), job [137233557879](https://github.com/wimdotgg/groundwork/actions/runs/45030743887/job/137233557879): success, 1398 tests, 1398 pass, 0 fail, 0 skipped. The job log prints totals only, no file names. File coverage comes from the same command on that tree with `--test-reporter=junit`: 42 distinct `*.test.mjs` files, 1398 tests, 0 skipped, the same totals as the CI run. The 42 are all the test files in the pairing above (the `**` glob reaches `scripts/kit-update.test.mjs` and `scripts/groundwork/stubs/setup.test.mjs`).

## Final results for V17, V18 and V19 (AC3)

V17. Redesigned. The `settings-plan` job cannot read environments with the PR `GITHUB_TOKEN`: [PR #119](https://github.com/wimdotgg/groundwork/pull/119) (job 136588292396) logged `settings-plan: environments unreadable (HTTP 403)` while `repository`, `labels` and `rulesets` were readable, and [#117](https://github.com/wimdotgg/groundwork/issues/117) records that `actions: read` does not help. The design reads those sections as a file diff and treats the `check` at the end of each `apply-settings` run as their live verification (same as V4). Not re-tested (epic #169 Decisions, 2026-11-21).

V18. Redesigned. The `automatic_base_change_succeeded` event needs a stacked PR whose base branch is deleted, and D7 forbids stacked PRs, so no live PR can carry it. `pr-metadata.mjs` reads the event from the issue events endpoint and the timeline ([#109](https://github.com/wimdotgg/groundwork/issues/109), [docs](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)); fixture tests in `scripts/ci/pr-metadata.test.mjs` cover the read. Epic #169 Decisions, 2026-11-22.

V19. Verified. `failure-alert` opened an alert on a real failure: the `v0.2.0` `deploy` run 44996594461 failed its smoke test and ended in the `Fail the job` step, and `failure-alert` opened gw-p4-b#20. Source: `docs/runs/2026-11-21-phase4c-project-runs.md` (Runs and PRs, "Failure alert"). Disclosure: `gw-p4-b` has since been deleted (`GET /repos/wimdotgg/gw-p4-b` returns 404 on 2026-11-22), so the run and the issue are cited by number and the run note is the surviving record. Scope: the live run shows the open path only. Comment on a repeat failure and close on the next success are covered by fixture cases in `scripts/ci/fixtures/failure-alert.json`, not by a live run: "failure, open alert -> comment on it", "end to end: failure with open alert -> comment", "success, open alert -> close-issue with comment" and "end to end: success with open alert -> close". Epic #169 Decisions, 2026-11-22.

## Every other spec 19 row (AC4)

Result as written in spec 19 on `main` at `77564a3`. No row needs an action.

| Row | Result | Action |
|---|---|---|
| V1 | verified | none |
| V2 | verified | none |
| V3 | verified | none |
| V4 | redesigned | none |
| V5 | verified (PAT retired in `v0.2.0`) | none |
| V6 | verified | none |
| V7 | verified | none |
| V8 | verified | none |
| V9 | verified | none |
| V10 | verified | none |
| V11 | verified | none |
| V12 | verified | none |
| V13 | redesigned | none |
| V14 | verified | none |
| V15 | verified | none |
| V16 | verified | none |
| V20 | verified | none |
| V21 | verified | none |
| V22 | redesigned | none |

## For the integration task

Replace the V17, V18 and V19 result cells in spec 19 with the three results above. Spec 19 then holds no known gap or partial row, as G7 requires.
