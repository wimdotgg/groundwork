# 252: onboarding, portability and architecture+triage research

Spike #252 under epic #251, serving E2. Date 2026-11-23. External sources were read as data with `curl` (spec 6.7). Shorthand: **P** = `https://raw.githubusercontent.com/cursor/plugins/main/pstack/`, **M** = `https://raw.githubusercontent.com/mattpocock/skills/main/`. Both are MIT.

## Recommendation

- **Onboarding:** one `groundwork-setup` skill as the entry point, backed by an owner-run script (`scripts/human/setup.mjs`) and a rewritten `docs/setup.md`. The skill's first question asks whether owner-account steps may be scripted; the default answer is no, which means a browser walkthrough. Owner-account steps only ever run in a terminal the user opens outside the agent harness, so spec 2.1 and 17 stay as they are.
- **Portability before the guide:** after a config swap, 108 of 1400 tests fail. CODEOWNERS and `docs/setup.md` hardcode the owner. Fix these first, or a cloner's first PR goes red.
- **Architecture+triage:** add a lazy `GLOSSARY.md`, an ADR rule for `docs/decisions/`, and a rule-to-enforcer table, all modelled on Pocock's `domain-modeling` and pstack's `/correct`. Add a recommend-only `groundwork-triage` skill for untrusted reports. Groundwork's status stays derived (4.4): no agent-applied state labels.
- **Adoption of existing repos:** keep it out of the onboarding epic. The documented path is a fresh bootstrap followed by an import PR.

## (a) Prior art

### pstack (cursor/plugins)

| Practice | Source | Verdict |
|---|---|---|
| Architecture is held in principle skills (`model-the-domain`, `boundary-discipline`). `/architect` sketches two shapes and keeps the one where state has one owner. pstack has no ARCHITECTURE.md, ADRs or glossary | P`README.md` L222-254, P`skills/architect/SKILL.md` L9 | Fit. This is the planner's contract task (6.2) |
| `/correct`: "architecture first, then types, then a lint..., then a test, and write docs last", plus a table that pairs each rule with its enforcer | P`skills/correct/SKILL.md` L3, L17-22, L30 | Fit. Spec 16 already has an "Enforced by" column, and validators run from the base commit (8.2) |
| Exceptions need "a reason, an expiry date, and a human's approval" | P`skills/correct/SKILL.md` L26 | Fit. `integrity-exception` and `size-exception` are owner-only (5) |
| `/reflect` turns lessons into skill edits and waits for approval | P`skills/reflect/SKILL.md` L15-17 | Fit. Durable lessons land as an `AGENTS.md` PR (6.5) |
| "i don't believe in planning. the best spec is code" | P`README.md` L268-270 | Conflict. Spec 4 and 6.2 require epics, AC and an owner's `accepted` |
| Workers never ask a person, and PRs open ready, never draft | P`skills/poteto-mode/worker.md` L7-8 | Conflict. The draft PR is the lease (6.4), and `needs-decision` is the ask (6.6) |
| Stacks follow-ups by base branch and rebases | P`skills/poteto-mode/playbooks/opening-a-pr.md` L9, P`.../feature.md` L6 | Conflict. D7 forbids stacking, D17 forbids rebasing |
| TDD is opt-in: "Prefer no new test over a bad test" | P`skills/tdd/SKILL.md` L3, L26 | Conflict for bugs, which start with a failing test (4.6) |
| Benny triage: files a ticket "only for a clear, new bug", trusts markers only from the configured identity, and never sets priority unless configured | P`automations/benny/skills/triage-issue-reports/SKILL.md` L9, L26, L142, L224 | Fit in spirit (6.7, `priority:*` is owner-only). The Slack and Cursor runtime is out |
| Setup asks one question, shows the result, confirms, then writes | P`skills/setup-pstack/SKILL.md` L9-25 | Fit for the setup entry point |

### Matt Pocock (`mattpocock/skills`)

