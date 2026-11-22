# Decide deploy: scripts or none
<!-- type: Chore -->
<!-- size: M -->
<!-- blocked-by: 01 -->

## Outcome

The deploy decision is recorded in `config.json`: `"deploy": "scripts"` with working deploy, smoke and rollback scripts, or `"deploy": "none"` with no scripts. A new project starts with `none`.

## Serves

E4

## Scope

In: for a project that deploys, `git mv` the stubs from `scripts/stubs/deploy/` to `scripts/` (the scripts must keep mode 100755), replace their bodies, and set `"deploy": "scripts"`; otherwise leave `"deploy": "none"` and the stubs where they are. Each stub prints a `GROUNDWORK_STUB` line to stderr and exits 1 until replaced. Contract (spec 8.5): `scripts/deploy <tag>` deploys the release tag `vX.Y.Z` and reads its secrets from `process.env`; `scripts/smoke` takes no arguments, is read-only and idempotent, and runs after deploy and after rollback; `scripts/rollback <previous tag>` redeploys that tag. Exit 0 is success. List each production secret name in `environments.production.secrets` of `.github/groundwork/settings.json`, then map each one into the `deploy` job `env` in `.github/workflows/deploy.yml`, so the script sees it. Out: entering deploy secrets (owner only, listed by `bootstrap-pass2`).

## Touches

`scripts/stubs/deploy/`, `scripts/deploy`, `scripts/deploy.cmd`, `scripts/smoke`, `scripts/smoke.cmd`, `scripts/rollback`, `scripts/rollback.cmd`, `.github/groundwork/config.json`, `.github/groundwork/settings.json`, `.github/workflows/deploy.yml`

## Acceptance criteria

- [ ] AC1 `config.json` has `"deploy": "scripts"` and all three scripts and their `.cmd` shims exist and the three scripts are mode 100755 (`git ls-files -s scripts/deploy scripts/smoke scripts/rollback`), or it has `"deploy": "none"` and none of them exists.
- [ ] AC2 Each script exits non-zero on failure.

## Verification plan

Read `config.json` and list `scripts/`; for `scripts`, run `scripts/smoke` against a local or staging target.

## Risk

medium: a broken deploy script fails only at release time, so review `scripts/rollback` first.

## Context

`bootstrap-pass2` sets `DEPLOY_ENABLED` unless the project declares `"deploy": "none"`.
