# Phase 4c: live selftest and script admin runs

Date: 2026-11-21. Epic #168, task #199, `main` at `1ee8291` (v0.7.0). Both runs are `admin-run.yml` dispatches approved by the owner script, under the dated Decisions in [#168](https://github.com/wimdotgg/groundwork/issues/168) for the `selftest` and `script` admin approvals.

| Op | Run | Result |
|---|---|---|
| `selftest` | [44954106536](https://github.com/wimdotgg/groundwork/actions/runs/44954106536) | success, first attempt |
| `script` | [44954649162](https://github.com/wimdotgg/groundwork/actions/runs/44954649162) | success |

## selftest

Target `wimdotgg/selftest-44954106536`. Apply summary: `Result: pass`.

| Step | Result | Detail |
|---|---|---|
| bootstrap | pass | pass 1 applied |
| check | pass | all rows match or deferred |
| V3 | pass | create 201, repeat 422 |
| V11 | pass | update rule present |
| V16 | pass | fast-forward 200, forced rewind 422, delete ok |
| push-main | pass | push rejected with 422 |
| archive | pass | archived |

`gh api repos/wimdotgg/selftest-44954106536 --jq .archived` returns `true`.

## script

Run name: `admin-run script gw-p4-a ref=1ee8291f01e9df274443b17d82ee05332d428924 script=admin-ops/repo-info.mjs args={}`.

- Plan summary: script `admin-ops/repo-info.mjs`, SHA-256 `37847c2e0a7a0ea4e9ea23b7f17d78a337d6931dd34d8653be93ec7f31645276`.
- Token grants: `groundwork` contents read; `gw-p4-a` contents read.
- Apply summary: `Result: pass`, script result `gw-p4-a default branch: main`. Calls: the script fetched from `groundwork` at the pinned ref (200), then `GET /repos/wimdotgg/gw-p4-a` (200). Both installation tokens were revoked (204).

## For the owner to delete

`wimdotgg/selftest-44954106536` is archived and public. Deleting it is tier 3 and stays with the owner.
