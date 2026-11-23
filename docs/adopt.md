# Adopting an existing repository

Bootstrap can turn a repository that already holds code and history into a groundwork project in place, instead of creating a new one (owner decision Q4 C in the onboarding epic). It never does so by default: you opt in per run. The contract is spec 14.4; the pass 1 steps around it are spec 14.2. This guide assumes `<org>` is set up and has a release tag ([setup.md](setup.md) Part 1). Placeholders follow setup.md: `<org>`, `<owner>` (your login, `accounts.owner` in `config.json`), `<repo>` the repository to adopt.

Supported on any OS Claude Code runs on (owner decision Q7 A); nothing here has run live yet, so treat each step as expected and verify it.

Each gap below names what you do (**Owner**), what the agent does (**Agent**) and how to check it (**Verify**). Work through them before the opt-in run: every failing preflight row stops `apply` before any write.

## 1. The opt-in command

- **Owner:** make `<repo>` public if it is private. Bootstrap reads the target with tokens that see public data only, so a private repository looks absent and is refused.
- **Agent:** runs `node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap --repo <repo> --args '{"description":"...","adopt":true}'`. `adopt` takes `true` only; any other value fails with `adopt must be true when given`.
- **Owner:** open the run URL and read the `plan` job summary before you approve. It prints `Adoption preflight against vX.Y.Z: N failing row(s)`, the target head, one `ok` or `FAIL` line per row and the `report` lines. With failing rows the outcome line reads `Apply stops before any write`; fix the rows and request a new run instead of approving.
- **Verify:** the summary shows `0 failing row(s)` and the outcome `If the target is still foreign when apply runs, apply merges the kit into main at the target head`.

How the opt-in reads each target state:

| State | Without `adopt` | With `adopt: true` |
|---|---|---|
| absent or private | creates a new repository | refused: `adopt: <org>/<repo> is absent or private (these tokens read public data only), nothing to adopt` |
| fresh (`auto_init` only) | resumes bootstrap | refused: `adopt: <org>/<repo> is fresh, nothing to adopt` |
| groundwork project | resumes bootstrap | resumes bootstrap; `plan` says `the target is a groundwork project` |
| anything else | refused: `<org>/<repo> exists and is neither a groundwork project nor a fresh auto_init repository` | preflight, then the kit merge |

## 2. Preflight rows

Failing rows (any one stops `apply`):

| Row | Fails when | Fix |
|---|---|---|
| `default branch` | not `main` (`<branch>, must be main`) | section 3 |
| `empty repository` | no commits | push a first commit; without one there is nothing to merge into |
| `archived` | archived | unarchive in Settings, General |
| `protected main` | classic branch protection on `main` | section 5 |
| `collisions` | a kit path exists with other content, a kit path or one of its folders exists as another type (`<path> is a tree`), or a root or `docs/` CODEOWNERS exists without `.github/CODEOWNERS` (`<path> would be shadowed by .github/CODEOWNERS, move it there`) | section 4 |

Reported rows, which never fail: `labels the sync deletes`, `v* tags`, `environments`, `open issues failing issue-format`, `license`, `secrets` (`not read; check them in the browser`) and `merge settings` (`not read; pass 1 sets squash-only`). `apply` reruns the failing rows itself and stops with `adopt preflight failed: <row>: <detail>` on any of them.

## 3. Default branch named `main`

- **Owner:** in the browser, https://github.com/<org>/<repo>/settings, "Default branch", rename it to `main`. GitHub moves open PRs and redirects the old name. Local clones need `git branch -m <old> main` and `git fetch`.
- **Agent:** nothing until the rename is done; then reruns the request.
- **Verify:** the preflight row reads `ok default branch: main`.

## 4. Kit merge into the existing tree

The kit tree is the one a new project gets (spec 14.2 step 5): the release tag's tree without the control-repo paths, owners and placeholders filled, plus `kit-version.txt`, `version.txt` (`0.0.0`), an empty `CHANGELOG.md`, `.release-please-manifest.json` (`{}`), the `scripts/verify` stubs, the deploy stubs under `scripts/stubs/deploy/` and `docs/README.md`. Adopt writes it over the head the preflight read, as one commit `chore: bootstrap from groundwork vX.Y.Z`.

