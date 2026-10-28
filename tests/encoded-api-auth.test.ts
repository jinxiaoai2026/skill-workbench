import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { buildApp } from "../src/server/app.ts";
const opts = (db: any) => ({
  db,
  sessionKey: Buffer.alloc(32, 21),
  password: "fixture-owner-password",
  origin: "http://localhost:4317",
  allowCollection: false,
});
test("encoded API prefixes and segments keep owner/device authentication and no-store boundaries", async () => {
  const db = await openDB(":memory:"),
    app = await buildApp(opts(db));
  try {
    for (const url of [
      "/api/state",
      "/%61pi/state",
      "/a%70i/state",
      "/api/%73tate",
    ]) {
      const r = await app.inject({ url });
      assert.equal(r.statusCode, 401, url);
      assert.equal(r.headers["cache-control"], "no-store");
    }
    for (const url of ["/%61pi/skills", "/%61pi/pairings"])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            payload: { name: "Should not exist", ownership: "original" },
          })
        ).statusCode,
        401,
        url,
      );
    assert.equal((await db.all("SELECT * FROM skills")).length, 0);
    assert.equal((await db.all("SELECT * FROM pairings")).length, 0);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "fixture-owner-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    assert.equal(
      (await app.inject({ url: "/%61pi/state", headers: { cookie } }))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/%61pi/device/jobs", headers: { cookie } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/%61pi/skills",
          headers: { cookie, origin: "https://untrusted.example" },
          payload: { name: "Blocked", ownership: "original" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    await db.close();
  }
});
