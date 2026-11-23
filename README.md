# groundwork

A template and rules kit for GitHub. AI agents plan, build, review and merge work. Deterministic gates (CI checks, rulesets, a merge queue) decide what lands. One human owner sets the goals and approves the risky steps. Status: `0.x`.

## Who it is for

A solo owner directing AI agents on GitHub:

- You work in a free GitHub organization with public repositories. Rulesets, the merge queue and CodeQL are free only there.
- You want one issue per PR, agents that claim a task and hand it over, and gates that do not rely on an agent's word.
- You run Node 24+ and an agent harness that reads [AGENTS.md](AGENTS.md).

Built to run from any organization, tested only in `wimdotgg`. The org, owner and App names live in `.github/groundwork/config.json`, but `.github/CODEOWNERS`, [docs/setup.md](docs/setup.md), `AGENTS.md` and the spec still use the `wimdotgg` and `wianvdm` values. Swap them by hand.

## What you get

A new project starts with the CI workflows, rulesets, labels and agent scripts already in place. Agents work through a fixed loop (`next`, `claim`, build, `checkpoint`, ready, enqueue), and the merge queue lands the PRs. You step in to accept epics, answer `needs-decision` questions, approve admin runs, protected-path PRs and production deploys, and merge releases.

## Get started

Setup is manual today. There is no one-command installer.

1. Once per organization: create the org, three GitHub Apps (agent, admin, release) and the agent key, and copy this repository into the org as the control repo. Follow part 1 of [docs/setup.md](docs/setup.md), about 20 minutes in the browser.
2. For each project: an agent requests a bootstrap, you approve the run in the browser, then you accept the "Project setup" epic.

```
node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap --repo <name> --args '{"description":"..."}'
```

Part 2 of `docs/setup.md` has the full per-project path, including pass 2 and updating a project with `node scripts/agent/token.mjs exec -- node scripts/kit-update.mjs <vX.Y.Z>`.

Easier setup and portability to other organizations are being scoped in [epic #251](https://github.com/wimdotgg/groundwork/issues/251).

## Docs

- [docs/setup.md](docs/setup.md): one-time organization setup and the per-project path.
- [docs/workflow.md](docs/workflow.md): the flow for humans and where the owner steps in.
- [docs/spec.md](docs/spec.md): the specification; it wins over every other document.

Licensed MIT-0, see [LICENSE](LICENSE). Vulnerabilities: see [SECURITY.md](SECURITY.md).
