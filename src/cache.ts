import { Database } from "sql.js";
import { dbGet, dbRun } from "./db";

// L1 in-memory cache to avoid DB round-trips on repeated hovers
const _mem = new Map<string, string>();

export function cacheGet(key: string, db: Database): string | null {
  const hit = _mem.get(key);
  if (hit !== undefined) { return hit; }
  const row = dbGet(db, "SELECT explanation FROM explanations WHERE cache_key = ?", key);
  if (row) {
    const val = row["explanation"] as string;
    _mem.set(key, val);
    return val;
  }
  return null;
}

export function cacheSet(key: string, value: string, db: Database): void {
  _mem.set(key, value);
  dbRun(db, "INSERT OR IGNORE INTO explanations (cache_key, explanation) VALUES (?, ?)", key, value);
}

export function cacheClearMemory(): void {
  _mem.clear();
}

export function cacheClearAll(db: Database): void {
  _mem.clear();
  db.run("DELETE FROM explanations");
}