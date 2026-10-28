import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { buildApp } from "../src/server/app.ts";
test("Git runtime status is owner-only and never exposes unrelated quota fields or secrets", async () => {
  const db = await openDB(":memory:"),
    app = await buildApp({
      db,
      sessionKey: Buffer.alloc(32, 7),
      password: "fixture-password",
      origin: "http://127.0.0.1:4317",
      allowCollection: false,
    });
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/github/status" }))
        .statusCode,
      401,
    );
    await db.run("INSERT INTO meta VALUES(?,?)", [
      "github-api-budget",
      JSON.stringify({
        remaining: 0,
        limit: 60,
        resetAt: "2026-10-25T10:00:00Z",
        token: "should-not-leak",
      }),
    ]);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "fixture-password" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const response = await app.inject({
      method: "GET",
      url: "/api/github/status",
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.git.available, true);
    assert.match(body.git.version, /^git version /);
    assert.equal(body.api.remaining, 0);
    assert.doesNotMatch(response.body, /should-not-leak|password|sessionKey/);
  } finally {
    await app.close();
    await db.close();
  }
});
