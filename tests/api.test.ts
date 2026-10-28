import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { buildApp } from "../src/server/app.ts";
import { Service } from "../src/server/service.ts";
const password = "a-test-password-123";

test("launch name editor routes require owner/device authorization and reject cross-site edits", async () => {
  const f = await fixture();
  try {
    const service = new Service(f.db);
    const p = await service.createPairing();
    const pair = await service.pair({ code: p.code, name: "Test Mac" });
    const skill = {
      id: "77777777-7777-4777-8777-777777777777",
      name: "design",
      ownership: "original",
      version: "a".repeat(16),
    };
    await service.ingest(pair.deviceId, { skills: [skill], events: [] });
    const edit = {
      method: "PATCH" as const,
      url: "/api/skills/" + skill.id,
      payload: { launchName: "店铺设计" },
    };
    assert.equal((await f.app.inject(edit)).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          ...edit,
          headers: { cookie: f.cookie, origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    const saved = await f.app.inject({
      ...edit,
      headers: { cookie: f.cookie },
    });
    assert.equal(saved.statusCode, 200);
    const jobId = saved.json().launchNameJob.id;
    assert.equal(
      (await f.app.inject("/api/skill-name-jobs/" + jobId)).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/device/name-jobs",
          headers: { cookie: f.cookie },
        })
      ).statusCode,
      401,
    );
    const deviceHeaders = { authorization: "Bearer " + pair.token };
    const job = (
      await f.app.inject({
        url: "/api/device/name-jobs",
        headers: deviceHeaders,
      })
    ).json();
    const result = {
      method: "POST" as const,
      url: "/api/device/name-jobs/" + jobId + "/result",
      payload: { ...job, status: "succeeded" },
    };
    assert.equal(
      (await f.app.inject({ ...result, headers: { cookie: f.cookie } }))
        .statusCode,
      401,
    );
    assert.equal(
      (await f.app.inject({ ...result, headers: deviceHeaders })).statusCode,
      200,
    );
    const state = (
      await f.app.inject({ url: "/api/state", headers: { cookie: f.cookie } })
    ).json();
    assert.equal(state.skills[0].codexName, "店铺设计");
    assert.equal(state.usage.confirmed, 0);
    const status = (
      await f.app.inject({
        url: "/api/skill-name-jobs/" + jobId,
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal("attemptToken" in status, false);
    assert.equal(status.status, "succeeded");
  } finally {
    await f.close();
  }
});
async function fixture() {
  const db = await openDB(":memory:");
  const app = await buildApp({
    db,
    sessionKey: Buffer.alloc(32, 7),
    password,
    origin: "http://localhost:4317",
    allowCollection: false,
  });
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username: "admin", password },
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  return {
    db,
    app,
    cookie,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
test("unauthenticated reads and cross-origin writes are rejected; login is persistent cookie based", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject("/api/state")).statusCode, 401);
    assert.equal(
      (await f.app.inject({ url: "/api/state", headers: { cookie: f.cookie } }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/skills",
          headers: { cookie: f.cookie, origin: "https://evil.example" },
          payload: { name: "bad", ownership: "original" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});
test("pairing is single-use, replay does not increase usage, end-before-start and revoked devices work", async () => {
  const f = await fixture();
  try {
    const p = (
      await f.app.inject({
        method: "POST",
        url: "/api/pairings",
        headers: { cookie: f.cookie },
      })
    ).json();
    const pair = (
      await f.app.inject({
        method: "POST",
        url: "/api/pair",
        payload: { code: p.code, name: "Test Mac" },
      })
    ).json();
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/pair",
          payload: { code: p.code, name: "Test" },
        })
      ).statusCode,
      400,
    );
    const headers = { authorization: "Bearer " + pair.token };
    const skill = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "我的技能",
      description: "",
      ownership: "original",
      version: "a",
    };
    const base = {
      invocationId: "i1",
      skillId: skill.id,
      occurredAt: "2026-10-23T16:00:00Z",
      evidence: "confirmed",
      source: "managed-entry",
    };
    const end = { ...base, eventId: "e2", type: "end", status: "failed" };
    const start = { ...base, eventId: "e1", type: "start" };
    for (const events of [[end], [start], [start]])
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/sync",
            headers,
            payload: { skills: [skill], events },
          })
        ).statusCode,
        200,
      );
    const data = (
      await f.app.inject({
        url: "/api/state?range=custom&from=2026-10-24&to=2026-10-24",
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(data.usage.confirmed, 1);
    assert.equal(data.usage.inferred, 0);
    assert.equal(data.usage.events[0].status, "failed");
    const previous = (
      await f.app.inject({
        url: "/api/state?range=custom&from=2026-10-23&to=2026-10-23",
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(previous.usage.confirmed, 0);
    const conflict = await f.app.inject({
      method: "POST",
      url: "/api/sync",
      headers,
      payload: {
        skills: [skill],
        events: [
          {
            ...start,
            eventId: "e3",
            evidence: "inferred",
            source: "history-read",
          },
        ],
      },
    });
    assert.equal(conflict.statusCode, 400);
    await f.app.inject({
      method: "DELETE",
      url: "/api/devices/" + pair.deviceId,
      headers: { cookie: f.cookie },
    });
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/sync",
          headers,
          payload: { skills: [skill], events: [] },
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});
test("skill editing retains identity, excludes third-party ownership and CSV neutralizes formulas", async () => {
  const f = await fixture();
  try {
    const created = await f.app.inject({
      method: "POST",
      url: "/api/skills",
      headers: { cookie: f.cookie },
      payload: {
        name: "=SUM(1)",
        description: "Test",
        ownership: "original",
        platforms: ["抖音"],
        category: "内容制作",
      },
    });
    assert.equal(created.statusCode, 200);
    const s = created.json();
    const change = await f.app.inject({
      method: "PATCH",
      url: "/api/skills/" + s.id,
      headers: { cookie: f.cookie },
      payload: { name: "新名称" },
    });
    assert.equal(change.json().id, s.id);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/skills",
          headers: { cookie: f.cookie },
          payload: { name: "third", ownership: "thirdParty" },
        })
      ).statusCode,
      400,
    );
    await f.app.inject({
      method: "PATCH",
      url: "/api/skills/" + s.id,
      headers: { cookie: f.cookie },
      payload: { name: "=SUM(1)" },
    });
    const csv = await f.app.inject({
      url: "/api/export?kind=skills",
      headers: { cookie: f.cookie },
    });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.body, /'=SUM/);
  } finally {
    await f.close();
  }
});
test("CSV exports every matching invocation beyond the UI limit and device filtering affects totals", async () => {
  const f = await fixture();
  try {
    const p = (
      await f.app.inject({
        method: "POST",
        url: "/api/pairings",
        headers: { cookie: f.cookie },
      })
    ).json();
    const pair = (
      await f.app.inject({
        method: "POST",
        url: "/api/pair",
        payload: { code: p.code, name: "Export Mac" },
      })
    ).json();
    const skill = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "导出测试",
      ownership: "original",
      category: "经营分析",
      platforms: ["京东"],
    };
    const events = Array.from({ length: 205 }, (_, i) => ({
      eventId: "export-" + i,
      invocationId: "export-call-" + i,
      skillId: skill.id,
      occurredAt: "2026-10-24T01:00:00Z",
      type: "start",
      evidence: "confirmed",
      source: "managed-entry",
    }));
    for (let i = 0; i < events.length; i += 200)
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/sync",
            headers: { authorization: "Bearer " + pair.token },
            payload: { skills: [skill], events: events.slice(i, i + 200) },
          })
        ).statusCode,
        200,
      );
    const url = "/api/export?range=custom&from=2026-10-24&to=2026-10-24";
    const csv = await f.app.inject({ url, headers: { cookie: f.cookie } });
    assert.equal(csv.body.split("\r\n").length, 206);
    const filtered = (
      await f.app.inject({
        url: "/api/state?range=custom&from=2026-10-24&to=2026-10-24&platform=抖音",
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(filtered.usage.confirmed, 0);
  } finally {
    await f.close();
  }
});

