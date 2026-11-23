---
name: groundwork-setup
description: "Set up groundwork for a new GitHub organization: ask the consent question, then walk the owner through every setup step, run the App steps, hand the owner the page or wizard command where only they can act, and resume where setup stopped. Use when the owner asks to set up, onboard or install groundwork, or to continue an unfinished setup."
---

# Groundwork setup

Control repo only: if `.github/groundwork/kit-version.txt` exists, this is a project, not the control repo. Stop; project setup follows spec 14.2.

Spec 14.3 is the contract and wins over this file; `AGENTS.md` still applies. `docs/setup.md` is the same path for harnesses without skills.

Starter prompt for the owner, from a fresh clone of upstream groundwork opened in Claude Code:

> Set up groundwork for my organization with the groundwork-setup skill. Ask before each step that needs me.

Harness: Claude Code on Windows, macOS or Linux. Other harnesses follow `docs/setup.md` by hand; they get none of the client-side separation in `.claude/settings.json`.

## 1. Consent first

Before any other step, read nothing from GitHub, write nothing and open nothing: ask this question, word for word, with `AskUserQuestion`:

> May I use your main GitHub account for setup? (A) No: I walk you through every step in the browser. (B) Partly: I prepare a wizard you run in your own terminal; it opens each page and asks y/N before each write, and I never hold your login.

- Offer A and B only, with their letters as in the question. Never offer or accept a third option, such as the agent running anything under the owner login.
- List B first as the recommended answer: every write is shown before the owner types `y`, and fewer pages are filled by hand. Read the choice back and get a yes before writing it.
- Any other answer, "Other" included: write nothing and stop.
- Under either answer these stay in the browser: billing, org ownership, deletions, agent App key rotation and `admin` environment approvals.
- Consent ends when `release-merge` is `done`. After that, tier 3 work goes back to the browser.

Resume: if `setup-state.json` (section 3) already holds `consent.answer`, the question was answered. Read the answer back and continue at the resume point (section 4); never ask again and never change the answer. If `consent.endedAt` is set or no step is left, say setup is finished and run nothing.

## 2. Prerequisites

Check these right after the answer, before `org-create`. The owner checks what needs their login; you never run `gh auth status`.

- Node 24+ and git on PATH, here and in the owner's own terminal.
- Under B: `gh` logged in as the owner in their own terminal (they run `gh auth status` there).
- This clone on `main`, `origin` pointing at upstream groundwork, `git status --porcelain` empty before the consent note; after it, the note is the only change.
- macOS and Linux: `GROUNDWORK_SETUP_STATE_FILE` (and later `GROUNDWORK_AGENT_KEY_FILE`, `GROUNDWORK_AGENT_CLIENT_ID`) reach this session only from the environment Claude Code started in. The owner adds each line to their shell profile, restarts Claude Code, and uses the same values in the wizard's terminal. After a restart this skill resumes from the state file.

## 3. Record the answer

`setup-state.json` is the record of the answer and of progress, before and after the control repo exists:

- Windows: `%APPDATA%\groundwork\setup-state.json`. `GROUNDWORK_SETUP_STATE_FILE` wins when set.
- Elsewhere: the file named by `GROUNDWORK_SETUP_STATE_FILE`.
- Neither: stop and tell the owner to set `GROUNDWORK_SETUP_STATE_FILE` to a path outside any repository (section 2), then start again.

Write it with the file tool, never through a shell command line. Shape (spec 14.3):

```json
{
  "schemaVersion": 1,
  "org": null,
  "consent": { "answer": "B", "classes": ["wizard"], "answeredAt": "2026-11-23T09:00:00Z", "endedAt": null },
  "steps": {}
}
```

- `classes` is `["wizard"]` for B and `[]` for A. Timestamps are ISO 8601 UTC ending in `Z` (`YYYY-MM-DDTHH:MM:SSZ`, optional `.fff`).
- `org` stays `null` until `org-create` leaves `pending`; set it (`^[A-Za-z0-9-]+$`) in the same write as that step's entry. The wizard refuses `null` after it.
- Each step entry has exactly `status` (`pending`, `done`, `skipped`), `updatedAt` and `note`, always all three; `note` is `""` when empty. No other keys: the wizard refuses them.
- Set `consent.endedAt` when `release-merge` turns `done`.

