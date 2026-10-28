import Fastify, { type FastifyRequest } from "fastify";
import secureSession from "@fastify/secure-session";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { DB } from "./db.ts";
import { Service, csvCell } from "./service.ts";
import { hash, passwordHash, passwordMatches } from "./auth.ts";
import { collect } from "./collector.ts";
import { archiveRange } from "./jobs.ts";
import { getCatalog, getSkillPage } from "./catalog.ts";
import { CatalogTasks } from "./catalog-tasks.ts";
import { InstallService } from "./installations.ts";
import {
  ExplanationJobs,
  queueRecentExplanations,
} from "./explanation-jobs.ts";
import { explainMissing } from "./explanations.ts";
import { CloudChinese } from "./cloud-chinese.ts";
import { skillOwnershipLabels } from "../core/library.ts";
import { SkillNameService } from "./skill-names.ts";
import { GitHubQueryError } from "./github-query.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
declare module "@fastify/secure-session" {
  interface SessionData {
    owner: boolean;
    authVersion: string;
  }
}
export function requestPath(req: FastifyRequest): string {
  const matched = req.routeOptions.url;
  if (matched && matched !== "/*") return matched;
  try {
    return decodeURIComponent(req.url.split("?")[0]);
  } catch {
    throw Object.assign(new Error("无效请求路径"), { statusCode: 400 });
  }
}
export async function buildApp(options: {
  db: DB;
  sessionKey: Buffer;
  password: string;
  origin: string;
  allowCollection?: boolean;
}) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const service = new Service(options.db);
  const db = options.db;
  const catalogs = new CatalogTasks(db);
  const chineseJobs = new ExplanationJobs(db);
  const cloudChinese = new CloudChinese(db, options.sessionKey);
  const installer = new InstallService(db);
  const skillNames = new SkillNameService(db);
  if (!(await db.get("SELECT value FROM meta WHERE key=?", ["password"])))
    await db.run("INSERT INTO meta VALUES(?,?)", [
      "password",
      passwordHash(options.password),
    ]);
  await app.register(secureSession, {
    key: options.sessionKey,
    cookieName: "workbench_session",
    cookie: {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: options.origin.startsWith("https:"),
      maxAge: 7 * 86400,
    },
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  const isOwner = async (req: FastifyRequest) => {
    if (!req.session.get("owner")) return false;
    const record = await db.get("SELECT value FROM meta WHERE key=?", [
      "password",
    ]);
    if (!record || req.session.get("authVersion") !== hash(record.value)) {
      req.session.delete();
      return false;
    }
    return true;
  };
  app.addHook("onRequest", async (req, reply) => {
    const path = requestPath(req);
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "same-origin");
    if (path.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      ((req.headers.origin && req.headers.origin !== options.origin) ||
        req.headers["sec-fetch-site"] === "cross-site")
    )
      return reply.code(403).send({ error: "拒绝跨站写入请求" });
    if (!path.startsWith("/api/")) return;
    if (
      ["/api/login", "/api/session", "/api/pair", "/api/health"].includes(path)
    )
      return;
    if (path === "/api/sync" || path.startsWith("/api/device/")) {
      const bearer = req.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]+)$/,
      )?.[1];
      // Some hosting gateways reserve Authorization. The namespaced header uses
      // the same device credential, scope, hashing and revocation checks.
      const custom = req.headers["x-workbench-device-token"];
      const namespaced =
        typeof custom === "string" && /^[A-Za-z0-9_-]+$/.test(custom)
          ? custom
          : undefined;
      if (namespaced && bearer && namespaced !== bearer)
        return reply.code(401).send({ error: "设备凭证无效或已撤销" });
      const credential = namespaced || bearer;
      const device = credential
        ? await db.get(
            "SELECT id FROM devices WHERE token_hash=? AND revoked=0",
            [hash(credential)],
          )
        : undefined;
      if (!device)
        return reply.code(401).send({ error: "设备凭证无效或已撤销" });
      (req as any).deviceId = device.id;
      return;
    }
    if (!(await isOwner(req)))
      return reply.code(401).send({ error: "请先登录" });
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number };
    const code =
      e instanceof GitHubQueryError
        ? e.statusCode
        : e.statusCode && e.statusCode < 500
          ? e.statusCode
          : 400;
    if (e instanceof GitHubQueryError && e.retryAt)
      reply.header(
        "Retry-After",
        String(
          Math.max(1, Math.ceil((Date.parse(e.retryAt) - Date.now()) / 1000)),
        ),
      );
    reply.code(code).send({
      ...(e instanceof GitHubQueryError
        ? {
            code: e.code,
            upstreamStatus: e.upstreamStatus,
            retryAt: e.retryAt,
            rate: e.rate,
          }
        : {}),
      error:
        e instanceof z.ZodError
          ? "提交内容格式有误：" +
            e.issues.map((i) => i.path.join(".") + " " + i.message).join("；")
          : e.message,
    });
  });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/github/status", async () => {
    let git: { available: boolean; version?: string } = { available: false };
    try {
      const result = await promisify(execFile)(
        process.env.WORKBENCH_GIT || "git",
        ["--version"],
        { timeout: 3000, maxBuffer: 4096, encoding: "utf8" },
      );
      const version = result.stdout.trim();
      if (/^git version [0-9][^\r\n]{0,180}$/.test(version))
        git = { available: true, version };
    } catch {}
    const row = await db.get("SELECT value FROM meta WHERE key=?", [
      "github-api-budget",
    ]);
    const rate = row ? JSON.parse(row.value) : undefined;
    return {
      git,
      api: rate
        ? {
            remaining: rate.remaining,
            limit: rate.limit,
            resetAt: rate.resetAt,
          }
        : null,
    };
  });
  app.get("/api/session", async (req) => ({
    authenticated: await isOwner(req),
  }));
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const { username, password } = z
        .object({
          username: z.string().trim().max(100).default(""),
          password: z.string().max(500),
        })
        .parse(req.body);
      const record = await db.get("SELECT value FROM meta WHERE key=?", [
        "password",
      ]);
      const validPassword = passwordMatches(password, record!.value);
      if (username !== "admin" || !validPassword)
        return reply.code(401).send({ error: "账户或密码不正确" });
      req.session.set("owner", true);
      req.session.set("authVersion", hash(record!.value));
      return { ok: true };
    },
  );
  app.post("/api/logout", async (req) => {
    req.session.delete();
    return { ok: true };
  });
  app.post("/api/password", async (req) => {
    const { current, newPassword } = z
      .object({
        current: z.string().max(500),
        newPassword: z.string().min(10).max(200),
      })
      .parse(req.body);
    const verifier = await db.transaction(async (tx) => {
      const old = await tx.get("SELECT value FROM meta WHERE key=?", [
        "password",
      ]);
      if (!passwordMatches(current, old!.value))
        throw new Error("当前密码不正确");
      const value = passwordHash(newPassword);
      await tx.run("UPDATE meta SET value=? WHERE key=?", [value, "password"]);
      return value;
    });
    req.session.set("authVersion", hash(verifier));
    return { ok: true };
  });
  app.get("/api/state", async (req) =>
    service.state(req.query as Record<string, string>),
  );
  app.get("/api/catalog", async (req) => {
    const q = z
      .object({ repo: z.string(), refresh: z.literal("1").optional() })
      .parse(req.query);
    return getCatalog(db, q.repo, { forceRefresh: q.refresh === "1" });
  });
  app.get("/api/device/catalog-jobs", async (req) => {
    const q = z
      .object({ pauseUntil: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    return catalogs.claim((req as any).deviceId, q.pauseUntil);
  });
  app.post("/api/device/catalog-jobs/:id/result", async (req) =>
    catalogs.complete((req as any).deviceId, (req.params as any).id, req.body),
  );
  app.get("/api/catalog/skills", async (req) =>
    getSkillPage(
      db,
      z
        .object({
          repo: z.string(),
          offset: z.string().optional(),
          search: z.string().optional(),
        })
        .parse(req.query),
    ),
  );
  app.post("/api/install", async (req) => installer.enqueue(req.body));
  app.post("/api/install/batch", async (req) =>
    installer.enqueueBatch(req.body),
  );
  app.post("/api/install/status", async (req) =>
    installer.jobStatuses(req.body),
  );
  app.post("/api/install/alias", async (req) => installer.rename(req.body));
  app.get("/api/skill-name-jobs/:id", async (req) =>
    skillNames.status((req.params as any).id),
  );
  app.get("/api/device/name-jobs", async (req) =>
    skillNames.claim((req as any).deviceId),
  );
  app.post("/api/device/name-jobs/:id/result", async (req) =>
    skillNames.complete(
      (req as any).deviceId,
      (req.params as any).id,
      req.body,
    ),
  );
  app.get("/api/device/jobs", async (req) =>
    installer.claim((req as any).deviceId),
  );
  app.post("/api/device/jobs/:id/result", async (req) =>
    installer.complete((req as any).deviceId, (req.params as any).id, req.body),
  );
  app.get("/api/device/explanation-jobs", async (req) =>
    (await cloudChinese.enabled())
      ? null
      : chineseJobs.claim((req as any).deviceId),
  );
  app.post("/api/device/explanation-jobs/:id/result", async (req) =>
    chineseJobs.complete(
      (req as any).deviceId,
      (req.params as any).id,
      req.body,
    ),
  );
  app.post("/api/explanations", async () => {
    await queueRecentExplanations(db);
    const cloudEnabled = await cloudChinese.enabled();
    if (process.env.EXPLAIN_WITH_CODEX !== "0")
      void explainMissing(db, { localMetadataOnly: cloudEnabled }).catch((e) =>
        console.error((e as Error).message),
      );
    return {
      ok: true,
      message: cloudEnabled
        ? "已加入云端中文介绍队列，服务器会自动处理"
        : "已加入中文介绍队列，已连接的 Mac 会自动生成并同步",
    };
  });
  app.get("/api/settings/chinese", async () => cloudChinese.settings());
  app.post("/api/settings/chinese", async (req) => cloudChinese.save(req.body));
  app.post(
    "/api/settings/chinese/test",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async () => cloudChinese.test(),
  );
  app.post("/api/skills", async (req) => service.saveSkill(req.body));
  app.patch("/api/skills/:id", async (req) =>
    service.saveSkill(req.body, (req.params as any).id),
  );
  app.get("/api/skills/:id/versions", async (req) =>
    (
      await db.all(
        "SELECT * FROM skill_versions WHERE skill_id=? ORDER BY created_at DESC",
        [(req.params as any).id],
      )
    ).map((s) => ({ ...s, ...JSON.parse(s.payload), payload: undefined })),
  );
  app.post("/api/pairings", async () => service.createPairing());
  app.post(
    "/api/pair",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (req) => service.pair(req.body),
  );
  app.delete("/api/devices/:id", async (req) => {
    await db.run("UPDATE devices SET revoked=1 WHERE id=?", [
      (req.params as any).id,
    ]);
    return { ok: true };
  });
  app.post("/api/sync", async (req) => {
    const result = await service.ingest((req as any).deviceId, req.body);
    if (
      options.allowCollection !== false &&
      process.env.EXPLAIN_WITH_CODEX !== "0"
    ) {
      const cloudEnabled = await cloudChinese.enabled();
      const pending = await db.get(
        "SELECT q.full_name FROM explanation_requests q LEFT JOIN repo_explanation_versions c ON c.full_name=q.full_name AND c.source_hash=q.source_hash WHERE c.full_name IS NULL" +
          (cloudEnabled
            ? " AND (q.full_name LIKE 'local-skill:%' OR q.full_name LIKE '%#%')"
            : "") +
          " LIMIT 1",
      );
      const failed = await db.get(
        "SELECT id FROM job_runs WHERE kind=? AND status=? AND started_at>? LIMIT 1",
        ["chinese", "failed", new Date(Date.now() - 300000).toISOString()],
      );
      if (pending && !failed)
        void explainMissing(db, { localMetadataOnly: cloudEnabled }).catch(
          (e) => console.error("中文说明：" + e.message),
        );
    }
    return result;
  });
  app.post("/api/bookmarks", async (req) => {
    const repo = z
      .object({
        fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        repoId: z.string().optional(),
        description: z.string().max(4000).optional(),
        language: z.string().max(100).optional(),
        url: z.string().url().optional(),
        category: z.string().max(50).optional(),
        note: z.string().max(2000).optional(),
      })
      .parse(req.body);
    await db.run(
      "INSERT INTO bookmarks VALUES(?,?,?) ON CONFLICT(repo_id) DO UPDATE SET payload=excluded.payload",
      [
        repo.repoId || repo.fullName,
        JSON.stringify(repo),
        new Date().toISOString(),
      ],
    );
    return { ok: true };
  });
  app.delete("/api/bookmarks/:id", async (req) => {
    await db.run("DELETE FROM bookmarks WHERE repo_id=?", [
      (req.params as any).id,
    ]);
    return { ok: true };
  });
  app.post("/api/collect", async (_req, reply) => {
    if (options.allowCollection === false)
      return reply.code(403).send({ error: "此实例禁用采集" });
    void collect(db).catch((e) => console.error("采集失败：" + e.message));
    return { ok: true, message: "采集已启动，可在设置查看进度" };
  });
  app.get("/api/archives", async (req) =>
    service.listArchives(req.query as Record<string, string>),
  );
  app.get("/api/archives/:id", async (req) => {
    const row = await db.get("SELECT * FROM archives WHERE id=?", [
      (req.params as any).id,
    ]);
    if (!row) throw new Error("归档不存在");
    return { ...row, ...JSON.parse(row.payload), payload: undefined };
  });
  app.post("/api/archive", async (req) => {
    const { period, from, to } = z
      .object({
        period: z.enum(["daily", "month"]),
        from: z.string(),
        to: z.string(),
      })
      .parse(req.body);
    return { ok: await archiveRange(db, period, from, to) };
  });
  app.get("/api/export", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const s = await service.state(q, true);
    let rows: unknown[][];
    if (q.kind === "skills")
      rows = [
        [
          "名称",
          "归属",
          "分类",
          "平台",
          "期间确认次数",
          "累计确认次数",
          "创建日期",
          "来源项目",
          "Codex 调用名",
        ],
        ...s.skills.map((s) => [
          s.name,
          skillOwnershipLabels[s.ownership] || s.ownership,
          s.category,
          s.platforms.join("/"),
          s.stats.period,
          s.stats.total,
          s.createdDate,
          s.sourceRepo || s.upstream || "",
          s.codexName || s.name,
        ]),
      ];
    else
      rows = [
        ["Skill", "时间", "证据", "结果", "设备", "调用ID", "调用来源"],
        ...s.usage.events.map((e) => [
          e.name,
          e.started_at,
          e.evidence,
          e.status,
          e.device,
          e.invocation_id,
          e.source === "native-explicit"
            ? "Codex直接唤起"
            : e.source === "managed-entry"
              ? "受管执行"
              : "文件读取",
        ]),
      ];
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        'attachment; filename="skill-workbench.csv"',
      )
      .send("\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
  });
  const dist = resolve("dist");
  if (existsSync(dist + "/index.html")) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) =>
      requestPath(req).startsWith("/api/")
        ? reply.code(404).send({ error: "接口不存在" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
