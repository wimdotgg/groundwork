# groundwork: specification v1

Status: v1 done (Phase 5 ran every section 20 criterion on `gw-acceptance`; `docs/runs/2026-11-22-phase5-acceptance.md`); Phase 0 probes done (section 19); Phase 2 done (`v0.1.0`); agents act as the `wimdotgg-agent` App (`v0.2.0`); Phase 3a done (`v0.3.0`); Phase 3b done (`v0.4.0`); Phase 4 done (`v0.5.0`); Phase 4b done (`v0.6.0`: `groundwork` passed pass 2, section 21); Phase 4c added (deploy, `kit-update`, `selftest` and `script`; the live runs are in section 21 and `docs/runs/`). Date: 2026-11-22. Owner: `wianvdm`. Organization: `wimdotgg`.

Instance values: every org name, owner login, App slug, bot login, App ID, client ID, user ID and run link in this spec (`wimdotgg`, `wianvdm`, `wimdotgg-agent`, `wimdotgg-admin`, `wimdotgg-release` and the URLs under `github.com/wimdotgg/`) describes the `wimdotgg` instance that built groundwork. In a clone, `.github/groundwork/config.json` wins: read them as `<org>`, `accounts.owner` and the `apps.*` slugs of that file. Sections 19 to 21 are history and keep the instance names.

`groundwork` is three things in one public repository:

1. **Template.** New projects are created from its latest release by `bootstrap` and start with every workflow, rule and agent convention in place.
2. **Rules source.** It hosts the reusable CI workflows and the agent scripts that projects pin to a release tag's commit.
3. **Control repo.** Every admin operation (bootstrap, settings changes, one-off admin scripts) runs here, behind your approval.

Its purpose: a solo human orchestrates, AI agents do the work (plan, implement, review, merge), and strict, mostly deterministic gates keep the output from becoming slop.

---

## 1. Decisions record

