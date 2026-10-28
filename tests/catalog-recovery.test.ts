import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { openDB } from "../src/server/db.ts";
import { getCatalog as actualGetCatalog } from "../src/server/catalog.ts";
const getCatalog = (db: any, repo: string, options: any = {}) =>
  actualGetCatalog(db, repo, { gitCatalog: null, ...options });

const at = Date.parse("2026-10-25T05:00:00Z"),
  ref = "a".repeat(40);
async function withFetch(fn: typeof fetch, body: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

test("rate limits preserve reset information and suppress repeated REST requests across repositories", async () => {
  const db = await openDB(":memory:");
  let calls = 0;
  const publicCatalog = async () => {
    throw new Error("Public access unavailable");
  };
  try {
    await withFetch(
      async () => {
        calls++;
        return new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-limit": "60",
            "x-ratelimit-reset": String((at + 60000) / 1000),
          },
        });
      },
      async () => {
        for (const repo of ["spec/one", "spec/one", "spec/two"])
          await assert.rejects(
            () =>
              (getCatalog as any)(db, repo, { now: () => at, publicCatalog }),
            (e: any) =>
              e.code === "GITHUB_RATE_LIMITED" &&
              e.statusCode === 429 &&
              e.retryAt === "2026-10-25T05:01:00.000Z" &&
              e.rate.remaining === 0,
          );
        assert.equal(calls, 1);
        assert.equal((await db.all("SELECT * FROM skill_catalogs")).length, 0);
      },
    );
  } finally {
    await db.close();
  }
});

test("a valid pinned stale catalog remains usable during rate limits without losing its original check time", async () => {
  const db = await openDB(":memory:");
  const checkedAt = "2026-10-23T05:00:00.000Z";
  await db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
    "spec/cached",
    JSON.stringify({
      fullName: "spec/cached",
      ref,
      checkedAt,
      skills: [
        { name: "real", path: "skills/real", fileCount: 1, totalBytes: 100 },
      ],
    }),
    checkedAt,
  ]);
  try {
    await withFetch(
      async () =>
        new Response('{"message":"rate limit"}', {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      async () => {
        const result = await (getCatalog as any)(db, "spec/cached", {
          now: () => at,
        });
        assert.equal(result.skills[0].path, "skills/real");
        assert.equal(result.ref, ref);
        assert.equal(result.checkedAt, checkedAt);
        assert.equal(result.stale, true);
        assert.match(result.warning, /缓存/);
      },
    );
  } finally {
    await db.close();
  }
});

test("403 permissions, 401 authentication and 404 missing repositories are not mislabeled as rate limits", async () => {
  for (const [status, code] of [
    [403, "GITHUB_FORBIDDEN"],
    [401, "GITHUB_AUTHENTICATION"],
    [404, "GITHUB_NOT_FOUND"],
  ] as const) {
    const db = await openDB(":memory:");
    try {
      await withFetch(
        async () => new Response('{"message":"Permission denied"}', { status }),
        async () => {
          await assert.rejects(
            () => (getCatalog as any)(db, "spec/repo", { now: () => at }),
            (e: any) => e.code === code && e.upstreamStatus === status,
          );
          assert.equal(
            (await db.all("SELECT * FROM skill_catalogs")).length,
            0,
          );
        },
      );
    } finally {
      await db.close();
    }
  }
});

test("normal discovery deduplicates requests, caches genuine no-Skill results and recovers after cooldown", async () => {
  const db = await openDB(":memory:");
  let calls = 0;
  try {
    await withFetch(
      async (input) => {
        calls++;
        return Response.json(
          String(input).includes("/commits/HEAD")
            ? { sha: ref }
            : {
                tree: [
                  {
                    path: "README.md",
                    type: "blob",
                    size: 100,
                    mode: "100644",
                  },
                ],
                truncated: false,
              },
        );
      },
      async () => {
        const results = await Promise.all([
          getCatalog(db, "spec/plain"),
          getCatalog(db, "spec/plain"),
        ]);
        assert.equal(results[0].skills.length, 0);
        assert.equal(calls, 2);
        await getCatalog(db, "spec/plain");
        assert.equal(calls, 2);
      },
    );
  } finally {
    await db.close();
  }
});

