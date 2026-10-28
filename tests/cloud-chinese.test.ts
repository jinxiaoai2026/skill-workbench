import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDB } from "../src/server/db.ts";
import {
  queueExplanations,
  ExplanationJobs,
} from "../src/server/explanation-jobs.ts";
import { buildApp } from "../src/server/app.ts";
import { explainMissing } from "../src/server/explanations.ts";
import { explanationHash } from "../src/core/explanations.ts";
import {
  CloudChinese,
  requestCloudExplanations,
} from "../src/server/cloud-chinese.ts";

const key = Buffer.alloc(32, 19);
const secret = "private-api-key-for-test";
const repo = {
  fullName: "shop/report",
  description: "Inventory and profit reports",
};
const guide = {
  fullName: "shop/report",
  titleZh: "库存利润报表",
  summaryZh: "生成库存与利润报表。",
  useZh: "用于查看商品库存与利润。",
};
const config = {
  provider: "deepseek" as const,
  model: "deepseek-flash",
  apiKey: secret,
};

test("cloud configuration survives reopening encrypted, never returns a key, and requires a new key when changing provider", async () => {
  const db = await openDB(":memory:");
  try {
    const engine = new CloudChinese(db, key);
    assert.equal((await engine.settings()).enabled, false);
    await assert.rejects(
      engine.save({
        enabled: true,
        provider: "deepseek",
        model: "deepseek-flash",
        dailyLimit: 50,
      }),
      /密钥|Key/,
    );
    const saved = await engine.save({
      enabled: true,
      ...config,
      dailyLimit: 50,
    });
    assert.equal(saved.configured, true);
    assert.equal(JSON.stringify(saved).includes(secret), false);
    const raw = JSON.stringify(await db.all("SELECT * FROM meta"));
    assert.equal(raw.includes(secret), false);
    const reopened = new CloudChinese(db, key);
    assert.equal(await reopened.enabled(), true);
    await assert.rejects(
      reopened.save({
        enabled: true,
        provider: "openai",
        model: "gpt-4.1-mini",
        dailyLimit: 50,
      }),
      /密钥|Key/,
    );
    assert.equal((await reopened.settings()).provider, "deepseek");
    await reopened.save({
      enabled: false,
      provider: "deepseek",
      model: "deepseek-flash",
      dailyLimit: 50,
    });
    assert.equal(await reopened.enabled(), false);
    assert.equal((await reopened.settings()).configured, true);
    assert.equal(
      JSON.stringify(await reopened.settings()).includes(secret),
      false,
    );
  } finally {
    await db.close();
  }
});

test("cloud JSON transport reaches only the fixed provider, rejects redirects, and faithfully validates names and Chinese output", async () => {
  let received: any;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = {
      authorization: req.headers.authorization,
      body: JSON.parse(body),
    };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ items: [guide] }) },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const fetcher: typeof fetch = async (url, init) => {
      assert.equal(String(url), "https://api.deepseek.com/chat/completions");
      assert.equal(init?.redirect, "error");
      return fetch(`http://127.0.0.1:${address.port}/`, init);
    };
    assert.deepEqual(
      await requestCloudExplanations(config, [repo], { fetcher }),
      [guide],
    );
    assert.equal(received.authorization, "Bearer " + secret);
    assert.equal(received.body.response_format.type, "json_object");
    assert.equal(
      received.body.messages[1].content.includes(repo.description),
      true,
    );
    assert.equal("tools" in received.body, false);
    const malformed =
      (content: unknown, reason = "stop") =>
      async () =>
        Response.json({
          choices: [
            {
              finish_reason: reason,
              message: {
                content:
                  typeof content === "string"
                    ? content
                    : JSON.stringify(content),
              },
            },
          ],
        });
    for (const fetcher of [
      malformed(""),
      malformed("nonsense"),
      malformed({ items: [{ ...guide, fullName: "other/repo" }] }),
      malformed({ items: [{ ...guide, titleZh: "English only" }] }),
      malformed({ items: [guide] }, "length"),
    ]) {
      await assert.rejects(
        requestCloudExplanations(config, [repo], { fetcher }),
        /中文|结果|返回|JSON/,
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cloud transport bounds failures and does not echo secret response content", async () => {
  await assert.rejects(
    requestCloudExplanations(config, [repo], {
      fetcher: async () => {
        throw new Error("模型 " + secret);
      },
    }),
    (e: Error) => !e.message.includes(secret),
  );
  for (const status of [401, 429, 500]) {
    await assert.rejects(
      requestCloudExplanations(config, [repo], {
        fetcher: async () => new Response(secret, { status }),
      }),
      (e: Error) =>
        !e.message.includes(secret) && /密钥|限流|服务/.test(e.message),
    );
  }
  await assert.rejects(
    requestCloudExplanations(config, [repo], {
      timeoutMs: 20,
      fetcher: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error(secret)),
            { once: true },
          );
        }),
    }),
    /超时/,
  );
  await assert.rejects(
    requestCloudExplanations(config, [repo], {
      fetcher: async () => new Response("x".repeat(200000)),
    }),
    /过大/,
  );
});

