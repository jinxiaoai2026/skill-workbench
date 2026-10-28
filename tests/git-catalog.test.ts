import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { getCatalog, getSkillPage } from "../src/server/catalog.ts";
import { discoverSkills } from "../src/core/catalog.ts";
import { PublicGitError } from "../src/core/public-git.ts";
const ref = "b".repeat(40),
  at = Date.parse("2026-10-25T09:00:00Z");
const tree = [
  { path: ".agents/skills/design/SKILL.md", type: "blob", mode: "100644" },
  {
    path: ".agents/skills/design/references/layout.md",
    type: "blob",
    mode: "100644",
  },
  { path: ".claude/skills/design/SKILL.md", type: "blob", mode: "100644" },
  { path: "plugin/skills/design/SKILL.md", type: "blob", mode: "100644" },
  { path: ".claude/skills/review/SKILL.md", type: "blob", mode: "100644" },
  { path: "skills/pdf/SKILL.md", type: "blob", mode: "100644" },
];
test("Codex provider variants are preferred without hiding independent skills or inventing file sizes", () => {
  const result = discoverSkills(tree);
  assert.deepEqual(
    result.map((x) => x.path),
    [".agents/skills/design", ".claude/skills/review", "skills/pdf"],
  );
  assert.equal(result[0].fileCount, 2);
  assert.equal(result[0].totalBytes, null);
});
test("a normal Git preflight is independent of an existing REST cooldown and stores pinned real manifests", async () => {
  const db = await openDB(":memory:");
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("REST must not be used");
  };
  try {
    for (const key of ["github-catalog-cooldown", "catalog-failure:spec/repo"])
      await db.run("INSERT INTO meta VALUES(?,?)", [
        key,
        JSON.stringify({
          until: at + 3600000,
          message: "REST limited",
          code: "GITHUB_RATE_LIMITED",
          statusCode: 429,
        }),
      ]);
    const r = await getCatalog(db, "spec/repo", {
      now: () => at,
      gitCatalog: async () => ({
        ref,
        tree: [tree[0], tree[1]],
        manifests: new Map([
          [
            ".agents/skills/design",
            "---\nname: design\ndescription: Design a frontend page\n---\nSource instructions",
          ],
        ]),
      }),
    } as any);
    assert.equal(r.source, "github-git");
    assert.equal(r.ref, ref);
    assert.equal(r.skills.length, 1);
    assert.equal(requests, 0);
    const page = await getSkillPage(
      db,
      { repo: "spec/repo" },
      {
        loadManifest: async () => {
          throw new Error("Manifest must be cached");
        },
        translator: async () => {
          throw new Error("Unavailable");
        },
      },
    );
    assert.equal(page.items[0].manifestName, "design");
    assert.equal(page.items[0].description, "Design a frontend page");
    const again = await getCatalog(db, "spec/repo", {
      now: () => at + 1000,
      gitCatalog: async () => {
        throw new Error("Cache must be reused");
      },
    } as any);
    assert.equal(again.checkedAt, r.checkedAt);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
    await db.close();
  }
});
test("invalid Git manifests never become an installable Skill and verified empty repositories remain empty", async () => {
  const db = await openDB(":memory:");
  try {
    const invalid = await getCatalog(db, "spec/invalid", {
      now: () => at,
      gitCatalog: async () => ({
        ref,
        tree: [tree[0]],
        manifests: new Map([[".agents/skills/design", "not a valid manifest"]]),
      }),
    } as any);
    assert.equal(invalid.skills.length, 0);
    const empty = await getCatalog(db, "spec/empty", {
      now: () => at,
      gitCatalog: async () => ({
        ref,
        tree: [{ path: "README.md", type: "blob", mode: "100644" }],
        manifests: new Map(),
      }),
    } as any);
    assert.equal(empty.skills.length, 0);
    assert.equal(empty.source, "github-git");
  } finally {
    await db.close();
  }
});
test("an explicit Git download rate limit pauses all repositories without a REST or archive retry", async () => {
  const db = await openDB(":memory:");
  const original = globalThis.fetch;
  let api = 0,
    git = 0;
  globalThis.fetch = async () => {
    api++;
    throw new Error("No alternate request while limited");
  };
  try {
    for (const name of ["spec/one", "spec/two"])
      await assert.rejects(
        () =>
          getCatalog(db, name, {
            now: () => at,
            gitCatalog: async () => {
              git++;
              throw new PublicGitError(
                "Download limited",
                "GIT_RATE_LIMITED",
                new Date(at + 60000).toISOString(),
              );
            },
          } as any),
        (e: any) =>
          e.code === "GITHUB_RATE_LIMITED" &&
          e.retryAt === new Date(at + 60000).toISOString(),
      );
    assert.equal(api, 0);
    assert.equal(git, 1);
  } finally {
    globalThis.fetch = original;
    await db.close();
  }
});
