import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Connector } from "../connector/registry.ts";
import { sync, validateServer } from "../connector/sync.ts";
import { normalizeServer, requestServer } from "../connector/transport.ts";
import { runInstallJob } from "../connector/jobs.ts";
import { runSkillNameJob } from "../connector/name-jobs.ts";

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "connector-transport-"));
  const skillDirectory = join(root, "sample");
  mkdirSync(skillDirectory);
  writeFileSync(
    join(skillDirectory, "SKILL.md"),
    "---\nname: sample\ndescription: A private local skill\n---\nPrivate instructions.",
  );
  const connector = new Connector(join(root, "state"));
  const skill = connector.adopt(skillDirectory, "original");
  connector.setting("deviceId", "test-device");
  connector.enqueue({
    eventId: "gate-event",
    invocationId: "gate-call",
    skillId: skill.id,
    occurredAt: "2026-10-25T00:00:00Z",
    type: "start",
    evidence: "confirmed",
    source: "managed-entry",
  });
  return {
    connector,
    skill,
    close() {
      connector.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("sync bootstraps an anonymous share gate and ACKs metadata plus usage exactly once", async () => {
  const local = fixture();
  const previousToken = process.env.WORKBENCH_DEVICE_TOKEN;
  process.env.WORKBENCH_DEVICE_TOKEN = "test-device-secret";
  const bootstraps: {
    url: string;
    method?: string;
    headers: IncomingMessage["headers"];
    body: string;
  }[] = [];
  const batches: any[] = [];
  const effects = new Set<string>();
  const http = await listen(async (request, response) => {
    const body = await readBody(request);
    if (request.url === "/?sharecode=private-share") {
      bootstraps.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
      });
      response.setHeader("set-cookie", [
        "__wb_rsc=gate-one; Path=/; HttpOnly; Max-Age=3600",
        "unrelated=must-not-be-forwarded; Path=/",
      ]);
      response.end("gate ready");
      return;
    }
    if (request.headers.cookie !== "__wb_rsc=gate-one") {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Forbidden");
      return;
    }
    assert.equal(request.url, "/api/sync");
    assert.equal(
      request.headers["x-workbench-device-token"],
      "test-device-secret",
    );
    assert.equal(request.headers.authorization, undefined);
    const payload = JSON.parse(body);
    batches.push(payload);
    for (const event of payload.events) effects.add(event.eventId);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        acked: payload.events.map((event: any) => event.eventId),
      }),
    );
  });
  local.connector.setting("server", http.origin + "/?sharecode=private-share");
  try {
    assert.deepEqual(await sync(local.connector, { discover: false }), {
      skills: 1,
      events: 1,
    });
    assert.equal(local.connector.pending().length, 0);
    await sync(local.connector, { discover: false });
    assert.equal(effects.size, 1);
    assert.equal(batches.filter((batch) => batch.events.length).length, 1);
    assert.equal(batches[0].skills[0].id, local.skill.id);
    assert.equal(batches[0].skills[0].path, undefined);
    assert.equal(batches[0].skills[0].content, undefined);
    assert.equal(bootstraps.length, 1);
    assert.equal(bootstraps[0].method, "GET");
    assert.equal(bootstraps[0].body, "");
    assert.equal(bootstraps[0].headers.authorization, undefined);
    assert.equal(bootstraps[0].headers["x-workbench-device-token"], undefined);
    assert.equal(bootstraps[0].headers.cookie, undefined);
    assert.equal(bootstraps[0].headers["content-type"], undefined);
  } finally {
    if (previousToken === undefined) delete process.env.WORKBENCH_DEVICE_TOKEN;
    else process.env.WORKBENCH_DEVICE_TOKEN = previousToken;
    await http.close();
    local.close();
  }
});