| # | Decision | Rationale |
|---|---|---|
| D1 | Public repositories only | Rulesets, environment reviewers, CodeQL, secret scanning and dependency review are free only on public repos. `winzelle-projects` went public for the same reason (PR #22). |
| D2 | Owned by a free GitHub organization | Merge queue is only available for public repos owned by an organization. Needed for parallel agents. No personal-account fallback. |
| D3 | One repo for template, rules and control plane | A separate rules repo is deferred until 2-3 projects need updates. |
| D4 | Native issue types, sub-issues and dependencies | Available on GitHub; `gh` 2.102 supports `--type`, `--parent`, `--blocked-by`. |
| D5 | You accept once per epic | The planner posts the epic with its plan and sub-issues first; applying `accepted` then authorizes that decomposition. |
| D6 | Status is derived, never stored in labels | Label writes by `GITHUB_TOKEN` do not trigger workflows; a label state machine fails silently. |
| D7 | No stacked PRs | Merge queue only serves `main`; contract-first planning plus `blocked-by` replaces stacks. |
| D8 | Context lives in issue (intent), PR `## State` (current state), PR comments (journal) | No committed plan or state files. |
| D9 | Agents act through an org-owned GitHub App (`wimdotgg-agent`) | Agent scripts run on the App token: they refuse to call GitHub unless `GH_TOKEN` is set, which `token.mjs exec` does (2.1, 17). An App cannot be spam-flagged like a machine user was. |
| D10 | Admin work runs through approval-gated tiers | Agents request, you approve with one click, GitHub runs it with a short-lived scoped token. |
| D11 | Agents may edit workflows; all secrets live in protected environments | CODEOWNERS gates the merge; PR runs cannot reach environment secrets. |
| D12 | Reviewer agent is advisory | Deterministic checks and your CODEOWNERS approval are the blockers. |
| D13 | Versions stay `0.x.x` by default | `feat` and breaking bump minor, `fix` bumps patch; `1.0.0` only by your explicit config change. |
| D14 | Scripts are Node (ESM, no dependencies) | Cross-platform; you work on Windows. |
| D15 | Agent runtime (how workers are launched, which models) is out of scope for v1 | The template defines the protocol; a recommended setup is documented. |
| D16 | Agents act only on content written by you or the agent App | Public repos let anyone open issues and comment; that text is untrusted data. |
| D17 | Workers never force-push; `issue/*` branches only move forward and are updated from `main` by merge | Takeover is a plain push that fails as non-fast-forward for the race loser; the `issue-branches` ruleset enforces it server-side (9.5, V16). |
| D18 | A project may declare `"deploy": "none"` in `config.json` | Not every project ships a deployable; pass 2 then skips `DEPLOY_ENABLED` and deploy secrets. |

---

## 2. Identities and permissions

### 2.1 Accounts

| Identity | Kind | Role | Credentials on the agent machine |
|---|---|---|---|
| `wianvdm` | Your user | Org owner | Your `gh` keyring login and Git Credential Manager login may stay on the machine. GitHub does not keep them from agents, so the client does: with the org's third-party access restriction on and no approved apps, your GitHub CLI OAuth token still wrote to `groundwork` (probes #214 and #215, `docs/runs/2026-11-22-phase5-contract.md`). Agent scripts refuse to call GitHub unless `GH_TOKEN` is set, which `token.mjs exec` does (13.1, `lib/github.mjs`); `.claude/settings.json` sets `GH_CONFIG_DIR` to a directory with no `hosts.yml` and `GCM_INTERACTIVE=never` and denies every bare `gh` and `gh.exe` call, and under `token.mjs exec` the forms that read or change credentials, run extension code or persist config: every `gh auth` subcommand, `gh config set`, `gh alias set`, `gh alias import`, `gh extension`, `gh ext`, `gh extensions`, `gh copilot`, `gh aw`, `gh stack` and `gh webhook` (17). That stops accidental ambient use, not a deliberate bypass. You act in the browser or GitHub mobile app, and during org setup also through the owner wizard (14.3), which you start in your own terminal under this login; it holds `admin:org` only for its run and never runs inside an agent session. Bootstrap and admin work go through tier 2 (section 12). |
| `wimdotgg-agent` | GitHub App (App ID 5853598, client ID `Iv23lic380KcYz17cWxi`) | Installed on all org repos, permissions in 2.2 | Key encrypted on the agent machine (2.2); installation tokens minted per command. |
| `wimdotgg-release` | GitHub App | Installed on all org repos | None. Key only in each repo's `release` environment. |
| `wimdotgg-admin` | GitHub App (App ID 5782869, client ID `Iv23lipUuaiDCWGAKcYI`) | Installed on all org repos | None. Key only in the control repo's `admin` environment. |

App slugs live only in `.github/groundwork/config.json` (`apps.admin`, `apps.agent`, `apps.release`); scripts and rulesets never hardcode them. Bot logins are `<slug>[bot]`. All three Apps are owned by the organization (created at `https://github.com/organizations/<org>/settings/apps/new`, "Only on this account" = the org) and installed on the org with "All repositories" so new project repos are covered without a manual step. `GET /apps/{slug}` for a private org App returns 404 to the agent App.
GitHub reports the owner login as `WianVDM`. Logins are compared case-insensitively everywhere; `config.json` stores them lower-case.

### 2.2 Agent App

`wimdotgg-agent` (App ID 5853598, client ID `Iv23lic380KcYz17cWxi`, bot `wimdotgg-agent[bot]`, user id 359293167) is org-owned and installed on the org with "All repositories". Repository permissions: Contents RW, Pull requests RW, Issues RW, Workflows RW, Actions RW, Commit statuses R, Metadata R. No Checks permission (check runs on public repos are readable without it, V5), no Administration, Secrets, Variables or Environments, no organization permissions.

Key storage: the private key stays on the agent machine, never in a repo or environment. On Windows it is encrypted with DPAPI for the current user at `%APPDATA%\groundwork\wimdotgg-agent.pem.dpapi`, with `appId`, `slug` and `clientId` in `wimdotgg-agent.json` beside it. Elsewhere `GROUNDWORK_AGENT_KEY_FILE` (PEM path) and `GROUNDWORK_AGENT_CLIENT_ID` supply them.

`scripts/agent/token.mjs` is the only way agents write. `exec -- <command>` mints an installation token (App JWT, `GET /orgs/{org}/installation`, `POST /app/installations/{id}/access_tokens`) and runs the command with `GH_TOKEN`, the bot's commit name and noreply email, and a git credential helper that calls `token.mjs credential`. Tokens last one hour and are never stored.

Why not a machine user: GitHub flagged `wianvdm-agent` as spam and hid its content from everyone else. An org-owned App cannot be flagged that way, needs no seat or PAT rotation, and its writes are attributed to `[bot]`.

### 2.3 `wimdotgg-release` App

Repository permissions: Contents RW, Pull requests RW, Issues RW, Metadata R. It is the only actor allowed to create `v*` tags (ruleset bypass). release-please uses it so that release PRs trigger CI (PRs opened by `GITHUB_TOKEN` do not). The ruleset bypass entry needs the numeric App ID (not the client ID or installation ID); bootstrap resolves it with `GET /apps/{slug}`.
The `RELEASE_APP_CLIENT_ID` variable may hold either the App ID or the client ID: `actions/create-github-app-token` signs the App JWT with it as issuer, and GitHub accepts both. The live variable holds the App ID (5796650).
`release-please.yml` mints its token with `actions/create-github-app-token` v3.3.0 (commit `64ab729a6294000f5aa4a4bc0b73d1f32bc45510`; `app-id` is deprecated there): inputs `client-id`, `private-key`, `permission-contents: write`, `permission-pull-requests: write`, `permission-issues: write`. With `owner` and `repositories` unset the token covers only the current repository.

### 2.4 `wimdotgg-admin` App

Repository permissions: Administration RW, Contents RW, Environments RW, Secrets RW, Variables RW, Issues RW, Pull requests RW, Workflows RW, Actions RW, Metadata R.
Organization permissions: Issue types RW, Members R.
No organization permissions beyond the two above. Team access (`PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}`) needs repository Administration write and Members read.
Permissions the Phase 4 calls need, per the endpoint pages and the [permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps). "Has" is against the App as listed above:

| Call | Needs | Has | Docs |
|---|---|---|---|
| `POST /orgs/{org}/repos` (`auto_init: true`) | at least one of repository Administration write or repository "Repository creation" write (`repository_creation`); both are repository permissions, not organization ones | yes (Administration) | [create an organization repository](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository) |
| `GET /repos/{org}/{repo}`, `git/matching-refs/tags/v`, `git/trees/{tag}`, `git/blobs/{sha}`, `commits` on public repositories | no permission; the token is the control-repo read grant `{ contents: 'read' }` (12.1) | yes | [list matching references](https://docs.github.com/en/rest/git/refs#list-matching-references) |
| `POST /repos/{o}/{r}/git/trees`, `git/commits`; `PATCH git/refs/heads/main` | Contents write; Workflows write when the update changes workflow files | yes | [create a tree](https://docs.github.com/en/rest/git/trees#create-a-tree), [create a commit](https://docs.github.com/en/rest/git/commits#create-a-commit), [update a reference](https://docs.github.com/en/rest/git/refs#update-a-reference) |
| `POST /repos/{o}/{r}/labels` | Issues write (the reference also lists Pull requests; `apply-settings` already syncs labels with Issues alone) | yes | [create a label](https://docs.github.com/en/rest/issues/labels#create-a-label) |
| `POST /repos/{o}/{r}/issues` (with `type`), `issues/{n}/sub_issues`, `issues/{n}/dependencies/blocked_by` | Issues write | yes | [create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue), [add sub-issue](https://docs.github.com/en/rest/issues/sub-issues#add-sub-issue), [add a dependency](https://docs.github.com/en/rest/issues/issue-dependencies#add-a-dependency-an-issue-is-blocked-by) |
| `PATCH` and `GET /repos/{o}/{r}/code-scanning/default-setup` | Administration write (read for `GET`); no Code scanning alerts | yes | [update default setup](https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration) |
| `GET /repos/{o}/{r}/actions/runs` | Actions read | yes | [list workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository) |
| `POST` and `PUT /repos/{o}/{r}/rulesets` | Administration write | yes | [update a ruleset](https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset) |

No permission the App lacks was needed. Verified live (V7): `POST /orgs/{org}/repos` accepts a token restricted to `groundwork` with Administration write, and `PATCH code-scanning/default-setup` needs Administration write and no Code scanning alerts permission (run [44900056245](https://github.com/wimdotgg/groundwork/actions/runs/44900056245) configured it).
Every run mints an installation token restricted to the target repository and the permissions that operation needs (table in 12.1). Exceptions, only for `bootstrap`: the control-repo read grant and the create call below. Tokens last at most one hour.
The create call (the target repo does not exist yet, so the token cannot name it): bootstrap mints, through `ctx.withToken` (12.1), a token restricted to `groundwork` with Administration write. V7 verified that variant, so `createRepo` has no installation-wide retry and no `"all"` grant is declared.
`admin-run` mints through `scripts/groundwork/app-token.mjs` (RS256 JWT with `node:crypto`, then `POST /app/installations/{id}/access_tokens` with `repositories` and `permissions`), not through `actions/create-github-app-token`: the action has no `permission-*` input for Variables or Issue types, and the permission set varies per op.

### 2.5 Org settings (one-time, by you)

- Two-factor authentication required.
- Base repository permission: Read. Members cannot create repositories (bootstrap creates them).
- Team `agents` is empty and holds no repository grant: the agent is an App and needs none. `settings.json` `teamAccess` is `[]`, so `apply-settings` and `check` touch no team. Deleting the team is yours, in the browser.
- Issue types are not set by hand: `admin-run op=create-issue-types` creates Epic, Feature, Bug, Chore, Spike and deletes the default Task.
- Actions: require actions pinned to a full-length commit SHA (the policy does not cover reusable workflows); "Require approval for all external contributors" for fork PR workflows; "Allow GitHub Actions to create and approve pull requests" off. `apply-settings` also sets all three per repository (10, V12).

---

## 3. Repository layout

Paths marked `[control]` exist only in `groundwork` and are removed by bootstrap from new projects. Paths marked `[project]` are filled in per project.

```
.github/
  CODEOWNERS
  ISSUE_TEMPLATE/
    config.yml                    blank issues disabled
    epic.yml  feature.yml  bug.yml  chore.yml  spike.yml
  pull_request_template.md
  dependabot.yml
  groundwork/
    config.json                   org, accounts, App slugs, trust, label actors, limits, deploy mode, globs, suppression patterns
    settings.json                 repo settings, team access, environments, security, Actions settings, variables
    labels.json
    rulesets/
      main.json
      release-tag-creation.json
      release-tag-immutability.json
      issue-branches.json
    hotspots.json                 [project] serialized resources
    templates/                    markdown twins of the issue forms and comment formats
      epic.md feature.md bug.md chore.md spike.md
      plan-comment.md claim-comment.md checkpoint-comment.md
      handover-comment.md acceptance-comment.md state-section.md
    kit-version.txt               [project] groundwork tag this project is on; written by bootstrap and kit-update
  workflows/
    ci.yml                        caller: verify, security, test-integrity, scripts, settings-plan; aggregate `Check`
    pr-metadata.yml               `PR metadata` and `pr-size` (local jobs, not reusable)
    issue-format.yml
    protected-labels.yml
    plan-lint.yml
    release-please.yml
    deploy.yml                    [project] deploy, smoke, rollback; `kit-update` copies it only into a project that has none
    failure-alert.yml
    reusable-verify.yml           [control] reusable workflows (called by projects at a tag)
    reusable-security.yml         [control]
    admin-run.yml                 [control]
admin-ops/                        [control] reviewed one-off admin scripts for the `script` op (12.1); flat, `<name>.mjs` only, no tests here (they live in `scripts/groundwork/`, 13.1)
scripts/
  verify                          [project] contract entry point (sh + .cmd shim); groundwork's own is real, bootstrap swaps in the stub
  deploy  smoke  rollback         [project] written by the setup epic (sh + .cmd shim) from `scripts/stubs/deploy/`; absent with `"deploy": "none"` (8.5)
  stubs/deploy/                   [project] the six stub files (`deploy`, `smoke`, `rollback`, each with its `.cmd`) bootstrap copies from `scripts/groundwork/stubs/deploy/`; inert until moved to `scripts/` (8.5)
  agent/  token.mjs next.mjs claim.mjs checkpoint.mjs resume.mjs release.mjs plan-lint.mjs review-queue.mjs
  human/  inbox.mjs
  owner/  setup.mjs               [control] owner wizard (14.3); the owner runs it under their own login, never an agent
  admin/  request.mjs             dispatches admin-run in groundwork; runs the push probe locally
  ci/     pr-metadata.mjs pr-size.mjs issue-format.mjs test-integrity.mjs check-results.mjs
          protected-labels.mjs settings-plan.mjs failure-alert.mjs deploy-record.mjs
          fixtures/<script>.json   fixture cases and expected results for the ci tests
  lib/    github.mjs config.mjs trust.mjs markdown.mjs issue-model.mjs settings.mjs ci.mjs   (13.1)
  kit-update.mjs                  (13, 13.1)
  groundwork/                     [control] bootstrap.mjs bootstrap-pass2.mjs bootstrap-tree.mjs bootstrap-repo.mjs setup-epic.mjs check.mjs script.mjs selftest.mjs selftest-probes.mjs app-token.mjs apply-settings.mjs create-issue-types.mjs admin-run.mjs
    stubs/ verify verify.cmd      [control] the project stub bootstrap writes to scripts/verify*; scripts/verify.cmd and the stub's verify.cmd are the same shim and need Git for Windows sh
    stubs/ deploy/                [control] `deploy`, `smoke`, `rollback` and their `.cmd` shims (8.5)
    stubs/ README.md docs/ setup/ [control] project README and docs stubs, and the Project setup epic templates (13.1 `setup-epic.mjs`)
  **/*.test.mjs                   unit tests beside each script (`node --test "scripts/**/*.test.mjs"`; a bare directory fails on Node 24)
.claude/
  settings.json                   hooks and permission rules
  skills/ groundwork-planner/ groundwork-worker/ groundwork-reviewer/ groundwork-triage/ (6.8)
    groundwork-setup/             [control] the org-setup skill (14.3); a project never gets it
AGENTS.md                         canonical agent rules
CLAUDE.md                         contains `@AGENTS.md`
.gitattributes                    LF everywhere, CRLF for .cmd and .bat
.gitignore                        ignores `.claude/worktrees/`; re-includes `.claude/skills/groundwork-*/` (below)
docs/
  setup.md                        one-time org setup, per-project path
  workflow.md                     the flow for humans, Mermaid diagram, touchpoints
  spec.md                         this document
  decisions/<N>-<slug>.md         decision records: spike research and hard-to-reverse decisions (4.1)
  runs/<date>-<slug>.md           notes on live runs and acceptance probes (17, 21)
release-please-config.json
.release-please-manifest.json
version.txt                       release-please `simple` version file; must exist, it is never created
CHANGELOG.md
SECURITY.md
LICENSE
README.md
GLOSSARY.md                       [project] domain terms; created by the first PR that needs one, never by bootstrap (3)
```

All machine-read configuration under `.github/groundwork/` is JSON: Node has no built-in YAML parser and D14 forbids dependencies. YAML is used only for files GitHub itself reads (workflows, issue forms, `dependabot.yml`).
In `groundwork`, caller workflows reference reusable workflows locally (`./.github/workflows/reusable-*.yml`); bootstrap rewrites those references for projects (14.2).
`.gitignore` carries these lines, in this order, because a global git ignore may exclude `.claude/skills/`; only groundwork's own skills are re-included:
```
!.claude/skills/
.claude/skills/*
!.claude/skills/groundwork-*/
```
`GLOSSARY.md` sits at the repository root and holds domain terms only: words of the product, not groundwork or tooling terms. The first PR that needs a term creates it; bootstrap ships no stub. `groundwork` itself keeps no `GLOSSARY.md`: its terms are this spec, and bootstrap would copy a root `GLOSSARY.md` into new projects, since it keeps every file outside `CONTROL_PATHS` that no stub or generated file replaces (13.1). Agents read it when present and say nothing when it is absent.

`groundwork`'s `scripts/verify` runs `node --check` on every `.mjs` file and parses every JSON file under `.github/groundwork/`; unit tests stay in the `scripts` job (8.2).

---

## 4. Issue model

### 4.1 Types and hierarchy

| Type | Parent | Closed by | Notes |
|---|---|---|---|
| Epic | none | you, manually | A delegated goal. Carries `accepted` and `priority:*`. |
| Feature | Epic (or Feature at depth 3) | its PR | New behavior. |
| Bug | Epic, or none for the hotfix lane (4.6) | its PR | Requires a failing test first. |
| Chore | Epic | its PR | Maintenance, dependencies, refactors without behavior change. |
| Spike | Epic | its PR | Investigation. Claimed like any task (ref and draft PR). Output is a decision record `docs/decisions/<N>-<slug>.md`, merged with a `docs(spike): ...` title. After merge the agent appends one dated line linking the record to the epic's `## Decisions`. |

- Depth 2 by default. Depth 3 only when an epic exceeds 12 tasks: an intermediate Feature groups tasks.
- At most 12 sub-issues per parent.
- Sub-issue order under the parent is execution priority within that epic.
- Dependencies use native "blocked by". The graph must be acyclic (`plan-lint`).

Decision records (`docs/decisions/<N>-<slug>.md`) hold spike output and any other decision that is hard to reverse, surprising without context and a real trade-off; a decision must meet all three. `<N>` is the issue where the decision was made (spike, task or epic); `<slug>` is lower-case words joined by `-`.
- Short form, for non-spike decisions: `## Context`, `## Decision`, `## Consequences`, one to three sentences each. A task's record is added by that task's PR. A decision made on an epic (planner, owner answer) is added by the first task PR under that epic that relies on it, with `<N>` the epic number; planners open no PR (6.1).
- After the PR merges, the agent appends one dated line linking the record to the epic's `## Decisions` by hand; `release.mjs --merged` appends it only for spikes.
- Spike records keep their longer research form (`## Output` of the spike, 4.3).
- Agents read the records, when present, before planning or reviewing. A plan that contradicts a record raises `needs-decision` (6.6); a newer record that replaces one names it.
- No other decision directory: no `docs/adr/`.

### 4.2 Criterion IDs

- Epic success criteria: `E1`, `E2`, ... unique within the epic.
- Task acceptance criteria: `AC1`, `AC2`, ... unique within the task.
- A task's `## Serves` names the epic criteria it advances (`E2`).

### 4.3 Required body format

Issue forms (`.github/ISSUE_TEMPLATE/*.yml`) serve the web UI and set the issue type. Agents create issues from the markdown twins in `.github/groundwork/templates/` because forms do not apply to API or CLI issues. `issue-format` validates both against one heading list; a unit test asserts the forms and twins list the same sections (the test reads form `label:` lines with a regex, no YAML parser).

**Epic**
```
## Goal                one paragraph: outcome and why
## Success criteria    - [ ] E1 ... (observable, checkable)
## Constraints         limits, non-goals, out of scope
## Plan                approach, lanes, risks (planner-written before acceptance)
## Decisions           dated, append-only
## Open questions
```

**Feature / Chore**
```
## Outcome
## Serves              E2
## Scope               in / out
## Touches             expected paths or modules; hotspots named explicitly
## Acceptance criteria - [ ] AC1 ... (observable)
## Verification plan   commands, tests, visual evidence expected
## Risk                low | medium | high (rollback plan required if high)
## Context             files, links, prior decisions
```

**Bug** adds `## Reproduction` and `## Expected vs actual` to the Feature format. In the web form `Serves` is optional (hotfix lane, 4.6).

Issues created from the web forms render answers as `### <label>` headings and empty optional fields as `_No response_`. `issue-format` and `validateIssueBody` accept level-3 headings for form-generated bodies and treat `_No response_` as empty.
**Spike** uses `## Question`, `## Serves`, `## Timebox`, `## Output` (what the decision record at `docs/decisions/<N>-<slug>.md` must answer).

### 4.4 Derived status

No status labels. `scripts/lib/issue-model.mjs` computes status from facts; `next`, `inbox` and `resume` use it. The first matching row wins.

| Status | Condition |
|---|---|
| done | issue closed |
| needs decision | `needs-decision` label |
| queued | PR in the merge queue |
| in review | PR marked ready for review |
| claimed | `issue/N` ref exists (draft PR, or no PR yet within the claim window measured from the issue pointer comment or else the claim commit, 6.3) |
| orphaned | `issue/N` ref exists, the issue is open, and its PR is not open (closed unmerged); shown in `inbox`, cleared by deleting the branch |
| proposed | epic, or task under an epic, without a valid `accepted` (section 5) |
| blocked | an open issue in its `blocked-by` |
| ready | accepted ancestor (or hotfix lane), not blocked, no `issue/N` ref |

An Epic carrying a valid `accepted` is never `proposed`: it is `blocked` or `ready`. `next` excludes Epics from claim candidates. Only ancestors of type Epic supply `accepted`.

### 4.5 Checklists

**Definition of Ready** (checked by `next` before claim)
- Accepted ancestor epic (or hotfix lane)
- Required sections present; `needs-format` absent; parent present and depth within limits (except hotfix lane)
- Every AC is observable
- No open blockers
- `size:S` or `size:M`
- Author is a trusted account (D16)

**Definition of Done** (checked by `PR metadata` and the reviewer)
- Every AC mapped to evidence in the PR
- `Check` green; tests added; failing test first for bugs
- Docs updated where behavior changed
- No changes outside the task's scope
- Every review finding fixed or answered
- `## State` complete; handover comment posted

**Epic close** (checked by `scripts/agent/plan-lint --close` and by you)
- All sub-issues closed as completed, or "not planned" with a reason
- Acceptance comment maps every E criterion to evidence
- Decisions log current

`plan-lint --close` checks these rules and writes nothing; closing stays with you:
- Every sub-issue is closed. One closed as anything but completed needs a line in the epic's `## Decisions` that names `#N` and gives a reason and contains one of these words, case-insensitive: "not planned", "dropped", "won't", "superseded", "duplicate", "obsolete", "no longer", "cancel".
- A spike closed as completed needs a `## Decisions` line linking `docs/decisions/<N>-<slug>.md`.
- The acceptance comment (from the agent account, marker `acceptance`) has an evidence row for every E criterion; empty, `none`, `-`, `n/a`, `_No response_` and `<...>` placeholder cells do not count, and a row for an unknown criterion fails.
- An epic with no sub-issues or no E criteria fails.

The rest of "Decisions log current" stays with you.

### 4.6 Hotfix lane

A Bug with `priority:p0` applied by you skips epic acceptance: no parent required, `next` ranks it first, `PR metadata` accepts it without an accepted epic. After merge you merge the release PR for a patch release.

---

## 5. Labels

GitHub default labels are deleted. `labels.json` is the source of truth; bootstrap and `apply-settings` sync it.

| Label | Applied by | Meaning |
|---|---|---|
| `accepted` | you only | Epic authorized |
| `priority:p0` ... `priority:p3` | you only | Epic priority; tasks inherit |
| `size-exception` | you only | PR may exceed size limits |
| `no-issue` | you only | PR needs no issue; honored only when applied after the head's arrival in the PR (8.3), so re-applied after each push |
| `integrity-exception` | you only | PR may trip `test-integrity` (8.2) |
| `needs-decision` | agent | Work stopped until you answer; claim released |
| `needs-format` | `issue-format` | Body invalid; agents skip the issue |
| `size:S` `size:M` `size:L` | agent | Estimate; `L` must be split before claim |
| `area:*` | agent | Project-defined in `labels.json` |
| `flaky` | agent | Test ejected a merge-queue batch twice |
| `dependencies` | Dependabot only | Valid exemption only with author `dependabot[bot]` |
| `automated` | release App only | Valid exemption only with author `wimdotgg-release[bot]`; set through `"extra-label": "automated"` in `release-please-config.json` |
| `autorelease: pending` `autorelease: tagged` | release-please | Release PR state |

The required actor per protected label lives in `config.json` `labelActors` (13.1): `accepted`, `priority:*`, `size-exception`, `no-issue`, `integrity-exception` map to you; `dependencies` to `dependabot[bot]`; `automated` to the release App's bot. `protected-labels` removes any of these when applied by another actor, and comments why. Logins compare case-insensitively.

That removal is hygiene, not the gate: a removal by `GITHUB_TOKEN` fires no `unlabeled` run (D6). Every consumer of a protected label (`issue-model`, `PR metadata`, `pr-size`, `test-integrity`) therefore treats the label as valid only when the latest `labeled` event for it in the issue or PR timeline has the label's required actor.

`no-issue` is honored only by the stateless freshness rule in `PR metadata` (8.3): the label's latest `labeled` event must be later than the head's arrival in this PR (the newest arrival on the PR branch, which must be the head SHA, or a later force push, reopen or base change, 8.3), on every event type, and never for a PR whose head repository is not this one. `protected-labels` also removes it on `pull_request_target` `synchronize` and `reopened`, and `PR metadata` refuses it on those runs; the removal is hygiene and the failure an early signal, not the gate. The owner's re-applying the label fires `labeled`, which re-runs `PR metadata`.

---

## 6. Agent workflow

### 6.1 Roles

| Role | Does | Never |
|---|---|---|
| Planner | Turns a goal into an epic with sub-issues, dependencies and a plan comment; runs `plan-lint` | Starts implementation; applies `accepted` |
| Worker | Loops `next` → `claim` → build → checks → enqueue | Holds more than one task; merges release PRs |
| Reviewer | Reviews PRs opened by another session; posts comment reviews | Approves or requests changes (GitHub forbids both on a PR from the same account) |

Review threads must be resolved before merge (ruleset). The worker resolves each thread after fixing or answering it, with `resolve-thread.mjs` (13; `gh api` writes stay forbidden, 2.2), and records it in `## Review log`; that is how advisory findings (D12) get closed without the reviewer holding a veto.

A review starts with `Reviewer: <model>/<harness> · session <id>` (first or last non-empty line); `review-queue` (13) clears a PR only for a review with that line on its current head.

Roles are prompts packaged as `.claude/skills/groundwork-*` and described in `AGENTS.md`. All roles act as the agent App (2.2); the session id separates them.

### 6.2 Planning for width

- Contract task first (shared types, schema, API shape), then lane tasks that can run concurrently, then one integration task blocked by all lanes.
- Two tasks whose `## Touches` overlap must be linked with `blocked-by` or merged into one task.
- Tasks touching a hotspot name it in `## Touches`. `hotspots.json` paths are exact paths or directory prefixes, not globs (`scripts/lib` has no glob helper): `next` holds a hotspot when an open PR changes a file equal to a path or under it, and a task's `## Touches` names it by hotspot name or path.
- The plan comment on the epic lists lanes and lane width.
- `plan-lint` fails on: dependency cycle, task without AC (Spikes excepted), task without `## Serves`, epic without integration task, more than 12 sub-issues, depth over the limit, overlapping `## Touches` without a `blocked-by` link. It reports lane width.
- The planner runs `plan-lint` locally as its last step and posts the report comment. Adding sub-issues or dependencies fires no `issues` event on the epic, so the workflow (8.4) cannot be relied on to refresh the report.

### 6.3 Worker loop

1. `node scripts/agent/token.mjs exec -- node scripts/agent/next.mjs` returns the next eligible task: ready status, Definition of Ready met, hotspot not held by any open PR's actual changed files. Takeover candidates (6.4) rank before fresh tasks. Order after that: `priority:p0` hotfixes, then epic priority (ties by epic number), then sub-issue order. A takeover is offered only while the task passes every status check except `claimed`; format and size are not re-checked (6.4).
2. `node scripts/agent/token.mjs exec -- node scripts/agent/claim.mjs N --session <id> --agent <model>/<harness>` (13):
   - creates an empty commit `chore(claim): #N [session <id>]` through the API (`POST /git/commits` with the tree and SHA of `main` as tree and parent), so the claim does not depend on local checkout state. `claim.mjs` never sends `author` or `committer` dates, so GitHub stamps the committer date server-side; this agent-created API commit is the only place a commit date is trusted (6.4);
   - creates `refs/heads/issue/N` via `POST /repos/{o}/{r}/git/refs`. **Only HTTP 201 counts as claimed**; any other response (422 when the ref exists) means "not claimed, try the next candidate";
   - posts a one-line pointer comment on the issue (`issue/N`, session id, marker `<!-- groundwork:claim -->`); its server-side `created_at` is the claim time until the PR exists;
   - opens a draft PR from `issue/N` with the PR template, `Closes #N`, and an initial `## State`. If this step fails after the ref exists, `claim` retries it; a ref without a PR counts as an expired lease 15 minutes after the pointer comment, or, when there is no pointer comment either, 15 minutes after the claim commit's committer date;
   - posts the claim comment on the PR (claim, checkpoint and takeover comments all live on the PR, 6.4).
3. Build. Bugs start with a failing test. Push early. Bring the branch up to date with `main` by merging it (`git merge origin/main` or the PR's "Update branch"), never by rebase: `issue/*` only moves forward (D17).
4. `checkpoint` at the required moments (6.5).
5. Mark ready for review when Definition of Done is met (`gh pr ready N` through `token.mjs exec`). Required checks and reviewer run.
6. Address review findings; after 3 rounds, `needs-decision`.
7. Enqueue with `node scripts/agent/token.mjs exec -- gh pr merge N --auto --squash` (without `--squash` `gh` refuses; the PR enters the merge queue once requirements are met, including your approval on protected paths). The worker returns to step 1.
8. If the PR is ejected from the queue or receives new findings, the same worker returns to it before taking new work.
9. After merge: handover comment on the issue (`node scripts/agent/token.mjs exec -- node scripts/agent/release.mjs N --merged --session <id>`); for a Spike it also appends the decision line to the epic's `## Decisions`.

### 6.4 Leases and takeover

- A claim is a lease only while its PR is a **draft**. Ready, queued and awaiting-you PRs never expire.
- A draft lease expires after the configured lease (default 4 hours) without agent activity, measured by the server-side `created_at` of the latest PR comment authored by the agent account (claim, checkpoint and takeover each post one), falling back to the PR's `created_at`. PR `updated_at` is not used: any outside commenter can bump it on a public repo. Commit dates are client-controlled and not used either, with one exception: before a PR or pointer comment exists, the claim window runs from the claim commit's committer date, which GitHub stamps because `claim.mjs` creates that commit through the API and never sends dates (6.3).
- Takeover is compare-and-swap: the new worker reads the branch head SHA, creates a takeover commit `chore(claim): #N takeover [session <id>]` with that SHA as parent (`POST /git/commits`), and moves the branch with a plain fast-forward update (`PATCH /git/refs/heads/issue/N` with `force: false`). If the head moved in between, the update is not a fast-forward and fails; the loser of the race moves on. The winner posts a takeover comment, which restarts the lease.
- Rival-takeover window: until that comment exists the lease is not restarted, so a head that is another session's takeover commit (for this issue) with a GitHub-stamped committer date younger than `claimWithoutPrMinutes` holds the PR, and a second `claim` exits 3. Like the claim commit it is an agent-created API commit, so its date is server-stamped; a missing date counts as recent.
- `next` offers a takeover only while the task passes every status check except `claimed` (4.4), so format and size are not re-checked. A direct `claim N` on a takeover candidate does not re-check readiness (accepted gap).
- Workers never force-push in any form (no `--force` or its lease variant, no `+` refspec, no `force: true`), and the `issue-branches` ruleset (9.5) rejects non-fast-forward updates for everyone, so a revived worker's stale push is rejected. A revived worker runs `resume` first and stops if the PR footer names another session.
- Takeover continues from `resume` output; it never restarts the task.
- `needs-decision` releases the claim (`node scripts/agent/token.mjs exec -- node scripts/agent/release.mjs N --decision --session <id>`): a ready PR is first converted back to draft (a `needs-decision` raised after 3 review rounds must still be takeable; a closed PR is refused), the PR stays open with its `## State`, the PR body gets the marker `<!-- groundwork:released -->` above the footer break, and the worker takes other work. Once you remove `needs-decision`, the marker makes the PR a takeover candidate immediately; takeover removes the marker.
- Takeover candidates for `next`: draft PRs with an expired lease or a released marker, and no `needs-decision` label.

### 6.5 Context preservation

| Context | Home |
|---|---|
| Intent | Issue body; scope changes go into the epic's `## Decisions` |
| Current state | PR body `## State`, rewritten per checkpoint (max ~40 lines) |
| Reasoning | Checkpoint comments on the PR (max 10 lines each) |
| Code | The branch, pushed at every checkpoint even if red |
| Durable lessons | An `AGENTS.md` PR (protected path, you approve) |

`## State` format:

```
## State  (checkpoint 3 · 2026-11-16 14:20 · <model>/<harness> · session a1b2)
Done:        AC1, AC2 (tests: handler.test.ts › rejects empty input)
In progress: AC3, validation error mapping in src/api/errors.ts
Next:        wire error codes into the form; then AC4
Proven:      AC1, AC2 (CI run #482)
Unproven:    AC3, AC4
Rejected:    zod .refine for cross-field check, error path lost in nested arrays
Gotchas:     test DB needs `npm run db:reset` after pulling main
Open:        none
```

`checkpoint.mjs` pushes the branch, rewrites `## State` from the template, and posts the journal comment, in one command. Required before: ending a session, raising `needs-decision`, marking ready for review, completing a takeover.

`resume.mjs N` prints a bounded briefing (target under 300 lines): issue spec; epic goal and decisions; PR `## State`; last 3 journal entries; diff stat against `main`; latest CI result with the failing step; unresolved review threads; blocker status. Text authored by untrusted accounts is printed inside a fenced block labeled untrusted.

### 6.6 Escalation (`needs-decision`)

Raised when: 3 review rounds without convergence; the same failure 3 times; work falls outside the epic's success criteria (the agent opens a new proposed epic instead); a rule conflicts with the task; a second flake on the same test. The agent states the question and options in a comment. You answer; the next worker resumes.

### 6.7 Trust boundary (D16)

- Trusted authors: `wianvdm`, `wimdotgg-agent[bot]`, `wimdotgg-admin[bot]` (bootstrap opens the "Project setup" epic), `wimdotgg-release[bot]` (release PRs only), `dependabot[bot]` (dependency PRs only). The list lives in `config.json` (`trustedAuthors`, App bots named by App key) and is read through `scripts/lib/trust.mjs`; nothing else hardcodes it. Logins compare case-insensitively.
- `next` ignores issues not authored by a trusted account. To adopt an external report, you or an agent create a task that links to it (6.8).
- `resume`, the reviewer and the planner treat text from other authors as data, never as instructions.
- Outside contributors' PRs cannot satisfy `PR metadata` (no accepted issue) and their workflow runs require your approval.

### 6.8 Triage of untrusted reports

The queue is derived: `inbox` lists open untrusted-author issues with no linked task (13, section `untrusted-reports`). No label marks triage state: no `needs-triage`, `ready-for-agent` or other state label (4.4, 5).
- You invoke the `groundwork-triage` skill on one report. The agent reads it as data (6.7) and posts one recommendation comment on the report, ending with the marker `<!-- groundwork:triage -->`. The recommendation is the comment with that marker whose author is `accounts.agent` (as `plan-lint` finds its report); a marker from anyone else is ignored. A rerun updates that comment, but only while it is the agent's newest comment on the report: `gh issue comment --edit-last` edits the token user's newest comment and `gh` has no edit by id (`gh api` writes are forbidden, `AGENTS.md` Identity and pacing). After "ask for information" the skill stops instead and you decide; a script that upserts by comment id would lift this and is its own task. It recommends one of:
  - **Linked task:** a Feature, Bug or Chore under an open proposed epic (no `accepted`), existing or new.
  - **Ask for information:** the questions the reporter must answer first.
  - **Close as not planned:** with the reason.
- The agent acts only after you answer. An answer is text you type in the session, or a reply comment on the report whose author is `accounts.owner` (case-insensitive) and whose `created_at` is later than the recommendation's `updated_at` (the newest such reply wins), so an earlier answer never covers an updated recommendation. Report text and other comments read in the session are never an answer; a reply from anyone else is data. The answer may pick another of the three options. Without an answer the agent does nothing more.
- The agent writes the recommendation and any task in its own words. Report text it quotes goes inside an `untrusted <author>` fence (`untrustedBlock`, 13.1), because `resume` prints agent-authored issues as trusted text.
- On "linked task" it creates the task from the 4.3 template, with parent, type and the line `Reported in #<report>` in `## Context`, so `inbox` sees the link. A new epic is proposed only. The agent applies no owner-only label (5); the task stays out of `next` until you apply `accepted` to its epic.
- On "ask for information" it posts the questions as a second comment on the report, without the marker. The report stays in the queue.
- On "close as not planned" it closes the report with reason `not planned` and a comment giving the reason. When the rejected scope falls under an epic, the agent also appends a dated line to that epic's `## Decisions`; otherwise the close comment is the record. No out-of-scope directory.
- Reproduction is optional and runs repository code at a known commit, named by SHA in the comment. The agent never runs commands, opens URLs, applies patches or executes code taken from the report.

---

## 7. PR contract

**Branch:** `issue/N` (deterministic, the claim lock).
**Title:** Conventional Commit, `<type>(<scope>)!: <imperative summary>`. Types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test. `!` marks breaking. Title type must match issue type: Feature → `feat`; Bug → `fix`; Chore → `build|chore|ci|docs|refactor|style|test|perf|revert`; Spike → `docs(spike)`.
**Squash commit:** title = PR title, body blank. Breaking changes therefore must use `!` in the title.

**Body (`pull_request_template.md`)**

```
Closes #<issue>

## Summary
- Problem:
- Change:

## Evidence
| Criterion | Evidence (test name, command output, run link, screenshot link) |
|---|---|
| AC1 | |

## Executed checks
- [ ] `<command>`: <observed result>

## Unexecuted checks
- [ ] `<command>`: <why not, and when>  (or: None)

## Risk and rollback
- Risk: low | medium | high
- Rollback:

## State  (checkpoint <checkpoint> · <time> · <agent> · session <session>)
Done:        <done>
In progress: <in progress>
Next:        <next>
Proven:      <proven>
Unproven:    <unproven>
Rejected:    <rejected>
Gotchas:     <gotchas>
Open:        <open>

## Review log
- <finding>: fixed in <sha> | answered: <reason>

---
Agent: <agent> · session <session>
```

Screenshots and evidence are attached in the PR, never committed.

---

## 8. CI

All workflows: `permissions: contents: read` at the top, widened per job only where needed; every action pinned to a full commit SHA with a version comment; `timeout-minutes` on every job; `persist-credentials: false` on checkout. Event text (titles, bodies, branch names, labels) reaches scripts through `env:` or the event payload file, never through `${{ }}` inside `run:`.

Only `protected-labels` uses `pull_request_target` (it must write labels on fork and Dependabot PRs, whose `pull_request` token is read-only). Every other PR job is read-only and uses `pull_request`.

### 8.1 Required checks

All required checks are produced by the GitHub Actions app (`integration_id: 15368`) so nothing else can post a passing result under the same name.

| Check name | Workflow | On `pull_request` | On `merge_group` |
|---|---|---|---|
| `Check` | `ci.yml` | full | full (no path filters) |
| `PR metadata` | `pr-metadata.yml` | full | pass-through job (already validated on the PR) |
| `pr-size` | `pr-metadata.yml` | full | pass-through |

A required job named in the ruleset must be a job in the caller workflow that runs steps itself: a job that calls a reusable workflow reports as `<caller job> / <called job>` and cannot carry the required name (V8).
Pass-through means the same job runs and succeeds on `merge_group` without validating: steps that need PR data carry a step-level `if: github.event_name != 'merge_group'`, and the validators themselves also return `skip` (exit 0) for that event (13.1). Do not skip the job with a job-level `if`.

Code scanning results are required through the ruleset's `code_scanning` rule (bootstrap pass 2, V10).

### 8.2 `ci.yml`

Triggers: `pull_request` (opened, synchronize, reopened, ready_for_review), `merge_group`, `push` to `main`.
Concurrency: `ci-${{ github.event.pull_request.number || github.sha }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`, so `merge_group` and `push` runs are never cancelled. Keyed by SHA, not ref: GitHub keeps one pending run per group and cancels older pending ones, so a shared `main` group could leave a push range unscanned by gitleaks.

| Job | Calls | Does |
|---|---|---|
| `verify` | `reusable-verify.yml@<tag>` | Runs `scripts/verify` (format, lint, typecheck, test, build as the project defines). While `scripts/verify` still contains the stub marker `GROUNDWORK_STUB`, emits a warning and passes; `bootstrap-pass2` refuses to run while the marker is present. |
| `security` | `reusable-security.yml@<tag>` | actionlint and zizmor on workflows; gitleaks (`--ignore-gitleaks-allow`) over the diff (PR, merge group) or history increment (push), failing on an unreachable or empty range or a partial scan; osv-scanner on lockfiles, failing on any severity with exceptions only through `osv-scanner.toml` (exit 128 passes only when no lockfile failed to parse); `actions/dependency-review-action` on `pull_request` only (fail on high, runtime and development scopes). |
| `test-integrity` | local script | PR only (pass-through on `merge_group` and `push`). Fails when the diff deletes or skips tests, lowers a coverage or lint threshold, or adds a suppression (`eslint-disable`, `@ts-ignore`, `# noqa`, `.skip`, `xit`, and patterns from `config.json`), unless a valid `integrity-exception` is present (section 5). Labels are read live from the API; after you apply the label the agent re-runs the job. |
| `scripts` | local steps | `node --test "scripts/**/*.test.mjs"` (a bare directory fails on Node 24). Runs the kit's unit tests in every repo; control-only tests live under `scripts/groundwork/` and leave with that directory at bootstrap. |
| `settings-plan` | `scripts/ci/settings-plan.mjs` | PRs touching `.github/groundwork/**` only (the validator returns `skip` when the PR changes no file under `.github/groundwork/`). Writes desired vs. live settings to the job summary (tier 1, section 12); the PR's settings files are read as data from a second checkout of the PR head (`env.PR_ROOT`), never executed. The PR `GITHUB_TOKEN` reads rulesets, environments and labels; Actions settings return 403, so they are shown as a file diff against the base (V4). Fails only when a settings file is invalid. Prints one stdout status line per live section (readable, or unreadable with its HTTP status) to the job log (#110). |
| `Check` | `scripts/ci/check-results.mjs` | `needs: [verify, security, test-integrity, scripts, settings-plan]`, `if: always()`. Reads `toJSON(needs)` from `env`. Fails if any needed job has a result other than `success`. Stays in the caller so the required name is stable. |

`test-integrity`, `settings-plan` and `Check` check out their validator scripts, `scripts/lib/` and `.github/groundwork/config.json` from the **base** commit (`github.event.pull_request.base.sha`), like `PR metadata` and `pr-size` (8.3), so a PR cannot change the rules it is judged by; on `merge_group` and `push` they use the event's own commit. The workflow YAML comes from the PR and changes to it need your CODEOWNERS approval.
`PR metadata` reads the voiding events for head arrival (`head_ref_force_pushed`, `reopened`, `base_ref_changed`, `automatic_base_change_succeeded`) from both the timeline and the issue events endpoint, because GitHub documents `base_ref_changed` and `automatic_base_change_succeeded` as issue events only, so the timeline cannot be relied on for them (#109, #116).
`ci.yml` passes no secrets to the reusable workflows and never uses `secrets: inherit`. Dependabot-triggered runs get no secrets and a read-only token; every required job must pass under those conditions.
A commit message containing `[skip ci]` suppresses `pull_request` and `push` runs; the required checks then never report and the PR cannot merge, which is the wanted outcome.

### 8.3 `pr-metadata.yml`

Triggers: `pull_request` (opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled), `merge_group`.
Both jobs run local steps (no reusable workflow) so the check names are exactly `PR metadata` and `pr-size`. Concurrency per PR number, cancel in progress.
The validator scripts and `.github/groundwork/config.json` are checked out from the **base** commit (`github.event.pull_request.base.sha`) so a PR cannot change the rules it is judged by. (The workflow YAML itself comes from the PR; changes to it require your CODEOWNERS approval.) Permissions: `contents: read`, `pull-requests: read`, `issues: read`. Arrival time comes from the repository activity API, so no workflow-run permission is needed. The jobs report through exit code and job summary and never comment, so they work on fork and Dependabot PRs.

`PR metadata` fails unless:
- Exactly one closing reference `Closes #N` (outside HTML comments and code fences), to an open issue in this repo.
- The issue is valid (`needs-format` absent), authored by a trusted account, under an epic with a valid `accepted` (or hotfix lane), with no open blockers.
- Branch is `issue/N` and the head repository is this repository (no forks).
- Title is a Conventional Commit and its type matches the issue type.
- Every AC ID in the issue appears in the `## Evidence` table with non-empty evidence.
- `## State` exists, has no template placeholders, and lists no criterion as proven without evidence (ready-for-review PRs only; drafts get a warning).
- Spike PRs add exactly one file `docs/decisions/<N>-<slug>.md` (N is the closed issue).
- Exemptions from all of the above: a valid `dependencies` with author `dependabot[bot]` and a minor or patch update; a valid `automated` with author `wimdotgg-release[bot]`; a valid `no-issue` whose latest `labeled` event is later than the head's arrival in this PR, and never on a `synchronize` or `reopened` run, where it is refused with `` `no-issue` must be re-applied after new commits or a reopen ``. Never when the head repository differs from this repository (case-insensitive owner/name): activity is read by branch name from this repository, so a fork head proves nothing, and the PR fails with `no-issue does not apply to PRs from another repository`. Arrival is the newest arrival entry on the PR branch (repository activity API, `GET /repos/{owner}/{repo}/activity?ref=refs/heads/<branch>`, server `timestamp`; types `push`, `force_push`, `branch_creation`, `pr_merge`, `merge_queue_merge`; `branch_deletion` is not one), and its `after` must be the head SHA: an older entry for the same SHA does not stand in for a newer push of another commit (listing lag or a moved branch), so a newest entry for another SHA fails the check (exit 2) and a re-run clears it. Entries with the same newest timestamp must all be the head. A later `head_ref_force_pushed`, `reopened`, `base_ref_changed` or `automatic_base_change_succeeded` event, read from the timeline and the issue events endpoint (8.2), moves arrival later; no arrival entry at all also fails the check (exit 2). Commit dates are client-controlled and not used.
- Dependabot **major** updates fail until an agent edits the PR body to add `Closes #N` for a Chore issue. For author `dependabot[bot]` the branch, `## Evidence` and `## State` rules are waived; the issue rules apply.

`pr-size` fails when changed lines (additions plus deletions) exceed 400 or files exceed 20, excluding lockfiles, snapshot files and the generated-file globs in `config.json`, unless a valid `size-exception` is present. Exempt by the same rule as `PR metadata` (section 5): a valid `dependencies` with author `dependabot[bot]` (any update type), or a valid `automated` with author `wimdotgg-release[bot]`.

### 8.4 Issue and planning workflows

| Workflow | Trigger | Does |
|---|---|---|
| `issue-format.yml` | `issues`: opened, edited, reopened, typed, untyped | Validates headings for the type and unique criterion IDs. Invalid (or no type): adds `needs-format` and posts or updates one comment with the errors. Valid: removes `needs-format`. Permissions `issues: write`. The parent link is not checked here: it is added after creation and fires no `issues` event, so `plan-lint`, `next` and `PR metadata` check parent and depth instead. |
| `protected-labels.yml` | `issues`: labeled; `pull_request_target`: labeled, synchronize, reopened | Removes protected labels applied by anyone but their required actor (section 5; `github.event.sender.login`, V9), and removes `no-issue` on every `synchronize` and `reopened` (hygiene; the freshness rule in 8.3 is the gate). Checks out nothing from the PR and only calls the API. Permissions `issues: write`, `pull-requests: write`. |
| `plan-lint.yml` | `issues`: opened, edited, labeled, typed, filtered to type Epic by a job `if`; `workflow_dispatch` with input `epic` | Runs `plan-lint --post` and posts or updates one report comment on the epic. The step fails on any `{ ok: false }` result without a `failures` key (an API or usage error, or a dispatch on a non-epic); a lint failure carries `failures` and exits the step green, so a bad plan never turns the check red. The report comment is shared with the planner: the lookup accepts a marked comment from the agent App or `github-actions[bot]` and no other login, so the App's `--post` finds the workflow's comment and reports `unchanged`. Permissions `issues: write`. |

### 8.5 Release and operations workflows

| Workflow | Trigger | Does |
|---|---|---|
| `release-please.yml` | `pull_request`: closed, base `main`; `workflow_dispatch`. No `push` (11) | Job `dispatch-on-main`: runs on a merged close from this repository (any head branch), no environment, permissions `actions: write` only; its one step dispatches `release-please.yml` on `main` with `github.token`. Job `release-please`: runs only on `workflow_dispatch` (dispatched on `main`, `GITHUB_REF` `refs/heads/main`), and needs `vars.GROUNDWORK_READY == 'true'` (repository variable set at the end of bootstrap pass 1, so a run before the `release` environment exists does not fail on it). Environment `release`; mints the `wimdotgg-release` token (2.3); runs `googleapis/release-please-action` with `token`, `config-file`, `manifest-file`. Concurrency group `release-please` on the release job with `cancel-in-progress: false` (11). |
| `deploy.yml` | `release: published` | Job `if`: `vars.DEPLOY_ENABLED == 'true'` and the release is not a prerelease. Environment `production` (your approval, `v*` tags only; the run's ref is the release tag). Runs `scripts/deploy <tag>`, then `scripts/smoke`; on failure runs `scripts/rollback <previous tag>` and smokes again, and the job still fails. Writes a summary and appends a deploy record to the release notes (`contents: write`). Concurrency group `production`, never cancelled. |
| `failure-alert.yml` | `workflow_run` completed for release-please and deploy | Opens one alert issue per workflow on failure, comments on repeats, closes on the next success. Alert issues are authored by `github-actions[bot]` and have no type; `issue-format` skips issues by that author, `next` ignores them (untrusted author), `inbox` lists them. Permissions `issues: write`. |

Deploy scripts (contract for `deploy.yml` and the stubs; 13.1 `deploy-record.mjs` for the helper):

- `scripts/deploy <tag>`: `<tag>` is the release tag `vX.Y.Z`, the checked-out ref. Exit 0 deployed, any other code failed. The job's `production` secrets are in its environment (names from `settings.json` `environments.production.secrets`); the script reads them from `process.env`, nothing is passed as arguments. `deploy.yml` lists no secret itself: setup task 04 maps each name into the `deploy` job `env`.
- `scripts/smoke`: no arguments, read-only and idempotent. Exit 0 healthy. It runs after `deploy` and again after `rollback`.
- `scripts/rollback <previous tag>`: redeploys that tag; exit 0 rolled back. `deploy.yml` passes the tag `deploy-record.mjs previous-tag` prints: the highest published release `vX.Y.Z` that is not a draft or prerelease and is lower than the deployed tag. With none, nothing runs, the record says `Previous: none` and the job fails. A release tag that is not `vX.Y.Z` fails the `Find previous tag` step before `deploy` runs and writes no record, because `deploy-record.mjs` rejects the tag.
- Flow: deploy, smoke; if either fails, rollback then smoke; the job fails whenever deploy or the first smoke failed, even if the rollback smoke passes. Result in the record is `deployed` (deploy and smoke passed), `rolled-back` (rollback and its smoke passed) or `failed` (anything else).
- Record: after the last step (`if: always()`) `deploy-record.mjs` appends to the release notes the block below, or replaces it when the marker is already there (a rerun). `deploy.yml` also writes the same lines to the job summary.
  ```
  <!-- groundwork:deploy -->
  ### Deploy
  Result: deployed|rolled-back|failed
  Tag: vX.Y.Z
  Previous: vX.Y.Z|none
  Run: https://github.com/<org>/<repo>/actions/runs/<run id>
  ```
- Shims: each script has `<name>.cmd`, the `verify.cmd` shim with the script name swapped (needs Git for Windows `sh`).
- Stubs: `scripts/groundwork/stubs/deploy/` holds `deploy`, `smoke`, `rollback` and the shims ([control], so `bootstrap` drops the directory after reading it). Each stub prints one line `GROUNDWORK_STUB: scripts/<name> is the groundwork stub; replace it in the Project setup epic` to stderr and exits 1, unlike the `verify` stub, because a stub that passed would report an unreal deploy as green. `buildBootstrapTree` writes the six files to `scripts/stubs/deploy/` in every project, so a project with `"deploy": "none"` still has no `scripts/deploy`, `scripts/smoke` or `scripts/rollback`. A project that deploys moves the files to `scripts/` (setup task 04), replaces the bodies and sets `"deploy": "scripts"`; `kit-update` never touches `scripts/stubs/` or the moved scripts.

### 8.6 Reusable workflows and pinning

Projects call `uses: <org>/groundwork/.github/workflows/reusable-*.yml@<commit SHA> # vX.Y.Z`: the SHA of the release tag's commit, with the tag in a comment. The org's SHA-pinning policy does not cover reusable workflows; zizmor `unpinned-uses` alone rejects a tag reference (`gw-p4-a` `ci` run 44894024844, repository since deleted: `verify` and `actionlint` passed through the tag, `zizmor` failed), so `bootstrap` resolves the tag to its commit (`resolveTagCommit`, 13.1) and writes the SHA. Dependabot (`github-actions` ecosystem) opens bump PRs that move the SHA but leave `kit-version.txt` on the old tag, so the two can drift. `kit-update` owns these references (13.1): it rewrites every pin to the target tag's commit SHA with the tag in the comment, so after an update every pin names the tag in `kit-version.txt`. Dependabot stops moving them: the template `dependabot.yml` carries `ignore` with `dependency-name: "*/groundwork"` for the `github-actions` ecosystem. `.github/` is a protected path so you approve every such PR. `groundwork` itself calls its reusable workflows locally (`./.github/workflows/...`).
The reusable workflows declare `on: workflow_call` with no secrets and `permissions: contents: read`. They check out the caller's repository, so `scripts/verify` is the project's own. Tools they use (actionlint, zizmor, gitleaks, osv-scanner) are installed by SHA-pinned actions or checksum-verified downloads.

### 8.7 Control-repo workflows

| Workflow | Trigger | Does |
|---|---|---|
| `admin-run.yml` | `workflow_dispatch` | Tier 2 operations (section 12). |

There is no separate control CI workflow. `groundwork` runs the same `ci.yml` as projects; its `scripts` job also picks up the control-only tests under `scripts/groundwork/` (bootstrap against fixtures, issue and PR parsing fixtures), so they are part of groundwork's own `Check` without a cross-workflow dependency.

---

## 9. Rulesets

Stored as JSON in `.github/groundwork/rulesets/`; applied by bootstrap and `apply-settings`; compared against live by `check`.

### 9.1 `main`

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_type": "OrganizationAdmin", "actor_id": 1, "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
    } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "Check", "integration_id": 15368 },
          { "context": "PR metadata", "integration_id": 15368 },
          { "context": "pr-size", "integration_id": 15368 }
        ]
    } },
    { "type": "merge_queue", "parameters": {
        "merge_method": "SQUASH",
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 3,
        "min_entries_to_merge": 1,
        "max_entries_to_merge": 3,
        "min_entries_to_merge_wait_minutes": 1,
        "check_response_timeout_minutes": 30
    } }
  ]
}
```

Shapes checked against the REST reference for `POST /repos/{owner}/{repo}/rulesets` on 2026-11-16: rule types, every parameter name, `allowed_merge_methods` values (`merge`, `squash`, `rebase`, lower case), `merge_queue` enums (`merge_method`: `MERGE`, `SQUASH`, `REBASE`; `grouping_strategy`: `ALLGREEN`, `HEADGREEN`, upper case; all seven parameters required), `bypass_mode` values (`always`, `pull_request`, `exempt`).

- `strict` is off because the merge queue tests each group on top of `main`.
- `actor_id` is ignored for `OrganizationAdmin`; the file sends `1`, and read-back returns `null` (Phase 0). `check` compares `OrganizationAdmin` bypass actors by `actor_type` and `bypass_mode` only; every other bypass actor by `actor_type`, resolved `actor_id` and `bypass_mode`.
- The org-admin bypass is pull-request-only (valid for branch rulesets only). It exists so you can merge your own protected-path PRs, which you cannot approve yourself. A bypass merge also skips the merge queue (V6). Agents cannot use it: they act as the App, which is not an organization admin, and the client-side rules in 2.1 stop accidental use of your login in their calls.
- The merge queue cannot be combined with wildcard branch patterns; `~DEFAULT_BRANCH` is fine.
- Projects bootstrapped from releases after `v0.5.0` get the `code_scanning` rule in `rulesets/main.json` from the template; earlier ones add it through setup task 05. Pass 2 puts it into the live ruleset and adds `{ "type": "code_scanning", "parameters": { "code_scanning_tools": [ { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" } ] } }` (all three fields required). It works with the merge queue: no CodeQL analysis is produced for the queue ref, and the PR analysis satisfies the rule (V10). Before pass 2 (the live `main` ruleset has no `code_scanning` rule) and while CodeQL default setup is not `configured`, `apply-settings` sends `main` without a `code_scanning` rule present in `rulesets/main.json`, and `check` reports that rule `deferred`, not `differ`. Once the live rule exists, pass 2 has run and `check` fails closed: the rule, the default setup and `DEPLOY_ENABLED` are compared normally (10).
- Rulesets are applied idempotently: look up by `name`, then `PUT /repos/{o}/{r}/rulesets/{id}` or `POST`. The files hold no `id`.

### 9.2 `release-tag-creation`

```json
{
  "name": "release-tag-creation",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [
    { "actor_type": "Integration", "actor_id": "{{app-id:release}}", "bypass_mode": "always" }
  ],
  "rules": [ { "type": "creation" } ]
}
```

`actor_id` is the integer App ID from `GET /apps/{slug}`. The file stores the placeholder `{{app-id:release}}` (syntax in 13.1, `settings.mjs`), where `release` is the key in `config.json` `apps`; `apply-settings` resolves the slug to the number before sending. `pull_request` bypass mode does not exist for tag rulesets.

### 9.3 `release-tag-immutability`

Target `tag`, include `refs/tags/v*`, rules `deletion`, `update`, `non_fast_forward`, `bypass_actors: []`. The `update` rule is sent without `parameters` (`update_allows_fetch_and_merge` concerns fork branches); the API accepts that (V11).
Consequence: a bad release tag cannot be moved or deleted by anyone, including you, without disabling this ruleset in the browser (tier 3). Fix forward with a new patch release.

### 9.4 CODEOWNERS (protected paths, owner `@wianvdm`)

```
/.github/                       @wianvdm
/scripts/verify*                @wianvdm
/scripts/ci/                    @wianvdm
/scripts/lib/                   @wianvdm
/scripts/groundwork/            @wianvdm
/scripts/owner/                 @wianvdm
/admin-ops/                     @wianvdm
/AGENTS.md                      @wianvdm
/CLAUDE.md                      @wianvdm
/.claude/                       @wianvdm
/.gitleaks.toml                 @wianvdm
/.gitleaksignore                @wianvdm
/osv-scanner.toml               @wianvdm
/zizmor.yml                     @wianvdm
/release-please-config.json     @wianvdm
/.release-please-manifest.json  @wianvdm
/version.txt                    @wianvdm
```
`inbox` matches protected-path PRs against the working copy of `.github/CODEOWNERS`, while GitHub reads it from the base branch; a PR that edits CODEOWNERS is listed by the old rules until it merges. Projects append their test, lint and coverage config paths. The four scanner configs are protected because the scanners read them from the PR checkout, so an unprotected edit could silence a finding.
Release PRs touch the manifest and `version.txt`, so they need your approval; you merge them anyway (section 11). `scripts/groundwork/` is protected because `admin-run` executes it (bootstrap, check, app-token) with the admin App token; unprotected, a merged agent PR would run with admin rights at your next approval. `scripts/owner/` is protected because you run the owner wizard under your own login (14.3). `scripts/agent/`, `scripts/admin/` and `kit-update.mjs` are deliberately unprotected: they run with the agent's own credentials and gate nothing. `scripts/deploy`, `scripts/smoke` and `scripts/rollback` run with `production` secrets, but only after your approval of each deploy.

### 9.5 `issue-branches`

```json
{
  "name": "issue-branches",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/issue/*"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [ { "type": "non_fast_forward" } ]
}
```

Server-side backing for D17: nobody, including you, can force-push or otherwise rewrite an `issue/*` branch. Fast-forward pushes, merges from `main` and deletion stay allowed, so `delete_branch_on_merge` and orphan cleanup keep working (V16). No merge queue rule here, so the wildcard is allowed.

---

## 10. Repository settings (`settings.json`)

`settings.json` has one top-level key per endpoint group; `apply-settings` maps each onto these endpoints (all need repository Administration write unless noted). Body values are stored in the API's own field names so they are sent as written.

- `repository` → `PATCH /repos/{o}/{r}`: visibility public; `has_issues` on; `has_projects`, `has_wiki`, `has_discussions` off; `allow_squash_merge` on, `allow_merge_commit` and `allow_rebase_merge` off; `squash_merge_commit_title: PR_TITLE`, `squash_merge_commit_message: BLANK`; `allow_auto_merge`, `delete_branch_on_merge`, `allow_update_branch` on; `security_and_analysis` with `secret_scanning` and `secret_scanning_push_protection` `enabled`. `controlRepository` holds `is_template: true`, sent and compared on `groundwork` only. Nothing reads the flag (`bootstrap` reads the release tree), so `docs/setup.md` skips the manual "Template repository" setting.
- `teamAccess` → one `{ team, permission }` entry per team granted access, applied through the team-repo endpoint (2.4). It is `[]` now (2.5); an empty or absent key loads and compares cleanly, and `check` ignores live teams not listed.
- `security` → `PUT /private-vulnerability-reporting`, `PUT /vulnerability-alerts`, `PUT /automated-security-fixes`; `PATCH /code-scanning/default-setup` with `state: configured` in pass 2 only: `apply-settings` never sends it. Before pass 2 `check` reports a live state other than `configured` as `deferred`; after pass 2 (live `main` ruleset has the `code_scanning` rule) it is a mismatch, fixed by re-running `bootstrap-pass2`.
- `actions` → `PUT /actions/permissions` (`enabled: true`, `allowed_actions: all`, `sha_pinning_required: true`); `PUT /actions/permissions/workflow` (`default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`); `PUT /actions/permissions/fork-pr-contributor-approval` (`approval_policy: all_external_contributors`). All three verified (V12).
- `variables` → repository variables (Variables write). Each carries `assertWhen`, a signal read from the live repo (`settings.readSignals`, 13.1); `apply-settings` and `check` assert the variable only while its signal holds, otherwise `apply-settings` leaves it alone and `check` reports it `deferred`. `kitInstalled`: the repo contains `.github/groundwork/kit-version.txt` on its default branch, or is the control repo; it gates `GROUNDWORK_READY`, first set at the end of bootstrap pass 1 (14.2) and on `groundwork` by its first `apply-settings` (14.1). `deployReady`: `config.json` `deploy` is not `none` (`groundwork` declares `"deploy": "none"`, so `DEPLOY_ENABLED` is `deferred` here and the `settings-plan` summary shows no expectation for it), and CodeQL default setup is `configured` or pass 2 has run (live `main` ruleset has the `code_scanning` rule); it gates `DEPLOY_ENABLED`, first set by `bootstrap-pass2`. After pass 2, `DEPLOY_ENABLED` unset while `deploy` is not `none` is therefore a mismatch, never `deferred`.
- `environments` → 10.1.

`apply-settings` is idempotent, applies rulesets last, and stops at the first failed call with the list of what was and was not applied; re-running is the recovery path.

### 10.1 Environments

| Environment | Repos | Reviewers | `prevent_self_review` | `can_admins_bypass` | Deployment refs | Secrets and variables |
|---|---|---|---|---|---|---|
| `release` | all | none | false | true (API default) | branch `main` | secret `RELEASE_APP_KEY`; var `RELEASE_APP_CLIENT_ID` (App ID or client ID) |
| `production` | projects | `wianvdm` | false | false | tag `v*` | project deploy secrets (none with `"deploy": "none"`) |
| `admin` | `groundwork` only | `wianvdm` | false | false | branch `main` | secrets `ADMIN_APP_KEY`, `RELEASE_APP_KEY`; vars `ADMIN_APP_CLIENT_ID`, `RELEASE_APP_CLIENT_ID` |

- `PUT /repos/{o}/{r}/environments/{name}` body: `reviewers: [{ "type": "User", "id": <numeric user id> }]` (resolved from the login with `GET /users/{login}` at apply time), `prevent_self_review`, `can_admins_bypass`, `deployment_branch_policy: { "protected_branches": false, "custom_branch_policies": true }` (the two booleans must differ). `protected_branches: true` is not used: `main` is protected by a ruleset, not by classic branch protection.
- Then one `POST /repos/{o}/{r}/environments/{name}/deployment-branch-policies` per ref: `{ "name": "main", "type": "branch" }` or `{ "name": "v*", "type": "tag" }`.
- Environment secrets are written on the runner with `gh secret set --env <name> --repo <o>/<r>` (it does the sealed-box encryption that dependency-free Node cannot); the value is piped on stdin, never passed as an argument. Environment variables with `gh variable set --env`. Both need Environments write: the environment secret and variable endpoints sit under Environments in the GitHub App permissions reference, while Secrets and Variables cover repository-level ones.
- The release App key reaches each project's `release` environment by this route during bootstrap, copied from the `admin` environment.
- Self-review is irrelevant in practice: runs are triggered by the agent App or the release App, never by you.

PR runs (`refs/pull/*`) and runs on any branch other than `main` match no environment policy, so workflow changes outside `main` cannot read any secret. `workflow_dispatch` of a workflow file from another branch is blocked the same way.

### 10.2 Dependabot (`dependabot.yml`)

Ecosystems: `github-actions` always; the project's package ecosystems added by the setup epic. Weekly, cooldown 7 days, minor and patch grouped, labels `dependencies`, commit prefix `build`. Majors open as separate PRs that need a Chore issue (8.3).
Nobody owns Dependabot PRs by claim: `review-queue` lists them, and the reviewer session enqueues the ones whose checks are green (plus your approval when they touch `.github/`).

---

## 11. Releases and versioning

- release-please in manifest mode. `release-please-config.json`:
  ```json
  {
    "release-type": "simple",
    "include-component-in-tag": false,
    "bump-minor-pre-major": true,
    "initial-version": "0.1.0",
    "extra-label": "automated",
    "packages": { ".": {} }
  }
  ```
  Projects may switch `release-type`. `bump-patch-for-minor-pre-major` stays unset.
- `simple` updates `CHANGELOG.md` (created if missing) and `version.txt` (must exist). Bootstrap resets a project to manifest `{}`, `version.txt` `0.0.0` and an empty changelog, so the first release is `0.1.0`.
- `bump-minor-pre-major: true`: breaking changes bump minor while below 1.0. `feat` bumps minor, `fix` bumps patch.
- `1.0.0` only through `"release-as": "1.0.0"` on the package in `release-please-config.json` (protected path, you approve). The option is marked deprecated upstream in favour of a `Release-As:` commit footer, which blank squash bodies (section 7) rule out, so the config key is the route. Remove it in the PR after the release, or every later release repeats the version.
- Release PRs are opened by `wimdotgg-release[bot]`, pass through the same required checks and the merge queue, and carry `autorelease: pending` and `automated`.
- You merge release PRs. Merge cadence of agents never decides release cadence.
- Trigger: `release-please.yml` runs on `pull_request: closed` (base `main`) and `workflow_dispatch`. It has no `push` trigger (owner decision, #242). A merged close dispatches the workflow on `main`; the dispatched run builds the release (owner decision, #247). Push was dropped for two reasons: the queue pushes the squash commit to `main` before GitHub marks the PR merged, so the push run starts while the PR still reads open: on `gw-acceptance` run 45036123914 was created at 15:03:03Z and its release-please step started at 15:03:16Z, the PR merged at 15:03:23Z, so the run built no tag or release, failed with 422 "state cannot be changed" updating the merged PR and opened a stray release PR (`docs/runs/postv1-release-race-fix.md`). And an Actions `push` payload lists no added, removed or modified files, so no push guard can tell a release commit from any other (a first version keyed on the manifest never matches).
  - Dispatch: job `dispatch-on-main` has no environment, `permissions: actions: write` and an `if` on a merged close from this repository, any head branch; unmerged and fork closes skip. Its one step runs `gh workflow run release-please.yml --ref main` with `GH_TOKEN` set to `github.token`; a `workflow_dispatch` sent with `GITHUB_TOKEN` starts a run (`repository_dispatch` does too; most other events do not). The repository comes from `GH_REPO`, so no event value reaches the script. Job `release-please` runs only on `workflow_dispatch` (and `GROUNDWORK_READY`), so the notifier never enters the environment.
  - Environment: a merged close runs on `refs/pull/N/merge` with the PR side's workflow file, not on `refs/heads/main`. The `release` environment (deployment refs `main`) refuses that ref before any step, as run 45059252257 showed (#247). A dispatch on `main` has `GITHUB_REF` `refs/heads/main`, which the environment admits; a dispatch on any other ref is refused.
  - Concurrency: the `release-please` group sits on the release job, not the workflow, with `cancel-in-progress: false`. A running run is never cancelled; a pending run can be replaced by a later pending run, which also sees the merge. Each closed run's own dispatch queues a real run last, so nothing is lost even if a replaced run was pending.
  - Consequences: a merged fork PR runs nothing and waits for the next same-repository merge or a dispatch. The bootstrap commit is a push and starts no run; setup step 7 dispatches the workflow once (14.2). The read-only token for Dependabot is keyed on the actor (`github.actor == 'dependabot[bot]'`), and a merged close is sent by the merger (run 45059252257: `wimdotgg-agent[bot]`), so the dispatch is expected to work for a Dependabot PR; unobserved until the first Dependabot merge (#243).
  - Known limit: `failure-alert` closes an open alert on any `success` of the workflow, and a closed run now succeeds with only the notifier. A release job that keeps failing has its alert closed by the next merge's closed run and reopened as a new issue by the next failed dispatch. `failure-alert.mjs` is unchanged here; a follow-up issue tracks it.
  - Known limit: a stray release PR stays wrong when no releasable commit follows. On `gw-acceptance`, PR 29 stayed untouched after the owner's rerun built the release.
  - Recovery after a failed or replaced run: `workflow_dispatch`. A PR whose merge ref predates #247 runs the old workflow file once on its close and fails the environment check; dispatch by hand.
  - Unproven until the closed run of #247's own merge: that the closed run's `GITHUB_TOKEN` gets `actions: write`.
  - `release-please-action` reads the default branch, not the event ref, so the dispatched run needs no `target-branch`.
- `groundwork` versions itself the same way; its tags are what projects pin.

---

## 12. Admin elevation

| Tier | Scope | Mechanism | Your action |
|---|---|---|---|
| 0 | Normal work | Agent App (`token.mjs exec`) | none |
| 1 | Settings as code: `settings.json`, `labels.json`, `rulesets/*.json` | Agent opens a PR; the `settings-plan` job writes a plan to its job summary (desired vs. live where readable, otherwise file diff); after merge the agent runs `scripts/admin/request.mjs apply-settings --repo <r> --ref <sha>`; the run ends with `check` | CODEOWNERS approval on the PR, then approve the `admin` run |
| 2 | One-off admin work: bootstrap, new repo, issue types, cleanup | `scripts/admin/request.mjs <op>` dispatches `admin-run` in `groundwork` | Read the run summary, approve the `admin` environment |
| 3 | Owner-only: create Apps, billing, org ownership, secret values, agent App key rotation | You, in the browser. During org setup, secret values may instead go through the owner wizard (14.3), which you run in your own terminal; billing, org ownership, deletions, key rotation and `admin` approvals stay in the browser | everything |

### 12.1 `admin-run.yml`

The workflow is always dispatched on `main` of `groundwork` (`request.mjs` sends `ref: main`). The `admin` environment only admits `main`, so a dispatch from any other branch, including one carrying a modified `admin-run.yml`, stops at the environment and never reaches a secret. The built-in op code and `admin-run.yml` therefore always come from reviewed `main`.

Inputs (all strings; passed to steps through `env`):

| Input | Meaning |
|---|---|
| `op` | choice, one of the ops below |
| `target_repo` | repository name without owner, `^[A-Za-z0-9._-]+$`; empty for `create-issue-types` and `selftest`. The owner is always this org. |
| `ref` | 40-character commit SHA. `apply-settings`: a commit in `target_repo` that is `main` or an ancestor of it; the settings files are read at that commit. `script`: the current `main` head of `groundwork`, so a later fix or deletion of a script never leaves an older revision runnable. Empty for other ops. `plan` verifies it with the compare API (ancestry for `apply-settings`, an identical head for `script`) and fails otherwise. This input is data, not the workflow's run ref. |
| `script_path` | `op=script`: required, `^admin-ops/[A-Za-z0-9._-]+\.mjs$` (flat, no traversal), a file in `groundwork` at `ref`. Empty for every other op. |
| `args` | JSON object, validated per op against a fixed schema; unknown keys fail. `bootstrap`: `{"description": string, "adopt"?: true}`, `description` required, 1 to 350 printable ASCII characters; `adopt` is optional and only `true` is valid (14.4). `script`: any JSON object of at most 2000 characters, which the script validates itself; `plan` prints it. Every other op, `bootstrap-pass2` and `selftest` included: `{}` |

`admin-run.yml` carries `run-name: admin-run ${{ inputs.op }} ${{ inputs.target_repo }} ref=${{ inputs.ref }} script=${{ inputs.script_path }} args=${{ inputs.args }}` (Phase 4 task #143; `script=` added in Phase 4c), so the owner delegation (21) reads op, target, ref, script path and args from the run name. The format is exactly `admin-run <op> <target_repo> ref=<ref> script=<script_path> args=<args JSON>`: single spaces, an empty value leaves its separator (`admin-run create-issue-types  ref= script= args={}`, two spaces after the op). Every fixed-charset field comes before the one free-form field, `args`, which runs to the end of the title: parse left to right with `\S*` for op, target, ref and path, then `args=(.*)$`, because `args` may itself contain ` script=`. That script approves only `args={}` or `{"description":"[A-Za-z0-9 .,_-]{0,100}"}`; live `gw-p4-*` runs use that narrower description, the schema above stays wider.

Jobs:
1. `plan` (no environment, no secrets, `contents: read`): validates inputs; for `op=script` verifies `ref` is the `main` head of `groundwork`, fetches the file at `ref` with the job's `github.token`, prints it, its SHA-256 and its `permissions` to the run summary and refuses a file `parseScript` rejects (12.1 script op); for built-in ops prints the operation, target, args and requested token permissions; for `op=bootstrap` with `adopt: true` it also prints the 14.4 preflight rows from the `bootstrap` module's `plan` hook. Each `plan` fact renders as one inert code span. Job output `script_sha256` (step id `plan`, written to `$GITHUB_OUTPUT`; empty for other ops).
2. `apply` (environment `admin`, needs `plan`): mints a `wimdotgg-admin` token scoped to the op's repositories and permissions (2.4); for `op=script` re-fetches the blob at `ref`, verifies its SHA-256 equals `env.PLAN_SCRIPT_SHA256` (the `plan` job output): an empty value refuses before any mint, a different hash before the target mint, then runs it; writes a summary of every API call made (method, path, status; never bodies that may hold secrets). The summary also goes to stdout inside `::group::admin-run summary`, because the step summary is not readable through the API. `apply-settings` also writes the release secret and variable with `gh secret set` and `gh variable set`; each is a row with `method: gh`, the argument list as `path` and the exit code as `status`, or `null` when `gh` could not start (values never appear). Any failed call fails the job; ops are idempotent, so the fix is to re-run. `bootstrap`, `bootstrap-pass2` and `apply-settings` end the same job with the read-only `check` against the target, so one approval covers the change and its verification; a failed row fails the run.

| Op | Token repositories | Token permissions | Does |
|---|---|---|---|
| `bootstrap` | none up front (`TOKEN_SCOPE` `deferred`); the three grants above | `CONTROL_READ_PERMISSIONS`: Contents read. `CREATE_PERMISSIONS`: Administration write. `PERMISSIONS` after creation: Administration, Contents, Workflows, Environments, Variables, Issues write; Members, Actions read | 14.2 pass 1, then `check` |
| `bootstrap-pass2` | `target_repo` | Administration, Variables write; Contents, Environments, Actions, Issues, Members read | 14.2 step 4, then `check`. May target the control repository (`target_repo` equal to `controlRepo`, any case): it only configures an existing repository, and the token stays restricted to that one repository. Refuses on a stub `scripts/verify` before any write |
| `apply-settings` | `target_repo` | Administration, Environments, Variables, Issues write; Contents, Members, Actions read | Syncs `settings.json`, `labels.json`, environments and rulesets from `ref`, then `check`. On every target, `groundwork` included, it writes the `release` environment secret `RELEASE_APP_KEY` and variable `RELEASE_APP_CLIENT_ID`, and deletes live repository-level rulesets the settings do not declare. Refuses before any write when no `main` ruleset is desired, or when the desired `main` lacks `code_scanning` while pass 2 has run or its state is unreadable. |
| `check` | `target_repo` | Administration write (it reads the same live state `apply-settings` writes; ruleset bypass actors and merge fields are readable only with write, V20), Contents, Environments, Variables, Actions, Issues read, Members read | Comparison with no writes (section 13); stays a standalone op for drift checks |
| `create-issue-types` | none (org) | Issue types write | Creates the five types, renames case variants, deletes only GitHub default types (Task); other types outside the five are left alone and fail the run for the owner to review; idempotent. Permission key `issue_types` (V7: the GitHub API names it in the `X-Accepted-GitHub-Permissions` header; accepted in the mint body by the live `create-issue-types` runs) |
| `script` | none up front (`TOKEN_SCOPE` `deferred`): `[controlRepo]` with `CONTROL_READ_PERMISSIONS` to read the file, then `[target_repo]` | the script's `permissions`, exactly | Runs `admin-ops/<name>.mjs` at `ref` (contract below) |
| `selftest` | none up front (`deferred`): the three `bootstrap` grants, the third on `selftest-<run id>` | as `bootstrap` | Bootstraps `selftest-<run id>`, runs `check` and the probes below, archives the repo. Deleting it is tier 3. |

Ops available now: `apply-settings`, `check`, `create-issue-types`, `bootstrap`, `bootstrap-pass2`, `script` and `selftest` (the last two ran live, 21 and `docs/runs/2026-11-21-phase4c-admin-runs.md`). Only `bootstrap` refuses `target_repo` equal to the control repository (it creates the target, so it would overwrite `groundwork`); every other op may target it. `bootstrap-pass2` may because it configures a repository that already exists, so `groundwork` itself can pass pass 2 (21, Phase 4b integration). `request.mjs` dispatches `bootstrap` (needs `--repo`, takes `--args`), `bootstrap-pass2` (needs `--repo`, takes no `--args`; neither takes `--ref`), `script` (`--repo`, `--script`, optional `--ref` and `--args`) and `selftest` (no `--repo`, `--ref`, `--script` or `--args`). `ctx` carries no `args`: `bootstrap` reads the description from `env.INPUT_ARGS`, which `validateArgs` has already checked.

Token scopes (`TOKEN_SCOPE`): `target` (token restricted to `target_repo`), `org` (all repositories, no target) and `deferred` (no token up front; the target may not exist). A `deferred` op gets `ctx.client` and `ctx.token` as `null` and mints through `ctx.withToken({ repositories, permissions }, callback)`:
- `repositories`: `string[]`; `permissions`: snake_case keys as above.
- `admin-run` refuses, before minting, any request that is not one of the op's declared grants: (1) `[target_repo]` with a subset of `PERMISSIONS` (same or lower level); (2) `[controlRepo]` with exactly `CONTROL_READ_PERMISSIONS` (`{ contents: 'read' }`), used for every read of `groundwork` and for the existence check of the target, which is public data; (3) `[controlRepo]` with exactly `CREATE_PERMISSIONS`. `plan` prints `PERMISSIONS`, `CREATE_PERMISSIONS` and `CONTROL_READ_PERMISSIONS`, so the owner approves what can be minted.
- `admin-run` signs a fresh JWT per `withToken` call (a JWT lasts minutes, pass 1 plus `check` can outlive one), mints through `mintInstallationToken` (granted scope must equal requested), masks the token, awaits `callback({ client, token })` with a client that records every call into the summary table, and revokes the token in a `finally` with `DELETE /installation/token`. A failed revoke fails the run. `ctx.env` never carries `ADMIN_APP_KEY` or a JWT.
- Resolves to the callback's value; a callback error is rethrown after the revoke. Calls do not nest.
- `ctx.writeSettings(files: Record<string, string>) -> Promise<{ settingsRoot: string, config: object }>`: writes the given `.github/groundwork/` files into the run's temp directory (removed after the run) and loads `config` from them. `bootstrap` is the only user (14.2 step 6).

`check` after a `deferred` op: `admin-run` calls `withToken({ repositories: [target_repo], permissions: check.PERMISSIONS })` itself, reads settings from the target's `main` head as the standalone `check` does, and runs `check`. `OP_THEN_CHECK` covers `apply-settings`, `bootstrap` and `bootstrap-pass2`. A `deferred` op's `ctx.settingsRoot` and `ctx.config` are groundwork's own (as for `org` ops); `bootstrap` has one settings source: the built tree's `.github/groundwork/` files (13.1 `settingsFiles`), materialised by `ctx.writeSettings`; they equal what the bootstrap commit puts on `main`, because `bootstrap-tree` is built from one tag: the latest release, or on an `ours` resume the tag in the target's `kit-version.txt` (14.2 step 2). `bootstrap-pass2` and `check` read settings from the target's `main` head; only `apply-settings` reads at `ref`.


Access-token request keys are the snake_case names GitHub reports in `X-Accepted-GitHub-Permissions` (repository Variables is `actions_variables`; Issue types is `issue_types`).
Labels are written through the Issues permission. The permission keys for the token request body come from the GitHub App permissions reference (V7 covers the Issue types key).

Concurrency group `admin-${{ inputs.target_repo || 'org' }}`, never cancelled.

`script` op contract (modules `script.mjs`, 13.1):

- Inputs: `target_repo` (required, may be the control repository), `ref` (required: the `main` head of `groundwork` at `plan` time; a delegated approval needs exactly this, 21), `script_path` (required), `args`.
- `admin-ops/*.mjs` scripts are self-contained and export `const permissions = { ... };` and `async function run({ github, org, repo, args, log })`; they never read environment variables. The `permissions` statement is one `export const permissions = {...};` whose object is strict JSON (double-quoted `snake_case` keys, values `read` or `write`, at least one key, no nested braces). `parseScript(source) -> { permissions } | { problem }` reads it from the text and never executes the file; it refuses a file with none or more than one such statement, any other shape, and any match of `\bimport\b`, `\brequire\s*\(`, `\bgetBuiltinModule\b`, `\beval\s*\(`, `\bFunction\s*\(`, `.constructor(` or `process.binding`, comments included (the scan does not strip them, so a token in a comment is refused too). The check stops a plain import from slipping past the hash; deliberate evasion (a split string, constructor access without a call form) is visible in the printed file and falls to the owner review below. `plan` fails on a refusal. The mint uses the parsed object, not a runtime export, so what `plan` printed is what is minted.
- `plan`: prints the file, its SHA-256 (lowercase hex of the blob bytes), the parsed `permissions`, the target and the args; no secret is held.
- `apply`: re-fetches the file at `ref` with the `[controlRepo]` `CONTROL_READ_PERMISSIONS` grant, refuses on a SHA-256 different from `PLAN_SCRIPT_SHA256`, then mints exactly one token `{ repositories: [target_repo], permissions }`; `admin-run` refuses a target grant that is not exactly the parsed `permissions`. `repo` is `target_repo`; `log(line)` adds a log line; `github` is a `lib/github.mjs` client on that token. Isolation: the script runs in a child `node` process (`process.execPath`) started with `--permission --allow-fs-read=scripts/` and an environment allowlist of `SystemRoot` only, holding no key, no `INPUT_*` and no token (the test asserts the child sees none of `ADMIN_APP_KEY`, `RELEASE_APP_KEY`, `INPUT_*`, `GITHUB_*`); the target token, `org`, `repo` and `args` arrive as one JSON object on stdin, and call records, log lines and the result return as JSON lines on stdout. For this op the call table is therefore what the script reported, not what `admin-run` observed, and a stdout line that is not a protocol line fails the run, so a stray `console.log` cannot pass as a record. The token is revoked afterwards. `run` returns `{ ok, summary }`; a throw fails the run. A module may export `plan` (it returns a `problem`, or `facts`, `source` and `scriptPermissions`, and its `outputs` go to `GITHUB_OUTPUT`). The run summary shows the script result as one inert code-span line. The residual bound is owner review: `--permission` leaves network and signals open, a same-user child can still read the parent's process environment, so what keeps a script honest is the CODEOWNERS review of `/admin-ops/` and the printed file.
- Tests: `admin-ops/` holds no tests, because the `scripts` job runs `node --test "scripts/**/*.test.mjs"`. Tests for the shipped example live in `scripts/groundwork/script.test.mjs`; each later file adds its own to `scripts/groundwork/admin-ops.test.mjs`. `admin-ops/` is `[control]` (`CONTROL_PATHS`), so projects never receive it.

`selftest` op contract (modules `selftest.mjs`, `selftest-probes.mjs`, 13.1):

- Inputs: none (`target_repo`, `ref`, `script_path` empty, `args` `{}`). The target is `selftest-<GITHUB_RUN_ID>` (`SELFTEST_REPO_PREFIX` plus the run id, read from `ctx.env`); `ctx.repo` is that name. A rerun of the same run fails because that repository exists and is archived; dispatch a new run.
- Grants (the shape for both ops): a module of a `deferred` op exports `grants({ env, targetRepo, controlRepo, scriptPermissions }) -> Array<{ repositories: string[], permissions: object, match: 'exact'|'subset' }>`, the list of requests `withToken` may mint. `admin-run` uses it in `grantProblem` (a request must equal an `exact` entry or be a non-empty subset of a `subset` entry on the same repositories) and in `renderRequestedPermissions`, and, when the module exports an optional `targetRepo(env) -> string`, uses that name for `ctx.repo`, for `grants` and for the target `plan` prints (no op special case). A module with no `grants` export keeps today's three constants (`CONTROL_READ_PERMISSIONS`, `CREATE_PERMISSIONS`, `PERMISSIONS`), so `bootstrap.mjs` is untouched. The first task to need the seam (`script`, #195) adds both to `admin-run`; `selftest` (#197) only adds its own exports. `selftest` returns `[controlRepo]` with `CONTROL_READ_PERMISSIONS` (`exact`), `[controlRepo]` with `CREATE_PERMISSIONS` (`exact`) and `[selftest-<run id>]` with `PERMISSIONS` (`subset`); the `check` grant (`check.PERMISSIONS`) and the archive call are subsets of that third entry on the same repository. `selftest` exports `targetRepo(env)`, which builds `selftest-<GITHUB_RUN_ID>` (digits only, else it throws); `grants()` derives the name from `env` through it and ignores its `targetRepo` argument, and `plan` and `apply` report a non-digit `GITHUB_RUN_ID` as a failure. `script` returns `[controlRepo]` with `CONTROL_READ_PERMISSIONS` (`exact`) and `[target_repo]` with `scriptPermissions` (`exact`; `scriptPermissions` is the parsed `permissions`, and the entry is omitted while it is undefined). No grant names any other repository.
- Steps: the op first inspects the repository with the control read; a foreign or unreadable one is refused with failed `bootstrap` and `archive` rows and no `PATCH`, so a repository the run did not create is never archived. (1) `bootstrap.run` with `ctx.repo` set to the name and `ctx.env.INPUT_ARGS` set to `{"description":"groundwork selftest <run id>"}` (`bootstrap` reads its description from there, 12.1, and `INPUT_ARGS` is `{}` for `selftest`) (pass 1 from the latest release, 14.2), (2) `check` through `ctx.runCheck` (`withToken` on the repository with `check.PERMISSIONS`, reading its `main` head; a failed `bootstrap` skips `check` and the probes with one failed row each, and `archive` still runs) (selftest is not in `OP_THEN_CHECK`, because the archive must follow), (3) `runProbes`, (4) archive: `PATCH /repos/{org}/{repo}` with `{ archived: true }` on the third grant, always run once the repository exists, even after a failed step. The run fails when any step fails, a failed archive included. The summary is one table with a row for `bootstrap`, `check`, each probe and `archive`.
- Probes (`runProbes({ client, org, repo, log })`, `client` on the `PERMISSIONS` token, calls only under `/repos/{org}/{repo}`; each probe is idempotent against a fresh repository): `V3` `POST /git/refs` for `refs/heads/selftest-v3` returns 201 and a second one 422, then deletes the ref; `V11` reads `GET /rulesets`, then `GET /rulesets/{id}`, and the live `release-tag-immutability` ruleset holds an `update` rule; `V16` creates one child commit, then on `refs/heads/issue/1` a fast-forward update succeeds, a forced non-fast-forward update is rejected (422 or 409) and a delete succeeds; `push-main` the section 13 push probe against `main` (a dangling empty commit, `PATCH` without `force`, rejected with 422 or 409; it re-reads `main` and reports inconclusive when `main` moved, and a failed probe leaves its dangling commit on the throwaway repository). `PROBE_IDS` is `['V3', 'V11', 'V16', 'push-main']`; a row is `{ id, name, ok, detail }`; `runProbes` returns one row per id in that order and turns a thrown error into `ok: false` with the message as `detail`.
- Probes not listed are not run: V1, V12, V20 and V21 are covered by the `check` row, V2, V4 and V17 need pull requests, V10 needs pass 2.

---

## 13. Scripts

Node 24+, ESM, no npm dependencies. They call GitHub through `gh api` (agent machine, with the `GH_TOKEN` that `token.mjs exec` sets) or `fetch` with the token from `env` (CI and `admin-run`); `scripts/lib/github.mjs` hides the difference. The one exception is `gh secret set` / `gh variable set` in `admin-run` (10.1). Every script exits non-zero with a one-line reason on failure and supports `--json`. Run as `node scripts/agent/<name>.mjs`; Windows works under PowerShell and Git Bash.

| Script | Inputs | Output and effects |
|---|---|---|
| `agent/token.mjs` | `exec -- <command>` or `credential <get\|store\|erase>` | Mints an installation token for `apps.agent` (2.2), runs the command with it as `GH_TOKEN` plus the bot commit identity and a git credential helper; `credential` is that helper. Every agent write goes through it. |
| `agent/next.mjs` | `--json` | Next eligible task or takeover candidate, or "nothing ready" with reasons per skipped candidate. Exit 0 whenever it answers, including "nothing ready"; 1 error |
| `agent/claim.mjs` | `N`, `--session <id>`, `--agent <model>/<harness>`, `--json` | Claim per 6.3, or takeover per 6.4 when `issue/N` exists and is a takeover candidate. Exit 0 claimed (a rerun by the same session completes missing steps), 3 held by someone else, not claimable, Definition of Ready unmet (fresh claim only), or a rival takeover younger than `claimWithoutPrMinutes` holds the PR (6.4), 1 error or `tasksPerWorker` refusal. Reads the repository from `GITHUB_REPOSITORY`, else `gh repo view` |
| `agent/checkpoint.mjs` | `--session <id>`, `--input <path>`, `--auto` (hook mode: no-op unless on `issue/N` with a draft PR; pushes even without an input file), `--json` | Push, rewrite `## State`, journal comment. Exit 0 done or `--auto` no-op, 1 refused or error, 3 footer names another session. A footer-less PR exits 1; a non-auto run on a ready PR is allowed. `--auto` without a session id from flag, env or hook stdin `session_id` is a no-op (exit 0) |
| `agent/resume.mjs` | `N`, `--session <id>` (optional), `--json` | Bounded briefing (6.5), no writes. Exit 0, 3 the PR footer names another session, 1 error or, with `--session`, a PR without a footer. Re-reads the PR body, because `loadIssueFacts` exposes none |
| `agent/release.mjs` | `N`, `--decision` or `--merged`, `--session <id>`, `--json` | Releases claim or posts handover; a rerun changes nothing. Exit 0, 1 refused (`--merged` on an unmerged PR, `--decision` on a closed PR, or neither or both modes) or error, 3 `--decision` and the footer names another session |
| `agent/resolve-thread.mjs` | PR number, thread node id or `--list`, `--session <id>` (or `GROUNDWORK_SESSION`), `--json` | Resolves one review thread (6.1) with the `resolveReviewThread` mutation, or with `--list` prints the PR's unresolved threads as `<thread id> <path>:<line> <summary>` and writes nothing. The summary is the first comment's first line, capped at 120 characters, when its author is trusted for kind `comment` (6.7); otherwise `untrusted <login>`, text withheld (`resume` shows it fenced). Refuses before any write unless the PR is open, its head is `issue/N` in this repository, its footer names the calling session (the `resume` footer rule) and the thread belongs to it (first 100 threads). An already resolved thread exits 0 with no write. Exit 0, 3 the footer names another session, 1 refused or error |
| `agent/plan-lint.mjs` | epic number, `--post` or `--close` (not both), `--json` | Planning lint (6.2) or, with `--close`, the 4.5 epic close check. Read-only except `--post`, which creates or updates the one report comment, found by the hidden marker `<!-- groundwork:plan-lint -->`, from `templates/plan-comment.md` (keys `epic`, `result`, `width`, `lanes`, `failures`). `--close` posts nothing; its acceptance template `templates/acceptance-comment.md` has keys `criteria` and `gaps` and marker `acceptance`. `--json`: plan mode `{ ok, reason?, epic, tasks, width, failures[], posted }` (`tasks` counts leaf tasks; `width` is `null` on a dependency cycle; `posted` is `created`, `updated`, `unchanged` or `null`); `--close` `{ ok, reason?, epic, tasks, failures[] }` with no `width` or `posted` (`tasks` counts every sub-issue). Exit 0 clean; 1 on a lint failure (`--json` carries `failures`) and on an error (`{ ok: false, reason }`, no `failures`), so callers tell them apart by the `failures` key. |
| `agent/review-queue.mjs` | `--json` | Open ready PRs that need a review, and Dependabot PRs with green checks for the reviewer to enqueue. A PR is reviewed only when the agent account posted a review on its current head SHA whose first or last non-empty line is `Reviewer: <model>/<harness> · session <id>`; any push reopens it. `--json`: `{ ok, review[], dependabot[] }`. Exit 0 whenever it answers, 1 error. It does not exclude the caller's own session (the reviewer drops entries whose PR footer names its own); PRs without an agent footer (owner, release-please) are always listed. A Dependabot entry is minor or patch only; entries touching `.github/` carry no owner-approval note. Only the agent account's reviews count, so a separate reviewer App (`apps.reviewer`) needs a `review-queue` change first. |
| `human/inbox.mjs` | `--json` | Proposed epics, `needs-decision`, protected-path PRs awaiting you (those without the owner's approval on their head; drafts, release PRs and fork PRs are skipped; matched against the working copy of `.github/CODEOWNERS`), release PR, pending `production` and `admin` approvals, alert issues, orphaned claims, untrusted reports to triage (below). Run by an agent with the agent App token (reads only); it prints links you open in the browser. `--json`: `{ ok, empty, sections[{ key, heading, items[{ title, url, detail? }], unreadable? }] }`. A section the token cannot read (403 or 404) is `unreadable` and exits 0; any other error exits 1. Titles from untrusted authors are fenced. |
| `admin/request.mjs` | `op` (`apply-settings`, `check`, `create-issue-types`, `bootstrap`, `bootstrap-pass2`, `probe`, `script`, `selftest`), `--repo`, `--ref` (`apply-settings`: defaults to the target `main` head; `script`: defaults to the `groundwork` `main` head), `--script` (`script` only, required, `admin-ops/<name>.mjs`), `--args` (refused by `bootstrap-pass2`, `probe` and `selftest`) | Dispatches `admin-run` on `main` of `groundwork` (org and control repo name from `config.json`) with inputs `op`, `target_repo`, `ref`, `script_path`, `args` (`script_path` empty unless `script`); prints the run URL to approve. `script` needs `--repo` and `--script`; `selftest` takes no `--repo`, `--ref` or `--script`. `request.mjs probe --repo <r>` dispatches nothing: it runs the push probe below locally as the agent App through `token.mjs exec`, no approval. |
| `ci/*.mjs` | event payload path, env | CI validators (section 8); contracts in 13.1 |
| `lib/*.mjs` | | Shared modules; contracts in 13.1 |
| `kit-update.mjs` | `<tag>` (`vX.Y.Z`), `--json` | Run by an agent on the `issue/N` branch of a claimed Chore issue (`claim` opened the draft PR). Copies the kit paths (13.1) from that groundwork tag onto the branch, merges `config.json`, rewrites `kit-version.txt` and the reusable-workflow SHA pins (8.6), commits `chore(kit): update to <tag>` and pushes through `token.mjs exec`. Never touches `[project]` paths (except that it creates `.github/workflows/deploy.yml` when the project has none) or `config.json` values the project changed. Exit 0 updated or already on the tag, 1 refusal or error. `--json`: `{ ok, tag, changed[], skipped[] }` or `{ ok: false, reason }`. Refuses before any write: a tag that is not `vX.Y.Z`, does not exist in `<org>/<controlRepo>` (from the project's `config.json`) or is lower than `kit-version.txt`, a dirty working tree, and a branch other than `issue/N`. |
| `groundwork/bootstrap.mjs` | repo, pass | Section 14 |
| `groundwork/check.mjs` | repo | Pass/fail table of live vs. expected settings, rulesets, labels, environments (reviewers, `can_admins_bypass`, ref policies, secret and variable names), repository variables, team access, Actions settings. Pass-2 items are `deferred` before pass 2 and fail closed after it (10). Reads only; its token holds Administration write (12.1, V20). |
| `groundwork/selftest.mjs`, `groundwork/selftest-probes.mjs`, `groundwork/script.mjs` | | Admin ops `selftest` and `script` and the selftest probes (12.1, 13.1) |
| `groundwork/app-token.mjs` | client ID, key, repositories, permissions | Installation token (2.4) |
| `groundwork/apply-settings.mjs`, `groundwork/create-issue-types.mjs`, `groundwork/admin-run.mjs` | | Admin ops (12.1); `admin-run.mjs` is the dispatcher |

`inbox` section `untrusted-reports`, heading `Untrusted reports to triage`, the last section, after `orphaned-claims` (6.8):
- Includes an issue when it is open, is not a pull request, its author is not trusted for kind `issue` (`isTrustedAuthor`, 6.7), its author is not `github-actions[bot]` (alert issues have their own section), and it has no linked task.
- Linked task: report #N has one when an issue (not a pull request) in the same repository, open or closed, authored by a trusted account for kind `issue`, has a `Context` section with a line containing `Reported in #N` with no digit after `N`. The `Context` section is `## Context`, or `### Context` when the body has no `## Context` (web-form bodies, 4.3). The match is case-sensitive, and text inside HTML comments and code fences does not count (`parseSections` strips both). A mention elsewhere in the body, in a comment, or by an untrusted author does not link.
- Detection: `inbox` reads the report's timeline (`GET /repos/{owner}/{repo}/issues/{N}/timeline`), keeps `cross-referenced` events whose `source.issue` is an issue of this repository, and applies the rule above to each source issue's current body. GitHub records the event when the task body names `#N`.
- Item: the title fenced as for any untrusted author; `detail` is `opened <YYYY-MM-DD>` from `created_at`. The `--json` shape is unchanged.

Push probe (the agent identity is the one the rule must stop, so it runs on the agent machine through `token.mjs exec`, not in `admin-run`): create a dangling empty commit on top of `main` with `POST /git/commits`, then `PATCH /git/refs/heads/main` to it without `force`. Expected: rejected with a rule violation (422 or 409). An accepted update means protection is broken; `request.mjs` reports failure and leaves the empty commit `chore(check): probe` on `main` as evidence. Tag rules are checked by ruleset comparison only: a probe tag could never be deleted (9.3).

Agent script contract (`next`, `claim`, `checkpoint`, `resume`, `release` and `resolve-thread` above; 3a lanes build against this text):

- Session id: `--session <id>`, else env `GROUNDWORK_SESSION`, else exit 1 with `session id required`. `claim`, `checkpoint`, `release` and `resolve-thread` (`--list` included) need one; `resume` checks the PR footer only when one is given; `next` takes none. An id matches `[A-Za-z0-9._-]+` (`isValidSessionId`), because it sits in commit subjects, the State header and the PR footer. `claim` also needs the agent, `--agent <model>/<harness>` else env `GROUNDWORK_AGENT`, else exit 1; it must pass `isValidAgent` (exactly one `/` with a non-empty id-character segment on each side, so no `(`, `)` or `·`, which would break the State header). `checkpoint` reads the agent from the PR footer.
- Session id is the harness session id (Claude Code's `session_id`), used as `--session` and `GROUNDWORK_SESSION`. The `Stop` and `PreCompact` hooks learn the session only from env `GROUNDWORK_SESSION` or the `session_id` in their stdin JSON, and that id must equal the PR footer session, so a separately chosen id would never match. Subagents share their parent's session id and fire no Stop or PreCompact hooks (the hooks run in the parent session). Concurrent workers therefore run as separate top-level sessions, or with distinct explicit ids (`--session` or `GROUNDWORK_SESSION`); two workers on one id would pass each other's footer check, and `claim` would refuse the second one with exit 1 (`tasksPerWorker`, `findHeldDrafts`) because the first already holds a draft PR under that id.
- Node: every agent script imports `token.mjs`, which checks `process.versions.node`; a `node` below 24 makes each exit 1 with one stderr line (`import.meta.main` is undefined there, so without the check a script would do nothing and exit 0). Hooks and workers need Node 24 first on PATH.
- Exit codes: 0 success, 1 error or refusal, 3 held by another session. Exit 3 comes from `claim` (the ref or task is held, `issue/N` is not a takeover candidate, a fresh claim fails the Definition of Ready, or a rival takeover is inside its `claimWithoutPrMinutes` window, 6.4), `resume`, `checkpoint`, `release --decision` and `resolve-thread` (the PR footer names another session, so a revived worker stops before writing). Exit 1 also covers a `resume --session` or `checkpoint` on a PR without a footer (nothing to check the session against), `release --decision` on a closed PR, and a `node` below 24. Usage errors exit 1. A failure writes one line to stderr.
- One task per worker (`tasksPerWorker`): `claim` refuses a session that already holds a draft PR with exit 1, not 3, because 3 means "try the next candidate" and no candidate can succeed. A rerun by the same session on the issue it already holds is exempt.
- Authorship: a comment counts as ours only when it carries the marker and its author is the agent account (`sameLogin` with `config.accounts.agent`); a marker from anyone else is ignored by `claim`, `checkpoint`, `resume` and `release`.
- `--json`: one JSON object on stdout, always with `ok`. On a non-zero exit it is `{ "ok": false, "reason": "<one line>" }`, plus the fields the row names. Without `--json`, stdout is for humans and has no format guarantee.
- `next` success: `{ "ok": true, "next": { "kind": "takeover"|"fresh", "number": N, "pr": number|null, "epic": number|null, "title": "...", "reason": "..." }|null, "skipped": [{ "number": N, "code": "...", "reason": "..." }] }`. `next` is null for "nothing ready". `code` is a 4.4 status (`proposed`, `blocked`, `claimed`, `in-review`, `queued`, `needs-decision`, `orphaned`, `done`) or one of `needs-format`, `size` (missing or `size:L`), `untrusted-author`, `epic`, `hotspot`.
- `claim` success: `{ "ok": true, "number": N, "mode": "claim"|"takeover", "branch": "issue/N", "pr": number }`; exit 3 adds `number`.
- `checkpoint`: `--input <path>` (default `.artifacts/checkpoint.json`, git-ignored) holds `{ "fields": { "Done", "In progress", "Next", "Proven", "Unproven", "Rejected", "Gotchas", "Open" }, "journal": "<text>" }`, all eight fields non-empty. The script writes the header itself: next checkpoint number (`claim` writes the initial State as checkpoint 0), UTC `YYYY-MM-DD HH:MM`, the agent from the PR footer, the session. The header is filled from `state-section.md` and the journal from `checkpoint-comment.md` with `fillTemplate`. It refuses before any write when `unfilled` is not empty for the journal comment, when the rendered `## State` section (and only that section, so a journal saying `Map<string, number>` is fine) still has a `<...>` token, or when the State or journal exceeds `limits.stateLines` or `limits.journalLines`. It deletes the input file after the journal posts, so a hook runs `--auto` without repeating a journal. State is rewritten before the journal posts: a rerun after a failed journal post reads the new State number and bumps the checkpoint number again, and because the input file is kept, no text is lost. A non-auto run is allowed on a ready PR. `--auto` takes its session from `--session`, else `GROUNDWORK_SESSION`, else the hook stdin JSON `session_id`; with none it is a no-op (exit 0). `--auto` pushes `issue/N` without force (6.5: the branch is pushed even if red) only after the PR footer session check passes; on exit 3 it skips the push, so a revived worker cannot push onto a takeover winner's branch. Without an input file it posts no journal and rewrites no State. Off a draft `issue/N` PR it does nothing. Success: `{ "ok": true, "number": N, "pr": number, "checkpoint": number }`; a no-op: `{ "ok": true, "skipped": "<reason>" }`.
- `resume` success: `{ "ok": true, "number": N, "pr": number|null, "session": "<footer session>"|null, "truncated": boolean, "briefing": "<text>" }`; exit 3 carries `session`.
- `release` success: `{ "ok": true, "number": N, "mode": "decision"|"merged", "changed": boolean }`; `changed` is false on a rerun.
- `resolve-thread` success: `{ "ok": true, "number": N, "threadId": "<id>", "alreadyResolved"?: true }`; with `--list`, `{ "ok": true, "number": N, "lines": ["<thread id> <path>:<line> <summary>"] }`.
- PR footer: `Agent: <agent> · session <session>` (agent is `<model>/<harness>`), the last line of the PR body after `---`. A takeover rewrites it to the new agent and session. `checkpoint` and `release --decision` read the footer session as `resume` does.
- Initial PR body: `claim` fills `.github/pull_request_template.md` with `fillTemplate`: `<issue>` (so `Closes #<issue>` becomes `Closes #N`), the State keys with `checkpoint` 0, `time`, `agent`, `session`, and the fields `done`, `proven`, `rejected`, `gotchas`, `open` = `none`, `in progress` = `claimed, nothing built yet`, `next` = `start the first acceptance criterion`, `unproven` = `all`. Every other placeholder (`<command>`, `<observed result>`, `<why not, and when>`, `<finding>`, `<sha>`, `<reason>`) is the worker's to fill. `PR metadata` checks only `## State` for leftover placeholders; clearing the others is part of the worker's Definition of Done (4.5). `claim` refuses to post only when `unfilled` lists a key it owns, so the draft PR is never blocked by the worker-owned ones. The refuse-on-`unfilled` rule applies to comments, `## State` and the footer.
- Handover inputs: `release --merged` takes no input file. Done comes from the final `## State` `Done` field, Gotchas from its `Gotchas`, Follow-ups from its `Open`; `pr` is the merged PR number, `issue` the issue.
- Placeholder keys, one per meaning in every template (`state-section.md`, `pull_request_template.md`, comments): `issue`, `pr`, `checkpoint`, `session`, `previous session`, `agent`, `time` (UTC `YYYY-MM-DD HH:MM`), `journal`, the eight State fields in lower case (`done`, `in progress`, `next`, `proven`, `unproven`, `rejected`, `gotchas`, `open`), and `follow-ups`. Handover `done` and `gotchas` reuse the State keys of the same meaning.

Comment formats (`.github/groundwork/templates/`, filled with `fillTemplate`; placeholder keys are the text between the angle brackets). Every comment ends with its marker so a rerun can find it (`hasMarker`), matched together with the agent-account author.

| File | Comment | Posted by | Marker |
|---|---|---|---|
| `claim-comment.md` `## Issue pointer` | ``Claimed on `issue/<issue>` by session <session>.`` on the issue | `claim` | `claim` |
| `claim-comment.md` `## PR claim` | `Claim: #<issue>, session <session>.` on the PR | `claim` | `claim` |
| `claim-comment.md` `## PR takeover` | `Takeover: #<issue>, session <session>, previous session <previous session>.` on the PR | `claim` | `takeover` |
| `checkpoint-comment.md` | Header line (`Checkpoint <checkpoint> · <time> · <agent> · session <session>`) then `<journal>`, on the PR | `checkpoint` | `checkpoint` |
| `handover-comment.md` | `Handover: #<issue> merged in PR #<pr>.` with Done, Follow-ups, Gotchas and Session lines, on the issue | `release --merged` | `handover` |

Configuration lives in `.github/groundwork/config.json` (org, control repo, accounts, App slugs, trusted authors, label actors, deploy mode, limits from section 16, size-exclusion and generated-file globs, test-integrity patterns) and `hotspots.json`; scripts read both through `scripts/lib/config.mjs`.

### 13.1 Module contracts

Conventions for every module under `scripts/lib/` and `scripts/ci/`:

- ESM, `node:` built-ins only, Node 24+ (`path.posix.matchesGlob` for globs; it may print an experimental warning, which is harmless, and a unit test asserts `**/x` matches a root-level `x`). Types are JSDoc over plain JSON-compatible objects.
- Library modules never call `process.exit`, never write to stdout or stderr, and read the environment only through an `env` argument. They throw; every thrown error is a `GitHubError`, `ConfigError` or `SettingsError` with a one-line `message`. Content problems (an invalid body, a missing heading) are return values, not throws.
- Logins are compared only through `trust.sameLogin`. URL path segments built from caller input go through `github.apiPath`, never string concatenation.
- Internal dependencies (no cycles): `github`, `config`, `markdown` depend on nothing internal; `trust` → `config`; `issue-model` → `github`, `markdown`, `trust`; `settings` → `github`, `config`, `trust` (`resolveActor` for reviewer `owner`); `ci` → `github`, `config`, `trust`. Validators import `ci` plus what their row names.

#### Admin op modules

Each module under `scripts/groundwork` exports `OP`, `PERMISSIONS`, `TOKEN_SCOPE` (`target`, `org` or `deferred`), `validateArgs(args) -> string[]` and `run(ctx) -> { ok, summary }` with `ctx { client, token, org, repo, settingsRoot, config, env, log, recordCall, withToken, setScriptPermissions, writeSettings, runCheck }`; `runCheck() -> { ok, summary }` runs `check` on the target with the `check` token on its `main` head (deferred ops only), and `setScriptPermissions(permissions)` records the parsed `permissions` of a `script` run for the grant check; `withToken({ repositories, permissions }, async ({ client, token }) => T) -> Promise<T>` is the 12.1 hook, and `client` and `token` are `null` for `deferred` ops; `recordCall({ method, path, status })` adds a row to the call table for work that bypasses `client`, and `status` is `null` when the call never ran to an exit code. `check` also exports `runCheck`, which fails on zero rows and adds an `unreadable` row per unreadable live section.

`app-token.mjs` exports:
- `createAppJwt({ clientId, privateKey, now? })`: RS256 JWT, RSA keys only.
- `mintInstallationToken({ client, org, repositories: string[]|"all", permissions, env? })`: the granted scope must equal the requested one except one extra `metadata: read`; any mismatch revokes the token and throws; a failed revoke is reported.
- `revokeInstallationToken(client)`.

`bootstrap.mjs` exports `OP` (`'bootstrap'`), `TOKEN_SCOPE` (`'deferred'`), `PERMISSIONS`, `CREATE_PERMISSIONS` (`{ administration: 'write' }`), `CONTROL_READ_PERMISSIONS` (`{ contents: 'read' }`), `DESCRIPTION_MAX_LENGTH` (350), `validateArgs` and `run`. `bootstrap-pass2.mjs` exports `OP`, `TOKEN_SCOPE` (`'target'`), `PERMISSIONS`, `validateArgs` (any key is an error) and `run`. The helper modules below are `node:`-only, take one options object, throw `GitHubError` on API failure and `SettingsError` on malformed release content, and never read the environment. `bootstrap.run` calls them inside the 12.1 grants: steps 1 and 2 of 14.2 inside one `withToken` with `CONTROL_READ_PERMISSIONS` on `[controlRepo]` (the target may not exist and `ctx.client` is `null`); the create call through `createRepo`; labels, the commit, settings and the epic inside `withToken` with `PERMISSIONS` on `[repo]`.

`bootstrap-tree.mjs` (pure, no `client`):
- `CONTROL_PATHS: string[]`: exact paths or directory prefixes (ending `/`) removed from projects: `admin-ops/`, `scripts/groundwork/`, `.github/workflows/reusable-verify.yml`, `.github/workflows/reusable-security.yml`, `.github/workflows/admin-run.yml`. Stubs live under `scripts/groundwork/stubs/`, so the builder reads them before dropping the prefix.
- `KIT_VERSION_PATH = '.github/groundwork/kit-version.txt'` (`bootstrap-repo.mjs` repeats the literal until the two modules share one).
- `contentPaths(entries) -> string[]`: blobs whose text the builder needs: every blob under `.github/` and under `scripts/groundwork/stubs/`.
- `buildBootstrapTree({ entries, contents, org, controlRepo, repo, description, tag, tagSha }) -> TreeEntry[]`. `entries` is the release tree's blobs `{ path, mode, sha }`; `contents` maps each `contentPaths(entries)` path to its UTF-8 text; `tag` is `vX.Y.Z` and `tagSha` the 40-character commit SHA it points to (throws otherwise). Returns blob entries only, sorted by path, as `{ path, mode, sha }` (kept) or `{ path, mode, content }` (new or changed), ready for `POST git/trees` without `base_tree`. Rules: drop `CONTROL_PATHS`; in every output text file replace `__ORG__` and `__REPO__` literally, and `__DESCRIPTION__` literally in `.md` files only (elsewhere it throws, because the description may hold `"`, `\`, `:` and `#`, which break JSON and YAML); rewrite `./.github/workflows/reusable-<name>.yml` to `<org>/<controlRepo>/.github/workflows/reusable-<name>.yml@<tagSha> # <tag>` and drop the `# zizmor: ignore[self-repository] ...` comment on that line; write `KIT_VERSION_PATH` as `<tag>\n`, `.release-please-manifest.json` as `{}\n`, `version.txt` as `0.0.0\n` and `CHANGELOG.md` empty; replace `scripts/verify` and `scripts/verify.cmd` with `scripts/groundwork/stubs/verify` and `verify.cmd` (stub mode kept), `README.md` with `stubs/README.md`, and all of `docs/` with `stubs/docs/**`; copy the six `stubs/deploy/` files to `scripts/stubs/deploy/` (8.5). Every other `.github/groundwork/` file, `config.json` and `hotspots.json` included, is copied unchanged (none carries a placeholder; projects edit them by PR). A missing stub, `stubs/docs/` included, throws `SettingsError` naming the path.
- `adoptTreeEntries({ treeEntries, contents, target }) -> TreeEntry[]`: the kit entries an adopted repository gets over its existing tree (14.4). `target` is `{ tree, codeowners? }`, the recursive tree the preflight read and the text of its `.github/CODEOWNERS`. Never writes `LICENSE` (owner decision, #258); drops `README.md` when the target root holds a readme in any case or extension; appends the built CODEOWNERS text to the target's (a final newline added first when missing), so the kit lines match last; every other entry is unchanged. A target CODEOWNERS without `codeowners` throws `SettingsError`.
- `settingsFiles(treeEntries, contents) -> Record<string, string>`: the `.github/groundwork/**` files of the built tree as text. It is the only settings source of pass 1 (12.1, `ctx.writeSettings`).

`bootstrap-repo.mjs` (every function takes `{ client, org, ... }`, except `createRepo`):
- `latestReleaseTag({ client, org, controlRepo }) -> Promise<string>`: the highest `vMAJOR.MINOR.PATCH` among `git/matching-refs/tags/v`; throws when none exists (14.1 step 7).
- `resolveTagCommit({ client, org, controlRepo, tag }) -> Promise<string>`: the commit SHA of the release tag (annotated tags dereferenced).
- `readReleaseTree({ client, org, controlRepo, commitSha }) -> Promise<Entry[]>`: recursive tree, blobs only; throws when GitHub truncates it. `readBlobTexts({ client, org, controlRepo, entries, paths }) -> Promise<Record<string, string>>`. `readBlobContents({ client, org, controlRepo, entries }) -> Promise<Map<string, string>>`: base64 content by path for the entries that keep a control-repo `sha`, because the target holds no such objects. `readKitVersion({ client, org, repo }) -> Promise<string>`: the `vX.Y.Z` tag in the target's `kit-version.txt` on `main`; throws on anything else.
- `inspectRepo({ client, org, repo, adminBot }) -> Promise<'absent'|'fresh'|'ours'|'foreign'>` (read under the control-repo read grant, the target being public); `adminBot` is `<config.apps.admin>[bot]`. `absent` on 404; `ours` when `KIT_VERSION_PATH` exists on the default branch; `fresh` only when the default branch is `main`, holds exactly one commit authored by `adminBot` (compared with `trust.sameLogin`) and its root holds only `README.md` (the `auto_init` state after a crash before the bootstrap commit). Anything else is `foreign`, an empty repository (409) and a default branch other than `main` included. `run` writes nothing unless the state is `absent`, `fresh` or `ours`, or `foreign` with `adopt: true` after the adopt preflight (14.4), and on `ours` it writes nothing when the setup epic (`findSetupEpic`) is accepted or closed (14.2 step 1); this overrides "fails when there is no `kit-version.txt`" in lane wording.
- `readAdoptionGaps({ client, org, repo, kitEntries }) -> Promise<{ rows, empty, headSha?, treeSha?, tree? }>`: the 14.4 failing rows from GET calls; the collision row reads the default branch's head commit SHA (`headSha`), its tree SHA from `git/commits/<headSha>` (`treeSha`; `git/trees/<commit SHA>` echoes the commit SHA instead) and the recursive tree by `treeSha` (`tree`, returned when read whole); it fails on a commit without a tree SHA, a truncated tree or one without a tree list, and counts a kit path the target holds as a non-blob, or under an ancestor the target holds as a non-tree, as a collision, and a root or `docs/` CODEOWNERS that the kit's `.github/CODEOWNERS` would shadow. `createMissingLabels({ client, org, repo, labels }) -> Promise<number>`: POSTs the kit labels the target lacks (names compared with `normalizeLabel`) and changes nothing else; the adopt path's step 4 (14.4). `readAdoptionReport({ client, org, repo, kitLabels, empty, tree }) -> Promise<Array<{ name, detail }>>`: the 14.4 reported rows, read in `plan` only; `tree` gives the `license` row.
- `createRepo({ withToken, org, controlRepo, repo, description, permissions }) -> Promise<void>`: `POST /orgs/{org}/repos` (`{ name, description, private: false, auto_init: true }`) inside `withToken({ repositories: [controlRepo], permissions })` (V7: GitHub accepts the restricted token, so there is no installation-wide retry). Any failure, 422 (name taken) included, throws. `bootstrap.run` passes `CREATE_PERMISSIONS`.
- `commitBootstrapTree({ client, org, repo, tag, treeEntries, blobs, sleep }) -> Promise<{ sha: string, created: boolean }>`: `blobs` is the `readBlobContents` map, POSTed to the target with `git/blobs` (`sleep` spaces the calls) because tree entries cannot reference control-repo objects; then it creates the tree and the commit `chore: bootstrap from groundwork <tag>` (no author or committer fields) on the current `main` head, then `PATCH git/refs/heads/main` with `force: false`. `created: false` when `KIT_VERSION_PATH` already exists (resume). A 422 on that PATCH (`main` moved during the commit) throws `SettingsError` with rerun advice. `commitAdoptTree({ client, org, repo, tag, pin, treeEntries, blobs, sleep })` is the 14.4 kit merge: `pin` is `{ headSha, treeSha }` from `readAdoptionGaps`; it calls `requireMainHead({ client, org, repo, headSha })`, which throws `SettingsError` when `main` is no longer `headSha` (apply also calls it before its first write), then posts the same blobs and a tree with `base_tree: treeSha`, and commits with `headSha` as parent.

`apply-settings.mjs` exports `applySections(ctx, groups, dependencies) -> Promise<{ ok, summary }>`, `groups` a subset of `'labels' | 'settings' | 'variables' | 'rulesets'` (`settings` is repository, team access, security, Actions and environments, not variables); `dependencies` is a test seam (`spawnGh`). `run` applies all four in the current order. `bootstrap.run` calls `['labels']` (14.2 step 4), the commit, then `['settings']`, `['rulesets']` and `['variables']`, and after the epic `['labels']` once more (the final labels pass, 14.2 step 10), each with `ctx` copied from the `PERMISSIONS` token and the `writeSettings` result. GitHub seeds its ten default labels asynchronously after repository creation, possibly after step 4, and the final pass deletes them (V21).

`setup-epic.mjs`:
- `SETUP_EPIC_MARKER = '<!-- groundwork:setup-epic -->'`; each task body carries `<!-- groundwork:setup-task NN -->`.
- Templates live in `scripts/groundwork/stubs/setup/` of the release tree: `epic.md` and `NN-<slug>.md`. The first line of each is `# <title>`. A task file's next lines may be `<!-- type: Chore -->` (default `Feature`), `<!-- size: S -->` (`S` or `M`, required) and `<!-- blocked-by: NN, NN -->`. Bodies follow 4.3 and keep their markers.
- `parseSetupTemplates(files, { org, repo, description }) -> { epic: { title, body }, tasks: Array<{ number, title, type, size, body, blockedBy: string[] }> }` (pure). `files` maps the path relative to `setup/` to text. It replaces `__ORG__`, `__REPO__` and `__DESCRIPTION__` literally (all templates are Markdown). `SettingsError` on a missing title, an unknown type, a missing or invalid size or a `blocked-by` naming no task.
- `findSetupEpic({ client, org, repo, adminBot }) -> Promise<issue|undefined>` (`setup-epic.mjs`): the issue carrying the setup-epic marker, or `undefined`. `bootstrap` calls it in `readSource` on `ours`, under the control-read grant, so an `ours` rerun refuses before any write. A marker on an issue by another author fails the same way as in `openSetupEpic`.
- `openSetupEpic({ client, org, repo, templates, adminBot, sleep }) -> Promise<{ epic: number, created: number[] }>`; `templates` is the `parseSetupTemplates` result. It finds the epic by marker (`GET issues?state=all`) and creates only what is missing (`POST issues` with `type`, and for tasks `labels: ['size:<size>']`; `sub_issues` with the issue's numeric `id`; `dependencies/blocked_by`), so a rerun adds nothing. For issues that already exist it reads `sub_issues` and `dependencies/blocked_by` live and posts only the missing links, so a run that died between creation and linking resumes. `adminBot` is required and compared with `trust.sameLogin` on `issue.user.login`: a marker on an issue by another author throws `SettingsError` before any write. `sleep` (default the real timer) spaces issue creations by 12 seconds. No call applies a label other than `size:*`; the epic carries none.

`bootstrap-pass2.mjs` also exports:
- `run(ctx, { sleep, timeoutMs, pollMs })` takes its test seams in `dependencies`; `bootstrap.run(ctx, { sleep, settingsDependencies })` does the same.
- `STUB_MARKER = 'GROUNDWORK_STUB'`; `readVerifyState({ client, org, repo }) -> Promise<'stub'|'real'|'missing'|'unreadable'>` reads `scripts/verify` on `main` (`unreadable`: no content in the response); `run` refuses unless it returns `real`, so an unreadable file fails closed; it also refuses, before any write, when the project's `rulesets/main.json` has no `code_scanning` rule.
- `enableDefaultSetup({ client, org, repo, sleep }) -> Promise<void>`: returns without a write when default setup is already `configured` (a rerun writes nothing); otherwise `PATCH code-scanning/default-setup` with `{ state: 'configured' }`, then reads back until `configured`.
- `waitForFirstCodeqlRun({ client, org, repo, timeoutMs, pollMs, sleep }) -> Promise<{ runId: number, conclusion: string }>`: polls `actions/runs?branch=main&status=completed&event=dynamic&per_page=100` (issue-event workflows also report `head_branch: main` and would push the setup run off a default page), reading up to 10 pages per poll (the 1,000-result cap of the filtered runs endpoint), for the run whose `path` is `dynamic/github-code-scanning/codeql` (default setup; its run name is `CodeQL Setup`, so the name is not matched, V22); defaults 10 minutes and a 15 second poll; throws `GitHubError` on timeout. `run` fails, leaving the ruleset untouched, on a timeout or a `conclusion` other than `success`.
- `withCodeScanningRule({ live, desired }) -> object` (pure): `desired` is the target's `rulesets/main.json` at `ctx.settingsRoot` (14.2 step 4 commits the rule there first); it returns `live` with `desired`'s `code_scanning` rule added or replaced and every other rule kept; `SettingsError` when `desired` has none. `addCodeScanningRule({ client, org, repo, desired }) -> Promise<'added'|'present'>` GETs the live `main` ruleset and PUTs it back.
- `deployChecklist({ org, repo, secrets }) -> string[]`: summary lines naming the `production` environment page and each name in `secrets`, taken from `settings.json` `environments.production.secrets`.

`script.mjs` exports `OP` (`'script'`), `TOKEN_SCOPE` (`'deferred'`), `PERMISSIONS` (`{}`: the target grant is the file's own), `CONTROL_READ_PERMISSIONS`, `validateArgs`, `grants` (12.1), `parseScript(source) -> { permissions } | { problem }` (pure, static, 12.1) and `run`. `selftest.mjs` exports `OP`, `TOKEN_SCOPE` (`'deferred'`), `TAKES_TARGET_REPO` (`false`; `admin-run` then requires an empty `target_repo` for the op), `SELFTEST_REPO_PREFIX` (`'selftest-'`), `targetRepo(env)`, `grants` (12.1), `PERMISSIONS`, `CREATE_PERMISSIONS`, `CONTROL_READ_PERMISSIONS` (all `bootstrap`'s), `validateArgs` (reports any key; only `{}` passes) and `run`, which takes the optional seams `runBootstrap`, `probes` and `inspect`. `selftest-probes.mjs` exports `PROBE_IDS` and `runProbes` (12.1). `script.mjs` also exports `plan` (12.1); so does `bootstrap.mjs`, which returns the 14.4 preflight as `facts` when `adopt: true`.

`scripts/ci/deploy-record.mjs` (8.5; `node:`-only): `previousTag({ releases, tag }) -> string|null` (pure; `releases` is the `GET releases` array; skips drafts and prereleases and tags that are not `vX.Y.Z`; the highest lower than `tag`), `renderRecord({ result, tag, previous, runUrl }) -> string` (the 8.5 block, ending with a newline), `upsertRecord({ notes, record }) -> string` (appends `record` after a blank line, or replaces from the `<!-- groundwork:deploy -->` marker to the end of the block), and a CLI: `previous-tag <tag>` prints the tag or nothing, exit 0; `record --tag <tag> --result <r> --previous <tag|none> --run-url <url>` updates the release notes (`PATCH releases/{id}`), exit 0, 1 on error. Release data comes from the workflow's `GITHUB_TOKEN`.

`scripts/kit-update.mjs` (no npm dependencies, project-side; it imports `scripts/lib/config.mjs` and `github.mjs`; org and control repo come from the project's `config.json`):
- Kit paths copied from the tag's tree, overwriting: `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `.github/groundwork/templates/`, the workflows `issue-format`, `pr-metadata`, `protected-labels`, `plan-lint`, `release-please` and `failure-alert` (`.yml`), `scripts/agent/`, `scripts/human/`, `scripts/admin/`, `scripts/ci/`, `scripts/lib/`, `scripts/kit-update.mjs`, `.claude/skills/groundwork-*/` except the `[control]` `groundwork-setup/` (`KIT_EXCLUDED_PATHS`, kept in step with `CONTROL_PATHS` by a test in `scripts/groundwork/bootstrap-tree.test.mjs`). A file in the old tag's tree and not in the new one is deleted; a file of either tag under `KIT_EXCLUDED_PATHS` is deleted from the project when present, so a copy an older `kit-update` delivered goes. Only the paths the tags list are removed. `ci.yml` is also copied, with its `./.github/workflows/reusable-<name>.yml` references pinned as `bootstrap` does (14.2 step 5); it is overwritten, so a project's edits to it are lost.
- Copied only when the project's file equals the old tag's (else listed in `skipped`): `.github/dependabot.yml`, `.claude/settings.json`, `AGENTS.md`, `CLAUDE.md`. A project that edited `dependabot.yml` lands in `skipped` on every update and never gets the `ignore` rule of 8.6; the same holds for `AGENTS.md` and `CLAUDE.md` even when the tags' copies are equal.
- Copied only into a project that has none (`CREATE_ONLY_PATHS`): `.github/workflows/deploy.yml`. A project from a template older than the deploy workflow gets it with the `deploy-record` test that reads it; an existing file is never touched. A project that deploys from a workflow with another name keeps a second `release: published` deploy workflow after the copy and deploys twice when `DEPLOY_ENABLED` is `true`: it renames its workflow to `deploy.yml`, so `kit-update` leaves it alone.
- Never touched: everything else, among it `scripts/verify*`, `scripts/deploy`, `scripts/smoke`, `scripts/rollback`, `scripts/stubs/`, an existing `.github/workflows/deploy.yml`, `.github/CODEOWNERS`, `.github/groundwork/` (but `templates/`, `config.json` below and `kit-version.txt` below), `docs/`, `README.md`, `release-please-config.json`, `.release-please-manifest.json`, `version.txt`, `CHANGELOG.md`.
- `.github/groundwork/config.json`: three-way merge by key, recursing into objects (arrays are values): base is the old tag's file (the tag in `kit-version.txt`), ours the project's, theirs the new tag's. A key equal to base takes theirs; a key the project changed or deleted keeps ours; a key only in theirs is added. A changed merge result is written as 2-space JSON, so the first update that changes a key reformats a hand-wrapped file.
- `.github/groundwork/kit-version.txt` becomes `<tag>\n`. A tag equal to the current one changes nothing: exit 0 and `changed: []`.
- SHA pins (8.6): `resolveTagCommit` semantics (annotated tags dereferenced); in every `.github/workflows/*.yml` each existing `uses: <org>/<controlRepo>/.github/workflows/reusable-<name>.yml@<sha> # <tag>` becomes the new tag's commit SHA and tag (a trailing comment is replaced); other `uses:` lines are unchanged, and a local `./.github/workflows/reusable-*.yml` reference is pinned only in the copied `ci.yml`. The template `.github/dependabot.yml` carries the `ignore` rule of 8.6, so an unmodified project copy receives it through the unmodified-only copy.
- Staging: the plan's paths go to one `git add -A --force -- <paths>`, so a very large update could exceed the command-line limit; none has. `chmod` is a no-op on Windows and a mode change from 100755 to 100644 is never applied; no kit path is executable today.
- Exports: `KIT_PATHS`, `KIT_EXCLUDED_PATHS`, `UNMODIFIED_ONLY_PATHS` and `CREATE_ONLY_PATHS` (the four lists above), `mergeConfig({ base, ours, theirs }) -> object` (pure), `rewritePins({ text, org, controlRepo, tag, tagSha }) -> string` (pure) and `main({ argv, ... })`; test seams are the lane's choice.

#### `lib/github.mjs`: one client over `gh api`, `fetch` and fixtures

```js
/** @typedef {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} Method */
/** @typedef {{ owner: string, repo: string }} RepoRef */
/** @typedef {{ status: number, data: any, headers: Record<string, string> }} Response */
/** @typedef {{ body?: object, query?: Record<string, string|number|boolean>, accept?: string, okStatuses?: number[] }} RequestOptions */
/** @typedef {{ method: Method, path: string, status: number }} CallRecord */
/** @typedef {{
 *   transport: 'gh'|'fetch'|'fixture',
 *   request(method: Method, path: string, options?: RequestOptions): Promise<Response>,
 *   paginate(path: string, options?: { query?: object, itemsKey?: string }): Promise<any[]>,
 *   graphql(query: string, variables?: object): Promise<object>,
 * }} GitHubClient */
```

| Export | Contract |
|---|---|
| `createClient({ env, token?, onCall? }) → GitHubClient` | `token` given: `fetch` with that token (`admin-run` minted tokens). Else `env.GITHUB_ACTIONS === 'true'`: `fetch` with `env.GITHUB_TOKEN` (empty token throws). Else outside Actions `env.GH_TOKEN` is required, which `token.mjs exec` sets for its child: without it `createClient` throws a `GitHubError` naming `token.mjs exec` before any `gh` process starts, so a bare agent script exits 1 and makes no GitHub call. The ambient `gh` login is never used and no read-only path keeps an exception (`next`, `resume`, `review-queue`, `inbox` and `plan-lint` run under `token.mjs exec` too). With `GH_TOKEN`: `gh`, which spawns `gh api -i --method <m> <path>` with an argument array (no shell), body on stdin (`--input -`), status and headers parsed from the `-i` output. Base URL `env.GITHUB_API_URL` or `https://api.github.com`. `onCall(CallRecord)` runs after every call (the `admin-run` summary). |
| `createFixtureClient(routes, { onCall? }) → GitHubClient` | `routes`: `Record<string, Response \| Response[]>` keyed `"<METHOD> <path>"` with query parameters sorted by name and encoded; route keys are normalised to the same form as lookups (`"GET /repos/o/r/pulls/7/files?per_page=100"` for the first page, `"GET /repos/o/r/pulls/7/files?page=2&per_page=100"` for the next); an array yields successive responses. GraphQL calls are keyed `"POST /graphql"` with an ordered array of responses, one per call. An unmatched call throws `GitHubError` (status 0, `no fixture for <key>`). Every test uses this; no test touches the network. |
| `apiPath(template, params) → string` | Fills `{name}` segments with `encodeURIComponent(params.name)`; a missing param throws `GitHubError` (status 0). |
| `repoFromEnv(env) → RepoRef` | From `GITHUB_REPOSITORY`; throws `GitHubError` (status 0) when absent or malformed. |
| `currentRepo(env = process.env) → Promise<RepoRef>` | Agent machine only: `gh repo view --json owner,name`. Refuses without `env.GH_TOKEN` like `createClient`, because `resume` and `review-queue` call it first. |
| `class GitHubError extends Error` | Fields `status` (0 for transport failures), `method`, `path`, `apiMessage`. |

Behaviour shared by all transports: `request` rejects a path that does not start with `/` (`GitHubError`, status 0). It resolves on 2xx and on any status in `okStatuses` (`claim` passes `[422]`, existence probes pass `[404]`), and throws `GitHubError` otherwise. `paginate`'s first request is `path` with the caller's `query` plus `per_page=100` and no `page` parameter; each later request is the `Link: rel="next"` URL reduced to path plus query (base URL dropped), and the fixture key is that path with its query sorted; `itemsKey` unwraps responses such as `{ total_count, workflow_runs }`. `graphql` posts to `/graphql` and throws `GitHubError` with the first `errors[].message` when the response carries errors. No retries: callers re-run. Bodies never reach `onCall`.

#### `lib/config.mjs`

```js
/** @typedef {'owner'|'agent'|string} ActorRef   'owner', 'agent', 'app:<apps key>', or a literal login */
/** @typedef {{ actor: ActorRef, scope: 'any'|'issues'|'pull-requests' }} TrustedAuthor */
/** @typedef {{ hierarchyDepth: number, hierarchyDepthWithIntermediate: number, subIssuesPerParent: number,
 *   prChangedLines: number, prFiles: number, tasksPerWorker: number, activeWorkers: number,
 *   draftLeaseMinutes: number, claimWithoutPrMinutes: number, reviewRounds: number,
 *   sameFailureAttempts: number, ciReruns: number, stateLines: number, journalLines: number, resumeLines: number }} Limits */
/** @typedef {{ schemaVersion: 1, org: string, controlRepo: string,
 *   accounts: { owner: string, agent: string }, apps: Record<string, string>,
 *   trustedAuthors: TrustedAuthor[], labelActors: Record<string, ActorRef>,
 *   deploy: 'scripts'|'none', limits: Limits, sizeExcludeGlobs: string[], generatedGlobs: string[],
 *   testIntegrity: { testGlobs: string[], testDeclarationPatterns: string[], suppressionPatterns: string[], thresholdGlobs: string[] } }} Config */
/** @typedef {{ name: string, paths: string[] }} Hotspot */
```

| Export | Contract |
|---|---|
| `CONFIG_DIR` | `'.github/groundwork'` |
| `loadConfig({ root }) → Promise<Config>` | Reads `<root>/.github/groundwork/config.json`. Fails on unknown or missing top-level keys, `schemaVersion` other than 1, a pattern that does not compile, an `app:<key>` ref with no matching `apps` key, or a `labelActors` key with `*` anywhere but the end. Returns logins and slugs lower-cased. |
| `loadHotspots({ root }) → Promise<Hotspot[]>` | `hotspots.json` (`{ "schemaVersion": 1, "hotspots": Hotspot[] }`); `[]` when the file is absent. `paths` are exact paths or directory prefixes, never globs (6.2). |
| `repoRoot(scriptUrl) → string` | Repository root for a module at `scripts/<dir>/<file>.mjs` or `scripts/<file>.mjs` (`kit-update.mjs`): the parent of the nearest ancestor directory named `scripts`. Validators load config from their own checkout, so base-commit validators read base config (8.3). |
| `class ConfigError extends Error` | Field `file`. |

#### `lib/trust.mjs` (pure)

```js
/** @typedef {{ event: string, actor?: { login: string }, label?: { name: string }, created_at: string }} TimelineEvent   subset of the REST timeline item */
```

| Export | Contract |
|---|---|
| `normalizeLogin(login) → string` | Trimmed, lower-case. |
| `sameLogin(a, b) → boolean` | Case-insensitive equality; `false` when either is empty. |
| `resolveActor(ref, config) → string` | `owner`/`agent` → `config.accounts`; `app:<key>` → `<apps[key]>[bot]`; anything else is the literal login. Lower-case. Throws `ConfigError` for an unknown App key. |
| `isTrustedAuthor({ login, kind }, config) → boolean` | `kind`: `'issue'`, `'pull-request'` or `'comment'`. Scope `any` covers all kinds, `issues` only issues, `pull-requests` only PRs. |
| `requiredLabelActor(label, config) → string \| null` | Exact `labelActors` key first, then the longest matching `prefix*` key; resolved login, or `null` for unprotected labels. |
| `latestLabeledEvent(timeline, label) → { actor: string, createdAt: string } \| null` | Last `labeled` event for that label name. |
| `validLabels({ labels, timeline }, config) → string[]` | Current labels, minus every protected label whose latest `labeled` event is missing or by another actor (section 5). |
| `untrustedBlock(text, author) → string` | Wraps text in a fence longer than any backtick run inside it, info string `untrusted <author>` (6.5, 6.7). |

#### `lib/markdown.mjs` (pure)

| Export | Contract |
|---|---|
| `stripCommentsAndFences(text) → string` | Removes `<!-- ... -->` and fenced blocks (backtick and tilde). Every `markdown.mjs` export normalises CRLF to LF. |
| `parseSections(body) → { sections: Array<{ name, line, content }>, byName: Record<string, string>, duplicates: string[] }` | Level-2 headings after `stripCommentsAndFences`. `name` is the heading text with a trailing parenthesised group removed (`## State  (checkpoint 3 ...)` → `State`); `line` is the full heading line. A section also ends at the PR footer break (`findFooterBreak`). |
| `findClosingRefs(body) → Array<{ keyword, owner: string \| null, repo: string \| null, number }>` | Every GitHub closing keyword (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved; any case) outside comments, fences and inline code spans. Also matches full issue and PR URLs after the keyword. |
| `criterionIds(content, prefix) → string[]` | IDs (`E1`, `AC3`) from checklist lines `- [ ] <id> ...` or `- [x] <id> ...`, in order, duplicates kept. |
| `parseTable(content) → Array<Record<string, string>>` | First GFM table in the content; header cells are the keys, cells trimmed. |
| `parseStateSection(section) → { header: { checkpoint, at, agent, session }, fields: Record<string, string> }` | 6.5 format; missing header parts are `null`. `section` is the `{ line, content }` entry from `parseSections` or a full string that starts with the `## State` heading. |
| `templatePlaceholders(templateText) → string[]` | The `<...>` tokens of a template (`state-section.md`); a body still containing one is unfilled. |
| `fillTemplate(template, values) → { text, unfilled: string[] }` | Replaces every `<name>` placeholder outside comments and fences with `values[name]` (the key is the text between the brackets), in one pass, so a value is never filled again. A placeholder without a value, or whose value is `null` or `undefined`, stays in `text` and is listed once in `unfilled` (brackets included); `values` may be `null`. Callers refuse to post a comment when `unfilled` is not empty. |
| `templateSection(templateText, name) → string \| null` | Raw text of level-2 section `name` in a template file that holds several comments (`claim-comment.md`), markers kept; `null` when absent. |
| `findFooterBreak(lines) → number` | Index of the PR footer break: the last `---` line when only blank lines, groundwork markers and one `Agent:` line follow it to the end; `-1` otherwise, so a `---` rule inside an issue body stays content. The only copy; `parseSections`, `parseFooter` and `release.mjs` use it (`replaceSection` ends a section at any `---` line instead). |
| `replaceSection(body, name, content) → string` | Replaces the named section's content, or appends the section. A section ends at the next heading or at a line that is exactly `---` (the PR footer survives); the body always ends with one newline. |
| `hasMarker(body, name)`, `addMarker(body, name)`, `removeMarker(body, name)` | Marker `<!-- groundwork:<name> -->` (`released`, `claim`, `takeover`, `checkpoint`, `handover`, `issue-format`, `alert:<workflow path>`). |
| `formFieldLabels(yamlText) → string[]` | `label:` values of an issue form by regex (4.3); the form/twin unit test compares these with `parseSections` of the twin. |

#### `lib/issue-model.mjs`

```js
/** @typedef {'Epic'|'Feature'|'Bug'|'Chore'|'Spike'} IssueType */
/** @typedef {'done'|'needs-decision'|'queued'|'in-review'|'claimed'|'orphaned'|'proposed'|'blocked'|'ready'} Status */
/** @typedef {{ number: number, state: 'open'|'closed', merged: boolean, draft: boolean, inMergeQueue: boolean,
 *   released: boolean, headRepo: string, createdAt: string, lastAgentCommentAt: string|null }} PullFacts */
/** @typedef {{ number: number, title: string, type: string|null, state: 'open'|'closed', stateReason: string|null,
 *   author: string, body: string, labels: string[], validLabels: string[],
 *   ancestors: Array<{ number: number, type: string|null, validLabels: string[] }>,   nearest first
 *   blockedBy: Array<{ number: number, state: 'open'|'closed' }>,
 *   branch: { exists: boolean, sha: string|null }, claimCommentAt: string|null, claimCommitAt: string|null, pr: PullFacts|null }} IssueFacts
 *   claimCommentAt: server created_at of the newest issue comment by the agent account carrying marker `claim` (6.3)
 *   claimCommitAt: committer date of the ref head when `parseClaimCommit` accepts its message for this issue (claim or takeover commit), else null */
```

| Export | Contract |
|---|---|
| `ISSUE_TYPES`, `REQUIRED_HEADINGS: Record<IssueType, string[]>` | The 4.3 heading lists; the only copy in code. |
| `TITLE_TYPES: Record<IssueType, { types: string[], scope: string \| null }>` | Section 7 mapping; Spike is `{ types: ['docs'], scope: 'spike' }`. |
| `parseConventionalTitle(title) → { type, scope, breaking, summary } \| null` | `null` when the title is not a Conventional Commit with a section 7 type. |
| `validateIssueBody({ type, body }) → { ok: boolean, errors: string[] }` | Type present and known; each required heading exactly once; criterion IDs unique; Epic has at least one `E` ID; Feature, Bug, Chore have at least one `AC` ID; `## Serves` lists only `E<n>` IDs. |
| `loadIssueFacts(client, { owner, repo, number }, { config }) → Promise<IssueFacts>` | Reads the issue, its timeline (label validity), its parent chain (`GET .../issues/{n}/parent`, 404 ends the chain; a parent in another repository, or a 404 while the child has `parent_issue_url`, throws `GitHubError`), `blocked_by` dependencies, `git/ref/heads/issue/{n}` (404 = no branch), the issue PR (head `issue/{n}`, filtered on `head.ref`; the open one when it exists, else the newest by `created_at`), its merge-queue state (GraphQL `isInMergeQueue`), the newest PR comment by the agent account, the newest issue comment by the agent account with marker `claim`, and the ref head commit (`git/commits/{sha}`) for `claimCommitAt`. Throws `GitHubError`. |
| `claimCommitMessage({ number, session, kind? }) → string` | `chore(claim): #N [session <id>]`; `kind: 'takeover'` gives `chore(claim): #N takeover [session <id>]`. The only builder; `claim.mjs` uses it for the commit it creates. `session` must pass `isValidSessionId`. |
| `parseClaimCommit(message) → { number, session, kind: 'claim'\|'takeover' } \| null` | Inverse of the builder, reading the first line only. The only parser; `loadIssueFacts` uses it for `claimCommitAt`. |
| `isValidSessionId(session) → boolean` | `[A-Za-z0-9._-]+`. |
| `isValidAgent(agent) → boolean` | Exactly `<model>/<harness>`: two non-empty segments of `[A-Za-z0-9._-]+` joined by one `/`. |
| `parseFooter(body) → { agent, session } \| null` | The `Agent: <agent> · session <session>` line under the footer break (`findFooterBreak`); `null` without a break or when the agent fails `isValidAgent`. The only parser; `claim`, `checkpoint`, `resume` and `release` use it. |
| `isHotfixLane(facts, config) → boolean` | Bug, no parent, valid `priority:p0`. |
| `leaseState(pr, { config, now, claimCommentAt, claimCommitAt }) → { expired: boolean, released: boolean, since: string \| null }` | Draft PRs only (ready PRs never expire, 6.4); `since` is `lastAgentCommentAt ?? createdAt`, expired after `limits.draftLeaseMinutes`. `pr: null` (ref without a PR): `since` is `claimCommentAt ?? claimCommitAt`, expired after `limits.claimWithoutPrMinutes`; both `null` (ref head is not a claim commit) → `{ expired: true, released: false, since: null }`. |
| `deriveStatus(facts, { config, now }) → { status: Status, reason: string }` | First matching row of 4.4; pure. |

#### `lib/settings.mjs`

Placeholder syntax: a JSON string whose whole value is `{{app-id:<key>}}`, where `<key>` is a key of `config.json` `apps`. It is allowed only as `bypass_actors[].actor_id` in a ruleset file. Resolution replaces it with the integer `id` from `GET /apps/{slug}`; an unknown key or a failed lookup throws `SettingsError`. No other placeholder exists.

```js
/** @typedef {{ name: string, color: string, description: string }} Label */
/** @typedef {{ name: string, target: 'branch'|'tag', enforcement: string, conditions: object, bypass_actors: object[], rules: object[] }} Ruleset   no id */
/** @typedef {{ settings: object, labels: Label[], rulesets: Ruleset[] }} DesiredState   settings is settings.json as parsed */
/** @typedef {{ readable: true, value: any } | { readable: false, status: number }} LiveSection */
/** @typedef {{ kitInstalled: boolean, codeScanningConfigured: boolean|null, pass2Ran: boolean|null }} Signals   null when unreadable */
/** @typedef {{ section: string, key: string, desired: any, live: any, result: 'match'|'differ'|'missing'|'extra'|'unreadable'|'deferred' }} ComparisonRow */
```

| Export | Contract |
|---|---|
| `loadDesiredState({ root }) → Promise<DesiredState>` | Reads `settings.json`, `labels.json`, `rulesets/*.json`. Fails on unknown top-level keys, a variable `assertWhen` other than `kitInstalled` or `deployReady`, a ruleset with an `id`, a ruleset `name` that differs from its file name, duplicate label names. Placeholders stay unresolved. |
| `resolvePlaceholders(ruleset, { client, config }) → Promise<Ruleset>` | Returns a copy with every placeholder resolved. |
| `repoKind(repoName, config) → 'control' \| 'project'` | `control` when the name equals `controlRepo`. Selects `controlRepository` settings and environments by their `repos` value (`all`, `projects`, `control`). |
| `readLiveState(client, repo, { sections, environmentNames? }) → Promise<Record<string, LiveSection>>` | Sections: `repository`, `teamAccess`, `security`, `actions`, `variables`, `environments`, `labels`, `rulesets`. 403 and 404 make a section unreadable; other errors throw. `environmentNames` limits which environments get their sub-lists (secrets, variables) read. `automated-security-fixes` 404 means disabled. A 403 or 404 on `code-scanning/default-setup` yields an empty default-setup value, not an unreadable `security` section. Environment `can_admins_bypass` is passed through raw, so an absent value differs from `false`. |
| `readSignals(client, repo, { repoKind }) → Promise<Signals>` | `kitInstalled`: `repoKind` is `control`, or `GET .../contents/.github/groundwork/kit-version.txt` on the default branch succeeds (404 = false). `codeScanningConfigured`: `GET .../code-scanning/default-setup` `state === 'configured'`; 403 → `null`. `pass2Ran`: a live ruleset named `main` with a branch target (`GET .../rulesets`, then `GET .../rulesets/{id}`) has a `code_scanning` rule; 403 → `null`. |
| `compareStates(desired, live, { repoKind, config, signals }) → ComparisonRow[]` | `OrganizationAdmin` bypass actors compare by `actor_type` and `bypass_mode`; every other bypass actor by `actor_type`, resolved `actor_id` and `bypass_mode` (9.1). Secrets and variables by name; environment reviewers by resolved login. A variable is compared only while its `assertWhen` signal holds (`kitInstalled`; `deployReady` = `config.deploy !== 'none'` and (`codeScanningConfigured` or `pass2Ran`)), else `deferred`. The `main` ruleset's `code_scanning` rule and `security.code_scanning_default_setup` are `deferred` only while `pass2Ran` and `codeScanningConfigured` are both false (9.1, 10); once `pass2Ran` is true they compare normally, so a default setup that is not `configured`, or `DEPLOY_ENABLED` unset while `deploy` is not `none`, is `differ` (fail closed). A row whose signal is `null` is `unreadable`. Pure. |
| `class SettingsError extends Error` | Field `file`. |

`check.mjs`, `apply-settings` and `settings-plan` share this module; `check` passes when every row is `match` or `deferred`. `check` adds one `codeowners` row for `.github/CODEOWNERS` on the default branch: `match` when every owner is `@<accounts.owner>` (case-insensitive), `differ` otherwise (no owner, a team or an email included), `missing` on 404, `unreadable` on 403. Otherwise a cloned owner would leave protected paths with no valid reviewer, and `main` needs no other approval (9.4). The row proves who the owners are, not what they cover: `/x/ @<accounts.owner>` alone matches, and a later unowned line can unset an earlier owner. An adopted repository that keeps its own CODEOWNERS lines (14.4, 9.4) fails the row while a line names another owner, until the adoption task rewrites those lines or scopes the row to kit paths. The row does not count toward the guard against an empty desired state. `apply-settings` sends nothing for a `deferred` item.

#### `lib/ci.mjs`: the validator runner

```js
/** @typedef {{ eventName: string, payload: object, env: Record<string, string|undefined>, repo: RepoRef,
 *   client: GitHubClient|undefined, config: Config, root: string }} ValidatorContext   client undefined when the validator exports needsClient = false */
/** @typedef {{ kind: 'add-label'|'remove-label', number: number, label: string }
 *   | { kind: 'comment', number: number, body: string }
 *   | { kind: 'upsert-comment', number: number, marker: string, body: string }
 *   | { kind: 'create-issue', title: string, body: string }
 *   | { kind: 'close-issue', number: number, comment: string }} Action */
/** @typedef {{ conclusion: 'pass'|'fail'|'skip', errors: string[], warnings: string[], details: string, actions: Action[] }} ValidatorResult */
```

| Export | Contract |
|---|---|
| `runValidator(validator, { argv, env, scriptUrl }) → Promise<void>` | Payload path is `argv[2]`, else `env.GITHUB_EVENT_PATH`. Builds the context (`root` from `config.repoRoot(scriptUrl)`, client from `createClient({ env })` unless the validator exports `needsClient = false`, in which case no client is built and `ctx.client` is `undefined`), calls `collect` then `evaluate`, then `applyActions` for any actions. Appends `renderSummary` to the file at `env.GITHUB_STEP_SUMMARY` (stdout when unset, for local runs). Sets `process.exitCode`: `pass`/`skip` 0, `fail` 1, any thrown error 2 with the message in the summary. Any conclusion other than `pass`, `skip` or `fail` exits 2 before actions run. `GITHUB_EVENT_NAME` and `GITHUB_REPOSITORY` are required. A failed summary write exits 2. |
| `applyActions(actions, ctx) → Promise<void>` | Executes actions in order. `upsert-comment` edits the newest comment by `github-actions[bot]` carrying the marker, or creates one. Throws `GitHubError` on the first failure. |
| `renderSummary(validatorName, result) → string` | Markdown: conclusion, errors, warnings, details. |

#### `scripts/ci/*.mjs` validators

Every validator module exports `name` (the summary title), `collect(ctx) → Promise<Facts>` (all I/O, may throw), `evaluate(facts, config) → ValidatorResult` (pure, never throws for content) and optionally `needsClient` (default `true`; `check-results` exports `false` because its job has no `GITHUB_TOKEN`, 8.2), and ends with `if (import.meta.url === pathToFileURL(process.argv[1]).href) await runValidator(...)`. Run as `node scripts/ci/<name>.mjs [<event payload path>]` with the standard Actions env (`GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, `GITHUB_API_URL`, `GITHUB_STEP_SUMMARY`). They report only through the exit code and `$GITHUB_STEP_SUMMARY`: no annotations, no PR comments. The three actor scripts (`issue-format`, `protected-labels`, `failure-alert`) also perform their `actions`, and pass once those succeed.

Pass-through is decided in `collect`: for an event the row below maps to `skip`, `collect` makes no API call and returns the validator's facts with `eventName` set and every other field `null` or empty; `evaluate` then returns conclusion `skip`. Facts per validator (every one carries `eventName`):

```js
/** @typedef {{ filename: string, previousFilename: string|null, status: string, additions: number, deletions: number, patch: string|null }} PrFile   patch null when GitHub omits it */
/** @typedef {{ number: number, title: string, body: string, draft: boolean, author: string, headRef: string,
 *   headRepo: string, headSha: string, labels: string[], validLabels: string[] }} PrFacts   headRepo is owner/name */
/** @typedef {{ eventName: string, action?: string|null, repo: string, pr: PrFacts|null, closingRefs: Array<{ keyword: string, owner: string|null, repo: string|null, number: number }>,
 *   issue: IssueFacts|null, noIssueLabeledAt: string|null, headArrivedAt: string|null, files: PrFile[], stateTemplate: string|null }} PrMetadataFacts
 *   issue: the single closing reference's issue, else null; files: only for Spike issues, else []; headArrivedAt: the newest arrival on the PR branch (repository activity timestamp; its SHA must be the head), or a later head_ref_force_pushed, reopened, base_ref_changed or automatic_base_change_succeeded event, read only when no-issue is present on a PR whose head repository is this one; action: the payload action, `synchronize` and `reopened` void no-issue */
/** @typedef {{ eventName: string, author: string|null, validLabels: string[], files: PrFile[] }} PrSizeFacts */
/** @typedef {{ eventName: string, validLabels: string[], files: PrFile[] }} TestIntegrityFacts */
/** @typedef {{ eventName: string, needs: Record<string, { result: string }>|null }} CheckResultsFacts   null when NEEDS_JSON is absent or invalid */
/** @typedef {{ eventName: string, touched: boolean, repoKind: 'control'|'project', desired: DesiredState|null, loadError: string|null,
 *   live: Record<string, LiveSection>, signals: Signals|null, baseSettings: object|null }} SettingsPlanFacts   loadError: the SettingsError message */
/** @typedef {{ eventName: string, action: string, issue: { number: number, author: string, type: IssueType|null, body: string, labels: string[] },
 *   markerCommentExists: boolean }} IssueFormatFacts */
/** @typedef {{ eventName: string, action: string|null, number: number|null, label: string|null, sender: string|null, labels: string[] }} ProtectedLabelsFacts   action is the payload action of a handled event, else null; label and sender are null for skipped, synchronize and reopened events; labels: PR label names, read only for synchronize and reopened; a labeled event with a missing sender, label or number, or a synchronize or reopened event with no pull_request.number, throws */
/** @typedef {{ eventName: string, workflowPath: string, workflowName: string, conclusion: string, runUrl: string,
 *   openAlert: { number: number }|null }} FailureAlertFacts */
```

Tests: `scripts/ci/<name>.test.mjs` runs every case in `scripts/ci/fixtures/<name>.json` (an array, one file per validator to keep PRs within the file limit). A case is either `{ "description", "facts", "expected" }`, run through `evaluate` only, or `{ "description", "eventName", "payload", "env": {}, "routes": {}, "expected" }`, run through `collect` with `createFixtureClient(routes)` and then `evaluate`. `expected` is `{ "conclusion", "errorsInclude": [], "actions": [], "warningsInclude": [], "throws": "<substring>" }`; each `errorsInclude` and `warningsInclude` entry is a substring that must match one error or warning, and `throws` is a substring of the error a throwing case must raise. When `warningsInclude` is absent the runner asserts no warnings. Each rule in a row below has at least one failing and one passing `facts` case; each validator has at least one end-to-end case.

| Validator | Events | Reads | Fails when (or acts) |
|---|---|---|---|
| `pr-metadata` | `pull_request`; `merge_group` → `skip` | `loadIssueFacts` for the closed issue; PR timeline; repository activity for the PR branch (`/activity?ref=refs/heads/<branch>`, paginated) when `no-issue` is present on a same-repository PR, throws when no arrival is listed or the newest arrival is not the head SHA; PR files for Spikes; base `templates/state-section.md` from `root` | Any 8.3 rule; `no-issue` never exempts a `synchronize` or `reopened` run, nor a PR from another repository (`no-issue does not apply to PRs from another repository`). Head arrival reads the voiding events (8.2) from the timeline and the issue events endpoint (#109). Dependabot update type is the largest semver jump over every `from <a> to <b>` pair in title and body. Drafts get `## State` problems as warnings. |
| `pr-size` | `pull_request`; `merge_group` → `skip` | PR files (paginated); labels read live from the issue | Non-excluded additions plus deletions over `limits.prChangedLines`, or non-excluded files over `limits.prFiles`, without a valid `size-exception`. Exclusions: `sizeExcludeGlobs` plus `generatedGlobs`; a rename is excluded only when both names match an exclusion glob. Fails (exit 2) when GitHub lists fewer files than `changed_files` (3000-file cap). Exemptions (`pass`) by the `PR metadata` rule: valid `dependencies` with author `dependabot[bot]`, or valid `automated` with the release bot as author (8.3). |
| `test-integrity` | `pull_request`; `merge_group`, `push` → `skip` | PR files with `patch`; PR timeline | A `testGlobs` file deleted or renamed to a non-test path; a test file losing more `testDeclarationPatterns` lines than it gains; an added line matching a `suppressionPatterns` entry; a removed/added line pair in a `thresholdGlobs` file that differs only in numbers (any direction: tightening also needs the label); threshold numbers removed, or a threshold file deleted or renamed away; any file with additions whose patch GitHub omits (except removed files). Comment lines do not count as gained declarations. A valid `integrity-exception` turns failures into warnings. |
| `check-results` | any | none (`needsClient = false`); `env.NEEDS_JSON` (`toJSON(needs)`) | `needs` empty, or any job result other than `success`. |
| `settings-plan` | `pull_request`; others → `skip` | PR files (no `.github/groundwork/` change → `skip`); `loadDesiredState({ root: env.PR_ROOT })` from the PR head checkout (8.2); `readLiveState`; `readSignals`; base `settings.json` via the contents API for the Actions file diff (V4) | Only when the settings files fail `loadDesiredState`. Otherwise `pass` with the comparison table in `details` and one status line per live section in the optional `log` result field, which `runValidator` prints to stdout (#110). |
| `issue-format` | `issues`: opened, edited, reopened, typed, untyped | the issue's comments (marker `issue-format`) | Acts: invalid → `add-label needs-format` and `upsert-comment` with the errors; valid → `remove-label needs-format` and, if a marker comment exists, `upsert-comment` "No format errors.". Author `github-actions[bot]` → `skip`. |
| `protected-labels` | `issues`: labeled; `pull_request_target`: labeled, synchronize, reopened | payload only | Labeled: acts when `requiredLabelActor` is set and the sender differs: `remove-label` plus `comment` naming the required actor. Synchronize and reopened: `remove-label` plus `comment` when the PR carries `no-issue`, else no actions. |
| `failure-alert` | `workflow_run`: completed | open issues by `github-actions[bot]` carrying marker `alert:<workflow path>` | Acts: conclusion `failure`, `timed_out` or `startup_failure` → `create-issue` or `comment` on the open alert; `success` → `close-issue` on the open alert; anything else → nothing. |

---

## 14. Setup path

### 14.1 Once per organization (you, about 20 minutes; `docs/setup.md`)

Step IDs, their classes and the consent that governs them are in 14.3.

1. Create the free organization; enable 2FA requirement and the settings in 2.5.
2. Copy the control repo into the organization by clone and push (`repo-copy`, 14.3). The `wimdotgg` instance instead transferred `wianvdm/groundwork` (now `wimdotgg/groundwork`). The template flag is unused, since `bootstrap` reads the release tree. Its `main` must already contain `admin-run.yml`: nothing below works before that.
3. Create `wimdotgg-agent` as an organization-owned App (2.2; `docs/setup.md`), install it on the org with All repositories, and store its key on the agent machine. Your own `gh` and Git Credential Manager login may stay on that machine; the client-side rules in 2.1 stop accidental use of it (section 21, "2026-11-22: Phase 5 contract (#216)").
4. Create `wimdotgg-admin` and `wimdotgg-release` as organization-owned Apps (no manifests; `docs/setup.md` gives the manual form) and install both on the org with All repositories. The slugs are recorded in `config.json`.
5. In `groundwork`, create environment `admin` (reviewer you, deployment branch `main`, selected-branches policy, "Allow administrators to bypass" off) and store both App keys and their App IDs or client IDs there.
6. Approve `admin-run op=create-issue-types`, then `admin-run op=apply-settings --repo groundwork --ref <main sha>`. The second run creates groundwork's `release` environment with its key, sets `GROUNDWORK_READY`, applies the rulesets and ends with `check`. From here `main` is protected; the agent runs `request.mjs probe --repo groundwork` to confirm.
7. The agent dispatches `release-please.yml` once (or any PR merges); you merge the resulting release PR so `v0.1.0` exists. Bootstrap refuses to run without a release tag, because projects pin reusable workflows to one.

### 14.2 Per project

1. Agent runs `scripts/admin/request.mjs bootstrap --repo <name> --args '{"description":"..."}'`. You approve.
   Bootstrap pass 1, in this order:
   1. Inspect the repo (`inspectRepo`, 13.1) with the control-repo read grant (12.1). `foreign` fails the run before any write, unless `args` holds `"adopt": true` and the adopt preflight passes (14.4): an existing repo with no `kit-version.txt` that is not the `auto_init` state of this App (one commit by the admin App bot, default branch `main`, only `README.md`), an empty repo and a non-`main` default branch included. `ours` or `fresh` resumes: every later step is idempotent.
   2. Resolve the tag and read its tree (`readReleaseTree`, `readBlobTexts`), same grant. `absent`, `fresh` and an adopted `foreign` (14.4): `latestReleaseTag`. `ours`: the tag in the target's `kit-version.txt` on `main`, so steps 4 to 8 and the closing `check` read the files `main` already holds even when a newer release exists.
   3. If `absent`, create the repo with `POST /orgs/{org}/repos` (`name`, `description`, `private: false`, `auto_init: true`) through `createRepo` with a token restricted to `groundwork` (2.4). `bootstrap` refuses a `target_repo` equal to the control repository (`bootstrap-pass2` accepts it: it only configures an existing repository).
   4. Create the labels from the built tree's `labels.json`, `dependencies` included (`applySections` `labels`, under a `PERMISSIONS` token on the target). This precedes step 5 so Dependabot never opens a PR before the label exists. An adopted `foreign` repository (14.4) only gets the kit labels it lacks here (`createMissingLabels`); its full sync, which changes and deletes project labels, runs right after the step 5 ref update.
   5. Push one commit `chore: bootstrap from groundwork vX.Y.Z` to `main` whose tree is the release tag's tree with these changes: `[control]` paths removed (`scripts/owner/` and `.claude/skills/groundwork-setup/` among them); every owner on `.github/CODEOWNERS` replaced by `@<accounts.owner>` read from the tree's own `config.json`, so a clone never keeps the upstream owner (a value that is not a GitHub login fails the build); placeholders `__ORG__`, `__REPO__`, `__DESCRIPTION__` replaced; `./.github/workflows/reusable-*.yml` references rewritten to `<org>/groundwork/.github/workflows/reusable-*.yml@<tag commit SHA> # vX.Y.Z` (`resolveTagCommit`; a tag reference fails zizmor `unpinned-uses` on the project's first `ci` run); `kit-version.txt` written; manifest `{}`, `version.txt` `0.0.0`, empty `CHANGELOG.md`; `scripts/verify` and `scripts/verify.cmd` replaced by the stub from `scripts/groundwork/stubs/` (read before `[control]` paths are dropped); the six deploy stubs written to `scripts/stubs/deploy/`; README and `docs/` replaced by project stubs (`LICENSE` and `SECURITY.md` are copied unchanged; `buildBootstrapTree`, `commitBootstrapTree`; the control-repo blobs are copied with `readBlobContents`). It replaces the `auto_init` commit's tree and needs Workflows write because workflow files change.
   6. Apply settings, environments (`release` with its key, `production` without deploy secrets), Actions and security settings (`applySections` `settings`). The settings source for steps 4 to 8 is one: the built tree's `.github/groundwork/` files (`settingsFiles`), the same files the step 5 commit puts on `main`.
   7. Apply rulesets **last** (`applySections` `rulesets`; they would reject step 5).
   8. Set `GROUNDWORK_READY=true` (`applySections` `variables`).
   9. Open the "Project setup" epic with its sub-issues from the release tree's setup templates, typed, linked as sub-issues, unaccepted (`openSetupEpic`).
   10. Run the labels group once more (GitHub seeds its default labels asynchronously, V21), then `check`; any failed row fails the run.
   Workflows triggered by step 5 before step 8: `ci.yml` passes on the stub, `release-please.yml` starts no run (no `push` trigger, 11). The `auto_init` commit carries no workflows (V13). A rerun on `ours` applies the labels, settings and rulesets of the tag in `kit-version.txt`, so it would delete labels a project added and reset settings the project changed by PR. It resumes only before the Project setup epic is accepted; once the epic is accepted or closed, the rerun refuses before any write and names `apply-settings` as the repair path (owner decision #167 Q4, option C; `findSetupEpic`, 13.1).
2. Agent runs `request.mjs probe --repo <name>` (section 13, no approval, as the agent App). The push to `main` must be rejected.
3. You apply `accepted` to "Project setup". Agents choose the stack, fill `scripts/verify`, add ecosystems to Dependabot, define hotspots, and write the README. If the project deploys, they move `scripts/stubs/deploy/` to `scripts/`, replace the bodies and list the production secret names in `settings.json` (setup task 04); otherwise they set `"deploy": "none"` in `config.json`.
4. Agent requests `bootstrap-pass2` (`target_repo` may be the control repository); you approve once. It fails if `scripts/verify` is still the stub. Then: CodeQL default setup, wait until the first CodeQL run on `main` completes (Actions read), add the `code_scanning` rule to the live `main` ruleset, and, unless `"deploy": "none"`, set `DEPLOY_ENABLED=true` and print the deploy secrets you must enter (tier 3 checklist) in the run summary. Projects bootstrapped from releases after `v0.5.0` get the rule in `rulesets/main.json` from the template; earlier ones add it through setup task 05. Pass 2 refuses without it, so `check` and later `apply-settings` runs agree with live; until CodeQL default setup is `configured`, `apply-settings` leaves that rule out and `check` reports it `deferred` (9.1). Once the live rule exists, `check` fails closed on default setup and `DEPLOY_ENABLED` (10). A release PR opened before pass 2 has no CodeQL run, so the new `code_scanning` rule blocks it until its branch gets a new head: close and reopen the PR so release-please pushes one, then approve it again (a merge-queue repository offers no "Update branch"). The run ends with `check`.

### 14.3 Onboarding: consent, setup state and the owner wizard

The `groundwork-setup` skill is the entry point for 2.5 and 14.1; `docs/setup.md` is the same path for harnesses without skills. The owner's answers in #251 `## Decisions` (2026-11-23) bind this section.

**Consent.** The skill asks one question before any other step:

> May I use your main GitHub account for setup? (A) No: I walk you through every step in the browser. (B) Partly: I prepare a wizard you run in your own terminal; it opens each page and asks y/N before each write, and I never hold your login.

- Only A and B are offered. No agent-started script runs under the owner login; the section 21 delegations were a bypass of the setup period and stay closed.
- Scope: answer B lets the owner wizard perform the `wizard` class steps below; under answer A the owner does them in the browser or with the commands `docs/setup.md` gives. `app` and `browser` steps are the same under both answers.
- Always excluded, under either answer: billing, org ownership, deletions, agent App key rotation and `admin` environment approvals. They stay in the browser.
- End: consent ends when setup ends, that is when `release-merge` is `done`. The wizard refuses every step after that; later tier 3 work goes back to the browser.

**`setup-state.json`.** The record of the answer and of progress. On Windows it is `%APPDATA%\groundwork\setup-state.json`, beside the agent key (2.2); elsewhere it is the file named by `GROUNDWORK_SETUP_STATE_FILE`, which also wins on Windows when set. With neither, the skill and the wizard stop and name the variable. The file is a record, not a control: an agent session can write that directory.

```json
{
  "schemaVersion": 1,
  "org": "<org>",
  "consent": { "answer": "B", "classes": ["wizard"], "answeredAt": "2026-11-23T09:00:00Z", "endedAt": null },
  "steps": {
    "org-create": { "status": "done", "updatedAt": "2026-11-23T09:05:00Z", "note": "" }
  }
}
```

- `schemaVersion` is `1`. `org` is the org login, filled once `org-create` is done, `null` before.
- `consent.answer` is `"A"` or `"B"`; `consent.classes` is `["wizard"]` for B and `[]` for A. `answeredAt` and `endedAt` are ISO 8601 UTC; `endedAt` is set when `release-merge` turns `done` and lives only in this file.
- `steps` maps a step ID to `status` (`pending`, `done` or `skipped`), `updatedAt` (ISO 8601 UTC) and `note` (free text, required for `skipped`, for example "done before setup"). A missing ID means `pending`.
- Resume point: the first step in table order that is neither `done` nor `skipped`. The wizard marks its own steps; a `browser` step turns `done` once the owner confirms its verify check; the skill marks `app` steps after the run or command succeeds. A step turns `skipped` only when the owner says, at the step's start, that it is already done, and gives the note.
- Validation, because an agent can write the file and the wizard reads it under the owner login: the wizard refuses a file that fails this schema (unknown keys, other `schemaVersion`, unknown step IDs or statuses), accepts `org` only as `^[A-Za-z0-9-]+$` and every timestamp only as ISO 8601 UTC, strips control characters from every string it prints (`note` included), and never takes a command, URL or path from the file. URLs and commands are built from `org`, the step table and constants.

**Step IDs.** Every setup step of 2.5, 14.1 and tier 3 has exactly one class: `app` (the agent or admin App, tier 0 or 2), `wizard` (the owner wizard under answer B) or `browser` (the owner on a GitHub page; the wizard and the skill only open it and name field and value). Approving an `admin` run is a browser action inside an `app` step.

| ID | Source | Class | Step |
|---|---|---|---|
| `org-create` | 14.1.1 | browser | Create the free organization |
| `org-2fa` | 2.5 | browser | Require two-factor authentication (not settable over REST) |
| `org-base-permission` | 2.5 | wizard | Base permission Read; members cannot create repositories (`PATCH /orgs/{org}`; needs `admin:org`) |
| `org-pat-policy` | `docs/setup.md` | browser | Fine-grained token approval policy (no REST endpoint sets it) |
| `org-actions` | 2.5 | wizard | Actions: SHA pinning, approval for external contributors' fork PRs, Actions may not approve PRs (needs `admin:org`) |
| `org-team-agents` | 2.5 | browser | Delete team `agents` if it exists; a new org has none |
| `repo-copy` | 14.1.2 | wizard | Copy the control repo into the org from the owner's clone of upstream (below) |
| `app-agent` | 14.1.3 | browser | Create the agent App on the manual form; install it with All repositories |
| `agent-key-store` | 14.1.3 | wizard | Store the agent key and its metadata (2.2): on Windows `%APPDATA%\groundwork\<slug>.pem.dpapi` and `<slug>.json` with `appId`, `slug` and `clientId`; elsewhere a PEM at `GROUNDWORK_AGENT_KEY_FILE` plus `GROUNDWORK_AGENT_CLIENT_ID`, whose lines the wizard prints for the owner's shell profile |
| `app-admin` | 14.1.4 | browser | Create and install the admin App |
| `app-release` | 14.1.4 | browser | Create and install the release App |
| `admin-environment` | 14.1.5 | wizard | Environment `admin`: reviewer the owner, `main` only, administrators cannot bypass |
| `admin-secrets` | 14.1.5, tier 3 | wizard | `ADMIN_APP_KEY`, `RELEASE_APP_KEY` and the two App ID or client ID variables |
| `issue-types` | 2.5, 14.1.6 | app | `request.mjs create-issue-types` |
| `apply-settings` | 14.1.6 | app | `request.mjs apply-settings --repo groundwork --ref <main sha>`, then `probe` |
| `release-dispatch` | 14.1.7 | app | Dispatch `release-please.yml` |
| `release-merge` | 14.1.7 | browser | Merge the release PR so `v0.1.0` exists; setup ends here |

App creation uses the manual form (Q5 A): the wizard opens `https://github.com/organizations/<org>/settings/apps/new` and lists the permissions of 2.2 to 2.4. It asks for each App ID and client ID at the step that writes them (`agent-key-store`, `admin-secrets`), since `setup-state.json` has no field for them; the skill checks that the created slug matches the one `repo-copy` wrote. Tier 3 work outside setup (billing, org ownership, key rotation, per-project deploy secrets) has no step ID and stays in the browser.

`repo-copy` first checks the clone and refuses unless the branch is `main`, `git rev-list <baseline>..HEAD` is empty (no local commit the upstream ref lacks; baseline as in "Reviewed code only" below) and whole-tree `git status --porcelain` lists only the consent note. A rerun after a declined y/N or a failed push also accepts as modified exactly the paths `repo-copy` writes, and one commit ahead of the baseline only when its diff touches only those paths; that commit is printed before the push y/N. Any other dirty or ahead state refuses and prints `git restore .`, `git reset --hard <baseline remote>/main` and each untracked file to delete; the decision never reads `setup-state.json`. `.git/config` may set only keys that run no program (`core.repositoryformatversion`, `filemode`, `bare`, `logallrefupdates`, `symlinks`, `ignorecase`, `autocrlf` and `precomposeunicode`; `remote.*.url`, `fetch` and `gh-resolved`; `branch.*.remote`, `merge` and `rebase`; `user.name` and `email`); any other key, such as `gpg.program`, a credential helper, `core.sshCommand`, a filter, `diff.external` or an include, is refused by name, with the `git config --local --unset-all '<key>'` line that removes it. The wizard checks this at start (below), and `repo-copy` again before its own git commands. Then, in order, each write behind its own y/N: rename the clone's `origin` (upstream) to `upstream`, which upstream updates use later; write `.github/groundwork/config.json` (`org`, `accounts.owner`, `accounts.agent` as `<agent slug>[bot]`, the three `apps` slugs the owner plans to create) and the owner in `.github/CODEOWNERS`; reset the release files as bootstrap does for projects (11, 14.2 step 5): `.release-please-manifest.json` `{}`, `version.txt` `0.0.0`, empty `CHANGELOG.md`, so the first release is `v0.1.0`; print the consent note (control characters stripped) and the staged diff, stage exactly those paths by name (never `git add -A` or `commit -a`) and commit them as one commit `chore: set up <org> from groundwork <tag>` on top of the upstream history, under the owner's own Git identity (printed before the y/N; a `[bot]` identity is refused), where `<tag>` is `git describe --tags --abbrev=0 upstream/main`, or the upstream short SHA when no tag is reachable; then `gh repo create <org>/groundwork --public --source . --remote origin` (no `--push`: gh's own `git push` would run the clone's hooks), a check that `origin` pushes to `github.com/<org>/groundwork`, `gh repo set-default <org>/groundwork` (the clone keeps `upstream`, which `gh` resolves first without a default, and `currentRepo()` in `scripts/lib/github.mjs` resolves through `gh`; it refuses an `upstream` that already holds `gh-resolved`, which a default set in the upstream clone carries over on the rename), and `git push --set-upstream origin main` through the wizard's hook-free Git. Upstream tags are not pushed.

**Consent record.** No epic exists during org setup (the "Project setup" epic is per project, 14.2), so the record in the control repo is a run note, `docs/runs/<YYYY-MM-DD>-setup-consent.md`, dated by `consent.answeredAt`. The skill writes it into the clone's working tree right after the answer, under A and B alike (it holds no secret); without the skill the owner copies it from `docs/setup.md`. `repo-copy`, by the wizard or by hand, commits and pushes it, so it lands with the first commit and needs no PR. It is written once. Fields, one line each: date (`consent.answeredAt`); answer (A or B); classes (`[wizard]` or `[]`); always-excluded actions; end condition (`release-merge` done); the `setup-state.json` `schemaVersion`. No org: `org` is `null` when the note is written, and the `repo-copy` commit carries it in `config.json`. Progress is not in the note; it lives in `setup-state.json`.

**Owner wizard.** `scripts/owner/setup.mjs`, on a CODEOWNERS path (9.4) and `[control]` (3), run by the owner in their own terminal: `node scripts/owner/setup.mjs [--step <id>]`.

- Walk: without `--step` it starts at the resume point, performs `wizard` steps, opens the page of each `browser` step and waits for the owner's confirmation, and stops at the first `app` step, naming the request the agent makes. `--step <id>` runs one `wizard` or `browser` step; an unknown ID or an `app` step is refused.
- Refusals, checked before anything else: stdin or stdout is not a TTY; `GH_TOKEN` is set (`token.mjs exec` sets it; the wizard needs the owner's own login); `GH_CONFIG_DIR` ends in `.claude/gh-agent` after separator normalisation; `CLAUDECODE` is set (an agent session started outside the repository loads neither the deny rule nor `GH_CONFIG_DIR`).
- Reviewed code only: the wizard imports only Node built-ins, `scripts/owner/` and `scripts/lib/`, all CODEOWNERS paths; it never imports `scripts/agent/` (unprotected, 9.4), so the DPAPI write is its own. At start, before any other git command, it lists `git config --local --name-only --list` (reading the config runs nothing it names) and refuses a key outside the `repo-copy` allowlist above, so a local filter or `diff.external` never runs under the owner login. It then prints `HEAD` and refuses when `git status --porcelain -- scripts/owner scripts/lib` is not empty or when those paths differ from the baseline: `origin/main` when a remote `origin` exists and `refs/remotes/origin/main` resolves (upstream before `repo-copy`, the org's repository after it), else `upstream/main` (inside `repo-copy`, between the rename and the push, including after `gh repo create` added `origin` but the push failed). The wizard decides it from `git remote`, never from `setup-state.json`, and compares against the ref as last fetched; it runs no `git fetch` and prints the baseline SHA. That stops an accidental run of agent-edited code; a tampered wizard can drop its own check (17).
- Writes: every change to GitHub, a file or the Git repository is shown as the exact command or change, then a `y/N` prompt. Anything but `y` leaves the step `pending` and ends the walk, because later steps depend on earlier ones; the next run resumes there.
- Secrets: typed values are read with hidden entry. A PEM key is read from a file path the owner types at the prompt (never from the state file). Either way the value goes to `gh secret set` on stdin and never appears in arguments, logs, a new file, `setup-state.json` or an agent session. After `admin-secrets` the wizard offers, y/N, to delete the downloaded admin and release PEMs (2.1: their keys live only in the `admin` environment); on Windows it offers the same for the agent PEM once `agent-key-store` has written the DPAPI file.
- `admin:org`: the scope changes are credential state, not writes, and take no y/N. At start the wizard reads `gh auth status` and removes a leftover `admin:org` from an earlier run. It adds the scope with `gh auth refresh -s admin:org` only before `org-base-permission` or `org-actions`. Every run that added it ends, on success, refusal, error or interrupt (Ctrl+C), with `gh auth refresh --remove-scopes admin:org`, then reads `gh auth status` again and prints whether the scope is gone; if it is not, it prints the command and exits non-zero. No logout: the owner login stays (2.1, 17).

### 14.4 Adopting an existing repository

Bootstrap adopts a `foreign` repository in place only when the owner opts in: `request.mjs bootstrap --repo <name> --args '{"description":"...","adopt":true}'`. `adopt: true` on `ours` resumes as usual; on `absent` or `fresh` it is refused, since there is nothing to adopt. The owner's guide is `docs/adopt.md`.

- Preflight in `plan`: the `bootstrap` module's `plan` hook (12.1) inspects the target with the `plan` job's token and prints the report in the run summary, so the owner reads it before approving. Failing rows: a default branch other than `main`; an empty repository; an archived repository; `protected` set on `main` in `GET /repos/{o}/{r}/branches/main` (rulesets replace branch protection; removing it is a browser deletion); a collision: a path of the built kit tree (14.2 step 5 rules) that exists in the target with other content, except `README.md` and `LICENSE` (the project's are kept) and `.github/CODEOWNERS` (kit lines are appended); and a root or `docs/` CODEOWNERS without `.github/CODEOWNERS`, which the kit file would shadow (the project moves it to `.github/` by PR, keeping its rules, and reruns). Reported rows, which do not fail: project labels the label sync deletes, existing `v*` tags, environment names, the count of open issues that fail `issue-format`, and the root license files, or none (adopt never adds a `LICENSE`, beside a license file or in place of a missing one: owner decision, #258; the repository owner picks one). Not read: merge settings (pass 1 sets squash-only regardless) and secret names (they need a Secrets grant bootstrap does not hold; the report says to check them in the browser). No grant is added to 12.1.
- `apply` repeats the failing rows before any write call and stops on any of them. Step 1.2 on an adopted `foreign` repository resolves `latestReleaseTag`.
- An adopted repository never gets the step 5 full-tree commit, which posts a tree without `base_tree` and would drop every project file from `main`. The kit merge replaces it: the step 5 tree is written over the tree the preflight read (`base_tree`, `adoptTreeEntries`, `commitAdoptTree`), keeping every project path the kit does not ship, the project's license files, its readme (the kit `README.md` goes in only when the root holds no readme in any case or extension) and its CODEOWNERS lines with the kit lines appended. The commit's parent is the head the preflight read. Apply compares `main` with that head before its first write and again before the commit; a moved `main` refuses. Step 4 is split: before the commit apply only creates the kit labels the project lacks, `dependencies` included, and the full label sync (updates and deletes of project labels, which cannot be undone) runs after the `force: false` ref update succeeds. A refused commit therefore leaves at most new kit labels behind, never a changed or deleted project label. `plan` and the apply summary print that head. Every other pass 1 step runs as on `fresh`.

---

## 15. Harness integration

- `AGENTS.md` is canonical; `CLAUDE.md` is `@AGENTS.md`.
- `.claude/settings.json`:
  - Hooks: `Stop` and `PreCompact` run `node scripts/agent/token.mjs exec -- node scripts/agent/checkpoint.mjs --auto`. They need Node 24 first on PATH and learn the session from `GROUNDWORK_SESSION` or their stdin `session_id` (13). The hooks fire in the top-level session only, not in subagents.
  - Deny rules for the dangerous forms: `git push` with `-f`, any `--force` flag (including its lease variant) or a `+` refspec; `git rebase` and `git pull --rebase`; `git push` to `main`; `--no-verify` and `git commit -n`; `gh pr merge --admin`; `gh api` calls with `-X` or `--method` against `rulesets`, `environments`, `secrets`. The `git` rules have a bare form and a `token.mjs exec --` wrapped form; the `gh` rules need only the wrapped form, because every bare `gh` is denied. The `gh api` denies match the method flag (`-X*`, `--method*`, any method) before or after the path. The `git -C * push` wrapped denies cover `--force`, `-f`, `main` and `+` refspecs. A bare `git -C * push` is denied outright. The wrapped `gh api` denies also cover `-f`, `-F`, `--field`, `--raw-field` and `--input` against `rulesets`, `environments` and `secrets` (default POST without a method flag). Wrapped rules match only the literal prefix `node scripts/agent/token.mjs exec -- `, and a `-X` or `--method` flag placed after other flags can slip past the method-first rules: both stay owner follow-ups outside Phase 4.
  - Deny rules for bare calls, so nothing skips the wrapper: `git push` (also `git -C * push`) and every `gh` or `gh.exe` invocation (`gh`, `gh *`, `gh.exe`, `*gh.exe *`, `*/gh *`, `*\\gh *`). The two path rules require a separator right before `gh` (the backslash rule is `Bash(*\\gh *)` in the rule syntax and `"Bash(*\\\\gh *)"` in the JSON file), and `*gh.exe *` requires `gh.exe`, so no rule matches `node scripts/agent/token.mjs exec -- gh ...`; they also deny a wrapped `gh.exe` with arguments or a path-qualified `gh`, which no wrapped rule would catch. Besides the dangerous forms above, the wrapped `gh` form is denied for the credential, config, alias and extension forms of 17.
  - Agents write only through `node scripts/agent/token.mjs exec -- <command>`, including `claim`, `checkpoint` and `release`, `gh pr ready` and the enqueue; `AGENTS.md` also caps write pace (5 issue creations and 10 comments per minute).
  - Allow rules for `node scripts/agent/*`, `node scripts/human/inbox.mjs` (with or without arguments), `node --test *`. Deny rules for starting the owner wizard (14.3): `Bash(*node*scripts/owner/setup.mjs*)` and the backslash form `Bash(*node*scripts\\owner\\setup.mjs*)` (`"Bash(*node*scripts\\\\owner\\\\setup.mjs*)"` in the JSON file). They match command text, so any shell command naming the wizard after `node` is denied; reading, editing and testing `scripts/owner/` stay allowed. A wrapped line that names the file after `node` is refused too, so stage with `git add scripts/owner/`. The rules miss a `cd scripts/owner && node setup.mjs` form, a glob (`node scripts/owner/set*.mjs`), a case variant and, unverified, a PowerShell tool, which `Bash(...)` rules do not match; the wizard's refusals (14.3) still stop those.
- Codex and other harnesses: the same rules in `AGENTS.md`; no hook enforcement.
- Recommended runtime (documented, not built): one planner session per epic, up to 4 worker sessions each in its own git worktree, one reviewer session; reviewer on a different model from the workers.

---

## 16. Limits

| Limit | Value | Enforced by |
|---|---|---|
| Hierarchy depth | 2 (3 via intermediate Feature) | `plan-lint`, `next`, `PR metadata` |
| Sub-issues per parent | 12 | `plan-lint` |
| Issues per PR / PRs per issue | 1 / 1 | `PR metadata`, claim ref |
| PR size | 400 changed lines, 20 files | `pr-size` |
| Tasks per worker | 1 | `claim` |
| Active workers | 4 (configurable) | documented runtime |
| Draft lease | 4 hours (`draftLeaseMinutes: 240`) since the last agent comment on the PR | `next`, `claim` |
| Claim ref without a PR | 15 minutes | `next`, `claim` |
| Review rounds | 3 | `AGENTS.md`, reviewer |
| Same failure | 3 attempts | `AGENTS.md` |
| CI reruns | 1, then `flaky` issue | `AGENTS.md` |
| Merge queue group | build 3, merge up to 3; 1 automatic re-enqueue | ruleset, `AGENTS.md` |
| `## State` | ~40 lines | `checkpoint` |
| Journal comment | 10 lines | `checkpoint` |
| `resume` output | ~300 lines | `resume` |

---

## 17. Security model

- **Credentials on the agent machine:** the agent App key (DPAPI-encrypted on Windows) is the only one agents use; the tokens it mints cannot change settings, rulesets, environments or secrets. Your `gh` and Git Credential Manager login may also be present, and GitHub does not stop it acting on `groundwork` (probes #214 and #215). Separation is client-side: agent scripts refuse to call GitHub unless `GH_TOKEN` is set, which `token.mjs exec` does (13.1), and `.claude/settings.json` points `GH_CONFIG_DIR` at a directory with no `hosts.yml`, sets `GCM_INTERACTIVE=never` and denies every bare `gh` and `gh.exe` call outright (also a path-qualified `.../gh` or `.../gh.exe`), so a `gh` typed as itself never reaches the keyring login, and a name added later, such as an alias or an extension, needs no new rule. Open cases: a case variant (`GH`, `Gh`: Windows resolves the command name without case, the rules match it with case; the old per-name rules had the same gap) and a shell wrapper (`bash -c "gh ..."`, `sh -c`, `eval`). `env gh`, `command gh`, `xargs gh`, chained commands and subshells are denied. The wrapped form `token.mjs exec -- gh ...` stays allowed: it runs with `GH_TOKEN` set, and gh documents that this token takes precedence over stored credentials for `github.com` (`gh help environment`), so a wrapped command aimed at `github.com` never reads the keyring (`GH_HOST` is the open case below). These wrapped forms stay denied because they act beyond one API call: `gh auth token`, `gh auth git-credential` and `gh auth status --show-token` print the installation token, `gh auth login`, `gh auth setup-git`, `gh auth refresh` and `gh auth switch` change credential state, so the one rule `gh auth*` covers them all (`setup-git` writes the global Git config, where the helper would outlive the wrapper), `gh config set` and `gh alias set|import` persist config that later runs without the wrapper (a `!` alias is a shell command that no Bash rule sees, and `gh config set` writes the `hosts.yml` that makes gh list a host), and `gh extension`, `gh ext`, `gh extensions`, `gh copilot` and the stubs `gh aw`, `gh stack` and `gh webhook` download and run foreign code with `GH_TOKEN` (the stubs install an official extension when gh can prompt or `CI` is set; read from the gh v2.102.0 source, not executed). `gh release download` and `gh attestation` (alias `gh at`) are allowed wrapped: they fetch or verify data with `GH_TOKEN` like any read. Bare, they skip gh's auth check, which the blanket deny now covers. The keyring token stays readable to a hand-copied extension in the extensions directory, the open case. Any `gh` command that passes the auth check reads that keyring token once gh lists a host, which `GH_HOST` does for one call and a `hosts.yml` under `GH_CONFIG_DIR` does for good; `gh config set` writes that file, so it is denied, and `.claude/gh-agent/` is gitignored. `GH_HOST` and an overridden `GH_CONFIG_DIR` are environment, not command text: no deny rule can match them. These rules stop accidental ambient use, not a deliberate bypass: the deny rules match command text, and `GH_TOKEN` is not checked for origin.
- **Owner wizard:** the one use of your login that groundwork ships, during org setup only (14.3). You start it in your own terminal; it refuses without a TTY, with `GH_TOKEN` or `CLAUDECODE` set or with `GH_CONFIG_DIR` ending in `.claude/gh-agent`, asks y/N before every write, holds `admin:org` only for its run and removes it at the end. A deny rule keeps agent sessions from starting it, `AGENTS.md` forbids it, and CODEOWNERS keeps agent PRs from changing it or the `scripts/lib/` code it imports unreviewed. Your login stays on the machine; consent ends when setup ends. Open cases: CODEOWNERS gates what merges, not the checkout you run, and agents may edit `scripts/owner/` in a working tree; the wizard's clean-tree and `main` comparison stops the accidental case, but a tampered wizard can drop its own check, so run it from a checkout of reviewed `main`. On Windows, Node looks for a bare command name in the working directory before `PATH`, so a `git.exe`, `gh.exe` or `rundll32.exe` at the repository root (an unprotected path the clean-tree check never reads) would run under your login; the wizard sets `NoDefaultCurrentDirectoryInExePath` before its first call to close that lookup. `repo-copy` pushes the clone as the new org's `main` before any ruleset or CODEOWNERS gate exists there; its branch, no-local-commit and clean-tree checks and the printed note and diff stop the accidental case only. The deny rules miss the `cd`, glob, case and PowerShell forms (15). `setup-state.json` is agent-writable input, so the wizard validates it and takes no command, URL or path from it.
- **Secrets:** values come from you, in the browser or, during org setup, through the owner wizard's hidden prompt or a key file path you type, piped to `gh secret set` on stdin; they never pass through an agent session. They live only in environments restricted to `main`, `v*` tags, and (for `admin`, `production`) your approval. PR runs reach none of them.
- **Required checks:** pinned to the GitHub Actions app; the agent cannot post fake results (no Checks or Statuses write). A workflow that fakes a check name must be in the PR's own head commit, which puts it under `.github/` and behind your approval.
- **Rules the PR is judged by:** validators run from the base commit; workflow changes need your CODEOWNERS approval.
- **Protected labels:** validity comes from the labeling actor in the timeline, never from label presence (section 5).
- **Admin runs:** `admin-run.yml` and built-in ops always execute from `main`; the code they run (`.github/`, `scripts/groundwork/`, `scripts/lib/`, `admin-ops/`) reaches `main` only with your CODEOWNERS approval (9.4); `ref` inputs must be reachable from `main`; you see the script and its hash before approving.
- **Untrusted text:** D16, 6.7.
- **Supply chain:** actions pinned by SHA (repo-enforced); Dependabot with cooldown; osv-scanner, dependency review, gitleaks, CodeQL, push protection.
- **Accepted residual risks:** an agent running as your OS user could in principle read browser session data; one App identity means agents are distinguished only by session id; `pull_request` workflow YAML comes from the PR (gated by CODEOWNERS at merge, not at run); the agent App has Contents write, so an agent can delete another worker's `issue/*` branch (deletion stays allowed for `delete_branch_on_merge` and orphan cleanup; history is recoverable from the PR; overwriting is blocked by the `issue-branches` ruleset, 9.5); the release App key sits in every project's `release` environment without a reviewer, protected only by the `main`-only policy and CODEOWNERS on `.github/`.

---

## 18. Out of scope and later

**Out of scope:** language-specific tooling beyond the `scripts/verify` contract; infrastructure-as-code, databases, migrations and backups (rollback covers code, not data); private or sensitive code; multi-person teams; monorepos with several deployables; app-store and signed desktop builds; the agent runtime itself.

**Later:** preview deployments per PR; production monitoring beyond failure alerts; a metrics view (rework rate, flake rate, queue ejections, time to merge); optional quality gates in `scripts/verify` (coverage floors, performance budgets, accessibility, visual regression); a separate rules repo (D3); moving `isUnder` and `namesHotspot`, exported from `agent/next.mjs` for `plan-lint`, into `scripts/lib`; a `review-queue` change that counts reviews from a separate reviewer App (`apps.reviewer`).

---

## 19. Assumptions to verify before or during implementation

Phase 0 ran on `wimdotgg/probe` (archived; links stay valid). Result values: verified, redesigned (the design changed to fit what GitHub does), known gap (checked and not confirmed, with a Bug), pending. At v1 done every row is verified or redesigned.

| # | Assumption | How to verify | Result |
|---|---|---|---|
| V1 | Merge queue is available for public repos in a free organization | Enable on a throwaway repo in the new org | Verified: [probe#1](https://github.com/wimdotgg/probe/pull/1) merged through a `merge_group` [run](https://github.com/wimdotgg/probe/actions/runs/43862619217). |
| V2 | `require_code_owner_review` with 0 required approvals blocks a protected-path PR until the code owner approves | Throwaway repo test | Verified: [probe#2](https://github.com/wimdotgg/probe/pull/2) blocked until code-owner approval, then merged through the queue by auto-merge. |
| V3 | `POST /git/refs` on an existing ref fails with 422 (any non-201 is treated as not claimed) | Script test against throwaway repo | Verified: 201, then 422 "Reference already exists". `selftest` re-ran it on a throwaway repository ([run 44954106536](https://github.com/wimdotgg/groundwork/actions/runs/44954106536)). |
| V4 | Rulesets are readable with Metadata read (documented); environments and Actions settings are readable enough for tier 1 plans with the PR `GITHUB_TOKEN` | API test from a PR run | Redesigned: rulesets readable; environments, `actions/permissions`, team access, security and variables return 403 to the PR `GITHUB_TOKEN`, even with `actions: read` (V17), so `settings-plan` shows those sections as a file diff (8.2). Environments are treated like Actions settings; the `check` at the end of each `apply-settings` run is their live verification. |
| V5 | A fine-grained PAT for a machine user, resource owner the org, can hold Workflows and Actions write; it can set issue types, sub-issues and dependencies with Issues write; check runs are readable without a Checks permission | Create the PAT, run `claim` and the planner once | Verified: the agent PAT set an issue type, `--parent`, `--blocked-by`, read check runs and enqueued a PR. Retired in `v0.2.0`: the `wimdotgg-agent` App does the same with its own permissions (2.2), and no PAT exists. |
| V6 | Org-admin `pull_request` bypass lets you merge your own protected-path PR without lifting rules for agents | Throwaway repo test | Verified: [probe#6](https://github.com/wimdotgg/probe/pull/6) merged by the owner through the bypass; the bypass also skips the merge queue (9.1). |
| V7 | A `wimdotgg-admin` installation token with repository Administration write (no organization Administration) can create an organization repository with `POST /orgs/{org}/repos` while members cannot create repositories; whether that token may be repository-scoped (to `groundwork`) or must be installation-wide; the request-body key for the Issue types organization permission | `selftest`, first bootstrap | Verified: the permission key `issue_types` is confirmed by the API `X-Accepted-GitHub-Permissions` header. The create call works with a token restricted to `groundwork` and Administration write: [run 44898366229](https://github.com/wimdotgg/groundwork/actions/runs/44898366229) created `gw-p4-b` (and [run 44893580095](https://github.com/wimdotgg/groundwork/actions/runs/44893580095) `gw-p4-a`), so `createRepo` has no installation-wide variant (2.4). The tier 2 elevation path itself is verified: PAT 403 on admin calls, owner approval gate, reject stops the run, non-`main` dispatch refused, no self-approval, minted token cannot reach another repo. |
| V8 | Check names: caller-level jobs report under their own name (`Check`, `PR metadata`, `pr-size`); jobs calling reusable workflows report as `<caller job> / <called job>` | First CI run in `groundwork` | Verified on `probe`: `Check`, `PR metadata`, `pr-size`; a reusable call reports as `called / inner`. |
| V9 | `issues: labeled` and `pull_request_target: labeled` events triggered by the agent PAT start `protected-labels`; `github.event.sender.login` is the labeling actor | Label test | Verified: both events fired for labels applied by the agent; sender login printed. |
| V10 | The `code_scanning` ruleset rule works with the merge queue (CodeQL default setup analyses `merge_group` refs or the rule is satisfied by the PR analysis). Not found in the docs. If it blocks the queue, drop the rule and keep CodeQL alerts as advisory | Throwaway repo with pass 2 applied | Verified: rule `CodeQL` `high_or_higher`/`errors` with the merge queue; [probe#7](https://github.com/wimdotgg/probe/pull/7) merged through the queue. No analysis runs for the queue ref; the PR analysis satisfies the rule. |
| V11 | A tag ruleset accepts the `update` rule without `parameters` | First `apply-settings` | Verified on `probe`. `selftest` re-ran it on a throwaway repository ([run 44954106536](https://github.com/wimdotgg/groundwork/actions/runs/44954106536)). |
| V12 | REST exposes `sha_pinning_required` on `PUT /actions/permissions` and the fork PR approval policy; otherwise both stay manual org-level settings (2.5) and `check` only reads them | First `apply-settings` | Verified: `PUT actions/permissions` with `sha_pinning_required` and `PUT actions/permissions/fork-pr-contributor-approval` accepted and read back (10). |
| V13 | Workflows run on the initial commit of a generated repository (the reason for `GROUNDWORK_READY`); harmless if they do not | First bootstrap | Redesigned: the `auto_init` commit carries no workflows, so none runs on it; the bootstrap commit does start them, and on `gw-p4-b` `ci` concluded success on it (run 44898697529, repository since deleted) while `release-please` was skipped by its `if`. |
| V14 | `gh` on the agent machine supports `--type`, `--parent`, `--blocked-by` at the version named in D4; otherwise the scripts use `gh api` for those calls | `gh issue create --help` | Verified: `gh` 2.102 has all three. |
| V15 | release-please `simple` with manifest `{}`, `initial-version` and `version.txt` `0.0.0` proposes `0.1.0` first | First release PR in `groundwork` | Verified: dry run proposes `chore(main): release 0.1.0`. |
| V16 | The `issue-branches` ruleset (9.5) rejects non-fast-forward pushes to `issue/*` while fast-forward pushes, branch deletion and `delete_branch_on_merge` keep working | Throwaway repo test | Verified on `probe`. `selftest` re-ran it on a throwaway repository ([run 44954106536](https://github.com/wimdotgg/groundwork/actions/runs/44954106536)). |
| V17 | The `settings-plan` job reads environments with the PR `GITHUB_TOKEN` on a real PR that changes `.github/groundwork/` | Job summary of such a PR run | Redesigned: the job cannot read environments with the PR `GITHUB_TOKEN`. [PR #119](https://github.com/wimdotgg/groundwork/pull/119) (job 136588292396, touching `.github/groundwork/`) logged `settings-plan: environments unreadable (HTTP 403)` while `repository`, `labels` and `rulesets` were readable, and [#117](https://github.com/wimdotgg/groundwork/issues/117) records that `actions: read` does not help. GitHub's REST docs name no `GITHUB_TOKEN` permission for the environments endpoints, and none is known to work. The design reads those sections as a file diff and treats the `check` at the end of each `apply-settings` run as their live verification, as in V4. Not re-tested (epic #169 Decisions, 2026-11-21). |
| V18 | The `automatic_base_change_succeeded` event carries `created_at`, and `PR metadata` can read it | GitHub issue event types docs; live timeline | Redesigned: [docs](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types) confirm `created_at`, but list the event as supported in the REST API for issue events and not for timeline events, so `pr-metadata.mjs` reads the issue events endpoint as well as the timeline (8.2, 13.1; [#109](https://github.com/wimdotgg/groundwork/issues/109)). The event needs a stacked PR whose base branch is deleted and D7 forbids stacked PRs, so no live PR can carry it; fixture tests in `scripts/ci/pr-metadata.test.mjs` cover the read (epic #169 Decisions, 2026-11-22). |
| V19 | `failure-alert` opens an alert issue on failure, comments on a repeat, closes it on the next success | Failing release-please or deploy run | Verified (open path): the `v0.2.0` `deploy` run 44996594461 on `gw-p4-b` failed its smoke test and ended in the `Fail the job` step, and `failure-alert` opened `gw-p4-b#20`. `gw-p4-b` was deleted on 2026-11-22, so the record is `docs/runs/2026-11-21-phase4c-project-runs.md` (Runs and PRs). The comment on a repeat failure and the close on the next success are covered by fixture cases in `scripts/ci/fixtures/failure-alert.json`, not by a live run. |
| V20 | A ruleset's `bypass_actors` and merge-queue fields are readable only with Administration write | First live bootstrap | Verified: `check` returned unreadable rows for them with a read-only token ([run 44893580095](https://github.com/wimdotgg/groundwork/actions/runs/44893580095)), so the `check` token holds Administration write (12.1). |
| V21 | GitHub seeds its ten default labels asynchronously after repository creation | First live bootstrap | Verified: they appeared after the labels step of run 44893580095; the final labels pass of 14.2 deletes them, and `gw-p4-b` ended with only the `labels.json` set ([run 44898366229](https://github.com/wimdotgg/groundwork/actions/runs/44898366229)). |
| V22 | The default-setup CodeQL run is findable by workflow name | First live pass 2 | Redesigned: its run name is `CodeQL Setup`; `waitForFirstCodeqlRun` matches the path `dynamic/github-code-scanning/codeql` ([failed run 44900056245](https://github.com/wimdotgg/groundwork/actions/runs/44900056245), fix in the #152 PR). |

---

## 20. Acceptance criteria for groundwork v1

Acceptance runs on a throwaway project `gw-acceptance` with a small Node stack and `"deploy": "none"`.

- G1. A new project is created and configured end to end with one approval from you (`bootstrap`, which ends with `check`) plus the agent's push probe, and no other manual steps. Pass 2 later costs one more approval, plus the deploy secrets unless `"deploy": "none"`.
- G2. The `check` at the end of the bootstrap run passes on the new project, and the agent's push probe against `main` is rejected.
- G3. An epic with at least 3 parallel lane tasks is planned, accepted and completed by at least 2 concurrent workers, with no duplicate claims, through the merge queue.
- G4. A protected-path PR cannot merge without your approval; a PR without an accepted issue cannot merge; a PR with an unmapped AC cannot merge.
- G5. A worker killed mid-task is taken over after lease expiry and the task completes from `resume` output.
- G6. A release PR merged by you produces a `v0.x.y` tag and a release; only the release App can create the tag.
- G7. Every script has unit tests run by the `scripts` job of `ci.yml`; every V-assumption is recorded as verified or redesigned.

---

## 21. Review notes

### 2026-11-23: onboarding integration (#276)

Epic #258 joined on paper: [docs/runs/2026-11-23-onboarding-desk-check.md](runs/2026-11-23-onboarding-desk-check.md) traces a fresh clone to `v0.1.0` in a hypothetical second org and one in-place adoption without running either (Q2 C), and lists the improvisation points and what stays unproven. 14.3: the wizard checks the `.git/config` allowlist before any git command (from the PR #296 review), the allowlist wording names `branch.*.remote`, `merge` and `rebase`, and the consent note has no `org` line. Review round 1: `repo-copy` runs `gh repo set-default`, so `gh` and the agent scripts resolve to the org's copy rather than `upstream`, and a missing Git identity names `user.name` and `user.email`. No `bootstrap-sha`: the first release PR of a copied control repo lists upstream history in its changelog, since a `bootstrap-sha` at the clone point would leave only the `chore:` setup commit, which release-please does not release.

### 2026-11-23: triage dry run and epic #259 integration (#265)

Fixture-only per the owner's 2026-11-23 decision on #259: the `inbox` test fixture's report #100 by `stranger` lists under `untrusted-reports`, and the `groundwork-triage` steps produced a "close as not planned" recommendation offline; nothing was posted and no report content ran. Run note: [docs/runs/2026-11-23-triage-dry-run.md](runs/2026-11-23-triage-dry-run.md). Folded in the items carried from #277, #279, #281 and #283: `AGENTS.md` names the triage skill and the glossary and decision-record rule, 6.8 states the `--edit-last` limit and that the newest owner reply wins, 3 and 4.1 wording fixes, triage skill edge cases (failed close, marker in quotes, guard order) and two enforcer-table limits. Unproven without a live report: the posted comment, `--edit-last` under an installation token, an owner reply, task creation and `inbox` after the action.

### 2026-11-23: onboarding contract (#266)

Epic #258, from the owner's answers in #251 `## Decisions` (2026-11-23): Q1 B (an owner-run wizard with y/N per write; consent offers A and B only), Q4 C (in-place adoption as an opt-in), Q5 A (manual App form), Q7 A (Claude Code on Windows, macOS and Linux). Added 14.3 and 14.4; reworded 2.1, 12 tier 3, 15 and 17 for wizard-entered secrets during org setup, with `admin` approvals, billing, org ownership, deletions and key rotation staying in the browser; replaced the 14.1 step 2 transfer with clone and push; added `scripts/owner/` to 3, 9.4 and CODEOWNERS, an instance-values note under the status line and an `AGENTS.md` Never rule. Review round 1 corrections: wizard imports and the clean-tree check, decline ends the walk, `repo-copy` details, the consent note under answer A, `admin:org` at start, exit and interrupt, state-file validation, PEM paths and deletion, a `CLAUDECODE` refusal, and the adopt preflight in `plan` with no new grant. Round 2: `repo-copy` refuses local commits and stray edits and stages by name, the baseline ref is decided from `git remote`, the consent note carries no progress, and the collision row is defined here.

The kit merge of 14.4 is built (#274). `scripts/owner/` is `[control]` and in `CONTROL_PATHS` (`scripts/groundwork/bootstrap-tree.mjs`) since #268. Known limits: a tampered wizard can drop its own checkout check; the deny rules miss the `cd`, glob, case and PowerShell forms (15); `repo-copy` pushes the clone as the org's `main` before any ruleset or CODEOWNERS gate exists there, and its checks stop the accidental case only (17); `setup-state.json` is agent-writable; a clone copied without `gh repo set-default` resolves `gh` and the agent scripts to `upstream` (14.3); nothing here has run live (Q2 C, desk check only).

### 2026-11-23: glossary, decision records and triage contract (#260)

Epic #259 builds on spike #252 (`docs/decisions/252-onboarding-research.md`) and the owner's answer Q3 A in #251 `## Decisions`: a derived triage queue and a recommend-only skill, no new labels. Contract: `GLOSSARY.md` created on first use (3); decision records widened from spikes to any decision that is hard to reverse, surprising without context and a real trade-off, with a short form and `<N>` naming the deciding issue (4.1); the triage flow (6.8); the `inbox` section `untrusted-reports` and its linked-task rule (13). Section 18 drops ADRs from later work. Lanes #261 to #264 build on this text; `AGENTS.md`, skills and code are theirs.

### 2026-11-22: release-please closed run only dispatches (#247)

The `pull_request: closed` trigger from #238 failed live on its own merge: run 45059252257 ended before any step with `Branch "refs/pull/244/merge" is not allowed to deploy to release due to environment protection rules.` A merged close runs on `refs/pull/N/merge`, which the `release` environment (deployment refs `main`) refuses. The owner decided option e: the closed run only dispatches `release-please.yml` on `main`, and the release job runs on `workflow_dispatch`. A manual dispatch on `main`, run 45062490456, had already succeeded and opened release PR #246.

Corrections applied: 8.5 (`release-please.yml` row) and 11 (Trigger, Environment, Recovery) describe the notifier job `dispatch-on-main`, the dispatched release run and the `GITHUB_REF` of each. The claim that a merged close has `GITHUB_REF` `refs/heads/main` was false and is gone; the entry for #224 and its "known limit" stay as written. `docs/runs/postv1-release-race-fix.md` quotes the failed run's annotation and records the successful dispatch.

Unproven until the closed run of #247's own merge: that its `GITHUB_TOKEN` gets `actions: write`. Known limit: `failure-alert` treats a notifier-only closed run as a success of the workflow and closes a release alert; a follow-up issue tracks it. A PR whose merge ref predates the fix runs the old workflow file once and fails the environment check; dispatch by hand.

### 2026-11-22: Phase 5 integration, v1 done (#224)

Epic #169 ran every section 20 criterion on `gw-acceptance`; `docs/runs/2026-11-22-phase5-acceptance.md` maps E1 to E8 to evidence and lists the carry-over. Spec 19 now reads verified or redesigned in every row: V17 and V18 redesigned, V19 verified for the open path (the `failure-alert` comment and close paths rest on fixtures). The header reads "v1 done". `gw-p4-a`, `gw-p4-b` and the `selftest-*` repositories were deleted; the spec cites their runs by number and the run notes are the record.

Corrections applied: 14.2 step 4 and `docs/setup.md` (a release PR opened before pass 2 has no CodeQL run and needs a new head), 6.4 (lease prose names the configured lease). `AGENTS.md` and the three skills no longer call bare `gh` writes forbidden and contain no `gh api` write: the reviewer posts with `gh pr review --comment --body-file`, and the planner sets type, parent and blockers with `gh issue edit --type`, `--parent` or `--add-sub-issue`, and `--add-blocked-by`. `claim.mjs` drops a Conventional type the issue title already carries.

Errata for "bare gh denied outright (#229)", which stays as written: "a wrapped `gh.exe` or path-qualified `gh` is denied, as before" should read: a wrapped `gh.exe` with arguments was denied before; the path-qualified `gh` deny is new in #230. Its sixth pattern is `*\\gh *` (the rule is `Bash(*\\gh *)`; `"Bash(*\\\\gh *)"` in the JSON file).

Known limit: release-please can run on the merge-queue push before GitHub marks the release PR merged, so no release is built (#238).

### 2026-11-22: bare gh denied outright (#229)

Review round 3 of #228 found `gh at` (an alias of `gh attestation`) and the hidden stubs `gh aw`, `gh stack` and `gh webhook` past the per-name denies, and every name added later would miss too. The owner decided to deny every bare `gh` and `gh.exe` instead. `.claude/settings.json` now denies `gh`, `gh *`, `gh.exe`, `*gh.exe *`, `*/gh *` and `Bash(*\\gh *)`, and drops the bare per-subcommand `gh` rules they cover. The wrapped form `token.mjs exec -- gh ...` stays allowed; a wrapped `gh.exe` or path-qualified `gh` is denied, as before. Review round 1 caught a first version that let a wrapped `gh.exe` past every wrapped deny.

Wrapped denies kept, each with its reason (17): `gh auth` as one rule, because `token`, `git-credential` and `status --show-token` print the installation token and `login`, `setup-git`, `refresh` and `switch` change credential state (`setup-git` writes the global Git config); `gh config set` and `gh alias set|import` persist config that outlives the wrapper, and a `!` alias runs shell that no Bash rule sees; `gh extension`, `gh ext`, `gh extensions` and `gh copilot` download and run foreign code with `GH_TOKEN`. Wrapped denies added: the stubs `gh aw`, `gh stack` and `gh webhook`, which install an official extension (gh v2.102.0 source, not executed). Wrapped denies dropped: `gh release download` and `gh attestation`. Wrapped, `GH_TOKEN` takes precedence over stored credentials for `github.com` (`gh help environment`), so they carry no more risk than a read; bare they were the keyring problem the blanket deny now closes. No script uses either.

Corrections applied: 2.1 (`wianvdm` row), 6.3 step 1 and `docs/workflow.md` (`next` shown under `token.mjs exec`; the wrapper covers reads too, R11), 15 (deny rules) and 17 (credentials); `docs/setup.md` matches. Not done: denying `GH_HOST` or an overridden `GH_CONFIG_DIR` (command text cannot match them), a `ghs_` prefix check on `GH_TOKEN`, a case variant (`GH`) and a shell wrapper (`bash -c "gh ..."`, `sh -c`, `eval`); `env gh`, `command gh` and `xargs gh` are denied. The run note `docs/runs/2026-11-22-gh-blanket-deny.md` holds the harness probes.

### 2026-11-22: gh config and alias denies (#227)

Review of #225 found that one `gh config set` call turns the credential separation off: `gh config` runs with the auth check disabled and writes `.claude/gh-agent/hosts.yml` with a `github.com` key and no token, after which every `gh` command passes the auth check and falls back to the owner's keyring token. `GH_HOST=github.com` does the same for one call, and `gh alias set` can define a word that expands to the denied `auth token`. `.claude/settings.json` now denies `gh config set`, `gh alias set` and `gh alias import`, each bare and as a `token.mjs exec` form, and `.gitignore` lists `**/.claude/gh-agent/` so an untracked `hosts.yml` is not the only sign of a write. `GH_HOST` and an overridden `GH_CONFIG_DIR` stay open: command text cannot match them (17). Review rounds 1 and 2 found a second route: `gh release download`, `gh extension install`, installed extensions, `gh copilot`, `gh attestation trusted-root` and `gh attestation verify --bundle` skip the auth check and send the keyring token with no host listed (the last three not traced to a request), and an installed extension can run `gh auth token` itself, out of sight of every deny. The owner widened #227 on 2026-11-22 to deny `gh extension`, `gh ext`, `gh extensions`, `gh release download`, `gh attestation` and `gh copilot`, each bare and as a `token.mjs exec` form.

Corrections applied: 2.1 (`wianvdm` row), 14.1 step 3 (9.1 wording, "stop accidental use"), 15 (allow rules) and 17 (credentials). `AGENTS.md` (Worker loop) now runs every agent script under `token.mjs exec`. The worker, planner and reviewer skills, `docs/setup.md` and `README.md` no longer show bare `gh` reads or bare `request.mjs` and `kit-update.mjs` calls, and `permissions.allow` lost its `gh` read entries: since #225 they exit 1 or 4. Not done: a `ghs_` prefix check on `GH_TOKEN` (the #216 contract keeps origin unchecked). The run note `docs/runs/2026-11-22-agent-gh-config-denies.md` holds the harness probes.

### 2026-11-22: Phase 5 contract (#216)

Epic #169 proves v1 on `gw-acceptance`. Before it, the owner's decisions of 2026-11-22 (Decisions on #169) replaced the plan to remove the owner's `gh` and Git Credential Manager login from the agent machine. Two probe issues (#214, #215, closed) showed why removal was not the answer: the org's third-party access restriction was on with no approved apps, yet the owner's GitHub CLI OAuth token still wrote to `groundwork`. GitHub does not enforce the separation, so the client does.

Contract: `createClient` outside Actions without a token refuses unless `GH_TOKEN` is set, which `token.mjs exec` does, and names `token.mjs exec` in the error; `currentRepo` refuses the same way, because `resume` and `review-queue` call it first (13.1). No read-only path keeps the ambient `gh` login: every caller already runs under the wrapper, `inbox` included (13). `.claude/settings.json` carries `GH_CONFIG_DIR=.claude/gh-agent` (a directory with no `hosts.yml`: gh lists no host, so its auth check refuses every command outside `gh auth`; the keyring token stays readable through `gh auth token` and `gh auth git-credential`, which the deny rules cover), `GCM_INTERACTIVE=never` and deny rules: `gh auth token`, `gh auth git-credential`, `gh auth login`, `gh auth setup-git`, `gh auth refresh`, `gh auth switch`, bare `gh api graphql` and `gh.exe`. The first rules came from the untracked `settings.local.json`. Review of #225 added the `gh auth` subcommands that reach the keyring token or write a login, and a leading wildcard on `gh.exe` so a wrapped call matches.

Corrections applied: D9; 2.1 (`wianvdm` row); 9.1 (org-admin bypass); 13.1 (`createClient`, `currentRepo`, the `gh` sentence); 14.1 step 3; 17 (credentials). `docs/setup.md` part 1, section 3 step 5 follows. The run note `docs/runs/2026-11-22-phase5-contract.md` holds the probe evidence and the fail-closed transcripts.

Known limits: the rules stop accidental ambient use, not a deliberate bypass, and G4 (epic #169) proves they bind the bot identity. With `GH_CONFIG_DIR` set, the bare read-only commands in `permissions.allow` (`gh issue view` and the like) find no login and need the wrapper. `GH_TOKEN` set by anything other than `token.mjs exec` passes the check.

### 2026-11-22: Phase 4c integration (#200)

The lanes of epic #168 shipped the deploy workflow and scripts, `kit-update`, the `script` and `selftest` ops and their live runs. Live: `selftest` ([run 44954106536](https://github.com/wimdotgg/groundwork/actions/runs/44954106536)) passed all rows and archived its repository; its `push-main` probe saw the push rejected with 422, so the admin App token is bound by the `main` ruleset and the question left open in the Phase 4c contract is closed. `script` ([run 44954649162](https://github.com/wimdotgg/groundwork/actions/runs/44954649162)) ran `admin-ops/repo-info.mjs` against `gw-p4-a`. On `gw-p4-b` `kit-update` moved the project from `v0.5.0` to `v0.7.0`, and a forced smoke failure on `v0.2.0` rolled back to `v0.1.0` (`docs/runs/2026-11-21-phase4c-project-runs.md`).

Corrections applied: header; 3 and 13.1 (`deploy.yml` copied only when absent); 8.5 (production secrets mapped by setup task 04; a release tag that is not `vX.Y.Z` fails before deploy); 12.1 (ops available now, `script` `org` argument, token scan covers comments and `.constructor(`, child permission flags and environment, `plan` export, `selftest` inspect and skip rules, probe details); 13.1 (`ctx.runCheck` and `setScriptPermissions`, `kit-update` wording on `ci.yml`, skipped files, config reformatting, pins, staging, `buildBootstrapTree` deploy stubs); 14.2 steps 3 and 5; 19 V3, V11 and V16 (rerun by `selftest`). The 8.6 and 13 statements that `kit-update` owns the pins already held. Setup task 04 lists the production secret names in `settings.json`; setup task 05 confirms the `code_scanning` rule a current template already carries. Two code defects found by the live runs are fixed: `kit-update` now copies `deploy.yml` into a project without one, and `scripts/lib/config.test.mjs` no longer asserts that the running repository has no hotspots.

Open for a later change: Dependabot honouring `dependency-name: "*/groundwork"` against a `/` is unconfirmed; `kit-update` stages all plan paths in one `git add` and keeps its own pin pattern beside the one in `bootstrap-tree.mjs`; the first `kit-update` of a project older than `v0.7.0` cannot run the script (copy `scripts/kit-update.mjs` from the tag by hand) and may need an owner `size-exception`; every `deploy` run shares the `production` concurrency group, so an owner approval cap leaves no slack for a rollback test; `claim.mjs` reads the repository from the current directory and refuses a second draft claim under one session id.

### 2026-11-21: Phase 4c contract (#190)

Epic #168 builds the kit parts the spec promised. This contract fixes what the lanes build against: 8.5 (deploy, smoke and rollback arguments, exit codes, previous-tag rule, deploy record, shims, stubs under `scripts/stubs/deploy/` in projects and `scripts/groundwork/stubs/deploy/` in `groundwork`); 8.6 and 13.1 (`kit-update` kit paths, `config.json` three-way merge, SHA pins, the Dependabot `ignore` rule); 12.1 and 13.1 (the `script` op: `script_path`, `ref`, static `permissions`, SHA-256 handoff through `script_sha256`; the `selftest` op: `selftest-<run id>`, grants, archive, four probes); the `admin-run` run name gains a `script=<script_path>` field before `args=`, so the one free-form field is last. `admin-run.yml` lists both ops and declares `script_path`; both ops are registered with skeleton modules that refuse `not implemented`, and `request.mjs` dispatches them. The `script` op needs `ref` equal to the `main` head, and a delegated approval accepts only that. Open for the lanes to confirm: Dependabot's `dependency-name` wildcard against a `/`; whether the admin App token is bound by the `main` ruleset for the `push-main` probe.

### 2026-11-21: Phase 4c owner delegation (#168)

The delegation of the "2026-11-21: Phase 4b owner delegation (#170)" entry is extended to Phase 4c epic #168 under the same review rules and ends when #168 closes. A reopen does not revive it: any close ends it. `accepted` on #168 was applied after #167 closed. New action classes, `selftest` and `script` admin approvals and the `production` deploy approval, each need a dated Decision on #168 and a reviewed change to the script first; the Decisions list them with their limits. A delegated `script` approval needs `ref` equal to the `main` head of `groundwork`, because the delegation sees only the path and the hash, not the file. Tier 3 stays in person: App permission updates, secret values, deleting repositories, closing epics and editing the owner script. The script stays a temporary setup-period bypass, outside groundwork; no groundwork rule changes because of it.

### 2026-11-21: Phase 4b integration (#178)

`groundwork` passed pass 2 with delegated approvals. A `check` before it ([run 44942840162](https://github.com/wimdotgg/groundwork/actions/runs/44942840162)) showed 85 match and 3 deferred. `bootstrap-pass2` ([run 44943060298](https://github.com/wimdotgg/groundwork/actions/runs/44943060298)) then sent `PATCH code-scanning/default-setup` (202), saw CodeQL run 44943147788 succeed and logged `code_scanning rule: added` (the `PUT` on ruleset 27449099), so before it default setup was off and the rule absent. The summary lists only mismatches; the orchestrator named the three deferred rows (`security code_scanning_default_setup.state`, `variables DEPLOY_ENABLED`, `rulesets main.rules.code_scanning`) with a supplementary GET-only replay under the owner's `gh` login. The `check` after it ([run 44943368540](https://github.com/wimdotgg/groundwork/actions/runs/44943368540)) has 87 match, 0 mismatching and 1 deferred: `DEPLOY_ENABLED`, because `config.json` keeps `"deploy": "none"`; no `DEPLOY_ENABLED` variable exists on `groundwork`. From now on `groundwork` PRs need CodeQL results to merge.

Corrections applied from the lane PRs: 2.4 and 12.1 (no `"all"` create grant; ops that may target the control repository), 3 (`docs/runs/`), 9.1 and 14.2 (template `rulesets/main.json` carries `code_scanning`; `bootstrap-pass2` may target `groundwork`), 10 (`is_template` sent on `groundwork`, setup skips the manual setting), 12.1 (V7 key confirmed), 13.1 (`findSetupEpic`, `inspectRepo` refusal, CodeQL lookup reads 10 pages), 14.2 (`ours` refusal after setup acceptance replaces the open question; `LICENSE` and `SECURITY.md` copied unchanged), 19 V5 (PAT retired), header status and date. Open for a later change: the comment above `compareStates` in `scripts/lib/settings.mjs` (a template `main` lacking `code_scanning`) and `scripts/groundwork/stubs/setup/05-code-scanning-rule.md` are stale now that the template rule exists; a `target_repo` spelled `groundwork.git` passes the name pattern and is not compared equal to the control name; a CodeQL run behind more than 1,000 completed dynamic runs on `main` is still missed (only a `created` filter would reach it).

### 2026-11-21: Phase 4b owner delegation (#170)

The delegation of the "2026-11-21: Phase 4 owner delegation (#141)" entry is extended to Phase 4b epic #167 under the same review rules (agent comment review on the head SHA from another session; a Fable reviewer for protected paths). It ends when #167 closes. A reopen does not revive it: any close ends it. The actions are the ones listed there, with `accepted` on #167 after you close #140.

Admin approvals now also cover `groundwork`, beside the `gw-p4-*` allowlist, and only for `admin-run.yml` runs on `main` with empty `args` and these ops (op, target, ref and args read from the run name):

- `bootstrap-pass2`.
- `check` with an empty `ref`.
- `apply-settings` with a `ref` that is a `main` SHA at most 3 commits behind the tip of `main`.

The script's op and repo allowlist limits every admin approval. Tier 3 stays in person: App permission updates, secret values, deleting repositories, closing epics and editing the owner script.

The owner script is a temporary bypass for the setup period. It is not part of groundwork, and no groundwork rule changes because of it; this entry records that it existed and how far it reached. In the finished kit you approve admin runs in person, and you review the whole template in person once setup is complete. 2.1 and 14.1 point here.

### 2026-11-21: Phase 4 integration (#152)

`gw-p4-b` was bootstrapped from `v0.5.0` by [run 44898366229](https://github.com/wimdotgg/groundwork/actions/runs/44898366229): `check` clean, no default labels left, `ci` green on the bootstrap commit, probe rejected with 422. Setup tasks 01 and 05 merged through its queue with delegated approvals. Its first pass 2 ([run 44900056245](https://github.com/wimdotgg/groundwork/actions/runs/44900056245)) failed because `waitForFirstCodeqlRun` matched the run name `CodeQL`; default setup names it `CodeQL Setup`. The fix matches by path (V22). Pass 2 on `gw-p4-a` ([run 44901087785](https://github.com/wimdotgg/groundwork/actions/runs/44901087785)) refused on the stub with no write. The successful pass 2 on `gw-p4-b` is rerun after this PR merges and mapped to E4 in the epic acceptance comment.

Corrections applied from the lane PRs: 2.4 and 13.1 `createRepo` (one token variant, V7); 8.6 and 14.2 step 5 (SHA pins with a tag comment); 12.1 (ops available, summary also on stdout, `check` holds Administration write, `ctx` carries no `args`); 13 (`request.mjs` ops, probe runs as the agent App); 13.1 (`readKitVersion`, `readBlobContents`, `resolveTagCommit`, `commitBootstrapTree` `blobs` and `sleep`, `openSetupEpic` `adminBot` and `sleep`, `buildBootstrapTree` `tagSha`, `readReleaseTree` `commitSha`, `applySections` dependencies, `readVerifyState` `unreadable`); 14.2 step 10 (final labels pass); 15 (wrapped default-POST denies exist, E7 follow-up closed); 19 (V7, V13, V20 to V22). Answered: the lane issue-body updates (#155) were the orchestrator's; the control-repository refusal (#156) is in `bootstrap.run`. Open for a later epic: Dependabot bumps the SHA pins while `kit-version.txt` keeps the tag (`kit-update` should own them); open question for the owner, not decided: a rerun of pass 1 on `ours` applies the tag's labels and settings, deleting project-added labels and resetting changed settings (14.2); the wrapped denies match only the literal `token.mjs exec` prefix (15).

### 2026-11-21: Phase 4 contract (#142)

Pass 1 creates the repo with `POST /orgs/{org}/repos` (`auto_init: true`), creates labels, then pushes the bootstrap commit, which closes the Dependabot label gap. `TOKEN_SCOPE` gains `deferred` with a bounded `ctx.withToken`, so `bootstrap` mints its own tokens from declared grants; `bootstrap-pass2` stays `target`. Per the endpoint page the admin App already holds a sufficient permission for the create call; the token variant stays unverified until the first live run. `script` and `selftest` stay out of Phase 4. 12.1, 13.1 and 14.2 carry the module contracts the lane tasks build against.

### 2026-11-21: Phase 4 owner delegation (#141)

The delegation of the #81 entry is extended through Phase 4 epic #140 and ends when #140 closes. A reopen does not revive it: any close ends it. Your `gh` login stays on the orchestrator machine and a local script (outside the repository) performs only these actions, each with a "Delegated owner" marker on GitHub:

- Approve agent PRs, including ones touching `.github/`, `scripts/groundwork/`, `scripts/ci/` or `.claude/settings.json`. Every approval needs an agent comment review on the head SHA from a session other than the PR's author session; for the protected paths its Reviewer line must name a Fable reviewer.
- Merge release PRs.
- Apply `size-exception` to reviewed over-limit PRs.
- Apply `accepted` to #140 after #75 closes.
- Approve pending `admin` environment deployments, only for `admin-run.yml` runs on `main` whose op is `bootstrap`, `bootstrap-pass2` or `check` and whose target repo matches `gw-p4-*` (op, target, ref and args read from the run name).
- Inside `gw-p4-*` repositories: `approve-pr` under the same review rules, and accepting the "Project setup" epic opened by the admin App.

When the script waits for checks, a check run with a set conclusion counts as finished. Phase 5 owner actions (G1, G4, G6) stay in person. 2.1 and 14.1 point here.

### 2026-11-21: Phase 3b integration (#98)

Live runs on #75 and #74 are in PR #139. 4.5: `plan-lint --close` rules written out (reason line, spike decision link, evidence cells, empty epic). 6.1: `Reviewer:` line rule. 8.4: `plan-lint.yml` has the `typed` trigger, fails its step only on an API or usage error, and shares the marker comment with the App (agent App or `github-actions[bot]`). 9.4: `inbox` reads CODEOWNERS from the working copy, GitHub from the base branch. 13: rows for `plan-lint` (`--post` or `--close`, not the earlier `--close` only; marker, template keys, `--json` shape, exit 1 for both a lint failure and an error, told apart by `failures`), `review-queue` (inputs, JSON, Reviewer line first or last, head-SHA rule, own session not excluded, footer-less PRs listed) and `inbox` (App token, `--json`, sections, 403 and 404 unreadable). 18: `isUnder` and `namesHotspot` move to `scripts/lib` later; a reviewer App needs a `review-queue` change first.

### 2026-11-21: wrapped deny rules (#130)

15: `.claude/settings.json` gains the wrapped `git -C * push * --force*` and `-f*` denies, and the wrapped `gh api` denies for `-XDELETE`, `-XPUT`, `--method=DELETE` and `--method=PUT` against `rulesets`, `environments` and `secrets`. Review round 1 added the wrapped `git -C * push` forms for `--force` and `-f` right after `push`, `main` and `+` refspecs, the wrapped `gh api` method-first order, and any-method `-X*` and `--method*` rules (bare and wrapped) against the three paths. Every dangerous form now has a bare and a wrapped deny. The #122 gap (R5 of the #126 review) is closed. Follow-up: wrapped `gh api` writes against those paths through `-f` or `--input` without a method flag.

### 2026-11-21: live claim-loop run (#91)

Run on throwaway task #127 (PR #128), two top-level Claude Code sessions in separate worktrees (A `1ce6b81a-43ca-4a4e-85dd-0e2ced24d283`, B `c7c7de56-c010-4588-87df-03194dd78608`). Run note: `docs/runs/2026-11-21-claim-loop.md`.

AC1: both ran `claim.mjs 127` at 05:50:00Z by the local clock (B 05:50:00.0430Z, A 05:50:00.0433Z; GitHub stamped claim commit 7c1fb65 at 05:49:50Z). B exited 0 (`issue/127`, PR 128; [claim commit](https://github.com/wimdotgg/groundwork/commit/7c1fb6528f647400b0f6047b0141f0b94d4cc5d9), [claim comment](https://github.com/wimdotgg/groundwork/pull/128#issuecomment-7058196926)); A exited 3 (`issue/127 is already claimed`).

AC2: B ran `release 127 --decision` (exit 0, PR stayed draft with the released marker). `next` offered the takeover; A's `claim.mjs 127` exited 0 in mode takeover ([b8d754b](https://github.com/wimdotgg/groundwork/commit/b8d754b1ad47170702edd09d2d86198a807a7954), [comment](https://github.com/wimdotgg/groundwork/pull/128#issuecomment-7058219780)). B's next `checkpoint` exited 3: `PR footer names session 1ce6b81a-43ca-4a4e-85dd-0e2ced24d283`.

AC3: A ran `resume 127 --session` (exit 0, 78 lines), then checkpoints [1](https://github.com/wimdotgg/groundwork/pull/128#issuecomment-7058240701) and [2](https://github.com/wimdotgg/groundwork/pull/128#issuecomment-7058272887). #128 merged through the queue as [7715796](https://github.com/wimdotgg/groundwork/commit/7715796c796936a0c289fbf958e94bca17b797eb); `release 127 --merged` posted the [handover](https://github.com/wimdotgg/groundwork/issues/127#issuecomment-7058315429).

AC4: B committed 14dbf8a without pushing and ended its turn. Its Stop hook (`token.mjs exec -- checkpoint.mjs --auto`, session from hook stdin) pushed it: `issue/127` moved to [14dbf8a](https://github.com/wimdotgg/groundwork/commit/14dbf8a).

Gotchas: two worktrees of one clone cannot both check out `issue/N`, so a released worker detaches before the taker checks out; the local clock ran about 10 s ahead of GitHub (claim commit stamped 05:49:50Z), and leases use only server timestamps, so they are unaffected.

### 2026-11-21: scripted claim loop decisions (#122)

6.2, 13.1: `hotspots.json` paths are exact paths or directory prefixes, not globs; `findFooterBreak` and `parseFooter` documented as the only footer copies. 6.3, 6.4: the loop runs through the scripts and the wrapper; `release --decision` turns a ready PR back to draft; a takeover commit by another session younger than `claimWithoutPrMinutes` holds the PR; `next` offers a takeover only while the task passes every status check except `claimed` (format and size are not re-checked), and a direct `claim N` does not re-check it (accepted gap). 8.2: `base_ref_changed` is issue-events-only like `automatic_base_change_succeeded`. 13: session id is the harness session id; subagents share it and fire no Stop hook, so concurrent workers are separate top-level sessions or use distinct ids; Node 24 first on PATH; `checkpoint --auto` session from env or hook stdin; a checkpoint rerun after a failed journal post bumps the number and keeps the input file; non-auto `checkpoint` on a ready PR is allowed; exit 3 and exit 1 lists complete (Definition of Ready, rival takeover, footer-less PR, closed PR). 15: hooks run through the wrapper; bare-write and wrapped-form denies listed; read-only GraphQL goes through the wrapper. Known gap, owner-path follow-up: no wrapped deny for `git -C * push --force` or `-f`, and the wrapped `gh api` denies miss `-XDELETE`, `-XPUT` and `--method=DELETE`. 14.1: step 4 no longer lists team access (`teamAccess` is `[]`, #115).

### 2026-11-21: Phase 2 status, follow-up wording and owner delegation (#81)

Status: Phase 2 done (`v0.1.0`), agents act as the `wimdotgg-agent` App (`v0.2.0`), Phase 3a in progress (`v0.3.0`, 2026-11-20). D5: the planner posts the epic, plan and sub-issues before you apply `accepted`. 14.2: Dependabot label race recorded as a known gap. 12.1, 13.1: `recordCall` and the `gh secret set`/`gh variable set` rows. 14.1: release App value is the App ID or the client ID (2.3, 10.1; `docs/setup.md` section 4). 8.2, 8.3, 13.1, V18: `PR metadata` reads issue events as well as the timeline (#109), and V18 moves from known gap to partial; `settings-plan` logs section status (#110). `AGENTS.md`: stale test-command and template notes removed.

Temporary owner delegation: your `gh` login stays on the orchestrator machine and a local script, outside the repository, performs only these actions: approving reviewed agent PRs (never ones touching `.github/`, `scripts/groundwork/`, `scripts/ci/` or `.claude/settings.json`), merging release PRs, applying `size-exception` to reviewed over-limit PRs, and applying `accepted` to #75 after you close #74. Every action carries a "Delegated owner" marker on GitHub. It ends when #75 closes. Owner actions of Phases 4 and 5 are yours in person (G1, G4, G6). 2.1 and 14.1 point here.

### 2026-11-20: settings-plan environments (#117)

19: V4 and V17 corrected. `actions: read` does not make environments readable with the PR `GITHUB_TOKEN`; the log still shows `environments unreadable (HTTP 403)`. `settings-plan` treats environments like Actions settings (file-diff fallback), and the `check` at the end of each `apply-settings` run is the live verification.

### 2026-11-20: Phase 2 live verification (#78)

19: V17 to V19 added and the Result values gain `known gap`. `settings-plan` environment reads and the `failure-alert` cycle are unconfirmed; `automatic_base_change_succeeded` is documented as absent from the timeline endpoint `PR metadata` reads (bugs #110, #109).

### 2026-11-20: release App variable and apply-settings (#77)

2.3, 10.1: `RELEASE_APP_CLIENT_ID` may hold the App ID or the client ID; the live variable holds the App ID. Changing it is owner-only and both work, so the spec follows live. 12.1: the `apply-settings` row states once that every target, `groundwork` included, gets the `release` environment.

### 2026-11-20: Phase 3a contract (#82)

13, 13.1: agent script flags, exit codes, `--json` shapes and the session id rule fixed; comment formats and markers (`takeover`, `checkpoint`, `handover`) added; `fillTemplate`, `templateSection`, `claimCommitMessage`, `parseClaimCommit` and `isValidSessionId` added. `claimCommitAt` now also accepts a takeover commit, and session ids are limited to `[A-Za-z0-9._-]+`. Review round 1: one placeholder key per meaning across the comment templates, `state-section.md` and `pull_request_template.md` (section 7 shows the same template); initial PR body, handover inputs, footer checks, exit 1 for `tasksPerWorker`, author-and-marker matching, `--auto` push and `isValidAgent` added.

### 2026-11-20: no deploy and no team grant (#80)

2.5, 10: `groundwork` declares `"deploy": "none"` and `settings.json` `teamAccess` is `[]`; team `agents` is empty. Earlier entries keep the team-grant wording as history.

### 2026-11-20: agent App identity

GitHub hid the machine user `wianvdm-agent` (spam flag), so its content was invisible to others. Agents now act as the org-owned App `wimdotgg-agent`.
1. D9, 2.1, 2.2: machine user and fine-grained PAT replaced by the agent App; permissions as installed, key storage and `token.mjs` described.
2. 6.1, 6.7, 12, 13, 14.1, 15, 17: agent account wording becomes the App; trusted author is `wimdotgg-agent[bot]`; `agent/token.mjs` added; agent write pacing added to `AGENTS.md`.
3. `config.json`: `accounts.agent` is `wimdotgg-agent[bot]`, `apps.agent` is `wimdotgg-agent`.
Earlier entries below and sections 19 and 21 keep the machine-user wording as history.

Corrections made in the 2026-11-16 review. Verified against docs.github.com REST and Actions references, the `actions/create-github-app-token` source and the release-please schema and source on that date.

Verified unchanged: ruleset rule types and parameter names in 9.1; `allowed_merge_methods` and `merge_queue` enum values; `code_scanning` rule shape; `OrganizationAdmin` bypass with `pull_request` mode; `issues` activity types `typed` and `untyped`; `bump-minor-pre-major`, `initial-version`, `include-component-in-tag`; SHA pinning policy leaves reusable workflows by tag alone.

Corrected:
1. 2.4: organization Administration removed from the admin App; repo creation from a template is repository Administration write plus Contents read.
2. 2.4, 12.1: `admin-run` mints tokens with its own script, because `actions/create-github-app-token` has no `permission-*` input for Variables or Issue types. Per-op permission table added.
3. 2.2: Checks removed from the PAT (not offered for fine-grained PATs); PAT scope stated as "All repositories".
4. 2.3, 9.2: tag-ruleset bypass needs the numeric App ID; full JSON given; resolved at apply time.
5. 2.5, 14.1: issue types created only by `create-issue-types` (was both manual and op); team `agents` needs Write on `groundwork` to dispatch `admin-run`.
6. 3, 13: machine-read config moved from YAML to JSON (no YAML parser without dependencies, D14); `config.json` added.
7. 3, 8.3: `reusable-pr-metadata.yml` removed. A reusable call cannot produce the required names `PR metadata` and `pr-size`, and it contradicted base-commit validators.
8. 3, 8.2, 8.7: `groundwork-ci.yml` removed. A separate workflow cannot be part of `Check`; its tests run in a `scripts` job of `ci.yml`.
9. 3, 11: root `version.txt` added (release-please `simple` requires it); the kit pin file renamed `kit-version.txt`.
10. 3: `scripts/deploy`, `smoke`, `rollback`, `ci/protected-labels.mjs`, `ci/settings-plan.mjs`, `ci/failure-alert.mjs`, `groundwork/app-token.mjs` added to the layout.
11. 4.4: status rows ordered by precedence; `orphaned` added; claim window covered.
12. 5: `integrity-exception` defined and protected; protected labels validated by timeline actor, since removals by `GITHUB_TOKEN` trigger nothing.
13. 6.1: reviewer wording fixed; thread resolution by the worker reconciles the ruleset with D12.
14. 6.3, 6.4: claim commit made through the API; lease measured by agent comments instead of PR `updated_at` (outsiders can bump it); released claims become takeover candidates through a body marker; `next` returns takeover candidates.
15. 6.7: the admin App's bot added to trusted authors (it opens the setup epic).
16. 8.1, 8.2: pass-through defined as step-level exit, not job-level skip; `Check` needs list completed; `cancel-in-progress` expression given.
17. 8.3: `no-issue` freshness uses server-side run time, not commit dates; Dependabot major PRs exempt from the branch rule; fork heads rejected.
18. 8.4: parent check moved out of `issue-format` (the parent link arrives after `opened` and fires no event); permissions listed; `plan-lint` workflow cannot see sub-issue changes, planner posts the report.
19. 8.5: `release-please.yml` guarded by `GROUNDWORK_READY`; `deploy.yml` condition and script arguments stated; alert issues excluded from format checks.
20. 10: settings mapped to endpoints; fork-approval option named correctly; environment bodies, custom ref policies (not `protected_branches`), `prevent_self_review` values and the secret-writing route given.
21. 11: config file given in full; `release-as` deprecation and removal step noted; `automated` label wired through `extra-label`.
22. 12.1: workflow always dispatched on `main`; `ref` defined per op and must be reachable from `main`; input validation, failure behaviour, org-level concurrency group and `selftest` defined.
23. 13, 14.2: `check` is read-only; the push probe moved to the agent side, where the identity under test lives.
24. 14: ordering fixed: `admin-run.yml` on `main` first, groundwork's own `release` environment, first release before first bootstrap, bootstrap built from the release tag, reusable references rewritten, resume behaviour.
25. 19: V3 to V9 reworded; V10 to V15 added.

Not verifiable from documentation: V5, V7, V10, V11, V12, V13.

### 2026-11-16: implementation plan changes

Folded in after Phase 0 (section 19 has the evidence) and the implementation-plan review.

1. 2.1, 2.3, 2.4, 5, 6.7, 8, 11, 12.1, 14.1: Apps named `wimdotgg-admin` (App ID 5782869) and `wimdotgg-release`; org `wimdotgg`; slugs live only in `config.json`.
2. 2.1, 5, 6.7, 13.1: logins compare case-insensitively (GitHub reports the owner as `WianVDM`); `config.json` stores them lower-case.
3. 2.4, 12.1: the generate call uses a token restricted to `groundwork`, falling back to an installation-wide token for that single call, revoked at once with `DELETE /installation/token`. V7 decides.
4. 4.1, 4.3, 6.2, 6.3, 7, 8.3: Spikes claim like any task and merge a decision record `docs/decisions/<N>-<slug>.md` with a `docs(spike)` title; the merge closes the issue; the agent logs one line in the epic's `## Decisions`. The decision-comment route and "no PR" are gone.
5. 1 (D17), 6.3, 6.4, 9.5, 15, 17: workers never force-push in any form; takeover is a fast-forward-only update of the observed head; new ruleset `issue-branches` (non-fast-forward, no bypass; V16); branches update from `main` by merge, never rebase; deletion stays allowed.
6. 3: `.gitignore` re-includes only `.claude/skills/groundwork-*/`.
7. 3: the flow diagram is Mermaid inside `docs/workflow.md`.
8. 12, 12.1, 13, 14, 20: `bootstrap`, `bootstrap-pass2` and `apply-settings` end with `check` under the same approval; `check` stays standalone for drift; the push probe is `request.mjs probe`, agent-side, no approval. G1 is one approval plus the probe; pass 2 is one approval.
9. 19: Result column added; V16 added; Phase 0 results recorded.
10. 10, 10.1: `admin` and `production` set `can_admins_bypass: false`; `check` compares it. Actions settings applied per repo through REST (V12).
11. 1 (D18), 3, 10, 14.2, 20: projects may declare `"deploy": "none"`; pass 2 then skips `DEPLOY_ENABLED` and deploy secrets. Acceptance runs on `gw-acceptance` (Node, `deploy: none`).
12. 3, 14.2: `groundwork` has a real `scripts/verify`; bootstrap swaps in the stub from `scripts/groundwork/stubs/`.
13. 6.3, 9.1: `gh pr merge --auto --squash` (without `--squash` `gh` refuses with a merge queue); `OrganizationAdmin` read-back shows `actor_id: null`; bypass merges skip the queue.
14. 2.3: `actions/create-github-app-token` pinned at v3.3.0 (`64ab729a6294000f5aa4a4bc0b73d1f32bc45510`) with `client-id`.
15. 8.1: pass-through stated as step-level `if` plus validators returning `skip`; a step exiting 0 does not stop later steps.
16. 3, 13, 13.1: module contracts added; `scripts/lib/` gains `markdown.mjs`, `settings.mjs`, `ci.mjs`; ci fixtures live in one file per validator under `scripts/ci/fixtures/`. The ruleset App ID placeholder is `{{app-id:<key>}}`.
17. 5, 8.4: `protected-labels` acts on every `labelActors` entry, including `dependencies` and `automated`, with one rule instead of an owner-only list.
18. 9.2, 9.3, 10, 12.1: committed config files under `.github/groundwork/` match this text; V11 settled the `update` rule without `parameters`; op token permissions widened by the reads `check` needs.
19. 4.4, 6.3, 6.5, 8.2, 8.3, 9.1, 9.4, 10, 12.1, 13, 13.1, 14.2, 17: review findings R1 to R16 applied (R3 in part: environment secrets and variables stay under Environments write, per the GitHub App permissions reference). `scripts/groundwork/` protected; `needsClient`; Variables and Members reads for `check`; variable `op` replaced by `assertWhen` signals; Facts typedefs per validator; claim pointer comment on the issue (`claimCommentAt`) and claim comment on the PR; pagination and GraphQL fixture keys; non-admin bypass actors compared by `actor_id`; base-commit validators in `ci.yml`; `settings` → `trust`; `deferred` rows for pre-pass-2 code scanning; `matchesGlob` test; `repoRoot` and thrown error types; `pr-size` exemptions by label; durable lessons in `AGENTS.md`.
20. 4.4, 6.3, 6.4, 9.1, 10, 13, 13.1, 14.2: a ref with neither PR nor pointer comment expires 15 minutes after the claim commit's server-stamped committer date (`claimCommitAt`; `claim.mjs` never sends dates; the only trusted commit date), not at once. Pass-2 items fail closed once the live `main` ruleset has the `code_scanning` rule (`pass2Ran`): default setup not `configured`, or `DEPLOY_ENABLED` unset while `deploy` is not `none`, is a mismatch; before that they stay `deferred`.
21. 3, 4.3, 8.2, 9.4, 13.1, 15: Phase 1 corrections from the implemented code. Test command is `node --test "scripts/**/*.test.mjs"` (Node 24); markdown and github module behaviour (`parseStateSection` input, `---` section end, closing-ref URLs and code spans, CRLF, `request` path rule, fixture key normalisation); web-form issue bodies (`###` headings, `_No response_`, optional Bug `Serves`); scanner strictness in `security`; scanner configs in CODEOWNERS; `.gitattributes`, ignored `.claude/worktrees/` and the shared verify shim; Stop and PreCompact hooks deferred to Phase 3.
22. 4.4, 13.1: contract changes from implementation review. Epic with valid `accepted` is `blocked` or `ready`, `next` skips Epics, orphaned needs an open issue; `loadIssueFacts` PR selection, `isInMergeQueue`, cross-repo or missing parent throws, `type` is `string|null`; `readLiveState` `environmentNames` and 404/403 handling, `pass2Ran` branch-target rule, raw `can_admins_bypass`; `ci.mjs` exit 2 cases and required env; validator fixture `warningsInclude` and `throws`, `protected-labels` nullable facts, stricter `pr-size` and `test-integrity`; `testIntegrity` patterns in `config.json` now cover fixtures, `{ skip:`, `{ todo:` and `.todo(`.

### 2026-11-17: Phase 2 corrections

1. Header: status is Phase 2 in progress.
2. 2.1, 2.3, 2.4, 14.1: `wimdotgg-release` exists; both Apps are org-owned with no manifests; private org App slug lookup returns 404 to the agent PAT.
3. 3: `scripts/groundwork` lists `apply-settings.mjs`, `create-issue-types.mjs`, `admin-run.mjs`.
4. 8.2: `settings-plan` row describes the validator's `skip`.
5. 8.2: `ci.yml` concurrency keyed by SHA for pushes, so no push range is dropped (Phase 1 review R4).
6. 8.3: `actions: read` removed from `PR metadata`; no script reads workflow runs.
7. 12.1: available ops, `apply-settings` and `create-issue-types` behaviour, `issue_types` key.
8. 13, 13.1: `request.mjs` ops; admin op module contract; `app-token.mjs` API.
9. 19: V7 recorded as partial.
10. 12.1: access-token permission keys follow `X-Accepted-GitHub-Permissions`; Variables is `actions_variables`, not `variables`.
