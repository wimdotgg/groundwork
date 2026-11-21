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
- [ ] AC2 GitHub's Dependabot page reports no configuration error for the file.

## Verification plan

Open the repository's Dependabot insights page after merge and check each ecosystem is listed without errors.

## Risk

low

## Context

Dependabot PRs carry the `dependencies` label; the reviewer enqueues green minor and patch updates.
