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
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { Connector } from "../connector/registry.ts";
import { installSkill } from "../connector/install.ts";

import { renameRegisteredSkill as rename } from "../connector/skill-names.ts";
const source =
  "---\nname: source-skill\ndescription: Use the bundled design references.\n---\nRead references/design.md.\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-registered-name-"));
  const original = join(root, "external/source"),
    destination = join(root, "skills");
  mkdirSync(join(original, "references"), { recursive: true });
  writeFileSync(join(original, "SKILL.md"), source);
  writeFileSync(join(original, "references/design.md"), "keep references");
  const c = new Connector(join(root, "connector"));
  const skill = c.adopt(original, "original", "personal");
  const options = {
    destination,
    discoveryRoots: [destination, join(root, "external")],
  };
  return {
    root,
    original,
    destination,
    c,
    skill,
    options,
    job: (launchName: string) => ({
      id: "rename",
      skillId: skill.id,
      sourceVersion: skill.version,
      launchName,
    }),
    close: () => {
      c.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function metadata(file: string) {
  return parse(readFileSync(file, "utf8").split("---")[1]);
}

test("a registered personal skill gets an explicit Chinese alias without changing its manifest or assets", () => {
  const f = fixture();
  try {
    const result = rename(f.c, f.job("网页设计"), f.options);
    assert.equal(result.status, "succeeded");
    assert.equal(result.launchName, "网页设计");
    assert.equal(result.customName, "网页设计");
    assert.equal(result.sourceVersion, f.skill.version);
    assert.match(result.manifestHash, /^[a-f0-9]{64}$/);
    const alias = readFileSync(
      join(f.destination, "网页设计/SKILL.md"),
      "utf8",
    );
    assert.equal(
      metadata(join(f.destination, "网页设计/SKILL.md")).name,
      "网页设计",
    );
    assert.ok(alias.includes(join(f.original, "SKILL.md")));
    assert.ok(alias.includes(f.original));
    assert.equal(
      parse(
        readFileSync(
          join(f.destination, "网页设计/agents/openai.yaml"),
          "utf8",
        ),
      ).policy.allow_implicit_invocation,
      false,
    );
    assert.equal(readFileSync(join(f.original, "SKILL.md"), "utf8"), source);
    assert.equal(
      readFileSync(join(f.original, "references/design.md"), "utf8"),
      "keep references",
    );
    assert.equal(f.c.skills()[0].customName, "网页设计");
    assert.equal(f.c.discover(f.options.discoveryRoots).found, 1);
    assert.equal(f.c.skills().length, 1);
    assert.equal(f.c.skills()[0].id, "personal");
    assert.equal(f.c.skills()[0].customName, "网页设计");
  } finally {
    f.close();
  }
});

test("managed names support replay, case-only change and restoration of the original frontmatter name", () => {
  const f = fixture();
  try {
    rename(f.c, f.job("Design"), f.options);
    rename(f.c, f.job("Design"), f.options);
    rename(f.c, f.job("design"), f.options);
    assert.equal(
      metadata(join(f.destination, "design/SKILL.md")).name,
      "design",
    );
    rename(f.c, f.job("页面设计"), f.options);
    assert.equal(existsSync(join(f.destination, "design")), false);
    const restored = rename(f.c, f.job("source-skill"), f.options);
    assert.equal(restored.launchName, "source-skill");
    assert.equal(restored.customName, undefined);
    assert.equal(existsSync(join(f.destination, "页面设计")), false);
    assert.equal(f.c.skills()[0].customName, undefined);
    f.c.discover(f.options.discoveryRoots);
    assert.equal(f.c.skills()[0].customName, undefined);
    assert.equal(readFileSync(join(f.original, "SKILL.md"), "utf8"), source);
  } finally {
    f.close();
  }
});

test("external GitHub imports use canonical file identity even when two skills share repository metadata", () => {
  const f = fixture();
  try {
    const other = join(f.root, "external/other");
    mkdirSync(other);
    writeFileSync(
      join(other, "SKILL.md"),
      source.replace("source-skill", "other-skill"),
    );
    const one = f.c.adopt(f.original, "imported", f.skill.id, false, {
      sourceRepo: "owner/repo",
      sourcePath: "skills/design",
    });
    const two = f.c.adopt(other, "imported", "second", false, {
      sourceRepo: "owner/repo",
      sourcePath: "skills/design",
    });
    rename(
      f.c,
      { ...f.job("第一设计"), sourceVersion: one.version },
      f.options,
    );
    rename(
      f.c,
      { ...f.job("第二设计"), skillId: two.id, sourceVersion: two.version },
      f.options,
    );
    rename(f.c, f.job("改名设计"), f.options);
    assert.equal(existsSync(join(f.destination, "第一设计")), false);
    assert.equal(existsSync(join(f.destination, "第二设计")), true);
    f.c.discover(f.options.discoveryRoots);
    assert.equal(
      f.c.skills().find((s) => s.id === "personal")?.customName,
      "改名设计",
    );
    assert.equal(
      f.c.skills().find((s) => s.id === "second")?.customName,
      "第二设计",
    );
  } finally {
    f.close();
  }
});

test("registered skills can replace and restore a legacy GitHub installation alias", async () => {
  const f = fixture();
  try {
    const github = {
      id: "install",
      fullName: "owner/repo",
      path: "skills/original",
      name: "original",
      ref: "a".repeat(40),
      customName: "旧名称",
    };
    await installSkill(github, {
      destination: f.destination,
      stage: async (_job, staging) => {
        const directory = join(staging, "original");
        mkdirSync(directory);
        writeFileSync(join(directory, "SKILL.md"), source);
        return directory;
      },
    });
    // Exercise receipts created before targetFile and skillId were introduced.
    const legacyReceiptFile = join(
      f.destination,
      "旧名称/.workbench-alias.json",
    );
    const legacyReceipt = JSON.parse(readFileSync(legacyReceiptFile, "utf8"));
    delete legacyReceipt.targetFile;
    delete legacyReceipt.skillId;
    writeFileSync(legacyReceiptFile, JSON.stringify(legacyReceipt));
    const registered = f.c.adopt(
      join(f.destination, "original"),
      "imported",
      "downloaded",
    );
    f.c.discover([f.destination]);
    assert.equal(
      f.c.skills().find((s) => s.id === "downloaded")?.customName,
      "旧名称",
    );
    const job = {
      id: "rename",
      skillId: registered.id,
      sourceVersion: registered.version,
      launchName: "新名称",
    };
    rename(f.c, job, f.options);
    assert.equal(existsSync(join(f.destination, "旧名称")), false);
    assert.equal(existsSync(join(f.destination, "新名称")), true);
    f.c.discover([f.destination]);
    assert.equal(
      f.c.skills().find((s) => s.id === "downloaded")?.customName,
      "新名称",
    );
    rename(f.c, { ...job, launchName: "source-skill" }, f.options);
    assert.equal(existsSync(join(f.destination, "新名称")), false);
  } finally {
    f.close();
  }
});

test("stale versions, missing originals and unsupported names cannot create aliases", () => {
  const f = fixture();
  try {
    for (const launchName of [
      "../bad",
      "two words",
      "bad\nname",
      ".system",
      "a".repeat(65),
    ]) {
      assert.throws(() => rename(f.c, f.job(launchName), f.options), /名称/);
    }
    writeFileSync(join(f.original, "SKILL.md"), source + "local edit\n");
    assert.throws(() => rename(f.c, f.job("新名称"), f.options), /版本|修改/);
    assert.equal(existsSync(join(f.destination, "新名称")), false);
    rmSync(join(f.original, "SKILL.md"));
    assert.throws(
      () => rename(f.c, f.job("新名称"), f.options),
      /ENOENT|未找到|不存在/,
    );
    assert.throws(
      () => rename(f.c, { ...f.job("名称"), skillId: "unknown" }, f.options),
      /登记|不存在/,
    );
  } finally {
    f.close();
  }
});

test("occupied names and symlink-discoverable conflicts preserve all original files", () => {
  const f = fixture();
  try {
    rename(f.c, f.job("旧名称"), f.options);
    mkdirSync(join(f.destination, "已占用"));
    writeFileSync(join(f.destination, "已占用/SKILL.md"), "keep");
    assert.throws(() => rename(f.c, f.job("已占用"), f.options), /同名/);
    const linked = join(f.root, "linked");
    mkdirSync(linked);
    writeFileSync(
      join(linked, "SKILL.md"),
      source.replace("source-skill", "链接技能"),
    );
    symlinkSync(linked, join(f.destination, "link"));
    assert.throws(() => rename(f.c, f.job("链接技能"), f.options), /同名/);
    assert.equal(existsSync(join(f.destination, "旧名称")), true);
    assert.equal(
      readFileSync(join(f.destination, "已占用/SKILL.md"), "utf8"),
      "keep",
    );
    assert.equal(
      readFileSync(join(linked, "SKILL.md"), "utf8"),
      source.replace("source-skill", "链接技能"),
    );
  } finally {
    f.close();
  }
});

test("modified aliases cannot be replaced or removed, and discovery never publishes the edited name", () => {
  const f = fixture();
  try {
    rename(f.c, f.job("旧名称"), f.options);
    writeFileSync(
      join(f.destination, "旧名称/agents/openai.yaml"),
      "local policy edit",
    );
    assert.throws(() => rename(f.c, f.job("新名称"), f.options), /修改/);
    assert.throws(() => rename(f.c, f.job("source-skill"), f.options), /修改/);
    assert.equal(existsSync(join(f.destination, "新名称")), false);
    assert.equal(f.c.skills()[0].customName, "旧名称");
    f.c.discover(f.options.discoveryRoots);
    assert.equal(f.c.skills().length, 1);
    assert.equal(f.c.skills()[0].customName, undefined);
    assert.equal(
      readFileSync(join(f.destination, "旧名称/agents/openai.yaml"), "utf8"),
      "local policy edit",
    );
  } finally {
    f.close();
  }
});

test("discovery requires an alias receipt and its actual wrapper to identify the same registered target", () => {
  const f = fixture();
  try {
    rename(f.c, f.job("设计"), f.options);
    const other = join(f.root, "external/other");
    mkdirSync(other);
    writeFileSync(
      join(other, "SKILL.md"),
      source.replace("source-skill", "other-skill"),
    );
    const two = f.c.adopt(other, "local", "second");
    const receiptFile = join(f.destination, "设计/.workbench-alias.json");
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    writeFileSync(
      receiptFile,
      JSON.stringify({
        ...receipt,
        skillId: two.id,
        targetFile: join(other, "SKILL.md"),
      }),
    );
    f.c.discover(f.options.discoveryRoots);
    assert.equal(f.c.skills().length, 2);
    assert.equal(
      f.c.skills().find((s) => s.id === two.id)?.customName,
      undefined,
    );
    assert.equal(
      f.c.skills().find((s) => s.id === f.skill.id)?.customName,
      undefined,
    );
  } finally {
    f.close();
  }
});

test("even stale registry entries cannot rename system skills, plugin caches or alias wrappers", () => {
  const f = fixture();
  try {
    for (const part of [
      ".system/hidden",
      "plugins/cache/package/hidden",
      "wrapper",
    ]) {
      const directory = join(f.root, part);
      mkdirSync(directory, { recursive: true });
      const file = join(directory, "SKILL.md");
      writeFileSync(file, source);
      if (part === "wrapper")
        writeFileSync(join(directory, ".workbench-alias.json"), "{}");
      const skill = { ...f.skill, id: part, path: file };
      f.c.db
        .prepare("INSERT INTO skills VALUES(?,?,?)")
        .run(skill.id, skill.path, JSON.stringify(skill));
      assert.throws(
        () => rename(f.c, { ...f.job("新名称"), skillId: skill.id }, f.options),
        /用户|系统|插件|别名/,
      );
    }
    assert.equal(existsSync(join(f.destination, "新名称")), false);
  } finally {
    f.close();
  }
});

test("an imported source edited intentionally can be renamed once its current version is synced", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.original, ".workbench-source.json"),
      JSON.stringify({
        fullName: "owner/repo",
        path: "skills/source",
        ref: "a".repeat(40),
        manifestHash: "old-pinned-hash",
      }),
    );
    const edited = source + "Intentional source edit.\n";
    writeFileSync(join(f.original, "SKILL.md"), edited);
    const current = f.c.refresh(f.skill.id)[0];
    const result = rename(
      f.c,
      { ...f.job("当前设计"), sourceVersion: current.version },
      f.options,
    );
    assert.equal(result.customName, "当前设计");
    assert.equal(readFileSync(join(f.original, "SKILL.md"), "utf8"), edited);
  } finally {
    f.close();
  }
});

