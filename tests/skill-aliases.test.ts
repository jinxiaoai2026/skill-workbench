import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { installSkill } from "../connector/install.ts";
import { openDB } from "../src/server/db.ts";
import { InstallService } from "../src/server/installations.ts";
import { Service } from "../src/server/service.ts";

const source =
  "---\nname: source-skill\ndescription: Design pages using the bundled references.\n---\nRead references/design.md before designing.\n";
const job = {
  id: "test",
  fullName: "owner/design",
  path: "skills/original",
  name: "original",
  ref: "a".repeat(40),
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-alias-"));
  const destination = join(root, "skills");
  const stage = async (_job: unknown, directory: string) => {
    const dir = join(directory, "original");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), source);
    writeFileSync(
      join(dir, "references/design.md"),
      "Use the source design references.",
    );
    return dir;
  };
  return {
    root,
    destination,
    stage,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function metadata(file: string) {
  const text = readFileSync(file, "utf8");
  return parse(text.split("---")[1]);
}
test("custom Chinese name creates a discoverable alias pointing to the intact original and resources", async () => {
  const f = fixture();
  try {
    const result = await installSkill(
      { ...job, customName: "网页设计" } as any,
      f,
    );
    assert.equal(existsSync(join(f.destination, "网页设计/SKILL.md")), true);
    assert.equal((result as any).customName, "网页设计");
    assert.equal(
      metadata(join(f.destination, "网页设计/SKILL.md")).name,
      "网页设计",
    );
    assert.ok(
      readFileSync(join(f.destination, "网页设计/SKILL.md"), "utf8").includes(
        join(f.destination, "original/SKILL.md"),
      ),
    );
    assert.equal(
      readFileSync(join(f.destination, "original/SKILL.md"), "utf8"),
      source,
    );
    assert.equal(
      readFileSync(
        join(f.destination, "original/references/design.md"),
        "utf8",
      ),
      "Use the source design references.",
    );
  } finally {
    f.close();
  }
});
test("changing a managed alias removes the previous alias, supports replay, and preserves the original", async () => {
  const f = fixture();
  try {
    await installSkill({ ...job, customName: "网页设计" } as any, f);
    await installSkill(
      { ...job, kind: "alias", customName: "店铺设计" } as any,
      f,
    );
    assert.equal(existsSync(join(f.destination, "网页设计")), false);
    assert.equal(
      metadata(join(f.destination, "店铺设计/SKILL.md")).name,
      "店铺设计",
    );
    assert.equal(
      (
        await installSkill(
          { ...job, kind: "alias", customName: "店铺设计" } as any,
          f,
        )
      ).status,
      "succeeded",
    );
    assert.equal(
      readFileSync(join(f.destination, "original/SKILL.md"), "utf8"),
      source,
    );
  } finally {
    f.close();
  }
});
test("an owned English alias can change casing on macOS without colliding with itself", async () => {
  const f = fixture();
  try {
    await installSkill({ ...job, customName: "Design" }, f);
    const renamed = await installSkill(
      { ...job, kind: "alias", customName: "design" },
      f,
    );
    assert.equal(renamed.customName, "design");
    assert.equal(
      metadata(join(f.destination, "design/SKILL.md")).name,
      "design",
    );
    assert.equal(
      readFileSync(join(f.destination, "original/SKILL.md"), "utf8"),
      source,
    );
  } finally {
    f.close();
  }
});
test("alias rejects occupied names and modified prior aliases without changing either directory", async () => {
  const f = fixture();
  try {
    await installSkill({ ...job, customName: "网页设计" } as any, f);
    mkdirSync(join(f.destination, "已有技能"));
    writeFileSync(join(f.destination, "已有技能/SKILL.md"), "keep");
    await assert.rejects(
      () =>
        installSkill(
          { ...job, kind: "alias", customName: "已有技能" } as any,
          f,
        ),
      /同名/,
    );
    assert.equal(
      readFileSync(join(f.destination, "已有技能/SKILL.md"), "utf8"),
      "keep",
    );
    assert.equal(existsSync(join(f.destination, "网页设计")), true);
    writeFileSync(join(f.destination, "网页设计/SKILL.md"), "local edit");
    await assert.rejects(
      () =>
        installSkill(
          { ...job, kind: "alias", customName: "店铺设计" } as any,
          f,
        ),
      /修改/,
    );
    assert.equal(existsSync(join(f.destination, "店铺设计")), false);
    assert.equal(
      readFileSync(join(f.destination, "网页设计/SKILL.md"), "utf8"),
      "local edit",
    );
  } finally {
    f.close();
  }
});
test("alias-only jobs refuse missing or modified original files and symlinked aliases", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        installSkill(
          { ...job, kind: "alias", customName: "网页设计" } as any,
          f,
        ),
      /未找到|不存在/,
    );
    await installSkill(job, f);
    symlinkSync(
      join(f.destination, "original"),
      join(f.destination, "网页设计"),
    );
    await assert.rejects(
      () =>
        installSkill(
          { ...job, kind: "alias", customName: "网页设计" } as any,
          f,
        ),
      /同名|链接/,
    );
    writeFileSync(
      join(f.destination, "original/SKILL.md"),
      "local modification",
    );
    await assert.rejects(
      () =>
        installSkill({ ...job, kind: "alias", customName: "新设计" } as any, f),
      /修改/,
    );
  } finally {
    f.close();
  }
});
test("custom invocation names reject paths, whitespace and control characters before installation", async () => {
  const f = fixture();
  try {
    for (const customName of [
      "../escape",
      "two words",
      "bad\nname",
      ".system",
      "a".repeat(65),
    ]) {
      await assert.rejects(
        () => installSkill({ ...job, customName } as any, f),
        /名称/,
      );
    }
    assert.equal(existsSync(join(f.destination, "original")), false);
  } finally {
    f.close();
  }
});
test("alias conflicts include Codex-discoverable symlinked skills without modifying their targets", async () => {
  const f = fixture();
  try {
    await installSkill(job, f);
    const linked = join(f.root, "external-skill");
    mkdirSync(linked);
    writeFileSync(
      join(linked, "SKILL.md"),
      "---\nname: 网页设计\ndescription: Existing linked skill\n---\nkeep",
    );
    symlinkSync(linked, join(f.destination, "linked-folder"));
    await assert.rejects(
      () => installSkill({ ...job, kind: "alias", customName: "网页设计" }, f),
      /同名/,
    );
    assert.equal(existsSync(join(f.destination, "网页设计")), false);
    assert.match(readFileSync(join(linked, "SKILL.md"), "utf8"), /keep/);
  } finally {
    f.close();
  }
});
test("alias conflict checks also include other configured Codex user-skill locations", async () => {
  const f = fixture();
  try {
    await installSkill(job, f);
    const legacy = join(f.root, "legacy-skills");
    mkdirSync(join(legacy, "other-folder"), { recursive: true });
    writeFileSync(
      join(legacy, "other-folder/SKILL.md"),
      "---\nname: 网页设计\ndescription: Existing user skill\n---\nkeep",
    );
    await assert.rejects(
      () =>
        installSkill({ ...job, kind: "alias", customName: "网页设计" }, {
          ...f,
          discoveryRoots: [f.destination, legacy],
        } as any),
      /同名/,
    );
  } finally {
    f.close();
  }
});

