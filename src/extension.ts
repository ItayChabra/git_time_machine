import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { Database } from "sql.js";
import { getDb, closeDb, persist, dbGet, dbRun } from "./db";
import { initAndIngestRepo, ingestRepo } from "./ingest";
import { episodeForCommit } from "./episodes";
import { cacheGet, cacheSet, cacheClearMemory, cacheClearAll } from "./cache";
import { explainFunction, explainHunk } from "./llm";

const execAsync = promisify(exec);

// Bump this whenever the prompt or explanation format changes significantly.
// Old cache keys (different version prefix) will be purged on activation.
const CACHE_VERSION = "v2";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Config {
  githubToken: string;
  geminiApiKey: string;
  geminiModel: string;
  maxPRs: number;
  maxUnlinkedCommits: number;
  maxIssues: number;
}

// ── State ─────────────────────────────────────────────────────────────────────

let _context: vscode.ExtensionContext | null = null;
let _statusBar: vscode.StatusBarItem | null = null;

const repoIdCache = new Map<string, number>();
const activeIngests = new Map<string, Promise<void>>();
const onboardingPrompted = new Set<string>();
const inFlight = new Map<string, Promise<BlameStory | null>>();

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatus(text: string, tooltip = ""): void {
  if (!_statusBar) { return; }
  _statusBar.text = text;
  _statusBar.tooltip = tooltip;
  _statusBar.show();
}

// ── Config ────────────────────────────────────────────────────────────────────

async function getConfig(): Promise<Config> {
  if (!_context) { throw new Error("[GTM] Extension not activated"); }
  const cfg = vscode.workspace.getConfiguration("gitTimeMachine");
  const secrets = _context.secrets;

  let githubToken = (await secrets.get("gtm.githubToken")) ?? "";
  let geminiApiKey = (await secrets.get("gtm.geminiApiKey")) ?? "";

  // One-time migration: move keys from plain settings → SecretStorage
  if (!githubToken) {
    const legacy = cfg.get<string>("githubToken", "");
    if (legacy) {
      await secrets.store("gtm.githubToken", legacy);
      await cfg.update("githubToken", "", vscode.ConfigurationTarget.Global);
      githubToken = legacy;
    }
  }
  if (!geminiApiKey) {
    const legacy = cfg.get<string>("geminiApiKey", "");
    if (legacy) {
      await secrets.store("gtm.geminiApiKey", legacy);
      await cfg.update("geminiApiKey", "", vscode.ConfigurationTarget.Global);
      geminiApiKey = legacy;
    }
  }

  return {
    githubToken,
    geminiApiKey,
    geminiModel: cfg.get<string>("geminiModel", "gemini-2.0-flash"),
    maxPRs: cfg.get<number>("maxPRs", 50),
    maxUnlinkedCommits: cfg.get<number>("maxUnlinkedCommits", 50),
    maxIssues: cfg.get<number>("maxIssues", 200),
  };
}

function validateConfig(cfg: Config): string | null {
  if (!cfg.githubToken) {
    return 'Git Time Machine: GitHub token not set. Run "Git Time Machine: Set GitHub Token" from the command palette.';
  }
  if (!cfg.geminiApiKey) {
    return 'Git Time Machine: Gemini API key not set. Run "Git Time Machine: Set Gemini API Key" from the command palette.';
  }
  return null;
}

// ── Cache maintenance ─────────────────────────────────────────────────────────

/**
 * Purges explanation rows whose cache_key does not start with the current
 * CACHE_VERSION prefix. Runs once at startup so stale entries from old prompt
 * versions don't accumulate indefinitely.
 */
