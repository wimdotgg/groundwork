# Phase 5 G6 release run 2026-11-22

Issue #222, epic #169. Session 86a0f304-8103-4782-933e-8efd2bd8de52, `sonnet/claude-code`. Target: `wimdotgg/gw-acceptance`.

## Release (AC1)

The owner login `wianvdm` merged [gw-acceptance#9](https://github.com/wimdotgg/gw-acceptance/pull/9) ("chore(main): release 0.1.0") at 2026-11-22T15:03:23Z through the merge queue. Merge commit `0bc07a5`.

- Tag `v0.1.0`: `GET git/ref/tags/v0.1.0` returns `0bc07a51f398b664f0c38be6fbc3823e711e69d5`.
- Release: [v0.1.0](https://github.com/wimdotgg/gw-acceptance/releases/tag/v0.1.0), not a draft, published 15:09:24Z, author `wimdotgg-release[bot]`.

### Race

release-please run 45036123914 attempt 1 was created at 15:03:03Z, before the merge queue marked #9 merged at 15:03:23Z. It opened release PR #29 (0.2.0) at 15:03:24Z, then failed at 15:03:26Z updating the closed #9: "state cannot be changed. The pull request cannot be reopened." It built no release. The owner re-ran it; attempt 2 succeeded and produced the tag and release. #29 is untouched.

## Tag probe (AC2)

One request, as sanctioned for #222 only (epic #169 Decision 2026-11-22). Agent App through the wrapper, body `{"ref":"refs/tags/v0.0.0-probe","sha":"0bc07a51f398b664f0c38be6fbc3823e711e69d5"}`:

```
$ node scripts/agent/token.mjs exec -- gh api repos/wimdotgg/gw-acceptance/git/refs --input probe.json
{"message":"Reference update failed","documentation_url":"https://docs.github.com/rest/git/refs#create-a-reference","status":"422"}
gh: Reference update failed (HTTP 422)
```

GitHub's response does not name `release-tag-creation`, so the criterion's "naming the rule (quoted)" cannot be met from the body. The owner accepted this: the 422, the absent tag and the AC3 rows together are the evidence. Afterwards `git ls-remote --tags` lists only `refs/tags/v0.1.0`; no `v0.0.0-probe`. No second probe.

## Check (AC3)

[groundwork run 45037009286](https://github.com/wimdotgg/groundwork/actions/runs/45037009286), `admin-run check gw-acceptance`, `plan` and `apply` success, approved by `wianvdm` in `admin`. From the `apply` log:

```
Result: pass (83 rows, all match or deferred).
match: 82, differ: 0, missing: 0, extra: 0, unreadable: 0, deferred: 1
```

The summary lists counts only. The one deferred row is not a tag-ruleset row: `deferred` comes only from the code-scanning and `assertWhen` variable paths (`scripts/lib/settings.mjs:304-309`, `:347`), so both tag rows are among the 82 matches. The tag-rule bypass actors come from the desired files on `gw-acceptance` `main` (`.github/groundwork/rulesets/`), which the check matched against live:

- `release-tag-creation`: tag ruleset, active, rule `creation`, one bypass actor: Integration `{{app-id:release}}`, mode `always`. `GET apps/wimdotgg-release` gives id 5796650. The release App is the only bypass actor.
- `release-tag-immutability`: tag ruleset, active, rules `deletion`, `update`, `non_fast_forward`, `bypass_actors: []`. No bypass actor at all, so the release App is not one here.

AC3 says the release App is the only bypass actor on both rules. The design differs: spec 9.3 (`docs/spec.md:662-663`) fixes `release-tag-immutability` at `bypass_actors: []`, so no one can move or delete a release tag. The App's only privilege is creation (9.2). AC3's "both" is the mismatch, and the reviewer ruled AC3 met in substance. A direct read of live `bypass_actors` returns null for the agent App token, so the live side rests on the check's match, not on my read. Zero rows differ.
