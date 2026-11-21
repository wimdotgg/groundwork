# Setup

Owner guide. Part 1 runs once per organization (about 20 minutes, all in the browser). Part 2 runs for each project. Rules and contracts live in [spec.md](spec.md): identities and Apps in section 2, environments in 10.1, admin runs in 12, this path in 14.

Values below use the current org `wimdotgg`, owner `wianvdm` and agent App `wimdotgg-agent`. They match `.github/groundwork/config.json`; change them there if you fork.

## Part 1: once per organization

### 1. Organization

1. Create a free organization at https://github.com/organizations/plan.
2. Open https://github.com/organizations/wimdotgg/settings/security and require two-factor authentication.
3. Open https://github.com/organizations/wimdotgg/settings/member_privileges: set Base permissions to Read and turn off repository creation for members (bootstrap creates repos).
4. Open https://github.com/organizations/wimdotgg/settings/personal-access-tokens: allow fine-grained tokens and require administrator approval.
5. Open https://github.com/organizations/wimdotgg/settings/actions: require actions pinned to a full-length commit SHA. Set fork pull request workflows to "Require approval for all external contributors" and leave "Allow GitHub Actions to create and approve pull requests" off. `apply-settings` also sets these per repository.

Verify: each page shows the value you set after a reload.

### 2. Control repository

1. Transfer `groundwork` into the org (Settings, Danger Zone, Transfer). Current location: https://github.com/wimdotgg/groundwork.
2. Open the repo Settings and tick "Template repository".
3. Check that `main` contains `.github/workflows/admin-run.yml`. Nothing in steps 5 to 7 works without it.

### 3. Agent App

1. Open https://github.com/organizations/wimdotgg/settings/apps/new and create `wimdotgg-agent` with the common fields from section 4. Repository permissions: Contents RW, Pull requests RW, Issues RW, Workflows RW, Actions RW, Commit statuses R, Metadata R. No organization permissions.
2. Install it on the org with "All repositories".
3. Generate a private key and note the App ID and client ID.
4. Store the key on the agent machine. On Windows, encrypt it for the current user with DPAPI at `%APPDATA%\groundwork\wimdotgg-agent.pem.dpapi` (`ConvertFrom-SecureString` output) and put `appId`, `slug` and `clientId` in `%APPDATA%\groundwork\wimdotgg-agent.json`. Elsewhere, keep the PEM outside any repo and export `GROUNDWORK_AGENT_KEY_FILE` (its path) and `GROUNDWORK_AGENT_CLIENT_ID`. Delete the downloaded `.pem`.
5. Agents write only through `node scripts/agent/token.mjs exec -- <command>`. Keep your own `gh` login off the agent machine's write path.

Verify: `node scripts/agent/token.mjs exec -- gh api repos/wimdotgg/groundwork --jq .full_name` prints `wimdotgg/groundwork`.

### 4. GitHub Apps

Create both Apps under the organization, never under a personal account. Open https://github.com/organizations/wimdotgg/settings/apps/new for each.

Common fields:

- Homepage URL: `https://github.com/wimdotgg`.
- Webhook: Active off.
- Where can this App be installed: "Only on this account" (that means the org).
- No user-to-server or device flow options.

`wimdotgg-admin` (App ID 5782869, client ID `Iv23lipUuaiDCWGAKcYI`, already created):

| Scope | Permissions |
|---|---|
| Repository | Administration RW, Contents RW, Environments RW, Secrets RW, Variables RW, Issues RW, Pull requests RW, Workflows RW, Actions RW, Metadata R |
| Organization | Issue types RW, Members R |

`wimdotgg-release`:

| Scope | Permissions |
|---|---|
| Repository | Contents RW, Pull requests RW, Issues RW, Metadata R |

For each App, then:

1. Generate a private key (App settings, Private keys). The browser downloads a `.pem`; keep it for step 5.
2. Note the App ID and the client ID from the App settings page. The release App variable holds either (10.1).
3. Install it: App settings, Install App, choose `wimdotgg`, "All repositories". New project repos are then covered with no extra step.

Verify: https://github.com/organizations/wimdotgg/settings/installations lists both Apps with "All repositories".

The slugs `wimdotgg-admin` and `wimdotgg-release` must match `apps.admin` and `apps.release` in `.github/groundwork/config.json`.

### 5. Admin environment

In https://github.com/wimdotgg/groundwork/settings/environments, create `admin`:

