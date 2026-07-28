// Public GitHub REST API. Anonymous: 60 req/hr. With GITHUB_TOKEN: 5,000 req/hr.

export interface GithubRepo {
  name: string;
  description: string | null;
  url: string;
  language: string | null;
  stars: number;
  updatedAt: string;
  topics: string[];
}

export interface GithubProfile {
  username: string;
  name: string | null;
  bio: string | null;
  publicRepos: number;
  topRepos: GithubRepo[];
}

const GITHUB_API = "https://api.github.com";

// Accepts a bare username ("your-handle"), an "@handle", or a full
// profile URL ("https://github.com/your-handle", "github.com/your-handle/") —
// the chat shouldn't force the user to know which form to paste.
export function parseGithubUsername(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/github\.com\/([A-Za-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1];
  return trimmed.replace(/^@/, "");
}

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

interface GithubRepoApiItem {
  name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  topics?: string[];
  fork: boolean;
}

export async function fetchGithubProfile(
  username: string,
  limit = 6,
): Promise<GithubProfile> {
  const userRes = await fetch(`${GITHUB_API}/users/${username}`, {
    headers: authHeaders(),
  });
  if (!userRes.ok) {
    throw new Error(`GitHub user not found or rate-limited: ${username} (${userRes.status})`);
  }
  const user = (await userRes.json()) as { name: string | null; bio: string | null; public_repos: number };

  const reposRes = await fetch(
    `${GITHUB_API}/users/${username}/repos?per_page=100&sort=updated`,
    { headers: authHeaders() },
  );
  if (!reposRes.ok) {
    throw new Error(`GitHub repos fetch failed for ${username} (${reposRes.status})`);
  }
  const repos = (await reposRes.json()) as GithubRepoApiItem[];

  const topRepos = repos
    .filter((r) => !r.fork)
    .sort(
      (a, b) =>
        b.stargazers_count - a.stargazers_count ||
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
    .slice(0, limit)
    .map((r) => ({
      name: r.name,
      description: r.description,
      url: r.html_url,
      language: r.language,
      stars: r.stargazers_count,
      updatedAt: r.updated_at,
      topics: r.topics ?? [],
    }));

  return {
    username,
    name: user.name ?? null,
    bio: user.bio ?? null,
    publicRepos: user.public_repos,
    topRepos,
  };
}
