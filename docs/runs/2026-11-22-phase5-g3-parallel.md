# Phase 5 G3 parallel-lane run 2026-11-22

Issue #219, epic #169. Session 6e1b4735-3f8a-4c91-9021-de7a6cc7ae06, `sonnet/claude-code`. Target: `gw-acceptance` (owner `wimdotgg`). The live run is finished; this note records it from GitHub reads and from the branches checked out in the seven local worker clones. Epic gw-acceptance#13 was closed as completed by the owner at 2026-11-22T16:31:37Z, after the acceptance comment (16:26:53Z). `gw-acceptance` is deleted by the owner once epic #242 closes (#242 Decisions), so this note is the record: every reference to it is a name, number, run ID or quoted value, not a link. `{owner}` in a path or quoted output stands for `wimdotgg`.

Each task ran in its own clone and its own top-level T3 thread. Every claim names a distinct session id.

## AC1: epic, lanes, plan-lint, accepted

Epic #13 was created at 14:10:51Z. The owner login `wianvdm` applied `accepted` at 14:23:34Z (issue timeline).

| Task | Role | Blocked by |
|---|---|---|
| gw-acceptance#14 mean | lane | none |
| gw-acceptance#15 clamp | lane | none |
| gw-acceptance#16 unique | lane | none |
| gw-acceptance#17 slugify | lane (G5 takeover task) | none |
| gw-acceptance#31 shorten the draft lease | lane, added after the plan under an owner decision | none |
| gw-acceptance#18 wire modules into `src/index.mjs` | integration | #14, #15, #16, #17, #31 |

`GET issues/{n}/dependencies/blocked_by` returns an empty list for #14, #15, #16, #17 and #31, and exactly those five for #18.

Plan comment: gw-acceptance#13 comment 7080354210, `Plan lint #13: pass`, created 14:11:05Z and updated in place (the marker comment) at 15:55:56Z. Its latest body shows lane width 2 (#17 and #31 still open, #18 behind them) and no failures.

`plan-lint 13 --close`, run against `gw-acceptance` at 16:32Z with `GITHUB_REPOSITORY={owner}/gw-acceptance`, prints `Epic close #13: pass`. The acceptance comment is gw-acceptance#13 comment 7082080746, posted 16:26:53Z by `wimdotgg-agent`, with every E criterion mapped. It names #31 as added after the plan and #17 as taken over once.

## AC2: concurrent sessions

| Task | PR | Session | Clone | Claim commit | Merged |
|---|---|---|---|---|---|
| #17 first claim | gw-acceptance#25 | `3b47a28e-232e-4e37-a06e-619783fa6e73` | `gw-acceptance-g5a` | `bc509b1` 14:33:44Z | not merged by this session; killed 14:35:29Z |
| #14 | gw-acceptance#26 | `a35eec0f-d0d5-43d2-a6b5-5dc5ff93afe8` | `gw-acceptance-l1` | `a86f94d` 14:36:52Z | 14:42:38Z |
| #15 | gw-acceptance#27 | `9fc905d5-5171-41fa-9771-61552156ca92` | `gw-acceptance-l2` | `1250b65` 14:37:23Z | 14:42:55Z |
| #16 | gw-acceptance#28 | `fc6aeea4-4a0a-40c4-acf6-4c41f748db43` | `gw-acceptance-l3` | `ef24029` 14:40:10Z | 14:48:58Z |
| #31 | gw-acceptance#32 | `bd24be3c-061d-40fa-b92e-d61da101ed5f` | `gw-acceptance-lease` | `7d65c31` 15:56:45Z | 16:04:32Z |
| #17 takeover | #25 | `2d9c71ba-9635-4dfa-9d05-a6b3268f3390` | `gw-acceptance-g5b` | `b928a29` 16:06:20Z | 16:13:14Z |
| #18 | gw-acceptance#33 | `1cbd2eab-3d20-4857-a0f8-f0b544f4e4ff` | `gw-acceptance-int` | `0c23960` 16:15:18Z | 16:22:04Z |

Claim times are the commit dates on the PR; merge times are `mergedAt`. Session ids come from the claim commit messages and match the PR `## State` headers and the `Claim:` comments. The clone column comes from the branch each clone has checked out and the claim commits in its history. The kill time of the first #17 session is not on GitHub: its last write is the 14:34:21Z commit. 14:35:29Z is the run's own record, not a GitHub read.

Overlapping intervals, all with different session ids:

- #14 (14:36:52 to 14:42:38) and #15 (14:37:23 to 14:42:55): both held for about five minutes together.
- #16 (14:40:10 to 14:48:58) overlaps #14 until 14:42:38 and #15 until 14:42:55.

## AC3: merge queue and closed sub-issues

