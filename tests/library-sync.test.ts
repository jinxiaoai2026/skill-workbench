import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connector } from "../connector/registry.ts";
import { installSkill } from "../connector/install.ts";
import { openDB } from "../src/server/db.ts";
import { Service } from "../src/server/service.ts";
import { buildApp } from "../src/server/app.ts";
import { sync } from "../connector/sync.ts";
import {
  saveExplanations,
  explainMissing,
} from "../src/server/explanations.ts";
import { defaultSkillRoots } from "../connector/discovery.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "library-sync-"));
  const skills = join(root, "user-skills");
  mkdirSync(skills);
  const c = new Connector(join(root, "connector"));
  const write = (
    directory: string,
    name: string,
    description = "用于测试的技能",
  ) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nPrivate instructions, never synced by default.`,
    );
    return directory;
  };
  return {
    root,
    skills,
    c,
    write,
    close: () => {
      c.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("new local skills are discovered without adopt; rescans update metadata while preserving identity and declared authorship", () => {
  const f = fixture();
  try {
    const authored = f.write(join(f.skills, "mine"), "我的选品技能");
    const declared = f.c.adopt(authored, "original");
    f.write(join(f.skills, "new"), "新增技能");
    (f.c as any).discover([f.skills]);
    assert.equal(f.c.skills().length, 2);
    const local = f.c.skills().find((s) => s.name === "新增技能")!;
    assert.equal(local.ownership, "local");
    assert.equal(local.content, undefined);
    assert.equal(
      f.c.skills().find((s) => s.id === declared.id)?.ownership,
      "original",
    );
    f.write(join(f.skills, "new"), "改好的技能", "新的用途");
    (f.c as any).discover([f.skills]);
    assert.equal(
      f.c.skills().find((s) => s.id === local.id)?.name,
      "改好的技能",
    );
    assert.notEqual(
      f.c.skills().find((s) => s.id === local.id)?.version,
      local.version,
    );
  } finally {
    f.close();
  }
});
test("GitHub installed skill is included once with its custom invocation name; alias wrappers do not become library entries", async () => {
  const f = fixture();
  try {
    await installSkill(
      {
        id: "install",
        name: "design",
        fullName: "o/design",
        path: "skills/design",
        ref: "a".repeat(40),
        customName: "我的设计",
      },
      {
        destination: f.skills,
        stage: async (_job, temp) => f.write(join(temp, "design"), "design"),
      },
    );
    (f.c as any).discover([f.skills]);
    const [skill] = f.c.skills() as any[];
    assert.equal(f.c.skills().length, 1);
    assert.equal(skill.ownership, "imported");
    assert.equal(skill.sourceRepo, "o/design");
    assert.equal(skill.sourcePath, "skills/design");
    assert.equal(skill.upstream, "https://github.com/o/design");
    assert.equal(skill.customName, "我的设计");
    assert.equal(skill.name, "design");
  } finally {
    f.close();
  }
});
test("discovery excludes system and plugin-cache targets, deduplicates links, and tolerates malformed sibling manifests", () => {
  const f = fixture();
  try {
    const dir = f.write(join(f.skills, "real"), "正常技能");
    symlinkSync(dir, join(f.skills, "linked"));
    const system = f.write(join(f.root, ".system/builtin"), "系统技能");
    symlinkSync(system, join(f.skills, "system-link"));
    const plugin = f.write(
      join(f.root, "plugins/cache/vendor/skill"),
      "插件技能",
    );
    symlinkSync(plugin, join(f.skills, "plugin-link"));
    f.write(join(f.skills, ".system/hidden"), "隐藏系统技能");
    const bad = f.write(join(f.skills, "bad"), "bad");
    writeFileSync(join(bad, "SKILL.md"), "---\nname: [bad yaml\n---\nBroken");
    (f.c as any).discover([f.skills]);
    assert.deepEqual(
      f.c.skills().map((s) => s.name),
      ["正常技能"],
    );
    assert.throws(() => f.c.adopt(join(f.skills, "system-link"), "local"));
  } finally {
    f.close();
  }
});
test("GitHub origin establishes imported provenance and removes URL authentication data", () => {
  const f = fixture();
  try {
    const checkout = join(f.root, "checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(
      join(checkout, ".git/config"),
      '[remote "origin"]\n url = https://user:secret-token@github.com/shop/skills.git\n',
    );
    const skill = f.write(join(checkout, "skills/selection"), "selection");
    symlinkSync(skill, join(f.skills, "selection"));
    (f.c as any).discover([f.skills]);
    const saved = f.c.skills()[0] as any;
    assert.equal(saved.ownership, "imported");
    assert.equal(saved.upstream, "https://github.com/shop/skills");
    assert.equal(saved.sourcePath, "skills/selection");
    assert.equal(JSON.stringify(saved).includes("secret-token"), false);
    assert.match(
      readFileSync(join(skill, "SKILL.md"), "utf8"),
      /Private instructions/,
    );
  } finally {
    f.close();
  }
});

async function connected() {
  const f = fixture(),
    db = await openDB(":memory:"),
    service = new Service(db);
  const p = await service.createPairing(),
    device = await service.pair({ code: p.code, name: "Test Mac" });
  const app = await buildApp({
    db,
    sessionKey: Buffer.alloc(32, 7),
    password: "private-test-password",
    origin: "http://127.0.0.1",
    allowCollection: false,
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  f.c.setting("server", url);
  f.c.setting("deviceId", device.deviceId);
  const previousToken = process.env.WORKBENCH_DEVICE_TOKEN;
  process.env.WORKBENCH_DEVICE_TOKEN = device.token;
  return {
    ...f,
    db,
    service,
    device,
    close: async () => {
      if (previousToken === undefined)
        delete process.env.WORKBENCH_DEVICE_TOKEN;
      else process.env.WORKBENCH_DEVICE_TOKEN = previousToken;
      await app.close();
      await db.close();
      f.close();
    },
  };
}
test("synchronization automatically discovers later additions, includes GitHub skills and aliases, and preserves web organization without adding calls", async () => {
  const f = await connected();
  try {
    f.write(join(f.skills, "mine"), "本地创作");
    await installSkill(
      {
        id: "install",
        name: "design",
        fullName: "o/design",
        path: "skills/design",
        ref: "a".repeat(40),
        customName: "我的设计",
      },
      {
        destination: f.skills,
        stage: async (_j, temp) => f.write(join(temp, "design"), "design"),
      },
    );
    await (sync as any)(f.c, { roots: [f.skills] });
    const initial = await f.service.state();
    assert.equal(initial.skills.length, 2);
    const imported = initial.skills.find((s) => s.ownership === "imported")!;
    assert.equal(imported.name, "我的设计");
    assert.equal(imported.codexName, "我的设计");
    assert.equal(imported.sourceRepo, "o/design");
    assert.equal(initial.usage.confirmed, 0);
    await f.service.saveSkill(
      {
        name: "店铺设计助手",
        favorite: true,
        archived: true,
        category: "内容制作",
      },
      imported.id,
    );
    f.write(join(f.skills, "later"), "后来新制作的技能");
    await (sync as any)(f.c, { roots: [f.skills] });
    const after = await f.service.state();
    assert.equal(after.skills.length, 3);
    const saved = after.skills.find((s) => s.id === imported.id)!;
    assert.equal(saved.name, "店铺设计助手");
    assert.equal(saved.favorite, true);
    assert.equal(saved.archived, true);
    assert.equal(saved.category, "内容制作");
    assert.equal(after.usage.confirmed, 0);
    assert.equal(
      after.skills.every(
        (s) => s.content === undefined && s.path === undefined,
      ),
      true,
    );
    const registered = f.c.skills().find((s) => s.id === imported.id)!;
    f.c.enqueue({
      eventId: "import-start",
      invocationId: "import-call",
      skillId: registered.id,
      occurredAt: new Date().toISOString(),
      type: "start",
      evidence: "confirmed",
      source: "managed-entry",
    });
    await (sync as any)(f.c, { roots: [f.skills] });
    assert.equal((await f.service.state()).usage.confirmed, 1);
  } finally {
    await f.close();
  }
});
test("more than 300 discovered skills synchronize in batches with one acknowledged event", async () => {
  const f = await connected();
  try {
    for (let i = 0; i < 305; i++)
      f.write(join(f.skills, "skill-" + i), "skill-" + i);
    (f.c as any).discover([f.skills]);
    f.c.enqueue({
      eventId: "start",
      invocationId: "call",
      skillId: f.c.skills()[0].id,
      occurredAt: new Date().toISOString(),
      type: "start",
      evidence: "confirmed",
      source: "managed-entry",
    });
    await (sync as any)(f.c, { roots: [f.skills] });
    await (sync as any)(f.c, { roots: [f.skills] });
    assert.equal((await f.service.state()).skills.length, 305);
    assert.equal((await f.service.state()).usage.confirmed, 1);
    assert.equal(f.c.pending().length, 0);
  } finally {
    await f.close();
  }
});
test("a second device cannot overwrite or claim usage for another device's discovered skill", async () => {
  const db = await openDB(":memory:"),
    service = new Service(db);
  try {
    const p1 = await service.createPairing(),
      d1 = await service.pair({ code: p1.code, name: "Mac1" });
    const p2 = await service.createPairing(),
      d2 = await service.pair({ code: p2.code, name: "Mac2" });
    const skill = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "local",
      ownership: "local",
    };
    await service.ingest(d1.deviceId, { skills: [skill], events: [] });
    await assert.rejects(
      () =>
        service.ingest(d2.deviceId, {
          skills: [{ ...skill, name: "changed" }],
          events: [],
        }),
      /设备/,
    );
    await assert.rejects(
      () =>
        service.ingest(d2.deviceId, {
          skills: [],
          events: [
            {
              eventId: "foreign",
              invocationId: "foreign",
              skillId: skill.id,
              occurredAt: new Date().toISOString(),
              type: "start",
              evidence: "confirmed",
              source: "managed-entry",
            },
          ],
        }),
      /设备/,
    );
  } finally {
    await db.close();
  }
});
test("imported library entries reuse Chinese manifest explanations while retaining explicit web edits", async () => {
  const db = await openDB(":memory:"),
    service = new Service(db);
  try {
    const p = await service.createPairing(),
      device = await service.pair({ code: p.code, name: "Mac" });
    const skill = {
      id: "55555555-5555-4555-8555-555555555555",
      name: "design",
      description: "Design websites",
      ownership: "imported",
      sourceRepo: "o/design",
      sourcePath: "skills/design",
    };
    const input = {
      fullName: "o/design#skills/design",
      description: "技能名称：design\n技能用途：Design websites",
    };
    await saveExplanations(
      db,
      [input],
      [
        {
          fullName: input.fullName,
          titleZh: "网页设计技能",
          summaryZh: "用于设计网页和页面。",
          useZh: "协助完成网页设计。",
        },
      ],
    );
    await service.ingest(device.deviceId, { skills: [skill], events: [] });
    const entry = (await service.state()).skills[0];
    assert.equal(entry.name, "网页设计技能");
    assert.equal(entry.description, "用于设计网页和页面。");
    assert.equal(entry.codexName, "design");
    await service.saveSkill({ description: "我的用途说明" }, skill.id);
    await service.ingest(device.deviceId, { skills: [skill], events: [] });
    const edited = (await service.state()).skills[0];
    assert.equal(edited.description, "我的用途说明");
    assert.equal(edited.name, "网页设计技能");
  } finally {
    await db.close();
  }
});
test("aliases stay attached to their canonical installation when the same repo is installed in two roots", async () => {
  const f = fixture();
  try {
    const second = join(f.root, "second-skills");
    for (const [destination, ref, customName] of [
      [f.skills, "a".repeat(40), "版本一"],
      [second, "b".repeat(40), "版本二"],
    ]) {
      await installSkill(
        {
          id: customName,
          name: "design",
          fullName: "o/design",
          path: "skills/design",
          ref,
          customName,
        },
        {
          destination,
          stage: async (_j, temp) => f.write(join(temp, "design"), "design"),
        },
      );
    }
    f.c.discover([f.skills, second]);
    assert.equal(
      f.c
        .skills()
        .find((s) => s.path === realpathSync(join(f.skills, "design/SKILL.md")))
        ?.customName,
      "版本一",
    );
    assert.equal(
      f.c
        .skills()
        .find((s) => s.path === realpathSync(join(second, "design/SKILL.md")))
        ?.customName,
      "版本二",
    );
  } finally {
    f.close();
  }
});
test("configured installation destination is automatically scanned without separately configuring roots", () => {
  const f = fixture(),
    previous = process.env.WORKBENCH_SKILL_DESTINATION;
  try {
    f.write(join(f.skills, "configured"), "自定义目录技能");
    process.env.WORKBENCH_SKILL_DESTINATION = f.skills;
    // Restrict the host's default-root list to the isolated fixture for the scan.
    f.c.discover(defaultSkillRoots(f.c).filter((p) => p.startsWith(f.root)));
    assert.equal(
      f.c.skills().some((s) => s.name === "自定义目录技能"),
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_SKILL_DESTINATION;
    else process.env.WORKBENCH_SKILL_DESTINATION = previous;
    f.close();
  }
});
test("invalid source receipts do not suppress valid skill manifests", () => {
  const f = fixture();
  try {
    const dir = f.write(join(f.skills, "broken-receipt"), "有效技能");
    writeFileSync(join(dir, ".workbench-source.json"), "{broken json");
    const result = f.c.discover([f.skills]);
    assert.equal(f.c.skills()[0]?.name, "有效技能");
    assert.equal(f.c.skills()[0]?.ownership, "local");
    assert.match(result.errors.join(""), /来源/);
  } finally {
    f.close();
  }
});
test("new English local descriptions enter the Chinese cache using metadata only", async () => {
  const db = await openDB(":memory:"),
    service = new Service(db);
  try {
    const p = await service.createPairing(),
      d = await service.pair({ code: p.code, name: "Mac" });
    const skill = {
      id: "66666666-6666-4666-8666-666666666666",
      name: "customer-replies",
      description: "Draft customer service replies",
      ownership: "local",
      content: "PRIVATE BODY NEVER SEND TO TRANSLATOR",
    };
    await service.ingest(d.deviceId, { skills: [skill], events: [] });
    const pending = await service.state();
    const request = await db.get(
      "SELECT * FROM explanation_requests WHERE full_name=?",
      ["local-skill:" + skill.id],
    );
    assert.ok(request);
    assert.equal(request.payload.includes("PRIVATE BODY"), false);
    assert.match(pending.skills[0].description, /中文/);
    await explainMissing(db, {
      translator: async (inputs) =>
        inputs.map((input) => ({
          fullName: input.fullName,
          titleZh: "客服回复起草",
          summaryZh: "根据用户需求起草客服回复。",
          useZh: "用于客服沟通工作。",
        })),
    });
    const translated = (await service.state()).skills[0];
    assert.equal(translated.name, "客服回复起草");
    assert.equal(translated.description, "根据用户需求起草客服回复。");
    assert.equal(translated.codexName, "customer-replies");
  } finally {
    await db.close();
  }
});