test("a symlink to a managed alias does not authorize deleting the linked directory", () => {
  const f = fixture();
  try {
    rename(f.c, f.job("旧名称"), f.options);
    const moved = join(f.root, "moved-alias");
    renameSync(join(f.destination, "旧名称"), moved);
    symlinkSync(moved, join(f.destination, "旧名称"));
    assert.throws(
      () => rename(f.c, f.job("新名称"), f.options),
      /链接|同名|修改/,
    );
    assert.equal(existsSync(join(moved, "SKILL.md")), true);
    assert.equal(existsSync(join(f.destination, "新名称")), false);
  } finally {
    f.close();
  }
});

test("generic discovery does not register a receipt target that is not a registered user skill", () => {
  const f = fixture();
  try {
    rename(f.c, f.job("设计"), f.options);
    f.c.db.prepare("DELETE FROM skills WHERE id=?").run(f.skill.id);
    assert.equal(f.c.discover([f.destination]).found, 0);
    assert.equal(f.c.skills().length, 0);
  } finally {
    f.close();
  }
});

test("the configured default destination is honored without changing the source directory", () => {
  const f = fixture();
  const previous = process.env.WORKBENCH_SKILL_DESTINATION;
  try {
    process.env.WORKBENCH_SKILL_DESTINATION = f.destination;
    rename(f.c, f.job("默认设计"), {
      discoveryRoots: f.options.discoveryRoots,
    });
    assert.equal(existsSync(join(f.destination, "默认设计/SKILL.md")), true);
    assert.equal(readFileSync(join(f.original, "SKILL.md"), "utf8"), source);
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_SKILL_DESTINATION;
    else process.env.WORKBENCH_SKILL_DESTINATION = previous;
    f.close();
  }
});

