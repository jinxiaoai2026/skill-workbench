import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../web/api.ts";

test("catalog reads retry a transient gateway error once and retain a readable final error", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("Not Found", { status: 404 });
  };
  try {
    await assert.rejects(
      () => api("/catalog?repo=Nutlope%2Fhallmark"),
      (e: any) =>
        e.status === 404 &&
        /工作台.*重试/u.test(e.message) &&
        !e.message.includes("Unexpected token"),
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

test("catalog gateway recovery never repeats installation submissions or actual JSON errors", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response("Not Found", { status: 404 });
    };
    await assert.rejects(() =>
      api("/install", "POST", { fullName: "spec/repo" }),
    );
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: "接口不存在" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    };
    await assert.rejects(() => api("/catalog?repo=spec/repo"));
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response("Not Found", { status: 404 });
      return Response.json({ source: "device-git" });
    };
    assert.equal((await api("/catalog?repo=spec/repo")).source, "device-git");
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return Response.json({ items: [] });
    };
    assert.deepEqual(await api("/catalog/skills?repo=spec/repo"), {
      items: [],
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

test("GitHub JSON rate metadata remains available to the retry controls", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "GitHub 查询暂时受限",
        code: "GITHUB_RATE_LIMITED",
        retryAt: "2026-10-25T09:00:00.000Z",
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  try {
    await assert.rejects(
      () => api("/catalog?repo=example%2Fskill"),
      (e: any) =>
        e.status === 429 &&
        e.code === "GITHUB_RATE_LIMITED" &&
        e.retryAt === "2026-10-25T09:00:00.000Z" &&
        e.message === "GitHub 查询暂时受限",
    );
  } finally {
    globalThis.fetch = previous;
  }
});
