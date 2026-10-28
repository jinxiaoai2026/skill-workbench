import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSkills, validateRepository } from "../src/core/catalog.ts";
import {
  explanationHash,
  saveExplanations,
} from "../src/server/explanations.ts";
import { openDB } from "../src/server/db.ts";
import { InstallService } from "../src/server/installations.ts";
import { installSkill } from "../connector/install.ts";

test("catalog recognizes root/nested Skill manifests and excludes system paths and traversal", () => {
  assert.equal(
    validateRepository("cloudflare/security-audit-skill"),
    "cloudflare/security-audit-skill",
  );
  assert.throws(() => validateRepository("https://evil.test/x"));
  assert.throws(() => validateRepository("../x"));
  const rows = discoverSkills([
    { path: "skills/a/SKILL.md", type: "blob", size: 100 },
    { path: "skills/b/SKILL.md", type: "blob", size: 100 },
    { path: ".system/internal/SKILL.md", type: "blob", size: 10 },
    { path: "README.md", type: "blob", size: 10 },
  ]);
  assert.deepEqual(
    rows.map((r) => r.path),
    ["skills/a", "skills/b"],
  );
  assert.equal(
    discoverSkills([{ path: "README.md", type: "blob", size: 100 }]).length,
    0,
  );
});
test("Chinese explanations are bound to source content and reject English-only results", async () => {
  const db = await openDB(":memory:");
  const repo = { fullName: "php/php-src", description: "The PHP Interpreter" };
  try {
    const hash = explanationHash(repo);
    assert.notEqual(hash, explanationHash({ ...repo, description: "Changed" }));
    await assert.rejects(() =>
      saveExplanations(
        db,
        [repo],
        [
          {
            fullName: repo.fullName,
            titleZh: "PHP interpreter",
            summaryZh: "The PHP interpreter",
            useZh: "Use PHP",
          },
        ],
      ),
    );
    await saveExplanations(
      db,
      [repo],
      [
        {
          fullName: repo.fullName,
          titleZh: "PHP 解释器",
          summaryZh: "执行 PHP 程序的语言运行环境。",
          useZh: "适合开发或运行使用 PHP 的网站。",
        },
      ],
    );
    const stored = await db.get(
      "SELECT * FROM repo_explanations WHERE full_name=?",
      [repo.fullName],
    );
    assert.equal(stored.source_hash, hash);
    assert.match(JSON.parse(stored.payload).summaryZh, /解释|执行/);
  } finally {
    await db.close();
  }
});
test("installation jobs are device-scoped, deduplicated and third-party results stay outside personal skills", async () => {
  const db = await openDB(":memory:");
  try {
    await db.run(
      "INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)",
      ["mac1", "Mac", "hash1", new Date().toISOString()],
    );
    await db.run(
      "INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)",
      ["mac2", "Other", "hash2", new Date().toISOString()],
    );
    const service = new InstallService(db);
    const catalog = {
      fullName: "o/r",
      ref: "a".repeat(40),
      skills: [
        {
          name: "sample",
          path: "skills/sample",
          fileCount: 1,
          totalBytes: 100,
        },
      ],
      checkedAt: new Date().toISOString(),
    };
    await db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
      catalog.fullName,
      JSON.stringify(catalog),
      catalog.checkedAt,
    ]);
    const a = await service.enqueue({
      fullName: "o/r",
      path: "skills/sample",
      deviceId: "mac1",
    });
    const b = await service.enqueue({
      fullName: "o/r",
      path: "skills/sample",
      deviceId: "mac1",
    });
    assert.equal(a.id, b.id);
    assert.equal(await service.claim("mac2"), null);
    const claimed = await service.claim("mac1");
    assert.equal(claimed.id, a.id);
    await assert.rejects(() =>
      service.complete("mac2", a.id, {
        attemptToken: claimed.attemptToken,
        status: "succeeded",
        installedName: "sample",
      }),
    );
    await service.complete("mac1", a.id, {
      attemptToken: claimed.attemptToken,
      status: "succeeded",
      installedName: "sample",
      message: "安装完成",
    });
    assert.equal((await db.all("SELECT * FROM installed_skills")).length, 1);
    assert.equal((await db.all("SELECT * FROM skills")).length, 0);
    await db.run("UPDATE devices SET revoked=1 WHERE id=?", ["mac1"]);
    await assert.rejects(() => service.claim("mac1"));
  } finally {
    await db.close();
  }
});
test("installer stages real files, refuses unrelated existing destinations and replays its own receipt safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-test-"));
  const dest = join(root, "codex-skills");
  mkdirSync(dest);
  const job = {
    id: "job1",
    fullName: "o/r",
    ref: "a".repeat(40),
    path: "skills/sample",
    name: "sample",
  };
  const stage = async (_job: any, directory: string) => {
    const p = join(directory, "sample");
    mkdirSync(p);
    writeFileSync(
      join(p, "SKILL.md"),
      "---\nname: sample\ndescription: A test skill\n---\nTest.",
    );
    return p;
  };
  try {
    const result = await installSkill(job, { destination: dest, stage });
    assert.equal(result.status, "succeeded");
    assert.equal(existsSync(join(dest, "sample", "SKILL.md")), true);
    assert.equal(
      (await installSkill(job, { destination: dest, stage })).status,
      "succeeded",
    );
    writeFileSync(join(dest, "sample", "my-work.txt"), "keep");
    await assert.rejects(() =>
      installSkill(
        { ...job, ref: "b".repeat(40) },
        { destination: dest, stage },
      ),
    );
    assert.equal(
      readFileSync(join(dest, "sample", "my-work.txt"), "utf8"),
      "keep",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