test("an unregistered generic target cannot bypass registration by claiming unverified GitHub provenance", () => {
  const f = fixture();
  try {
    rename(f.c, f.job("设计"), f.options);
    const receiptFile = join(f.destination, "设计/.workbench-alias.json");
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    delete receipt.skillId;
    writeFileSync(
      receiptFile,
      JSON.stringify({
        ...receipt,
        fullName: "owner/repo",
        path: "skills/source",
        ref: "a".repeat(40),
        targetName: "source",
      }),
    );
    f.c.db.prepare("DELETE FROM skills WHERE id=?").run(f.skill.id);
    assert.equal(f.c.discover([f.destination]).found, 0);
    assert.equal(f.c.skills().length, 0);
  } finally {
    f.close();
  }
});

test("launch names also conflict with registered skills outside the configured discovery roots", () => {
  const f = fixture();
  try {
    const remote = join(f.root, "elsewhere/other");
    mkdirSync(remote, { recursive: true });
    writeFileSync(
      join(remote, "SKILL.md"),
      source.replace("source-skill", "另一技能"),
    );
    f.c.adopt(remote, "local", "elsewhere");
    assert.throws(
      () =>
        rename(f.c, f.job("另一技能"), {
          destination: f.destination,
          discoveryRoots: [f.destination],
        }),
      /同名/,
    );
    assert.equal(existsSync(join(f.destination, "另一技能")), false);
  } finally {
    f.close();
  }
});

