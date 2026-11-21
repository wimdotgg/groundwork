# Add the code_scanning rule to the main ruleset
<!-- type: Chore -->
<!-- size: S -->
<!-- blocked-by: 01 -->

## Outcome

`rulesets/main.json` carries the `code_scanning` rule, so `check` and `apply-settings` agree with the live ruleset once `bootstrap-pass2` runs.

## Serves

E5

## Scope

In: add a `code_scanning` rule for CodeQL to `.github/groundwork/rulesets/main.json`. Out: enabling CodeQL default setup (done by `bootstrap-pass2`).

## Touches

`.github/groundwork/rulesets/main.json`

## Acceptance criteria

- [ ] AC1 `rulesets/main.json` holds a `code_scanning` rule and every existing rule is unchanged.
- [ ] AC2 The file remains valid JSON that `apply-settings` accepts.

## Verification plan

Run the `Check` workflow; it validates the settings files.

## Risk

low

## Context

Until CodeQL default setup is configured, `apply-settings` leaves the rule out and `check` reports it as deferred (spec 9.1).