1. Required reviewers: `wianvdm`.
2. "Allow administrators to bypass configured protection rules": off.
3. Deployment branches and tags: "Selected branches and tags", add one rule: branch `main`.
4. Environment secrets:
   - `ADMIN_APP_KEY`: full contents of the admin App `.pem`, including the BEGIN and END lines.
   - `RELEASE_APP_KEY`: full contents of the release App `.pem`.
5. Environment variables:
   - `ADMIN_APP_CLIENT_ID`: `Iv23lipUuaiDCWGAKcYI`.
   - `RELEASE_APP_CLIENT_ID`: the release App ID (5796650). The client ID works too, because the App JWT accepts either as issuer.

Verify: the environment page shows one reviewer, one branch rule, two secrets and two variables. Delete the `.pem` files from disk once stored.

### 6. First admin runs

The agent starts each run with `node scripts/admin/request.mjs <op> ...`. It prints the run URL. For every run you:

1. Open the URL.
2. Read the `plan` job summary (operation, target, args, token permissions).
3. Approve the pending `admin` deployment.

Run these in order:

1. `create-issue-types`. Creates Epic, Feature, Bug, Chore and Spike, and deletes the default Task. Check https://github.com/organizations/wimdotgg/settings/issue-types.
2. `apply-settings --repo groundwork`. The agent may add `--ref <main sha>`; without it the script uses current `main`. The run creates groundwork's `release` environment with its key, applies labels and rulesets, sets `GROUNDWORK_READY`, and ends with `check`. A failed `check` row fails the run; fix the cause and re-run (ops are idempotent).
3. `probe --repo groundwork`. The agent runs this itself; it needs no approval. Expected output: `push probe rejected: main is protected`. Output saying main is NOT protected means the rulesets did not apply; do not continue.

Verify: the `apply-settings` run is green, https://github.com/wimdotgg/groundwork/settings/rules lists the rulesets, and the probe reports protected.

### 7. First release

1. The agent dispatches `release-please.yml` once (or any PR merges, which triggers it).
2. You merge the release PR opened by `wimdotgg-release[bot]`. Agents never merge release PRs.

Verify: the tag `v0.1.0` exists at https://github.com/wimdotgg/groundwork/tags. Projects pin reusable workflows to a release tag, and bootstrap refuses to run without one.

## Part 2: each project

Steps 1 and 4 use ops that arrive in Phase 4: `bootstrap` and `bootstrap-pass2` are not available yet (Phase 4). `request.mjs` rejects them today. This part describes the intended path from spec 14.2.

1. Agent requests `bootstrap --repo <name> --args '{"description":"..."}'`. Not available yet (Phase 4). You open the run URL, read the plan, approve. Pass 1 generates the repo from the template, pushes a single `chore: bootstrap from groundwork vX.Y.Z` commit, applies settings, labels, team access, environments and security settings, applies rulesets last, sets `GROUNDWORK_READY`, opens the "Project setup" epic (unaccepted) and ends with `check`.
2. Agent runs `node scripts/admin/request.mjs probe --repo <name>`. Available now; no approval. The push to `main` must be rejected.
3. You apply the `accepted` label to the "Project setup" epic. Agents then choose the stack, fill `scripts/verify`, add Dependabot ecosystems, define hotspots and write the README. If the project deploys, they write `scripts/deploy`, `scripts/smoke` and `scripts/rollback`; otherwise they set `"deploy": "none"` in `config.json`.
4. Agent requests `bootstrap-pass2 --repo <name>`. Not available yet (Phase 4). You approve once. It fails while `scripts/verify` is still the stub. It enables CodeQL default setup, adds the `code_scanning` rule to the live `main` ruleset after the first CodeQL run, sets `DEPLOY_ENABLED=true` unless `deploy` is `none`, and prints the deploy secrets you must enter in the run summary. Enter those secrets in the project's `production` environment yourself.

Available now for existing repos: `apply-settings --repo <name> [--ref <sha>]` (after a settings PR merges; you also approve the PR as CODEOWNER) and `check --repo <name>` (read-only drift check).

## Security notes

- Secrets live only in environments restricted to `main` or `v*` tags. PR runs and other branches reach none.
- `admin` needs your approval on every run and always executes `admin-run.yml` from `main`; code under `.github/`, `scripts/groundwork/`, `scripts/lib/` and `admin-ops/` reaches `main` only with your CODEOWNERS approval.
- Owner-only tier 3 tasks, always in the browser: creating Apps, secret values, PAT rotation (every 90 days), billing, org ownership.