| Practice | Source | Verdict |
|---|---|---|
| `GLOSSARY.md` at the root plus `docs/adr/NNNN-slug.md`, created lazily. Agents read them first and "proceed silently" when they are absent | M`skills/engineering/setup-matt-pocock-skills/domain.md` L5-11, M`skills/engineering/domain-modeling/SKILL.md` L40 | Fit. Spec 18 lists "ADRs beyond spike decision records" as later work. Reuse `docs/decisions/` rather than adding `docs/adr/` |
| An ADR only when the decision is hard to reverse, surprising without context and the result of a real trade-off; one to three sentences | M`skills/engineering/domain-modeling/SKILL.md` L68-74, M`.../ADR-FORMAT.md` L9-15 | Fit. Spike records stay longer, because they also hold the research |
| "If your output contradicts an existing ADR, surface it explicitly" | `domain.md` L49 | Fit. Escalate through `needs-decision` (6.6) |
| Triage roles: `bug`/`enhancement` plus one state from `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` | M`skills/engineering/triage/SKILL.md` L24-45 | Conflict. An agent-applied `ready-for-agent` would stand in for `accepted` (owner-only) and for the derived Definition of Ready (4.4) |
| The maintainer invokes triage; the agent recommends and waits | M`skills/engineering/triage/SKILL.md` L49, L72 | Fit. This matches the owner touchpoints |
| External-PR triage filters on `author_association` | M`skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md` L21-28 | Partial fit. Groundwork reads `trustedAuthors` from config (6.7), never `author_association` |
| `to-spec` then `to-tickets`: the user approves the breakdown before anything is published; slices are vertical, with native blocked-by edges | M`skills/engineering/to-tickets/SKILL.md` L27-56 | Fit. This is the planner, `plan-lint` and the `accepted` flow |
| "avoid specific file paths... they go stale fast" | M`skills/engineering/to-tickets/SKILL.md` L105 | Conflict. `## Touches` paths drive hotspot holds (6.2) |
| `implement-spec`: one integration branch and one PR per spec | M`skills/engineering/implement-spec/SKILL.md` L11-42 | Conflict. One issue per PR (16) and no stacking (D7) |
| TDD "Red before green", tested only at agreed seams | M`skills/engineering/tdd/SKILL.md` L22, L36 | Fit |
| Rejected scope goes to `.out-of-scope/` | M`skills/engineering/triage/OUT-OF-SCOPE.md` | Fit as a dated line in the epic's `## Decisions`, no new directory |
| Setup is "Explore, present..., confirm with the user, then write", one section at a time with the recommended answer first. `/wizard` scripts the human-only steps | M`skills/engineering/setup-matt-pocock-skills/SKILL.md` L15, L34-36, M`README.md` L34 | Fit. This is the model for the setup skill |
| Ships as a plugin or via `npx skills add` | M`.agents/install-block.md` L11-121 | Out. Groundwork is a template repository, and its skills live in `.claude/skills/` |

## (b) Owner-only setup steps

Inside an agent session the owner login cannot be used, by design. `GH_CONFIG_DIR` points at a directory with no `hosts.yml`, and every bare `gh` call is denied (`.claude/settings.json`, spec 2.1 at `docs/spec.md:46`, spec 17 at `docs/spec.md:1247`). So "as the user" can only mean a script the user runs in their own terminal; the agent prepares the command and reads back its output. Delegations under spec 21 already work this way (`docs/spec.md:1402`).

Legend: **App** = the agent or admin App (tier 0 or 2). **Owner script** = the user runs it with their own `gh` login, which needs `gh auth refresh -s admin:org` for org endpoints. **Browser** = walkthrough only.