const installedIdentity = {
  fullName: "owner/repo",
  path: "skills/original",
  ref: "a".repeat(40),
  installedName: "installed-original",
};
function installedFixture() {
  const f = fixture();
  const directory = join(f.destination, installedIdentity.installedName);
  mkdirSync(directory, { recursive: true });
  // The source may have been intentionally edited after installation.
  writeFileSync(
    join(directory, "SKILL.md"),
    source + "Intentional local edit.\n",
  );
  writeFileSync(
    join(directory, ".workbench-source.json"),
    JSON.stringify({
      fullName: installedIdentity.fullName,
      path: installedIdentity.path,
      ref: installedIdentity.ref,
      manifestHash: "older-installation-manifest-hash",
    }),
  );
  const registered = f.c.adopt(directory, "imported", "installed", false, {
    sourceRepo: installedIdentity.fullName,
    sourcePath: installedIdentity.path,
  });
  return {
    ...f,
    directory,
    registered,
    renameJob: {
      id: "installation-rename",
      skillId: registered.id,
      sourceVersion: registered.version,
      launchName: "安装调用",
    },
  };
}

test("only a canonical installed original with matching provenance returns installation identity without local paths", () => {
  const f = installedFixture();
  try {
    const result = rename(f.c, f.renameJob, f.options);
    assert.deepEqual(result.installation, installedIdentity);
    assert.equal(JSON.stringify(result).includes(f.root), false);
    assert.equal(
      readFileSync(join(f.directory, "SKILL.md"), "utf8"),
      source + "Intentional local edit.\n",
    );
    const restored = rename(
      f.c,
      { ...f.renameJob, launchName: "source-skill" },
      f.options,
    );
    assert.deepEqual(restored.installation, installedIdentity);
  } finally {
    f.close();
  }
});