function purgeOldCacheEntries(db: Database): void {
  try {
    db.run(
      `DELETE FROM explanations WHERE
         cache_key NOT LIKE 'fn:${CACHE_VERSION}:%'
         AND cache_key NOT LIKE 'hunk:${CACHE_VERSION}:%'`
    );
    persist();
  } catch (e) {
    console.error("[GTM] Cache purge failed:", e);
  }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function parseGitHubRemote(url: string): { owner: string; name: string } | null {
  const h = url.match(/https?:\/\/github\.com\/([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  if (h) { return { owner: h[1], name: h[2] }; }
  const s = url.match(/git@github\.com:([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  if (s) { return { owner: s[1], name: s[2] }; }
  return null;
}

async function getRepoOwnerName(
  workspaceRoot: string
): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await execAsync("git remote -v", { cwd: workspaceRoot });
    const lines = stdout.split("\n").filter((l) => l.includes("(fetch)"));
    const originLine = lines.find(
      (l) => l.startsWith("origin\t") || l.startsWith("origin ")
    );
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

/**
 * Returns the workspace folder that contains the given file, or falls back to
 * the first folder. Handles multi-root workspaces correctly.
 */
function getWorkspaceRootForFile(filePath: string): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { return null; }
  const normalized = filePath.split(path.sep).join("/");
  let best: vscode.WorkspaceFolder | null = null;
  let bestLen = 0;
  for (const folder of folders) {
    const fp = folder.uri.fsPath.split(path.sep).join("/");
    if (normalized.startsWith(fp + "/") && fp.length > bestLen) {
      best = folder;
      bestLen = fp.length;
    }
  }
  return (best ?? folders[0]).uri.fsPath;
}

interface BlameInfo {
  sha: string;
  originalLine: number;
  repoRelativePath: string;
}

async function getBlameInfo(
  filePath: string,
  lineNumber: number,
  workspaceRoot: string
): Promise<BlameInfo | null> {
  try {
    const repoRelativePath = path
      .relative(workspaceRoot, filePath)
      .split(path.sep)
      .join("/");

    if (!repoRelativePath || repoRelativePath.startsWith("..")) { return null; }

    const { stdout } = await execAsync(
      `git blame -L ${lineNumber},${lineNumber} --porcelain -- "${repoRelativePath}"`,
      { cwd: workspaceRoot }
    );

    const firstLine = stdout.split("\n")[0].split(" ");
    const sha = firstLine[0];
    const originalLine = parseInt(firstLine[1], 10);

    if (!sha || sha.length < 7 || isNaN(originalLine)) { return null; }
    if (/^0+$/.test(sha)) { return null; } // uncommitted line

    return { sha, originalLine, repoRelativePath };
  } catch (e) {
    console.error("[GTM] git blame failed:", e);
    return null;
  }
}

/**
 * Fetches the diff for a specific file in a commit using the local git repo.
 * Used as a fallback for hunk-level explanations and when live source lookup fails.
 */
async function getPatchForFile(
  sha: string,
  repoRelativePath: string,
  workspaceRoot: string
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `git show --no-color "${sha}" -- "${repoRelativePath}"`,
      { cwd: workspaceRoot }
    );
    if (!stdout.trim()) { return null; }
    const lines = stdout.split("\n");
    const diffStart = lines.findIndex((l) => l.startsWith("diff --git"));
    if (diffStart !== -1) { return lines.slice(diffStart).join("\n"); }
    const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
    return hunkStart !== -1 ? lines.slice(hunkStart).join("\n") : null;
  } catch { return null; }
}

// ── Live source extraction ────────────────────────────────────────────────────

/**
 * Reads the full current source text of a named symbol from the live editor.
 * Preferred input for function-level explanations — gives Gemini the complete
 * picture of what the function does right now, not a 3-line diff from weeks ago.
 *
 * Returns null if the symbol can't be found (language server unavailable, file
 * not on disk, etc.) — callers fall back to the diff hunk in that case.
 */
async function getLiveSourceForSymbol(
  filePath: string,
  functionName: string,
  workspaceRoot: string
): Promise<string | null> {
  try {
    const absPath = path.join(workspaceRoot, filePath.split("/").join(path.sep));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      doc.uri
    );
    if (!symbols?.length) { return null; }

    const flat: vscode.DocumentSymbol[] = [];
    const collect = (syms: vscode.DocumentSymbol[]) => {
      for (const s of syms) {
        flat.push(s);
        if (s.children?.length) { collect(s.children); }
      }
    };
    collect(symbols);

    const sym = flat.find((s) => s.name === functionName);
    return sym ? doc.getText(sym.range) : null;
  } catch {
    return null;
  }
}

// ── Symbol cache ──────────────────────────────────────────────────────────────
// Caches the full symbol list per (document URI, document version) so we only
// call executeDocumentSymbolProvider once per edit, not once per hover.

interface SymbolEntry {
  version: number;
  flat: Array<{ name: string; start: number; end: number }>;
}
const symbolCache = new Map<string, SymbolEntry>();

const BLOCK_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Constructor,
]);

async function getEnclosingSymbol(
  document: vscode.TextDocument,
  line: number
): Promise<string | null> {
  const uri = document.uri.toString();
  let entry = symbolCache.get(uri);

  if (!entry || entry.version !== document.version) {
    const flat: Array<{ name: string; start: number; end: number }> = [];
    try {
      const symbols = await vscode.commands.executeCommand<
        (vscode.DocumentSymbol | vscode.SymbolInformation)[]
      >("vscode.executeDocumentSymbolProvider", document.uri);

      function collect(syms: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) {
        for (const sym of syms) {
          if ("range" in sym) {
            if (BLOCK_KINDS.has(sym.kind)) {
              flat.push({ name: sym.name, start: sym.range.start.line, end: sym.range.end.line });
            }
            if (sym.children?.length) { collect(sym.children); }
          } else if ("location" in sym) {
            if (BLOCK_KINDS.has(sym.kind)) {
              flat.push({
                name: sym.name,
                start: sym.location.range.start.line,
                end: sym.location.range.end.line,
              });
            }
          }
        }
      }
      collect(symbols ?? []);
    } catch { /* language server unavailable */ }

    entry = { version: document.version, flat };
    symbolCache.set(uri, entry);

    if (symbolCache.size > 50) {
      const firstKey = symbolCache.keys().next().value;
      if (firstKey) { symbolCache.delete(firstKey); }
    }
  }

  return (
    entry.flat
      .filter((s) => s.start <= line && line <= s.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0]?.name ?? null
  );
}

// ── Hunk extraction ───────────────────────────────────────────────────────────

function extractHunkForLine(
  patch: string,
  originalLine: number
): { hunk: string; hunkStart: number | null } {
  if (!patch) { return { hunk: patch, hunkStart: null }; }
  const hunks: { start: number; count: number; lines: string[] }[] = [];
  let current: { start: number; count: number; lines: string[] } | null = null;
  for (const line of patch.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (m) {
      if (current) { hunks.push(current); }
      current = { start: parseInt(m[1]), count: parseInt(m[2] ?? "1"), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) { hunks.push(current); }

  // Exact match first
  for (const h of hunks) {
    if (h.start <= originalLine && originalLine <= h.start + h.count) {
      return { hunk: h.lines.join("\n"), hunkStart: h.start };
    }
  }

  // No exact match — return the closest hunk instead of dumping the whole patch
  if (hunks.length > 0) {
    const closest = hunks.reduce((a, b) =>
      Math.abs(a.start - originalLine) <= Math.abs(b.start - originalLine) ? a : b
    );
    return { hunk: closest.lines.join("\n"), hunkStart: closest.start };
  }

  return { hunk: patch, hunkStart: null };
}

// ── Ingest helper ─────────────────────────────────────────────────────────────

function startIngest(
  repoId: number,
  remote: { owner: string; name: string },
  workspaceRoot: string,
  db: Database,
  cfg: Config
): void {
  if (activeIngests.has(workspaceRoot)) { return; }

  setStatus(
    "$(sync~spin) GTM: Indexing...",
    `Indexing ${remote.owner}/${remote.name} — click to re-index`
  );

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
          maxIssues: cfg.maxIssues,
          onProgress: (msg) => progress.report({ message: msg }),
        });
        repoIdCache.set(workspaceRoot, repoId);
        setStatus("$(git-commit) GTM: Ready", "Git Time Machine — click to re-index");
        vscode.window.showInformationMessage(
          "Git Time Machine: Indexing complete. Hovers are now active!"
        );
      } catch (e) {
        console.error("[GTM] Ingestion failed:", e);
        dbRun(db, "UPDATE repos SET status = 'error' WHERE id = ?", repoId);
        persist();
        setStatus("$(error) GTM: Error", `Indexing failed — ${e}`);
        vscode.window.showErrorMessage(`Git Time Machine: Indexing failed — ${e}`);
      }
    }
  ) as Promise<void>;

  ingestPromise.finally(() => activeIngests.delete(workspaceRoot));
  activeIngests.set(workspaceRoot, ingestPromise);
}