| Step (spec) | Route | Tool or page |
|---|---|---|
| Create the org (14.1.1) | Browser | `https://github.com/organizations/plan` |
| Require 2FA (2.5) | Browser | `/organizations/<org>/settings/security`. `two_factor_requirement_enabled` is read-only in REST ([orgs](https://docs.github.com/en/rest/orgs/orgs#update-an-organization) body has no such field) |
| Base permission Read, members cannot create repos (2.5) | Owner script | `PATCH /orgs/{org}` with `default_repository_permission` and `members_can_create_repositories` ([update an organization](https://docs.github.com/en/rest/orgs/orgs#update-an-organization)) |
| Fine-grained PAT approval policy (`docs/setup.md:14`) | Browser | No REST endpoint sets the policy; the PAT endpoints only list and review requests ([personal access tokens](https://docs.github.com/en/rest/orgs/personal-access-tokens)) |
| Actions: SHA pinning, fork approval, Actions may not approve PRs (2.5) | Owner script, or skip | `PUT /orgs/{org}/actions/permissions` (`sha_pinning_required`), `.../fork-pr-contributor-approval`, `.../workflow` (`can_approve_pull_request_reviews`) ([Actions permissions](https://docs.github.com/en/rest/actions/permissions)). `apply-settings` already sets all three per repo (`docs/spec.md:99`) |
| Team `agents` (2.5) | None | Spec says it holds no grant (`docs/spec.md:97`). Drop it from the cloner path |
| Issue types (2.5) | App, tier 2 | `request.mjs create-issue-types`; the owner approves `admin` |
| Copy the control repo into the org (14.1.2) | Owner script | `gh repo create <org>/groundwork --public --source . --push` from a clone; the template flag is unused (`docs/spec.md:1181`) |
| Create three Apps (14.1.3-4) | Browser, optionally with the manifest flow | Manifest flow: the user clicks "Create GitHub App" on a form the agent generates. The owner script then exchanges the code with `POST /app-manifests/{code}/conversions` within one hour, which returns the ID, client ID and PEM ([manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)). Unverified: whether a `localhost` `redirect_url` is accepted |
| Install the Apps with "All repositories" (14.1.3-4) | Browser | App settings, Install App. No REST call creates an installation |
| Store the agent key (14.1.3) | Owner script | Local DPAPI encryption only (`docs/setup.md:30`); the PEM never enters the agent's context |
| `admin` environment: reviewer, `main` policy, no admin bypass (14.1.5) | Owner script | `PUT /repos/{o}/{r}/environments/admin` plus `deployment-branch-policies` (spec 10.1, `docs/spec.md:726`) |
| `ADMIN_APP_KEY`, `RELEASE_APP_KEY`, client ID variables (14.1.5) | Owner script | `gh secret set --env admin` from stdin and `gh variable set --env admin`. Values never pass through the agent |
| Approve `admin` runs (14.1.6, 14.2) | Browser (default) or owner script | `POST /repos/{o}/{r}/actions/runs/{id}/pending_deployments`, the action delegated under spec 21 |
| Rulesets, labels, `release` environment | App, tier 2 | `apply-settings` and `bootstrap` (`docs/spec.md:807`) |
| Merge the first release PR (14.1.7) | Browser or owner script | `gh pr merge`. Agents never merge release PRs (AGENTS.md) |
| Billing, org ownership, key rotation (tier 3, `docs/spec.md:781`) | Browser | Always |

**Consent.** The setup skill asks one question before anything else:

> May I prepare commands for you to run with your own GitHub account? Choose (A) no: I walk you through every owner step in the browser; (B) yes, for the steps marked "Owner script": each one prints its plan and asks y/N in your terminal; (C) choose step by step.

- **Scope:** the consent covers named step classes from the table above, never the whole account. Billing, org ownership, deletions and key rotation are never in scope. It ends when setup ends.
- **Record:** before the control repo exists, the answer goes in `setup-state.json`, beside the agent key in `%APPDATA%\groundwork\` (outside any repo; elsewhere, a path from an environment variable). Once the repo exists, the agent posts the same answer as a dated line in the setup epic's `## Decisions`, in the format of the spec 21 delegation entries: action classes, limits and the end condition "ends when this epic closes".
- **Enforcement:** the owner script refuses any step class missing from `setup-state.json`. The deny rules already keep the agent from running it with the owner login.

## (c) Portability

Measured: with `wimdotgg` and `wianvdm` replaced in `.github/groundwork/config.json`, `node --test "scripts/**/*.test.mjs"` goes from 1400 passes to 108 failures. Ten test files load the repo's own config: `scripts/agent/next.test.mjs`, `scripts/agent/checkpoint.test.mjs` and eight `scripts/ci/*.test.mjs`. Their fixtures in `scripts/ci/fixtures/*.json` hardcode the logins (`pr-metadata.json` 252 hits, `failure-alert.json` 61, `pr-size.json` 47).

| Where | What | Needs |
|---|---|---|
| `.github/groundwork/config.json:3,6,7,10-12` | org, owner, agent bot and App slugs | Already the single source. The setup prompt writes these values |
| `.github/CODEOWNERS:2-17` | `@wianvdm` on every line | Setup prompt rewrites it. Optionally a check that the CODEOWNERS owner equals `accounts.owner`. Bootstrap fills only `__ORG__`, `__REPO__` and `__DESCRIPTION__` (`scripts/groundwork/bootstrap-tree.mjs:57-63`), so projects inherit the control repo's file |
| `scripts/ci/fixtures/*.json`, the ten tests above | logins tied to the live config | Tests read a fixture config, not the repo's own. Contract task: the clone stays green after the config edit |
| `AGENTS.md:13` | `wimdotgg-agent[bot]` | Generic wording: "the agent App bot (`accounts.agent`)" |
| `docs/setup.md:5,12-15,21,27,30,33,37,41,46,53,63,65,67,71,73,78-79,95,99,104,106` | org URLs, App IDs, client ID values, owner login | Rewrite with `<org>`, `<owner>` and `<app>` placeholders that the setup skill fills |
| `docs/spec.md:46-56,320,419,665,723-724,1181-1184` | this instance's App IDs, logins and slugs | Doc note: spec values describe the `wimdotgg` instance, and config wins |
| `LICENSE:3` | `Copyright 2026 wimdotgg` (MIT No Attribution) | Doc note. Bootstrap copies it unchanged to projects (`docs/spec.md:1196`) |
| `.release-please-manifest.json`, `version.txt`, `CHANGELOG.md` | groundwork's own release history (0.10.1) | Setup step or doc note: a clone's first release continues from 0.10.1 unless reset |
| `docs/runs/*` | historical run notes | Keep. History |
| Already clean | Workflows use `github.repository` (`.github/workflows/release-please.yml:25`); rulesets use `{{app-id:release}}` and `OrganizationAdmin` (`.github/groundwork/rulesets/release-tag-creation.json:7`, `main.json:7`); environment reviewers say `"owner"` (`.github/groundwork/settings.json:62,71`); `token.mjs` reads the slug from config (`scripts/agent/token.mjs:180-182`) | None |

## (d) Adopting an existing repository

Bootstrap refuses `foreign`: any existing repository without `kit-version.txt` that is not the admin App's `auto_init` state (`docs/spec.md:1192`). Adoption would need all of the following:

- Merge the kit into an existing tree (README, `.github/workflows`, CODEOWNERS).
- Default branch `main`.
- Accept that labels are synced from `labels.json`, which deletes the project's existing labels (spec 5).
- Accept that rulesets replace existing branch protection.
- Squash-only merges through a merge queue.
- Existing issues fail `issue-format` and stay invisible to `next` until rewritten.
- Existing tags and secrets must be reconciled with release-please and environments.

**Recommendation: out of scope** for the onboarding epic. The safe path already exists: bootstrap a fresh repo, then an agent claims a Chore and imports the old code as one PR (`git merge --allow-unrelated-histories` on `issue/N`). The squash merge flattens history, and the old repo stays as the archive. Adoption in place is a separate epic, if it is ever wanted. Owner question Q4.

## Onboarding epic: recommended shape

- **Entry point:** a mix of three parts.
  - `.claude/skills/groundwork-setup/` runs the conversation: the consent question first, then one section at a time, recommended answer first, confirm, then write (the Pocock and pstack pattern above).
  - `scripts/human/setup.mjs` performs the owner-script steps and keeps `setup-state.json`, so a rerun resumes at the first unfinished step.
  - `docs/setup.md` is the guide. Codex and other harnesses follow the guide by hand.
- **Guide split:**
  - User-facing `docs/setup.md`: numbered steps, each with the exact page URL, field and value, plus a "Verify" line.
  - Agent-facing: the skill's `SKILL.md`, holding the step table from (b), commands, checks and resume rules.
  - Spec 14 stays the contract.
- **Draft success criteria:**
  - E1: with a different org, owner and App slugs in `config.json`, the full test suite passes, and no file outside `config.json`, CODEOWNERS and `docs/runs/` names `wimdotgg` or `wianvdm`, except where a listed doc note says why.
  - E2: one documented entry point (the setup skill, or the guide when the harness has no skills) asks the consent question before any other step. It records the answer in `setup-state.json` and later in the setup epic's `## Decisions`, and resumes at the first unfinished step.
  - E3: every step of spec 2.5, 14.1 and tier 3 is classified as App, owner script or browser. Each browser step names the page URL, field, value and a verify check.
  - E4: owner-script steps print a plan and ask y/N, refuse step classes outside the recorded consent, and never pass a secret value through the agent's context.
  - E5: a run from a fresh clone to `v0.1.0` in a second org follows only the guide, and its run note lists every place a user had to improvise.
- **Rough tasks** (width 3 after the contract):
  1. Contract: `setup-state.json` shape, step IDs, consent classes and spec 14 wording.
  2. Tests read a fixture config.
  3. CODEOWNERS, `AGENTS.md:13`, LICENSE and release-history notes.
  4. `docs/setup.md` rewrite.
  5. `scripts/human/setup.mjs`.
  6. Setup skill.
  7. Manifest-flow spike, optional.
  8. Integration: second-org dry run.

## Architecture+triage epic: recommended shape

- **Architecture docs:**
  - A lazy root `GLOSSARY.md` with domain terms only, no implementation.
  - `docs/decisions/<N>-<slug>.md` widened from spikes to any decision that passes Pocock's three-part bar, with a short ADR form.
  - A rule-to-enforcer table in `AGENTS.md`, linking each rule to the script, check or ruleset that enforces it, so lessons land as structure first (pstack `/correct`).
  - Bootstrap ships empty project stubs for `GLOSSARY.md` and `docs/decisions/`.
- **Gates:**
  - The planner skill reads the glossary and decisions before writing an epic. A plan that contradicts a decision raises `needs-decision`.
  - The reviewer flags new terms missing from the glossary, as a comment review only (D12).
  - No new required check.
- **Triage:** a `groundwork-triage` skill that the owner invokes on untrusted-author issues.
  - The agent reproduces the report and recommends one of: create a linked task under a proposed epic, ask for information, or close as not planned with a reason.
  - It acts only after the owner answers. The task it creates follows 4.3 and gets no `accepted`.
  - No state labels: status stays derived (4.4). The only new label would be an optional workflow-applied `needs-triage` on untrusted-author issues (owner question Q3).
- **Draft success criteria:**
  - E1: `GLOSSARY.md` and the decision-record rule exist in the control repo and in bootstrap stubs, and the planner and reviewer skills read them.
  - E2: `AGENTS.md` carries a rule-to-enforcer table covering every rule in its Never list.
  - E3: `groundwork-triage` produces a recommendation comment on an untrusted-author issue and, after the owner answers, a linked task that passes `issue-format`, without applying owner-only labels.
  - E4: a dry run on one external report is recorded in a run note.
- **Rough tasks:**
  1. Contract: glossary and decision-record format, plus the spec 18 change.
  2. Rule-to-enforcer table.
  3. Planner and reviewer skill edits.
  4. Triage skill.
  5. Bootstrap stubs.
  6. Optional `needs-triage` workflow.
  7. Integration dry run.

## Open questions for the owner

1. **Q1, default consent answer:** (A) browser walkthrough by default, owner script opt-in (recommended); (B) owner script by default; (C) browser only, with no owner script built.
2. **Q2, proof for onboarding E5:** (A) the owner creates a second free org for a dry run (recommended); (B) an outside tester; (C) desk check only.
3. **Q3, triage label:** (A) no new label, recommend-only skill (recommended); (B) workflow-applied `needs-triage` on untrusted-author issues; (C) Pocock's full state set (conflicts with 4.4).
4. **Q4, adoption of existing repos:** (A) out of scope, fresh bootstrap plus import PR (recommended); (B) a later epic; (C) in the onboarding epic.
5. **Q5, App creation:** (A) manual form, as now; (B) a manifest-flow helper in the onboarding epic (saves typing permissions, adds a local redirect listener); (C) a spike first.

## Gaps

- Not read: pstack guides 05 and 08-10, the `why`, `swarm` and `figure-it-out` skills; Pocock's `docs/engineering/*.md` and the sandcastle docs.
- Not verified live: manifest-flow `localhost` redirect; that `gh repo create --source` keeps Actions enabled in the new org.
