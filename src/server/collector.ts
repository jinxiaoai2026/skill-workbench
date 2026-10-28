import { randomUUID } from "node:crypto";
import { queueExplanations } from "./explanation-jobs.ts";
import type { DB } from "./db.ts";
import { githubJSON } from "./github-query.ts";
import {
  parseTrending,
  type RepoEntry,
  type Snapshot,
} from "../core/trending.ts";
export const SOURCES = [
  "all",
  "python",
  "typescript",
  "javascript",
  "go",
  "rust",
  "java",
  "c",
  "c++",
  "c#",
  "php",
  "shell",
  "swift",
  "kotlin",
  "ruby",
  "dart",
  "vue",
  "html",
  "css",
  "jupyter-notebook",
];
export async function fetchHTML(url: string): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          "user-agent": "PersonalSkillWorkbench/0.1 (+GitHub Trending archive)",
          accept: "text/html",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error("GitHub HTTP " + r.status);
      return await r.text();
    } catch (e) {
      last = e;
      if (attempt < 2)
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw last;
}
async function enrich(db: DB, entry: RepoEntry, budget: { remaining: number }) {
  const cached = await db.get(
    "SELECT payload,fetched_at FROM repositories WHERE full_name=?",
    [entry.fullName],
  );
  let details: Partial<RepoEntry> = cached ? JSON.parse(cached.payload) : {};
  if (
    (!cached || Date.now() - Date.parse(cached.fetched_at) > 86400000) &&
    budget.remaining > 0
  ) {
    budget.remaining--;
    try {
      {
        const j = await githubJSON(db, "/repos/" + entry.fullName, {
          priority: "background",
        });
        details = {
          repoId: String(j.id),
          license: j.license?.spdx_id || null,
          updatedAt: j.pushed_at,
          topics: j.topics || [],
        };
        await db.run(
          "INSERT INTO repositories VALUES(?,?,?) ON CONFLICT(full_name) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
          [entry.fullName, JSON.stringify(details), new Date().toISOString()],
        );
      }
    } catch {
      /* Enrichment is optional; a valid original snapshot remains usable. */
    }
  }
  return { ...entry, ...details };
}
export async function collect(
  db: DB,
  options: {
    sources?: string[];
    fetcher?: (url: string) => Promise<string>;
    enrich?: boolean;
  } = {},
) {
  const owner = randomUUID(),
    started = new Date().toISOString();
  const acquired = await db.transaction(async (tx) => {
    await tx.run("DELETE FROM job_locks WHERE key=? AND expires_at<?", [
      "collection",
      started,
    ]);
    await tx.run(
      "INSERT INTO job_locks VALUES(?,?,?) ON CONFLICT(key) DO NOTHING",
      ["collection", owner, new Date(Date.now() + 900000).toISOString()],
    );
    return (
      (await tx.get("SELECT owner FROM job_locks WHERE key=?", ["collection"]))
        ?.owner === owner
    );
  });
  if (!acquired) return { skipped: true, reason: "采集任务正在运行" };
  const jobId = randomUUID(),
    results: {
      source: string;
      period: string;
      count?: number;
      error?: string;
    }[] = [];
  await db.run("INSERT INTO job_runs VALUES(?,?,?,?,?,?)", [
    jobId,
    "collection",
    started,
    null,
    "running",
    "{}",
  ]);
  try {
    const sources = options.sources || SOURCES,
      budget = { remaining: process.env.GITHUB_TOKEN ? 200 : 20 };
    const requests = [
      ...sources.map((source) => ({ source, period: "daily" })),
      { source: "all", period: "weekly" },
      { source: "all", period: "monthly" },
    ];
    for (const request of requests) {
      try {
        const path =
          request.source === "all"
            ? ""
            : "/" + encodeURIComponent(request.source);
        const url =
          "https://github.com/trending" + path + "?since=" + request.period;
        const html = await (options.fetcher || fetchHTML)(url);
        let entries = parseTrending(html);
        const previous = await db.get(
          "SELECT payload FROM snapshots WHERE source=? AND period=? ORDER BY collected_at DESC LIMIT 1",
          [request.source, request.period],
        );
        if (
          previous &&
          entries.length <
            Math.max(
              1,
              Math.floor(JSON.parse(previous.payload).entries.length * 0.35),
            )
        )
          throw new Error("解析数量较历史骤降，保留上一次有效快照并等待重试");
        if (options.enrich !== false) {
          const enriched = [];
          for (const entry of entries)
            enriched.push(await enrich(db, entry, budget));
          entries = enriched;
        }
        const snapshot: Snapshot = {
          id: randomUUID(),
          ...request,
          collectedAt: new Date().toISOString(),
          entries,
        };
        await db.run("INSERT INTO snapshots VALUES(?,?,?,?,?)", [
          snapshot.id,
          request.source,
          request.period,
          snapshot.collectedAt,
          JSON.stringify(snapshot),
        ]);
        await queueExplanations(db, entries).catch(() =>
          console.error("中文介绍排队未完成，连接器稍后会自动补查"),
        );
        results.push({ ...request, count: entries.length });
      } catch (e) {
        results.push({ ...request, error: (e as Error).message });
      }
      await db.run("UPDATE job_runs SET payload=? WHERE id=?", [
        JSON.stringify({ results }),
        jobId,
      ]);
    }
    const success = results.filter((r) => !r.error).length;
    const status =
      success === results.length ? "succeeded" : success ? "partial" : "failed";
    await db.run(
      "UPDATE job_runs SET ended_at=?,status=?,payload=? WHERE id=?",
      [
        new Date().toISOString(),
        status,
        JSON.stringify({ results, sourceSet: "languages-v1" }),
        jobId,
      ],
    );
    return { jobId, status, results };
  } catch (e) {
    await db.run(
      "UPDATE job_runs SET ended_at=?,status=?,payload=? WHERE id=?",
      [
        new Date().toISOString(),
        "failed",
        JSON.stringify({ error: (e as Error).message, results }),
        jobId,
      ],
    );
    throw e;
  } finally {
    await db.run("DELETE FROM job_locks WHERE key=? AND owner=?", [
      "collection",
      owner,
    ]);
  }
}
