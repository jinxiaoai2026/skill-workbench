import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseGitTree,
  readGitRepository,
  stageGitSkill,
} from "../src/core/public-git.ts";
const exec = promisify(execFile);
const hash = "a".repeat(40);
test("Git tree parsing keeps regular files and rejects traversal, malformed or incomplete tree output", () => {
  const valid = Buffer.from(
    "100644 blob " +
      hash +
      "\t.skills/real/SKILL.md\0" +
      "120000 blob " +
      hash +
      "\tskills/link\0" +
      "160000 commit " +
      hash +
      "\tsubmodule\0",
  );
  const entries = parseGitTree(valid);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].path, ".skills/real/SKILL.md");
  for (const p of [
    "../outside",
    "/absolute",
    ".git/config",
    "skills/../bad",
    "skills\\bad",
    "skills/\u0000bad",
    "skills/\tevil",
  ])
    assert.throws(() =>
      parseGitTree(Buffer.from("100644 blob " + hash + "\t" + p + "\0")),
    );
  assert.throws(() =>
    parseGitTree(Buffer.from("100644 commit " + hash + "\tREADME.md\0")),
  );
  assert.throws(() =>
    parseGitTree(Buffer.from("100644 blob " + hash + "\tREADME.md")),
  );
});
test("real Git staging selects the requested historical commit and directory without including siblings or .git", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-git-test-")),
    repo = join(root, "origin");
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = async (args: string[], cwd = repo) =>
    exec("git", args, { cwd, env, maxBuffer: 5 * 1024 * 1024 });
  const commit = async () => {
    await run(["add", "."]);
    await run([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    return (await run(["rev-parse", "HEAD"])).stdout.trim();
  };
  try {
    mkdirSync(join(repo, "skills/one/references"), { recursive: true });
    mkdirSync(join(repo, "skills/two"), { recursive: true });
    writeFileSync(
      join(repo, "skills/one/SKILL.md"),
      "---\nname: one\ndescription: The first skill\n---\nOriginal",
    );
    writeFileSync(
      join(repo, "skills/one/references/guide.txt"),
      "Original resource",
    );
    writeFileSync(
      join(repo, "skills/two/SKILL.md"),
      "---\nname: two\ndescription: Another skill\n---\nOther",
    );
    writeFileSync(join(repo, "unrelated.bin"), "Do not stage");
    await run(["init", "-q"]);
    const old = await commit();
    writeFileSync(
      join(repo, "skills/one/SKILL.md"),
      "---\nname: one\ndescription: Changed upstream\n---\nNew",
    );
    await commit();
    const runner = async (args: string[], options: any) => {
      const fixed = args.map((x) =>
        x === "https://github.com/spec/repo.git" ? repo : x,
      );
      const result = await exec(
        "git",
        ["-c", "protocol.file.allow=always", ...fixed],
        { ...options, env, maxBuffer: 5 * 1024 * 1024, encoding: "buffer" },
      );
      return Buffer.from(result.stdout);
    };
    const catalog = await readGitRepository("spec/repo", { runner } as any);
    assert.equal(catalog.manifests.size, 2);
    assert.match(catalog.manifests.get("skills/one")!, /Changed upstream/);
    const dest = join(root, "selected");
    await stageGitSkill("spec/repo", old, "skills/one", dest, {
      runner,
    } as any);
    assert.match(
      readFileSync(join(dest, "SKILL.md"), "utf8"),
      /The first skill/,
    );
    assert.equal(
      readFileSync(join(dest, "references/guide.txt"), "utf8"),
      "Original resource",
    );
    assert.equal(existsSync(join(dest, ".git")), false);
    assert.equal(existsSync(join(dest, "unrelated.bin")), false);
    assert.equal(existsSync(join(dest, "skills/two")), false);
    await assert.rejects(() =>
      stageGitSkill("spec/repo", old, "../outside", join(root, "invalid"), {
        runner,
      } as any),
    );
    assert.equal(existsSync(join(root, "invalid")), false);
    const raced = join(root, "raced");
    const racingRunner = async (args: string[], options: any) => {
      if (args.includes("checkout")) {
        mkdirSync(raced);
        writeFileSync(join(raced, "SKILL.md"), "Local contents");
      }
      return runner(args, options);
    };
    await assert.rejects(() =>
      stageGitSkill("spec/repo", old, "skills/one", raced, {
        runner: racingRunner,
      } as any),
    );
    assert.equal(
      readFileSync(join(raced, "SKILL.md"), "utf8"),
      "Local contents",
    );
    mkdirSync(join(repo, "skills/huge"), { recursive: true });
    writeFileSync(join(repo, "skills/huge/SKILL.md"), "x".repeat(256001));
    const huge = await commit();
    await assert.rejects(() =>
      stageGitSkill("spec/repo", huge, "skills/huge", join(root, "huge"), {
        runner,
      } as any),
    );
    assert.equal(existsSync(join(root, "huge")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a stalled Git process is terminated and its own temporary directory is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-timeout-")),
    script = join(root, "git-probe"),
    log = join(root, "cwd.txt");
  const previous = process.env.WORKBENCH_GIT,
    previousLog = process.env.WORKBENCH_GIT_TEST_LOG;
  writeFileSync(
    script,
    '#!/bin/sh\npwd > "$WORKBENCH_GIT_TEST_LOG"\nsleep 10\n',
    { mode: 0o700 },
  );
  process.env.WORKBENCH_GIT = script;
  process.env.WORKBENCH_GIT_TEST_LOG = log;
  try {
    const start = Date.now();
    await assert.rejects(
      () => readGitRepository("spec/repo", { timeoutMs: 1500 }),
      (e: any) => e.code === "GIT_NETWORK",
    );
    assert.ok(Date.now() - start < 4000);
    assert.equal(existsSync(readFileSync(log, "utf8").trim()), false);
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_GIT;
    else process.env.WORKBENCH_GIT = previous;
    if (previousLog === undefined) delete process.env.WORKBENCH_GIT_TEST_LOG;
    else process.env.WORKBENCH_GIT_TEST_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});
test("Git download storage limits terminate the process and clean partial files", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-storage-")),
    script = join(root, "git-probe"),
    log = join(root, "cwd.txt");
  const previous = process.env.WORKBENCH_GIT,
    previousLog = process.env.WORKBENCH_GIT_TEST_LOG;
  writeFileSync(
    script,
    '#!/bin/sh\npwd > "$WORKBENCH_GIT_TEST_LOG"\ndd if=/dev/zero of=oversize bs=1024 count=2048 2>/dev/null\nsleep 10\n',
    { mode: 0o700 },
  );
  process.env.WORKBENCH_GIT = script;
  process.env.WORKBENCH_GIT_TEST_LOG = log;
  try {
    await assert.rejects(
      () =>
        readGitRepository("spec/repo", {
          timeoutMs: 3000,
          maxDirectoryBytes: 1024,
        }),
      (e: any) => e.code === "GIT_TOO_LARGE",
    );
    assert.equal(existsSync(readFileSync(log, "utf8").trim()), false);
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_GIT;
    else process.env.WORKBENCH_GIT = previous;
    if (previousLog === undefined) delete process.env.WORKBENCH_GIT_TEST_LOG;
    else process.env.WORKBENCH_GIT_TEST_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});
