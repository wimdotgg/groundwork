# Project setup: __REPO__

## Goal

Make `__ORG__/__REPO__` ready for agent work: a real stack behind `scripts/verify`, dependency updates, serialized resources named, deploy decided, code scanning enforced.

## Success criteria

- [ ] E1 `scripts/verify` runs the project's real build and tests, and the `GROUNDWORK_STUB` marker is gone.
- [ ] E2 `.github/dependabot.yml` covers every package ecosystem the project uses.
- [ ] E3 `.github/groundwork/hotspots.json` names the serialized resources and `README.md` describes the project.
- [ ] E4 `config.json` has `"deploy": "scripts"` and `scripts/deploy`, `scripts/smoke` and `scripts/rollback` exist, or it keeps `"deploy": "none"` and none of them exists.
- [ ] E5 `.github/groundwork/rulesets/main.json` carries the `code_scanning` rule.
- [ ] E6 `bootstrap-pass2` has run and its closing `check` passed.

## Constraints

- Every change goes through a task PR; nothing is pushed to `main`.
- The owner applies `accepted` to this epic and approves `bootstrap-pass2`.

## Plan

Task 01 comes first: the stack decides the rest. Tasks 02 to 05 then run in parallel. Task 06 requests `bootstrap-pass2` once the others are merged.

## Decisions

None yet.

## Open questions

Which stack does the project use?