for (const status of [403, 404])
  test(`plain-text gateway ${status} renews the gate and replays a request once`, async () => {
    let bootstraps = 0;
    let attempts = 0;
    let effects = 0;
    const http = await listen(async (request, response) => {
      const body = await readBody(request);
      if (request.url === "/?sharecode=renew") {
        bootstraps++;
        assert.equal(request.method, "GET");
        assert.equal(request.headers["x-workbench-device-token"], undefined);
        assert.equal(request.headers.authorization, undefined);
        assert.equal(body, "");
        response.setHeader(
          "set-cookie",
          `__wb_rsc=cookie-${bootstraps}; Path=/`,
        );
        response.end("ready");
        return;
      }
      attempts++;
      if (request.headers.cookie === "__wb_rsc=cookie-1") {
        response.writeHead(status, { "content-type": "text/plain" });
        response.end(status === 403 ? "Forbidden" : "Not Found");
        return;
      }
      assert.equal(request.headers.cookie, "__wb_rsc=cookie-2");
      assert.equal(
        request.headers["x-workbench-device-token"],
        "fake-device-token",
      );
      assert.equal(body, '{"eventId":"one-effect"}');
      effects++;
      response.setHeader("content-type", "application/json");
      response.end('{"acked":["one-effect"]}');
    });
    try {
      const response = await requestServer(
        http.origin + "/?sharecode=renew",
        "/api/sync",
        {
          method: "POST",
          headers: { "x-workbench-device-token": "fake-device-token" },
          body: '{"eventId":"one-effect"}',
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { acked: ["one-effect"] });
      assert.equal(bootstraps, 2);
      assert.equal(attempts, 2);
      assert.equal(effects, 1);
    } finally {
      await http.close();
    }
  });

test("a share entry 404 with a newly issued gate cookie checks the same-origin root before API upload", async () => {
  const calls: {
    path?: string;
    cookie?: string;
    token?: string | string[];
    body: string;
  }[] = [];
  const http = await listen(async (request, response) => {
    const body = await readBody(request);
    calls.push({
      path: request.url,
      cookie: request.headers.cookie,
      token: request.headers["x-workbench-device-token"],
      body,
    });
    if (request.url === "/?sharecode=first-entry") {
      response.writeHead(404, {
        "content-type": "text/plain",
        "set-cookie": "__wb_rsc=valid-new-session; Path=/; HttpOnly",
      });
      response.end("Not Found");
      return;
    }
    assert.equal(request.headers.cookie, "__wb_rsc=valid-new-session");
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end("<html>workbench</html>");
      return;
    }
    assert.equal(request.url, "/api/sync");
    response.setHeader("content-type", "application/json");
    response.end('{"acked":["one"]}');
  });
  try {
    const r = await requestServer(
      http.origin + "/?sharecode=first-entry",
      "/api/sync",
      {
        method: "POST",
        headers: {
          "x-workbench-device-token": "private-device-token",
          "content-type": "application/json",
        },
        body: '{"eventId":"one"}',
      },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { acked: ["one"] });
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/?sharecode=first-entry", "/", "/api/sync"],
    );
    assert.ok(
      calls.slice(0, 2).every((c) => c.token === undefined && c.body === ""),
    );
    assert.equal(calls[2].token, "private-device-token");
    assert.equal(calls[2].body, '{"eventId":"one"}');
  } finally {
    await http.close();
  }
});

test("a failed same-origin root probe never sends device credentials or queued events", async () => {
  let calls = 0;
  const http = await listen(async (request, response) => {
    calls++;
    assert.equal(request.headers["x-workbench-device-token"], undefined);
    assert.equal(await readBody(request), "");
    response.writeHead(404, {
      "content-type": "text/plain",
      ...(calls === 1 ? { "set-cookie": "__wb_rsc=unusable; Path=/" } : {}),
    });
    response.end("Not Found");
  });
  try {
    await assert.rejects(
      () =>
        requestServer(http.origin + "/?sharecode=bad-entry", "/api/sync", {
          method: "POST",
          headers: { "x-workbench-device-token": "private-device-token" },
          body: "private-payload",
        }),
      /无法打开服务器/,
    );
    assert.equal(calls, 2);
  } finally {
    await http.close();
  }
});

test("persistent gateway rejection refreshes at most once and application JSON rejection never refreshes", async () => {
  for (const contentType of ["text/plain", "application/json"]) {
    let bootstraps = 0;
    let attempts = 0;
    const http = await listen((request, response) => {
      if (request.url === "/?sharecode=denied") {
        response.setHeader(
          "set-cookie",
          `__wb_rsc=cookie-${++bootstraps}; Path=/`,
        );
        response.end("ready");
      } else {
        attempts++;
        response.writeHead(403, { "content-type": contentType });
        response.end(
          contentType === "text/plain"
            ? "Forbidden"
            : '{"error":"device revoked"}',
        );
      }
    });
    try {
      const response = await requestServer(
        http.origin + "/?sharecode=denied",
        "/api/sync",
      );
      assert.equal(response.status, 403);
      await response.body?.cancel();
      assert.equal(bootstraps, contentType === "text/plain" ? 2 : 1);
      assert.equal(attempts, contentType === "text/plain" ? 2 : 1);
    } finally {
      await http.close();
    }
  }
});