async function serviceFixture() {
  const db = await openDB(":memory:");
  await db.run(
    "INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)",
    ["mac", "Mac", "token", new Date().toISOString()],
  );
  const catalog = {
    fullName: job.fullName,
    ref: job.ref,
    skills: [{ name: job.name, path: job.path, fileCount: 1, totalBytes: 100 }],
    checkedAt: new Date().toISOString(),
  };
  await db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
    job.fullName,
    JSON.stringify(catalog),
    catalog.checkedAt,
  ]);
  return { db, service: new InstallService(db) };
}
const request = { fullName: job.fullName, path: job.path, deviceId: "mac" };
test("installation carries the requested alias and publishes it only after the matching device succeeds", async () => {
  const f = await serviceFixture();
  try {
    const queued = await f.service.enqueue({
      ...request,
      customName: "网页设计",
    });
    const claimed = await f.service.claim("mac");
    assert.equal(claimed.customName, "网页设计");
    assert.equal((await new Service(f.db).state()).installedSkills.length, 0);
    await assert.rejects(() =>
      f.service.complete("mac", queued.id, {
        status: "succeeded",
        attemptToken: claimed.attemptToken,
        installedName: job.name,
        customName: "其他名字",
      }),
    );
    await f.service.complete("mac", queued.id, {
      status: "succeeded",
      attemptToken: claimed.attemptToken,
      installedName: job.name,
      customName: "网页设计",
    });
    const state = await new Service(f.db).state();
    assert.equal(state.installedSkills[0].custom_name, "网页设计");
    assert.equal(state.skills.length, 0);
    assert.equal(
      (await f.service.enqueue({ ...request, customName: "网页设计" })).id,
      queued.id,
    );
  } finally {
    await f.db.close();
  }
});
test("installed skills can change alias without a new download; failed jobs preserve the prior name and old names can be reused", async () => {
  const f = await serviceFixture();
  try {
    const initial = await f.service.enqueue(request);
    const originalClaim = await f.service.claim("mac");
    await f.service.complete("mac", initial.id, {
      status: "succeeded",
      attemptToken: originalClaim.attemptToken,
      installedName: job.name,
    });
    for (const customName of ["网页设计", "店铺设计", "网页设计"]) {
      const next = await (f.service as any).rename({ ...request, customName });
      const claim = await f.service.claim("mac");
      assert.equal(claim.kind, "alias");
      assert.equal(claim.ref, job.ref);
      await f.service.complete("mac", next.id, {
        status: "succeeded",
        attemptToken: claim.attemptToken,
        installedName: job.name,
        customName,
      });
      assert.equal(
        (await new Service(f.db).state()).installedSkills[0].custom_name,
        customName,
      );
    }
    const failed = await (f.service as any).rename({
      ...request,
      customName: "已占用",
    });
    const failedClaim = await f.service.claim("mac");
    await f.service.complete("mac", failed.id, {
      status: "failed",
      attemptToken: failedClaim.attemptToken,
      message: "同名",
    });
    assert.equal(
      (await new Service(f.db).state()).installedSkills[0].custom_name,
      "网页设计",
    );
    await assert.rejects(() =>
      (f.service as any).rename({
        ...request,
        deviceId: "other",
        customName: "设计",
      }),
    );
    await assert.rejects(() =>
      (f.service as any).rename({ ...request, customName: "../bad" }),
    );
  } finally {
    await f.db.close();
  }
});
test("pending aliases reserve names per device and prevent conflicting edits to the same skill", async () => {
  const f = await serviceFixture();
  try {
    const first = await f.service.enqueue({
      ...request,
      customName: "网页设计",
    });
    await assert.rejects(
      () => f.service.enqueue({ ...request, customName: "店铺设计" }),
      /等待|进行/,
    );
    const other = {
      fullName: "other/repo",
      ref: job.ref,
      skills: [{ name: "other", path: ".", fileCount: 1, totalBytes: 100 }],
      checkedAt: new Date().toISOString(),
    };
    await f.db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
      other.fullName,
      JSON.stringify(other),
      other.checkedAt,
    ]);
    await assert.rejects(
      () =>
        f.service.enqueue({
          fullName: other.fullName,
          path: ".",
          deviceId: "mac",
          customName: "网页设计",
        }),
      /同名/,
    );
    assert.equal(
      (await f.service.enqueue({ ...request, customName: "网页设计" })).id,
      first.id,
    );
  } finally {
    await f.db.close();
  }
});
