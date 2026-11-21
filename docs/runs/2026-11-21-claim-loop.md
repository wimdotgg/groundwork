# Claim-loop run 2026-11-21

- First claim: session c7c7de56-c010-4588-87df-03194dd78608 won (exit 0) at 05:50:00Z; session 1ce6b81a-43ca-4a4e-85dd-0e2ced24d283 got exit 3.
- The winner's Stop hook pushed its unpushed commit 14dbf8a.
- The winner ran `release --decision`; session 1ce6b81a-43ca-4a4e-85dd-0e2ced24d283 took over with `claim.mjs` (mode takeover). The winner's next `checkpoint` exited 3.
- Gotcha: two worktrees of one clone cannot both check out `issue/127`. A released worker must leave the branch (`git checkout --detach`) before the taker can check it out.
- Final checkpoint: 1, by session 1ce6b81a-43ca-4a4e-85dd-0e2ced24d283.
