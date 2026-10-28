import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { collect } from "../src/server/collector.ts";
import { archiveRange } from "../src/server/jobs.ts";
const page = `<article class="Box-row"><h2><a href="/a/b">a/b</a></h2><p>Chinese text-to-speech</p><a data-hydro-click='{&quot;payload&quot;:{&quot;repository_id&quot;:123}}'></a><a href="/a/b/stargazers">100</a></article>`;
test("live collector contract preserves valid snapshots on failure and reports partial source coverage", async () => {
  const db = await openDB(":memory:");
  try {
    const first = await collect(db, {
      sources: ["all"],
      enrich: false,
      fetcher: async () => page,
    });
    assert.equal((first as any).status, "succeeded");
    const fail = await collect(db, {
      sources: ["all"],
      enrich: false,
      fetcher: async (url) =>
        url.includes("weekly") ? page : "<h1>Rate limit</h1>",
    });
    assert.equal((fail as any).status, "partial");
    const snapshots = await db.all("SELECT * FROM snapshots");
    assert.equal(snapshots.length, 4);
    assert.equal(JSON.parse(snapshots[0].payload).entries[0].repoId, "123");
    const jobs = await db.all("SELECT * FROM job_runs ORDER BY started_at");
    assert.equal(jobs.length, 2);
    assert.equal(
      JSON.parse(jobs[1].payload).results.filter((r: any) => r.error).length,
      2,
    );
  } finally {
    await db.close();
  }
});
test("archives are stable and create a new revision only when underlying ranked data changes", async () => {
  const db = await openDB(":memory:");
  try {
    const snapshot = {
      id: "s1",
      source: "all",
      period: "daily",
      collectedAt: "2026-10-23T12:00:00Z",
      entries: [
        {
          repoId: "123",
          fullName: "a/b",
          url: "https://github.com/a/b",
          description: "",
          language: "",
          stars: 100,
          periodStars: 10,
        },
      ],
    };
    await db.run("INSERT INTO snapshots VALUES(?,?,?,?,?)", [
      snapshot.id,
      snapshot.source,
      snapshot.period,
      snapshot.collectedAt,
      JSON.stringify(snapshot),
    ]);
    await archiveRange(db, "daily", "2026-10-23", "2026-10-23");
    await archiveRange(db, "daily", "2026-10-23", "2026-10-23");
    assert.equal((await db.all("SELECT id FROM archives")).length, 1);
    assert.equal(
      await archiveRange(db, "daily", "2026-10-22", "2026-10-22"),
      false,
    );
  } finally {
    await db.close();
  }
});