- **Kept:** every project path the kit does not ship, byte for byte; any root readme (the kit `README.md` goes in only when the root holds no readme in any case or extension); any license file. Adopt never adds a `LICENSE`, beside a license file or in place of a missing one (owner decision in the onboarding epic); the `license` row names the project's files or says `none; adopt adds none, the repository owner picks one`.
- **Appended:** `.github/CODEOWNERS`. The project's lines stay and the kit lines, naming `@<owner>`, go after them, so the kit rules match last and win on kit paths.
- **Refused:** any other kit path the project holds with different content. Likely ones: `.gitignore`, `.gitattributes`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `CHANGELOG.md`, `version.txt`, `release-please-config.json`, `scripts/verify`, `docs/README.md`, `.github/dependabot.yml`, `.github/pull_request_template.md` and files under `.github/workflows/` and `.github/ISSUE_TEMPLATE/`. A root or `docs/` CODEOWNERS is refused too: GitHub reads `.github/CODEOWNERS` first, so the kit file would shadow it.

- **Owner:** decide per collision: rename the project file (`CHANGELOG.md` to `HISTORY.md`), delete it, or replace it with the kit's version from the release tag. Move a root or `docs/` CODEOWNERS to `.github/CODEOWNERS`, keeping its rules. Commit to `main` through the project's own process; groundwork rules do not apply yet.
- **Owner:** rewrite every owner in the project's CODEOWNERS lines to `@<owner>`, or drop those lines. The closing `check` has a `codeowners` row that fails while any line names another owner, a team or an email, and a failed row fails the bootstrap run (spec 14.2 step 10). Do it before adoption; if a line slips through, the rest of pass 1 has applied by then, so fix the file by PR and run `check --repo <repo>`.
- **Agent:** lists the collisions from the `plan` summary (it cuts long lists to `and N more`; the agent can diff the target tree against the release tag for the whole list), then reruns the request once `main` is fixed.
- **Verify:** `ok collisions: none`. After apply, https://github.com/<org>/<repo>/commits/main shows the bootstrap commit with the preflight head as its parent, and the project's files unchanged.

## 5. Rulesets replace branch protection

Pass 1 applies the kit rulesets (`main`, `issue/*` branches, `v*` tag creation and immutability) last. Classic branch protection on `main` would fight them, and the API deletion is a destructive admin call, so it stays yours.

- **Owner:** https://github.com/<org>/<repo>/settings/branches, delete the rule for `main`. Then check https://github.com/<org>/<repo>/settings/rules: the rulesets sync deletes every repository-level ruleset that the kit does not declare, and the preflight does not list them. Organization rulesets are left alone.
- **Agent:** reruns the request after the deletion.
- **Verify:** the preflight row reads `ok protected main: not set`; after apply, the rules page lists the kit rulesets and `request.mjs probe --repo <repo>` prints `push probe rejected: main is protected`.

## 6. Label sync deletes the project's labels

`labels.json` is the whole list. Before the kit merge, apply only creates the kit labels `<repo>` lacks (`dependencies` included), so a refused commit changes no project label. After the commit lands, the full sync runs: kit-named labels (compared case-insensitively) get the kit colour and description, and every other label is deleted, which removes it from every issue and PR. There is no undo and no keep list.

- **Owner:** read `labels the sync deletes` in `plan`. If any carry meaning, have them exported first; if one must survive, it goes into `.github/groundwork/labels.json` by PR after adoption and is recreated by `apply-settings`.
- **Agent:** before you approve, exports each listed label's issues and PRs to a file, for example `node scripts/agent/token.mjs exec -- gh issue list --repo <org>/<repo> --label "<name>" --state all --json number,title`, and attaches the result to the adoption Chore or the setup epic.
- **Verify:** the apply summary shows `- labels (missing kit labels): N created`, then the full sync line and `- labels (final pass): ...`; https://github.com/<org>/<repo>/labels matches `labels.json`.

## 7. Squash-only merges through a queue

