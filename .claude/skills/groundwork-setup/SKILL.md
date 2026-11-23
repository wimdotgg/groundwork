---
name: groundwork-setup
description: Set up groundwork for a new GitHub organization: ask the consent question, then walk the owner through every setup step, run the App steps, hand the owner the page or wizard command where only they can act, and resume where setup stopped. Use when the owner asks to set up, onboard or install groundwork, or to continue an unfinished setup.
---

# Groundwork setup

Spec 14.3 is the contract and wins over this file; `AGENTS.md` still applies. `docs/setup.md` is the same path for harnesses without skills.

Starter prompt for the owner, from a fresh clone of upstream groundwork opened in Claude Code:

> Set up groundwork for my organization with the groundwork-setup skill. Ask before each step that needs me.

Harness: Claude Code on Windows, macOS or Linux. Other harnesses follow `docs/setup.md` by hand; they get none of the client-side separation in `.claude/settings.json`.

## 1. Consent first

Before any other step, read nothing from GitHub, write nothing and open nothing: ask this question, word for word, with `AskUserQuestion`:

> May I use your main GitHub account for setup? (A) No: I walk you through every step in the browser. (B) Partly: I prepare a wizard you run in your own terminal; it opens each page and asks y/N before each write, and I never hold your login.

- Offer A and B only. Never offer or accept a third option, such as the agent running anything under the owner login.
- List B first as the recommended answer: every write is shown before the owner types `y`, and fewer pages are filled by hand. Read the choice back and get a yes before writing it.
- Under either answer these stay in the browser: billing, org ownership, deletions, agent App key rotation and `admin` environment approvals.
- Consent ends when `release-merge` is `done`. After that, tier 3 work goes back to the browser.

Resume: if `setup-state.json` (section 2) already holds `consent.answer`, the question was answered. Read the answer back and continue at the resume point (section 3); never ask again and never change the answer.

## 2. Record the answer

`setup-state.json` is the record of the answer and of progress, before and after the control repo exists:

- Windows: `%APPDATA%\groundwork\setup-state.json`. `GROUNDWORK_SETUP_STATE_FILE` wins when set.
- Elsewhere: the file named by `GROUNDWORK_SETUP_STATE_FILE`.
- Neither: stop and tell the owner to set `GROUNDWORK_SETUP_STATE_FILE` to a path outside any repository, then start again.

Write it with the file tool, never through a shell command line. Shape (spec 14.3):

```json
{
  "schemaVersion": 1,
  "org": null,
  "consent": { "answer": "B", "classes": ["wizard"], "answeredAt": "2026-11-23T09:00:00Z", "endedAt": null },
  "steps": {}
}
```

- `classes` is `["wizard"]` for B and `[]` for A. Timestamps are ISO 8601 UTC.
- `org` stays `null` until `org-create` is `done`, then holds the login (`^[A-Za-z0-9-]+$`).
- Each step entry: `status` (`pending`, `done`, `skipped`), `updatedAt`, `note`. No other keys: the wizard refuses unknown ones.
- Set `consent.endedAt` when `release-merge` turns `done`.

The control repo does not exist yet, so its record is a run note. Right after the answer, under A and B alike, write `docs/runs/<YYYY-MM-DD>-setup-consent.md` in this clone's working tree, dated by `answeredAt`. One line each:

```markdown
# Setup consent

- Date: 2026-11-23T09:00:00Z
- Answer: B
- Classes: wizard
- Always excluded: billing, org ownership, deletions, agent App key rotation, admin environment approvals
- Ends: when release-merge is done
- setup-state.json schemaVersion: 1
```

The note has no `org` line: `org` is `null` when it is written, and the `repo-copy` commit carries the org in `config.json`. `repo-copy` commits the note with the first commit, so from then on the note in the control repo is the record of the answer. Write it once; progress stays in `setup-state.json`. Touch nothing else in the working tree before `repo-copy`: the wizard refuses a tree with other changes.

## 3. Resume and skip

- Resume point: the first step in the table below that is neither `done` nor `skipped`. A missing ID means `pending`.
- Skip: only when the owner says, at the start of that step, that it is already done. Ask for a short note ("done before setup"), then mark it `skipped` with that note. Never skip on your own judgment.
- Mark `done`: an `app` step after its command succeeds; a `browser` step once the owner confirms its verify check and you checked what you can read; a `wizard` step is marked by the wizard, so re-read the file after the owner says the wizard finished it. Under answer A, mark a `wizard` step `done` once the owner confirms its verify check.
- Ask each question the same way: propose the recommended answer first, get a yes, then write.

## 4. Step classes

- `app`: run it yourself through `node scripts/agent/token.mjs exec -- ...`. Any `admin` run prints a URL; the owner opens it, reads the `plan` summary and approves the deployment.
- `wizard`, answer B: tell the owner to run `node scripts/owner/setup.mjs --step <id>` in their own terminal, outside Claude Code (not the `!` shell: the wizard refuses when `CLAUDECODE` is set). Never run anything under `scripts/owner/` yourself; `.claude/settings.json` denies it, and the owner login must never reach this session. Without `--step` the wizard walks from the resume point and stops at the next `app` step.
- `wizard`, answer A: give the browser route or the command from `docs/setup.md`, which the owner runs themselves.
- `browser`: give URL, field, value and the verify check below. Open nothing yourself; the owner clicks.

