import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import {
  ExplanationJobs,
  queueExplanations,
} from "../src/server/explanation-jobs.ts";
import {
  explanationHash,
  saveExplanations,
} from "../src/server/explanations.ts";
const repo = { fullName: "shop/report", description: "Inventory report tool" },
  at = Date.parse("2026-10-26T03:00:00Z");
const guide = (titleZh = "库存报表工具") => ({
  fullName: repo.fullName,
  titleZh,
  summaryZh: "用于库存报表的工具。",
  useZh: "整理导出的库存报表。",
});
const finish = (job: any, title?: string) => ({
  status: "succeeded",
  attemptToken: job.attemptToken,
  items: job.inputs.map((r: any) => ({
    ...guide(title),
    fullName: r.fullName,
    sourceHash: r.sourceHash,
  })),
});
async function device(db: any, id: string) {
  await db.run("INSERT INTO devices VALUES(?,?,?,0,?,?)", [
    id,
    id,
    id,
    new Date(at).toISOString(),
    new Date(at).toISOString(),
  ]);
}
test("Chinese results are bound to the claiming device, token, and exact description version; existing text wins", async () => {
  const db = await openDB(":memory:");
  const q = new ExplanationJobs(db, () => at);
  try {
    await device(db, "one");
    await device(db, "two");
    await queueExplanations(db, [repo, repo]);
    const job = await q.claim("one");
    assert.ok(job);
    assert.equal(job.inputs.length, 1);
    assert.equal(await q.claim("two"), null);
    await assert.rejects(() => q.complete("two", job.id, finish(job)));
    await assert.rejects(() =>
      q.complete("one", job.id, {
        ...finish(job),
        attemptToken: "00000000-0000-4000-8000-000000000000",
      }),
    );
    const wrong = finish(job);
    wrong.items[0].sourceHash = "0".repeat(64);
    await assert.rejects(() => q.complete("one", job.id, wrong));
    const english = finish(job);
    english.items[0].titleZh = "English only";
    await assert.rejects(() => q.complete("one", job.id, english));
    await saveExplanations(db, [repo], [guide("手动整理的中文介绍")]);
    await q.complete("one", job.id, finish(job));
    await q.complete("one", job.id, finish(job, "重复回传不能覆盖"));
    assert.equal(
      JSON.parse(
        (
          await db.get(
            "SELECT payload FROM repo_explanation_versions WHERE full_name=? AND source_hash=?",
            [repo.fullName, explanationHash(repo)],
          )
        ).payload,
      ).titleZh,
      "手动整理的中文介绍",
    );
    assert.equal(
      (await db.all("SELECT * FROM explanation_requests")).length,
      0,
    );
    assert.equal((await db.all("SELECT * FROM install_jobs")).length, 0);
    await queueExplanations(db, [repo]);
    assert.equal(await q.claim("one"), null);
    const changed = {
      ...repo,
      description: "Updated inventory and profit tool",
    };
    await queueExplanations(db, [changed]);
    const next = await q.claim("one");
    assert.ok(next);
    assert.notEqual(next.inputs[0].sourceHash, job.inputs[0].sourceHash);
    await q.complete("one", next.id, finish(next, "新版利润工具"));
    assert.equal(
      (
        await db.all(
          "SELECT * FROM repo_explanation_versions WHERE full_name=?",
          [repo.fullName],
        )
      ).length,
      2,
    );
  } finally {
    await db.close();
  }
});
test("expired or revoked claims cannot write; failures retain metadata and pause generation across devices", async () => {
  const db = await openDB(":memory:");
  let now = at;
  const q = new ExplanationJobs(db, () => now);
  try {
    await device(db, "one");
    await device(db, "two");
    await queueExplanations(db, [repo]);
    const old = await q.claim("one");
    assert.ok(old);
    now += 360001;
    const job = await q.claim("two");
    assert.ok(job);
    await assert.rejects(() => q.complete("one", old.id, finish(old)));
    await db.run("UPDATE devices SET revoked=1 WHERE id='two'");
    await assert.rejects(() => q.complete("two", job.id, finish(job)));
    await db.run("UPDATE devices SET revoked=0 WHERE id='two'");
    await q.complete("two", job.id, {
      status: "failed",
      attemptToken: job.attemptToken,
      message: "中文引擎暂时不可用",
    });
    assert.equal(await q.claim("one"), null);
    assert.equal(
      (await db.all("SELECT * FROM explanation_requests")).length,
      1,
    );
    assert.equal((await db.all("SELECT * FROM repo_explanations")).length, 0);
    now += 300001;
    assert.ok(await q.claim("one"));
  } finally {
    await db.close();
  }
});
test("a batch separates different versions of the same repository and excludes local skill content", async () => {
  const db = await openDB(":memory:");
  const q = new ExplanationJobs(db, () => at);
  try {
    await device(db, "one");
    await queueExplanations(db, [
      repo,
      { ...repo, description: "A changed description" },
      { fullName: "local-skill:private", description: "private instructions" },
      { fullName: "shop/report#skills/x", description: "skill instructions" },
    ]);
    const job = await q.claim("one");
    assert.ok(job);
    assert.equal(job.inputs.length, 1);
    assert.equal(
      (await db.all("SELECT * FROM explanation_requests")).length,
      2,
    );
    await q.complete("one", job.id, finish(job));
    const next = await q.claim("one");
    assert.ok(next);
    assert.notEqual(next.inputs[0].sourceHash, job.inputs[0].sourceHash);
  } finally {
    await db.close();
  }
});
test("a failing batch rotates behind newer projects and its items retry individually", async () => {
  const db = await openDB(":memory:");
  let now = at;
  const q = new ExplanationJobs(db, () => now);
  try {
    await device(db, "one");
    await queueExplanations(
      db,
      Array.from({ length: 21 }, (_, i) => ({
        fullName: "shop/item" + String(i).padStart(2, "0"),
        description: "Inventory reports",
      })),
    );
    await db.run("UPDATE explanation_requests SET requested_at=?", [
      new Date(at - 1000).toISOString(),
    ]);
    await db.run(
      "UPDATE explanation_requests SET requested_at=? WHERE full_name=?",
      [new Date(at - 500).toISOString(), "shop/item20"],
    );
    const first = await q.claim("one");
    assert.ok(first);
    assert.equal(first.inputs.length, 20);
    await q.complete("one", first.id, {
      status: "failed",
      attemptToken: first.attemptToken,
      message: "一个条目生成格式无效",
    });
    assert.equal(await q.claim("one"), null);
    now += 300001;
    const later = await q.claim("one");
    assert.ok(later);
    assert.deepEqual(
      later.inputs.map((x) => x.fullName),
      ["shop/item20"],
    );
    await q.complete("one", later.id, finish(later));
    const retry = await q.claim("one");
    assert.ok(retry);
    assert.equal(retry.inputs.length, 1);
    assert.equal(
      (await db.all("SELECT * FROM explanation_requests")).length,
      20,
    );
  } finally {
    await db.close();
  }
});
