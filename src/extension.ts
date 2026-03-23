import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { getDb, closeDb, persist, dbGet, dbAll, dbRun } from "./db";
import { initAndIngestRepo, ingestRepo, getRepoStatus } from "./ingest";
import { episodeForCommit } from "./episodes";
import { cacheGet, cacheSet, cacheClearMemory, cacheClearAll } from "./cache";
import { explainFunction, explainHunk } from "./llm";
import { getCommitDetail } from "./github";

const execAsync = promisify(exec);

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("gitTimeMachine");
  return {
    githubToken: cfg.get<string>("githubToken", ""),
    geminiApiKey: cfg.get<string>("geminiApiKey", ""),
    geminiModel: cfg.get<string>("geminiModel", "gemini-2.0-flash"),
    maxPRs: cfg.get<number>("maxPRs", 50),
    maxUnlinkedCommits: cfg.get<number>("maxUnlinkedCommits", 50),
  };
}

function validateConfig(cfg: ReturnType<typeof getConfig>): string | null {
  if (!cfg.githubToken) {
    return "Git Time Machine: GitHub token not set. Add it in Settings → Git Time Machine.";
  }
  if (!cfg.geminiApiKey) {
    return "Git Time Machine: Gemini API key not set. Add it in Settings → Git Time Machine.";
  }
  return null;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function parseGitHubRemote(url: string): { owner: string; name: string } | null {
  const h = url.match(/https?:\/\/github\.com\/([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  if (h) { return { owner: h[1], name: h[2] }; }
  const s = url.match(/git@github\.com:([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  if (s) { return { owner: s[1], name: s[2] }; }
  return null;
}

async function getRepoOwnerName(workspaceRoot: string): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await execAsync("git remote -v", { cwd: workspaceRoot });
    const lines = stdout.split("\n").filter(l => l.includes("(fetch)"));
    const originLine = lines.find(l => l.startsWith("origin\t") || l.startsWith("origin "));
    if (originLine) {
      const parsed = parseGitHubRemote(originLine.split(/\s+/)[1]);
      if (parsed) { return parsed; }
    }
    for (const line of lines) {
      const url = line.split(/\s+/)[1];
      if (!url) { continue; }
      const parsed = parseGitHubRemote(url);
      if (parsed) { return parsed; }
    }
    return null;
  } catch { return null; }
}

interface BlameInfo { sha: string; originalLine: number; repoRelativePath: string; }

async function getBlameInfo(
  filePath: string, lineNumber: number, workspaceRoot: string
): Promise<BlameInfo | null> {
  try {
    const normalizedFile = filePath.split(path.sep).join("/");
    const normalizedRoot = workspaceRoot.split(path.sep).join("/");
    const { stdout } = await execAsync(
      `git blame -L ${lineNumber},${lineNumber} --porcelain -- "${normalizedFile}"`,
      { cwd: workspaceRoot }
    );
    const firstLine = stdout.split("\n")[0].split(" ");
    const sha = firstLine[0];
    const originalLine = parseInt(firstLine[1], 10);
    if (!sha || sha.length < 7 || isNaN(originalLine)) { return null; }
    if (/^0+$/.test(sha)) { return null; }
    const repoRelativePath = normalizedFile.replace(normalizedRoot, "").replace(/^\//, "");
    if (!repoRelativePath || repoRelativePath === normalizedFile) { return null; }
    return { sha, originalLine, repoRelativePath };
  } catch { return null; }
}

async function getEnclosingSymbol(document: vscode.TextDocument, line: number): Promise<string | null> {
  try {
    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >("vscode.executeDocumentSymbolProvider", document.uri);
    if (!symbols?.length) { return null; }
    const BLOCK_KINDS = new Set([
      vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class,
      vscode.SymbolKind.Module, vscode.SymbolKind.Namespace, vscode.SymbolKind.Constructor,
    ]);
    const flat: { name: string; start: number; end: number }[] = [];
    function collect(syms: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) {
      for (const sym of syms) {
        if ("range" in sym) {
          if (BLOCK_KINDS.has(sym.kind)) {
            flat.push({ name: sym.name, start: sym.range.start.line, end: sym.range.end.line });
          }
          if (sym.children?.length) { collect(sym.children); }
        } else if ("location" in sym) {
          if (BLOCK_KINDS.has(sym.kind)) {
            flat.push({ name: sym.name, start: sym.location.range.start.line, end: sym.location.range.end.line });
          }
        }
      }
    }
    collect(symbols);
    return flat
      .filter(s => s.start <= line && line <= s.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]?.name ?? null;
  } catch { return null; }
}

function extractHunkForLine(
  patch: string, originalLine: number
): { hunk: string; hunkStart: number | null } {
  if (!patch) { return { hunk: patch, hunkStart: null }; }
  const hunks: { start: number; count: number; lines: string[] }[] = [];
  let current: { start: number; count: number; lines: string[] } | null = null;
  for (const line of patch.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (m) {
      if (current) { hunks.push(current); }
      current = { start: parseInt(m[1]), count: parseInt(m[2] ?? "1"), lines: [line] };
    } else if (current) { current.lines.push(line); }
  }
  if (current) { hunks.push(current); }
  for (const h of hunks) {
    if (h.start <= originalLine && originalLine <= h.start + h.count) {
      return { hunk: h.lines.join("\n"), hunkStart: h.start };
    }
  }
  return { hunk: patch, hunkStart: null };
}

// ── State ─────────────────────────────────────────────────────────────────────

let _context: vscode.ExtensionContext | null = null;
const repoIdCache = new Map<string, number>();

// Track ongoing background ingestion promises per workspace root
// so we never double-ingest and can check if still running
const activeIngests = new Map<string, Promise<void>>();

// ── Repo resolution ───────────────────────────────────────────────────────────

async function resolveRepoId(
  workspaceRoot: string,
  cfg: ReturnType<typeof getConfig>
): Promise<number | null> {
  // Cache hit — already ready
  const cached = repoIdCache.get(workspaceRoot);
  if (cached !== undefined) { return cached; }

  if (!_context) { return null; }
  const db = await getDb(_context);
  const remote = await getRepoOwnerName(workspaceRoot);
  if (!remote) { return null; }

  const { repoId, alreadyReady } = await initAndIngestRepo(db, {
    ...remote,
    githubToken: cfg.githubToken,
    geminiApiKey: cfg.geminiApiKey,
    geminiModel: cfg.geminiModel,
    maxPRs: cfg.maxPRs,
    maxUnlinkedCommits: cfg.maxUnlinkedCommits,
  });

  if (alreadyReady) {
    repoIdCache.set(workspaceRoot, repoId);
    return repoId;
  }

  // Start background ingest if not already running
  if (!activeIngests.has(workspaceRoot)) {
    const ingestPromise = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Git Time Machine: Indexing ${remote.owner}/${remote.name}`,
        cancellable: false,
      },
      async (progress) => {
        try {
          await ingestRepo(repoId, db, {
            ...remote,
            githubToken: cfg.githubToken,
            geminiApiKey: cfg.geminiApiKey,
            geminiModel: cfg.geminiModel,
            maxPRs: cfg.maxPRs,
            maxUnlinkedCommits: cfg.maxUnlinkedCommits,
            onProgress: (msg) => progress.report({ message: msg }),
          });
          repoIdCache.set(workspaceRoot, repoId);
          vscode.window.showInformationMessage(
            "Git Time Machine: Indexing complete. Hovers are now active!"
          );
        } catch (e) {
          console.error("[GTM] Ingestion failed:", e);
          dbRun(db, "UPDATE repos SET status = 'error' WHERE id = ?", repoId);
          persist();
          vscode.window.showErrorMessage(`Git Time Machine: Indexing failed — ${e}`);
        }
      }
    ) as Promise<void>;
    ingestPromise.then(() => activeIngests.delete(workspaceRoot));

    activeIngests.set(workspaceRoot, ingestPromise);
  }

  // Still indexing — hovers return null until done
  return null;
}

// ── Blame story ───────────────────────────────────────────────────────────────

interface BlameStory {
  sha: string; file_path: string | null;
  function_name: string | null; file_explanation: string | null;
  episode: {
    id: number; title: string; start_date: string; end_date: string;
    llm_summary: string | null; pr_number: number | null; issue_number: number | null;
  } | null;
}

async function getBlameStory(
  sha: string, filePath: string, originalLine: number, functionName: string | null,
  workspaceRoot: string
): Promise<BlameStory | null> {
  if (!_context) { return null; }
  const cfg = getConfig();
  const db = await getDb(_context);

  const commit = dbGet(db, "SELECT id, message, pr_id FROM commits WHERE sha = ?", sha) as
    { id: number; message: string | null; pr_id: number | null } | undefined;

  const episode = commit ? episodeForCommit(commit.id, db) : null;

  let prTitle: string | null = null;
  let prBody: string | null = null;
  if (commit?.pr_id) {
    const pr = dbGet(db, "SELECT title, body FROM pull_requests WHERE id = ?", commit.pr_id) as
      { title: string | null; body: string | null } | undefined;
    prTitle = pr?.title ?? null;
    prBody = pr?.body ?? null;
  }

  const cacheKey = functionName
    ? `fn:${sha}:${filePath}:${functionName}`
    : `hunk:${sha}:${filePath}:${originalLine}`;

  const cached = cacheGet(cacheKey, db);
  if (cached) {
    return { sha, file_path: filePath, function_name: functionName, file_explanation: cached, episode };
  }

  // Fetch patch on demand — never stored in DB
  try {
    const remote = await getRepoOwnerName(workspaceRoot);
    if (!remote) {
      return { sha, file_path: filePath, function_name: null, file_explanation: null, episode };
    }
    const detail = await getCommitDetail(remote.owner, remote.name, sha, cfg.githubToken);
    const fileData = detail.files?.find(f => f.filename === filePath);
    if (!fileData?.patch) {
      return { sha, file_path: filePath, function_name: null, file_explanation: null, episode };
    }

    const { hunk, hunkStart } = extractHunkForLine(fileData.patch, originalLine);

    let explanation: string;
    if (functionName) {
      explanation = await explainFunction(
        filePath, functionName, hunk,
        commit?.message ?? "", prTitle, prBody,
        cfg.geminiApiKey, cfg.geminiModel
      );
    } else if (hunkStart !== null) {
      explanation = await explainHunk(
        filePath, hunk, commit?.message ?? "", prTitle, prBody,
        cfg.geminiApiKey, cfg.geminiModel
      );
    } else {
      return { sha, file_path: filePath, function_name: null, file_explanation: null, episode };
    }

    cacheSet(cacheKey, explanation, db);
    return { sha, file_path: filePath, function_name: functionName, file_explanation: explanation, episode };
  } catch (e) {
    console.error("[GTM] getBlameStory failed:", e);
    return { sha, file_path: filePath, function_name: null, file_explanation: null, episode };
  }
}

// ── In-flight dedup ───────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<BlameStory | null>>();

async function getOrFetch(
  sha: string, filePath: string, originalLine: number,
  functionName: string | null, workspaceRoot: string
): Promise<BlameStory | null> {
  const key = functionName
    ? `${sha}:${filePath}:fn:${functionName}`
    : `${sha}:${filePath}:L:${originalLine}`;
  if (inFlight.has(key)) { return inFlight.get(key)!; }
  const promise = getBlameStory(sha, filePath, originalLine, functionName, workspaceRoot)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// ── Hover content ─────────────────────────────────────────────────────────────

function buildHoverContent(story: BlameStory): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;

  if (story.file_explanation) {
    const title = story.function_name
      ? `Why \`${story.function_name}\` exists`
      : "Why this line exists";
    md.appendMarkdown(`### 🕰 ${title}\n\n${story.file_explanation}\n\n`);
    if (story.episode) {
      const ep = story.episode;
      const meta = [`📅 ${new Date(ep.start_date).toLocaleDateString()}`];
      if (ep.pr_number) { meta.push(`🔀 PR #${ep.pr_number}`); }
      if (ep.issue_number) { meta.push(`🐛 Issue #${ep.issue_number}`); }
      md.appendMarkdown(`---\n*${ep.title} · ${meta.join(" · ")}*`);
    }
    return md;
  }

  if (story.episode) {
    const ep = story.episode;
    md.appendMarkdown(`### 🕰 ${ep.title}\n\n`);
    if (ep.llm_summary) { md.appendMarkdown(`${ep.llm_summary}\n\n`); }
    const meta = [`📅 ${new Date(ep.start_date).toLocaleDateString()}`];
    if (ep.pr_number) { meta.push(`🔀 PR #${ep.pr_number}`); }
    if (ep.issue_number) { meta.push(`🐛 Issue #${ep.issue_number}`); }
    md.appendMarkdown(`*${meta.join(" · ")}*`);
    return md;
  }

  md.appendMarkdown(`**Git Time Machine** — no story found for \`${story.sha.slice(0, 8)}\`.`);
  return md;
}

// ── Hover provider ────────────────────────────────────────────────────────────

class GitTimeMachineHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | null> {
    const cfg = getConfig();
    if (validateConfig(cfg)) { return null; }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return null; }

    const repoId = await resolveRepoId(workspaceRoot, cfg);
    if (!repoId) { return null; } // still indexing

    const [blameInfo, functionName] = await Promise.all([
      getBlameInfo(document.uri.fsPath, position.line + 1, workspaceRoot),
      getEnclosingSymbol(document, position.line),
    ]);
    if (!blameInfo) { return null; }

    const story = await getOrFetch(
      blameInfo.sha, blameInfo.repoRelativePath, blameInfo.originalLine,
      functionName, workspaceRoot
    );
    return story ? new vscode.Hover(buildHoverContent(story)) : null;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdIngestRepo(context: vscode.ExtensionContext) {
  const cfg = getConfig();
  const err = validateConfig(cfg);
  if (err) { vscode.window.showErrorMessage(err); return; }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("Git Time Machine: No workspace folder open.");
    return;
  }

  const remote = await getRepoOwnerName(workspaceRoot);
  if (!remote) {
    vscode.window.showErrorMessage("Git Time Machine: Could not detect GitHub repo from git remote.");
    return;
  }

  // Wipe existing data for this repo so it fully re-ingests
  repoIdCache.delete(workspaceRoot);
  activeIngests.delete(workspaceRoot);
  const db = await getDb(context);
  const existing = dbGet(db, "SELECT id FROM repos WHERE full_name = ?", `${remote.owner}/${remote.name}`);
  if (existing) {
    const id = existing["id"] as number;
    db.run("DELETE FROM episode_members WHERE episode_id IN (SELECT id FROM episodes WHERE repo_id = ?)", [id]);
    db.run("DELETE FROM episodes WHERE repo_id = ?", [id]);
    db.run("DELETE FROM file_changes WHERE commit_id IN (SELECT id FROM commits WHERE repo_id = ?)", [id]);
    db.run("DELETE FROM commits WHERE repo_id = ?", [id]);
    db.run("DELETE FROM pull_requests WHERE repo_id = ?", [id]);
    db.run("DELETE FROM issues WHERE repo_id = ?", [id]);
    db.run("DELETE FROM repos WHERE id = ?", [id]);
    persist();
  }

  const { repoId } = await initAndIngestRepo(db, {
    ...remote,
    githubToken: cfg.githubToken,
    geminiApiKey: cfg.geminiApiKey,
    geminiModel: cfg.geminiModel,
    maxPRs: cfg.maxPRs,
    maxUnlinkedCommits: cfg.maxUnlinkedCommits,
  });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Git Time Machine: Indexing ${remote.owner}/${remote.name}`,
      cancellable: false,
    },
    async (progress) => {
      try {
        await ingestRepo(repoId, db, {
          ...remote,
          githubToken: cfg.githubToken,
          geminiApiKey: cfg.geminiApiKey,
          geminiModel: cfg.geminiModel,
          maxPRs: cfg.maxPRs,
          maxUnlinkedCommits: cfg.maxUnlinkedCommits,
          onProgress: (msg) => progress.report({ message: msg }),
        });
        repoIdCache.set(workspaceRoot, repoId);
        vscode.window.showInformationMessage(
          "Git Time Machine: Indexing complete. Hovers are now active!"
        );
      } catch (e) {
        console.error("[GTM] Manual ingest failed:", e);
        vscode.window.showErrorMessage(`Git Time Machine: Indexing failed — ${e}`);
      }
    }
  );
}

async function cmdClearCache(context: vscode.ExtensionContext) {
  const db = await getDb(context);
  cacheClearAll(db); // clears both L1 memory and L2 SQLite explanations
  persist();
  inFlight.clear();
  vscode.window.showInformationMessage("Git Time Machine: explanation cache cleared.");
}

async function cmdResetData(context: vscode.ExtensionContext) {
  const db = await getDb(context);
  db.run("DELETE FROM episode_members");
  db.run("DELETE FROM episodes");
  db.run("DELETE FROM explanations");
  db.run("DELETE FROM file_changes");
  db.run("DELETE FROM commits");
  db.run("DELETE FROM pull_requests");
  db.run("DELETE FROM issues");
  db.run("DELETE FROM repos");
  persist();
  cacheClearMemory();
  repoIdCache.clear();
  activeIngests.clear();
  inFlight.clear();
  vscode.window.showInformationMessage("Git Time Machine: all data cleared.");
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  _context = context;

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file", pattern: "**/*" },
      new GitTimeMachineHoverProvider()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.ingestRepo",
      () => cmdIngestRepo(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.clearCache",
      () => cmdClearCache(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.resetData",
      () => cmdResetData(context))
  );

  const cfg = getConfig();
  const err = validateConfig(cfg);
  if (err) { vscode.window.showWarningMessage(err); }
}

export function deactivate() {
  closeDb();
}
