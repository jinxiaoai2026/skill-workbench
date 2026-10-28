import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { InstallService } from "../src/server/installations.ts";
import {
  saveExplanations,
  explainMissing,
} from "../src/server/explanations.ts";
import { Service } from "../src/server/service.ts";
const guide = (r: { fullName: string; description?: string }) => ({
  fullName: r.fullName,
  titleZh: "项目中文说明",
  summaryZh: "根据所选描述生成的中文用途：" + r.description,
  useZh: "用于完成项目描述中的工作。",
});
test("stale install claim cannot override the current successful attempt", async () => {
  const db = await openDB(":memory:");
  try {
    await db.run(
      "INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)",
      ["mac", "Mac", "hash", new Date().toISOString()],
    );
    const catalog = {
      fullName: "o/r",
      ref: "a".repeat(40),
      skills: [{ name: "a", path: "skills/a", fileCount: 1, totalBytes: 100 }],
      checkedAt: new Date().toISOString(),
    };
    await db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
      catalog.fullName,
      JSON.stringify(catalog),
      catalog.checkedAt,
    ]);
    const s = new InstallService(db),
      job = await s.enqueue({
        fullName: "o/r",
        path: "skills/a",
        deviceId: "mac",
      });
    const first = await s.claim("mac");
    await db.run("UPDATE install_jobs SET lease_until=? WHERE id=?", [
      "2000-01-01T00:00:00Z",
      job.id,
    ]);
    const second = await s.claim("mac");
    await assert.rejects(() =>
      s.complete("mac", job.id, {
        attemptToken: first.attemptToken,
        status: "failed",
        message: "old",
      }),
    );
    await s.complete("mac", job.id, {
      attemptToken: second.attemptToken,
      status: "succeeded",
      installedName: "a",
    });
    assert.equal(
      (await db.get("SELECT status FROM install_jobs WHERE id=?", [job.id]))
        .status,
      "succeeded",
    );
  } finally {
    await db.close();
  }
});
test("Chinese generation covers bookmark-only projects outside the recent snapshot window", async () => {
  const db = await openDB(":memory:");
  try {
    const repo = {
      fullName: "saved/old",
      description: "An inventory planning tool",
    };
    await db.run("INSERT INTO bookmarks VALUES(?,?,?)", [
      repo.fullName,
      JSON.stringify(repo),
      new Date().toISOString(),
    ]);
    const result = await explainMissing(db, {
      translator: async (repos) => repos.map(guide),
    });
    assert.equal(result.completed, 1);
    const data = await new Service(db).state();
    assert.ok(data.bookmarks[0].guide);
    assert.match(data.bookmarks[0].guide.summaryZh, /中文用途/);
  } finally {
    await db.close();
  }
});
test("old bookmarked descriptions retain their Chinese guide when current project descriptions change", async () => {
  const db = await openDB(":memory:");
  try {
    const old = { fullName: "o/r", description: "Old reporting tool" },
      updated = { ...old, description: "New reporting tool" };
    await db.run("INSERT INTO bookmarks VALUES(?,?,?)", [
      old.fullName,
      JSON.stringify(old),
      new Date().toISOString(),
    ]);
    await saveExplanations(db, [old], [guide(old)]);
    await saveExplanations(db, [updated], [guide(updated)]);
    const result = await new Service(db).state();
    assert.ok(result.bookmarks[0].guide);
    assert.match(result.bookmarks[0].guide.summaryZh, /Old reporting/);
  } finally {
    await db.close();
  }
});

test("individual skill purposes come from the actual pinned manifest including multiline descriptions", async () => {
  const { parseSkillManifest } = await import("../src/server/catalog.ts");
  const data = parseSkillManifest(
    "---\nname: analyze\ndescription: >\n  Review customer support tickets\n  and identify unresolved refund requests.\n---\nUntrusted instructions below.",
  );
  assert.equal(data.name, "analyze");
  assert.equal(
    data.description,
    "Review customer support tickets and identify unresolved refund requests.\n",
  );
  assert.throws(() =>
    parseSkillManifest("---\nname: invalid\n---\nNo description"),
  );
});

test("viewing an older snapshot requests its missing Chinese explanation outside the recent scan window", async () => {
  const db = await openDB(":memory:");
  try {
    const old = {
      fullName: "old/repo",
      description: "Old saved inventory project",
      repoId: "old",
      url: "https://github.com/old/repo",
      language: "",
      stars: 10,
      periodStars: 1,
    };
    const older = {
      id: "older",
      source: "all",
      period: "daily",
      collectedAt: "2025-01-01T02:00:00Z",
      entries: [old],
    };
    await db.run("INSERT INTO snapshots VALUES(?,?,?,?,?)", [
      older.id,
      older.source,
      older.period,
      older.collectedAt,
      JSON.stringify(older),
    ]);
    for (let i = 0; i < 121; i++) {
      const s = {
        ...older,
        id: "new-" + i,
        collectedAt: new Date(
          Date.parse("2026-10-24T01:00:00Z") + i * 1000,
        ).toISOString(),
        entries: [
          {
            ...old,
            fullName: "recent/repo",
            description: "Recent project",
            repoId: "new",
          },
        ],
      };
      await db.run("INSERT INTO snapshots VALUES(?,?,?,?,?)", [
        s.id,
        s.source,
        s.period,
        s.collectedAt,
        JSON.stringify(s),
      ]);
    }
    const service = new Service(db);
    await service.state({
      range: "custom",
      from: "2025-01-01",
      to: "2025-01-01",
    });
    const requested = await db.get(
      "SELECT * FROM explanation_requests WHERE full_name=?",
      [old.fullName],
    );
    assert.ok(requested);
    await explainMissing(db, { translator: async (repos) => repos.map(guide) });
    const state = await service.state({
      range: "custom",
      from: "2025-01-01",
      to: "2025-01-01",
    });
    assert.ok(state.trending.ranked[0].guide);
    assert.match(
      state.trending.ranked[0].guide.summaryZh,
      /Old saved inventory/,
    );
  } finally {
    await db.close();
  }
});
