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

- `push`: the commit message must not start with `chore(main): release `.
- `pull_request`: the PR is merged, its head repository is this repository and its head branch starts with `release-please--`.
- `workflow_dispatch`: unchanged.

Trace of the same timeline under the new trigger:

| Time | Event | Result |
|---|---|---|
| 15:03:03Z | Queue pushes `0bc07a5` ("chore(main): release 0.1.0 (#9)") | `push` run created, job skipped by the message guard, no write |
| 15:03:23Z | PR 9 marked merged | `pull_request` closed event, `merged == true`, head `release-please--branches--main`, job runs |
| after 15:03:23Z | closed run | release-please sees PR 9 merged, tags `v0.1.0`, publishes the release, then opens or updates the next release PR from commits after the tag |

Any other PR close skips the job: `merged` is false, or the head branch does not start with `release-please--`. The `release-please` concurrency group is kept, so a manual `workflow_dispatch` cannot overlap a closed run. The action reads the default branch from the repository, not the event ref (`src/index.ts`, `loadOrBuildManifest`, at the pinned commit `45996ed`), so the closed event's ref `refs/pull/N/merge` does no harm.

## Not proven here

No workflow test harness exists, so the trigger conditions rest on the config diff and this trace. #243 proves it live on a repository with the merge queue.