test("public fallback returns only a verified pinned catalog and is reused instead of repeating API failures", async () => {
  const db = await openDB(":memory:");
  let reads = 0;
  try {
    await withFetch(
      async () =>
        new Response('{"message":"rate limit exceeded"}', {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((at + 60000) / 1000),
          },
        }),
      async () => {
        const publicCatalog = async () => {
          reads++;
          return {
            ref,
            tree: [
              {
                path: "skills/actual/SKILL.md",
                type: "blob",
                size: 100,
                mode: "100644",
              },
            ],
            manifests: new Map([
              [
                "skills/actual",
                "---\nname: actual\ndescription: Actual writing skill\n---\nWrite.",
              ],
            ]),
          };
        };
        const c = await (getCatalog as any)(db, "spec/public", {
          now: () => at,
          publicCatalog,
        });
        assert.equal(c.ref, ref);
        assert.equal(c.skills[0].path, "skills/actual");
        assert.equal(c.source, "github-public-archive");
        await (getCatalog as any)(db, "spec/public", {
          now: () => at,
          publicCatalog,
        });
        assert.equal(reads, 1);
        assert.equal((await db.all("SELECT * FROM skill_manifests")).length, 1);
      },
    );
  } finally {
    await db.close();
  }
});

test("public archive checks are pinned, bounded, complete and exclude symbolic Skill manifests", async () => {
  const { readPublicRepository } =
    await import("../src/server/public-repository.ts");
  function tar(files: { path: string; content: string; type?: string }[]) {
    const blocks: Buffer[] = [];
    for (const f of files) {
      const data = Buffer.from(f.content);
      const h = Buffer.alloc(512);
      h.write("repo-" + ref + "/" + f.path);
      h.write("0000644\0", 100);
      h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
      h.fill(32, 148, 156);
      h.write(f.type || "0", 156);
      h.write("ustar\0", 257);
      const sum = h.reduce((a, b) => a + b, 0);
      h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
  }
  const archive = tar([
    { path: "README.md", content: "A resource list" },
    {
      path: "skills/writer/SKILL.md",
      content: "---\nname: writer\ndescription: Writes articles\n---\nWrite.",
    },
    { path: "skills/fake/SKILL.md", content: "../outside", type: "2" },
  ]);
  const calls: string[] = [];
  const result = await readPublicRepository("spec/public", {
    fetcher: async (input) => {
      calls.push(String(input));
      return calls.length === 1
        ? new Response(
            '<script type="application/json" data-target="react-app.embeddedData">' +
              JSON.stringify({
                payload: {
                  codeViewRepoRoute: { refInfo: { currentOid: ref } },
                },
              }) +
              "</script>",
          )
        : new Response(archive);
    },
  });
  assert.equal(result.ref, ref);
  assert.ok(calls[1].endsWith("/" + ref));
  assert.equal(
    result.manifests.get("skills/writer")?.includes("name: writer"),
    true,
  );
  assert.equal(
    result.tree.some(
      (e: any) => e.path === "skills/fake/SKILL.md" && e.type === "blob",
    ),
    false,
  );
  await assert.rejects(() =>
    readPublicRepository("spec/missing", {
      fetcher: async () => new Response("<html>no verified commit</html>"),
    }),
  );
  for (const bad of [
    tar([{ path: "../outside/SKILL.md", content: "bad" }]),
    gzipSync(Buffer.alloc(51 * 1024 * 1024)),
  ]) {
    let n = 0;
    await assert.rejects(() =>
      readPublicRepository("spec/unsafe", {
        fetcher: async () =>
          ++n === 1
            ? new Response(
                '<script data-target="react-app.embeddedData">' +
                  JSON.stringify({
                    payload: {
                      codeViewRepoRoute: { refInfo: { currentOid: ref } },
                    },
                  }) +
                  "</script>",
              )
            : new Response(bad),
      }),
    );
  }
});

test("concurrent uncached repositories cannot spend the same final public-read budget slot twice", async () => {
  const db = await openDB(":memory:");
  let reads = 0;
  await db.run("INSERT INTO meta VALUES(?,?)", [
    "catalog-public-budget",
    JSON.stringify({ start: at, count: 9 }),
  ]);
  const publicCatalog = async () => {
    reads++;
    return {
      ref,
      tree: [{ path: "README.md", type: "blob", size: 100, mode: "100644" }],
      manifests: new Map<string, string>(),
    };
  };
  try {
    await withFetch(
      async () =>
        new Response('{"message":"rate limit"}', {
          status: 429,
          headers: { "retry-after": "60" },
        }),
      async () => {
        await Promise.allSettled([
          (getCatalog as any)(db, "spec/one", { now: () => at, publicCatalog }),
          (getCatalog as any)(db, "spec/two", { now: () => at, publicCatalog }),
        ]);
        assert.equal(reads, 1);
      },
    );
  } finally {
    await db.close();
  }
});

test("REST requests resume after reset instead of remaining stuck in the failure cache", async () => {
  const db = await openDB(":memory:");
  let time = at,
    calls = 0;
  try {
    await withFetch(
      async (input) => {
        calls++;
        if (time === at)
          return new Response('{"message":"rate limit"}', {
            status: 429,
            headers: { "retry-after": "60" },
          });
        return Response.json(
          String(input).includes("/commits/HEAD")
            ? { sha: ref }
            : { tree: [], truncated: false },
        );
      },
      async () => {
        await assert.rejects(() =>
          (getCatalog as any)(db, "spec/reset", {
            now: () => time,
            publicCatalog: async () => {
              throw new Error("Unavailable");
            },
          }),
        );
        time = at + 61000;
        const c = await (getCatalog as any)(db, "spec/reset", {
          now: () => time,
        });
        assert.equal(c.skills.length, 0);
        assert.equal(c.source, "github-api");
        assert.equal(calls, 3);
      },
    );
  } finally {
    await db.close();
  }
});

test("a public Retry-After is preserved across repositories rather than falling back to an earlier REST reset", async () => {
  const { GitHubQueryError } = await import("../src/server/github-query.ts");
  const db = await openDB(":memory:");
  let time = at,
    reads = 0;
  try {
    await withFetch(
      async () =>
        new Response('{"message":"rate limit"}', {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      async () => {
        const publicCatalog = async () => {
          reads++;
          throw new GitHubQueryError(
            "Public rate limit",
            "GITHUB_RATE_LIMITED",
            429,
            429,
            "2026-10-25T05:02:00.000Z",
          );
        };
        await assert.rejects(
          () =>
            (getCatalog as any)(db, "spec/pub-one", {
              now: () => time,
              publicCatalog,
            }),
          (e: any) => e.retryAt === "2026-10-25T05:02:00.000Z",
        );
        time += 61000;
        await assert.rejects(
          () =>
            (getCatalog as any)(db, "spec/pub-two", {
              now: () => time,
              publicCatalog,
            }),
          (e: any) => e.retryAt === "2026-10-25T05:02:00.000Z",
        );
        assert.equal(reads, 1);
      },
    );
  } finally {
    await db.close();
  }
});

test("a missing Chinese engine cannot block already verified Skill manifest previews", async () => {
  const { getSkillPage } = await import("../src/server/catalog.ts");
  const db = await openDB(":memory:");
  const checkedAt = new Date().toISOString();
  await db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
    "spec/writer",
    JSON.stringify({
      fullName: "spec/writer",
      ref,
      checkedAt,
      skills: [
        {
          name: "writer",
          path: "skills/writer",
          fileCount: 1,
          totalBytes: 100,
        },
      ],
    }),
    checkedAt,
  ]);
  await db.run("INSERT INTO skill_manifests VALUES(?,?,?,?,?)", [
    "spec/writer",
    ref,
    "skills/writer",
    JSON.stringify({ name: "writer", description: "Writes project articles." }),
    checkedAt,
  ]);
  try {
    const result = await getSkillPage(
      db,
      { repo: "spec/writer" },
      {
        translator: async () => {
          throw new Error("Engine unavailable");
        },
      },
    );
    assert.equal(result.items[0].manifestName, "writer");
    assert.match(result.warning || "", /中文/);
    assert.equal(
      (await db.all("SELECT * FROM explanation_requests")).length,
      1,
    );
  } finally {
    await db.close();
  }
});