`<org>` is `org` from `setup-state.json`. `<agent>`, `<admin>`, `<release>` are the App slugs in `.github/groundwork/config.json` once `repo-copy` wrote them.

## 5. Secrets

Never ask for, read, store or echo a secret value: App private keys, the agent key, `ADMIN_APP_KEY`, `RELEASE_APP_KEY`, tokens. Key and secret steps go to the wizard's hidden prompt (B) or to the owner's browser and own terminal (A). If the owner pastes one into the chat anyway, do not repeat it; say it is now in the session transcript and that they should rotate that key.

## 6. Steps

| ID | Class |
|---|---|
| `org-create` | browser |
| `org-2fa` | browser |
| `org-base-permission` | wizard |
| `org-pat-policy` | browser |
| `org-actions` | wizard |
| `org-team-agents` | browser |
| `repo-copy` | wizard |
| `app-agent` | browser |
| `agent-key-store` | wizard |
| `app-admin` | browser |
| `app-release` | browser |
| `admin-environment` | wizard |
| `admin-secrets` | wizard |
| `issue-types` | app |
| `apply-settings` | app |
| `release-dispatch` | app |
| `release-merge` | browser |

### `org-create` (browser)

- URL: https://github.com/organizations/plan
- Field, value: plan Free; organization name the login the owner chose (`^[A-Za-z0-9-]+$`).
- Verify: https://github.com/<org> shows the organization. Then write `org` to `setup-state.json`.

### `org-2fa` (browser)

- URL: https://github.com/organizations/<org>/settings/security
- Field, value: "Require two-factor authentication for everyone in the organization" on.
- Verify: still on after a reload.

### `org-base-permission` (wizard)

- B: `node scripts/owner/setup.mjs --step org-base-permission`.
- A: https://github.com/organizations/<org>/settings/member_privileges; Base permissions Read; repository creation for members off (public and private).
- Verify: both values hold after a reload.

### `org-pat-policy` (browser)

- URL: https://github.com/organizations/<org>/settings/personal-access-tokens
- Field, value: fine-grained tokens, "Require administrator approval".
- Verify: still selected after a reload.

### `org-actions` (wizard)

- B: `node scripts/owner/setup.mjs --step org-actions`.
- A: https://github.com/organizations/<org>/settings/actions; "Require actions to be pinned to a full-length commit SHA" on; fork pull request workflows "Require approval for all external contributors"; "Allow GitHub Actions to create and approve pull requests" off.
- Verify: all three hold after a reload.

### `org-team-agents` (browser)

- URL: https://github.com/orgs/<org>/teams/agents
- Field, value: if the team exists, its settings, Delete this team. A new org has none.
- Verify: the URL returns 404.

### `repo-copy` (wizard)

Before it, plan the App slugs and the config values:

