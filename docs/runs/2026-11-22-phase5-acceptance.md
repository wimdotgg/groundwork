# Phase 5 acceptance run 2026-11-22

Issue #224, epic #169. Session 298f2bc2-9741-4e1c-8da5-bd87919b0be7, `sonnet/claude-code`, Node 24.22.3 on Windows. PR #239.

## E1 to E8

| Criterion | Evidence |
|---|---|
| E1 (G1) | One `bootstrap` request, [groundwork run 45018831414](https://github.com/wimdotgg/groundwork/actions/runs/45018831414); pass 2 as one more approval. `docs/runs/2026-11-22-phase5-bootstrap.md`, `docs/runs/2026-11-22-phase5-setup-pass2.md` |
| E2 (G2) | Closing `check`: 83 rows, 0 differ, 3 deferred. Push probe: `push probe rejected: main is protected`. `docs/runs/2026-11-22-phase5-bootstrap.md` |
| E3 (G3) | Parallel lane tasks claimed by distinct sessions in their own clones, merged through the queue (for example gw-acceptance #26 and #27, claimed 31 seconds apart). `docs/runs/2026-11-22-phase5-g3-parallel.md` |
| E4 (G4) | Three blocked PRs, one per case: gw-acceptance #22 (protected path), #23 (no accepted ancestor epic), #24 (AC without an evidence row). `docs/runs/2026-11-22-phase5-g4-blocked-prs.md` |
| E5 (G5) | Worker killed at 14:35:29Z; takeover commit at 16:06:20Z, 92 minutes after the last agent comment, past the configured 20-minute lease, with no released marker; completed from `resume` output. `docs/runs/2026-11-22-phase5-g5-takeover.md` |
| E6 (G6) | Release PR gw-acceptance#9 merged by the owner: tag `v0.1.0` and release. Tag probe by the agent App: HTTP 422, no `v0.0.0-probe`. `check` 83 rows, 0 differ ([groundwork run 45037009286](https://github.com/wimdotgg/groundwork/actions/runs/45037009286)). `docs/runs/2026-11-22-phase5-g6-release.md` |
| E7 (G7) | every script has a test file; the `scripts` job ran 42 test files, 1398 tests, all passing; spec 19 has no known gap or partial row. `docs/runs/2026-11-22-phase5-g7-audit.md` |
| E8 | Final `check --repo groundwork`: see below. Spec header "v1 done" and the closing section 21 entry (this PR). |

## Final check (AC4)

CHECK_RESULT

## Carry-over (AC6, AC7)

One row per item of the [carry-over comment](https://github.com/wimdotgg/groundwork/issues/224#issuecomment-7082520228). "Verified fixed" cites what the merged PR did.

| Item | Result |
|---|---|
| #228 R7: spec 1237 and 1306 name `gh copilot`, `gh attestation trusted-root` and `gh attestation verify --bundle` as untraced | Verified fixed by #229: the credentials bullet (spec 17) no longer lists them as untraced and says `gh attestation` is allowed wrapped. The earlier section 21 entry for #227 still carries the sentence and stays as written (AC3) |
| #228 R8: `docs/runs/2026-11-22-agent-gh-config-denies.md:62` stale | Verified fixed: the file's ignore-rule transcript (line 62) shows rule `**/.claude/gh-agent/` |
| Open owner question: denies for `gh extension*`, `release download`, `attestation`, `copilot`; `AGENTS.md:82`, `:91` bare commands | Verified fixed by #229 and #230: `gh extension`, `gh ext`, `gh extensions` and `gh copilot` are denied wrapped, `release download` and `attestation` are allowed wrapped (spec 17), and every bare `gh` is denied; `AGENTS.md` Worker loop runs every script under the wrapper |
| #228 R11: spec 358 and `docs/workflow.md:38` show bare `next.mjs` and "only writes under the wrapper" | Verified fixed by #229: spec.md:358 and `docs/workflow.md:38` show `token.mjs exec -- node scripts/agent/next.mjs` and say reads go through the wrapper (`docs/runs/2026-11-22-gh-blanket-deny.md`) |
| #230 R6: `AGENTS.md:14` and the skills' line 18 say "bare gh writes are forbidden" and "a bare gh exits 4" | Fixed: `AGENTS.md:14` and `.claude/skills/groundwork-*/SKILL.md:18` now say bare `gh` is denied outright; grep output in the PR |
| #230 R11: spec 1306 "a wrapped `gh.exe` or path-qualified `gh` is denied, as before" | Fixed by erratum in the Phase 5 section 21 entry; the earlier entry stays as written (AC3) |
| #230 R12: `docs/runs/2026-11-22-gh-blanket-deny.md:131` gotcha | Fixed: `docs/runs/2026-11-22-gh-blanket-deny.md:131` says the separator rules deny any command text with `/` or `\` before `gh ` |
| Conflict: reviewer skill `gh api ... -X POST -f` against `AGENTS.md` | Fixed (owner Decision 2026-11-22: `AGENTS.md` wins): `.claude/skills/groundwork-reviewer/SKILL.md:37` posts with `gh pr review N --comment --body-file <file>` |
| #221 worker used a `gh api` REST PATCH to set an issue type | Fixed: planner skill step 5 uses `gh issue edit <n> --type <Type>`; gh 2.102.0 has the flag |
| Release PR opened before pass 2 has no CodeQL run | Fixed: spec 14.2 step 4 and `docs/setup.md` (the pass 2 step) say to close and reopen the PR, then approve again |
| Planner skill REST fallback (`PATCH` type, `POST` sub_issues, `POST` blocked_by) | Fixed: `.claude/skills/groundwork-planner/SKILL.md:40` uses `gh issue edit --type`, `--parent` or `--add-sub-issue`, and `--add-blocked-by`. Every relation has a CLI form, so the skill needs no stop-and-ask beyond a relation `gh issue` cannot set |
| `claim.mjs` doubles the type prefix (`feat: feat: ...`) | Fixed: `scripts/agent/claim.mjs` (`withoutTypePrefix`), test `AC8` in `scripts/agent/claim.test.mjs`. Failing run before the fix: `actual: 'feat: feat: add slugify module'`, `expected: 'feat: add slugify module'`; 36 of 36 pass after |
| Lease prose hardcodes "4 hours" (gw-acceptance PR #32 R1) | Fixed: `AGENTS.md` (Leases), `scripts/agent/claim.mjs` (`takeOver` comment) and spec 6.4 read "the configured lease (default 4 hours)" |
| #222 AC3 wording ("release App only bypass actor on both tag rules") | Recorded: spec 9.3 fixes `release-tag-immutability` at no bypass actors, so the criterion's "both" does not match the design; the reviewer ruled AC3 met in substance (`docs/runs/2026-11-22-phase5-g6-release.md`). The closed issue body is not edited |
| Release-please race against the merge queue | Out of scope: tracked as [#238](https://github.com/wimdotgg/groundwork/issues/238). Seen at gw-acceptance#9: the run started 15:03:16Z, GitHub marked the PR merged at 15:03:23Z, so no release was built and a second release PR (#29) opened |

## Left as is

- `gw-acceptance` `limits.draftLeaseMinutes` stays at 20 (owner decision 2026-11-22). The repository is deleted after Phase 5, so it is not restored.
- gw-acceptance#29 stays open by owner decision.
- gw-acceptance branches `issue/19`, `issue/20` and `issue/21` (G4 probe PRs, closed unmerged) remain.
