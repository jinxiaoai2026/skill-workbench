import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { buildApp } from "../src/server/app.ts";

const originalPassword = "original-test-secret";
const nextPassword = "new-secret1";
const origin = "https://skills.example.test";
async function fixture() {
  const db = await openDB(":memory:");
  const app = await buildApp({
    db,
    sessionKey: Buffer.alloc(32, 3),
    password: originalPassword,
    origin,
    allowCollection: false,
  });
  await app.ready();
  const login = (username: string | undefined, password = originalPassword) =>
    app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin },
      payload: { ...(username === undefined ? {} : { username }), password },
    });
  return {
    db,
    app,
    login,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
const cookie = (r: any) => String(r.headers["set-cookie"]).split(";")[0];

test("administrator login requires the correct account as well as password", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.login("someone-else")).statusCode, 401);
    assert.equal((await f.login(undefined)).statusCode, 401);
    assert.equal(
      (await f.login("admin", "incorrect-password")).statusCode,
      401,
    );
    const accepted = await f.login("admin");
    assert.equal(accepted.statusCode, 200);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/state",
          headers: { cookie: cookie(accepted) },
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test("changing the password accepts eleven characters and replaces the verifier without storing plaintext", async () => {
  const f = await fixture();
  try {
    const signedIn = await f.login("admin");
    const before = (
      await f.db.get("SELECT value FROM meta WHERE key='password'")
    ).value;
    const changed = await f.app.inject({
      method: "POST",
      url: "/api/password",
      headers: { cookie: cookie(signedIn), origin },
      payload: { current: originalPassword, newPassword: nextPassword },
    });
    assert.equal(changed.statusCode, 200);
    const after = (
      await f.db.get("SELECT value FROM meta WHERE key='password'")
    ).value;
    assert.notEqual(after, before);
    assert.equal(after.includes(nextPassword), false);
    assert.equal((await f.login("admin", nextPassword)).statusCode, 200);
    assert.equal((await f.login("admin", originalPassword)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test("password changes invalidate other sessions while retaining the changing administrator session", async () => {
  const f = await fixture();
  try {
    const first = await f.login("admin"),
      second = await f.login("admin");
    const changed = await f.app.inject({
      method: "POST",
      url: "/api/password",
      headers: { cookie: cookie(first), origin },
      payload: {
        current: originalPassword,
        newPassword: "long-new-test-password",
      },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/state",
          headers: { cookie: cookie(second) },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/session",
          headers: { cookie: cookie(second) },
        })
      ).json().authenticated,
      false,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/state",
          headers: { cookie: cookie(changed) },
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
