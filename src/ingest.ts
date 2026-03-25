import { Database } from "sql.js";
import { dbGet, dbAll, dbRun, dbRunGetId, persist } from "./db";
import {
  makeLimiter,
  getRepo,
  listMergedPRs,
  listPRCommitShas,
  listRecentCommits,
  listIssues,
  getCommitDetail,
  GHCommit,
} from "./github";
import { buildAndPersistEpisodes } from "./episodes";

export interface IngestConfig {
  owner: string;
  name: string;
  githubToken: string;
  geminiApiKey: string;
  geminiModel: string;
  maxPRs: number;
  maxUnlinkedCommits: number;
  maxIssues: number;
  onProgress?: (message: string) => void;
}

// Truncation limits — keeps the DB lean on large repos
const PR_BODY_MAX = 5_000;
const ISSUE_BODY_MAX = 2_000;

export async function ingestRepo(
  repoId: number,
  db: Database,
  cfg: IngestConfig
): Promise<void> {
  const { owner, name, githubToken } = cfg;
  const report = (msg: string) => cfg.onProgress?.(msg);

  // ── 1. Fetch merged PRs ───────────────────────────────────────────────────
  report(`Fetching PRs for ${owner}/${name}...`);
  const prs = await listMergedPRs(owner, name, githubToken, cfg.maxPRs);

  const existingPRNumbers = new Set(
    dbAll(db, "SELECT number FROM pull_requests WHERE repo_id = ?", repoId).map(
      (r) => r["number"] as number
    )
  );

  for (const pr of prs) {
    if (!existingPRNumbers.has(pr.number)) {
      dbRun(
        db,
        "INSERT OR IGNORE INTO pull_requests (repo_id, number, title, body, state, merged_at) VALUES (?, ?, ?, ?, ?, ?)",
        repoId,
        pr.number,
        pr.title,
        // Truncate body to avoid bloating the DB on repos with large PR descriptions
        (pr.body ?? "").slice(0, PR_BODY_MAX),
        pr.state,
        pr.merged_at
      );
      existingPRNumbers.add(pr.number);
    }
  }
  persist();

  report(`Fetching commits for ${prs.length} PRs...`);
  // ── 2. Fetch commits for each PR in parallel (cap 5) ─────────────────────
  const prLimiter = makeLimiter(5);
  const commitLimiter = makeLimiter(5);

  const existingCommitShas = new Set(
    dbAll(db, "SELECT sha FROM commits WHERE repo_id = ?", repoId).map(
      (r) => r["sha"] as string
    )
  );

  const prRows = dbAll(
    db,
    "SELECT id, number FROM pull_requests WHERE repo_id = ?",
    repoId
  );
  const prIdByNumber = new Map(
    prRows.map((r) => [r["number"] as number, r["id"] as number])
  );

  const prCommitTasks = prs.map((pr) =>
    prLimiter(async () => {
      const shas = await listPRCommitShas(owner, name, pr.number, githubToken);
      const prDbId = prIdByNumber.get(pr.number);
      if (!prDbId) { return; }

      const newShas = shas.filter((sha) => !existingCommitShas.has(sha));
      await Promise.all(
        newShas.map((sha) =>
          commitLimiter(async () => {
            try {
              const detail = await getCommitDetail(owner, name, sha, githubToken);
              dbRun(
                db,
                "INSERT OR IGNORE INTO commits (repo_id, sha, author, date, message, pr_id) VALUES (?, ?, ?, ?, ?, ?)",
                repoId,
                sha,
                detail.commit.author.name,
                detail.commit.author.date,
                detail.commit.message,
                prDbId
              );
              existingCommitShas.add(sha);

              const commitRow = dbGet(db, "SELECT id FROM commits WHERE sha = ?", sha);
              if (commitRow) {
                const commitDbId = commitRow["id"] as number;
                for (const f of detail.files ?? []) {
                  dbRun(
                    db,
                    "INSERT INTO file_changes (commit_id, file_path, change_type) VALUES (?, ?, ?)",
                    commitDbId,
                    f.filename,
                    f.status
                  );
                }
              }
            } catch (e) {
              console.error(`[GTM] Failed to fetch commit ${sha}:`, e);
            }
          })
        )
      );
    })
  );

  await Promise.all(prCommitTasks);
  persist();

  report(`Fetching recent unlinked commits...`);
  // ── 3. Fetch recent unlinked commits ──────────────────────────────────────
  const latestRow = dbGet(
    db,
    "SELECT MAX(date) as d FROM commits WHERE repo_id = ?",
    repoId
  );
  const latestDate = latestRow?.["d"] as string | null;

  const recentCommits = await listRecentCommits(
    owner,
    name,
    githubToken,
    cfg.maxUnlinkedCommits,
    latestDate ?? undefined
  );

  const unlinkedShas = recentCommits
    .filter((c: GHCommit) => !existingCommitShas.has(c.sha))
    .map((c: GHCommit) => c.sha);

  await Promise.all(
    unlinkedShas.map((sha) =>
      commitLimiter(async () => {
        try {
          const detail = await getCommitDetail(owner, name, sha, githubToken);
          dbRun(
            db,
            "INSERT OR IGNORE INTO commits (repo_id, sha, author, date, message, pr_id) VALUES (?, ?, ?, ?, ?, ?)",
            repoId,
            sha,
            detail.commit.author.name,
            detail.commit.author.date,
            detail.commit.message,
            null
          );
          existingCommitShas.add(sha);

          const commitRow = dbGet(db, "SELECT id FROM commits WHERE sha = ?", sha);
          if (commitRow) {
            const commitDbId = commitRow["id"] as number;
            for (const f of detail.files ?? []) {
              dbRun(
                db,
                "INSERT INTO file_changes (commit_id, file_path, change_type) VALUES (?, ?, ?)",
                commitDbId,
                f.filename,
                f.status
              );
            }
          }
        } catch (e) {
          console.error(`[GTM] Failed to fetch unlinked commit ${sha}:`, e);
        }
      })
    )
  );
  persist();

  report(`Fetching issues...`);
  // ── 4. Fetch issues ───────────────────────────────────────────────────────
  const issues = await listIssues(owner, name, githubToken, cfg.maxIssues);
  const existingIssueNumbers = new Set(
    dbAll(db, "SELECT number FROM issues WHERE repo_id = ?", repoId).map(
      (r) => r["number"] as number
    )
  );
  for (const issue of issues) {
    if (!existingIssueNumbers.has(issue.number)) {
      dbRun(
        db,
        "INSERT OR IGNORE INTO issues (repo_id, number, title, body, state) VALUES (?, ?, ?, ?, ?)",
        repoId,
        issue.number,
        issue.title,
        // Truncate body to avoid bloating the DB on repos with many large issues
        (issue.body ?? "").slice(0, ISSUE_BODY_MAX),
        issue.state
      );
    }
  }
  persist();

  report(`Building episodes and generating AI summaries...`);
  // ── 5. Build episodes ─────────────────────────────────────────────────────
  await buildAndPersistEpisodes(repoId, db, cfg.geminiApiKey, cfg.geminiModel);

  // ── 6. Mark ready ─────────────────────────────────────────────────────────
  dbRun(db, "UPDATE repos SET status = 'ready' WHERE id = ?", repoId);
  persist();
}

export async function initAndIngestRepo(
  db: Database,
  cfg: IngestConfig
): Promise<{ repoId: number; alreadyReady: boolean }> {
  const repoData = await getRepo(cfg.owner, cfg.name, cfg.githubToken);

  const existing = dbGet(
    db,
    "SELECT id, status FROM repos WHERE full_name = ?",
    repoData.full_name
  );
  if (existing) {
    const repoId = existing["id"] as number;
    const status = existing["status"] as string;
    if (status === "ready") { return { repoId, alreadyReady: true }; }
    // Was indexing / errored — re-run
    dbRun(db, "UPDATE repos SET status = 'indexing' WHERE id = ?", repoId);
    return { repoId, alreadyReady: false };
  }

  const repoId = dbRunGetId(
    db,
    "INSERT INTO repos (owner, name, full_name, default_branch, status) VALUES (?, ?, ?, ?, 'indexing')",
    cfg.owner,
    cfg.name,
    repoData.full_name,
    repoData.default_branch
  );
  persist();
  return { repoId, alreadyReady: false };
}

export function getRepoStatus(db: Database, repoId: number): string | null {
  const row = dbGet(db, "SELECT status FROM repos WHERE id = ?", repoId);
  return row ? (row["status"] as string) : null;
}