# groundwork: specification v1

Status: agreed design; Phase 0 probes done (section 19); Phase 2 in progress. Date: 2026-11-16. Owner: `wianvdm`. Organization: `wimdotgg`.

`groundwork` is three things in one public repository:

1. **Template.** New projects are generated from it and start with every workflow, rule and agent convention in place.
2. **Rules source.** It hosts the reusable CI workflows and the agent scripts that projects pin by version tag.
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
| D5 | You accept once per epic | Applying `accepted` to an epic authorizes its decomposition. |
| D6 | Status is derived, never stored in labels | Label writes by `GITHUB_TOKEN` do not trigger workflows; a label state machine fails silently. |
| D7 | No stacked PRs | Merge queue only serves `main`; contract-first planning plus `blocked-by` replaces stacks. |
| D8 | Context lives in issue (intent), PR `## State` (current state), PR comments (journal) | No committed plan or state files. |
| D9 | Agents act through a machine account with Write role | Your admin credentials are never stored on the agent machine. |
| D10 | Admin work runs through approval-gated tiers | Agents request, you approve with one click, GitHub runs it with a short-lived scoped token. |
| D11 | Agents may edit workflows; all secrets live in protected environments | CODEOWNERS gates the merge; PR runs cannot reach environment secrets. |
| D12 | Reviewer agent is advisory | Deterministic checks and your CODEOWNERS approval are the blockers. |
| D13 | Versions stay `0.x.x` by default | `feat` and breaking bump minor, `fix` bumps patch; `1.0.0` only by your explicit config change. |
| D14 | Scripts are Node (ESM, no dependencies) | Cross-platform; you work on Windows. |
| D15 | Agent runtime (how workers are launched, which models) is out of scope for v1 | The template defines the protocol; a recommended setup is documented. |
| D16 | Agents act only on content written by you or the agent account | Public repos let anyone open issues and comment; that text is untrusted data. |
| D17 | Workers never force-push; `issue/*` branches only move forward and are updated from `main` by merge | Takeover is a plain push that fails as non-fast-forward for the race loser; the `issue-branches` ruleset enforces it server-side (9.5, V16). |
| D18 | A project may declare `"deploy": "none"` in `config.json` | Not every project ships a deployable; pass 2 then skips `DEPLOY_ENABLED` and deploy secrets. |

---

## 2. Identities and permissions

### 2.1 Accounts

| Identity | Kind | Role | Credentials on the agent machine |
|---|---|---|---|
| `wianvdm` | Your user | Org owner | **None.** You act in the browser or GitHub mobile app. Bootstrap and admin work go through tier 2 (section 12). |
| `wianvdm-agent` (user id 357302967) | Machine user (GitHub ToS allows one free machine account per person) | Org member, Write on `groundwork` and every project repo via team `agents` | Fine-grained PAT, stored by `gh` and Git Credential Manager. |
| `wimdotgg-release` | GitHub App | Installed on all org repos | None. Key only in each repo's `release` environment. |
| `wimdotgg-admin` | GitHub App (App ID 5782869, client ID `Iv23lipUuaiDCWGAKcYI`) | Installed on all org repos | None. Key only in the control repo's `admin` environment. |

App slugs live only in `.github/groundwork/config.json` (`apps.admin`, `apps.release`); scripts and rulesets never hardcode them. Bot logins are `<slug>[bot]`. Both Apps are owned by the organization (created at `https://github.com/organizations/<org>/settings/apps/new`, "Only on this account" = the org) and installed on the org with "All repositories" so new project repos are covered without a manual step. `GET /apps/{slug}` for a private org App returns 404 to the agent PAT.
GitHub reports the owner login as `WianVDM`. Logins are compared case-insensitively everywhere; `config.json` stores them lower-case.

### 2.2 Agent PAT (fine-grained, resource owner = the org, repository access "All repositories")

| Repository permission | Access | Why |
|---|---|---|
| Contents | Read and write | Branches, commits, claim refs |
| Pull requests | Read and write | Draft PRs, reviews (comment only), enqueue |
| Issues | Read and write | Create epics and tasks, comments, labels, issue type, sub-issues, dependencies |
| Workflows | Read and write | Agents may change workflow files via PR (D11) |
| Actions | Read and write | Read runs, re-run failed jobs, dispatch `admin-run` in `groundwork` |
| Commit statuses | Read | Read CI results |
| Metadata | Read | Required (also covers reading rulesets) |
| Administration, Secrets, Variables, Environments | **None** | Admin work goes through tier 2 |

No organization permissions. Fine-grained PATs offer no Checks permission; check runs on public repos are readable without it (V5).
Expiry 90 days; rotation is a tier 3 task with a reminder issue.

### 2.3 `wimdotgg-release` App

Repository permissions: Contents RW, Pull requests RW, Issues RW, Metadata R. It is the only actor allowed to create `v*` tags (ruleset bypass). release-please uses it so that release PRs trigger CI (PRs opened by `GITHUB_TOKEN` do not). The ruleset bypass entry needs the numeric App ID (not the client ID or installation ID); bootstrap resolves it with `GET /apps/{slug}`.
`release-please.yml` mints its token with `actions/create-github-app-token` v3.3.0 (commit `64ab729a6294000f5aa4a4bc0b73d1f32bc45510`; `app-id` is deprecated there): inputs `client-id`, `private-key`, `permission-contents: write`, `permission-pull-requests: write`, `permission-issues: write`. With `owner` and `repositories` unset the token covers only the current repository.

### 2.4 `wimdotgg-admin` App

Repository permissions: Administration RW, Contents RW, Environments RW, Secrets RW, Variables RW, Issues RW, Pull requests RW, Workflows RW, Actions RW, Metadata R.
Organization permissions: Issue types RW, Members R.
No organization Administration: `POST /repos/{template_owner}/{template_repo}/generate` is covered by repository Administration write plus Contents read on the template (V7). Team access (`PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}`) needs repository Administration write and Members read.
Every run mints an installation token restricted to the target repository and the permissions that operation needs (table in 12.1). Tokens last at most one hour.
One exception, for the generate call (the target repo does not exist yet, so the token cannot name it): bootstrap first mints a token restricted to `groundwork` with Administration write and Contents read. Only if GitHub refuses the generate call with that token does it mint an installation-wide token with the same two permissions, make that single call, and revoke the token at once with `DELETE /installation/token`. V7 decides which variant ships; the other is deleted.
`admin-run` mints through `scripts/groundwork/app-token.mjs` (RS256 JWT with `node:crypto`, then `POST /app/installations/{id}/access_tokens` with `repositories` and `permissions`), not through `actions/create-github-app-token`: the action has no `permission-*` input for Variables or Issue types, and the permission set varies per op.

### 2.5 Org settings (one-time, by you)

- Two-factor authentication required.
- Base repository permission: Read. Members cannot create repositories (bootstrap creates them).
- Fine-grained PAT policy: allowed, approval required (you approve the agent PAT once).
- Team `agents` containing `wianvdm-agent`. You grant it Write on `groundwork` once (14.1); bootstrap grants it Write on each project repo.
- Issue types are not set by hand: `admin-run op=create-issue-types` creates Epic, Feature, Bug, Chore, Spike and deletes the default Task.
- Actions: require actions pinned to a full-length commit SHA (the policy does not cover reusable workflows, which stay referenced by tag); "Require approval for all external contributors" for fork PR workflows; "Allow GitHub Actions to create and approve pull requests" off. `apply-settings` also sets all three per repository (10, V12).

---

## 3. Repository layout

Paths marked `[control]` exist only in `groundwork` and are removed by bootstrap from generated projects. Paths marked `[project]` are filled in per project.

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
    deploy.yml                    [project] deploy, smoke, rollback
    failure-alert.yml
    reusable-verify.yml           [control] reusable workflows (called by projects at a tag)
    reusable-security.yml         [control]
    admin-run.yml                 [control]