// ── Repo resolution ───────────────────────────────────────────────────────────

async function resolveRepoId(
  workspaceRoot: string,
  cfg: Config
): Promise<number | null> {
  const cached = repoIdCache.get(workspaceRoot);
  if (cached !== undefined) { return cached; }
  if (!_context) { return null; }
  if (activeIngests.has(workspaceRoot)) { return null; }

  const db = await getDb(_context);
  const remote = await getRepoOwnerName(workspaceRoot);
  if (!remote) { return null; }

  const existing = dbGet(
    db,
    "SELECT id, status FROM repos WHERE full_name = ?",
    `${remote.owner}/${remote.name}`
  );

  if (existing) {
    const repoId = existing["id"] as number;
    const status = existing["status"] as string;
    if (status === "ready") {
      repoIdCache.set(workspaceRoot, repoId);
      setStatus("$(git-commit) GTM: Ready", "Git Time Machine — click to re-index");
      return repoId;
    }
    dbRun(db, "UPDATE repos SET status = 'indexing' WHERE id = ?", repoId);
    persist();
    startIngest(repoId, remote, workspaceRoot, db, cfg);
    return null;
  }

  if (onboardingPrompted.has(workspaceRoot)) { return null; }
  onboardingPrompted.add(workspaceRoot);

  const choice = await vscode.window.showInformationMessage(
    `Git Time Machine: Index ${remote.owner}/${remote.name}? ` +
      "This fetches your PR history and generates AI hover explanations.",
    "Index Now",
    "Not Now"
  );
  if (choice !== "Index Now") { return null; }

  try {
    const { repoId } = await initAndIngestRepo(db, {
      ...remote,
      githubToken: cfg.githubToken,
      geminiApiKey: cfg.geminiApiKey,
      geminiModel: cfg.geminiModel,
      maxPRs: cfg.maxPRs,
      maxUnlinkedCommits: cfg.maxUnlinkedCommits,
      maxIssues: cfg.maxIssues,
    });
    startIngest(repoId, remote, workspaceRoot, db, cfg);
  } catch (e) {
    vscode.window.showErrorMessage(`Git Time Machine: Failed to initialize repo — ${e}`);
  }

  return null;
}

