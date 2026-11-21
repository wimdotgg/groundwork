# Phase 4c: kit-update and deploy rollback on gw-p4-b

Date: 2026-11-21. Epic #168, task #198. Target: `wimdotgg/gw-p4-b`, on kit `v0.5.0` at the start, `groundwork` release `v0.7.0` (`1ee8291`) as the update target.

Work in progress: the table is filled as each step lands.

| Step | Link | Result |
|---|---|---|
| Chore issue for the update | [gw-p4-b#11](https://github.com/wimdotgg/gw-p4-b/issues/11) | claimed, PR #12 |
| `kit-update` PR | [gw-p4-b#12](https://github.com/wimdotgg/gw-p4-b/pull/12) | ready, awaiting the owner |

## Findings so far

- `v0.5.0` has no `scripts/kit-update.mjs`, so the project cannot run the script it needs. The PR seeds it from the `v0.7.0` tag in a first commit; the run then overwrites it with the same bytes.
- `kit-update` delivers `scripts/ci/deploy-record.test.mjs` but not `.github/workflows/deploy.yml` (a project path, spec 13.1), and the test reads that workflow. Without it `Check` fails, so the PR adds `deploy.yml` from the tag by hand. A project updating from a tag without `deploy.yml` hits the same failure.
- The update is 940 added and 122 removed lines in 10 files; it cannot be split below the 400-line limit and needs the owner's `size-exception`.
- Stubs for deploy exist only in projects bootstrapped from `v0.7.0` or later (`scripts/stubs/deploy/`); `gw-p4-b` has none, so the deploy setup task writes the scripts directly.