Each PR has a `merge_group` run on a `gh-readonly-queue/main/pr-N-...` branch, listed by `gh run list --event merge_group`. All concluded `success`.

| PR | `ci` | `pr-metadata` | Merged |
|---|---|---|---|
| #26 | gw-acceptance run 45034235922 | gw-acceptance run 45034235731 | 14:42:38Z, `de3cb29` |
| #27 | gw-acceptance run 45034237245 | gw-acceptance run 45034236788 | 14:42:55Z, `f906b0f` |
| #28 | gw-acceptance run 45034810957 | gw-acceptance run 45034810479 | 14:48:58Z, `b75bb1e` |
| #32 | gw-acceptance run 45041725099 | gw-acceptance run 45041724785 | 16:04:32Z, `5c3a454` |
| #25 | gw-acceptance run 45042508342 | gw-acceptance run 45042508087 | 16:13:14Z, `9913b94` |
| #33 | gw-acceptance run 45043380141 | gw-acceptance run 45043379654 | 16:22:04Z, `42bf2bb` |

`merge_group` runs exist only for queued PRs, so each is a direct proof of queue entry.

Issue state: #14, #15, #16, #17, #18 and #31 are all `CLOSED` with `stateReason: COMPLETED`, closed within 5 seconds of their PR merge (for example #14 at 14:42:42Z).

## AC4: claims, footers, journals

One `chore(claim): #N [session ...]` commit and one PR per task. Only #17 has a second claim-type commit, `b928a29` `chore(claim): #17 takeover [session 2d9c71ba-...]`, on gw-acceptance PR #25. #31 has its own task and PR, so it also has one claim commit and no takeover.

`issue/N` claim refs are deleted on merge: `matching-refs/heads/issue/` on `gw-acceptance` now lists only `issue/19`, `issue/20` and `issue/21` (the G4 probes). The claim is therefore evidenced by the claim commit, the issue's `Claimed on issue/N by session ...` comment and the PR's `Claim:` comment.

| Task, claim ref | Issue claim comment | PR claim comment | PR footer (`Agent:` line) | Journal comments |
|---|---|---|---|---|
| #14, `issue/14` | gw-acceptance#14 comment 7080675410 | gw-acceptance#26 comment 7080676126 | session `a35eec0f` | cp1 comment 7080686686, cp2 comment 7080729484 |
| #15, `issue/15` | gw-acceptance#15 comment 7080681771 | gw-acceptance#27 comment 7080682283 | session `9fc905d5` | cp1 comment 7080698397, cp2 comment 7080730021 |
| #16, `issue/16` | gw-acceptance#16 comment 7080716149 | gw-acceptance#28 comment 7080716737 | session `fc6aeea4` | cp1 comment 7080732153, cp2 comment 7080775024, cp3 comment 7080811700 |
| #17, `issue/17` | gw-acceptance#17 comment 7080636667 | gw-acceptance#25 comment 7080637207, takeover gw-acceptance#25 comment 7081816568 | session `2d9c71ba` (after takeover) | cp1 comment 7081830640, cp2 comment 7081838841, cp3 comment 7081880242 |
| #31, `issue/31` | gw-acceptance#31 comment 7081693988 | gw-acceptance#32 comment 7081694539 | session `bd24be3c` | cp1 comment 7081709394 |
| #18, `issue/18` | gw-acceptance#18 comment 7081932208 | gw-acceptance#33 comment 7081932911 | session `1cbd2eab` | cp1 comment 7081946090, cp2 comment 7082000118 |

Each PR closes its own task (`closingIssuesReferences`: #25 to #17, #26 to #14, #27 to #15, #28 to #16, #32 to #31, #33 to #18). Handover comments on the issues follow each merge, for example gw-acceptance#17 comment 7081911313.

The takeover followed #32 (merged 16:04:32Z), a `gw-acceptance` config change made for this run by owner decision: `limits.draftLeaseMinutes` 240 to 20 in `.github/groundwork/config.json`. Spec 6.4 keeps the 4-hour default.

## Observations

- Title prefix: PRs #25 to #28, #32 and #33 opened as `feat: feat: ...` or `chore: chore: ...` (a doubled prefix from the issue title) and were renamed by hand: #27 at 14:38:16Z, #26 at 14:40:51Z, #28 at 14:41:47Z, #25 at 16:07:50Z, #32 at 15:57:41Z, #33 at 16:16:38Z (PR timeline `renamed` events). `claim.mjs` builds the title from the issue title; carried over to #224.
- The merge queue gave each lane PR its own `merge_group` run. #26 and #27 entered the queue at 14:41:47Z and 14:41:52Z (`added_to_merge_queue`), their `merge_group` runs started 14:42:05Z and 14:42:06Z, and they merged 17 seconds apart.
