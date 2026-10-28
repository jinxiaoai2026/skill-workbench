import type { DB } from "./db.ts";
import { randomUUID } from "node:crypto";

export class GitHubQueryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly upstreamStatus?: number,
    readonly retryAt?: string,
    readonly rate?: {
      remaining: number | null;
      limit: number | null;
      resetAt?: string;
      requestId?: string;
    },
  ) {
    super(message);
  }
}
const numeric = (v: string | null) =>
  v !== null && /^\d+$/.test(v) ? Number(v) : null;
type QueryOptions = {
  now?: () => number;
  fetcher?: typeof fetch;
  priority?: "interactive" | "background";
};
const queues = new WeakMap<DB, Promise<unknown>>();
export async function githubJSON(
  db: DB,
  path: string,
  options: QueryOptions = {},
) {
  const previous = queues.get(db) || Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() =>
      withSharedLease(
        db,
        () => requestGitHub(db, path, options),
        options.priority,
      ),
    );
  queues.set(db, task);
  try {
    return await task;
  } finally {
    if (queues.get(db) === task) queues.delete(db);
  }
}
async function withSharedLease<T>(
  db: DB,
  request: () => Promise<T>,
  priority?: QueryOptions["priority"],
): Promise<T> {
  const owner = randomUUID(),
    deadline = Date.now() + 21000;
  while (true) {
    const now = new Date().toISOString();
    await db.run(
      "INSERT INTO job_locks VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE job_locks.expires_at<?",
      [
        "github-rest-request",
        owner,
        new Date(Date.now() + 30000).toISOString(),
        now,
      ],
    );
    const lock = await db.get("SELECT owner FROM job_locks WHERE key=?", [
      "github-rest-request",
    ]);
    if (lock?.owner === owner) break;
    if (priority === "background" || Date.now() >= deadline)
      throw new GitHubQueryError(
        "其他GitHub查询正在执行，本次可选查询已等待或跳过。",
        "GITHUB_BUSY",
        503,
        undefined,
        new Date(Date.now() + 1000).toISOString(),
      );
    await new Promise((r) => setTimeout(r, 25));
  }
  try {
    return await request();
  } finally {
    await db.run("DELETE FROM job_locks WHERE key=? AND owner=?", [
      "github-rest-request",
      owner,
    ]);
  }
}
async function requestGitHub(db: DB, path: string, options: QueryOptions) {
  const now = (options.now || Date.now)();
  const stored = await db.get("SELECT value FROM meta WHERE key=?", [
    "github-catalog-cooldown",
  ]);
  if (stored) {
    const c = JSON.parse(stored.value);
    if (c.until > now)
      throw new GitHubQueryError(
        c.message,
        "GITHUB_RATE_LIMITED",
        429,
        c.status,
        new Date(c.until).toISOString(),
        c.rate,
      );
  }
  const used = await db.get("SELECT value FROM meta WHERE key=?", [
    "github-api-budget",
  ]);
  if (used) {
    const rate = JSON.parse(used.value),
      resetAt = Date.parse(rate.resetAt || "");
    if (
      resetAt > now &&
      rate.remaining !== null &&
      rate.remaining <= (options.priority === "background" ? 10 : 0)
    )
      throw new GitHubQueryError(
        options.priority === "background"
          ? "已保留GitHub查询额度供添加技能，跳过本次可选信息补充。"
          : "GitHub REST 查询额度已用完，请在提示时间后重试。",
        options.priority === "background"
          ? "GITHUB_RESERVED"
          : "GITHUB_RATE_LIMITED",
        options.priority === "background" ? 503 : 429,
        undefined,
        new Date(resetAt).toISOString(),
        rate,
      );
  }
  let r: Response;
  try {
    r = await (options.fetcher || fetch)("https://api.github.com" + path, {
      headers: {
        accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN
          ? { authorization: "Bearer " + process.env.GITHUB_TOKEN }
          : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new GitHubQueryError(
      "暂时无法连接 GitHub，请稍后重试。",
      "GITHUB_UNAVAILABLE",
      503,
    );
  }
  const remaining = numeric(r.headers.get("x-ratelimit-remaining")),
    limit = numeric(r.headers.get("x-ratelimit-limit"));
  const reset = numeric(r.headers.get("x-ratelimit-reset"));
  const rate = {
    remaining,
    limit,
    ...(reset ? { resetAt: new Date(reset * 1000).toISOString() } : {}),
    ...(r.headers.get("x-github-request-id")
      ? { requestId: r.headers.get("x-github-request-id")! }
      : {}),
  };
  if (remaining !== null && reset) {
    const latest = await db.get("SELECT value FROM meta WHERE key=?", [
      "github-api-budget",
    ]);
    const previous = latest ? JSON.parse(latest.value) : undefined;
    const previousReset = Date.parse(previous?.resetAt || "");
    const budget =
      previousReset > reset * 1000 && previousReset > now
        ? previous
        : previousReset === reset * 1000 && previous.remaining !== null
          ? { ...rate, remaining: Math.min(remaining, previous.remaining) }
          : rate;
    await db.run(
      "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ["github-api-budget", JSON.stringify(budget)],
    );
  }
  if (r.ok) return r.json() as Promise<any>;
  const body = (await r.text()).slice(0, 8192);
  const retry = r.headers.get("retry-after");
  const limited =
    r.status === 429 ||
    (r.status === 403 &&
      (remaining === 0 ||
        retry !== null ||
        /rate limit|secondary limit|abuse detection/i.test(body)));
  if (limited) {
    const retryTime =
      retry && /^\d+$/.test(retry)
        ? now + Number(retry) * 1000
        : retry && Number.isFinite(Date.parse(retry))
          ? Date.parse(retry)
          : 0;
    const until =
      Math.max(
        now + 1000,
        retryTime,
        remaining === 0 && reset ? reset * 1000 : 0,
      ) || now + 60000;
    const effective = until <= now + 1000 ? now + 60000 : until;
    const message =
      "GitHub REST 接口请求频率已达上限，与 Codex 余额无关。预计北京时间 " +
      new Date(effective).toLocaleTimeString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      }) +
      " 后可重试。";
    await db.run(
      "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [
        "github-catalog-cooldown",
        JSON.stringify({ until: effective, status: r.status, message, rate }),
      ],
    );
    throw new GitHubQueryError(
      message,
      "GITHUB_RATE_LIMITED",
      429,
      r.status,
      new Date(effective).toISOString(),
      rate,
    );
  }
  if (r.status === 401)
    throw new GitHubQueryError(
      "工作台当前 GitHub 认证配置不可用，请管理员检查；不是 Codex 余额问题。",
      "GITHUB_AUTHENTICATION",
      502,
      401,
    );
  if (r.status === 403)
    throw new GitHubQueryError(
      "GitHub 拒绝访问该仓库，可能是权限或访问策略限制，未判定为额度不足。",
      "GITHUB_FORBIDDEN",
      502,
      403,
    );
  if (r.status === 404)
    throw new GitHubQueryError(
      "GitHub 仓库或指定版本不存在，或当前连接无权查看。",
      "GITHUB_NOT_FOUND",
      404,
      404,
    );
  throw new GitHubQueryError(
    "GitHub 项目查询暂时失败（" +
      r.status +
      "），尚未判断该仓库是否包含 Skill。",
    "GITHUB_UNAVAILABLE",
    503,
    r.status,
  );
}
