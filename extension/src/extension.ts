import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import * as https from "https";
import * as http from "http";

const execAsync = promisify(exec);

// ── Types ────────────────────────────────────────────────────────────────────

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
  function_name: string | null; // resolved symbol name, null if hunk fallback was used
  file_explanation: string | null;
  episode: EpisodeSummary | null;
}

// ── Git blame ────────────────────────────────────────────────────────────────

interface BlameInfo {
  sha: string;
  originalLine: number;
  repoRelativePath: string;
}

async function getBlameInfo(
  filePath: string,
  lineNumber: number
): Promise<BlameInfo | null> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return null; }

    const { stdout } = await execAsync(
      `git blame -L ${lineNumber},${lineNumber} --porcelain "${filePath}"`,
      { cwd: workspaceRoot }
    );

    const firstLine = stdout.split("\n")[0].split(" ");
    const sha = firstLine[0];
    const originalLine = parseInt(firstLine[1], 10);

    if (!sha || sha.length < 7 || isNaN(originalLine)) { return null; }
    if (/^0+$/.test(sha)) { return null; } // uncommitted line

    const repoRelativePath = filePath
      .replace(workspaceRoot, "")
      .replace(/\\/g, "/")
      .replace(/^\//, "");

    return { sha: sha.slice(0, 8), originalLine, repoRelativePath };
  } catch {
    return null;
  }
}

// ── VS Code symbol provider ───────────────────────────────────────────────────

/**
 * Find the deepest symbol (function/method/class) containing the given line.
 *
 * Uses VS Code's built-in executeDocumentSymbolProvider — powered by whatever
 * language server is active (Pylance for Python, etc.). Zero dependencies.
 *
 * Returns the symbol name, or null if:
 *   - The line is in global scope (no enclosing symbol)
 *   - No language server is active for this file type
 *   - The symbol provider returns nothing
 *
 * In all null cases the caller falls back to hunk-based logic.
 */
async function getEnclosingSymbol(
  document: vscode.TextDocument,
  line: number // 0-based
): Promise<string | null> {
  try {
    // executeDocumentSymbolProvider can return either:
    //   DocumentSymbol[]     — has .range and .children (tree structure)
    //   SymbolInformation[]  — has .location.range, no .children (flat list)
    // Pylance may return either depending on version. We handle both.
    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >(
      "vscode.executeDocumentSymbolProvider",
      document.uri
    );

    if (!symbols || symbols.length === 0) { return null; }

    // Only consider symbols that represent logical code blocks.
    // Pylance also exposes parameters and variables as symbols with tiny ranges
    // that would always win the smallest-range sort, giving us parameter names
    // like repo_id instead of the enclosing function name.
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

// ── Backend API call ─────────────────────────────────────────────────────────

function fetchBlameStory(
  backendUrl: string,
  repoId: number,
  sha: string,
  filePath: string,
  originalLine: number,
  functionName: string | null
): Promise<BlameStory | null> {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      sha,
      file_path: filePath,
      original_line: String(originalLine),
    });
    if (functionName) {
      params.set("function_name", functionName);
    }

    const url = `${backendUrl}/files/${repoId}/blame_story?${params.toString()}`;
    const lib = url.startsWith("https") ? https : http;

    lib.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data) as BlameStory); }
          catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    }).on("error", () => resolve(null));
  });
}

// ── Hover content ────────────────────────────────────────────────────────────

function buildHoverContent(story: BlameStory): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;

  if (story.file_explanation) {
    // Show function name in title if we resolved one
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

// ── Cache ─────────────────────────────────────────────────────────────────────
//
// Two cache keys, mirroring the two backend paths:
//
// Function key:  repoId:sha:file:fn:functionName
//   All lines inside the same named function share this entry.
//   Correct because the backend anchored the LLM on that specific function.
//   No bleed: two different functions in the same hunk get different keys.
//
// Hunk key:  repoId:sha:file:hunk:originalLine (set from backend response)
//   Used for global-scope lines where no symbol was found.
//   Falls back gracefully to v0.3.3 behavior.
//
// In-flight map prevents duplicate concurrent requests for the same exact line.

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
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<BlameStory | null> {

  // 1. Function cache hit — fastest path when inside a known symbol
  if (functionName) {
    const fKey = fnKey(repoId, sha, repoRelativePath, functionName);
    if (cache.has(fKey)) { return cache.get(fKey) ?? null; }
  }

  // 2. Exact line cache hit
  const lKey = lineKey(repoId, sha, repoRelativePath, originalLine);
  if (cache.has(lKey)) { return cache.get(lKey) ?? null; }

  // 3. In-flight deduplication for this exact line
  if (inFlight.has(lKey)) { return inFlight.get(lKey)!; }

  // 4. API call
  const promise = fetchBlameStory(
    backendUrl, repoId, sha, repoRelativePath, originalLine, functionName
  ).then((story) => {
    inFlight.delete(lKey);
    cache.set(lKey, story);

    // Also cache under function key if the backend resolved one
    if (story?.function_name) {
      const fKey = fnKey(repoId, sha, repoRelativePath, story.function_name);
      cache.set(fKey, story);
    }

    return story;
  }).catch(() => {
    inFlight.delete(lKey);
    return null;
  });

  inFlight.set(lKey, promise);
  return promise;
}

// ── Hover provider ───────────────────────────────────────────────────────────

class GitTimeMachineHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | null> {
    const config = vscode.workspace.getConfiguration("gitTimeMachine");
    const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");
    const repoId = config.get<number>("repoId", 1);

    // Run git blame and symbol lookup concurrently — both are local, fast
    const [blameInfo, functionName] = await Promise.all([
      getBlameInfo(document.uri.fsPath, position.line + 1),
      getEnclosingSymbol(document, position.line),
    ]);

    if (!blameInfo) { return null; }

    const { sha, originalLine, repoRelativePath } = blameInfo;

    const story = await getOrFetch(
      backendUrl, repoId, sha, repoRelativePath,
      originalLine, functionName,
      document, position
    );

    return story ? new vscode.Hover(buildHoverContent(story)) : null;
  }
}

// ── Activation ───────────────────────────────────────────────────────────────

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
      vscode.window.showInformationMessage("Git Time Machine: cache cleared.");
    })
  );
}

export function deactivate() {}