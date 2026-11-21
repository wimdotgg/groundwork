// Read-only example for the `script` op (12.1): reports a repository's default branch.
export const permissions = { "contents": "read" };

export async function run({ github, org, repo, log }) {
  const { data } = await github.request('GET', `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);
  log(`default branch ${data.default_branch}`);
  return { ok: true, summary: `${repo} default branch: ${data.default_branch}` };
}