1. Propose `<org>-agent`, `<org>-admin` and `<org>-release` (lowercase, `^[a-z0-9][a-z0-9-]*$`, 34 characters at most) and get a yes or the owner's names.
2. Check each slug is free with `GET https://api.github.com/apps/<slug>`. No App key exists yet, so call it unauthenticated, and keep the slug off the command line: write a curl config file in your scratch directory, outside the clone, holding `url = "https://api.github.com/apps/<slug>"`, then run `curl -s -o /dev/null -w "%{http_code}\n" -K <that file>`. `404` means no App holds the slug; `200` means it is taken, so ask the owner for another and check again.
3. Propose the `.github/groundwork/config.json` change: `org`, `accounts.owner` (the owner's login), `accounts.agent` (`<agent>[bot]`), `apps.agent`, `apps.admin`, `apps.release`; plus the owner in `.github/CODEOWNERS`. Show the values and get a yes.

Then:

- B: the owner runs `node scripts/owner/setup.mjs --step repo-copy` and types the confirmed values at its prompts. The wizard renames `origin` to `upstream`, writes those files, resets the release files, commits them with the consent note as `chore: set up <org> from groundwork <tag>` and runs `gh repo create <org>/groundwork --public --source . --remote origin --push`, each behind a y/N.
- A: write the confirmed `config.json` and `CODEOWNERS` changes into the working tree yourself, plus the release resets (`.release-please-manifest.json` `{}`, `version.txt` `0.0.0`, empty `CHANGELOG.md`), and show `git diff`. The owner runs the remote rename, the commit by path name and the `gh repo create` push from `docs/setup.md` in their own terminal.
- Verify: https://github.com/<org>/groundwork shows the commit, with the consent note under `docs/runs/`.

### `app-agent` (browser)

- URL: https://github.com/organizations/<org>/settings/apps/new
- Fields, values: GitHub App name `<agent>`; Homepage URL `https://github.com/<org>`; Webhook Active off; repository permissions Contents RW, Pull requests RW, Issues RW, Workflows RW, Actions RW, Commit statuses R, Metadata R; no organization permissions; "Only on this account". Then Install App, `<org>`, "All repositories". Then generate a private key and note the App ID and client ID; the key goes to `agent-key-store`, not to this session.
- Verify: https://github.com/organizations/<org>/settings/installations lists the App with "All repositories". Ask the owner for the App page URL (`https://github.com/apps/<slug>`) and run the slug check below.

### `agent-key-store` (wizard)

- B: `node scripts/owner/setup.mjs --step agent-key-store`. The wizard reads the PEM from a path the owner types and writes the DPAPI file on Windows, or prints the `GROUNDWORK_AGENT_KEY_FILE` and `GROUNDWORK_AGENT_CLIENT_ID` lines for the shell profile elsewhere.
- A: `docs/setup.md` part 1, section 3, step 4, done by the owner in their own terminal.
- Verify: `node scripts/agent/token.mjs exec -- gh repo view --json nameWithOwner` prints `<org>/groundwork`. From here you can read GitHub as the agent App.

### `app-admin` (browser)

- URL: https://github.com/organizations/<org>/settings/apps/new
- Fields, values: name `<admin>`; common fields as `app-agent`; repository permissions Administration RW, Contents RW, Environments RW, Secrets RW, Variables RW, Issues RW, Pull requests RW, Workflows RW, Actions RW, Metadata R; organization permissions Issue types RW, Members R. Install on `<org>` with "All repositories"; generate a private key and keep the `.pem` for `admin-secrets`; note the client ID.
- Verify: the installations page lists it with "All repositories"; slug check below.

### `app-release` (browser)

- URL: https://github.com/organizations/<org>/settings/apps/new
- Fields, values: name `<release>`; common fields as `app-agent`; repository permissions Contents RW, Pull requests RW, Issues RW, Metadata R. Install with "All repositories"; generate a private key and keep the `.pem`; note the App ID.
- Verify: the installations page lists it with "All repositories"; slug check below.

### Slug check after each App

Take the slug from the App page URL the owner gives, check it against `^[a-z0-9][a-z0-9-]*$` and compare it with the matching `apps.*` value in `config.json`. Equal: mark the step `done`. Different, because GitHub changed or refused the name: name the repair. Before `apply-settings` creates the rulesets, the owner commits the corrected slug to `config.json` on `main` in their own clone and pushes. After `apply-settings`, the fix is a PR to `.github/groundwork/config.json` that the owner approves as CODEOWNER. A wrong `apps.agent` also stops `token.mjs` from finding the agent key, so fix it before `agent-key-store` is verified.

### `admin-environment` (wizard)

- B: `node scripts/owner/setup.mjs --step admin-environment`.
- A: https://github.com/<org>/groundwork/settings/environments/new; name `admin`; Required reviewers the owner; "Allow administrators to bypass configured protection rules" off; Deployment branches and tags "Selected branches and tags" with one rule, branch `main`.
- Verify: the environment page shows one reviewer and one branch rule.

### `admin-secrets` (wizard)

- B: `node scripts/owner/setup.mjs --step admin-secrets`. Keys are read with hidden entry or from a PEM path the owner types; the wizard then offers to delete the downloaded PEMs.
- A: on the `admin` environment page, secrets `ADMIN_APP_KEY` (whole admin `.pem`, BEGIN and END lines included) and `RELEASE_APP_KEY` (whole release `.pem`); variables `ADMIN_APP_CLIENT_ID` (admin client ID) and `RELEASE_APP_CLIENT_ID` (release App ID or client ID). Then delete both `.pem` files.
- Verify: the page lists two secrets and two variables by name.

### `issue-types` (app)

- Run `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs create-issue-types` and give the owner the run URL to approve.
- Verify: the run is green and https://github.com/organizations/<org>/settings/issue-types lists Epic, Feature, Bug, Chore and Spike.

### `apply-settings` (app)

- `git fetch origin`, then take `git rev-parse origin/main` and check it is 40 hex characters. Run `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs apply-settings --repo groundwork --ref <sha>`; the owner approves the run.
- Then `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs probe --repo groundwork`. It must report `main` protected; if not, stop: the rulesets did not apply.

### `release-dispatch` (app)

- Run `node scripts/agent/token.mjs exec -- gh workflow run release-please.yml` from this clone (the repo comes from `origin`).
- Verify: a release PR by `<release>[bot]` opens on https://github.com/<org>/groundwork/pulls.

### `release-merge` (browser)

- URL: the release PR from `release-dispatch`.
- Field, value: approve it as CODEOWNER and merge. Agents never merge release PRs.
- Verify: `node scripts/agent/token.mjs exec -- gh release view v0.1.0 --json tagName` prints `v0.1.0`. Mark the step `done`, set `consent.endedAt`, and tell the owner setup is finished and per-project work follows spec 14.2.
