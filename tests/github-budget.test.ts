import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { githubJSON } from "../src/server/github-query.ts";
import { collect } from "../src/server/collector.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const at = Date.parse("2026-10-25T09:00:00Z"),
  reset = at + 3600000;
const response = (remaining: number) =>
  Response.json(
    { ok: true, id: 1, topics: [], license: null },
    {
      headers: {
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-limit": "60",
        "x-ratelimit-reset": String(reset / 1000),
      },
    },
  );
test("optional metadata preserves the last ten API requests for interactive use", async () => {
  const db = await openDB(":memory:");
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return response(calls === 1 ? 10 : 9);
  };
  try {
    await githubJSON(db, "/repos/spec/first", { now: () => at, fetcher });
    await assert.rejects(
      () =>
        githubJSON(db, "/repos/spec/background", {
          now: () => at,
          fetcher,
          priority: "background",
        } as any),
      (e: any) => e.code === "GITHUB_RESERVED",
    );
    await githubJSON(db, "/repos/spec/interactive", { now: () => at, fetcher });
    assert.equal(calls, 2);
  } finally {
    await db.close();
  }
});
test("concurrent optional lookups cannot both consume the final unreserved request", async () => {
  const db = await openDB(":memory:");
  let calls = 0;
  await db.run("INSERT INTO meta VALUES(?,?)", [
    "github-api-budget",
    JSON.stringify({
      remaining: 11,
      limit: 60,
      resetAt: new Date(reset).toISOString(),
    }),
  ]);
  const fetcher = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return response(10);
  };
  try {
    const result = await Promise.allSettled(
      [1, 2].map((n) =>
        githubJSON(db, "/repos/spec/" + n, {
          now: () => at,
          fetcher,
          priority: "background",
        } as any),
      ),
    );
    assert.equal(result.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});
test("successful zero remaining responses stop further requests until the genuine reset", async () => {
  const db = await openDB(":memory:");
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return response(0);
  };
  try {
    await githubJSON(db, "/repos/spec/last", { now: () => at, fetcher });
    await assert.rejects(
      () => githubJSON(db, "/repos/spec/no", { now: () => at + 1000, fetcher }),
      (e: any) => e.code === "GITHUB_RATE_LIMITED",
    );
    assert.equal(calls, 1);
    await githubJSON(db, "/repos/spec/recovered", {
      now: () => reset + 1000,
      fetcher,
    });
    assert.equal(calls, 2);
  } finally {
    await db.close();
  }
});
test("the collector respects a previously observed installation cooldown while retaining valid snapshots", async () => {
  const db = await openDB(":memory:"),
    original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-limit": "60",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  };
  const html =
    '<article class="Box-row"><h2><a href="/spec/real">spec/real</a></h2><p>Actual project</p><a href="/spec/real/stargazers">100</a></article>';
  try {
    await assert.rejects(() => githubJSON(db, "/repos/spec/limited"));
    const result = await collect(db, {
      sources: ["all"],
      fetcher: async () => html,
    });
    assert.equal((result as any).status, "succeeded");
    assert.equal(calls, 1);
    assert.equal((await db.all("SELECT * FROM snapshots")).length, 3);
  } finally {
    globalThis.fetch = original;
    await db.close();
  }
});
test("separate app and worker connections cannot overwrite a newer lower budget or consume its reserve", async () => {
  const root = mkdtempSync(join(tmpdir(), "github-shared-budget-")),
    path = join(root, "db.sqlite");
  const app = await openDB(path),
    worker = await openDB(path);
  await app.run("INSERT INTO meta VALUES(?,?)", [
    "github-api-budget",
    JSON.stringify({
      remaining: 12,
      limit: 60,
      resetAt: new Date(reset).toISOString(),
    }),
  ]);
  let started!: () => void;
  const began = new Promise<void>((r) => (started = r));
  let calls = 0;
  try {
    const slow = githubJSON(worker, "/repos/spec/worker", {
      now: () => at,
      fetcher: async () => {
        calls++;
        started();
        await new Promise((r) => setTimeout(r, 80));
        return response(11);
      },
    });
    await began;
    const fast = githubJSON(app, "/repos/spec/app", {
      now: () => at,
      fetcher: async () => {
        calls++;
        return response(10);
      },
    });
    await Promise.all([slow, fast]);
    const row = await app.get("SELECT value FROM meta WHERE key=?", [
      "github-api-budget",
    ]);
    assert.equal(JSON.parse(row!.value).remaining, 10);
    await assert.rejects(
      () =>
        githubJSON(worker, "/repos/spec/background", {
          now: () => at,
          priority: "background",
          fetcher: async () => {
            calls++;
            return response(9);
          },
        }),
      (e: any) => e.code === "GITHUB_RESERVED",
    );
    assert.equal(calls, 2);
  } finally {
    await app.close();
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