// ── Blame story ───────────────────────────────────────────────────────────────

interface BlameStory {
  sha: string;
  file_path: string | null;
  function_name: string | null;
  file_explanation: string | null;
  episode: {
    id: number;
    title: string;
    start_date: string;
    end_date: string;
    llm_summary: string | null;
    pr_number: number | null;
    issue_number: number | null;
  } | null;
}

async function getBlameStory(
  sha: string,
  filePath: string,
  originalLine: number,
  functionName: string | null,
  workspaceRoot: string
): Promise<BlameStory | null> {
  if (!_context) { return null; }
  const cfg = await getConfig();
  const db = await getDb(_context);

  const commit = dbGet(db, "SELECT id, message, pr_id FROM commits WHERE sha = ?", sha) as
    | { id: number; message: string | null; pr_id: number | null }
    | undefined;

  const episode = commit ? episodeForCommit(commit.id, db) : null;

  let prTitle: string | null = null;
  let prBody: string | null = null;
  if (commit?.pr_id) {
    const pr = dbGet(db, "SELECT title, body FROM pull_requests WHERE id = ?", commit.pr_id) as
      | { title: string | null; body: string | null }
      | undefined;
    prTitle = pr?.title ?? null;
    prBody = pr?.body ?? null;
  }

  const cacheKey = functionName
    ? `fn:${CACHE_VERSION}:${sha}:${filePath}:${functionName}`
    : `hunk:${CACHE_VERSION}:${sha}:${filePath}:${originalLine}`;

  const cached = cacheGet(cacheKey, db);
  if (cached) {
    return { sha, file_path: filePath, function_name: functionName, file_explanation: cached, episode };
  }

  try {
    let explanation: string;

    if (functionName) {
      // Preferred: feed Gemini the full live source of the function so it can
      // describe what it actually does, not guess from a 3-line diff.
      const liveSource = await getLiveSourceForSymbol(filePath, functionName, workspaceRoot);
      if (liveSource) {
        explanation = await explainFunction(
          filePath, functionName, liveSource,
          commit?.message ?? "", prTitle, prBody,
          cfg.geminiApiKey, cfg.geminiModel,
          true // isLiveSource
        );
      } else {
        // Fallback: no language server — use the diff hunk
        const patch = await getPatchForFile(sha, filePath, workspaceRoot);
        if (!patch) {
          return { sha, file_path: filePath, function_name: null, file_explanation: null, episode };
        }
        const { hunk } = extractHunkForLine(patch, originalLine);
        explanation = await explainFunction(
          filePath, functionName, hunk,
          commit?.message ?? "", prTitle, prBody,
          cfg.geminiApiKey, cfg.geminiModel,
          false // isLiveSource
        );
      }
    } else {
      // No enclosing function — hunk-level explanation using the diff
      const patch = await getPatchForFile(sha, filePath, workspaceRoot);
      if (!patch) {
        return { sha, file_path: filePath, function_name: null, file_explanation: null, episode };
      }
      const { hunk, hunkStart } = extractHunkForLine(patch, originalLine);
      if (hunkStart === null) {
        return { sha, file_path: filePath, function_name: null, file_explanation: null, episode };
      }
      explanation = await explainHunk(
        filePath, hunk,
        commit?.message ?? "", prTitle, prBody,
        cfg.geminiApiKey, cfg.geminiModel
      );
    }

    // Don't cache transient errors — let the next hover retry cleanly
    if (!explanation.startsWith("Error:") && !explanation.startsWith("Explanation failed")) {
      cacheSet(cacheKey, explanation, db);
    }

    return { sha, file_path: filePath, function_name: functionName, file_explanation: explanation, episode };
  } catch (e) {
    console.error("[GTM] getBlameStory failed:", e);
    return { sha, file_path: filePath, function_name: null, file_explanation: null, episode };
  }
}

