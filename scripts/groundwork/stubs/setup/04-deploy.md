# Decide deploy: scripts or none
<!-- type: Chore -->
<!-- size: M -->
<!-- blocked-by: 01 -->

## Outcome

The deploy decision is recorded in `config.json`: `"deploy": "scripts"` with working deploy, smoke and rollback scripts, or `"deploy": "none"` with no scripts. A new project starts with `none`.

## Serves

E4

## Scope

In: for a project that deploys, set `"deploy": "scripts"` and write `scripts/deploy`, `scripts/smoke` and `scripts/rollback` with their `.cmd` shims; otherwise leave `"deploy": "none"`. Out: entering deploy secrets (owner only, listed by `bootstrap-pass2`).

## Touches

`scripts/deploy`, `scripts/deploy.cmd`, `scripts/smoke`, `scripts/smoke.cmd`, `scripts/rollback`, `scripts/rollback.cmd`, `.github/groundwork/config.json`

## Acceptance criteria

- [ ] AC1 `config.json` has `"deploy": "scripts"` and all three scripts and their `.cmd` shims exist, or it has `"deploy": "none"` and none of them exists.
- [ ] AC2 Each script exits non-zero on failure.

## Verification plan

Read `config.json` and list `scripts/`; for `scripts`, run `scripts/smoke` against a local or staging target.

## Risk

medium: a broken deploy script fails only at release time, so review `scripts/rollback` first.

## Context

`bootstrap-pass2` sets `DEPLOY_ENABLED` unless the project declares `"deploy": "none"`.
