# Setup

From a fresh clone of upstream groundwork to `v0.1.0` in your own organization, then each project. Rules and contracts live in [spec.md](spec.md): identities and Apps in 2, environments in 10.1, admin runs in 12, this path in 14.

**Start.** Open Claude Code in your clone and say: `set up groundwork`. The `groundwork-setup` skill asks one consent question, (A) every step in the browser or (B) a wizard you run in your own terminal, then walks you through the steps below and resumes where you stopped. Under B you run `node scripts/owner/setup.mjs` in a terminal outside Claude Code; it asks y/N before every write. Without the skill, follow the steps below in order by hand (answer A).

**You need:** a GitHub account with two-factor authentication; Node 24+, Git and the GitHub CLI (`gh auth login` as yourself) on the machine; a clone of upstream groundwork on `main` with no local changes; about an hour.

Placeholders: `<org>` your organization, `<owner>` your login (lower-case), `<app>` the agent App slug, `<admin-app>` and `<release-app>` the admin and release App slugs. `repo-copy` writes all of them to `.github/groundwork/config.json`, so pick the App slugs before you create the Apps. App names are global on GitHub; if one is taken, follow the slug recovery under `app-agent`.

## Part 1: once per organization

Each step has an ID and a class. **browser**: you, on a GitHub page; the skill or wizard only opens it. **wizard**: the owner wizard under answer B; under answer A you do it by hand as written. **app**: the agent requests an `admin` run and you approve it in the browser. `setup-state.json` records the answer and each step's status; it is a record, not a control. On Windows it lives in `%APPDATA%\groundwork\`; on macOS and Linux set `GROUNDWORK_SETUP_STATE_FILE` to its path, or the skill and wizard stop (the variable also wins on Windows). Billing, org ownership, deletions, key rotation and `admin` approvals stay in the browser under either answer. Consent ends when the last step is done. The wizard builds every `wizard` and `browser` step except `org-team-agents` and `release-merge`: it stops at those with "not in this wizard version", the skill walks them with you and marks them, and you rerun the wizard.

### Consent note

The skill writes it into your clone right after you answer. By hand, create `docs/runs/<YYYY-MM-DD>-setup-consent.md` before `repo-copy`, which commits it:

```markdown
# Setup consent

- Date: <YYYY-MM-DDTHH:MM:SSZ>
- Answer: <A or B>
- Classes: <[] for A, [wizard] for B>
- Always excluded: billing, org ownership, deletions, agent App key rotation, admin environment approvals
- Ends: when release-merge is done
- setup-state.json schemaVersion: 1
```

### `org-create` · browser

- Page: https://github.com/account/organizations/new?plan=free (the page the wizard opens; https://github.com/organizations/plan with Free leads there).
- Field: plan. Value: Free. Field: Organization account name. Value: `<org>`. Field: "This organization belongs to". Value: "My personal account".
- Verify: https://github.com/<org> opens and lists you under People as Owner.

### `org-2fa` · browser

- Page: https://github.com/organizations/<org>/settings/security
- Field: "Require two-factor authentication for everyone in the organization". Value: checked, Save.
- Verify: after a reload the box is still checked.

### `org-base-permission` · wizard

Answer A, in the browser:

- Page: https://github.com/organizations/<org>/settings/member_privileges
- Field: Base permissions. Value: Read. Field: Repository creation, Public and Private. Value: both unchecked (bootstrap creates repositories).
- Verify: after a reload Base permissions shows Read and both creation boxes are unchecked.

### `org-pat-policy` · browser

- Page: https://github.com/organizations/<org>/settings/personal-access-tokens
- Field: "Require administrator approval" for fine-grained tokens. Value: selected, Save. No groundwork identity uses a token; this only gates tokens members create.
- Verify: after a reload the approval option is still selected.

### `org-actions` · wizard

Answer A, in the browser:

- Page: https://github.com/organizations/<org>/settings/actions
- Field: "Require actions to be pinned to a full-length commit SHA". Value: checked.
- Field: "Approval for running fork pull request workflows from contributors". Value: "Require approval for all external contributors".
- Field: "Allow GitHub Actions to create and approve pull requests". Value: unchecked.
- Verify: after a reload all three show those values. `apply-settings` also sets them per repository.

### `org-team-agents` · browser

A new organization has no `agents` team; skip with the note "no team".

- Page: https://github.com/orgs/<org>/teams, open `agents`, then Settings.
- Field: "Delete this team". Value: confirm.
- Verify: https://github.com/orgs/<org>/teams lists no `agents` team.

### `repo-copy` · wizard

Copies your clone into `<org>/groundwork` as one setup commit on top of upstream history. Answer A, in your clone, after writing the consent note. Git commands work the same in Git Bash and PowerShell:

```sh
git switch main
git status --porcelain            # must list only the consent note
git rev-list origin/main..HEAD    # must print nothing: no local commits
git remote rename origin upstream
```

Edit `.github/groundwork/config.json`: `org` `<org>`, `accounts.owner` `<owner>`, `accounts.agent` `<app>[bot]`, `apps.agent` `<app>`, `apps.admin` `<admin-app>`, `apps.release` `<release-app>`. In `.github/CODEOWNERS`, replace every owner with `@<owner>`. Reset the release files so the first release is `v0.1.0`:

```sh
# Git Bash, macOS, Linux
printf '{}\n' > .release-please-manifest.json
printf '0.0.0\n' > version.txt
: > CHANGELOG.md
```

```powershell
# PowerShell
Set-Content .release-please-manifest.json '{}'
Set-Content version.txt '0.0.0'
Clear-Content CHANGELOG.md
```

Then, in either shell:

```sh
git add .github/groundwork/config.json .github/CODEOWNERS .release-please-manifest.json version.txt CHANGELOG.md docs/runs/<YYYY-MM-DD>-setup-consent.md
git diff --cached                 # read it; nothing else may be staged
git commit -m "chore: set up <org> from groundwork $(git describe --tags --abbrev=0 upstream/main)"
gh repo create <org>/groundwork --public --source . --remote origin
git remote get-url --push --all origin   # must print one line: https://github.com/<org>/groundwork.git
git push --set-upstream origin main
```

