import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDB } from "../src/server/db.ts";
import { buildApp } from "../src/server/app.ts";
import { hash } from "../src/server/auth.ts";
import { Connector } from "../connector/registry.ts";
import { runCatalogJob } from "../connector/catalog-jobs.ts";
import { PublicGitError } from "../src/core/public-git.ts";
test("paired worker sends only public catalog metadata; owner and device APIs retain separate authorization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-worker-")),
    db = await openDB(":memory:"),
    c = new Connector(dir);
  const previous = process.env.WORKBENCH_DEVICE_TOKEN;
  process.env.WORKBENCH_DEVICE_TOKEN = "fixture_token";
  const app = await buildApp({
    db,
    sessionKey: Buffer.alloc(32, 7),
    password: "fixture-password",
    origin: "http://127.0.0.1:4317",
    allowCollection: false,
  });
  try {
    await db.run("INSERT INTO devices VALUES(?,?,?,0,?,?)", [
      "one",
      "Mac",
      hash("fixture_token"),
      new Date().toISOString(),
      new Date().toISOString(),
    ]);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    c.setting("server", origin);
    c.setting("deviceId", "one");
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/device/catalog-jobs" }))
        .statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "fixture-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/device/catalog-jobs",
          headers: { cookie },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/catalog?repo=spec/repo",
          headers: { "x-workbench-device-token": "fixture_token" },
        })
      ).statusCode,
      401,
    );
    await runCatalogJob(c);
    const pending = await app.inject({
      method: "GET",
      url: "/api/catalog?repo=spec/repo",
      headers: { cookie },
    });
    assert.equal(pending.statusCode, 503);
    assert.equal(pending.json().code, "CATALOG_PENDING");
    let reads = 0;
    await runCatalogJob(c, async (name) => {
      reads++;
      assert.equal(name, "spec/repo");
      return {
        ref: "a".repeat(40),
        tree: [
          {
            path: "skills/design/SKILL.md",
            type: "blob",
            mode: "100644",
            oid: "b".repeat(40),
          },
        ],
        manifests: new Map([
          [
            "skills/design",
            "---\nname: design\ndescription: Design a page\n---\nDO NOT UPLOAD THIS INSTRUCTION BODY",
          ],
        ]),
        omittedVariants: 0,
      };
    });
    assert.equal(reads, 1);
    const cached = await app.inject({
      method: "GET",
      url: "/api/catalog?repo=spec/repo",
      headers: { cookie },
    });
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.json().source, "device-git");
    const manifests = await db.all("SELECT payload FROM skill_manifests");
    assert.doesNotMatch(JSON.stringify(manifests), /DO NOT UPLOAD/);
    assert.equal((await db.all("SELECT * FROM install_jobs")).length, 0);
    assert.equal(c.skills().length, 0);
    await app.inject({
      method: "GET",
      url: "/api/catalog?repo=spec/limited",
      headers: { cookie },
    });
    await runCatalogJob(c, async () => {
      throw new PublicGitError(
        "limited",
        "GIT_RATE_LIMITED",
        new Date(Date.now() + 120000).toISOString(),
      );
    });
    assert.ok(Number(c.setting("github-download-until")) > Date.now());
    await runCatalogJob(c, async () => {
      throw new Error("must not read while held");
    });
    const limited = await app.inject({
      method: "GET",
      url: "/api/catalog?repo=spec/new&refresh=1",
      headers: { cookie },
    });
    assert.equal(limited.statusCode, 429);
    await db.run("UPDATE devices SET revoked=1 WHERE id='one'");
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/device/catalog-jobs",
          headers: { "x-workbench-device-token": "fixture_token" },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
    c.close();
    await db.close();
    if (previous === undefined) delete process.env.WORKBENCH_DEVICE_TOKEN;
    else process.env.WORKBENCH_DEVICE_TOKEN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
