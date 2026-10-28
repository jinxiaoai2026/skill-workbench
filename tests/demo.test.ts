import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { seedDemo } from "../src/server/demo.ts";
import { Service } from "../src/server/service.ts";

test("explicit demo seed produces useful fictional records without real devices, content, or cloud keys", async () => {
  const db = await openDB(":memory:");
  try {
    await seedDemo(db);
    const state = await new Service(db).state({ range: "30d" });
    assert.equal(state.skills.length, 8);
    assert.equal(state.devices.length, 1);
    assert.equal(state.devices[0].name, "演示设备（非真实连接）");
    assert.ok(state.usage.confirmed > 0);
    assert.equal(state.trending.coveredDays, 5);
    assert.equal(state.trending.ranked.length, 8);
    assert.ok(
      state.trending.ranked.every(
        (r) => r.fullName.startsWith("demo-lab/") && r.guide?.titleZh,
      ),
    );
    assert.equal(
      state.skills.some((s) => s.content),
      false,
    );
    assert.equal(
      (await db.all("SELECT * FROM meta WHERE key='cloud-chinese-config-v1'"))
        .length,
      0,
    );
    const again = await seedDemo(db);
    assert.equal(again.reused, true);
    assert.equal(
      (await new Service(db).state({ range: "30d" })).usage.confirmed,
      state.usage.confirmed,
    );
  } finally {
    await db.close();
  }
});

test("demo seed refuses a nonempty non-demo database and preserves existing records", async () => {
  const db = await openDB(":memory:");
  try {
    await new Service(db).saveSkill({
      name: "Keep existing skill",
      ownership: "original",
    });
    const before = await db.all("SELECT * FROM skills");
    await assert.rejects(seedDemo(db), /空库|演示/);
    assert.deepEqual(await db.all("SELECT * FROM skills"), before);
    assert.equal((await db.all("SELECT * FROM snapshots")).length, 0);
  } finally {
    await db.close();
  }
});

test("demo HTTP routes reject ordinary and encoded mutation/catalog paths without exposing real settings", async () => {
  const db = await openDB(":memory:");
  await seedDemo(db);
  const { buildDemoApp } = await import("../src/server/demo.ts");
  const app = await buildDemoApp({
    db,
    sessionKey: Buffer.alloc(32, 22),
    password: "demo-test-password",
    origin: "http://localhost:4325",
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "demo-test-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const state = await app.inject({ url: "/api/state", headers: { cookie } });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().demo, true);
    for (const url of [
      "/api/pairings",
      "/%61pi/pairings",
      "/api/settings/chinese",
      "/%61pi/settings/chinese",
      "/api/settings/chinese/test",
    ])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { cookie },
            payload: {},
          })
        ).statusCode,
        403,
        url,
      );
    for (const url of [
      "/api/catalog?repo=demo-lab/tool",
      "/api/%63atalog?repo=demo-lab/tool",
      "/%61pi/catalog?repo=demo-lab/tool",
    ]) {
      assert.equal(
        (await app.inject({ url, headers: { cookie } })).statusCode,
        403,
        url,
      );
      assert.equal(
        (await app.inject({ method: "HEAD", url, headers: { cookie } }))
          .statusCode,
        403,
        url,
      );
    }
    assert.equal((await db.all("SELECT * FROM pairings")).length, 0);
    assert.equal(
      (await db.all("SELECT * FROM meta WHERE key='cloud-chinese-config-v1'"))
        .length,
      0,
    );
    assert.equal((await db.all("SELECT * FROM install_jobs")).length, 0);
  } finally {
    await app.close();
    await db.close();
  }
});
