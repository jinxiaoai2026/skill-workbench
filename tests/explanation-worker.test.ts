import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { openDB } from "../src/server/db.ts";
import { buildApp } from "../src/server/app.ts";
import { hash } from "../src/server/auth.ts";
import { queueExplanations } from "../src/server/explanation-jobs.ts";
import { explanationHash } from "../src/core/explanations.ts";
import { Connector } from "../connector/registry.ts";
import { runExplanationJob } from "../connector/explanation-jobs.ts";
const cached = { fullName: "shop/cached", description: "Saved reporting tool" },
  fresh = { fullName: "shop/fresh", description: "A new stock analysis tool" };
const guide = (fullName: string) => ({
  fullName,
  titleZh: "库存经营工具",
  summaryZh: "根据导出的库存资料进行分析。",
  useZh: "用于整理库存资料。",
});
test("cache hits and new translations are uploaded, and a lost result receipt survives restart without regeneration", async () => {
  const root = mkdtempSync(join(tmpdir(), "chinese-worker-")),
    db = await openDB(":memory:");
  let c = new Connector(root);
  const previous = process.env.WORKBENCH_DEVICE_TOKEN;
  process.env.WORKBENCH_DEVICE_TOKEN = "fixture_token";
  const app = await buildApp({
    db,
    sessionKey: Buffer.alloc(32, 7),
    password: "fixture-password",
    origin: "http://127.0.0.1:4317",
    allowCollection: false,
  });
  let loseReceipt = true,
    generations = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const r = await app.inject({
      method: req.method as any,
      url: req.url!,
      headers: req.headers as any,
      ...(body ? { payload: body } : {}),
    });
    if (req.url?.endsWith("/result") && loseReceipt) {
      loseReceipt = false;
      res.destroy();
      return;
    }
    res.writeHead(r.statusCode, r.headers as any);
    res.end(r.body);
  });
  try {
    await db.run("INSERT INTO devices VALUES(?,?,?,0,?,?)", [
      "one",
      "Mac",
      hash("fixture_token"),
      new Date().toISOString(),
      new Date().toISOString(),
    ]);
    await queueExplanations(db, [cached, fresh]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    c.setting("server", "http://127.0.0.1:" + (server.address() as any).port);
    c.setting("deviceId", "one");
    c.setting(
      "chinese-cache:" + explanationHash(cached),
      JSON.stringify(guide(cached.fullName)),
    );
    await assert.rejects(() =>
      runExplanationJob(c, async (repos) => {
        generations++;
        assert.deepEqual(repos, [fresh]);
        return [guide(fresh.fullName)];
      }),
    );
    assert.ok(c.setting("chinese-result-outbox"));
    assert.equal(
      (await db.all("SELECT * FROM repo_explanation_versions")).length,
      2,
    );
    c.close();
    c = new Connector(root);
    await runExplanationJob(c, async () => {
      throw new Error("Existing result must be retried first");
    });
    assert.equal(c.setting("chinese-result-outbox"), "");
    assert.equal(generations, 1);
    await runExplanationJob(c, async () => {
      throw new Error("No new metadata");
    });
    assert.equal(
      (await db.all("SELECT * FROM job_runs WHERE kind='chinese'")).length,
      1,
    );
    assert.equal(c.skills().length, 0);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/device/explanation-jobs" }))
        .statusCode,
      401,
    );
    await db.run("UPDATE devices SET revoked=1 WHERE id='one'");
    await assert.rejects(() => runExplanationJob(c));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await app.close();
    c.close();
    await db.close();
    if (previous === undefined) delete process.env.WORKBENCH_DEVICE_TOKEN;
    else process.env.WORKBENCH_DEVICE_TOKEN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test("generation failure pauses the connector and keeps the public request available for retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "chinese-failure-")),
    db = await openDB(":memory:"),
    c = new Connector(root),
    previous = process.env.WORKBENCH_DEVICE_TOKEN;
  process.env.WORKBENCH_DEVICE_TOKEN = "fixture_token";
  const app = await buildApp({
    db,
    sessionKey: Buffer.alloc(32, 7),
    password: "fixture-password",
    origin: "http://127.0.0.1:4317",
    allowCollection: false,
  });
  try {
    await db.run("INSERT INTO devices VALUES(?,?,?,0,?,?)", [
      "one",
      "Mac",
      hash("fixture_token"),
      new Date().toISOString(),
      new Date().toISOString(),
    ]);
    await queueExplanations(db, [fresh]);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    c.setting("server", origin);
    c.setting("deviceId", "one");
    await runExplanationJob(c, async () => {
      throw new Error("Engine unavailable");
    });
    assert.ok(Number(c.setting("chinese-retry-until")) > Date.now());
    await runExplanationJob(c, async () => [guide(fresh.fullName)]);
    assert.equal(
      (await db.all("SELECT * FROM job_runs WHERE kind='chinese'")).length,
      1,
    );
    assert.equal(
      (await db.all("SELECT * FROM explanation_requests")).length,
      1,
    );
  } finally {
    await app.close();
    c.close();
    await db.close();
    if (previous === undefined) delete process.env.WORKBENCH_DEVICE_TOKEN;
    else process.env.WORKBENCH_DEVICE_TOKEN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
