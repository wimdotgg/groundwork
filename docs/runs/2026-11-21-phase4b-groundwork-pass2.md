# Phase 4b: pass 2 and check on groundwork

Date: 2026-11-21. Epic #167, task #178, `main` at `192c481`. Every run is an `admin-run.yml` dispatch on `main`, approved by the owner script (21, Phase 4b owner delegation).

| Step | Run | Result |
|---|---|---|
| `check` before pass 2 | [44942840162](https://github.com/wimdotgg/groundwork/actions/runs/44942840162) | pass: 88 rows, 85 match, 3 deferred |
| `bootstrap-pass2` | [44943060298](https://github.com/wimdotgg/groundwork/actions/runs/44943060298) | pass: default setup `configured`, CodeQL run 44943147788 `success`, `code_scanning` rule added |
| `check` after pass 2 | [44943368540](https://github.com/wimdotgg/groundwork/actions/runs/44943368540) | pass: 88 rows, 87 match, 1 deferred |

Pass 2 sent `PATCH code-scanning/default-setup` (202) and logged `code_scanning rule: added`, so before it default setup was off and the rule absent.

The `check` summary lists only mismatching rows, so it does not name the deferred rows. As supplementary evidence, the orchestrator ran a read-only local replay of `runCheck` at the same `main` (GET requests only, owner `gh` login for reads, because the agent token cannot read ruleset bypass actors). It named them:

- Before pass 2: `security code_scanning_default_setup.state`, `variables DEPLOY_ENABLED`, `rulesets main.rules.code_scanning`.
- After pass 2: `variables DEPLOY_ENABLED`. `config.json` keeps `"deploy": "none"`, so the variable stays unset.

Read-only state after pass 2: default setup `configured`; ruleset 27449099 (`main`) rule types `deletion`, `non_fast_forward`, `required_linear_history`, `pull_request`, `required_status_checks`, `merge_queue`, `code_scanning`; repository variables `GROUNDWORK_READY` only.
