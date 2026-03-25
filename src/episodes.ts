import { Database } from "sql.js";
import { dbAll, dbGet, dbRun, dbRunGetId, persist } from "./db";
import { summarizeEpisode, EpisodeContext } from "./llm";
import { makeLimiter } from "./github";

interface CommitRow {
  id: number; sha: string; date: string; message: string | null; pr_id: number | null;
}
interface PRRow {
  id: number; number: number; title: string | null; body: string | null; merged_at: string | null;
}
interface IssueRow {
  id: number; number: number; title: string | null; body: string | null;
}

function parseIssueNumbers(text: string): number[] {
  return [...text.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
}

export interface EpisodeSummary {
  id: number; title: string;
  start_date: string; end_date: string;
  llm_summary: string | null;
  pr_number: number | null; issue_number: number | null;
}

export async function buildAndPersistEpisodes(
  repoId: number, db: Database, apiKey: string, model: string
): Promise<void> {
  // Clear existing episodes
  const oldEps = dbAll(db, "SELECT id FROM episodes WHERE repo_id = ?", repoId);
  for (const ep of oldEps) {
    dbRun(db, "DELETE FROM episode_members WHERE episode_id = ?", ep["id"]);
    dbRun(db, "DELETE FROM episodes WHERE id = ?", ep["id"]);
  }

  const commits = dbAll(
    db,
    "SELECT id, sha, date, message, pr_id FROM commits WHERE repo_id = ? AND date IS NOT NULL ORDER BY date ASC",
    repoId
  ) as unknown as CommitRow[];
  if (!commits.length) { return; }

  const allPRs = dbAll(
    db, "SELECT id, number, title, body, merged_at FROM pull_requests WHERE repo_id = ?", repoId
  ) as unknown as PRRow[];
  const prById = new Map(allPRs.map(pr => [pr.id, pr]));
  const mergedPRs = allPRs
    .filter(pr => pr.merged_at)
    .sort((a, b) => a.merged_at!.localeCompare(b.merged_at!));

  // Group commits by PR, collect unlinked
  const commitsByPr = new Map<number, CommitRow[]>();
  const unlinked: CommitRow[] = [];
  for (const c of commits) {
    if (c.pr_id !== null) {
      const arr = commitsByPr.get(c.pr_id) ?? [];
      arr.push(c);
      commitsByPr.set(c.pr_id, arr);
    } else {
      unlinked.push(c);
    }
  }

  // Heuristic: link unlinked commits to merged PR within 24h
  for (const c of unlinked) {
    const cTime = new Date(c.date).getTime();
    const match = mergedPRs.find(pr => {
      const mergedTime = new Date(pr.merged_at!).getTime();
      return mergedTime >= cTime && mergedTime - cTime <= 86_400_000;
    });
    if (match) {
      c.pr_id = match.id;
      dbRun(db, "UPDATE commits SET pr_id = ? WHERE id = ?", match.id, c.id);
      const arr = commitsByPr.get(match.id) ?? [];
      arr.push(c);
      commitsByPr.set(match.id, arr);
    }
  }
  const stillUnlinked = unlinked.filter(c => c.pr_id === null);

  // Build windows: PR-grouped + time-windowed unlinked
  const windows: { commits: CommitRow[]; prId: number | null }[] = [
    ...[...commitsByPr.entries()].map(([prId, cs]) => ({ commits: cs, prId })),
  ];
  if (stillUnlinked.length) {
    let w = [stillUnlinked[0]];
    for (let i = 1; i < stillUnlinked.length; i++) {
      const gap = new Date(stillUnlinked[i].date).getTime() - new Date(w[w.length - 1].date).getTime();
      if (gap <= 86_400_000) { w.push(stillUnlinked[i]); }
      else { windows.push({ commits: w, prId: null }); w = [stillUnlinked[i]]; }
    }
    windows.push({ commits: w, prId: null });
  }
  windows.sort((a, b) => a.commits[0].date.localeCompare(b.commits[0].date));

  // Build episode summaries in parallel (capped at 3)
  const epLimiter = makeLimiter(3);
  const tasks = windows.map(w => epLimiter(async () => {
    const pr = w.prId !== null ? (prById.get(w.prId) ?? null) : null;
    const allText = [
      ...w.commits.map(c => c.message ?? ""),
      pr?.title ?? "",
      pr?.body ?? "",
    ].join(" ");

    const issueNums = parseIssueNumbers(allText);
    const issue = issueNums.length
      ? (dbGet(db, "SELECT id, number, title, body FROM issues WHERE repo_id = ? AND number = ?",
          repoId, issueNums[0]) as unknown as IssueRow | undefined) ?? null
      : null;

    let title: string;
    if (pr) { title = `PR #${pr.number}: ${pr.title ?? "No Title"}`; }
    else if (issue) { title = `Issue #${issue.number}: ${issue.title ?? "No Title"}`; }
    else { title = `Changes on ${w.commits[0].date.slice(0, 10)}`; }

    const ctx: EpisodeContext = {
      pr_title: pr?.title ?? "",
      pr_body: (pr?.body ?? "").slice(0, 600),
      commit_messages: w.commits.map(c => c.message ?? "").join("\n").slice(0, 600),
      issue_title: issue?.title ?? "",
      issue_body: (issue?.body ?? "").slice(0, 400),
    };

    const llmSummary = await summarizeEpisode(ctx, apiKey, model);
    const sorted = [...w.commits].sort((a, b) => a.date.localeCompare(b.date));

    const epId = dbRunGetId(
      db,
      "INSERT INTO episodes (repo_id, title, start_date, end_date, llm_summary) VALUES (?, ?, ?, ?, ?)",
      repoId, title, sorted[0].date, sorted[sorted.length - 1].date, llmSummary
    );

    for (const c of w.commits) {
      dbRun(db, "INSERT INTO episode_members (episode_id, commit_id, pr_id, issue_id, member_type) VALUES (?, ?, ?, ?, ?)",
        epId, c.id, null, null, "commit");
    }
    if (pr) {
      dbRun(db, "INSERT INTO episode_members (episode_id, commit_id, pr_id, issue_id, member_type) VALUES (?, ?, ?, ?, ?)",
        epId, null, pr.id, null, "pr");
    }
    if (issue) {
      dbRun(db, "INSERT INTO episode_members (episode_id, commit_id, pr_id, issue_id, member_type) VALUES (?, ?, ?, ?, ?)",
        epId, null, null, issue.id, "issue");
    }
  }));

  await Promise.all(tasks);
  persist();
}

export function episodeForCommit(commitId: number, db: Database): EpisodeSummary | null {
  const row = dbGet(db, `
    SELECT e.id, e.title, e.start_date, e.end_date, e.llm_summary,
           pr.number AS pr_number, i.number AS issue_number
    FROM episodes e
    JOIN episode_members em ON em.episode_id = e.id AND em.commit_id = ? AND em.member_type = 'commit'
    LEFT JOIN episode_members epr ON epr.episode_id = e.id AND epr.member_type = 'pr'
    LEFT JOIN pull_requests pr ON pr.id = epr.pr_id
    LEFT JOIN episode_members ei ON ei.episode_id = e.id AND ei.member_type = 'issue'
    LEFT JOIN issues i ON i.id = ei.issue_id
    LIMIT 1
  `, commitId);

  if (!row) { return null; }
  return {
    id: row["id"] as number,
    title: row["title"] as string,
    start_date: row["start_date"] as string,
    end_date: row["end_date"] as string,
    llm_summary: row["llm_summary"] as string | null,
    pr_number: row["pr_number"] as number | null,
    issue_number: row["issue_number"] as number | null,
  };
}