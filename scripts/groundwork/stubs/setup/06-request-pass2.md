# Request bootstrap-pass2
<!-- type: Chore -->
<!-- size: S -->
<!-- blocked-by: 01, 02, 03, 04, 05 -->

## Outcome

`bootstrap-pass2` has run and its closing `check` passed, with every setup task merged.

## Serves

E6

## Scope

In: run `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap-pass2 --repo __REPO__`, then add a "Setup" line to `README.md` with the pass-2 run link and its check result. Out: approving the run (owner only).

## Touches

`README.md`

## Acceptance criteria

- [ ] AC1 `README.md` has a "Setup" line linking the `bootstrap-pass2` run.
- [ ] AC2 The line states the run's final `check` result and the `deploy` mode in `config.json`.

## Verification plan

Open the linked run and confirm it matches the README line.

## Risk

low

## Context

`bootstrap-pass2` refuses to run while `scripts/verify` is still the stub. The task waits for the owner's approval of the admin run; pass 2 also enables CodeQL and waits for its first run on `main`.