test("an external copy sharing installed repository metadata never returns installation identity", () => {
  const f = installedFixture();
  try {
    writeFileSync(
      join(f.original, ".workbench-source.json"),
      readFileSync(join(f.directory, ".workbench-source.json")),
    );
    f.c.adopt(f.original, "imported", f.skill.id, false, {
      sourceRepo: installedIdentity.fullName,
      sourcePath: installedIdentity.path,
    });
    const result = rename(f.c, f.job("外部调用"), f.options);
    assert.equal(result.status, "succeeded");
    assert.equal(result.installation, undefined);
    assert.equal(existsSync(join(f.destination, "外部调用/SKILL.md")), true);
  } finally {
    f.close();
  }
});

test("missing, invalid, symlinked or mismatched installation receipts do not grant installation identity", () => {
  for (const kind of [
    "missing",
    "invalid-json",
    "symlink",
    "invalid-repo",
    "invalid-path",
    "invalid-ref",
    "mismatched-repo",
    "mismatched-path",
    "missing-provenance",
  ]) {
    const f = installedFixture();
    try {
      const file = join(f.directory, ".workbench-source.json");
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      if (kind === "missing") rmSync(file);
      if (kind === "invalid-json") writeFileSync(file, "invalid json");
      if (kind === "symlink") {
        const linked = join(f.root, "receipt.json");
        writeFileSync(linked, JSON.stringify(receipt));
        rmSync(file);
        symlinkSync(linked, file);
      }
      if (kind === "invalid-repo")
        writeFileSync(file, JSON.stringify({ ...receipt, fullName: "../bad" }));
      if (kind === "invalid-path")
        writeFileSync(file, JSON.stringify({ ...receipt, path: "../bad" }));
      if (kind === "invalid-ref")
        writeFileSync(file, JSON.stringify({ ...receipt, ref: "main" }));
      if (kind === "mismatched-repo")
        writeFileSync(
          file,
          JSON.stringify({ ...receipt, fullName: "different/repo" }),
        );
      if (kind === "mismatched-path")
        writeFileSync(
          file,
          JSON.stringify({ ...receipt, path: "skills/other" }),
        );
      if (kind === "missing-provenance")
        f.c.adopt(f.directory, "imported", f.registered.id, false, {
          sourceRepo: undefined,
          sourcePath: undefined,
        });
      const result = rename(f.c, f.renameJob, f.options);
      assert.equal(result.status, "succeeded", kind);
      assert.equal(result.installation, undefined, kind);
      assert.equal(
        existsSync(join(f.destination, "安装调用/SKILL.md")),
        true,
        kind,
      );
    } finally {
      f.close();
    }
  }
});

test("symlinked external sources and nested installed directories cannot claim installation identity", () => {
  for (const kind of [
    "symlinked-source",
    "nested-source",
    "invalid-installed-name",
  ]) {
    const f = installedFixture();
    try {
      const moved =
        kind === "symlinked-source"
          ? join(f.root, "elsewhere/original")
          : kind === "nested-source"
            ? join(f.destination, "group/original")
            : join(f.destination, "中文目录");
      mkdirSync(join(moved, ".."), { recursive: true });
      renameSync(f.directory, moved);
      if (kind === "symlinked-source") symlinkSync(moved, f.directory);
      f.c.adopt(moved, "imported", f.registered.id, false, {
        sourceRepo: installedIdentity.fullName,
        sourcePath: installedIdentity.path,
      });
      const result = rename(f.c, f.renameJob, f.options);
      assert.equal(result.status, "succeeded", kind);
      assert.equal(result.installation, undefined, kind);
    } finally {
      f.close();
    }
  }
});
