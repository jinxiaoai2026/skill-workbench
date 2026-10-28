import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { Service } from "../src/server/service.ts";
import { SkillNameService } from "../src/server/skill-names.ts";

const id = "77777777-7777-4777-8777-777777777777";
async function fixture() {
  const db = await openDB(":memory:"),
    service = new Service(db),
    names = new SkillNameService(db);
  const p = await service.createPairing(),
    device = await service.pair({ code: p.code, name: "Mac" });
  const p2 = await service.createPairing(),
    other = await service.pair({ code: p2.code, name: "Other" });
  const skill = {
    id,
    name: "web-design-engineer",
    description:
      "Build polished websites and dashboards. Not for backend or videos.",
    ownership: "local",
    version: "a".repeat(16),
  };
  await service.ingest(device.deviceId, { skills: [skill], events: [] });
  return { db, service, names, device, other, skill };
}
test("existing uncategorized skills are automatically categorized and manual choices survive future sync", async () => {
  const f = await fixture();
  try {
    let entry = (await f.service.state()).skills[0];
    assert.equal(entry.category, "网页设计");
    assert.equal(entry.categoryMode, "auto");
    await f.service.saveSkill(
      { category: "内容制作", categoryMode: "manual", favorite: true },
      id,
    );
    await f.service.ingest(f.device.deviceId, {
      skills: [f.skill],
      events: [],
    });
    entry = (await f.service.state()).skills[0];
    assert.equal(entry.category, "内容制作");
    assert.equal(entry.favorite, true);
    await f.service.saveSkill({ categoryMode: "auto" }, id);
    assert.equal((await f.service.state()).skills[0].category, "网页设计");
  } finally {
    await f.db.close();
  }
});
test("editing launch name queues a device-bound job and exposes the new name only after confirmation", async () => {
  const f = await fixture();
  try {
    const saved = await f.service.saveSkill(
      { name: "网页设计助手", launchName: "店铺设计", categoryMode: "auto" },
      id,
    );
    assert.ok(saved.launchNameJob);
    assert.equal(saved.launchNameJob.status, "queued");
    assert.equal(
      (await f.service.state()).skills[0].codexName,
      "web-design-engineer",
    );
    assert.equal(await f.names.claim(f.other.deviceId), null);
    const job = await f.names.claim(f.device.deviceId);
    assert.ok(job);
    assert.equal(job.skillId, id);
    assert.equal(job.launchName, "店铺设计");
    assert.equal(job.sourceVersion, f.skill.version);
    assert.equal(JSON.stringify(job).includes("/Users/"), false);
    await assert.rejects(() =>
      f.names.complete(f.other.deviceId, job.id, {
        status: "succeeded",
        launchName: "店铺设计",
        sourceVersion: job.sourceVersion,
        attemptToken: job.attemptToken,
      }),
    );
    await f.names.complete(f.device.deviceId, job.id, {
      status: "succeeded",
      launchName: "店铺设计",
      sourceVersion: job.sourceVersion,
      attemptToken: job.attemptToken,
    });
    const state = await f.service.state();
    assert.equal(state.skills[0].codexName, "店铺设计");
    assert.equal(state.skills[0].name, "网页设计助手");
    assert.equal(state.usage.confirmed, 0);
    const status = await f.names.status(job.id);
    assert.equal(status.status, "succeeded");
    assert.equal("attemptToken" in status, false);
    assert.equal("attempt_token" in status, false);
  } finally {
    await f.db.close();
  }
});
test("failed or expired name jobs preserve prior launch names and fresh attempts can retry", async () => {
  const f = await fixture();
  try {
    const first = await f.names.enqueue({ skillId: id, launchName: "新名称" });
    assert.ok(first);
    const a = await f.names.claim(f.device.deviceId);
    assert.ok(a);
    await f.db.run("UPDATE skill_name_jobs SET lease_until=? WHERE id=?", [
      "2000-01-01T00:00:00Z",
      first.id,
    ]);
    const b = await f.names.claim(f.device.deviceId);
    assert.ok(b);
    await assert.rejects(() =>
      f.names.complete(f.device.deviceId, first.id, {
        status: "succeeded",
        launchName: "新名称",
        sourceVersion: a.sourceVersion,
        attemptToken: a.attemptToken,
      }),
    );
    await f.names.complete(f.device.deviceId, first.id, {
      status: "failed",
      message: "名称已被占用",
      attemptToken: b.attemptToken,
    });
    assert.equal(
      (await f.service.state()).skills[0].codexName,
      "web-design-engineer",
    );
    const retry = await f.names.enqueue({ skillId: id, launchName: "新名称" });
    assert.ok(retry);
    assert.notEqual(retry.id, first.id);
  } finally {
    await f.db.close();
  }
});
test("unlinked records, duplicate active names and invalid names are rejected without partial metadata edits", async () => {
  const f = await fixture();
  try {
    const unlinked = await f.service.saveSkill({
      name: "未连接",
      ownership: "original",
    });
    await assert.rejects(
      () => f.names.enqueue({ skillId: unlinked.id, launchName: "本机命名" }),
      /连接|本机/,
    );
    await assert.rejects(() =>
      f.service.saveSkill({ name: "不应保存", launchName: "../bad" }, id),
    );
    assert.equal(
      (
        await f.db.get("SELECT payload FROM skills WHERE id=?", [id])
      ).payload.includes("不应保存"),
      false,
    );
    const queued = await f.names.enqueue({
      skillId: id,
      launchName: "网页设计",
    });
    assert.ok(queued);
    assert.equal(
      (await f.names.enqueue({ skillId: id, launchName: "网页设计" }))?.id,
      queued.id,
    );
    await assert.rejects(
      () => f.names.enqueue({ skillId: id, launchName: "另一个名称" }),
      /等待|进行/,
    );
    const another = {
      ...f.skill,
      id: "88888888-8888-4888-8888-888888888888",
      name: "other",
    };
    await f.service.ingest(f.device.deviceId, {
      skills: [another],
      events: [],
    });
    await assert.rejects(
      () => f.names.enqueue({ skillId: another.id, launchName: "网页设计" }),
      /同名|占用/,
    );
  } finally {
    await f.db.close();
  }
});