const successfulFetch =
  (onRequest = () => {}) =>
  async (_url: unknown, init: any) => {
    onRequest();
    const inputs = JSON.parse(JSON.parse(init.body).messages[1].content);
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              items: inputs.map((r: any) => ({
                ...guide,
                fullName: r.fullName,
              })),
            }),
          },
        },
      ],
    });
  };
const enabledSettings = { enabled: true, ...config, dailyLimit: 50 };

test("cloud queue runs without a Mac, shares the lock across workers, preserves cached Chinese, and atomically limits requests by Beijing day", async () => {
  const db = await openDB(":memory:");
  let now = Date.parse("2026-10-26T15:59:00Z"),
    calls = 0;
  const options = { now: () => now, fetcher: successfulFetch(() => calls++) };
  try {
    const worker = new CloudChinese(db, key, options),
      other = new CloudChinese(db, key, options);
    await queueExplanations(
      db,
      Array.from({ length: 6 }, (_, i) => ({
        ...repo,
        fullName: "shop/report" + i,
      })),
    );
    await worker.tick();
    assert.equal(calls, 0);
    await worker.save({ ...enabledSettings, dailyLimit: 1 });
    await Promise.all([worker.tick(), other.tick()]);
    assert.equal(calls, 1);
    assert.equal(
      (await db.all("SELECT * FROM repo_explanation_versions")).length,
      5,
    );
    assert.equal((await worker.settings()).usedToday, 1);
    await worker.tick();
    assert.equal(calls, 1);
    now += 120000; // midnight in Beijing, still the same UTC day
    await other.tick();
    assert.equal(calls, 2);
    assert.equal((await worker.settings()).usedToday, 1);
    const cached = await db.all("SELECT * FROM repo_explanation_versions");
    assert.equal(cached.length, 6);
    await worker.tick();
    assert.deepEqual(
      await db.all("SELECT * FROM repo_explanation_versions"),
      cached,
    );
    assert.equal((await db.all("SELECT * FROM devices")).length, 0);
  } finally {
    await db.close();
  }
});

test("a failed cloud call consumes its budget, retains the queue, and waits through a persistent five-minute cooldown", async () => {
  const db = await openDB(":memory:");
  let now = Date.parse("2026-10-27T03:00:00Z"),
    calls = 0;
  try {
    const worker = new CloudChinese(db, key, {
      now: () => now,
      fetcher: async () => {
        calls++;
        return new Response(secret, { status: 429 });
      },
    });
    await worker.save(enabledSettings);
    await queueExplanations(db, [repo]);
    await worker.tick();
    const state = await worker.settings();
    assert.equal(state.usedToday, 1);
    assert.equal(state.pending, 1);
    assert.equal(state.lastJob?.status, "failed");
    assert.equal(JSON.stringify(state).includes(secret), false);
    assert.ok(state.cooldownUntil);
    const restarted = new CloudChinese(db, key, {
      now: () => now,
      fetcher: successfulFetch(() => calls++),
    });
    await restarted.tick();
    assert.equal(calls, 1);
    now += 300001;
    await restarted.tick();
    assert.equal(calls, 2);
    assert.equal((await restarted.settings()).pending, 0);
    assert.equal((await restarted.settings()).lastJob?.status, "succeeded");
  } finally {
    await db.close();
  }
});

