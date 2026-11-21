# Define hotspots and write the README
<!-- type: Chore -->
<!-- size: S -->
<!-- blocked-by: 01 -->

## Outcome

Serialized resources are named for the `next` script, and the README tells a newcomer what the project is and how to verify it.

## Serves

E3

## Scope

In: list lockfiles, migrations or generated schemas in `.github/groundwork/hotspots.json` (exact paths or directory prefixes, no globs); replace the README stub. Out: deploy docs.

## Touches

`.github/groundwork/hotspots.json`, `README.md`

## Acceptance criteria

- [ ] AC1 `hotspots.json` names every resource that two tasks must not change at once, or stays an empty list with the reason in the PR.
- [ ] AC2 `README.md` states what the project does, the chosen stack and how to run `scripts/verify`.

## Verification plan

Run `scripts/verify` and the `Check` workflow, then read the README from a clean clone.

## Risk

low

## Context

Hotspot paths are exact paths or directory prefixes (spec 6.2).