test("stale editor retries use the newest connector version and cannot overwrite confirmed source metadata", async () => {
  const f = await fixture();
  try {
    const stale = (await f.service.state()).skills[0];
    const first = await f.service.saveSkill(
      { ...stale, launchName: "网页助手" },
      id,
    );
    const claimed = await f.names.claim(f.device.deviceId);
    assert.ok(first.launchNameJob && claimed);
    const current = { ...f.skill, version: "b".repeat(16) };
    await f.service.ingest(f.device.deviceId, {
      skills: [current],
      events: [],
    });
    await f.names.complete(f.device.deviceId, claimed.id, {
      status: "failed",
      message: "原技能版本已变更",
      attemptToken: claimed.attemptToken,
    });
    await f.service.saveSkill(
      { ...stale, launchName: "网页助手", customName: "伪造旧别名" },
      id,
    );
    const retried = await f.names.claim(f.device.deviceId);
    assert.ok(retried);
    assert.equal(retried.sourceVersion, current.version);
    const saved = (await f.service.state()).skills[0];
    assert.equal(saved.version, current.version);
    assert.equal(saved.customName, undefined);
  } finally {
    await f.db.close();
  }
});

test("restoring verified original names does not apply the narrower new-alias rules", async () => {
  const f = await fixture();
  try {
    for (const name of ["source.skill", "s".repeat(90)]) {
      await f.service.ingest(f.device.deviceId, {
        skills: [
          { ...f.skill, name, customName: "网页助手" },
          { ...f.skill, id: "88888888-8888-4888-8888-888888888888", name },
        ],
        events: [],
      });
      await f.service.saveSkill({ launchName: name }, id);
      const job = await f.names.claim(f.device.deviceId);
      assert.ok(job);
      await f.names.complete(f.device.deviceId, job.id, {
        ...job,
        status: "succeeded",
      });
      const saved = (await f.service.state()).skills[0];
      assert.equal(saved.codexName, name);
      assert.equal(saved.customName, undefined);
    }
  } finally {
    await f.db.close();
  }
});

test("rename results update installation metadata only for the connector-confirmed canonical installed copy", async () => {
  const f = await fixture();
  try {
    const source = {
      ...f.skill,
      sourceRepo: "owner/repo",
      sourcePath: "skills/source",
    };
    const installation = {
      fullName: source.sourceRepo,
      path: source.sourcePath,
      ref: "a".repeat(40),
      installedName: "installed-copy",
    };
    await f.service.ingest(f.device.deviceId, { skills: [source], events: [] });
    await f.db.run("INSERT INTO installed_skills VALUES(?,?,?,?,?,?,?)", [
      f.device.deviceId,
      installation.fullName,
      installation.path,
      installation.ref,
      installation.installedName,
      "a".repeat(64),
      new Date().toISOString(),
    ]);
    await f.db.run("INSERT INTO skill_aliases VALUES(?,?,?,?,?)", [
      f.device.deviceId,
      installation.fullName,
      installation.path,
      "InstalledAlias",
      new Date().toISOString(),
    ]);
    await f.service.saveSkill({ launchName: "外部副本" }, id);
    const external = await f.names.claim(f.device.deviceId);
    assert.ok(external);
    await f.names.complete(f.device.deviceId, external.id, {
      ...external,
      status: "succeeded",
    });
    assert.equal(
      (await f.db.get("SELECT custom_name FROM skill_aliases")).custom_name,
      "InstalledAlias",
    );
    await f.service.saveSkill({ launchName: "已确认副本" }, id);
    const installed = await f.names.claim(f.device.deviceId);
    assert.ok(installed);
    await f.names.complete(f.device.deviceId, installed.id, {
      ...installed,
      status: "succeeded",
      installation,
    });
    assert.equal(
      (await f.db.get("SELECT custom_name FROM skill_aliases")).custom_name,
      "已确认副本",
    );
  } finally {
    await f.db.close();
  }
});
