# Claim-loop run 2026-11-21

- First claim: session c7c7de56-c010-4588-87df-03194dd78608 won (exit 0) at 05:50:00Z by the local clock (GitHub stamped the claim commit 7c1fb65 at 05:49:50Z); session 1ce6b81a-43ca-4a4e-85dd-0e2ced24d283 got exit 3.
- The winner's Stop hook pushed its unpushed commit 14dbf8a.
- The winner ran `release --decision`; session 1ce6b81a-43ca-4a4e-85dd-0e2ced24d283 took over with `claim.mjs` (mode takeover). The winner's next `checkpoint` exited 3.
- Gotcha: two worktrees of one clone cannot both check out `issue/127`. A released worker must leave the branch (`git checkout --detach`) before the taker can check it out.
- Gotcha: the local clock ran about 10 s ahead of GitHub; leases use only server timestamps, so this does not affect them.
- Final checkpoint: 2, by session 1ce6b81a-43ca-4a4e-85dd-0e2ced24d283.