// ── In-flight dedup ───────────────────────────────────────────────────────────

async function getOrFetch(
  sha: string,
  filePath: string,
  originalLine: number,
  functionName: string | null,
  workspaceRoot: string
): Promise<BlameStory | null> {
  const key = functionName
    ? `${sha}:${filePath}:fn:${functionName}`
    : `${sha}:${filePath}:L:${originalLine}`;
  if (inFlight.has(key)) { return inFlight.get(key)!; }
  const promise = getBlameStory(sha, filePath, originalLine, functionName, workspaceRoot).finally(
    () => inFlight.delete(key)
  );
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

  md.appendMarkdown(
    `**Git Time Machine** — no story found for \`${story.sha.slice(0, 8)}\`.`
  );
  return md;
}

// ── Hover provider ────────────────────────────────────────────────────────────

const SKIP_LANGUAGE_IDS = new Set(["plaintext", "log", "csv", "tsv"]);

class GitTimeMachineHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    if (SKIP_LANGUAGE_IDS.has(document.languageId)) { return null; }

    const cfg = await getConfig();
    if (token.isCancellationRequested) { return null; }
    if (validateConfig(cfg)) { return null; }

    const workspaceRoot = getWorkspaceRootForFile(document.uri.fsPath);
    if (!workspaceRoot) { return null; }

    const repoId = await resolveRepoId(workspaceRoot, cfg);
    if (token.isCancellationRequested) { return null; }

    if (!repoId) {
      if (activeIngests.has(workspaceRoot)) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(
          "⏳ **Git Time Machine** is indexing your repo — explanations will appear when done."
        );
        return new vscode.Hover(md);
      }
      return null;
    }

    const [blameInfo, functionName] = await Promise.all([
      getBlameInfo(document.uri.fsPath, position.line + 1, workspaceRoot),
      getEnclosingSymbol(document, position.line),
    ]);
    if (token.isCancellationRequested) { return null; }
    if (!blameInfo) { return null; }

    const story = await getOrFetch(
      blameInfo.sha,
      blameInfo.repoRelativePath,
      blameInfo.originalLine,
      functionName,
      workspaceRoot
    );
    if (token.isCancellationRequested) { return null; }
    return story ? new vscode.Hover(buildHoverContent(story)) : null;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdSetGithubToken(context: vscode.ExtensionContext) {
  const token = await vscode.window.showInputBox({
    prompt: "Enter your GitHub personal access token (needs repo read scope)",
    password: true,
    placeHolder: "ghp_...",
    ignoreFocusOut: true,
  });
  if (token !== undefined) {
    await context.secrets.store("gtm.githubToken", token);
    vscode.window.showInformationMessage("Git Time Machine: GitHub token saved securely ✓");
  }
}

async function cmdSetGeminiApiKey(context: vscode.ExtensionContext) {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your Google Gemini API key",
    password: true,
    ignoreFocusOut: true,
  });
  if (key !== undefined) {
    await context.secrets.store("gtm.geminiApiKey", key);
    vscode.window.showInformationMessage("Git Time Machine: Gemini API key saved securely ✓");
  }
}