Pass 1 sets squash merge only (merge commits and rebase merges off, auto-merge on) and the `main` ruleset adds the merge queue and squash as the only merge method, whatever the project used before. Branches merge by squash commit titled after the PR.

- **Owner:** tell contributors; open PRs built for merge commits land as one squash commit each. Merges go through the queue: `gh pr merge <n> --auto --squash`.
- **Agent:** nothing; agents already enqueue that way.
- **Verify:** `check --repo <repo>` passes; a PR page offers only "Squash and merge" via "Merge when ready".

## 8. Existing issues fail `issue-format`

Groundwork issues need the headings of `.github/groundwork/templates/`. `issue-format` runs on issue events (opened, edited, reopened, typed, untyped), so an old issue gets `needs-format` the next time it is touched. Either way `next` never offers it: it has no accepted epic, no required sections and no size label.

- **Owner:** decide which old issues matter. Accept the "Project setup" epic first (setup.md Part 2), then ask a planner to turn the ones you keep into epics and tasks from the templates, linking the old issue as context. Close the rest or leave them as backlog.
- **Agent:** the planner writes new issues from the markdown twins and links the originals; it never edits an untrusted author's issue into a task.
- **Verify:** the `open issues failing issue-format` count in `plan` is the size of the backlog; `next` lists only the new tasks.

## 9. Existing tags and secrets

**Tags.** After apply, the tag rulesets let only the release App create `v*` tags and block deleting or moving them, existing ones included. Release-please starts from `.release-please-manifest.json`, which the kit writes as `{}`, with `version.txt` at `0.0.0` and `initial-version` `0.1.0` in `release-please-config.json`. Expected, unproven: with `v*` tags already present it may propose a version that already exists.

- **Owner:** read `v* tags` in `plan`. To continue from the last tag `vX.Y.Z`, approve a Chore PR after adoption that sets `.release-please-manifest.json` to `{".": "X.Y.Z"}` and `version.txt` to `X.Y.Z` (both are code-owner paths). With no tags, the first release is `v0.1.0`.
- **Agent:** claims that Chore and opens the PR before the first release PR is merged.
- **Verify:** the next release PR by the release App proposes the version after `vX.Y.Z`.

**Secrets.** Bootstrap holds no Secrets grant, so `plan` neither reads nor moves them. Groundwork keeps secrets in environments restricted to `main` (`release`) or `v*` tags (`production`); repository secrets reach any workflow on any branch. Pass 1 creates `release` and `production` and leaves the project's other environments in place.

- **Owner:** in the browser, https://github.com/<org>/<repo>/settings/secrets/actions, note the repository secrets. After pass 2 prints the deploy secret names, enter each in the `production` environment and delete the repository-level copy. Retire or merge the project's own environments listed in `environments`.
- **Agent:** lists the production secret names in `settings.json` (setup task 04), so pass 2 prints them.
- **Verify:** the repository secrets page is empty; `check --repo <repo>` passes after pass 2.

## 10. Apply order and recovery

Apply runs, in order (spec 14.4):

1. Repeats the failing rows; stops on any.
2. Validates the kit settings files, so a bad file fails before any write.
3. Checks `main` is still the head the preflight read.
4. Creates the missing kit labels only.
5. Checks the head again, posts the kit blobs and a tree over the preflight's tree, commits with that head as parent and moves `main` with `force: false`.
6. Full label sync, then settings, rulesets, `GROUNDWORK_READY`, the "Project setup" epic, a final labels pass and `check`, as for a new project.

If `main` moved after the preflight, apply refuses with `<org>/<repo> main moved from <old> to <new> after the adopt preflight; no commit was made, rerun bootstrap`, or, when it moves between the commit and the ref update, `<org>/<repo> main moved during the commit; no ref update was made, rerun bootstrap`. Nothing of the project changed, but kit labels created in step 4 stay; a rerun reuses them. Request a new run: it reads the new head and prints a fresh preflight. A failure after step 5 is resumed by running the same command again: the target is then a groundwork project and every later step is idempotent.

After pass 1, continue with setup.md Part 2 from step 2 (the probe).
