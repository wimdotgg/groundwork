# Workflow

The flow for humans. Rules and contracts live in [spec.md](spec.md); this page shows where you step in.

## Lifecycle

Owner gates are the dark boxes.

```mermaid
flowchart TD
  G([Owner delegates a goal]):::gate --> P[Planner opens epic and sub-issues]
  P --> A{{Owner applies accepted}}:::gate
  A --> N[Workers: next, then claim]
  N --> D[Draft PR on issue/N]
  D --> C[Checks and advisory review]
  C --> R[Ready for review]
  R --> PP{{Protected paths? Owner approves}}:::gate
  PP --> Q[Merge queue]
  R --> Q
  Q --> S[Squash merge]
  S --> H[Handover: State section, issue closes]
  S --> RP[release-please PR]
  RP --> M{{Owner merges release PR}}:::gate
  M --> T[Release App tags v*]
  T --> AP{{Owner approves production}}:::gate
  AP --> DP[Deploy]
  DP --> SM[Smoke]
  SM -->|fails| RB[Rollback]
  SM -->|passes| OK([Live])
  D -. needs-decision .-> ND{{Owner answers}}:::gate
  ND -.-> N

  classDef gate fill:#1f2937,stroke:#f59e0b,color:#ffffff,stroke-width:2px
```

Sections: planning [6.2](spec.md), worker loop [6.3](spec.md), PR contract [7](spec.md), CI [8](spec.md), rulesets [9](spec.md), releases [11](spec.md).

## Your touchpoints

- Accept epics: apply the `accepted` label once the plan reads right. Nothing is built before this.
- Answer `needs-decision` issues. The agent stops and waits (6.6).
- Approve PRs that touch protected paths (CODEOWNERS, 9.4).
- Approve admin runs in the browser or the GitHub mobile app (section 12).
- Merge release PRs (section 11). They touch the manifest, so they need your approval too.
- Approve each production deploy (the `production` environment, 10.1).

Everything else merges on green checks through the queue.

## Your inbox

`scripts/human/inbox` lists what waits for you: epics to accept, `needs-decision` issues, PRs on protected paths, release PRs, alert issues. Arrives in Phase 3.

## Admin tiers

| Tier | Scope | Your action |
|---|---|---|
| 0 | Normal work, agent App | none |
| 1 | Settings as code (`settings.json`, `labels.json`, `rulesets/*.json`) | Approve the PR, then the `admin` run |
| 2 | One-off ops: bootstrap, new repo, issue types, cleanup | Read the run summary, approve the `admin` run |
| 3 | Apps, billing, org ownership, secret values, PAT rotation | You, in the browser |

Detail in [section 12](spec.md).

## What agents never do

Force-push or rebase, push to `main`, bypass checks, change rulesets or secrets, or merge their own protected-path changes. The full list is in [AGENTS.md](../AGENTS.md); the enforcement is in [sections 9 and 17](spec.md).
