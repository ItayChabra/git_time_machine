import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import * as https from "https";
import * as http from "http";
import * as path from "path";

const execAsync = promisify(exec);

// ── Types ─────────────────────────────────────────────────────────────────────

interface EpisodeSummary {
  id: number;
  title: string;
  start_date: string;
  end_date: string;
  llm_summary: string | null;
  pr_number: number | null;
  issue_number: number | null;
}

interface BlameStory {
  sha: string;
  file_path: string | null;
  function_name: string | null;
  file_explanation: string | null;
  episode: EpisodeSummary | null;
}

interface RepoOut {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  status: string;
}

// ── Config helpers ────────────────────────────────────────────────────────────

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("gitTimeMachine");
  return {
    backendUrl: cfg.get<string>("backendUrl", "http://localhost:8000"),
    githubToken: cfg.get<string>("githubToken", ""),
    geminiApiKey: cfg.get<string>("geminiApiKey", ""),
    maxCommits: cfg.get<number>("maxCommits", 200),
    geminiModel: cfg.get<string>("geminiModel", "gemini-3-flash-preview"),
  };
}

function credentialHeaders(cfg: ReturnType<typeof getConfig>): Record<string, string> {
  return {
    "x-github-token": cfg.githubToken,
    "x-gemini-api-key": cfg.geminiApiKey,
    "x-gemini-model": cfg.geminiModel,
    "Content-Type": "application/json",
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

// ── Git remote parsing ────────────────────────────────────────────────────────

function parseGitHubRemote(remoteUrl: string): { owner: string; name: string } | null {
  const httpsMatch = remoteUrl.match(/https?:\/\/github\.com\/([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  if (httpsMatch) { return { owner: httpsMatch[1], name: httpsMatch[2] }; }

  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  if (sshMatch) { return { owner: sshMatch[1], name: sshMatch[2] }; }

  return null;
}

async function getRepoOwnerName(workspaceRoot: string): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await execAsync("git remote -v", { cwd: workspaceRoot });
    const lines = stdout.split("\n").filter(l => l.includes("(fetch)"));

    // Prefer "origin" — works for most users
    const originLine = lines.find(l => l.startsWith("origin\t") || l.startsWith("origin "));
    if (originLine) {
      const url = originLine.split(/\s+/)[1];
      const parsed = parseGitHubRemote(url);
      if (parsed) { return parsed; }
    }

    // Fall back to first GitHub remote found (covers custom remote names)
    for (const line of lines) {
      const url = line.split(/\s+/)[1];
      if (!url) { continue; }
      const parsed = parseGitHubRemote(url);
      if (parsed) { return parsed; }
    }

    return null;
  } catch {
    return null;
  }
}

// ── Repo resolution ───────────────────────────────────────────────────────────

const repoIdCache = new Map<string, number>();

async function resolveRepoId(
  workspaceRoot: string,
  cfg: ReturnType<typeof getConfig>
): Promise<number | null> {
  if (repoIdCache.has(workspaceRoot)) {
    return repoIdCache.get(workspaceRoot)!;
  }

  const parsed = await getRepoOwnerName(workspaceRoot);
  if (!parsed) { return null; }

  const { owner, name } = parsed;
  const headers = credentialHeaders(cfg);

  try {
    const existing = await apiGet<RepoOut>(
      `${cfg.backendUrl}/repos/by-name?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`,
      headers
    );
    if (existing) {
      repoIdCache.set(workspaceRoot, existing.id);
      return existing.id;
    }
  } catch {
    // 404 = not ingested yet, fall through to ingest
  }

  try {
    const created = await apiPost<RepoOut>(
      `${cfg.backendUrl}/repos/`,
      { owner, name, max_commits: cfg.maxCommits },
      headers
    );
    if (created) {
      repoIdCache.set(workspaceRoot, created.id);
      vscode.window.showInformationMessage(
        `Git Time Machine: Indexing ${owner}/${name} (${cfg.maxCommits} commits). Hovers will appear once indexing completes.`
      );
      return created.id;
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Git Time Machine: Failed to ingest repo — ${err}`);
  }

  return null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function apiGet<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data) as T); } catch { resolve(null); }
        } else if (res.statusCode === 404) {
          reject(new Error("404"));
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
  });
}

function apiPost<T>(url: string, body: object, headers: Record<string, string>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const parsed = new URL(url);
    const lib = url.startsWith("https") ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(bodyStr) },
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode < 300) {
          try { resolve(JSON.parse(data) as T); } catch { resolve(null); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Git blame ────────────────────────────────────────────────────────────────

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

    const repoRelativePath = normalizedFile
      .replace(normalizedRoot, "")
      .replace(/^\//, "");

    if (!repoRelativePath || repoRelativePath === normalizedFile) { return null; }

    return { sha, originalLine, repoRelativePath };
  } catch {
    return null;
  }
}

// ── VS Code symbol provider ───────────────────────────────────────────────────

async function getEnclosingSymbol(document: vscode.TextDocument, line: number): Promise<string | null> {
  try {
    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >("vscode.executeDocumentSymbolProvider", document.uri);

    if (!symbols || symbols.length === 0) { return null; }

    const BLOCK_KINDS = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Module,
      vscode.SymbolKind.Namespace,
      vscode.SymbolKind.Constructor,
    ]);

    interface FlatSymbol { name: string; start: number; end: number; }
    const flat: FlatSymbol[] = [];

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

    const matches = flat
      .filter(s => s.start <= line && line <= s.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start));

    return matches[0]?.name ?? null;
  } catch {
    return null;
  }
}

// ── Backend API call ──────────────────────────────────────────────────────────

function fetchBlameStory(
  backendUrl: string,
  repoId: number,
  sha: string,
  filePath: string,
  originalLine: number,
  functionName: string | null,
  headers: Record<string, string>,
): Promise<BlameStory | null> {
  const params = new URLSearchParams({
    sha,
    file_path: filePath,
    original_line: String(originalLine),
  });
  if (functionName) { params.set("function_name", functionName); }

  const url = `${backendUrl}/files/${repoId}/blame_story?${params.toString()}`;
  return apiGet<BlameStory>(url, headers).catch(() => null);
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
    md.appendMarkdown(`### 🕰 ${title}\n\n`);
    md.appendMarkdown(`${story.file_explanation}\n\n`);
    if (story.episode) {
      const ep = story.episode;
      const date = new Date(ep.start_date).toLocaleDateString();
      const meta: string[] = [`📅 ${date}`];
      if (ep.pr_number) { meta.push(`🔀 PR #${ep.pr_number}`); }
      if (ep.issue_number) { meta.push(`🐛 Issue #${ep.issue_number}`); }
      md.appendMarkdown(`---\n*${ep.title} · ${meta.join(" · ")}*`);
    }
    return md;
  }

  if (story.episode) {
    const ep = story.episode;
    const date = new Date(ep.start_date).toLocaleDateString();
    md.appendMarkdown(`### 🕰 ${ep.title}\n\n`);
    if (ep.llm_summary) { md.appendMarkdown(`${ep.llm_summary}\n\n`); }
    const meta: string[] = [`📅 ${date}`];
    if (ep.pr_number) { meta.push(`🔀 PR #${ep.pr_number}`); }
    if (ep.issue_number) { meta.push(`🐛 Issue #${ep.issue_number}`); }
    md.appendMarkdown(`*${meta.join(" · ")}*`);
    return md;
  }

  md.appendMarkdown(`**Git Time Machine** — no story found for \`${story.sha.slice(0, 8)}\`.`);
  return md;
}

// ── In-process cache ──────────────────────────────────────────────────────────

const cache = new Map<string, BlameStory | null>();
const inFlight = new Map<string, Promise<BlameStory | null>>();

function fnKey(repoId: number, sha: string, file: string, fn: string): string {
  return `${repoId}:${sha}:${file}:fn:${fn}`;
}
function lineKey(repoId: number, sha: string, file: string, line: number): string {
  return `${repoId}:${sha}:${file}:L:${line}`;
}

async function getOrFetch(
  backendUrl: string,
  repoId: number,
  sha: string,
  repoRelativePath: string,
  originalLine: number,
  functionName: string | null,
  headers: Record<string, string>,
): Promise<BlameStory | null> {
  if (functionName) {
    const fKey = fnKey(repoId, sha, repoRelativePath, functionName);
    if (cache.has(fKey)) { return cache.get(fKey) ?? null; }
  }

  const lKey = lineKey(repoId, sha, repoRelativePath, originalLine);
  if (cache.has(lKey)) { return cache.get(lKey) ?? null; }
  if (inFlight.has(lKey)) { return inFlight.get(lKey)!; }

  const promise = fetchBlameStory(
    backendUrl, repoId, sha, repoRelativePath, originalLine, functionName, headers
  ).then((story) => {
    inFlight.delete(lKey);
    cache.set(lKey, story);
    if (story?.function_name) {
      cache.set(fnKey(repoId, sha, repoRelativePath, story.function_name), story);
    }
    return story;
  }).catch(() => {
    inFlight.delete(lKey);
    return null;
  });

  inFlight.set(lKey, promise);
  return promise;
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

    const [blameInfo, functionName] = await Promise.all([
      getBlameInfo(document.uri.fsPath, position.line + 1, workspaceRoot),
      getEnclosingSymbol(document, position.line),
    ]);

    if (!blameInfo) { return null; }

    const repoId = await resolveRepoId(workspaceRoot, cfg);
    if (!repoId) { return null; }

    const { sha, originalLine, repoRelativePath } = blameInfo;
    const story = await getOrFetch(
      cfg.backendUrl, repoId, sha, repoRelativePath,
      originalLine, functionName, credentialHeaders(cfg),
    );

    return story ? new vscode.Hover(buildHoverContent(story)) : null;
  }
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file", pattern: "**/*" },
      new GitTimeMachineHoverProvider()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.clearCache", () => {
      cache.clear();
      inFlight.clear();
      repoIdCache.clear();
      vscode.window.showInformationMessage("Git Time Machine: cache cleared.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimeMachine.ingestRepo", async () => {
      const cfg = getConfig();
      const error = validateConfig(cfg);
      if (error) { vscode.window.showErrorMessage(error); return; }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("Git Time Machine: No workspace folder open.");
        return;
      }

      repoIdCache.delete(workspaceRoot);
      const repoId = await resolveRepoId(workspaceRoot, cfg);
      if (!repoId) {
        vscode.window.showErrorMessage("Git Time Machine: Could not detect GitHub repo from git remote.");
      }
    })
  );

  const cfg = getConfig();
  const error = validateConfig(cfg);
  if (error) {
    vscode.window.showWarningMessage(error);
  }
}

export function deactivate() {}