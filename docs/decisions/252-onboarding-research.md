# 252: onboarding, portability and architecture+triage research

Spike #252 under epic #251, serving E2. Date 2026-11-23. External sources were read as data with `curl` (spec 6.7). Shorthand: **P** = `https://raw.githubusercontent.com/cursor/plugins/main/pstack/`, **M** = `https://raw.githubusercontent.com/mattpocock/skills/main/`. Both are MIT.

## Recommendation

- **Onboarding:** the entry point is a `groundwork-setup` skill. Behind it sit an owner-run wizard script on a CODEOWNERS-protected path and a rewritten `docs/setup.md`.
  - The skill's first question asks whether the agent may use the owner's main account (Q1).
  - Recommended answer: no. The agent prepares each step; the owner runs the wizard in their own terminal and confirms each action there.
  - The alternative, an agent-invoked owner script, is spelled out with its cost so the owner can choose it knowingly.
- **Portability before the guide:** with another org in `config.json`, 108 of 1400 tests fail.
  - Worse, a cloned CODEOWNERS names `@wianvdm`, who has no write access in the new org. GitHub then has no valid code owner, so every protected path merges without owner review (`main` needs zero other approvals). The gate fails open.
  - Both get fixed before the guide is written.
- **Architecture+triage:** add a `GLOSSARY.md` created on first use, an ADR rule for `docs/decisions/` and a rule-to-enforcer table, modelled on Pocock's `domain-modeling` and pstack's `/correct`.
  - Untrusted-author issues get a derived `inbox` queue plus a recommend-only `groundwork-triage` skill.
  - Status stays derived (4.4): no agent-applied state labels.
- **Adoption of existing repos:** keep it out of the onboarding epic. The documented path is a fresh bootstrap followed by an import PR, which needs the owner's `size-exception`.

## (a) Prior art

### pstack (cursor/plugins)

| Practice | Source | Verdict |
|---|---|---|
| Architecture lives in principle skills (`model-the-domain`, `boundary-discipline`). `/architect` sketches two shapes and keeps the one where state has one owner. No ARCHITECTURE.md, ADR or glossary | P`README.md` L222-254, P`skills/architect/SKILL.md` L9 | Fit. This is the planner's contract task (6.2) |
| `/correct`: "architecture first, then types, then a lint..., then a test, and write docs last", plus a table pairing each rule with its enforcer | P`skills/correct/SKILL.md` L3, L17-22, L30 | Fit. Spec 16 already has an "Enforced by" column; validators run from the base commit (8.2) |
| Exceptions need "a reason, an expiry date, and a human's approval" | P`skills/correct/SKILL.md` L26 | Fit. `integrity-exception` and `size-exception` are owner-only (5) |
| `/reflect` turns lessons into skill edits and waits for approval | P`skills/reflect/SKILL.md` L15-17 | Fit. Durable lessons go in an `AGENTS.md` PR (6.5) |
| "i don't believe in planning. the best spec is code" | P`README.md` L268-270 | Conflict. Spec 4 and 6.2 require epics, AC and the owner's `accepted` |
| Workers never ask a person; PRs open ready, never draft | P`skills/poteto-mode/worker.md` L7-8 | Conflict. The draft PR is the lease (6.4); `needs-decision` is how a worker asks (6.6) |
| "Rebase into small, ordered commits. Stack follow-ups." | P`skills/poteto-mode/playbooks/feature.md` L14, P`.../opening-a-pr.md` L5 | Conflict. D7 forbids stacking, D17 forbids rebasing |
| TDD opt-in: "Prefer no new test over a bad test" | P`skills/tdd/SKILL.md` L3, L26 | Conflict for bugs, which start with a failing test (4.6) |
| Benny triage files a ticket "only for a clear, new bug" and says "Do not reproduce or fix it here". It trusts markers only from the configured identity and sets no priority unless configured | P`automations/benny/skills/triage-issue-reports/SKILL.md` L9, L26, L142, L224 | Fit in spirit (6.7; `priority:*` is owner-only). The Slack and Cursor runtime is out |
| `setup-pstack`: ask for a budget (AskQuestion preferred), show the roles, confirm, validate, then write | P`skills/setup-pstack/SKILL.md` L30-48 | Fit for the setup entry point |

