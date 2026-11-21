# Add Dependabot ecosystems
<!-- type: Chore -->
<!-- size: S -->
<!-- blocked-by: 01 -->

## Outcome

Dependabot watches every package ecosystem the chosen stack uses.

## Serves

E2

## Scope

In: add one `updates` entry per ecosystem in `.github/dependabot.yml`, keeping the existing `github-actions` entry. Out: major upgrades.

## Touches

`.github/dependabot.yml`

## Acceptance criteria

- [ ] AC1 `.github/dependabot.yml` has an `updates` entry for each package manager the project uses.
- [ ] AC2 Each new entry has `package-ecosystem`, `directory`, `schedule` and the `dependencies` label, as the `github-actions` entry does.

## Verification plan

Read the PR diff of `.github/dependabot.yml`: each ecosystem is listed with those keys. After merge, the repository's Dependabot page shows no configuration error.

## Risk

low

## Context

Dependabot PRs carry the `dependencies` label; the reviewer enqueues green minor and patch updates.
