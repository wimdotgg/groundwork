# Choose the stack and fill scripts/verify
<!-- size: M -->

## Outcome

The project has a chosen stack and `scripts/verify` runs its real build, lint and tests, failing on error.

## Serves

E1

## Scope

In: pick the language and tooling, scaffold the minimal project, replace the stub in `scripts/verify` and keep `scripts/verify.cmd` working. Out: Dependabot, deploy and README.

## Touches

`scripts/verify`, `scripts/verify.cmd`, plus the stack's manifest, lockfile and source directories

## Acceptance criteria

- [ ] AC1 `scripts/verify` no longer contains `GROUNDWORK_STUB` and exits non-zero when a test fails.
- [ ] AC2 The `Check` workflow runs the real `scripts/verify` and passes on the PR.

## Verification plan

Run `scripts/verify` locally, then break a test and confirm a non-zero exit.

## Risk

low

## Context

The stub lives at `scripts/verify`; `bootstrap-pass2` refuses to run while it is still the stub.
