import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDB } from "../src/server/db.ts";
import { Service } from "../src/server/service.ts";
import { Connector } from "../connector/registry.ts";
import { runManaged } from "../connector/runner.ts";
test("web name description and ownership edits survive unchanged connector heartbeats", async () => {
  const db = await openDB(":memory:");
  const service = new Service(db);
  try {
    const { code } = await service.createPairing();
    const device = await service.pair({ code, name: "Test" });
    const skill = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "source-name",
      description: "Source description",
      ownership: "original",
      version: "v1",
    };
    await service.ingest(device.deviceId, { skills: [skill], events: [] });
    await service.saveSkill(
      { name: "我的显示名称", description: "我写的说明", ownership: "derived" },
      skill.id,
    );
    await service.ingest(device.deviceId, { skills: [skill], events: [] });
    const saved = (await service.state()).skills[0];
    assert.equal(saved.name, "我的显示名称");
    assert.equal(saved.description, "我写的说明");
    assert.equal(saved.ownership, "derived");
    assert.equal(saved.codexName, "source-name");
  } finally {
    await db.close();
  }
});
test("managed execution refreshes the registered file and records its new version without changing ID or content opt-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-refresh-"));
  const dir = join(root, "skill");
  mkdirSync(dir);
  const path = join(dir, "SKILL.md");
  writeFileSync(path, "---\nname: before\ndescription: Before\n---\nV1");
  const c = new Connector(join(root, "connector"));
  try {
    const first = c.adopt(dir, "original", undefined, true);
    writeFileSync(path, "---\nname: after\ndescription: After\n---\nV2");
    await runManaged(c, first.id, process.execPath, ["-e", "process.exit(0)"]);
    const changed = c.skills()[0];
    assert.equal(changed.id, first.id);
    assert.equal(changed.name, "after");
    assert.notEqual(changed.version, first.version);
    assert.equal(changed.syncContent, true);
    assert.match(changed.content || "", /V2/);
    assert.equal(c.pending()[0].version, changed.version);
  } finally {
    c.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("archive pagination and month filters expose old months and all saved revisions", async () => {
  const db = await openDB(":memory:");
  const service = new Service(db);
  try {
    for (let i = 0; i < 45; i++)
      await db.run("INSERT INTO archives VALUES(?,?,?,?,?,?,?)", [
        "archive-" + i,
        "daily",
        i === 0 ? "2025-01-01" : "2026-10-01",
        i === 0 ? "2025-01-01" : "2026-10-01",
        "trending-v1",
        "{}",
        new Date(1700000000000 + i * 1000).toISOString(),
      ]);
    const first = await service.listArchives({});
    assert.equal(first.items.length, 36);
    assert.equal(first.hasMore, true);
    const second = await service.listArchives({ offset: "36" });
    assert.equal(second.items.length, 9);
    assert.equal(second.items.at(-1)?.id, "archive-0");
    const old = await service.listArchives({ month: "2025-01" });
    assert.equal(old.items.length, 1);
    assert.equal(old.items[0].id, "archive-0");
  } finally {
    await db.close();
  }
});
