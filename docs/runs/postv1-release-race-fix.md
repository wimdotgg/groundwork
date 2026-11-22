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

`release-please.yml` runs on `pull_request: closed` (base `main`) and `workflow_dispatch`. It has no `push` trigger (owner decision on #242, after review round 2 of #244). Two reasons: the push run races the merge mark, and an Actions `push` payload has no added, removed or modified file lists, so no push guard can tell a release commit from another. A first version of this fix keyed a push skip on `github.event.commits.*.modified`; that expression never matches.

The job `if` requires, per event:

- `pull_request`: the PR is merged and its head repository is this repository. Any head branch qualifies, so release PRs are created and updated after ordinary merges.
- `workflow_dispatch`: runs.

Trace of the same timeline under the new trigger:

| Time | Event | Result |
|---|---|---|
| 15:03:03Z | Queue pushes `0bc07a5` | no `push` trigger, no run |
| 15:03:23Z | PR 9 marked merged | `pull_request` closed event, `merged == true`, same repository, `GITHUB_REF` `refs/heads/main`, job runs |
| after 15:03:23Z | closed run | release-please sees PR 9 merged, tags `v0.1.0`, publishes the release, then opens or updates the next release PR from commits after the tag |

A queue group `[release PR, other PR]` lands in one push; each PR gets its own closed event after the merge mark, and each run sees both merges, so the order inside the group does not matter. Unmerged and fork closes skip the job. The `release-please` group sits on the job with `cancel-in-progress: false`: a running run is never cancelled, a pending run can be replaced by a later pending run, which sees the same merges. A skipped job is assumed not to join the group (assumption, item 3 below). The action reads the default branch from the repository, not the event ref (`src/index.ts`, `loadOrBuildManifest`, at the pinned commit `45996ed`).

For a merged close `GITHUB_REF` is `refs/heads/main`; only an unmerged close carries `refs/pull/N/merge`. That is why the `release` environment, whose deployment refs allow `main` only, admits the job: on any other ref it refuses before the job reads `RELEASE_APP_KEY`.

## Consequences and limits

- A merged fork PR runs nothing; the next same-repository merge or a dispatch picks it up.
- The bootstrap commit is a push and starts no run; setup step 7 dispatches the workflow once.
- A Dependabot PR close may run without the environment secrets (unverified).
- A stray release PR stays wrong when no releasable commit follows: PR 29 stayed untouched after the owner's rerun built the release.

## Not proven here

No workflow test harness exists, so the trigger conditions rest on the config diff and this trace. #243 proves it live on a repository with the merge queue, and must check each of these:

1. The first merged same-repository PR close builds or updates the release PR.
2. Merging a release PR through the merge queue yields tag and release with no stray release PR, and the closed run's `GITHUB_REF` is `refs/heads/main`, which the `release` environment admits.
3. PR closes that skip leave no cancelled or pending `release-please` run behind (skipped jobs never join the job-level group).
4. A Dependabot PR close: whether the job gets the environment secrets, if one is observable.
