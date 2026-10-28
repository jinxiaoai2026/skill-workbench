import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { CatalogTasks } from "../src/server/catalog-tasks.ts";
import { getCatalog, getSkillPage } from "../src/server/catalog.ts";
const at = Date.parse("2026-10-25T10:00:00Z");
const result = (attemptToken: string) => ({
  attemptToken,
  status: "succeeded",
  ref: "a".repeat(40),
  omittedVariants: 2,
  skills: [
    {
      path: "skills/design",
      name: "design",
      fileCount: 2,
      totalBytes: null,
      manifest: { name: "design", description: "Design a frontend page" },
    },
  ],
});
test("online connector catalog is deduplicated, pinned, and cached without any cloud GitHub request", async () => {
  const db = await openDB(":memory:");
  let now = at;
  const q = new CatalogTasks(db, () => now);
  try {
    for (const id of ["one", "two"])
      await db.run("INSERT INTO devices VALUES(?,?,?,0,?,?)", [
        id,
        id,
        id,
        new Date(at).toISOString(),
        new Date(at).toISOString(),
      ]);
    assert.equal(await q.claim("one"), null);
    for (let n = 0; n < 2; n++)
      await assert.rejects(
        () => getCatalog(db, "spec/repo", { now: () => now }),
        (e: any) => e.code === "CATALOG_PENDING",
      );
    assert.equal((await db.all("SELECT * FROM catalog_tasks")).length, 1);
    assert.equal(await q.claim("two"), null);
    const job = await q.claim("one");
    assert.ok(job);
    assert.equal(await q.claim("one"), null);
    await assert.rejects(() =>
      q.complete("two", job.id, result(job.attemptToken)),
    );
    await assert.rejects(() =>
      q.complete("one", job.id, result("00000000-0000-4000-8000-000000000000")),
    );
    await q.complete("one", job.id, result(job.attemptToken));
    await assert.rejects(() =>
      q.complete("one", job.id, result(job.attemptToken)),
    );
    const catalog = await getCatalog(db, "spec/repo", { now: () => now });
    assert.equal(catalog.source, "device-git");
    assert.equal(catalog.ref, "a".repeat(40));
    const page = await getSkillPage(
      db,
      { repo: "spec/repo" },
      {
        translator: async () => {
          throw new Error("offline");
        },
      },
    );
    assert.equal(page.items[0].manifestName, "design");
    assert.equal((await db.all("SELECT * FROM install_jobs")).length, 0);
    now += 31000;
    await assert.rejects(
      () => getCatalog(db, "spec/repo", { now: () => now, forceRefresh: true }),
      (e: any) => e.code === "CATALOG_PENDING",
    );
    const next = await q.claim("one");
    assert.ok(next);
    assert.notEqual(next.attemptToken, job.attemptToken);
    now += 61000;
    await assert.rejects(() =>
      q.complete("one", next.id, result(next.attemptToken)),
    );
    const replay = await q.claim("one");
    assert.ok(replay);
    assert.notEqual(replay.attemptToken, next.attemptToken);
    const invalid = result(replay.attemptToken);
    invalid.skills[0].path = "../escape";
    await assert.rejects(() => q.complete("one", replay.id, invalid));
    await db.run("UPDATE devices SET revoked=1 WHERE id=?", ["one"]);
    await assert.rejects(() =>
      q.complete("one", replay.id, result(replay.attemptToken)),
    );
  } finally {
    await db.close();
  }
});
test("capability expires; download cooldown is shared and force refresh cannot bypass it", async () => {
  const db = await openDB(":memory:");
  let now = at;
  const q = new CatalogTasks(db, () => now);
  try {
    await db.run("INSERT INTO devices VALUES(?,?,?,0,?,?)", [
      "one",
      "Mac",
      "hash",
      new Date(at).toISOString(),
      new Date(at).toISOString(),
    ]);
    await q.claim("one", at + 120000);
    await assert.rejects(
      () => q.request("spec/repo"),
      (e: any) => e.code === "GITHUB_RATE_LIMITED",
    );
    now += 61000;
    await assert.rejects(
      () => q.request("spec/repo"),
      (e: any) => e.code === "GITHUB_RATE_LIMITED",
    );
    assert.equal(await q.claim("one"), null);
    await assert.rejects(
      () => q.request("spec/repo"),
      (e: any) => e.code === "GITHUB_RATE_LIMITED",
    );
    now += 61000;
    // Capability expires independently of the earlier rate-limit hold.
    assert.equal(await q.request("spec/repo"), false);
    await q.claim("one");
    await assert.rejects(
      () => q.request("spec/repo"),
      (e: any) => e.code === "CATALOG_PENDING",
    );
    const job = await q.claim("one");
    assert.ok(job);
    await q.complete("one", job.id, {
      attemptToken: job.attemptToken,
      status: "failed",
      message: "GitHub 下载暂时限流",
      errorCode: "GIT_RATE_LIMITED",
      retryAt: new Date(now + 60000).toISOString(),
    });
    await assert.rejects(
      () => q.request("spec/other"),
      (e: any) => e.code === "GITHUB_RATE_LIMITED",
    );
  } finally {
    await db.close();
  }
});
test("refresh preserves an existing mixed-case repository cache key and replaces its old preview", async () => {
  const db = await openDB(":memory:");
  const q = new CatalogTasks(db, () => at);
  try {
    const old = {
      fullName: "Spec/Repo",
      ref: "b".repeat(40),
      skills: [],
      checkedAt: new Date(at - 40000).toISOString(),
      source: "github-api",
    };
    await db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
      old.fullName,
      JSON.stringify(old),
      old.checkedAt,
    ]);
    await db.run("INSERT INTO devices VALUES(?,?,?,0,?,?)", [
      "one",
      "Mac",
      "hash",
      new Date(at).toISOString(),
      new Date(at).toISOString(),
    ]);
    await q.claim("one");
    await assert.rejects(
      () => getCatalog(db, "Spec/Repo", { now: () => at, forceRefresh: true }),
      (e: any) => e.code === "CATALOG_PENDING",
    );
    const job = await q.claim("one");
    assert.ok(job);
    await q.complete("one", job.id, result(job.attemptToken));
    const catalog = await getCatalog(db, "Spec/Repo", { now: () => at });
    assert.equal(catalog.source, "device-git");
    assert.equal((await db.all("SELECT * FROM skill_catalogs")).length, 1);
  } finally {
    await db.close();
  }
});