### Matt Pocock (`mattpocock/skills`)

| Practice | Source | Verdict |
|---|---|---|
| `GLOSSARY.md` at the root plus `docs/adr/NNNN-slug.md`, created lazily. Agents read them first and "proceed silently" when they are absent | M`skills/engineering/setup-matt-pocock-skills/domain.md` L5-11, M`skills/engineering/domain-modeling/SKILL.md` L40 | Fit. Spec 18 lists "ADRs beyond spike decision records" as later work. Reuse `docs/decisions/` rather than adding `docs/adr/` |
| ADR only when a decision is hard to reverse, surprising without context and a real trade-off; one to three sentences | M`skills/engineering/domain-modeling/SKILL.md` L68-74, M`.../ADR-FORMAT.md` L9-15 | Fit. Spike records stay longer because they carry the research |
| "If your output contradicts an existing ADR, surface it explicitly" | `domain.md` L49 | Fit. Raise it through `needs-decision` (6.6) |
| Triage roles: `bug`/`enhancement` plus one state from `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` | M`skills/engineering/triage/SKILL.md` L24-45 | Conflict. An agent-applied `ready-for-agent` would stand in for `accepted` (owner-only) and the derived Definition of Ready (4.4) |
| The maintainer invokes triage; the agent recommends and waits | M`skills/engineering/triage/SKILL.md` L49, L72 | Fit. Matches the owner touchpoints |
| External-PR triage filters on `author_association` | M`skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md` L21-28 | Partial fit. Groundwork reads `trustedAuthors` from config (6.7) |
| `to-spec` then `to-tickets`: the user approves the breakdown before publishing; vertical slices, native blocked-by edges | M`skills/engineering/to-tickets/SKILL.md` L27-56 | Fit. Planner, `plan-lint` and `accepted` |
| "avoid specific file paths... they go stale fast" | M`skills/engineering/to-tickets/SKILL.md` L105 | Conflict. `## Touches` paths drive hotspot holds (6.2) |
| `implement-spec`: one integration branch, one PR per spec | M`skills/engineering/implement-spec/SKILL.md` L11-42 | Conflict. One issue per PR (16), no stacking (D7) |
| TDD "Red before green", tests only at agreed seams | M`skills/engineering/tdd/SKILL.md` L22, L36 | Fit |
| Rejected scope goes to `.out-of-scope/` | M`skills/engineering/triage/OUT-OF-SCOPE.md` | Fit as a dated line in the epic's `## Decisions`; no new directory |
| Setup: "Explore, present..., confirm with the user, then write", one section at a time, recommended answer first | M`skills/engineering/setup-matt-pocock-skills/SKILL.md` L15, L34-36 | Fit. The model for the setup skill |
| `/wizard` generates a script for steps only a human can do (M`README.md` L241). Details below | M`skills/engineering/wizard/SKILL.md` L8-44 | Fit. The closest prior art to (b); the model for the owner wizard |
| Ships as a plugin or via `npx skills add` | M`.agents/install-block.md` L11-121 | Out. Groundwork is a template repository; skills live in `.claude/skills/` |

`/wizard` in detail:
- The script "opens each URL, says exactly what to click" (L8).
- It takes secrets with hidden entry and writes `gh secret set` (L10, L35-37).
- It asks for confirmation before irreversible steps (L37).
- The agent traces it statically and never runs it end to end (L43).

The script runs as the human, so the agent never holds the human's login. Groundwork needs the same split.

## (b) Owner-only setup steps

