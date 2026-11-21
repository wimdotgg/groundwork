# groundwork

A solo human orchestrates, AI agents plan, implement, review and merge, and strict, mostly deterministic gates keep the output from becoming slop. This repository holds the kit that sets that up. Status: `0.x`.

It is three things in one public repository:

1. **Template.** `bootstrap` creates new projects from the latest release. They start with every workflow, rule and agent convention in place.
2. **Rules source.** The reusable CI workflows and agent scripts live here. Projects pin the workflows to a release tag's commit.
3. **Control repo.** Admin operations (bootstrap, settings changes) run here, behind the owner's approval.

For one owner who works with agents on GitHub. Everything assumes a free GitHub organization and public repositories (spec D1, D2).

## How a project starts

1. The agent requests `scripts/admin/request.mjs bootstrap --repo <name> --args '{"description":"..."}'`; the owner approves.
2. Bootstrap pass 1 creates the repo, labels, settings and rulesets, writes the kit files from the release tag and opens a "Project setup" epic.
3. The owner accepts the epic. Agents choose the stack, fill `scripts/verify` and write the project README.
4. The agent requests `bootstrap-pass2`; the owner approves once. It enables CodeQL, and sets the deploy switch unless `config.json` says `"deploy": "none"`.

Agents work one issue per PR through the worker loop in [AGENTS.md](AGENTS.md); the merge queue lands the PRs.

## Planned

Not built yet, listed in the spec layout: `deploy.yml`, `kit-update.mjs`, the `selftest` and `script` admin ops, and `admin-ops/`.

## Docs

- [docs/setup.md](docs/setup.md): one-time organization setup and the per-project path.
- [docs/workflow.md](docs/workflow.md): the flow for humans and where the owner steps in.
- [docs/spec.md](docs/spec.md): the specification; it wins over every other document.

Licensed MIT-0, see [LICENSE](LICENSE). Vulnerabilities: see [SECURITY.md](SECURITY.md).
