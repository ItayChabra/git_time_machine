import * as path from "path";
import * as fs from "fs";
import initSqlJs, { Database, SqlValue } from "sql.js";
import * as vscode from "vscode";

const SCHEMA_VERSION = 1;

let _db: Database | null = null;
let _dbPath: string | null = null;

export async function getDb(context: vscode.ExtensionContext): Promise<Database> {
  if (_db) { return _db; }

  const dir = context.storageUri!.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  _dbPath = path.join(dir, "cache.db");

  const wasmPath = path.join(
    context.extensionPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm"
  );
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) as unknown as ArrayBuffer });

  _db = fs.existsSync(_dbPath)
    ? new SQL.Database(fs.readFileSync(_dbPath))
    : new SQL.Database();

  migrate(_db);
  persist();
  return _db;
}

// Debounced persist — collapses rapid-fire write calls during ingest into one
// file write per quiet period. Safe because Node is single-threaded: db.run()
// calls never interleave, only the file write is deferred.
let _persistTimer: NodeJS.Timeout | null = null;

export function persist(): void {
  if (!_db || !_dbPath) { return; }
  if (_persistTimer) { clearTimeout(_persistTimer); }
  _persistTimer = setTimeout(() => {
    if (_db && _dbPath) {
      fs.writeFileSync(_dbPath, Buffer.from(_db.export()));
    }
    _persistTimer = null;
  }, 200);
}

// Synchronous flush — use on shutdown so the final save is never lost
function persistNow(): void {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  if (_db && _dbPath) {
    fs.writeFileSync(_dbPath, Buffer.from(_db.export()));
  }
}

export function closeDb(): void {
  persistNow();
  _db?.close();
  _db = null;
}

function migrate(db: Database): void {
  const results = db.exec("PRAGMA user_version");
  const version = results.length ? (results[0].values[0][0] as number) : 0;
  if (version >= SCHEMA_VERSION) { return; }

  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      owner            TEXT NOT NULL,
      name             TEXT NOT NULL,
      full_name        TEXT UNIQUE NOT NULL,
      default_branch   TEXT NOT NULL DEFAULT 'main',
      status           TEXT NOT NULL DEFAULT 'indexing'
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id   INTEGER NOT NULL REFERENCES repos(id),
      number    INTEGER NOT NULL,
      title     TEXT, body TEXT, state TEXT, merged_at TEXT,
      UNIQUE(repo_id, number)
    );
    CREATE TABLE IF NOT EXISTS commits (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      sha     TEXT UNIQUE NOT NULL,
      author  TEXT, date TEXT NOT NULL, message TEXT,
      pr_id   INTEGER REFERENCES pull_requests(id)
    );
    CREATE TABLE IF NOT EXISTS file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_id INTEGER NOT NULL REFERENCES commits(id),
      file_path TEXT NOT NULL, change_type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      number INTEGER NOT NULL, title TEXT, body TEXT, state TEXT,
      UNIQUE(repo_id, number)
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      title TEXT NOT NULL, start_date TEXT NOT NULL,
      end_date TEXT NOT NULL, llm_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS episode_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL REFERENCES episodes(id),
      commit_id INTEGER REFERENCES commits(id),
      pr_id INTEGER REFERENCES pull_requests(id),
      issue_id INTEGER REFERENCES issues(id),
      member_type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS explanations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT UNIQUE NOT NULL, explanation TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_commits_repo        ON commits(repo_id);
    CREATE INDEX IF NOT EXISTS ix_commits_pr          ON commits(pr_id);
    CREATE INDEX IF NOT EXISTS ix_commits_date        ON commits(date);
    CREATE INDEX IF NOT EXISTS ix_file_changes_commit ON file_changes(commit_id);
    CREATE INDEX IF NOT EXISTS ix_file_changes_path   ON file_changes(file_path);
    CREATE INDEX IF NOT EXISTS ix_ep_members_episode  ON episode_members(episode_id, member_type);
    CREATE INDEX IF NOT EXISTS ix_ep_members_commit   ON episode_members(commit_id);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export type Row = Record<string, SqlValue>;

export function dbGet(db: Database, sql: string, ...params: SqlValue[]): Row | undefined {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? (stmt.getAsObject() as Row) : undefined;
  stmt.free();
  return row;
}

export function dbAll(db: Database, sql: string, ...params: SqlValue[]): Row[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: Row[] = [];
  while (stmt.step()) { rows.push(stmt.getAsObject() as Row); }
  stmt.free();
  return rows;
}

export function dbRun(db: Database, sql: string, ...params: SqlValue[]): void {
  db.run(sql, params);
}

export function dbRunGetId(db: Database, sql: string, ...params: SqlValue[]): number {
  db.run(sql, params);
  const results = db.exec("SELECT last_insert_rowid()");
  return results[0].values[0][0] as number;
}