admin-ops/                        [control] reviewed one-off admin scripts
scripts/
  verify                          [project] contract entry point (sh + .cmd shim); groundwork's own is real, bootstrap swaps in the stub
  deploy  smoke  rollback         [project] written by the setup epic (sh + .cmd shim); absent with `"deploy": "none"`
  agent/  next.mjs claim.mjs checkpoint.mjs resume.mjs release.mjs plan-lint.mjs review-queue.mjs
  human/  inbox.mjs
  admin/  request.mjs             dispatches admin-run in groundwork; runs the push probe locally
  ci/     pr-metadata.mjs pr-size.mjs issue-format.mjs test-integrity.mjs check-results.mjs
          protected-labels.mjs settings-plan.mjs failure-alert.mjs
          fixtures/<script>.json   fixture cases and expected results for the ci tests
  lib/    github.mjs config.mjs trust.mjs markdown.mjs issue-model.mjs settings.mjs ci.mjs   (13.1)
  kit-update.mjs
  groundwork/                     [control] bootstrap.mjs check.mjs selftest.mjs app-token.mjs apply-settings.mjs create-issue-types.mjs admin-run.mjs
    stubs/ verify verify.cmd      [control] the project stub bootstrap writes to scripts/verify*; scripts/verify.cmd and the stub's verify.cmd are the same shim and need Git for Windows sh
  **/*.test.mjs                   unit tests beside each script (`node --test "scripts/**/*.test.mjs"`; a bare directory fails on Node 24)
.claude/
  settings.json                   hooks and permission rules
  skills/ groundwork-planner/ groundwork-worker/ groundwork-reviewer/
AGENTS.md                         canonical agent rules
CLAUDE.md                         contains `@AGENTS.md`
.gitattributes                    LF everywhere, CRLF for .cmd and .bat
.gitignore                        ignores `.claude/worktrees/`; re-includes `.claude/skills/groundwork-*/` (below)
docs/
  setup.md                        one-time org setup, per-project path
  workflow.md                     the flow for humans, Mermaid diagram, touchpoints
  spec.md                         this document
  decisions/<N>-<slug>.md         spike decision records (4.1)
release-please-config.json
.release-please-manifest.json
version.txt                       release-please `simple` version file; must exist, it is never created
CHANGELOG.md
SECURITY.md
LICENSE
README.md
```

All machine-read configuration under `.github/groundwork/` is JSON: Node has no built-in YAML parser and D14 forbids dependencies. YAML is used only for files GitHub itself reads (workflows, issue forms, `dependabot.yml`).
In `groundwork`, caller workflows reference reusable workflows locally (`./.github/workflows/reusable-*.yml`); bootstrap rewrites those references for projects (14.2).
`.gitignore` carries these lines, in this order, because a global git ignore may exclude `.claude/skills/`; only groundwork's own skills are re-included:
```
!.claude/skills/
.claude/skills/*
!.claude/skills/groundwork-*/
```
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

Review threads must be resolved before merge (ruleset). The worker resolves each thread after fixing or answering it and records it in `## Review log`; that is how advisory findings (D12) get closed without the reviewer holding a veto.

Roles are prompts packaged as `.claude/skills/groundwork-*` and described in `AGENTS.md`. All roles use the agent account; the session id separates them.

### 6.2 Planning for width

- Contract task first (shared types, schema, API shape), then lane tasks that can run concurrently, then one integration task blocked by all lanes.
- Two tasks whose `## Touches` overlap must be linked with `blocked-by` or merged into one task.
- Tasks touching a hotspot name it in `## Touches`.
- The plan comment on the epic lists lanes and lane width.
- `plan-lint` fails on: dependency cycle, task without AC (Spikes excepted), task without `## Serves`, epic without integration task, more than 12 sub-issues, depth over the limit, overlapping `## Touches` without a `blocked-by` link. It reports lane width.
- The planner runs `plan-lint` locally as its last step and posts the report comment. Adding sub-issues or dependencies fires no `issues` event on the epic, so the workflow (8.4) cannot be relied on to refresh the report.

### 6.3 Worker loop

1. `node scripts/agent/next.mjs` returns the next eligible task: ready status, Definition of Ready met, hotspot not held by any open PR's actual changed files. Takeover candidates (6.4) rank before fresh tasks. Order after that: `priority:p0` hotfixes, then epic priority, then sub-issue order.
2. `node scripts/agent/claim.mjs N`:
   - creates an empty commit `chore(claim): #N [session <id>]` through the API (`POST /git/commits` with the tree and SHA of `main` as tree and parent), so the claim does not depend on local checkout state. `claim.mjs` never sends `author` or `committer` dates, so GitHub stamps the committer date server-side; this agent-created API commit is the only place a commit date is trusted (6.4);
   - creates `refs/heads/issue/N` via `POST /repos/{o}/{r}/git/refs`. **Only HTTP 201 counts as claimed**; any other response (422 when the ref exists) means "not claimed, try the next candidate";
   - posts a one-line pointer comment on the issue (`issue/N`, session id, marker `<!-- groundwork:claim -->`); its server-side `created_at` is the claim time until the PR exists;
   - opens a draft PR from `issue/N` with the PR template, `Closes #N`, and an initial `## State`. If this step fails after the ref exists, `claim` retries it; a ref without a PR counts as an expired lease 15 minutes after the pointer comment, or, when there is no pointer comment either, 15 minutes after the claim commit's committer date;
   - posts the claim comment on the PR (claim, checkpoint and takeover comments all live on the PR, 6.4).