No `--push` on `gh repo create`: the wizard pushes with its own hook-free Git after checking the push URL, and by hand you do the same in two steps. Never `git add -A` or `git commit -a`. The push carries `.github/workflows/`, which GitHub accepts only from a credential with the `workflow` scope: if it is refused for that scope and `gh` is your Git credential helper, run `gh auth refresh -s workflow` and push again. Upstream tags are not pushed. Keep the `upstream` remote: [upstream updates](#upstream-updates) use it.

- Verify: https://github.com/<org>/groundwork shows your commit on `main`, and `main` contains `.github/workflows/admin-run.yml`. Nothing after this works without it.

`LICENSE` names the original copyright holder. Replace it, or add your own line, if you publish under your name.

### `app-agent` · browser

- Page: https://github.com/organizations/<org>/settings/apps/new (the wizard opens it and lists these values).
- Fields and values common to all three Apps: GitHub App name, the slug you chose (check the slug in the App's URL afterwards); Homepage URL `https://github.com/<org>`; Webhook "Active" unchecked; "Where can this GitHub App be installed?" "Only on this account"; no callback URL, user authorization or device flow.
- Field: Repository permissions. Value: Contents RW, Pull requests RW, Issues RW, Workflows RW, Actions RW, Commit statuses R, Metadata R. No organization permissions.
- Then: "Generate a private key" (the browser downloads a `.pem`); note the App ID and client ID; Install App, choose `<org>`, "All repositories".
- Verify: https://github.com/organizations/<org>/settings/installations lists `<app>` with "All repositories", and the App page URL ends in `/apps/<app>`.

Slug recovery: if GitHub gives any App a slug other than the one `repo-copy` wrote (name taken, or slugified differently), correct `apps.*` and `accounts.agent` in `.github/groundwork/config.json`, commit that file by path and push to `main` before `apply-settings` (`main` is unprotected until then). On Windows, name the `agent-key-store` files after the corrected slug.

### `agent-key-store` · wizard

The key stays on the agent machine, never in a repo or environment, and never in an agent session. Answer A, on Windows in PowerShell (DPAPI, current user):

```powershell
$dir = "$env:APPDATA\groundwork"; New-Item -ItemType Directory -Force $dir | Out-Null
Get-Content -Raw <path to downloaded .pem> | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content "$dir\<app>.pem.dpapi"
Set-Content "$dir\<app>.json" '{"appId":"<App ID>","slug":"<app>","clientId":"<client ID>"}'
```

Elsewhere: move the PEM outside every repository, `chmod 600` it, and add `export GROUNDWORK_AGENT_KEY_FILE=<path>` and `export GROUNDWORK_AGENT_CLIENT_ID=<client ID>` to your shell profile. On Windows, delete the downloaded `.pem` once the DPAPI file exists.

- Verify: `node scripts/agent/token.mjs exec -- gh repo view <org>/groundwork --json nameWithOwner` prints `<org>/groundwork`.

Your own `gh` and Git Credential Manager logins may stay on the machine. Agents reach GitHub only through `token.mjs exec`: agent scripts refuse to run without its `GH_TOKEN`, and `.claude/settings.json` sets `GH_CONFIG_DIR` and `GCM_INTERACTIVE=never` and denies bare `gh` (spec 2.1). Keep those entries in any copy of the settings.

### `app-admin` · browser

- Page: https://github.com/organizations/<org>/settings/apps/new, the common fields of `app-agent`, name `<admin-app>`.
- Field: Repository permissions. Value: Administration RW, Contents RW, Environments RW, Secrets RW, Variables RW, Issues RW, Pull requests RW, Workflows RW, Actions RW, Metadata R. Field: Organization permissions. Value: Issue types RW, Members R.
- Then: generate a private key and keep the `.pem` for `admin-secrets`; note the client ID; install on `<org>` with "All repositories".
- Verify: the installations page lists `<admin-app>` with "All repositories", and the App page URL ends in `/apps/<admin-app>`, the `apps.admin` value in `config.json`.

### `app-release` · browser

- Page: https://github.com/organizations/<org>/settings/apps/new, the common fields of `app-agent`, name `<release-app>`.
- Field: Repository permissions. Value: Contents RW, Pull requests RW, Issues RW, Metadata R. No organization permissions.
- Then: generate a private key and keep the `.pem` for `admin-secrets`; note the App ID; install on `<org>` with "All repositories".
- Verify: the installations page lists `<release-app>` with "All repositories", and the App page URL ends in `/apps/<release-app>`, the `apps.release` value in `config.json`.

### `admin-environment` · wizard

Answer A, in the browser:

- Page: https://github.com/<org>/groundwork/settings/environments/new
- Field: Name. Value: `admin`, then "Configure environment".
- Field: Required reviewers. Value: checked, `<owner>`.
- Field: "Allow administrators to bypass configured protection rules". Value: unchecked.
- Field: Deployment branches and tags. Value: "Selected branches and tags", one rule: branch `main`.
- Verify: https://github.com/<org>/groundwork/settings/environments lists `admin`; its page shows one reviewer, one branch rule and no bypass.

### `admin-secrets` · wizard

Answer A, on the `admin` environment page (https://github.com/<org>/groundwork/settings/environments, then `admin`):

- Environment secret `ADMIN_APP_KEY`: the full `<admin-app>` `.pem`, BEGIN and END lines included.
- Environment secret `RELEASE_APP_KEY`: the full `<release-app>` `.pem`.
- Environment variable `ADMIN_APP_CLIENT_ID`: the `<admin-app>` client ID.
- Environment variable `RELEASE_APP_CLIENT_ID`: the `<release-app>` App ID (the client ID works too).
- Verify: the page lists two secrets and two variables with those names. Then delete both `.pem` files from disk.

### `issue-types` · app

The agent runs `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs create-issue-types` and prints the run URL. You open it, read the `plan` job summary (operation, target, args, token permissions) and approve the pending `admin` deployment. Every `admin` run below works the same way.

- Verify: https://github.com/organizations/<org>/settings/issue-types lists Epic, Feature, Bug, Chore and Spike, and no Task.

### `apply-settings` · app

The agent requests `apply-settings --repo groundwork --ref <main sha>`; you approve. The run creates the `release` environment with its key, applies labels and rulesets, sets `GROUNDWORK_READY` and ends with `check`. A failed `check` row fails the run: fix the cause and re-run (ops are idempotent). The agent then runs `probe --repo groundwork` itself, with no approval.

- Verify: the run is green, https://github.com/<org>/groundwork/settings/rules lists the rulesets, and the probe prints `push probe rejected: main is protected`. A probe saying `main` is NOT protected means the rulesets did not apply: stop.

### `release-dispatch` · app

The agent runs `node scripts/agent/token.mjs exec -- gh workflow run release-please.yml --ref main` once (any merged PR also triggers it). No `admin` run and no approval: the `release` environment has no reviewer. `<release-app>[bot]` opens a release PR for `v0.1.0`.

### `release-merge` · browser

- Page: https://github.com/<org>/groundwork/pulls, the release PR by `<release-app>[bot]`.
- Field: "Review changes". Value: Approve (you are the code owner of the version files). Then "Merge when ready". Agents never merge release PRs.
- Verify: https://github.com/<org>/groundwork/tags lists `v0.1.0`. Setup and consent end here; bootstrap refuses to run without a release tag.

## Part 2: each project

Pass 1, the probe and pass 2 run through `request.mjs`; every `admin` run waits for your approval in the browser. The path is spec 14.2. To turn a repository you already have into a project in place, follow [adopt.md](adopt.md) for pass 1, then continue here at step 2.

1. Agent runs `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap --repo <name> --args '{"description":"..."}'`. You open the run URL, read the plan, approve. Pass 1 creates the repo, creates the labels, pushes a single `chore: bootstrap from groundwork vX.Y.Z` commit (reusable workflows pinned to the tag's commit SHA), applies settings, team access, environments and security settings, applies rulesets last, sets `GROUNDWORK_READY`, opens the "Project setup" epic (unaccepted), runs a final labels pass and ends with `check`. GitHub's default labels are gone afterwards.
2. Agent runs `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs probe --repo <name>`. No approval. The push to `main` must be rejected (`"protected": true`, status 409 or 422).
3. You apply the `accepted` label to the "Project setup" epic. Agents then choose the stack, fill `scripts/verify`, add Dependabot ecosystems, define hotspots and write the README. If the project deploys, they move the stubs in `scripts/stubs/deploy/` to `scripts/`, replace their bodies and list the production secret names in `settings.json`; otherwise they set `"deploy": "none"` in `config.json`. A project bootstrapped before `v0.7.0` has no stubs and writes the scripts directly.
4. Agent runs `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap-pass2 --repo <name>`. You approve once. It refuses while `scripts/verify` is still the stub, missing or unreadable. It enables CodeQL default setup, waits for the first CodeQL run on `main`, adds the `code_scanning` rule to the live `main` ruleset, sets `DEPLOY_ENABLED=true` unless `deploy` is `none`, prints the deploy secrets you must enter in the run summary and ends with `check`. Enter those secrets in the project's `production` environment yourself. A release PR opened before pass 2 has no CodeQL run, so the new `code_scanning` rule blocks it until its branch gets a new head: close and reopen the PR so release-please pushes one, then approve it again (a merge-queue repository offers no "Update branch"). Pass 2 refuses without the `code_scanning` rule in `.github/groundwork/rulesets/main.json`: a project from template `v0.6.0` or later has it, an older one adds it first (setup task 05).

Available now for existing repos: `apply-settings --repo <name> [--ref <sha>]` (after a settings PR merges; you also approve the PR as CODEOWNER), `check --repo <name>` (read-only drift check), `script --repo <name> --script <admin-ops file> [--ref <sha>] [--args <json>]` (one reviewed script from `admin-ops/`; the delegated approval needs `ref` equal to the `main` head) and `selftest` (bootstraps a throwaway `selftest-<run id>` repository, runs `check` and four probes, archives it; deleting it stays yours).

To move a project to a newer release, an agent claims a Chore issue and runs `node scripts/agent/token.mjs exec -- node scripts/kit-update.mjs <vX.Y.Z>` on its `issue/N` branch. A project older than `v0.7.0` has no script yet: copy `scripts/kit-update.mjs` from the tag by hand first. The first update is large and may need your `size-exception`. `kit-update` adds `.github/workflows/deploy.yml` when the project has none, so a project that deploys from a differently named workflow renames it to `deploy.yml` first, or it deploys twice.

## Upstream updates

`kit-update` moves projects to your own control repo's release. Moving `<org>/groundwork` itself to a newer upstream groundwork is a merge of an upstream tag:

1. You or a planner open a Chore issue naming the upstream tag `vX.Y.Z`; an agent claims it.
2. On `issue/N`: `git fetch --no-tags upstream refs/tags/vX.Y.Z`, then `git merge FETCH_HEAD`. Resolve conflicts keeping your side in `.github/groundwork/config.json`, `.github/CODEOWNERS`, `version.txt`, `.release-please-manifest.json` and `CHANGELOG.md`; take upstream elsewhere unless you changed the region on purpose.
3. Push through the wrapper and mark the PR ready. You apply `size-exception` (an upstream release is far over 400 lines) and approve as code owner.

The cost of squash-only `main` (`rulesets/main.json`): the squash commit has no upstream parent, so the merge base stays at the clone point. Every later update conflicts again in each region upstream changed twice since the clone, and the version files conflict every time. An upstream release that deletes or skips tests also needs your `integrity-exception`.

## Notes

- Harness: Claude Code is supported on Windows, macOS and Linux. Other harnesses can run the agent scripts but get no client-side separation: the deny rules and `GH_CONFIG_DIR` in `.claude/settings.json` bind Claude Code only.
- macOS and Linux are expected to work and unproven: no run has covered them. The agent key is a PEM at `GROUNDWORK_AGENT_KEY_FILE`, protected by file permissions only.
- CODEOWNERS for a cloned owner is unconfirmed. GitHub documents that code owners need write access; an owner listed without it may leave protected paths without a required reviewer. `repo-copy` writes `@<owner>`, bootstrap writes it into each project, and the `check` row `codeowners` fails when `.github/CODEOWNERS` names anyone but `accounts.owner`.

## Security notes

- Secrets live only in environments restricted to `main` or `v*` tags. PR runs and other branches reach none.
- `admin` needs your approval on every run and always executes `admin-run.yml` from `main`; code under `.github/`, `scripts/groundwork/`, `scripts/lib/`, `scripts/owner/` and `admin-ops/` reaches `main` only with your CODEOWNERS approval.
- Owner-only tier 3 tasks: creating Apps, billing, org ownership, deletions, key rotation, always in the browser. Secret values too, except that during setup the wizard may enter them under answer B.

Rotate a key in the App settings: generate a new one, store it where the old one lives, delete the old one. The agent key lives on the agent machine (`agent-key-store`). The admin key is `ADMIN_APP_KEY` in the `admin` environment. The release key is `RELEASE_APP_KEY` in the `admin` environment: update that secret, run `apply-settings --repo <name>` for `groundwork` and each project so the `release` environment copies refresh, then delete the old key. Prove each by its next use: `token.mjs exec`, an `admin` run, the next release-please run.
