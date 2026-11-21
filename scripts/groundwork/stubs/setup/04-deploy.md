# Decide deploy: scripts or none
<!-- type: Chore -->
<!-- size: M -->
<!-- blocked-by: 01 -->

## Outcome

The deploy decision is recorded in `config.json`: `"deploy": "scripts"` with working deploy, smoke and rollback scripts, or `"deploy": "none"` with no scripts. A new project starts with `none`.

## Serves

E4

## Scope

In: for a project that deploys, move the stubs from `scripts/stubs/deploy/` to `scripts/`, replace their bodies, and set `"deploy": "scripts"`; otherwise leave `"deploy": "none"` and the stubs where they are. Each stub prints a `GROUNDWORK_STUB` line to stderr and exits 1 until replaced. Contract (spec 8.5): `scripts/deploy <tag>` deploys the release tag `vX.Y.Z` and reads its secrets from `process.env`; `scripts/smoke` takes no arguments, is read-only and idempotent, and runs after deploy and after rollback; `scripts/rollback <previous tag>` redeploys that tag. Exit 0 is success. Out: entering deploy secrets (owner only, listed by `bootstrap-pass2`).

## Touches

`scripts/stubs/deploy/`, `scripts/deploy`, `scripts/deploy.cmd`, `scripts/smoke`, `scripts/smoke.cmd`, `scripts/rollback`, `scripts/rollback.cmd`, `.github/groundwork/config.json`

## Acceptance criteria

- [ ] AC1 `config.json` has `"deploy": "scripts"` and all three scripts and their `.cmd` shims exist, or it has `"deploy": "none"` and none of them exists.
- [ ] AC2 Each script exits non-zero on failure.

## Verification plan

Read `config.json` and list `scripts/`; for `scripts`, run `scripts/smoke` against a local or staging target.

## Risk

medium: a broken deploy script fails only at release time, so review `scripts/rollback` first.

## Context

`bootstrap-pass2` sets `DEPLOY_ENABLED` unless the project declares `"deploy": "none"`.