3. Build. Bugs start with a failing test. Push early. Bring the branch up to date with `main` by merging it (`git merge origin/main` or the PR's "Update branch"), never by rebase: `issue/*` only moves forward (D17).
4. `checkpoint` at the required moments (6.5).
5. Mark ready for review when Definition of Done is met. Required checks and reviewer run.
6. Address review findings; after 3 rounds, `needs-decision`.
7. Enqueue with `gh pr merge N --auto --squash` (without `--squash` `gh` refuses; the PR enters the merge queue once requirements are met, including your approval on protected paths). The worker returns to step 1.
8. If the PR is ejected from the queue or receives new findings, the same worker returns to it before taking new work.
9. After merge: handover comment on the issue (`scripts/agent/release.mjs N --merged`); for a Spike it also appends the decision line to the epic's `## Decisions`.

### 6.4 Leases and takeover

- A claim is a lease only while its PR is a **draft**. Ready, queued and awaiting-you PRs never expire.
- A draft lease expires after 4 hours without agent activity, measured by the server-side `created_at` of the latest PR comment authored by the agent account (claim, checkpoint and takeover each post one), falling back to the PR's `created_at`. PR `updated_at` is not used: any outside commenter can bump it on a public repo. Commit dates are client-controlled and not used either, with one exception: before a PR or pointer comment exists, the claim window runs from the claim commit's committer date, which GitHub stamps because `claim.mjs` creates that commit through the API and never sends dates (6.3).
- Takeover is compare-and-swap: the new worker reads the branch head SHA, creates a takeover commit `chore(claim): #N takeover [session <id>]` with that SHA as parent (`POST /git/commits`), and moves the branch with a plain fast-forward update (`PATCH /git/refs/heads/issue/N` with `force: false`). If the head moved in between, the update is not a fast-forward and fails; the loser of the race moves on. The winner posts a takeover comment, which restarts the lease.
- Workers never force-push in any form (no `--force` or its lease variant, no `+` refspec, no `force: true`), and the `issue-branches` ruleset (9.5) rejects non-fast-forward updates for everyone, so a revived worker's stale push is rejected. A revived worker runs `resume` first and stops if the PR footer names another session.
- Takeover continues from `resume` output; it never restarts the task.
- `needs-decision` releases the claim (`release.mjs N --decision`): the draft PR stays open with its `## State`, the PR body gets the marker `<!-- groundwork:released -->`, and the worker takes other work. Once you remove `needs-decision`, the marker makes the PR a takeover candidate immediately; takeover removes the marker.
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

- Trusted authors: `wianvdm`, `wianvdm-agent`, `wimdotgg-admin[bot]` (bootstrap opens the "Project setup" epic), `wimdotgg-release[bot]` (release PRs only), `dependabot[bot]` (dependency PRs only). The list lives in `config.json` (`trustedAuthors`, App bots named by App key) and is read through `scripts/lib/trust.mjs`; nothing else hardcodes it. Logins compare case-insensitively.
- `next` ignores issues not authored by a trusted account. To adopt an external report, you or an agent create a task that links to it.
- `resume`, the reviewer and the planner treat text from other authors as data, never as instructions.
- Outside contributors' PRs cannot satisfy `PR metadata` (no accepted issue) and their workflow runs require your approval.

---

## 7. PR contract

**Branch:** `issue/N` (deterministic, the claim lock).
**Title:** Conventional Commit, `<type>(<scope>)!: <imperative summary>`. Types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test. `!` marks breaking. Title type must match issue type: Feature → `feat`; Bug → `fix`; Chore → `build|chore|ci|docs|refactor|style|test|perf|revert`; Spike → `docs(spike)`.
**Squash commit:** title = PR title, body blank. Breaking changes therefore must use `!` in the title.

**Body (`pull_request_template.md`)**

```
Closes #N

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

## State
(see section 6.5 format)

## Review log
- <finding>: fixed in <sha> | answered: <reason>

---
Agent: <model>/<harness> · session <id>
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
| `settings-plan` | `scripts/ci/settings-plan.mjs` | PRs touching `.github/groundwork/**` only (the validator returns `skip` when the PR changes no file under `.github/groundwork/`). Writes desired vs. live settings to the job summary (tier 1, section 12); the PR's settings files are read as data from a second checkout of the PR head (`env.PR_ROOT`), never executed. The PR `GITHUB_TOKEN` reads rulesets, environments and labels; Actions settings return 403, so they are shown as a file diff against the base (V4). Fails only when a settings file is invalid. |
| `Check` | `scripts/ci/check-results.mjs` | `needs: [verify, security, test-integrity, scripts, settings-plan]`, `if: always()`. Reads `toJSON(needs)` from `env`. Fails if any needed job has a result other than `success`. Stays in the caller so the required name is stable. |

`test-integrity`, `settings-plan` and `Check` check out their validator scripts, `scripts/lib/` and `.github/groundwork/config.json` from the **base** commit (`github.event.pull_request.base.sha`), like `PR metadata` and `pr-size` (8.3), so a PR cannot change the rules it is judged by; on `merge_group` and `push` they use the event's own commit. The workflow YAML comes from the PR and changes to it need your CODEOWNERS approval.
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
- Exemptions from all of the above: a valid `dependencies` with author `dependabot[bot]` and a minor or patch update; a valid `automated` with author `wimdotgg-release[bot]`; a valid `no-issue` whose latest `labeled` event is later than the head's arrival in this PR, and never on a `synchronize` or `reopened` run, where it is refused with `` `no-issue` must be re-applied after new commits or a reopen ``. Never when the head repository differs from this repository (case-insensitive owner/name): activity is read by branch name from this repository, so a fork head proves nothing, and the PR fails with `no-issue does not apply to PRs from another repository`. Arrival is the newest arrival entry on the PR branch (repository activity API, `GET /repos/{owner}/{repo}/activity?ref=refs/heads/<branch>`, server `timestamp`; types `push`, `force_push`, `branch_creation`, `pr_merge`, `merge_queue_merge`; `branch_deletion` is not one), and its `after` must be the head SHA: an older entry for the same SHA does not stand in for a newer push of another commit (listing lag or a moved branch), so a newest entry for another SHA fails the check (exit 2) and a re-run clears it. Entries with the same newest timestamp must all be the head. A later `head_ref_force_pushed`, `reopened`, `base_ref_changed` or `automatic_base_change_succeeded` timeline event moves arrival later; no arrival entry at all also fails the check (exit 2). Commit dates are client-controlled and not used.
- Dependabot **major** updates fail until an agent edits the PR body to add `Closes #N` for a Chore issue. For author `dependabot[bot]` the branch, `## Evidence` and `## State` rules are waived; the issue rules apply.

`pr-size` fails when changed lines (additions plus deletions) exceed 400 or files exceed 20, excluding lockfiles, snapshot files and the generated-file globs in `config.json`, unless a valid `size-exception` is present. Exempt by the same rule as `PR metadata` (section 5): a valid `dependencies` with author `dependabot[bot]` (any update type), or a valid `automated` with author `wimdotgg-release[bot]`.

### 8.4 Issue and planning workflows

| Workflow | Trigger | Does |
|---|---|---|
| `issue-format.yml` | `issues`: opened, edited, reopened, typed, untyped | Validates headings for the type and unique criterion IDs. Invalid (or no type): adds `needs-format` and posts or updates one comment with the errors. Valid: removes `needs-format`. Permissions `issues: write`. The parent link is not checked here: it is added after creation and fires no `issues` event, so `plan-lint`, `next` and `PR metadata` check parent and depth instead. |
| `protected-labels.yml` | `issues`: labeled; `pull_request_target`: labeled, synchronize, reopened | Removes protected labels applied by anyone but their required actor (section 5; `github.event.sender.login`, V9), and removes `no-issue` on every `synchronize` and `reopened` (hygiene; the freshness rule in 8.3 is the gate). Checks out nothing from the PR and only calls the API. Permissions `issues: write`, `pull-requests: write`. |
| `plan-lint.yml` | `issues`: opened, edited, labeled, filtered to type Epic by a job `if`; `workflow_dispatch` with input `epic` | Runs `plan-lint` and posts or updates one report comment on the epic. Permissions `issues: write`. |

### 8.5 Release and operations workflows

| Workflow | Trigger | Does |
|---|---|---|
| `release-please.yml` | `push` to `main`; `workflow_dispatch` | Job `if: vars.GROUNDWORK_READY == 'true'` (repository variable set at the end of bootstrap pass 1, so the run triggered by template generation does not fail on a missing environment). Environment `release`; mints the `wimdotgg-release` token (2.3); runs `googleapis/release-please-action` with `token`, `config-file`, `manifest-file`. Concurrency group `release-please`, never cancelled. |
| `deploy.yml` | `release: published` | Job `if`: `vars.DEPLOY_ENABLED == 'true'` and the release is not a prerelease. Environment `production` (your approval, `v*` tags only; the run's ref is the release tag). Runs `scripts/deploy <tag>`, then `scripts/smoke`; on failure runs `scripts/rollback <previous tag>` and smokes again, and the job still fails. Writes a summary and appends a deploy record to the release notes (`contents: write`). Concurrency group `production`, never cancelled. |
| `failure-alert.yml` | `workflow_run` completed for release-please and deploy | Opens one alert issue per workflow on failure, comments on repeats, closes on the next success. Alert issues are authored by `github-actions[bot]` and have no type; `issue-format` skips issues by that author, `next` ignores them (untrusted author), `inbox` lists them. Permissions `issues: write`. |

### 8.6 Reusable workflows and pinning

Projects call `uses: <org>/groundwork/.github/workflows/reusable-*.yml@vX.Y.Z`. The org's SHA-pinning policy does not apply to reusable workflows, and `v*` tags are immutable (9.3), so a tag reference is stable. Dependabot (`github-actions` ecosystem) opens bump PRs; `.github/` is a protected path so you approve them. `groundwork` itself calls its reusable workflows locally (`./.github/workflows/...`).
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
- The org-admin bypass is pull-request-only (valid for branch rulesets only). It exists so you can merge your own protected-path PRs, which you cannot approve yourself. A bypass merge also skips the merge queue (V6). Your admin credentials are never on the agent machine, so agents cannot use it.
- The merge queue cannot be combined with wildcard branch patterns; `~DEFAULT_BRANCH` is fine.
- Pass 2 adds `{ "type": "code_scanning", "parameters": { "code_scanning_tools": [ { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" } ] } }` (all three fields required). It works with the merge queue: no CodeQL analysis is produced for the queue ref, and the PR analysis satisfies the rule (V10). Before pass 2 (the live `main` ruleset has no `code_scanning` rule) and while CodeQL default setup is not `configured`, `apply-settings` sends `main` without a `code_scanning` rule present in `rulesets/main.json`, and `check` reports that rule `deferred`, not `differ`. Once the live rule exists, pass 2 has run and `check` fails closed: the rule, the default setup and `DEPLOY_ENABLED` are compared normally (10).
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
Projects append their test, lint and coverage config paths. The four scanner configs are protected because the scanners read them from the PR checkout, so an unprotected edit could silence a finding.
Release PRs touch the manifest and `version.txt`, so they need your approval; you merge them anyway (section 11). `scripts/groundwork/` is protected because `admin-run` executes it (bootstrap, check, app-token) with the admin App token; unprotected, a merged agent PR would run with admin rights at your next approval. `scripts/agent/`, `scripts/admin/` and `kit-update.mjs` are deliberately unprotected: they run with the agent's own credentials and gate nothing. `scripts/deploy`, `scripts/smoke` and `scripts/rollback` run with `production` secrets, but only after your approval of each deploy.

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

- `repository` → `PATCH /repos/{o}/{r}`: visibility public; `has_issues` on; `has_projects`, `has_wiki`, `has_discussions` off; `allow_squash_merge` on, `allow_merge_commit` and `allow_rebase_merge` off; `squash_merge_commit_title: PR_TITLE`, `squash_merge_commit_message: BLANK`; `allow_auto_merge`, `delete_branch_on_merge`, `allow_update_branch` on; `security_and_analysis` with `secret_scanning` and `secret_scanning_push_protection` `enabled`. `controlRepository` holds `is_template: true`, sent on `groundwork` only.
- `teamAccess` → team `agents`: `push` (Write) through the team-repo endpoint (2.4).
- `security` → `PUT /private-vulnerability-reporting`, `PUT /vulnerability-alerts`, `PUT /automated-security-fixes`; `PATCH /code-scanning/default-setup` with `state: configured` in pass 2 only: `apply-settings` never sends it. Before pass 2 `check` reports a live state other than `configured` as `deferred`; after pass 2 (live `main` ruleset has the `code_scanning` rule) it is a mismatch, fixed by re-running `bootstrap-pass2`.
- `actions` → `PUT /actions/permissions` (`enabled: true`, `allowed_actions: all`, `sha_pinning_required: true`); `PUT /actions/permissions/workflow` (`default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`); `PUT /actions/permissions/fork-pr-contributor-approval` (`approval_policy: all_external_contributors`). All three verified (V12).
- `variables` → repository variables (Variables write). Each carries `assertWhen`, a signal read from the live repo (`settings.readSignals`, 13.1); `apply-settings` and `check` assert the variable only while its signal holds, otherwise `apply-settings` leaves it alone and `check` reports it `deferred`. `kitInstalled`: the repo contains `.github/groundwork/kit-version.txt` on its default branch, or is the control repo; it gates `GROUNDWORK_READY`, first set at the end of bootstrap pass 1 (14.2) and on `groundwork` by its first `apply-settings` (14.1). `deployReady`: `config.json` `deploy` is not `none`, and CodeQL default setup is `configured` or pass 2 has run (live `main` ruleset has the `code_scanning` rule); it gates `DEPLOY_ENABLED`, first set by `bootstrap-pass2`. After pass 2, `DEPLOY_ENABLED` unset while `deploy` is not `none` is therefore a mismatch, never `deferred`.
- `environments` → 10.1.

`apply-settings` is idempotent, applies rulesets last, and stops at the first failed call with the list of what was and was not applied; re-running is the recovery path.

### 10.1 Environments

| Environment | Repos | Reviewers | `prevent_self_review` | `can_admins_bypass` | Deployment refs | Secrets and variables |
|---|---|---|---|---|---|---|
| `release` | all | none | false | true (API default) | branch `main` | secret `RELEASE_APP_KEY`; var `RELEASE_APP_CLIENT_ID` |
| `production` | projects | `wianvdm` | false | false | tag `v*` | project deploy secrets (none with `"deploy": "none"`) |
| `admin` | `groundwork` only | `wianvdm` | false | false | branch `main` | secrets `ADMIN_APP_KEY`, `RELEASE_APP_KEY`; vars `ADMIN_APP_CLIENT_ID`, `RELEASE_APP_CLIENT_ID` |

- `PUT /repos/{o}/{r}/environments/{name}` body: `reviewers: [{ "type": "User", "id": <numeric user id> }]` (resolved from the login with `GET /users/{login}` at apply time), `prevent_self_review`, `can_admins_bypass`, `deployment_branch_policy: { "protected_branches": false, "custom_branch_policies": true }` (the two booleans must differ). `protected_branches: true` is not used: `main` is protected by a ruleset, not by classic branch protection.
- Then one `POST /repos/{o}/{r}/environments/{name}/deployment-branch-policies` per ref: `{ "name": "main", "type": "branch" }` or `{ "name": "v*", "type": "tag" }`.
- Environment secrets are written on the runner with `gh secret set --env <name> --repo <o>/<r>` (it does the sealed-box encryption that dependency-free Node cannot); the value is piped on stdin, never passed as an argument. Environment variables with `gh variable set --env`. Both need Environments write: the environment secret and variable endpoints sit under Environments in the GitHub App permissions reference, while Secrets and Variables cover repository-level ones.
- The release App key reaches each project's `release` environment by this route during bootstrap, copied from the `admin` environment.
- Self-review is irrelevant in practice: runs are triggered by the agent account or the release App, never by you.

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
- `groundwork` versions itself the same way; its tags are what projects pin.

---

## 12. Admin elevation

| Tier | Scope | Mechanism | Your action |
|---|---|---|---|
| 0 | Normal work | Agent PAT | none |
| 1 | Settings as code: `settings.json`, `labels.json`, `rulesets/*.json` | Agent opens a PR; the `settings-plan` job writes a plan to its job summary (desired vs. live where readable, otherwise file diff); after merge the agent runs `scripts/admin/request.mjs apply-settings --repo <r> --ref <sha>`; the run ends with `check` | CODEOWNERS approval on the PR, then approve the `admin` run |
| 2 | One-off admin work: bootstrap, new repo, issue types, cleanup | `scripts/admin/request.mjs <op>` dispatches `admin-run` in `groundwork` | Read the run summary, approve the `admin` environment |
| 3 | Owner-only: create Apps, billing, org ownership, secret values, PAT rotation | You, in the browser | everything |

### 12.1 `admin-run.yml`

The workflow is always dispatched on `main` of `groundwork` (`request.mjs` sends `ref: main`). The `admin` environment only admits `main`, so a dispatch from any other branch, including one carrying a modified `admin-run.yml`, stops at the environment and never reaches a secret. The built-in op code and `admin-run.yml` therefore always come from reviewed `main`.

Inputs (all strings; passed to steps through `env`):

| Input | Meaning |
|---|---|
| `op` | choice, one of the ops below |
| `target_repo` | repository name without owner, `^[A-Za-z0-9._-]+$`; empty for `create-issue-types`. The owner is always this org. |
| `ref` | 40-character commit SHA. `apply-settings`: a commit in `target_repo` that is `main` or an ancestor of it; the settings files are read at that commit. `script`: a commit in `groundwork` that is `main` or an ancestor of it. Empty for other ops. `plan` verifies ancestry with the compare API and fails otherwise. This input is data, not the workflow's run ref. |
| `script_path` | `op=script` only; must match `admin-ops/*.mjs` |
| `args` | JSON object, validated per op against a fixed schema; unknown keys fail |

Jobs:
1. `plan` (no environment, no secrets, `contents: read`): validates inputs; for `op=script` fetches the file at `ref`, prints it, its SHA-256 and its exported `permissions` to the run summary; for built-in ops prints the operation, target, args and requested token permissions. Outputs the SHA-256.
2. `apply` (environment `admin`, needs `plan`): mints a `wimdotgg-admin` token scoped to the op's repositories and permissions (2.4); for `op=script` re-fetches the blob at `ref`, verifies the SHA-256 matches `plan`, then runs it; writes a summary of every API call made (method, path, status; never bodies that may hold secrets). Any failed call fails the job; ops are idempotent, so the fix is to re-run. `bootstrap`, `bootstrap-pass2` and `apply-settings` end the same job with the read-only `check` against the target, so one approval covers the change and its verification; a failed row fails the run.

| Op | Token repositories | Token permissions | Does |
|---|---|---|---|
| `bootstrap` | step 1: `groundwork` (fallback: installation-wide for the generate call only, revoked at once; 2.4); step 2: `target_repo` | step 1: Administration write, Contents read. Step 2: Administration, Contents, Workflows, Environments, Variables, Issues write; Members, Actions read | 14.2 pass 1, then `check` |
| `bootstrap-pass2` | `target_repo` | Administration, Variables write; Contents, Environments, Actions, Issues, Members read | 14.2 step 4, then `check` |
| `apply-settings` | `target_repo` | Administration, Environments, Variables, Issues write; Contents, Members, Actions read | Syncs `settings.json`, `labels.json`, environments and rulesets from `ref`, then `check`. On `groundwork` it also writes the `release` environment. On every target it writes the `release` environment secret `RELEASE_APP_KEY` and variable `RELEASE_APP_CLIENT_ID`, and deletes live repository-level rulesets the settings do not declare. Refuses before any write when no `main` ruleset is desired, or when the desired `main` lacks `code_scanning` while pass 2 has run or its state is unreadable. |
| `check` | `target_repo` | Administration, Contents, Environments, Variables, Actions, Issues, Members read | Read-only comparison (section 13); stays a standalone op for drift checks |
| `create-issue-types` | none (org) | Issue types write | Creates the five types, renames case variants, deletes only GitHub default types (Task); other types outside the five are left alone and fail the run for the owner to review; idempotent. Permission key `issue_types` (V7: the GitHub API names it in the `X-Accepted-GitHub-Permissions` header; mint body still to confirm live) |
| `script` | `target_repo` | the script's exported `permissions` | Runs `admin-ops/<name>.mjs` |
| `selftest` | step 1 as `bootstrap`; then the throwaway repo | as `bootstrap` | Bootstraps `selftest-<run id>`, runs `check` and the section 19 probes that need admin rights, archives the repo. Deleting it is tier 3. |

Ops available now: `apply-settings`, `check` and `create-issue-types`; `bootstrap`, `bootstrap-pass2`, `script` and `selftest` arrive in Phase 4.

Labels are written through the Issues permission. The permission keys for the token request body come from the GitHub App permissions reference (V7 covers the Issue types key).

Concurrency group `admin-${{ inputs.target_repo || 'org' }}`, never cancelled.

`admin-ops/*.mjs` scripts export `const permissions` (the token permissions they need, shown in `plan`) and `async function run({ github, repo, args, log })`; they never read environment variables directly.

---

## 13. Scripts

Node 24+, ESM, no npm dependencies. They call GitHub through `gh api` (agent machine) or `fetch` with the token from `env` (CI and `admin-run`); `scripts/lib/github.mjs` hides the difference. The one exception is `gh secret set` / `gh variable set` in `admin-run` (10.1). Every script exits non-zero with a one-line reason on failure and supports `--json`. Run as `node scripts/agent/<name>.mjs`; Windows works under PowerShell and Git Bash.

| Script | Inputs | Output and effects |
|---|---|---|
| `agent/next.mjs` | `--json` | Next eligible task or takeover candidate, or "nothing ready" with reasons per skipped candidate |
| `agent/claim.mjs` | `N`, `--session <id>` | Claim per 6.3, or takeover per 6.4 when `issue/N` exists and is a takeover candidate; exit code 0 claimed, 3 held by someone else, 1 error |
| `agent/checkpoint.mjs` | `--auto` (hook mode: no-op unless on `issue/N` with a draft PR) | Push, rewrite `## State`, journal comment |
| `agent/resume.mjs` | `N` | Bounded briefing (6.5) |
| `agent/release.mjs` | `N`, `--decision` or `--merged` | Releases claim or posts handover |
| `agent/plan-lint.mjs` | epic number, `--close` | Lint report; exit non-zero on failure |
| `agent/review-queue.mjs` | | PRs ready for review without a review from another session |
| `human/inbox.mjs` | | Proposed epics, `needs-decision`, protected-path PRs awaiting you, release PR, pending `production` and `admin` approvals, alert issues, orphaned claims. Run by an agent with the PAT; it prints links you open in the browser. |
| `admin/request.mjs` | `op` (`apply-settings`, `check`, `create-issue-types`, `probe`), `--repo`, `--ref` (`apply-settings`; defaults to the target `main` head), `--args` | Dispatches `admin-run` on `main` of `groundwork` (org and control repo name from `config.json`); prints the run URL to approve. `request.mjs probe --repo <r>` dispatches nothing: it runs the push probe below locally with the PAT, no approval. |
| `ci/*.mjs` | event payload path, env | CI validators (section 8); contracts in 13.1 |
| `lib/*.mjs` | | Shared modules; contracts in 13.1 |
| `kit-update.mjs` | `<tag>` | Copies scripts, templates and caller workflows from that groundwork tag onto a branch, rewrites the reusable-workflow tag and `kit-version.txt`, and opens a PR. Never touches `[project]` paths or `config.json` values the project changed. The PR goes through a Chore issue like any other. |
| `groundwork/bootstrap.mjs` | repo, pass | Section 14 |
| `groundwork/check.mjs` | repo | Pass/fail table of live vs. expected settings, rulesets, labels, environments (reviewers, `can_admins_bypass`, ref policies, secret and variable names), repository variables, team access, Actions settings. Pass-2 items are `deferred` before pass 2 and fail closed after it (10). Reads only; token reads in 12.1. |
| `groundwork/selftest.mjs` | | 12.1 |
| `groundwork/app-token.mjs` | client ID, key, repositories, permissions | Installation token (2.4) |
| `groundwork/apply-settings.mjs`, `groundwork/create-issue-types.mjs`, `groundwork/admin-run.mjs` | | Admin ops (12.1); `admin-run.mjs` is the dispatcher |

Push probe (the agent identity is the one the rule must stop, so it runs on the agent machine with the PAT, not in `admin-run`): create a dangling empty commit on top of `main` with `POST /git/commits`, then `PATCH /git/refs/heads/main` to it without `force`. Expected: rejected with a rule violation (422 or 409). An accepted update means protection is broken; `request.mjs` reports failure and leaves the empty commit `chore(check): probe` on `main` as evidence. Tag rules are checked by ruleset comparison only: a probe tag could never be deleted (9.3).

Configuration lives in `.github/groundwork/config.json` (org, control repo, accounts, App slugs, trusted authors, label actors, deploy mode, limits from section 16, size-exclusion and generated-file globs, test-integrity patterns) and `hotspots.json`; scripts read both through `scripts/lib/config.mjs`.

### 13.1 Module contracts

Conventions for every module under `scripts/lib/` and `scripts/ci/`:

- ESM, `node:` built-ins only, Node 24+ (`path.posix.matchesGlob` for globs; it may print an experimental warning, which is harmless, and a unit test asserts `**/x` matches a root-level `x`). Types are JSDoc over plain JSON-compatible objects.
- Library modules never call `process.exit`, never write to stdout or stderr, and read the environment only through an `env` argument. They throw; every thrown error is a `GitHubError`, `ConfigError` or `SettingsError` with a one-line `message`. Content problems (an invalid body, a missing heading) are return values, not throws.
- Logins are compared only through `trust.sameLogin`. URL path segments built from caller input go through `github.apiPath`, never string concatenation.
- Internal dependencies (no cycles): `github`, `config`, `markdown` depend on nothing internal; `trust` → `config`; `issue-model` → `github`, `markdown`, `trust`; `settings` → `github`, `config`, `trust` (`resolveActor` for reviewer `owner`); `ci` → `github`, `config`, `trust`. Validators import `ci` plus what their row names.

#### Admin op modules

Each module under `scripts/groundwork` exports `OP`, `PERMISSIONS`, `TOKEN_SCOPE` (`target` or `org`), `validateArgs(args) -> string[]` and `run(ctx) -> { ok, summary }` with `ctx { client, token, org, repo, settingsRoot, config, env, log }`. `check` also exports `runCheck`, which fails on zero rows and adds an `unreadable` row per unreadable live section.

`app-token.mjs` exports:
- `createAppJwt({ clientId, privateKey, now? })`: RS256 JWT, RSA keys only.
- `mintInstallationToken({ client, org, repositories: string[]|"all", permissions, env? })`: the granted scope must equal the requested one except one extra `metadata: read`; any mismatch revokes the token and throws; a failed revoke is reported.
- `revokeInstallationToken(client)`.

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
| `createClient({ env, token?, onCall? }) → GitHubClient` | `token` given: `fetch` with that token (`admin-run` minted tokens). Else `env.GITHUB_ACTIONS === 'true'`: `fetch` with `env.GITHUB_TOKEN` (empty token throws). Else `gh`: spawns `gh api -i --method <m> <path>` with an argument array (no shell), body on stdin (`--input -`), status and headers parsed from the `-i` output. Base URL `env.GITHUB_API_URL` or `https://api.github.com`. `onCall(CallRecord)` runs after every call (the `admin-run` summary). |
| `createFixtureClient(routes, { onCall? }) → GitHubClient` | `routes`: `Record<string, Response \| Response[]>` keyed `"<METHOD> <path>"` with query parameters sorted by name and encoded; route keys are normalised to the same form as lookups (`"GET /repos/o/r/pulls/7/files?per_page=100"` for the first page, `"GET /repos/o/r/pulls/7/files?page=2&per_page=100"` for the next); an array yields successive responses. GraphQL calls are keyed `"POST /graphql"` with an ordered array of responses, one per call. An unmatched call throws `GitHubError` (status 0, `no fixture for <key>`). Every test uses this; no test touches the network. |
| `apiPath(template, params) → string` | Fills `{name}` segments with `encodeURIComponent(params.name)`; a missing param throws `GitHubError` (status 0). |
| `repoFromEnv(env) → RepoRef` | From `GITHUB_REPOSITORY`; throws `GitHubError` (status 0) when absent or malformed. |
| `currentRepo() → Promise<RepoRef>` | Agent machine only: `gh repo view --json owner,name`. |
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
| `loadHotspots({ root }) → Promise<Hotspot[]>` | `hotspots.json` (`{ "schemaVersion": 1, "hotspots": Hotspot[] }`); `[]` when the file is absent. |
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
| `parseSections(body) → { sections: Array<{ name, line, content }>, byName: Record<string, string>, duplicates: string[] }` | Level-2 headings after `stripCommentsAndFences`. `name` is the heading text with a trailing parenthesised group removed (`## State  (checkpoint 3 ...)` → `State`); `line` is the full heading line. |
| `findClosingRefs(body) → Array<{ keyword, owner: string \| null, repo: string \| null, number }>` | Every GitHub closing keyword (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved; any case) outside comments, fences and inline code spans. Also matches full issue and PR URLs after the keyword. |
| `criterionIds(content, prefix) → string[]` | IDs (`E1`, `AC3`) from checklist lines `- [ ] <id> ...` or `- [x] <id> ...`, in order, duplicates kept. |
| `parseTable(content) → Array<Record<string, string>>` | First GFM table in the content; header cells are the keys, cells trimmed. |
| `parseStateSection(section) → { header: { checkpoint, at, agent, session }, fields: Record<string, string> }` | 6.5 format; missing header parts are `null`. `section` is the `{ line, content }` entry from `parseSections` or a full string that starts with the `## State` heading. |
| `templatePlaceholders(templateText) → string[]` | The `<...>` tokens of a template (`state-section.md`); a body still containing one is unfilled. |
| `replaceSection(body, name, content) → string` | Replaces the named section's content, or appends the section. A section ends at the next heading or at a line that is exactly `---` (the PR footer survives); the body always ends with one newline. |
| `hasMarker(body, name)`, `addMarker(body, name)`, `removeMarker(body, name)` | Marker `<!-- groundwork:<name> -->` (`released`, `claim`, `issue-format`, `alert:<workflow path>`). |
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
 *   claimCommitAt: committer date of the ref head when its message matches the claim commit format `chore(claim): #N [session <id>]`, else null */
```

| Export | Contract |
|---|---|
| `ISSUE_TYPES`, `REQUIRED_HEADINGS: Record<IssueType, string[]>` | The 4.3 heading lists; the only copy in code. |
| `TITLE_TYPES: Record<IssueType, { types: string[], scope: string \| null }>` | Section 7 mapping; Spike is `{ types: ['docs'], scope: 'spike' }`. |
| `parseConventionalTitle(title) → { type, scope, breaking, summary } \| null` | `null` when the title is not a Conventional Commit with a section 7 type. |
| `validateIssueBody({ type, body }) → { ok: boolean, errors: string[] }` | Type present and known; each required heading exactly once; criterion IDs unique; Epic has at least one `E` ID; Feature, Bug, Chore have at least one `AC` ID; `## Serves` lists only `E<n>` IDs. |
| `loadIssueFacts(client, { owner, repo, number }, { config }) → Promise<IssueFacts>` | Reads the issue, its timeline (label validity), its parent chain (`GET .../issues/{n}/parent`, 404 ends the chain; a parent in another repository, or a 404 while the child has `parent_issue_url`, throws `GitHubError`), `blocked_by` dependencies, `git/ref/heads/issue/{n}` (404 = no branch), the issue PR (head `issue/{n}`, filtered on `head.ref`; the open one when it exists, else the newest by `created_at`), its merge-queue state (GraphQL `isInMergeQueue`), the newest PR comment by the agent account, the newest issue comment by the agent account with marker `claim`, and the ref head commit (`git/commits/{sha}`) for `claimCommitAt`. Throws `GitHubError`. |
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

`check.mjs`, `apply-settings` and `settings-plan` share this module; `check` passes when every row is `match` or `deferred`. `apply-settings` sends nothing for a `deferred` item.

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
| `pr-metadata` | `pull_request`; `merge_group` → `skip` | `loadIssueFacts` for the closed issue; PR timeline; repository activity for the PR branch (`/activity?ref=refs/heads/<branch>`, paginated) when `no-issue` is present on a same-repository PR, throws when no arrival is listed or the newest arrival is not the head SHA; PR files for Spikes; base `templates/state-section.md` from `root` | Any 8.3 rule; `no-issue` never exempts a `synchronize` or `reopened` run, nor a PR from another repository (`no-issue does not apply to PRs from another repository`). Dependabot update type is the largest semver jump over every `from <a> to <b>` pair in title and body. Drafts get `## State` problems as warnings. |
| `pr-size` | `pull_request`; `merge_group` → `skip` | PR files (paginated); labels read live from the issue | Non-excluded additions plus deletions over `limits.prChangedLines`, or non-excluded files over `limits.prFiles`, without a valid `size-exception`. Exclusions: `sizeExcludeGlobs` plus `generatedGlobs`; a rename is excluded only when both names match an exclusion glob. Fails (exit 2) when GitHub lists fewer files than `changed_files` (3000-file cap). Exemptions (`pass`) by the `PR metadata` rule: valid `dependencies` with author `dependabot[bot]`, or valid `automated` with the release bot as author (8.3). |
| `test-integrity` | `pull_request`; `merge_group`, `push` → `skip` | PR files with `patch`; PR timeline | A `testGlobs` file deleted or renamed to a non-test path; a test file losing more `testDeclarationPatterns` lines than it gains; an added line matching a `suppressionPatterns` entry; a removed/added line pair in a `thresholdGlobs` file that differs only in numbers (any direction: tightening also needs the label); threshold numbers removed, or a threshold file deleted or renamed away; any file with additions whose patch GitHub omits (except removed files). Comment lines do not count as gained declarations. A valid `integrity-exception` turns failures into warnings. |
| `check-results` | any | none (`needsClient = false`); `env.NEEDS_JSON` (`toJSON(needs)`) | `needs` empty, or any job result other than `success`. |
| `settings-plan` | `pull_request`; others → `skip` | PR files (no `.github/groundwork/` change → `skip`); `loadDesiredState({ root: env.PR_ROOT })` from the PR head checkout (8.2); `readLiveState`; `readSignals`; base `settings.json` via the contents API for the Actions file diff (V4) | Only when the settings files fail `loadDesiredState`. Otherwise `pass` with the comparison table in `details`. |
| `issue-format` | `issues`: opened, edited, reopened, typed, untyped | the issue's comments (marker `issue-format`) | Acts: invalid → `add-label needs-format` and `upsert-comment` with the errors; valid → `remove-label needs-format` and, if a marker comment exists, `upsert-comment` "No format errors.". Author `github-actions[bot]` → `skip`. |
| `protected-labels` | `issues`: labeled; `pull_request_target`: labeled, synchronize, reopened | payload only | Labeled: acts when `requiredLabelActor` is set and the sender differs: `remove-label` plus `comment` naming the required actor. Synchronize and reopened: `remove-label` plus `comment` when the PR carries `no-issue`, else no actions. |
| `failure-alert` | `workflow_run`: completed | open issues by `github-actions[bot]` carrying marker `alert:<workflow path>` | Acts: conclusion `failure`, `timed_out` or `startup_failure` → `create-issue` or `comment` on the open alert; `success` → `close-issue` on the open alert; anything else → nothing. |

---

## 14. Setup path

### 14.1 Once per organization (you, about 20 minutes; `docs/setup.md`)

1. Create the free organization; enable 2FA requirement and the settings in 2.5.
2. Transfer `wianvdm/groundwork` into the organization (done: `wimdotgg/groundwork`); mark it as a template repository. Its `main` must already contain `admin-run.yml`: nothing below works before that.
3. Create `wianvdm-agent`, invite it to the org, add to team `agents`, give the team Write on `groundwork`, create its fine-grained PAT (2.2), approve it, and log `gh` and git in with it on the agent machine. Remove your own `gh` and Git Credential Manager login for github.com from that machine.
4. Create `wimdotgg-admin` and `wimdotgg-release` as organization-owned Apps (no manifests; `docs/setup.md` gives the manual form) and install both on the org with All repositories. The slugs are recorded in `config.json`.
5. In `groundwork`, create environment `admin` (reviewer you, deployment branch `main`, selected-branches policy, "Allow administrators to bypass" off) and store both App keys and client IDs there.
6. Approve `admin-run op=create-issue-types`, then `admin-run op=apply-settings --repo groundwork --ref <main sha>`. The second run creates groundwork's `release` environment with its key, sets `GROUNDWORK_READY`, applies the rulesets and ends with `check`. From here `main` is protected; the agent runs `request.mjs probe --repo groundwork` to confirm.
7. The agent dispatches `release-please.yml` once (or any PR merges); you merge the resulting release PR so `v0.1.0` exists. Bootstrap refuses to run without a release tag, because projects pin reusable workflows to one.

### 14.2 Per project

1. Agent runs `scripts/admin/request.mjs bootstrap --repo <name> --args '{"description":"..."}'`. You approve.
   Bootstrap pass 1, in this order:
   1. Fail if the repo exists and has no `kit-version.txt` (not ours). If it exists with one, resume: every later step is idempotent.
   2. Generate the repo from the template (`POST /repos/{org}/groundwork/generate` with `owner`, `name`, `description`, `private: false`). Generation copies `main`, which may be ahead of the latest release.
   3. Push one commit `chore: bootstrap from groundwork vX.Y.Z` to `main` whose tree is the latest release tag's tree with these changes: `[control]` paths removed; placeholders `__ORG__`, `__REPO__`, `__DESCRIPTION__` replaced; `./.github/workflows/reusable-*.yml` references rewritten to `<org>/groundwork/.github/workflows/reusable-*.yml@vX.Y.Z`; `kit-version.txt` written; manifest `{}`, `version.txt` `0.0.0`, empty `CHANGELOG.md`; `scripts/verify` and `scripts/verify.cmd` replaced by the stub from `scripts/groundwork/stubs/` (read before `[control]` paths are dropped); README and `docs/` replaced by project stubs. Needs Workflows write because workflow files change.
   4. Apply settings, labels, team access, environments (`release` with its key, `production` without deploy secrets), Actions and security settings.
   5. Apply rulesets **last** (they would reject step 3).
   6. Set `GROUNDWORK_READY=true`.
   7. Open the "Project setup" epic with its sub-issues from templates, typed, linked as sub-issues, unaccepted.
   8. Run `check`; any failed row fails the run.
   Runs triggered by steps 2 and 3 before step 6: `ci.yml` passes on the stub, `release-please.yml` is skipped by its `if`.
2. Agent runs `request.mjs probe --repo <name>` (section 13, no approval). The push to `main` must be rejected.
3. You apply `accepted` to "Project setup". Agents choose the stack, fill `scripts/verify`, add ecosystems to Dependabot, define hotspots, and write the README. If the project deploys, they write `scripts/deploy`, `scripts/smoke`, `scripts/rollback`; otherwise they set `"deploy": "none"` in `config.json`.
4. Agent requests `bootstrap-pass2`; you approve once. It fails if `scripts/verify` is still the stub. Then: CodeQL default setup, wait until the first CodeQL run on `main` completes (Actions read), add the `code_scanning` rule to the live `main` ruleset, and, unless `"deploy": "none"`, set `DEPLOY_ENABLED=true` and print the deploy secrets you must enter (tier 3 checklist) in the run summary. The `code_scanning` rule is also committed to the project's `rulesets/main.json` by an agent PR beforehand, so `check` and later `apply-settings` runs agree with live; until CodeQL default setup is `configured`, `apply-settings` leaves that rule out and `check` reports it `deferred` (9.1). Once the live rule exists, `check` fails closed on default setup and `DEPLOY_ENABLED` (10). The run ends with `check`.

---

## 15. Harness integration

- `AGENTS.md` is canonical; `CLAUDE.md` is `@AGENTS.md`.
- `.claude/settings.json`:
  - Hooks: `Stop` and `PreCompact` run `node scripts/agent/checkpoint.mjs --auto`. They are added to `.claude/settings.json` in Phase 3, when `scripts/agent/checkpoint.mjs` exists.
  - Deny rules: `git push` with `-f`, any `--force` flag (including its lease variant) or a `+` refspec; `git rebase`; `git push` to `main`; `--no-verify`; `gh pr merge --admin`; `gh api` calls with `-X DELETE` or `-X PUT` against `rulesets`, `environments`, `secrets`.
  - Allow rules for `node scripts/agent/*`, `node scripts/human/*`, read-only `gh`.
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

- **Credentials on the agent machine:** only the agent PAT. It cannot change settings, rulesets, environments or secrets.
- **Secrets:** only in environments restricted to `main`, `v*` tags, and (for `admin`, `production`) your approval. PR runs reach none of them.
- **Required checks:** pinned to the GitHub Actions app; the agent cannot post fake results (no Checks or Statuses write). A workflow that fakes a check name must be in the PR's own head commit, which puts it under `.github/` and behind your approval.
- **Rules the PR is judged by:** validators run from the base commit; workflow changes need your CODEOWNERS approval.
- **Protected labels:** validity comes from the labeling actor in the timeline, never from label presence (section 5).
- **Admin runs:** `admin-run.yml` and built-in ops always execute from `main`; the code they run (`.github/`, `scripts/groundwork/`, `scripts/lib/`, `admin-ops/`) reaches `main` only with your CODEOWNERS approval (9.4); `ref` inputs must be reachable from `main`; you see the script and its hash before approving.
- **Untrusted text:** D16, 6.7.
- **Supply chain:** actions pinned by SHA (repo-enforced); Dependabot with cooldown; osv-scanner, dependency review, gitleaks, CodeQL, push protection.
- **Accepted residual risks:** an agent running as your OS user could in principle read browser session data; one machine account means agents are distinguished only by session id; `pull_request` workflow YAML comes from the PR (gated by CODEOWNERS at merge, not at run); the agent PAT has Contents write, so an agent can delete another worker's `issue/*` branch (deletion stays allowed for `delete_branch_on_merge` and orphan cleanup; history is recoverable from the PR; overwriting is blocked by the `issue-branches` ruleset, 9.5); the release App key sits in every project's `release` environment without a reviewer, protected only by the `main`-only policy and CODEOWNERS on `.github/`.

---

## 18. Out of scope and later

**Out of scope:** language-specific tooling beyond the `scripts/verify` contract; infrastructure-as-code, databases, migrations and backups (rollback covers code, not data); private or sensitive code; multi-person teams; monorepos with several deployables; app-store and signed desktop builds; the agent runtime itself.

**Later:** preview deployments per PR; production monitoring beyond failure alerts; a metrics view (rework rate, flake rate, queue ejections, time to merge); optional quality gates in `scripts/verify` (coverage floors, performance budgets, accessibility, visual regression); ADRs beyond spike decision records and epic decision logs; a separate rules repo (D3).

---

## 19. Assumptions to verify before or during implementation

Phase 0 ran on `wimdotgg/probe` (archived; links stay valid). Result values: verified, redesigned (the design changed to fit what GitHub does), pending.

| # | Assumption | How to verify | Result |
|---|---|---|---|
| V1 | Merge queue is available for public repos in a free organization | Enable on a throwaway repo in the new org | Verified: [probe#1](https://github.com/wimdotgg/probe/pull/1) merged through a `merge_group` [run](https://github.com/wimdotgg/probe/actions/runs/43862619217). |
| V2 | `require_code_owner_review` with 0 required approvals blocks a protected-path PR until the code owner approves | Throwaway repo test | Verified: [probe#2](https://github.com/wimdotgg/probe/pull/2) blocked until code-owner approval, then merged through the queue by auto-merge. |
| V3 | `POST /git/refs` on an existing ref fails with 422 (any non-201 is treated as not claimed) | Script test against throwaway repo | Verified: 201, then 422 "Reference already exists". |
| V4 | Rulesets are readable with Metadata read (documented); environments and Actions settings are readable enough for tier 1 plans with the PR `GITHUB_TOKEN` | API test from a PR run | Redesigned: rulesets and environments readable; `actions/permissions` returns 403, so `settings-plan` shows Actions settings as a file diff (8.2). |
| V5 | A fine-grained PAT for a machine user, resource owner the org, can hold Workflows and Actions write; it can set issue types, sub-issues and dependencies with Issues write; check runs are readable without a Checks permission | Create the PAT, run `claim` and the planner once | Verified: the agent PAT set an issue type, `--parent`, `--blocked-by`, read check runs and enqueued a PR. |
| V6 | Org-admin `pull_request` bypass lets you merge your own protected-path PR without lifting rules for agents | Throwaway repo test | Verified: [probe#6](https://github.com/wimdotgg/probe/pull/6) merged by the owner through the bypass; the bypass also skips the merge queue (9.1). |
| V7 | A `wimdotgg-admin` installation token with repository Administration write and Contents read (no organization Administration) can generate a repo from the template while members cannot create repositories; whether that token may be repository-scoped (to `groundwork`) or must be installation-wide; the request-body key for the Issue types organization permission | `selftest`, first bootstrap | Partial (Phase 2): the permission key `issue_types` is confirmed by the API `X-Accepted-GitHub-Permissions` header; the generate call is still pending Phase 4. Decides which 2.4 token variant ships. The tier 2 elevation path itself is verified: PAT 403 on admin calls, owner approval gate, reject stops the run, non-`main` dispatch refused, no self-approval, minted token cannot reach another repo. |
| V8 | Check names: caller-level jobs report under their own name (`Check`, `PR metadata`, `pr-size`); jobs calling reusable workflows report as `<caller job> / <called job>` | First CI run in `groundwork` | Verified on `probe`: `Check`, `PR metadata`, `pr-size`; a reusable call reports as `called / inner`. |
| V9 | `issues: labeled` and `pull_request_target: labeled` events triggered by the agent PAT start `protected-labels`; `github.event.sender.login` is the labeling actor | Label test | Verified: both events fired for labels applied by the agent; sender login printed. |
| V10 | The `code_scanning` ruleset rule works with the merge queue (CodeQL default setup analyses `merge_group` refs or the rule is satisfied by the PR analysis). Not found in the docs. If it blocks the queue, drop the rule and keep CodeQL alerts as advisory | Throwaway repo with pass 2 applied | Verified: rule `CodeQL` `high_or_higher`/`errors` with the merge queue; [probe#7](https://github.com/wimdotgg/probe/pull/7) merged through the queue. No analysis runs for the queue ref; the PR analysis satisfies the rule. |
| V11 | A tag ruleset accepts the `update` rule without `parameters` | First `apply-settings` | Verified on `probe`. |
| V12 | REST exposes `sha_pinning_required` on `PUT /actions/permissions` and the fork PR approval policy; otherwise both stay manual org-level settings (2.5) and `check` only reads them | First `apply-settings` | Verified: `PUT actions/permissions` with `sha_pinning_required` and `PUT actions/permissions/fork-pr-contributor-approval` accepted and read back (10). |
| V13 | Workflows run on the initial commit of a generated repository (the reason for `GROUNDWORK_READY`); harmless if they do not | First bootstrap | Pending (Phase 4). |
| V14 | `gh` on the agent machine supports `--type`, `--parent`, `--blocked-by` at the version named in D4; otherwise the scripts use `gh api` for those calls | `gh issue create --help` | Verified: `gh` 2.102 has all three. |
| V15 | release-please `simple` with manifest `{}`, `initial-version` and `version.txt` `0.0.0` proposes `0.1.0` first | First release PR in `groundwork` | Verified: dry run proposes `chore(main): release 0.1.0`. |
| V16 | The `issue-branches` ruleset (9.5) rejects non-fast-forward pushes to `issue/*` while fast-forward pushes, branch deletion and `delete_branch_on_merge` keep working | Throwaway repo test | Verified on `probe`. |

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