test("cloud results require a live cloud lease and cannot finish a paired-device job", async () => {
  const db = await openDB(":memory:");
  let now = Date.parse("2026-10-27T03:00:00Z");
  try {
    const jobs = new ExplanationJobs(db, () => now);
    await queueExplanations(db, [repo]);
    const claimed = await jobs.claimCloud();
    assert.ok(claimed);
    const result = {
      status: "succeeded",
      attemptToken: claimed.attemptToken,
      items: [{ ...guide, sourceHash: claimed.inputs[0].sourceHash }],
    };
    await assert.rejects(
      jobs.completeCloud(claimed.id, {
        ...result,
        attemptToken: "11111111-1111-4111-8111-111111111111",
      }),
      /过期/,
    );
    now += 360001;
    await assert.rejects(jobs.completeCloud(claimed.id, result), /过期/);
    assert.equal((await db.all("SELECT * FROM repo_explanations")).length, 0);
    const next = await jobs.claimCloud();
    await jobs.completeCloud(next!.id, {
      ...result,
      attemptToken: next!.attemptToken,
    });
    assert.equal((await db.all("SELECT * FROM repo_explanations")).length, 1);
  } finally {
    await db.close();
  }
});

test("connection tests use saved credentials and the same request budget without changing the public queue", async () => {
  const db = await openDB(":memory:");
  let calls = 0;
  try {
    const engine = new CloudChinese(db, key, {
      fetcher: successfulFetch(() => calls++),
    });
    await engine.save({ ...enabledSettings, enabled: false, dailyLimit: 1 });
    await queueExplanations(db, [repo]);
    assert.equal((await engine.test()).ok, true);
    assert.equal(calls, 1);
    await assert.rejects(engine.test(), /上限/);
    assert.equal(calls, 1);
    assert.equal((await engine.settings()).pending, 1);
    assert.equal((await db.all("SELECT * FROM repo_explanations")).length, 0);
  } finally {
    await db.close();
  }
});

test("cloud configuration is owner-only, cross-site protected, and an enabled cloud executor stops new Mac claims", async () => {
  const db = await openDB(":memory:");
  const origin = "https://workbench.example";
  const app = await buildApp({
    db,
    sessionKey: key,
    password: "owner-test-password",
    origin,
    allowCollection: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "owner-test-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const route = {
      method: "POST" as const,
      url: "/api/settings/chinese",
      payload: enabledSettings,
    };
    assert.equal((await app.inject(route)).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          ...route,
          headers: { cookie, origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    const saved = await app.inject({ ...route, headers: { cookie, origin } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.includes(secret), false);
    const read = await app.inject({
      url: "/api/settings/chinese",
      headers: { cookie },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().configured, true);
    assert.equal(read.body.includes(secret), false);
    const pairCode = (
      await app.inject({
        method: "POST",
        url: "/api/pairings",
        headers: { cookie },
      })
    ).json().code;
    const pair = (
      await app.inject({
        method: "POST",
        url: "/api/pair",
        payload: { code: pairCode, name: "test Mac" },
      })
    ).json();
    const headers = { authorization: "Bearer " + pair.token };
    assert.equal(
      (await app.inject({ url: "/api/settings/chinese", headers })).statusCode,
      401,
    );
    await queueExplanations(db, [repo]);
    assert.equal(
      (
        await app.inject({ url: "/api/device/explanation-jobs", headers })
      ).json(),
      null,
    );
    assert.equal(
      (await db.all("SELECT * FROM explanation_requests")).length,
      1,
    );
  } finally {
    await app.close();
    await db.close();
  }
});

test("enabling cloud for public projects leaves local Skill metadata on its existing CLI path without sending public queue entries there", async () => {
  const db = await openDB(":memory:");
  try {
    await queueExplanations(db, [repo]);
    const local = {
      fullName: "local-skill:77777777-7777-4777-8777-777777777777",
      description: "Local inventory assistant metadata",
    };
    await db.run("INSERT INTO explanation_requests VALUES(?,?,?,?)", [
      local.fullName,
      explanationHash(local),
      JSON.stringify(local),
      new Date().toISOString(),
    ]);
    await explainMissing(db, {
      localMetadataOnly: true,
      translator: async (inputs) => {
        assert.deepEqual(
          inputs.map((r) => r.fullName),
          [local.fullName],
        );
        return [{ ...guide, fullName: local.fullName }];
      },
    });
    assert.equal(
      (await db.all("SELECT full_name FROM explanation_requests"))[0].full_name,
      "shop/report",
    );
    assert.equal(
      (await db.all("SELECT full_name FROM repo_explanations"))[0].full_name,
      local.fullName,
    );
  } finally {
    await db.close();
  }
});
