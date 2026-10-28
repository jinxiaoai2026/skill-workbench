import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
export interface DB {
  all<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const schema = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,payload TEXT NOT NULL,device_id TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_versions(skill_id TEXT NOT NULL,version TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(skill_id,version));
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pairings(code_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,payload TEXT NOT NULL,received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invocations(device_id TEXT NOT NULL,invocation_id TEXT NOT NULL,skill_id TEXT NOT NULL,evidence TEXT NOT NULL,source TEXT NOT NULL,started_at TEXT,ended_at TEXT,status TEXT NOT NULL,version TEXT,PRIMARY KEY(device_id,invocation_id));
CREATE INDEX IF NOT EXISTS invocations_started ON invocations(started_at);
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,source TEXT NOT NULL,period TEXT NOT NULL,collected_at TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(collected_at);
CREATE TABLE IF NOT EXISTS repositories(full_name TEXT PRIMARY KEY,payload TEXT NOT NULL,fetched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookmarks(repo_id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,period TEXT NOT NULL,from_day TEXT NOT NULL,to_day TEXT NOT NULL,algorithm TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_runs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,status TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_locks(key TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repo_explanations(full_name TEXT PRIMARY KEY,source_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repo_explanation_versions(full_name TEXT NOT NULL,source_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(full_name,source_hash));
CREATE TABLE IF NOT EXISTS explanation_requests(full_name TEXT NOT NULL,source_hash TEXT NOT NULL,payload TEXT NOT NULL,requested_at TEXT NOT NULL,PRIMARY KEY(full_name,source_hash));
CREATE TABLE IF NOT EXISTS skill_catalogs(full_name TEXT PRIMARY KEY,payload TEXT NOT NULL,checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_manifests(full_name TEXT NOT NULL,ref TEXT NOT NULL,skill_path TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(full_name,ref,skill_path));
CREATE TABLE IF NOT EXISTS install_jobs(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,full_name TEXT NOT NULL,skill_path TEXT NOT NULL,ref TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lease_until TEXT);
CREATE INDEX IF NOT EXISTS install_jobs_device ON install_jobs(device_id,status,created_at);
CREATE TABLE IF NOT EXISTS installed_skills(device_id TEXT NOT NULL,full_name TEXT NOT NULL,skill_path TEXT NOT NULL,ref TEXT NOT NULL,name TEXT NOT NULL,manifest_hash TEXT,installed_at TEXT NOT NULL,PRIMARY KEY(device_id,full_name,skill_path));
CREATE TABLE IF NOT EXISTS skill_aliases(device_id TEXT NOT NULL,full_name TEXT NOT NULL,skill_path TEXT NOT NULL,custom_name TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(device_id,full_name,skill_path));
CREATE TABLE IF NOT EXISTS skill_name_jobs(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,skill_id TEXT NOT NULL,launch_name TEXT NOT NULL,source_version TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,attempt_token TEXT,lease_until TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS skill_name_jobs_device ON skill_name_jobs(device_id,status,created_at);
`;
export async function openDB(
  location = process.env.DATABASE_URL || ".local/workbench.sqlite",
): Promise<DB> {
  let raw: DB;
  if (location.startsWith("postgres")) {
    const pool = new pg.Pool({ connectionString: location, max: 5 });
    const wrap = (
      query: (sql: string, p: unknown[]) => Promise<any>,
      close: () => Promise<void>,
    ): DB => ({
      all: async (sql, params = []) => {
        let i = 0;
        return (
          await query(
            sql.replace(/\?/g, () => "$" + ++i),
            params,
          )
        ).rows;
      },
      get: async function (sql, params = []) {
        return (await this.all(sql, params))[0];
      },
      run: async function (sql, params = []) {
        await this.all(sql, params);
      },
      transaction: async (fn) => {
        const c = await pool.connect();
        const tx = wrap(
          (s, p) => c.query(s, p),
          async () => {},
        );
        try {
          await c.query("BEGIN");
          const result = await fn(tx);
          await c.query("COMMIT");
          return result;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
      close,
    });
    raw = wrap(
      (s, p) => pool.query(s, p),
      () => pool.end(),
    );
  } else {
    if (location !== ":memory:")
      mkdirSync(dirname(location), { recursive: true, mode: 0o700 });
    const sqlite = new DatabaseSync(location);
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;");
    raw = {
      all: async (sql, params = []) =>
        sqlite.prepare(sql).all(...(params as any[])) as any[],
      get: async (sql, params = []) =>
        sqlite.prepare(sql).get(...(params as any[])) as any,
      run: async (sql, params = []) => {
        sqlite.prepare(sql).run(...(params as any[]));
      },
      transaction: async (fn) => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(raw);
          sqlite.exec("COMMIT");
          return result;
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      },
      close: async () => sqlite.close(),
    };
  }
  // All operations in a process share a queue, preventing unrelated writes from
  // accidentally joining a SQLite transaction while its callback awaits.
  let tail = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const db: DB = {
    all: (s, p) => exclusive(() => raw.all(s, p)),
    get: (s, p) => exclusive(() => raw.get(s, p)),
    run: (s, p) => exclusive(() => raw.run(s, p)),
    transaction: (fn) => exclusive(() => raw.transaction(fn)),
    close: () => exclusive(() => raw.close()),
  };
  for (const statement of schema.split(";").filter((s) => s.trim()))
    await db.run(statement);
  await db.run(
    "INSERT INTO repo_explanation_versions SELECT full_name,source_hash,payload,created_at FROM repo_explanations WHERE 1=1 ON CONFLICT(full_name,source_hash) DO NOTHING",
  );
  return db;
}
