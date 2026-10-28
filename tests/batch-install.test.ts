import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { InstallService } from "../src/server/installations.ts";
import { buildApp } from "../src/server/app.ts";

async function fixture(count = 3) {
  const db = await openDB(":memory:");
  await db.run(
    "INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)",
    ["mac", "Mac", "hash", new Date().toISOString()],
  );
  const catalog = {
    fullName: "o/collection",
    ref: "a".repeat(40),
    checkedAt: new Date().toISOString(),
    skills: Array.from({ length: count }, (_, i) => ({
      name: "skill-" + i,
      path: "skills/skill-" + i,
      fileCount: 1,
      totalBytes: 100,
    })),
  };
  await db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
    catalog.fullName,
    JSON.stringify(catalog),
    catalog.checkedAt,
  ]);
  const service = new InstallService(db);
  const request = {
    fullName: catalog.fullName,
    deviceId: "mac",
    skills: catalog.skills.map((s) => ({ path: s.path })),
  };
  return { db, service, request, catalog };
}
test("all three selected skills enqueue together with independent names and repeated submission reuses jobs", async () => {
  const f = await fixture();
  try {
    const input = {
      ...f.request,
      skills: f.request.skills.map((s, i) => ({
        ...s,
        customName: "我的技能" + i,
      })),
    };
    const result = await (f.service as any).enqueueBatch(input);
    assert.equal(result.items.length, 3);
    assert.equal(new Set(result.items.map((i: any) => i.job.id)).size, 3);
    const again = await (f.service as any).enqueueBatch(input);
    assert.deepEqual(
      again.items.map((i: any) => i.job.id),
      result.items.map((i: any) => i.job.id),
    );
    const names = [];
    for (let i = 0; i < 3; i++) {
      const job = await f.service.claim("mac");
      names.push(job.customName);
      await f.service.complete("mac", job.id, {
        status: "succeeded",
        installedName: job.name,
        customName: job.customName,
        attemptToken: job.attemptToken,
      });
    }
    assert.deepEqual(names.sort(), ["我的技能0", "我的技能1", "我的技能2"]);
    assert.equal((await f.db.all("SELECT * FROM installed_skills")).length, 3);
    assert.equal((await f.db.all("SELECT * FROM invocations")).length, 0);
    assert.equal(await f.service.claim("mac"), null);
  } finally {
    await f.db.close();
  }
});
test("already installed skills are skipped without changing their custom invocation names", async () => {
  const f = await fixture();
  try {
    await f.db.run("INSERT INTO installed_skills VALUES(?,?,?,?,?,?,?)", [
      "mac",
      "o/collection",
      "skills/skill-0",
      f.catalog.ref,
      "skill-0",
      null,
      new Date().toISOString(),
    ]);
    await f.db.run("INSERT INTO skill_aliases VALUES(?,?,?,?,?)", [
      "mac",
      "o/collection",
      "skills/skill-0",
      "已有调用名",
      new Date().toISOString(),
    ]);
    const result = await (f.service as any).enqueueBatch(f.request);
    assert.equal(result.items[0].status, "installed");
    assert.equal((await f.db.all("SELECT * FROM install_jobs")).length, 2);
    assert.equal(
      (await f.db.get("SELECT custom_name FROM skill_aliases")).custom_name,
      "已有调用名",
    );
  } finally {
    await f.db.close();
  }
});
test("invalid paths and conflicting batch names leave no partly queued batch", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() =>
      (f.service as any).enqueueBatch({
        ...f.request,
        skills: [{ path: "skills/skill-0" }, { path: "../outside" }],
      }),
    );
    await assert.rejects(
      () =>
        (f.service as any).enqueueBatch({
          ...f.request,
          skills: [
            { path: "skills/skill-0", customName: "同名" },
            { path: "skills/skill-1", customName: "同名" },
          ],
        }),
      /同名/,
    );
    assert.equal((await f.db.all("SELECT * FROM install_jobs")).length, 0);
    await assert.rejects(
      () =>
        (f.service as any).enqueueBatch({
          ...f.request,
          skills: [f.request.skills[0], f.request.skills[0]],
        }),
      /重复/,
    );
    await assert.rejects(() =>
      (f.service as any).enqueueBatch({ ...f.request, deviceId: "unknown" }),
    );
  } finally {
    await f.db.close();
  }
});
test("batch progress includes older jobs outside the global100 and exposes no execution credentials", async () => {
  const f = await fixture(105);
  try {
    const batch = await (f.service as any).enqueueBatch(f.request);
    const claimed = await f.service.claim("mac");
    await f.service.complete("mac", claimed.id, {
      status: "failed",
      attemptToken: claimed.attemptToken,
      message: "测试失败",
    });
    const jobs = await (f.service as any).jobStatuses({
      ids: batch.items.map((i: any) => i.job.id),
    });
    assert.equal(jobs.length, 105);
    assert.equal(jobs.find((j: any) => j.id === claimed.id).status, "failed");
    assert.equal(
      jobs.some((j: any) => j.payload || j.attemptToken),
      false,
    );
  } finally {
    await f.db.close();
  }
});
test("batch install and progress endpoints require owner authentication", async () => {
  const f = await fixture();
  const app = await buildApp({
    db: f.db,
    sessionKey: Buffer.alloc(32, 9),
    password: "batch-test-password",
    origin: "http://localhost",
    allowCollection: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "batch-test-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/install/batch",
          payload: f.request,
        })
      ).statusCode,
      401,
    );
    const result = await app.inject({
      method: "POST",
      url: "/api/install/batch",
      payload: f.request,
      headers: { cookie },
    });
    assert.equal(result.statusCode, 200);
    const ids = result.json().items.map((i: any) => i.job.id);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/install/status",
          payload: { ids },
        })
      ).statusCode,
      401,
    );
    const status = await app.inject({
      method: "POST",
      url: "/api/install/status",
      payload: { ids },
      headers: { cookie },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().length, 3);
  } finally {
    await app.close();
    await f.db.close();
  }
});
test("one failed skill does not stop the other jobs and only failed items create new retry jobs", async () => {
  const f = await fixture();
  try {
    const batch = await f.service.enqueueBatch(f.request);
    const first = await f.service.claim("mac");
    await f.service.complete("mac", first.id, {
      status: "failed",
      attemptToken: first.attemptToken,
      message: "隔离失败示例",
    });
    for (let i = 0; i < 2; i++) {
      const next = await f.service.claim("mac");
      await f.service.complete("mac", next.id, {
        status: "succeeded",
        installedName: next.name,
        attemptToken: next.attemptToken,
      });
    }
    const statuses = await f.service.jobStatuses({
      ids: batch.items.flatMap((i) => (i.job ? [i.job.id] : [])),
    });
    assert.equal(
      statuses.filter((s: any) => s.status === "succeeded").length,
      2,
    );
    assert.equal(statuses.filter((s: any) => s.status === "failed").length, 1);
    const retry = await f.service.enqueueBatch({
      ...f.request,
      skills: [{ path: first.path }],
    });
    assert.notEqual(retry.items[0].job!.id, first.id);
    assert.equal((await f.db.all("SELECT * FROM install_jobs")).length, 4);
    const repeatedAll = await f.service.enqueueBatch(f.request);
    assert.equal(
      repeatedAll.items.filter((i) => i.status === "installed").length,
      2,
    );
    assert.equal((await f.db.all("SELECT * FROM install_jobs")).length, 4);
  } finally {
    await f.db.close();
  }
});
