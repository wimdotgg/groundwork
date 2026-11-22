# Release-please race with the merge queue

Issue #238, epic #242. Session 796c62d1-7b1a-489c-a7aa-2be0a912db7f, `sonnet/claude-code`. Fix: `.github/workflows/release-please.yml`; trigger documented in spec 11 and 8.5. The live proof is #243.

Correction (#247, session c1c8b9d9-cdf7-4a9b-aece-6d95192469a4, `sonnet/claude-code`): the first version of the fix failed on its own merge. See "Live failure and correction"; the trace and the `GITHUB_REF` claims below it were wrong for a merged close and are marked.

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

## Fix and trace under the new trigger (superseded for the release job by #247)

`release-please.yml` runs on `pull_request: closed` (base `main`) and `workflow_dispatch`. It has no `push` trigger (owner decision on #242, after review round 2 of #244). Two reasons: the push run races the merge mark, and an Actions `push` payload has no added, removed or modified file lists, so no push guard can tell a release commit from another. A first version of this fix keyed a push skip on `github.event.commits.*.modified`; that expression never matches.

The first #238 version ran the release job on the closed event itself. Its `if` and trace follow as written; the `GITHUB_REF` column and the closing paragraph are wrong, see the correction below.

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

Wrong, corrected below: this paragraph claimed that a merged close has `GITHUB_REF` `refs/heads/main` and only an unmerged close carries `refs/pull/N/merge`.

## Live failure and correction (#247)

#244 merged as `feeb272` at 2026-11-22T19:10:31Z. Its own closed run, https://github.com/wimdotgg/groundwork/actions/runs/45059252257 (head branch `issue/238`, event `pull_request`), failed in 3 seconds before any step. The run's annotations:

> X Branch "refs/pull/244/merge" is not allowed to deploy to release due to environment protection rules.
>
> X The deployment was rejected or didn't satisfy other protection rules.

A merged close runs with `GITHUB_REF` `refs/pull/N/merge` and the PR side's workflow file. The `release` environment's deployment refs allow `main` only, so it refuses the job. No release PR was created or updated.

A manual `workflow_dispatch` on `main` by the agent App, https://github.com/wimdotgg/groundwork/actions/runs/45062490456, succeeded in 20 seconds and opened release PR #246 (0.10.1). That ref is admitted.

Owner decision (option e, #242): the closed run only notifies. Job `dispatch-on-main` has no environment, `permissions: actions: write` and an `if` on a merged close from this repository. Its one step runs `gh workflow run release-please.yml --ref main` with `GH_TOKEN` set to `github.token`; a `workflow_dispatch` sent with `GITHUB_TOKEN` starts a run. Job `release-please` keeps `environment: release` and the job-level concurrency group, and runs only on `workflow_dispatch` with `GROUNDWORK_READY` true. The repository reaches the step through `GH_REPO`, so no event value is interpolated into the script.

Trace under the corrected design:

| Event | Result |
|---|---|
| Queue pushes the squash commit | no `push` trigger, no run |
| PR marked merged | closed run, `dispatch-on-main` runs, no environment |
| Dispatch | `release-please` run on `refs/heads/main`, the `release` environment admits it, release-please sees the merge |

Unknowns:

- Whether the closed run's `GITHUB_TOKEN` gets `actions: write`: settled by the closed run of #247's own merge.
- A PR whose merge ref predates the fix runs the old workflow file once on its close and fails the environment check again; a manual dispatch covers it.

## Consequences and limits

- A merged fork PR runs nothing; the next same-repository merge or a dispatch picks it up.
- The bootstrap commit is a push and starts no run; setup step 7 dispatches the workflow once.
- A Dependabot PR close runs with a read-only `GITHUB_TOKEN` by default, so its dispatch may fail (unverified).
- A stray release PR stays wrong when no releasable commit follows: PR 29 stayed untouched after the owner's rerun built the release.

## Not proven here

No workflow test harness exists, so the trigger conditions rest on the config diff and this trace. #243 proves it live on a repository with the merge queue, and must check each of these:

1. The first merged same-repository PR close builds or updates the release PR.
2. Merging a release PR through the merge queue yields tag and release with no stray release PR: the closed run dispatches, and the dispatched run on `refs/heads/main` is admitted by the `release` environment.
3. PR closes that skip leave no cancelled or pending `release-please` run behind (skipped jobs never join the job-level group).
4. A Dependabot PR close: whether the dispatch succeeds with its read-only token, if one is observable.
