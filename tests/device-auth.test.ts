import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { buildApp } from "../src/server/app.ts";
import { Service } from "../src/server/service.ts";

test("namespaced device credentials authenticate through proxies without changing scope or revocation", async () => {
  const db = await openDB(":memory:");
  const app = await buildApp({
    db,
    sessionKey: Buffer.alloc(32, 4),
    password: "test-admin-password",
    origin: "https://skills.example.test",
    allowCollection: false,
  });
  try {
    await app.ready();
    const service = new Service(db),
      pairing = await service.createPairing();
    const device = await service.pair({ code: pairing.code, name: "My Mac" });
    const sync = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/sync",
        headers,
        payload: { skills: [], events: [] },
      });
    assert.equal(
      (await sync({ "x-workbench-device-token": device.token })).statusCode,
      200,
    );
    assert.equal(
      (await sync({ authorization: "Bearer " + device.token })).statusCode,
      200,
    );
    assert.equal(
      (await sync({ "x-workbench-device-token": "invalid" })).statusCode,
      401,
    );
    assert.equal((await sync({})).statusCode, 401);
    assert.equal(
      (
        await sync({
          "x-workbench-device-token": device.token,
          authorization: "Bearer another-device-token",
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/state",
          headers: { "x-workbench-device-token": device.token },
        })
      ).statusCode,
      401,
    );
    await db.run("UPDATE devices SET revoked=1 WHERE id=?", [device.deviceId]);
    assert.equal(
      (await sync({ "x-workbench-device-token": device.token })).statusCode,
      401,
    );
  } finally {
    await app.close();
    await db.close();
  }
});