test("an expired gate cookie refreshes before the next API call", async () => {
  let bootstraps = 0;
  const cookies: (string | undefined)[] = [];
  const http = await listen((request, response) => {
    if (request.url === "/?sharecode=expiry") {
      response.setHeader(
        "set-cookie",
        `__wb_rsc=cookie-${++bootstraps}; Max-Age=3600; Path=/`,
      );
      response.end("ready");
      return;
    }
    cookies.push(request.headers.cookie);
    if (cookies.length === 1)
      response.setHeader("set-cookie", "__wb_rsc=expired; Max-Age=0; Path=/");
    response.setHeader("content-type", "application/json");
    response.end("null");
  });
  try {
    const server = http.origin + "/?sharecode=expiry";
    await (await requestServer(server, "/api/device/jobs")).json();
    await (await requestServer(server, "/api/device/jobs")).json();
    assert.equal(bootstraps, 2);
    assert.deepEqual(cookies, ["__wb_rsc=cookie-1", "__wb_rsc=cookie-2"]);
  } finally {
    await http.close();
  }
});

test("share gate follows only same-origin anonymous redirects and retains only its gate cookie", async () => {
  const calls: string[] = [];
  const http = await listen(async (request, response) => {
    calls.push(request.url!);
    if (request.url === "/?sharecode=redirect") {
      assert.equal(request.headers["x-workbench-device-token"], undefined);
      assert.equal(await readBody(request), "");
      response.writeHead(302, {
        location: "/",
        "set-cookie": [
          "__wb_rsc=redirect-cookie; Path=/",
          "other=ignored; Path=/",
        ],
      });
      response.end();
    } else if (request.url === "/") {
      assert.equal(request.method, "GET");
      assert.equal(request.headers["x-workbench-device-token"], undefined);
      assert.equal(request.headers.cookie, "__wb_rsc=redirect-cookie");
      response.end("ready");
    } else {
      assert.equal(request.headers.cookie, "__wb_rsc=redirect-cookie");
      response.end("ok");
    }
  });
  try {
    assert.equal(
      (
        await requestServer(http.origin + "/?sharecode=redirect", "/api/sync", {
          method: "POST",
          headers: {
            "x-workbench-device-token": "fake-device-token",
            cookie: "other=do-not-send",
          },
          body: "private body",
        })
      ).status,
      200,
    );
    assert.deepEqual(calls, ["/?sharecode=redirect", "/", "/api/sync"]);
  } finally {
    await http.close();
  }
});

test("cross-origin API paths and redirects never forward device credentials or bodies", async () => {
  const received: string[] = [];
  const other = await listen(async (request, response) => {
    received.push(
      (request.headers["x-workbench-device-token"] || "") +
        (await readBody(request)),
    );
    response.end("unreachable");
  });
  let gateRedirect = false;
  const http = await listen((request, response) => {
    if (request.url?.startsWith("/?sharecode=") && !gateRedirect) {
      response.setHeader("set-cookie", "__wb_rsc=private-cookie; Path=/");
      response.end("ready");
    } else {
      response.writeHead(307, { location: other.origin + "/api/capture" });
      response.end();
    }
  });
  const init = {
    method: "POST",
    headers: {
      authorization: "Bearer fake-secret",
      "x-workbench-device-token": "fake-device-token",
    },
    body: "private-event-body",
  };
  try {
    const server = http.origin + "/?sharecode=redirect-secret";
    await assert.rejects(
      () => requestServer(server, other.origin + "/api/capture", init),
      /API 路径/,
    );
    await assert.rejects(
      () =>
        requestServer(
          server,
          "//127.0.0.1:" + new URL(other.origin).port + "/api/capture",
          init,
        ),
      /API 路径/,
    );
    for (const path of ["", "api/sync", "/\\outside/api", "/api/\nsync"])
      await assert.rejects(() => requestServer(server, path, init), /API 路径/);
    await assert.rejects(
      () => requestServer(server, "/api/sync", init),
      /重定向/,
    );
    gateRedirect = true;
    await assert.rejects(
      () =>
        requestServer(
          http.origin + "/?sharecode=new-secret",
          "/api/pair",
          init,
        ),
      /重定向/,
    );
    assert.deepEqual(received, []);
  } finally {
    await Promise.all([http.close(), other.close()]);
  }
});