The control repo does not exist yet, so its record is a run note. Right after the answer, under A and B alike, write `docs/runs/<YYYY-MM-DD>-setup-consent.md` in this clone's working tree, dated by `answeredAt`. One line each:

```markdown
# Setup consent

- Date: 2026-11-23T09:00:00Z
- Answer: B
- Classes: [wizard]
- Always excluded: billing, org ownership, deletions, agent App key rotation, admin environment approvals
- Ends: when release-merge is done
- setup-state.json schemaVersion: 1
```

The note has no `org` line: `org` is `null` when it is written, and the `repo-copy` commit carries the org in `config.json`. `repo-copy` commits the note with the first commit, so from then on the note in the control repo is the record of the answer. Write it once; progress stays in `setup-state.json`. Touch nothing else in the working tree before `repo-copy`: the wizard refuses a tree with other changes.

## 4. Resume, skip, decline

- Resume point: the first step in the table below that is neither `done` nor `skipped`. A missing ID means `pending`.
- Skip: only when the owner says, at the start of that step, that it is already done. Ask for a short note ("done before setup"), then mark it `skipped` with that note. Never skip on your own judgment.
- Mark `done`: an `app` step after its command succeeds; a `browser` step you walked once the owner confirms its verify check and you checked what you can read; under A, a `wizard` step once the owner confirms its verify check. Steps the wizard walks, the wizard marks: re-read the file after it ends.
- Decline: the owner says no at a step or to a proposed value. The step stays `pending`; stop there, nothing after it runs.
- A step the wizard should have done is still `pending` after its run: the owner declined or the wizard refused. Ask which and why; never mark it yourself.
- Ask each question the same way: propose the recommended answer first, get a yes, then write.

## 5. Step classes

`<org>` is `org` from `setup-state.json`. `<agent>`, `<admin>`, `<release>` are the App slugs in `.github/groundwork/config.json` once `repo-copy` wrote them.

- `app`: run it yourself through `node scripts/agent/token.mjs exec -- ...`. Any `admin` run prints a URL; the owner opens it, reads the `plan` summary and approves the deployment.
- Answer B, `wizard` and `browser` steps: hand them to the wizard (section 6). Never run anything under `scripts/owner/` yourself; `.claude/settings.json` denies it, and the owner login must never reach this session.
- Answer A, and any step the wizard does not build yet: walk it yourself. Open the step's page (below), name field and value, and wait for the owner's verify. A `wizard` step under A is done by the owner in the browser, or with the commands given at that step in their own terminal.

Open a page without putting it on the command line: build the URL only from `<org>`, the slugs and the URLs in this file, write it to a file in your scratch directory, then run:

```
node -e "const u=require('fs').readFileSync(process.argv[1],'utf8').trim();if(!/^https:\/\/github\.com\/[A-Za-z0-9\/?=&._-]*$/.test(u))process.exit(1);const [c,a]=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',u]]:[process.platform==='darwin'?'open':'xdg-open',[u]];require('child_process').spawn(c,a,{detached:true,stdio:'ignore'}).unref()" <that file>
```

Also print the URL, in case no browser opens.

## 6. The owner wizard (answer B)

The owner runs `node scripts/owner/setup.mjs` in their own terminal at this clone's root, outside Claude Code (not the `!` shell: the wizard refuses when `CLAUDECODE` is set). `--step <id>` runs one step. Before they start, tell them:

- Preconditions: their own `gh` login; `GH_TOKEN` unset; `.git/config` setting only the keys spec 14.3 allows (the wizard refuses any other by name before it runs a git command, and names the `git config --local --unset-all` line); `scripts/owner` and `scripts/lib` unchanged against `origin/main` as last fetched; the same `GROUNDWORK_SETUP_STATE_FILE` as this session, if set.
- Walk: from the resume point it asks "Already done before setup? y/N" per step (`y` asks for a note and skips the step; `N` runs it). A `browser` step opens the page, names field and value, then asks "Verified? y/N"; after `org-create` it asks "Organization login:". It stops at the next `app` step and names the request I make.
- Before the first of `org-base-permission` and `org-actions`, `gh auth refresh -s admin:org` opens a browser prompt for the extra scope. Each `gh` command is shown, then "Run it? y/N". `org-actions` first prints that it sends `enabled_repositories=all`, which turns Actions on for every repository. At the end it removes the scope and prints "admin:org is gone"; if not, it prints the removal command.
- Anything but `y` ends the walk with the step `pending`; the next run resumes there.

