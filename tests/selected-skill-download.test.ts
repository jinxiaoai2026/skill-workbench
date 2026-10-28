import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageSelected, type InstallJob } from "../connector/install.ts";
import { PublicGitError } from "../src/core/public-git.ts";
const job: InstallJob = {
  id: "fixture",
  fullName: "spec/repo",
  ref: "c".repeat(40),
  path: "skills/selected",
  name: "selected",
};
test("selected download carries the fixed revision and exact skill path without downloading an archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selected-skill-"));
  try {
    const result = await stageSelected(job, dir, {
      git: async (fullName, ref, path, dest) => {
        assert.equal(fullName, "spec/repo");
        assert.equal(path, "skills/selected");
        mkdirSync(dest);
        writeFileSync(join(dest, "SKILL.md"), ref);
        return dest;
      },
      official: async () => {
        throw new Error("Archive must not run");
      },
    });
    assert.equal(result, join(dir, "selected"));
    assert.equal(
      readFileSync(join(result, "SKILL.md"), "utf8"),
      "c".repeat(40),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("only a missing Git executable uses the official archive installer as a compatibility fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selected-fallback-"));
  let fallback = 0;
  try {
    const result = await stageSelected(job, dir, {
      git: async () => {
        throw new PublicGitError("Git not found", "GIT_MISSING");
      },
      official: async (_job, directory) => {
        fallback++;
        const p = join(directory, "selected");
        mkdirSync(p);
        writeFileSync(join(p, "SKILL.md"), "Original official installer");
        return p;
      },
    });
    assert.equal(
      readFileSync(join(result, "SKILL.md"), "utf8"),
      "Original official installer",
    );
    assert.equal(fallback, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("download rate limits or connection failures never trigger another archive attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selected-limit-"));
  let fallback = 0;
  try {
    for (const code of ["GIT_RATE_LIMITED", "GIT_NETWORK"])
      await assert.rejects(
        () =>
          stageSelected(job, dir, {
            git: async () => {
              throw new PublicGitError("Download stopped", code);
            },
            official: async () => {
              fallback++;
              return "unreachable";
            },
          }),
        (e: any) => e.code === code,
      );
    assert.equal(fallback, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