**The harness stops the owner login, but only for ambient use.** Inside an agent session the owner login is unreachable by accident: `GH_CONFIG_DIR` points at a directory with no `hosts.yml`, and every bare `gh` call is denied (spec 2.1 at `docs/spec.md:46`, 17 at `docs/spec.md:1247`). That stops ambient use, not a script that resets `GH_CONFIG_DIR` for its own child `gh`. `.claude/settings.json:9` allows `node scripts/human/*` without a prompt, so today an agent could start any script under that path.

**Prior art in this repo.** The spec 21 delegations are the one place where something acted under the owner login for the agent. An out-of-repo script with an action allowlist approved runs unattended (`docs/spec.md:1402-1404`, `docs/runs/2026-11-21-phase4c-project-runs.md:26,42`). Spec 21 calls it "a temporary bypass for the setup period. It is not part of groundwork" (`docs/spec.md:1390`). That is the precedent for Q1 option C, not for the recommended design.

Legend:
- **App:** the agent or admin App (tier 0 or 2).
- **Owner wizard:** the user runs it in their own terminal with their own `gh` login. Org endpoints need `gh auth refresh -s admin:org`.
- **Browser:** walkthrough only. The wizard opens the URL and names the field and value.

| Step (spec) | Route | Tool or page |
|---|---|---|
| Create the org (14.1.1) | Browser | `https://github.com/organizations/plan` |
| Require 2FA (2.5) | Browser | `/organizations/<org>/settings/security`. `two_factor_requirement_enabled` is response-only in REST ([update an organization](https://docs.github.com/en/rest/orgs/orgs#update-an-organization)) |
| Base permission Read; members cannot create repos (2.5) | Owner wizard | `PATCH /orgs/{org}` with `default_repository_permission` and `members_can_create_repositories` ([update an organization](https://docs.github.com/en/rest/orgs/orgs#update-an-organization)) |
| Fine-grained PAT approval policy (`docs/setup.md:14`) | Browser | No REST endpoint sets it; the PAT endpoints only list and review ([personal access tokens](https://docs.github.com/en/rest/orgs/personal-access-tokens)) |
| Actions: SHA pinning, fork approval, Actions may not approve PRs (2.5) | Owner wizard, or skip | `PUT /orgs/{org}/actions/permissions` (`sha_pinning_required`), `.../fork-pr-contributor-approval`, `.../workflow` (`can_approve_pull_request_reviews`) ([Actions permissions](https://docs.github.com/en/rest/actions/permissions)). `apply-settings` already sets all three per repo (`docs/spec.md:99`) |
| Team `agents` (2.5) | None | Holds no grant (`docs/spec.md:97`). Drop it from the cloner path |
| Issue types (2.5) | App, tier 2 | `request.mjs create-issue-types`; the owner approves `admin` |
| Copy the control repo into the org (14.1.2) | Owner wizard | Route weighed below |
| Create three Apps (14.1.3-4) | Browser | Manual form; the wizard opens `/organizations/<org>/settings/apps/new` and lists the permissions. A manifest flow ([docs](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), `POST /app-manifests/{code}/conversions` within one hour) would prefill the form; its `localhost` redirect is unverified (Q5) |
| Install the Apps with "All repositories" (14.1.3-4) | Browser | App settings, Install App. No REST call creates an installation |
| Store the agent key (14.1.3) | Owner wizard | Windows: DPAPI file. Elsewhere: a PEM at `GROUNDWORK_AGENT_KEY_FILE`, protected only by file permissions (`docs/setup.md:30`, `scripts/agent/token.mjs:66-71`). The PEM never enters the agent's context |
| `admin` environment: reviewer, `main` policy, no admin bypass (14.1.5) | Owner wizard | `PUT /repos/{o}/{r}/environments/admin` plus `deployment-branch-policies` (`docs/spec.md:726`) |
| `ADMIN_APP_KEY`, `RELEASE_APP_KEY`, client ID variables (14.1.5) | Owner wizard | Hidden entry, then `gh secret set --env admin` from stdin and `gh variable set --env admin` |
| Approve `admin` runs (14.1.6, 14.2) | Browser | Stays in person (`docs/spec.md:1390`) |
| Rulesets, labels, `release` environment | App, tier 2 | `apply-settings` and `bootstrap` (`docs/spec.md:807`) |
| Merge the first release PR (14.1.7) | Browser | Agents never merge release PRs (AGENTS.md) |
| Billing, org ownership, key rotation (tier 3, `docs/spec.md:781`) | Browser | Always |
| Drop the extra scope at the end | Owner wizard | `gh auth refresh --remove-scopes admin:org`. The owner login stays on the machine, and 2.1 only stops accidental use of it |

Entering secret values through the owner wizard changes tier 3 ("in the browser", `docs/spec.md:781`) and spec 17. The onboarding contract task rewords both. `admin` approvals stay in the browser.

**Copy route for the control repo.** Pick clone and push.

| Route | Effect | Verdict |
|---|---|---|
| Clone and push: `gh repo create <org>/groundwork --public --source . --push` | Own repository, full history. Tags are not pushed unless asked | Recommended |
| Fork | Stays in the upstream fork network; Actions start disabled on forks | Rejected |
| `--template` | One commit, no tags. Needs the template flag upstream, which spec 14.1.2 leaves unused (`docs/spec.md:1181`) | Rejected |

After the copy, the wizard resets `.release-please-manifest.json` and `version.txt`, and clears `CHANGELOG.md`, so the clone's first release is `v0.1.0`. That matches E5 and `docs/setup.md:106`. Moving a clone to a newer upstream groundwork has no path today: `kit-update` moves projects to their own control repo's release only. Q6.

**Consent.** The setup skill asks before anything else (Q1 holds the options):

> May I use your main GitHub account for setup? (A) No: I walk you through every step in the browser. (B) Partly: I prepare a wizard you run in your own terminal; it opens each page and asks y/N before each action, and I never hold your login. (C) Yes: I run an allowlisted script under your login for named steps until setup ends.

- **Scope:** named step classes from the table above. Billing, org ownership, deletions, key rotation and `admin` approvals are always excluded. Consent ends when setup ends.
- **Record:**
  - Before the control repo exists, the answer goes in `setup-state.json` beside the agent key (`%APPDATA%\groundwork\`, or a path from an environment variable elsewhere).
  - Once the repo exists, the agent posts it as a dated line in the setup epic's `## Decisions`: classes, limits, end condition.
  - The file is a record, not a control: the agent can write that directory.
- **Control (option B):**
  - The y/N in the user's terminal is the control.
  - The wizard refuses without a TTY, and when harness markers are set: a wrapper `GH_TOKEN`, or `GH_CONFIG_DIR` at `.claude/gh-agent`.
  - It lives on a CODEOWNERS path, so an agent PR cannot change it without owner review.
  - The `.claude/settings.json:9` allow rule is narrowed to `node scripts/human/inbox.mjs`.
- **Option C's cost:**
  - It ships the spec 21 bypass to every cloner as a feature.
  - It breaks the client-side separation of 2.1 and 17, and the owner-login-stays decision behind it (`docs/spec.md:1346-1352`).
  - It reopens tier 3.
  - Recommended against, but the owner can choose it.

## (c) Portability

Measured: with `wimdotgg` and `wianvdm` replaced in `.github/groundwork/config.json`, `node --test "scripts/**/*.test.mjs"` goes from 1400 passes to 108 failures, in seven files:

| File | Failures |
|---|---|
| `scripts/ci/pr-metadata.test.mjs` | 66 |
| `scripts/ci/protected-labels.test.mjs` | 16 |
| `scripts/agent/next.test.mjs` | 16 |
| `scripts/human/inbox.test.mjs` | 6 |
| `scripts/ci/pr-size.test.mjs` | 2 |
| `scripts/lib/settings.test.mjs` | 1 (L174) |
| `scripts/ci/test-integrity.test.mjs` | 1 |

Eleven files load the live config: those seven, plus `ci/check-results`, `ci/issue-format`, `ci/settings-plan` and `lib/config.test.mjs:82`. Fixtures in `scripts/ci/fixtures/*.json` hardcode the logins (`pr-metadata.json` 252 hits).

| Where | What | Needs |
|---|---|---|
| `.github/groundwork/config.json:3,6,7,10-12` | org, owner, agent bot, App slugs | Already the single source. The setup prompt writes it |
| `.github/CODEOWNERS:2-17` | `@wianvdm` on every line. Bootstrap fills only `__ORG__`, `__REPO__`, `__DESCRIPTION__` (`scripts/groundwork/bootstrap-tree.mjs:57-63`), so projects copy it as is. Under a cloner nobody valid owns protected paths, and `main` needs zero other approvals (`.github/groundwork/rulesets/main.json:14-15`): the gate fails open | Required, not optional: template the owner in bootstrap, make `check` fail when the CODEOWNERS owner differs from `accounts.owner`, and have the second-org dry run confirm GitHub's behaviour (to confirm) |
| The eleven test files above, `scripts/ci/fixtures/*.json` | logins tied to the live config | Tests read a fixture config. The clone stays green after the config edit |
| `AGENTS.md:13` | `wimdotgg-agent[bot]` | Generic wording: "the agent App bot (`accounts.agent`)" |
| `docs/setup.md:5,12-15,21,27,30,33,37,41,46,53,63,65,67,71,73,80-81,95,99,104,106` | org URLs, App IDs, client IDs, owner login | Rewrite with `<org>`, `<owner>` and `<app>` placeholders that the setup skill fills |
| `docs/spec.md:46-56,320,419,665,723-724,1181-1184` | this instance's IDs, logins, slugs | Doc note: spec values describe the `wimdotgg` instance; config wins |
| `LICENSE:3` | `Copyright 2026 wimdotgg` (MIT No Attribution) | Doc note. Bootstrap copies it to projects (`docs/spec.md:1196`) |
| `.release-please-manifest.json`, `version.txt`, `CHANGELOG.md` | groundwork's release history (0.10.1) | Wizard resets them after the copy (see (b)) |
| `docs/runs/*` | historical run notes | Keep |
| Already clean | Workflows use `github.repository` (`.github/workflows/release-please.yml:25`); rulesets use `{{app-id:release}}` and `OrganizationAdmin` (`.github/groundwork/rulesets/release-tag-creation.json:7`, `main.json:7`); environment reviewers say `"owner"` (`.github/groundwork/settings.json:62,71`); `token.mjs` reads the slug from config (`scripts/agent/token.mjs:180-182`) | None |

**Platform and harness support today:**

| Setup | Key storage | Hooks (checkpoint) | Client-side separation (deny rules, `GH_CONFIG_DIR`) |
|---|---|---|---|
| Windows, Claude Code | DPAPI | yes | yes |
| macOS or Linux, Claude Code | plaintext PEM at `GROUNDWORK_AGENT_KEY_FILE` | yes | yes |
| Codex or other harnesses | either | no | no: only `AGENTS.md` text and the fail-closed `GH_TOKEN` check in the scripts (13.1) |

A public template must say which rows it supports. Q7.

## (d) Adopting an existing repository

Bootstrap refuses `foreign`: an existing repository with no `kit-version.txt` that is not the admin App's `auto_init` state (`docs/spec.md:1192`). Adoption in place would need:

- Merging the kit into an existing tree (README, `.github/workflows`, CODEOWNERS).
- A default branch named `main`.
- Label sync from `labels.json`, which deletes the project's labels (spec 5).
- Rulesets replacing existing branch protection.
- Squash-only merges through a queue.
- Existing issues fail `issue-format` and stay invisible to `next` until rewritten.
- Existing tags and secrets reconciled with release-please and environments.

**Recommendation: out of scope** for the onboarding epic.
- The workable path today is to bootstrap a fresh repo, then have an agent claim a Chore and import the old code as one PR (`git merge --allow-unrelated-histories` on `issue/N`).
- That PR exceeds `pr-size` (400 lines, 20 files, `docs/spec.md:534`), so it needs the owner's `size-exception`.
- The squash merge flattens history; the old repo stays as the archive.
- In-place adoption would be a separate epic. Q4.

## Onboarding epic: recommended shape

- **Entry point:**
  - `.claude/skills/groundwork-setup/` runs the conversation: the consent question first, then one section at a time with the recommended answer first, confirm, then write.
  - An owner wizard (for example `scripts/owner/setup.mjs`, its path added to CODEOWNERS in the contract task) performs the owner-wizard steps and keeps `setup-state.json`, so a rerun resumes at the first unfinished step.
  - `docs/setup.md` is the guide; harnesses without skills follow it by hand.
- **Guide split:**
  - User-facing `docs/setup.md`: numbered steps, each with page URL, field, value and a "Verify" line.
  - Agent-facing: the skill's `SKILL.md` with the (b) table, commands, checks and resume rules.
  - Spec 14 stays the contract.
- **Draft success criteria:**
  - E1: with a different org, owner and App slugs in `config.json`, the full test suite passes; `check` fails when the CODEOWNERS owner differs from `accounts.owner`; bootstrap writes the configured owner into project CODEOWNERS; no other file outside `docs/runs/` names `wimdotgg` or `wianvdm` except where a doc note says why.
  - E2: one entry point asks the consent question before any other step, records the answer in `setup-state.json` and later in the setup epic's `## Decisions`, and resumes at the first unfinished step.
  - E3: every step of spec 2.5, 14.1 and tier 3 is classified as App, owner wizard or browser, and each browser step names page URL, field, value and a verify check.
  - E4: the owner wizard sits on a CODEOWNERS path. It refuses without a TTY or with harness markers set, asks y/N before every write, takes secrets with hidden entry and never passes them through the agent's context, and ends by dropping `admin:org`. The `scripts/human/*` allow rule is narrowed to `inbox.mjs`.
  - E5: a run from a fresh clone to `v0.1.0` in a second org follows only the guide. It confirms GitHub's CODEOWNERS behaviour for the cloned owner, and its run note lists every place a user had to improvise.
- **Rough tasks** (width 3 after the contract):
  1. Contract: `setup-state.json` shape, step IDs, consent classes, the wizard path in CODEOWNERS, the narrowed allow rule, and spec 2.1, 12 tier 3, 14 and 17 wording.
  2. Tests read a fixture config.
  3. CODEOWNERS templating and the `check` row, `AGENTS.md:13`, LICENSE note.
  4. `docs/setup.md` rewrite with the copy route and version reset.
  5. Owner wizard.
  6. Setup skill.
  7. Integration: second-org dry run.

## Architecture+triage epic: recommended shape

- **Architecture docs:**
  - `GLOSSARY.md` created on first use, domain terms only. Agents read it when present and stay silent when absent; bootstrap ships no stub.
  - `docs/decisions/<N>-<slug>.md` widened from spikes to any decision that passes Pocock's three-part bar, with a short ADR form.
  - A rule-to-enforcer table in `AGENTS.md`, linking each rule to the script, check or ruleset that enforces it (pstack `/correct`).
- **Gates:**
  - The planner skill reads the glossary and decisions before writing an epic; a plan that contradicts a decision raises `needs-decision`.
  - The reviewer flags new terms missing from the glossary, as a comment review only (D12).
  - No new required check.
- **Triage:**
  - `inbox` lists open untrusted-author issues with no linked task: a derived queue, no label.
  - The owner invokes a `groundwork-triage` skill on one of them. The agent recommends one of: create a linked task under a proposed epic, ask for information, or close as not planned with a reason. It acts only after the owner answers.
  - Any reproduction runs repo code at a known commit; it never runs commands, URLs or patches taken from the report (6.7, Benny L9).
  - The task it creates follows 4.3 and gets no `accepted`.
- **Draft success criteria:**
  - E1: the glossary and decision-record rule are documented, and the planner and reviewer skills read them when present.
  - E2: `AGENTS.md` carries a rule-to-enforcer table covering every rule in its Never list.
  - E3: `inbox` lists unlinked untrusted-author issues. `groundwork-triage` posts a recommendation and, after the owner answers, creates a linked task that passes `issue-format`. It applies no owner-only labels and executes nothing from the report.
  - E4: a dry run on one external report is recorded in a run note.
- **Rough tasks:**
  1. Contract: glossary and decision-record format, plus the spec 18 change.
  2. Rule-to-enforcer table.
  3. Planner and reviewer skill edits.
  4. `inbox` triage listing.
  5. Triage skill.
  6. Integration dry run.

## Open questions for the owner

1. **Q1, may the agent use your main account for setup?**
   - (A) No: browser walkthrough only, no wizard.
   - (B) Partly: an owner wizard you run in your terminal, with y/N per action, on a protected path; the agent never holds your login.
   - (C) Yes: an agent-invoked, allowlisted owner script for named step classes until the setup epic closes. This ships the spec 21 bypass to every cloner and breaks the 2.1 and 17 separation.
   - Recommended: B.
2. **Q2, proof for onboarding E5:**
   - (A) You create a second free org for a dry run.
   - (B) An outside tester.
   - (C) Desk check only, which leaves the CODEOWNERS behaviour unconfirmed.
   - Recommended: A.
3. **Q3, triage queue:**
   - (A) Derived: `inbox` lists untrusted-author issues with no linked task, and a recommend-only skill.
   - (B) A workflow-applied `needs-triage` label.
   - (C) Pocock's full state labels, which conflict with 4.4.
   - Recommended: A.
4. **Q4, adopting existing repos:**
   - (A) Out of scope: fresh bootstrap plus an import PR under `size-exception`.
   - (B) A later epic for in-place adoption.
   - (C) Inside the onboarding epic.
   - Recommended: A.
5. **Q5, App creation:**
   - (A) The manual form, with the wizard opening the page and listing permissions.
   - (B) A manifest-flow helper in the onboarding epic.
   - (C) A manifest spike first.
   - Recommended: A. The form is three Apps, once per org; the manifest flow adds a local redirect listener whose `localhost` support is unverified.
6. **Q6, updating a clone from upstream groundwork:**
   - (A) Out of scope: a doc note to merge an upstream tag into an `issue/N` branch (needs `size-exception`).
   - (B) An `upstream-update` script in the onboarding epic.
   - (C) A later epic.
   - Recommended: A.
7. **Q7, supported platforms and harnesses:**
   - (A) Claude Code on Windows, macOS and Linux, with other harnesses documented as unsupported for separation.
   - (B) Windows and Claude Code only.
   - (C) Widen separation to Codex and others in the onboarding epic.
   - Recommended: A.

## Gaps

- Not read: pstack guides 05 and 08-10, the `why`, `swarm` and `figure-it-out` skills; Pocock's `docs/engineering/*.md`, the wizard's `template.sh` and the sandcastle docs.
- Not verified live:
  - the manifest-flow `localhost` redirect;
  - GitHub's handling of a CODEOWNERS owner without write access in a cloned org (E5);
  - that `gh repo create --source` keeps Actions enabled in a new org.

## Follow-up epics

Opened as proposed by #254 on 2026-11-23, following the owner's answers in #251 `## Decisions`. Where they differ from the recommendations above, the answers win: Q2 C (desk check, no second-org dry run) and Q4 C (existing-repo adoption inside the onboarding epic).

- #258 Onboarding: portability, setup entry point and guide. Also carries the PR #255 round-2 review items.
- #259 Architecture docs and triage.