After the walk ends, re-read `setup-state.json` and continue from the resume point.

Wizard coverage: the wizard builds every `wizard` and `browser` step except `org-team-agents` and `release-merge`, and stops at those with "not in this wizard version". Walk them as under A (section 5), mark them yourself, then hand back to the wizard.

## 7. Secrets

Never ask for, read, store or echo a secret value: App private keys, the agent key, `ADMIN_APP_KEY`, `RELEASE_APP_KEY`, tokens. Key and secret steps go to the wizard's hidden prompt (B) or to the owner's browser and own terminal (A). If the owner pastes one into the chat anyway, do not repeat it; say it is now in the session transcript and that they should rotate that key.

## 8. Steps

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

- URL: https://github.com/account/organizations/new?plan=free
- Field, value: plan Free; organization name the login the owner chose (`^[A-Za-z0-9-]+$`).
- Verify: the new organization page opens. Write `org` with the step entry.

### `org-2fa` (browser)

- URL: https://github.com/organizations/<org>/settings/security
- Field, value: "Require two-factor authentication for everyone in the organization" on.
- Verify: the box stays checked after Save.

### `org-base-permission` (wizard)

- B: the wizard sends `PATCH /orgs/<org>` (Base permission Read, member repository creation off).
- A: https://github.com/organizations/<org>/settings/member_privileges; Base permissions Read; repository creation for members off (public and private).
- Verify: both values hold after a reload.

### `org-pat-policy` (browser)

- URL: https://github.com/organizations/<org>/settings/personal-access-tokens
- Field, value: fine-grained personal access tokens, "Require administrator approval".
- Verify: the option stays selected after Save.

### `org-actions` (wizard)

- B: the wizard sends three `PUT` calls under `/orgs/<org>/actions/permissions`.
- A: https://github.com/organizations/<org>/settings/actions; "Require actions to be pinned to a full-length commit SHA" on; fork pull request workflows "Require approval for all external contributors"; "Allow GitHub Actions to create and approve pull requests" off.
- Verify: all three hold after a reload.

### `org-team-agents` (browser)

- URL: https://github.com/orgs/<org>/teams/agents
- Field, value: if the team exists, its settings, Delete this team. A new org has none.
- Verify: the URL returns 404.

### `repo-copy` (wizard)

Before it, plan the App slugs and the config values:

1. Propose `<org>-agent`, `<org>-admin` and `<org>-release` with `<org>` lowercased and get a yes or the owner's names. Gate every slug, proposed or typed: it must match `^[a-z0-9][a-z0-9-]*$` and be 34 characters at most. Refuse any other and ask again; nothing unchecked goes into a file.
2. Check each slug. No App key exists yet, so call unauthenticated, and keep the slug off the command line: write a curl config file in your scratch directory, outside the clone, holding `url = "https://api.github.com/apps/<slug>"`, run `curl -s -o /dev/null -w "%{http_code}\n" -K <that file>`, then do the same for `url = "https://api.github.com/users/<slug>%5Bbot%5D"`. A private App answers 404 on the first; its bot user answers 200 on the second. Either 200: taken, ask for another. Both 404: probably free; the App form decides, and the slug check after each App is the fallback. Any other status (403 at the 60 per hour unauthenticated limit, 000, 5xx) is no answer: retry later, never read it as free.
3. Propose the `.github/groundwork/config.json` change: `org`, `accounts.owner` (the owner's login), `accounts.agent` (`<agent>[bot]`), `apps.agent`, `apps.admin`, `apps.release`; plus the owner in `.github/CODEOWNERS`. Show the values and get a yes.

Under B the wizard does the rest, each write behind its own y/N; it asks the owner for the login and slugs, so give them the confirmed values. Under A, the owner, in their own terminal at this clone's root:

1. `git remote rename origin upstream`.
2. You write the confirmed `config.json` and `CODEOWNERS` changes and reset the release files: `.release-please-manifest.json` `{}`, `version.txt` `0.0.0`, empty `CHANGELOG.md`. Show `git diff`.
3. `git add` those five paths and the consent note by name (never `-A`), then `git commit -m "chore: set up <org> from groundwork <tag>"` under their own Git identity, `<tag>` from `git describe --tags --abbrev=0 upstream/main` or the upstream short SHA.
4. `gh repo create <org>/groundwork --public --source . --remote origin` (no `--push`), then `git remote get-url --push --all origin`, which must print exactly one URL, that of `<org>/groundwork` (HTTPS or SSH), then `git push --set-upstream origin main`. A push refused for the `workflow` scope (it carries `.github/workflows/`) needs `gh auth refresh -s workflow` when `gh` is the Git credential helper.

- Verify: https://github.com/<org>/groundwork shows the commit, with the consent note under `docs/runs/`.

### `app-agent` (browser)

URL: https://github.com/organizations/<org>/settings/apps/new. One action at a time, in page order:

1. GitHub App name: `<agent>`.
2. Homepage URL: `https://github.com/<org>`.
3. "Request user authorization (OAuth) during installation" off, "Enable Device Flow" off: no user-to-server or device flow.
4. Webhook: Active off.
5. Repository permissions: Contents RW, Pull requests RW, Issues RW, Workflows RW, Actions RW, Commit statuses R, Metadata R. No organization permissions.
6. Where can this GitHub App be installed: "Only on this account".
7. Create GitHub App. Note the App ID and client ID.
8. Generate a private key. The key goes to `agent-key-store`, never to this session.
9. Install App, `<org>`, "All repositories".

- Verify: https://github.com/organizations/<org>/settings/installations lists the App with "All repositories". Then the slug check below.

### `agent-key-store` (wizard)

- B: the wizard asks for the client ID, on Windows the App ID, and the path of the downloaded `.pem`, then stores the key. A: the owner stores the key in their own terminal as `docs/setup.md` describes for `agent-key-store`. Windows: `%APPDATA%\groundwork\<agent>.pem.dpapi` and `<agent>.json` (`appId`, `slug`, `clientId`). Elsewhere: the PEM outside any repository, `GROUNDWORK_AGENT_KEY_FILE` and `GROUNDWORK_AGENT_CLIENT_ID` in the shell profile, then restart Claude Code (section 2).
- Verify: `node scripts/agent/token.mjs exec -- gh repo view --json nameWithOwner` prints `<org>/groundwork`. From here you can read GitHub as the agent App.

### `app-admin` (browser)

- URL: https://github.com/organizations/<org>/settings/apps/new
- Same actions as `app-agent`, with name `<admin>`; repository permissions Administration RW, Contents RW, Environments RW, Secrets RW, Variables RW, Issues RW, Pull requests RW, Workflows RW, Actions RW, Metadata R; organization permissions Issue types RW, Members R. Keep the `.pem` for `admin-secrets`; note the client ID.
- Verify: the installations page lists it with "All repositories"; slug check below.

### `app-release` (browser)

- URL: https://github.com/organizations/<org>/settings/apps/new
- Same actions as `app-agent`, with name `<release>`; repository permissions Contents RW, Pull requests RW, Issues RW, Metadata R. Keep the `.pem`; note the App ID.
- Verify: the installations page lists it with "All repositories"; slug check below.

### Slug check after each App

Ask for the App's URL: `https://github.com/apps/<slug>` or the settings page `https://github.com/organizations/<org>/settings/apps/<slug>` the form lands on. Gate the slug as in `repo-copy` and compare it with `config.json`. Equal: mark the step `done`. Different, because GitHub changed or refused the name: name the repair. The fix is `apps.<role>`, and for the agent App also `accounts.agent` (`<slug>[bot]`), which trust, label actors and `review-queue` read. Before `apply-settings` creates the rulesets, the owner commits the fix to `main` from their own terminal and pushes. After `apply-settings`, it is a PR to `.github/groundwork/config.json` the owner approves as CODEOWNER. A wrong `apps.agent` also stops `token.mjs` finding the agent key, so fix it before verifying `agent-key-store`.

### `admin-environment` (wizard)

- URL: https://github.com/<org>/groundwork/settings/environments/new
- Name `admin`; Required reviewers the owner; "Allow administrators to bypass configured protection rules" off; Deployment branches and tags "Selected branches and tags" with one rule, branch `main`.
- Verify: the environment page shows one reviewer and one branch rule.

### `admin-secrets` (wizard)

- On the `admin` environment page: secrets `ADMIN_APP_KEY` (whole admin `.pem`, BEGIN and END lines included) and `RELEASE_APP_KEY` (whole release `.pem`); variables `ADMIN_APP_CLIENT_ID` (admin client ID) and `RELEASE_APP_CLIENT_ID` (release App ID or client ID). Then delete both `.pem` files.
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
