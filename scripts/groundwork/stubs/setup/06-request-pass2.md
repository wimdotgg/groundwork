# Request bootstrap-pass2
<!-- type: Chore -->
<!-- size: S -->
<!-- blocked-by: 01, 02, 03, 04, 05 -->

## Outcome

`bootstrap-pass2` is requested and the owner can approve it with every setup task merged.

## Serves

E6

## Scope

In: run `scripts/admin/request.mjs bootstrap-pass2 --repo __REPO__` from the control repository. Out: approving the run (owner only).

## Touches

none

## Acceptance criteria

- [ ] AC1 The request run exists and awaits the owner's approval.
- [ ] AC2 The task comment links the run and states the `deploy` mode.

## Verification plan

Open the linked admin run and confirm it waits for approval.

## Risk

low

## Context

`bootstrap-pass2` refuses to run while `scripts/verify` is still the stub.
