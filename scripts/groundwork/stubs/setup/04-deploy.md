# Decide deploy: scripts or none
<!-- type: Chore -->
<!-- size: M -->
<!-- blocked-by: 01 -->

## Outcome

The deploy decision is recorded: either working `scripts/deploy`, `scripts/smoke` and `scripts/rollback`, or `"deploy": "none"` in `config.json`.

## Serves

E4

## Scope

In: write the three scripts for a project that deploys, or set `"deploy": "none"`. Out: entering deploy secrets (owner only, listed by `bootstrap-pass2`).

## Touches

`scripts/deploy`, `scripts/smoke`, `scripts/rollback`, `.github/groundwork/config.json`

## Acceptance criteria

- [ ] AC1 Either all three scripts exist and are executable, or `config.json` has `"deploy": "none"` and no script exists.
- [ ] AC2 Each script exits non-zero on failure.

## Verification plan

Run `scripts/smoke` against a local or staging target, or read `config.json` for the `none` case.

## Risk

medium: a broken deploy script fails only at release time, so review `scripts/rollback` first.

## Context

`bootstrap-pass2` sets `DEPLOY_ENABLED` unless the project declares `"deploy": "none"`.
