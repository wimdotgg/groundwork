# Confirm the code_scanning rule in the main ruleset
<!-- type: Chore -->
<!-- size: S -->
<!-- blocked-by: 01 -->

## Outcome

`rulesets/main.json` carries the `code_scanning` rule, so `check` and `apply-settings` agree with the live ruleset once `bootstrap-pass2` runs.

## Serves

E5

## Scope

In: open `.github/groundwork/rulesets/main.json` and confirm it holds a `code_scanning` rule for CodeQL. A project from template `v0.6.0` or later has it: change nothing, close this issue with a comment that names the rule, and add a dated line to the epic's `## Decisions`. A project from an older template lacks it: add the rule in a PR. Out: enabling CodeQL default setup (done by `bootstrap-pass2`).

## Touches

`.github/groundwork/rulesets/main.json` (only when the rule is missing)

## Acceptance criteria

- [ ] AC1 `rulesets/main.json` holds a `code_scanning` rule, found as it was or added, and every other rule is unchanged.
- [ ] AC2 The file remains valid JSON that `apply-settings` accepts.

## Verification plan

Read the file for the rule. When a PR added it, the `Check` workflow validates the settings files.

## Risk

low

## Context

Until CodeQL default setup is configured, `apply-settings` leaves the rule out and `check` reports it as deferred (spec 9.1).
