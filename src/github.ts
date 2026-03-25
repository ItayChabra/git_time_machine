import * as https from "https";

const GITHUB_API = "https://api.github.com";
const MAX_RETRIES = 3;

// ── Concurrency limiter ───────────────────────────────────────────────────────

export function makeLimiter(concurrency: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        running++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            running--;
            queue.shift()?.();
          });
      };
      running < concurrency ? run() : queue.push(run);
    });
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Core HTTP ─────────────────────────────────────────────────────────────────

async function ghGet(url: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "git-time-machine-vscode",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error("JSON parse failed"));
            }
          } else {
            reject(
              Object.assign(
                new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`),
                { statusCode: res.statusCode }
              )
            );
          }
        });
      }
    );
    req.on("error", reject);
  });
}

async function ghGetWithRetry(url: string, token: string): Promise<unknown> {
  const backoff = [1000, 4000, 10000];
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await ghGet(url, token);
    } catch (e: unknown) {
      const code = (e as { statusCode?: number }).statusCode;
      const retryable = code === 429 || (code !== undefined && code >= 500);
      if (!retryable || i === MAX_RETRIES - 1) { throw e; }
      await sleep(backoff[i]);
    }
  }
  throw new Error("unreachable");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GHRepo {
  full_name: string;
  default_branch: string;
}

export interface GHPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
}

export interface GHCommit {
  sha: string;
  commit: {
    author: { name: string; date: string };
    message: string;
  };
}

export interface GHFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface GHCommitDetail extends GHCommit {
  files: GHFile[];
}

export interface GHIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  pull_request?: unknown;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function getRepo(
  owner: string,
  name: string,
  token: string
): Promise<GHRepo> {
  return ghGetWithRetry(
    `${GITHUB_API}/repos/${owner}/${name}`,
    token
  ) as Promise<GHRepo>;
}

export async function listMergedPRs(
  owner: string,
  name: string,
  token: string,
  maxPRs: number
): Promise<GHPullRequest[]> {
  const result: GHPullRequest[] = [];
  let page = 1;
  while (result.length < maxPRs) {
    const batch = (await ghGetWithRetry(
      `${GITHUB_API}/repos/${owner}/${name}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
      token
    )) as GHPullRequest[];
    if (!batch.length) { break; }
    result.push(...batch.filter((pr) => pr.merged_at !== null));
    if (batch.length < 100) { break; }
    page++;
  }
  return result.slice(0, maxPRs);
}

export async function listPRCommitShas(
  owner: string,
  name: string,
  prNumber: number,
  token: string
): Promise<string[]> {
  const shas: string[] = [];
  let page = 1;
  while (true) {
    const batch = (await ghGetWithRetry(
      `${GITHUB_API}/repos/${owner}/${name}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
      token
    )) as GHCommit[];
    if (!batch.length) { break; }
    shas.push(...batch.map((c) => c.sha));
    if (batch.length < 100) { break; }
    page++;
  }
  return shas;
}

export async function getCommitDetail(
  owner: string,
  name: string,
  sha: string,
  token: string
): Promise<GHCommitDetail> {
  return ghGetWithRetry(
    `${GITHUB_API}/repos/${owner}/${name}/commits/${sha}`,
    token
  ) as Promise<GHCommitDetail>;
}

export async function listRecentCommits(
  owner: string,
  name: string,
  token: string,
  max: number,
  since?: string
): Promise<GHCommit[]> {
  const result: GHCommit[] = [];
  let page = 1;
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
  while (result.length < max) {
    const batch = (await ghGetWithRetry(
      `${GITHUB_API}/repos/${owner}/${name}/commits?per_page=100&page=${page}${sinceParam}`,
      token
    )) as GHCommit[];
    if (!batch.length) { break; }
    result.push(...batch);
    if (batch.length < 100) { break; }
    page++;
  }
  return result.slice(0, max);
}

export async function listIssues(
  owner: string,
  name: string,
  token: string,
  max: number
): Promise<GHIssue[]> {
  if (max === 0) { return []; }
  const result: GHIssue[] = [];
  let page = 1;
  while (result.length < max) {
    const batch = (await ghGetWithRetry(
      `${GITHUB_API}/repos/${owner}/${name}/issues?state=all&per_page=100&page=${page}`,
      token
    )) as GHIssue[];
    if (!batch.length) { break; }
    result.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) { break; }
    page++;
  }
  return result.slice(0, max);
}