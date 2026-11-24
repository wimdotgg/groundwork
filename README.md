# groundwork

A template and rules kit for GitHub. AI agents plan, build, review and merge work. Deterministic gates (CI checks, rulesets, a merge queue) decide what lands. One human owner sets the goals and approves the risky steps. Status: `0.x`.

## Who it is for

A solo owner directing AI agents on GitHub:

- You work in a free GitHub organization with public repositories. Rulesets, the merge queue and CodeQL are free only there.
- You want one issue per PR, agents that claim a task and hand it over, and gates that do not rely on an agent's word.
- You run Node 24+ and Claude Code, on Windows, macOS or Linux. Other harnesses can follow [AGENTS.md](AGENTS.md) but lose the hooks and the client-side separation from your own GitHub login; only Windows has been run so far.

Built to run from any organization; only the `wimdotgg` instance has run it so far. Setup writes your org, owner and App names into `.github/groundwork/config.json` and `.github/CODEOWNERS`; nothing else needs a hand edit. The `wimdotgg` and `wianvdm` names left in the spec (its instance-values note says why), `LICENSE`, `CHANGELOG.md`, one example in the triage skill, and the tests and their fixtures describe the instance that built groundwork. The tests read a frozen copy of the config, so they stay green under your values. Whether a cloned CODEOWNERS gates protected paths for a new owner is unconfirmed ([setup.md, Notes](docs/setup.md#notes)).

## What you get

A new project starts with the CI workflows, rulesets, labels and agent scripts already in place. Agents work through a fixed loop (`next`, `claim`, build, `checkpoint`, ready, enqueue), and the merge queue lands the PRs. You step in to accept epics, answer `needs-decision` questions, approve admin runs, protected-path PRs and production deploys, and merge releases.

## Get started

1. Once per organization: clone this repository (`git clone https://github.com/wimdotgg/groundwork.git`), open Claude Code in the clone and say `set up groundwork`. The `groundwork-setup` skill asks one consent question, then walks you through the org, three GitHub Apps (agent, admin, release), the agent key and the copy of this repository into the org as the control repo. Under answer B you run the owner wizard, `node scripts/owner/setup.mjs`, in your own terminal; it asks y/N before every write. Without Claude Code, follow part 1 of [docs/setup.md](docs/setup.md) by hand, about an hour, mostly in the browser.
2. For each project: an agent requests a bootstrap, you approve the run in the browser, then you accept the "Project setup" epic.

```
node scripts/agent/token.mjs exec -- node scripts/admin/request.mjs bootstrap --repo <name> --args '{"description":"..."}'
```

Part 2 of `docs/setup.md` has the full per-project path, including pass 2 and updating a project with `node scripts/agent/token.mjs exec -- node scripts/kit-update.mjs <vX.Y.Z>`.

To turn a repository you already have into a project in place, see [docs/adopt.md](docs/adopt.md).

## Docs

- [docs/setup.md](docs/setup.md): one-time organization setup and the per-project path.
- [docs/adopt.md](docs/adopt.md): adopting an existing repository.
- [docs/workflow.md](docs/workflow.md): the flow for humans and where the owner steps in.
- [docs/spec.md](docs/spec.md): the specification; it wins over every other document.

Licensed MIT-0, see [LICENSE](LICENSE). Vulnerabilities: see [SECURITY.md](SECURITY.md).
