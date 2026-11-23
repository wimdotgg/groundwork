# Onboarding desk check 2026-11-23

Issue #276, epic #258 (E7). Session a945581b-5520-4c70-abd2-637c40fa4b89, `claude-opus-5-5/claude-code`, Node 24.22.3 on Windows. Desk check only, per #251 `## Decisions` Q2 C: nothing below ran. No org was created, no wizard or adopt run started, no page opened. Each step was read against `docs/setup.md`, `docs/adopt.md`, `.claude/skills/groundwork-setup/SKILL.md` and the code under `scripts/owner/` on `main` at `8534794` plus the #276 changes.

Hypothetical second org: owner `jdoe`, org `acme-labs`, Apps `acme-labs-agent`, `acme-labs-admin`, `acme-labs-release`, consent answer B, Windows. "Improvise" names what the owner has to work out without a doc line telling them; "none" means the docs and the wizard cover the step.

## Path 1: fresh clone to `v0.1.0`

| # | Step | Trace | Improvise |
|---|---|---|---|
| 0 | Clone | README "Get started" step 1: clone, open Claude Code, say `set up groundwork`. `docs/setup.md` "You need" lists Node 24+, Git, `gh auth login` as yourself, a clean `main`. A fresh `git clone` writes only `core.*` layout keys, `remote.origin.url`/`fetch` and `branch.main.remote`/`merge`, all inside the wizard's `.git/config` allowlist. | none for the clone: README gives the `git clone` line since #276. A tool that added local Git config (an IDE's `branch.main.vscode-merge-base`, a local `credential.helper`) makes the wizard refuse at start, naming the key and the `git config --local --unset-all '<key>'` line. |
| 1 | Consent | Skill section 1 asks A or B before anything else, writes `%APPDATA%\groundwork\setup-state.json` and `docs/runs/<date>-setup-consent.md` (no `org` line; `Classes: [wizard]`). | none. On macOS or Linux the owner sets `GROUNDWORK_SETUP_STATE_FILE` and restarts Claude Code (skill section 2). |
| 2 | `org-create` · browser | Wizard opens `https://github.com/account/organizations/new?plan=free`, asks "Verified? y/N", then "Organization login:". | An org name already taken: the owner picks another on the page; nothing downstream holds the name yet. |
| 3 | `org-2fa` · browser | Wizard opens `/organizations/acme-labs/settings/security`. | none |
| 4 | `org-base-permission` · wizard | `gh auth refresh -s admin:org` (browser prompt), then `gh api -X PATCH /orgs/acme-labs ...` behind y/N. | none |
| 5 | `org-pat-policy` · browser | Wizard opens `/organizations/acme-labs/settings/personal-access-tokens`. | none |
| 6 | `org-actions` · wizard | Three `PUT`s; the `enabled_repositories=all` note prints first. | none |
| 7 | `org-team-agents` · browser | The wizard stops: "not in this wizard version; see docs/setup.md". The skill walks it (a new org has no team), marks it `skipped` with "no team", and the owner reruns the wizard. `docs/setup.md` Part 1 and skill section 6 now say so. | none after #276. Before it, the skill still said the wizard built only five steps. |
| 8 | `repo-copy` · wizard | Start check: `.git/config` allowlist, then `scripts/owner` and `scripts/lib` against `origin/main`. Step: consent note present, branch `main`, nothing ahead, only the note dirty; y/N each: rename `origin` to `upstream`; owner login and three slugs (defaults `acme-labs-*`), config and CODEOWNERS written; release files reset; `git add` by name, diff, note and author shown, commit `chore: set up acme-labs from groundwork vX.Y.Z`; `gh repo create acme-labs/groundwork --public --source . --remote origin`; one push URL checked; `gh repo set-default acme-labs/groundwork` (since #276 rev 2); `git push --set-upstream origin main` with hooks off. The push runs `ci.yml` on `main` once (its only `push` trigger). | (a) No Git identity: before #276 rev 2 the refusal was "git var failed with exit 128" with Git's reason dropped; it now carries Git's reason and names `user.name` and `user.email`, and both docs list the identity as a prerequisite. (b) Which repository `gh` means: the clone keeps `upstream` (for upstream updates), and `gh` without a repository sorts `upstream` first, so `gh repo view`, `gh workflow run` and every agent script (`currentRepo()` in `scripts/lib/github.mjs` runs `gh repo view` with no repository) would target upstream groundwork. Probed under the wrapper in a scratch clone with `upstream` `cli/cli` and `origin` `wimdotgg/groundwork`: `currentRepo()` returned `cli/cli`, and `wimdotgg/groundwork` once `remote.origin.gh-resolved` was `base`, the key `gh repo set-default` writes. The wizard now sets it before the push, its allowlist accepts the key, and it refuses an `upstream` that already holds it (a default set in the upstream clone moves to `upstream` on the rename). The answer A route in `docs/setup.md` and the skill has the same command. (c) The push carries `.github/workflows/`, so the credential needs the `workflow` scope (see below). (d) `LICENSE` names `wimdotgg`; `docs/setup.md` says to replace it or add a line. |
| 9 | `app-agent` · browser | Wizard prints name, homepage, webhook off, the seven repository permissions, "Only on this account", opens `/settings/apps/new`, then the slug's install page. | App slug already taken. The skill checks each slug before `repo-copy` (unauthenticated `curl`), which catches most. If GitHub still assigns another slug, the wizard opens the install page of the configured slug, which 404s: the owner installs from the App's own page, then follows "Slug recovery" in `docs/setup.md` (fix `apps.*` and `accounts.agent`, commit by path, push to `main` before `apply-settings`). The wizard does not check slug length; the skill caps it at 34. |
| 10 | `agent-key-store` · wizard | Asks client ID, App ID (Windows) and the `.pem` path; DPAPI via `powershell.exe`, key on stdin; writes `acme-labs-agent.pem.dpapi` and `.json`; offers to delete the download. Verify: `token.mjs exec -- gh repo view acme-labs/groundwork` in `docs/setup.md`; the skill's verify named no repository and would have printed the upstream repository before #276 rev 2, which adds it. | none. Until this step, the `Stop` and `PreCompact` hooks run `token.mjs exec`, which finds no key for the configured App, so each turn is expected to show a hook error line (read from `.claude/settings.json`; not run). |
| 11 | `app-admin`, `app-release` · browser | As step 9 with their permission lists; keys kept for step 13. | Slug taken: as step 9. |
| 12 | `admin-environment` · wizard | Reads `gh api user`, refuses unless it is `accounts.owner`; `PUT` the environment with the owner's user ID as reviewer, no admin bypass; adds the `branch:main` policy. | none |
| 13 | `admin-secrets` · wizard | Per App: PEM path, `gh secret set ... --env admin` with the key on stdin, client ID or App ID into the variable; offers to delete both PEMs. | none |
| 14 | `issue-types` · app | Agent runs `request.mjs create-issue-types`; the owner approves the `admin` run. | none |
| 15 | `apply-settings` · app | `--ref` the `main` SHA; labels, rulesets (the tag ruleset's release App ID comes from `{{app-id:release}}`, not a hardcoded value), `release` environment, `GROUNDWORK_READY`, `check` (its `codeowners` row passes because `repo-copy` wrote `@jdoe`); then `probe`. | none |
| 16 | `release-dispatch` · app | `gh workflow run release-please.yml --repo acme-labs/groundwork --ref main` through the wrapper (the repository named since #276 rev 2; without it, and without the `gh` default, the dispatch went to upstream and failed for the new App). Manifest `{}`, `version.txt` `0.0.0`, `initial-version` `0.1.0`, so the release App opens a `v0.1.0` release PR. | The changelog question, below. |
| 17 | `release-merge` · browser | The owner approves as code owner of the version files and uses "Merge when ready"; the release App tags `v0.1.0`. Verify: `gh release view v0.1.0 --repo acme-labs/groundwork`; without the repository it read upstream, which has a `v0.1.0`, and passed before any merge. The skill sets `consent.endedAt`. | none after #276 rev 2, if CODEOWNERS behaves (unproven below). |

### The `workflow` scope on the first push

GitHub refuses a push that creates or changes files under `.github/workflows/` unless the credential carries the `workflow` scope, and the `repo-copy` push creates all of them. Git Credential Manager tokens and `gh` set up as the Git credential helper during `gh auth login` are expected to carry it; a classic personal access token without it, or a `gh` token from an older login, does not. The wizard pushes with the owner's own Git credential, and the `admin:org` refresh and removal leave other scopes in place. `docs/setup.md` and the skill now say: when the push is refused for that scope and `gh` is the Git credential helper, run `gh auth refresh -s workflow` and push again (the wizard's `repo-copy` rerun resumes at the push). Unproven: no push to a fresh org has run.

### `bootstrap-sha`: decided, not set

The first release PR in `acme-labs/groundwork` finds no earlier release (upstream tags are not pushed and releases are not copied), so release-please reads the whole history: 239 commits on `main` today, 104 of them `feat` or `fix`, all inside its default search depth. The `v0.1.0` changelog therefore lists upstream history, and `(#N)` references in those subjects link to the new repository's numbers, which point at nothing or at unrelated issues. Setting `bootstrap-sha` to the clone point would leave only the `chore:` setup commit, which release-please does not release, so `release-dispatch` would open no PR and setup could not reach `v0.1.0`. Decision: leave `bootstrap-sha` unset and accept the upstream changelog; the owner may trim `CHANGELOG.md` in a later PR. Recorded in spec 21 (#276).

## Path 2: in-place adoption of one repository

Hypothetical `acme-labs/widget`: public, default branch `master` with a classic protection rule, labels `bug` and `wontfix`, 12 open issues, tags up to `v1.2.0`, a `LICENSE`, `README.md`, `CHANGELOG.md`, `.gitignore`, `.github/workflows/test.yml` triggered on `master`, a repository secret `NPM_TOKEN`. `acme-labs/groundwork` is at `v0.1.0` from path 1.

| # | `docs/adopt.md` section | Trace | Improvise |
|---|---|---|---|
| 1 | Opt-in | Already in the org and public. Agent requests `bootstrap --repo widget --args '{"description":"...","adopt":true}'`; `plan` prints the preflight. | Before making a private repository public, adopt says to check history for secrets but names no tool; the kit's `.gitleaks.toml` is an obvious choice but is not mentioned. |
| 2 | Preflight | Failing rows in the first plan: `default branch: master, must be main` and `collisions: .gitignore, CHANGELOG.md`. `protected main` reads `ok protected main: not set`: the row reads `/branches/main` (`readMainProtection`, `scripts/groundwork/bootstrap-repo.mjs`), which is 404 while the branch is `master`. Reported: two labels to delete, `v1.2.0` among the tags, `license`, `secrets` not read. | The first plan hides the protection failure. `docs/adopt.md` puts the rename (section 3) before the protection removal (section 5) but does not say the row turns `FAIL` only after the rename. |
| 3 | `main` | Owner renames `master` to `main` in Settings; GitHub carries the classic rule over, so the rerun's plan shows `FAIL protected main`. | `test.yml` still triggers on `master`; GitHub's rename does not edit workflow files and adopt does not mention it. The owner edits the trigger. |
| 4 | Kit merge | Owner renames `CHANGELOG.md` to `HISTORY.md` and deletes `.gitignore`, so the kit writes its own. `README.md` and `LICENSE` stay. | Deleting the project `.gitignore` drops its rules; adopt offers rename or delete only. The owner re-adds the project's ignore lines to the kit file by PR after adoption. |
| 5 | Rulesets | Agent saves the ruleset list (none); owner deletes the classic rule for `master`/`main`. | none |
| 6 | Labels | Agent exports `bug`, `wontfix` and their issue and PR lists to `.artifacts/adopt-widget/`; owner keeps a copy. | none |
| 7 | Squash-only | Owner tells contributors; `test.yml` uses `actions/checkout@v4` by tag, so it fails under SHA pinning until the Chore pins it. | none |
| 8 | Issues | Old issues get `needs-format` when touched; the planner rewrites the kept ones after the "Project setup" epic is accepted. | none |
| 9 | Tags, secrets | Chore sets the manifest and `version.txt` to `1.2.0`; no release PR approved before it. `NPM_TOKEN` moves to `production` after pass 2. | none |
| 10 | Apply | Owner freezes `main`, approves; apply re-reads, commits `chore: bootstrap from groundwork v0.1.0` over the head, syncs labels, settings and rulesets, opens the epic, ends with `check`. Then `docs/setup.md` Part 2 from step 2. | none |

## Improvisation points

1. Local `.git/config` keys outside the allowlist (step 0); the refusal names the key and the quoted removal line.
2. A taken org name (step 2); handled on the page.
3. No Git identity (step 8): the refusal now carries Git's reason and names `user.name` and `user.email`; both docs list it as a prerequisite.
4. A credential without the `workflow` scope on the first push (step 8); recovery now documented.
5. `LICENSE` naming `wimdotgg` (step 8); documented.
6. An App slug already taken or changed by GitHub (steps 9, 11): the pre-check, the wizard's 404 install page, "Slug recovery". Slug length unchecked by the wizard.
7. Hook error lines until `agent-key-store` (step 10).
8. An upstream changelog with mislinked `(#N)` references in `v0.1.0` (step 16).
9. Adoption: no named secret scanner before going public; workflow triggers on the old default branch; a deleted project `.gitignore` (path 2, sections 1, 3, 4).

10. Which repository `gh` and the agent scripts resolve in the copied clone (steps 8, 10, 16, 17): fixed by `gh repo set-default` in `repo-copy` and `--repo` on the skill and guide commands. A clone copied by hand before this needs `gh repo set-default <org>/groundwork` once.
11. Adoption: `protected main` is `ok` in the first plan while the default branch is not `main`, and fails only after the rename (path 2, row 2).

Points 6 (slug length), 7, 8, 9 and 11 are not fixed here: each is a doc line or a message in a file outside #276, and none blocks the path. Known limit, not a defect: the wizard has no page for `org-team-agents` or `release-merge` and stops at them before the skip prompt, so the skill marks them (one stop and a rerun for `org-team-agents`; `release-merge` ends consent anyway). A follow-up Chore could give `org-team-agents` a page.

## Unproven

- CODEOWNERS behaviour for a cloned owner: GitHub documents that code owners need write access; `repo-copy` writes `@jdoe`, who owns the org, so the release PR review is expected to bind. Not run.
- macOS and Linux: by design (PEM at `GROUNDWORK_AGENT_KEY_FILE`, `GROUNDWORK_SETUP_STATE_FILE`), never run.
- Adoption: nothing in path 2 has run against a real repository.
- The whole wizard under the owner login: covered by tests with fakes and local fixture repositories only, never against GitHub.
- The `workflow` scope claim and the first-push `ci.yml` run on a fresh org.
- GitHub page layouts and field names quoted in `docs/setup.md` for an org other than `wimdotgg`.
- Repository resolution and the agent loop (`next`, `claim`, `checkpoint`, `gh pr ready`) in a clone that keeps `upstream`: only `currentRepo()` and `gh repo view` were probed, in a scratch clone, with and without `gh-resolved`.
- `protected main` turning `FAIL` after a rename: read from the code, not run.
- release-please's changelog for a copied history (the analysis above is from its documented behaviour, not a run).