async function cmdIngestRepo(context: vscode.ExtensionContext) {
  const cfg = await getConfig();
  const err = validateConfig(cfg);
  if (err) {
    vscode.window.showErrorMessage(err);
    return;
  }

  // FIX: Detect the correct workspace folder based on the active file
  // This prevents indexing the wrong repo in multi-root workspaces.
  let workspaceRoot: string | undefined;
  const activeEditor = vscode.window.activeTextEditor;

  if (activeEditor) {
    workspaceRoot = getWorkspaceRootForFile(activeEditor.document.uri.fsPath) ?? undefined;
  } else {
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  if (!workspaceRoot) {
    vscode.window.showErrorMessage("Git Time Machine: No workspace folder found to index.");
    return;
  }

  // PREVENT DOUBLE-INDEXING: Don't start if we are already busy
  if (activeIngests.has(workspaceRoot)) {
    vscode.window.showInformationMessage("Git Time Machine: Indexing is already in progress for this folder.");
    return;
  }

  const remote = await getRepoOwnerName(workspaceRoot);
  if (!remote) {
    vscode.window.showErrorMessage("Git Time Machine: Could not detect a GitHub repo from git remote.");
    return;
  }

  const db = await getDb(context);
  const fullName = `${remote.owner}/${remote.name}`;
  const existing = dbGet(db, "SELECT id FROM repos WHERE full_name = ?", fullName);

  // CLEANUP: If re-indexing, purge old data to ensure a clean slate
  if (existing) {
    const id = existing["id"] as number;
    
    // We wrap these in a try/catch just in case the DB is locked
    try {
      db.run("DELETE FROM episode_members WHERE episode_id IN (SELECT id FROM episodes WHERE repo_id = ?)", [id]);
      db.run("DELETE FROM episodes WHERE repo_id = ?", [id]);
      db.run("DELETE FROM explanations WHERE cache_key LIKE 'fn:%' OR cache_key LIKE 'hunk:%'"); // Optional: clear AI cache on full re-index
      db.run("DELETE FROM file_changes WHERE commit_id IN (SELECT id FROM commits WHERE repo_id = ?)", [id]);
      db.run("DELETE FROM commits WHERE repo_id = ?", [id]);
      db.run("DELETE FROM pull_requests WHERE repo_id = ?", [id]);
      db.run("DELETE FROM issues WHERE repo_id = ?", [id]);
      db.run("DELETE FROM repos WHERE id = ?", [id]);
      persist();
    } catch (e) {
      console.error("[GTM] Failed to purge old repo data:", e);
    }
  }

  // RESET LOCAL STATE
  repoIdCache.delete(workspaceRoot);
  activeIngests.delete(workspaceRoot);
  onboardingPrompted.delete(workspaceRoot);

  try {
    const { repoId } = await initAndIngestRepo(db, {
      ...remote,
      githubToken: cfg.githubToken,
      geminiApiKey: cfg.geminiApiKey,
      geminiModel: cfg.geminiModel,
      maxPRs: cfg.maxPRs,
      maxUnlinkedCommits: cfg.maxUnlinkedCommits,
      maxIssues: cfg.maxIssues,
    });
    
    startIngest(repoId, remote, workspaceRoot, db, cfg);
  } catch (e) {
    vscode.window.showErrorMessage(`Git Time Machine: Failed to start indexing — ${e}`);
  }
}

async function cmdClearCache(context: vscode.ExtensionContext) {
  const db = await getDb(context);
  cacheClearAll(db);
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
  onboardingPrompted.clear();
  inFlight.clear();
  symbolCache.clear();
  setStatus("$(git-commit) GTM", "Git Time Machine — click to index");
  vscode.window.showInformationMessage("Git Time Machine: all data cleared.");
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  _context = context;

  _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  _statusBar.command = "gitTimeMachine.ingestRepo";
  _statusBar.text = "$(git-commit) GTM";
  _statusBar.tooltip = "Git Time Machine — click to index";
  _statusBar.show();
  context.subscriptions.push(_statusBar);

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file", pattern: "**/*" },
      new GitTimeMachineHoverProvider()
    )
  );

  // Purge stale cache entries from old prompt versions on startup.
  // Runs async and silently — never blocks activation.
  getDb(context).then((db) => purgeOldCacheEntries(db)).catch(() => {});

  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.setGithubToken", () => cmdSetGithubToken(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.setGeminiApiKey", () => cmdSetGeminiApiKey(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.ingestRepo", () => cmdIngestRepo(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.clearCache", () => cmdClearCache(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.resetData", () => cmdResetData(context))
  );

  getConfig().then((cfg) => {
    const err = validateConfig(cfg);
    if (err) { vscode.window.showWarningMessage(err); }
  });
}

export function deactivate() {
  closeDb();
}