test("pair CLI reaches the private gate anonymously and keeps secrets out of failure output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "connector-pair-"));
  const paths: string[] = [];
  const http = await listen(async (request, response) => {
    paths.push(request.url!);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-workbench-device-token"], undefined);
    const body = await readBody(request);
    if (request.url === "/?sharecode=private-url-code") {
      assert.equal(body, "");
      assert.equal(request.method, "GET");
      response.setHeader("set-cookie", "__wb_rsc=pair-cookie; Path=/");
      response.end("ready");
    } else {
      assert.equal(request.headers.cookie, "__wb_rsc=pair-cookie");
      assert.deepEqual(JSON.parse(body), {
        code: "private-pair-code",
        name: "Test Mac",
      });
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"expired pair code"}');
    }
  });
  try {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "connector/cli.ts",
        "pair",
        http.origin + "/?sharecode=private-url-code",
        "private-pair-code",
        "--name",
        "Test Mac",
      ],
      {
        env: { ...process.env, WORKBENCH_CONNECTOR_DIR: directory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 1);
    assert.deepEqual(paths, ["/?sharecode=private-url-code", "/api/pair"]);
    assert.match(output, /配对失败/);
    assert.doesNotMatch(
      output,
      /private-url-code|private-pair-code|pair-cookie/,
    );
  } finally {
    await http.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal servers do not bootstrap and both device job claimers use the shared gate transport", async () => {
  const local = fixture();
  const previousToken = process.env.WORKBENCH_DEVICE_TOKEN;
  process.env.WORKBENCH_DEVICE_TOKEN = "job-device-token";
  let bootstraps = 0;
  const paths: string[] = [];
  const http = await listen((request, response) => {
    if (request.url === "/?sharecode=jobs") {
      bootstraps++;
      response.setHeader("set-cookie", "__wb_rsc=jobs-cookie; Path=/");
      response.end("ready");
      return;
    }
    paths.push(request.url!);
    if (request.url !== "/api/plain") {
      assert.equal(request.headers.cookie, "__wb_rsc=jobs-cookie");
      assert.equal(
        request.headers["x-workbench-device-token"],
        "job-device-token",
      );
      assert.equal(request.headers.authorization, undefined);
    } else assert.equal(request.headers.cookie, undefined);
    response.setHeader("content-type", "application/json");
    response.end("null");
  });
  try {
    await (await requestServer(http.origin, "/api/plain")).json();
    assert.equal(bootstraps, 0);
    local.connector.setting("server", http.origin + "/?sharecode=jobs");
    await runInstallJob(local.connector);
    await runSkillNameJob(local.connector);
    assert.equal(bootstraps, 1);
    assert.deepEqual(paths, [
      "/api/plain",
      "/api/device/jobs",
      "/api/device/name-jobs",
    ]);
  } finally {
    if (previousToken === undefined) delete process.env.WORKBENCH_DEVICE_TOKEN;
    else process.env.WORKBENCH_DEVICE_TOKEN = previousToken;
    await http.close();
    local.close();
  }
});

test("server normalization keeps only the validated origin and optional share code without exposing invalid input", () => {
  const accepted = [
    ["https://EXAMPLE.test:443/path?ignored=x#section", "https://example.test"],
    [
      "https://example.test/?sharecode=a%2Bb%2F%3D&ignored=x#section",
      "https://example.test/?sharecode=a%2Bb%2F%3D",
    ],
    ["http://localhost:4123/", "http://localhost:4123"],
    ["http://[::1]:4123/", "http://[::1]:4123"],
  ];
  for (const [input, expected] of accepted) {
    assert.equal(normalizeServer(input), expected);
    assert.equal(validateServer(input), new URL(expected).origin);
  }
  for (const input of [
    undefined,
    null,
    42,
    "",
    "not-a-url",
    "http://example.test",
    "file:///tmp/test",
    "https://user:private-secret@example.test/?sharecode=private-code",
    "https://@example.test/",
    "h\nttps://@example.test/",
    "https://example.test/?sharecode=",
    "https://example.test/?sharecode=a&sharecode=b",
    "https://example.test/?sharecode=a%0Ab",
  ]) {
    assert.throws(
      () => normalizeServer(input as string),
      (error: Error) => {
        assert.doesNotMatch(error.message, /private-secret|private-code/);
        return true;
      },
    );
  }
});
