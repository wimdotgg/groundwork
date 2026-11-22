# Release-please race with the merge queue

Issue #238, epic #242. Session 796c62d1-7b1a-489c-a7aa-2be0a912db7f, `sonnet/claude-code`. Fix: `.github/workflows/release-please.yml`; trigger documented in spec 11 and 8.5. The live proof is #243.

## Failure evidence

Read from the Actions and pull request APIs of the `gw-acceptance` repository, which the owner deletes after epic #242; these quoted values are the record. All times 2026-11-22.

| Event | Value |
|---|---|
| `release-please` run | 45036123914, event `push`, head `0bc07a51f398b664f0c38be6fbc3823e711e69d5` |
| Attempt 1 created | "2026-11-22T15:03:03Z" |
| Attempt 1 job started | "2026-11-22T15:03:09Z" |
| `release-please-action` step started | "2026-11-22T15:03:16Z" |
| Release PR 9 ("chore(main): release 0.1.0") merged | "2026-11-22T15:03:23Z" |
| Stray release PR 29 ("chore(main): release 0.2.0") created | "2026-11-22T15:03:24Z" |
| `release-please-action` step failed | "2026-11-22T15:03:26Z", attempt 1 conclusion "failure" |
| Attempt 2 (owner rerun) started | "2026-11-22T15:09:11Z", conclusion "success", tag `v0.1.0` and release built |

The step failed with "state cannot be changed. The pull request cannot be reopened." (HTTP 422) while updating the merged release PR. Release PR 29 was opened from the same branch, `release-please--branches--main`, and stayed open.

The step started 7 seconds before PR 9 read as merged. The merge queue pushes the squash commit to `main` first and marks the PR merged afterwards. The push run therefore saw a release PR that was still open, built no release and opened a new release PR from the unreleased history.

## Fix and trace under the new trigger

`release-please.yml` now also runs on `pull_request: closed` with base `main`. The job `if` requires, per event:

- `push`: no commit in the push may have changed `.release-please-manifest.json` (`contains(toJSON(github.event.commits.*.modified), '".release-please-manifest.json"')`). Every release commit changes it, and the check holds for a queue group where the release PR is not the tip.
- `pull_request`: the PR is merged, its head repository is this repository and its head branch starts with `release-please--`.
- `workflow_dispatch`: unchanged.

Trace of the same timeline under the new trigger:

| Time | Event | Result |
|---|---|---|
| 15:03:03Z | Queue pushes `0bc07a5` (changes the manifest) | `push` run created, job skipped by the manifest guard, no write |
| 15:03:23Z | PR 9 marked merged | `pull_request` closed event, `merged == true`, head `release-please--branches--main`, `GITHUB_REF` `refs/heads/main`, job runs |
| after 15:03:23Z | closed run | release-please sees PR 9 merged, tags `v0.1.0`, publishes the release, then opens or updates the next release PR from commits after the tag |

Queue group `[release PR, other PR]` (up to 3 entries land in one push):

| Order | Push run | Closed run |
|---|---|---|
| release PR first, other PR tip | skipped: the release commit is in `commits` and changed the manifest | builds the release, then covers the other PR's commit |
| other PR first, release PR tip | skipped, same reason | same |

A separate push with no manifest change inside the roughly 20 s between a queue push and the merge mark still runs and races. The run can fail (alert) or open a stray release PR; the closed run still builds the release. The guard does not close this window.

Any other PR close skips the job: `merged` is false, or the head branch does not start with `release-please--`. The `release-please` group moved from the workflow to the job, so a skipped run never joins it and cannot replace the pending closed run that builds a release. A running run is never cancelled; a pending run can be replaced by a later pending run, which sees the same merge. The action reads the default branch from the repository, not the event ref (`src/index.ts`, `loadOrBuildManifest`, at the pinned commit `45996ed`).

For a merged close `GITHUB_REF` is `refs/heads/main`; only an unmerged close carries `refs/pull/N/merge`. That is why the `release` environment, whose deployment refs allow `main` only, admits the job: on any other ref it refuses before the job reads `RELEASE_APP_KEY`.

## Not proven here

No workflow test harness exists, so the trigger conditions rest on the config diff and this trace. #243 proves it live on a repository with the merge queue, and must check each of these:

1. The closed run starts after the merge mark with `GITHUB_REF` `refs/heads/main` and the `release` environment admits it.
2. The `push` run for the release commit is skipped by the manifest guard (`github.event.commits.*.modified` holds `.release-please-manifest.json`).
3. PR closes that skip leave no cancelled or pending `release-please` run behind (skipped jobs never join the job-level group).
4. The closed run creates the tag and release and opens no stray release PR.