test("install API requires owner authorization and results can only be submitted by the assigned device", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject("/api/catalog?repo=o/r")).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/install",
          payload: { fullName: "o/r", path: "skills/a", deviceId: "x" },
        })
      ).statusCode,
      401,
    );
    const p = (
      await f.app.inject({
        method: "POST",
        url: "/api/pairings",
        headers: { cookie: f.cookie },
      })
    ).json();
    const device = (
      await f.app.inject({
        method: "POST",
        url: "/api/pair",
        payload: { code: p.code, name: "Install Mac" },
      })
    ).json();
    const catalog = {
      fullName: "o/r",
      ref: "a".repeat(40),
      skills: [
        {
          name: "sample",
          path: "skills/sample",
          fileCount: 1,
          totalBytes: 100,
        },
      ],
      checkedAt: new Date().toISOString(),
    };
    await f.db.run("INSERT INTO skill_catalogs VALUES(?,?,?)", [
      catalog.fullName,
      JSON.stringify(catalog),
      catalog.checkedAt,
    ]);
    const response = await f.app.inject({
      method: "POST",
      url: "/api/install",
      headers: { cookie: f.cookie },
      payload: {
        fullName: "o/r",
        path: "skills/sample",
        deviceId: device.deviceId,
      },
    });
    assert.equal(response.statusCode, 200);
    const job = response.json();
    const headers = { authorization: "Bearer " + device.token };
    const claimed = await f.app.inject({ url: "/api/device/jobs", headers });
    assert.equal(claimed.json().id, job.id);
    const done = await f.app.inject({
      method: "POST",
      url: "/api/device/jobs/" + job.id + "/result",
      headers,
      payload: {
        status: "succeeded",
        installedName: "sample",
        manifestHash: "b".repeat(64),
        attemptToken: claimed.json().attemptToken,
      },
    });
    assert.equal(done.statusCode, 200);
    const data = (
      await f.app.inject({ url: "/api/state", headers: { cookie: f.cookie } })
    ).json();
    assert.equal(data.installedSkills.length, 1);
    assert.equal(data.skills.length, 0);
    assert.equal(data.usage.confirmed, 0);
    const renamePayload = {
      fullName: "o/r",
      path: "skills/sample",
      deviceId: device.deviceId,
      customName: "网页设计",
    };
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/install/alias",
          payload: renamePayload,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/install/alias",
          headers: { cookie: f.cookie, origin: "https://evil.example" },
          payload: renamePayload,
        })
      ).statusCode,
      403,
    );
    const renamed = await f.app.inject({
      method: "POST",
      url: "/api/install/alias",
      headers: { cookie: f.cookie },
      payload: renamePayload,
    });
    assert.equal(renamed.statusCode, 200);
    const aliasClaim = (
      await f.app.inject({ url: "/api/device/jobs", headers })
    ).json();
    assert.equal(aliasClaim.kind, "alias");
    assert.equal(aliasClaim.customName, "网页设计");
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/device/jobs/" + renamed.json().id + "/result",
          headers,
          payload: {
            status: "succeeded",
            installedName: "sample",
            customName: "网页设计",
            attemptToken: aliasClaim.attemptToken,
          },
        })
      ).statusCode,
      200,
    );
    const renamedState = (
      await f.app.inject({ url: "/api/state", headers: { cookie: f.cookie } })
    ).json();
    assert.equal(renamedState.installedSkills[0].custom_name, "网页设计");
    assert.equal(renamedState.usage.confirmed, 0);
  } finally {
    await f.close();
  }
});
