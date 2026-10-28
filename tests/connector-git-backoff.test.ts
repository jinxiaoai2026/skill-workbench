import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Connector } from "../connector/registry.ts";
import { runInstallJob } from "../connector/jobs.ts";
test("a Git Retry-After persists across connector restarts and leaves subsequent install jobs unclaimed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "connector-git-backoff-")),
    script = join(root, "git-probe"),
    log = join(root, "git.log");
  const keys = [
      "WORKBENCH_GIT",
      "WORKBENCH_DEVICE_TOKEN",
      "WORKBENCH_SKILL_DESTINATION",
      "WORKBENCH_BACKOFF_TEST_LOG",
    ],
    before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  writeFileSync(
    script,
    '#!/bin/sh\necho called >> "$WORKBENCH_BACKOFF_TEST_LOG"\nprintf "HTTP/2 429\\nRetry-After: 120\\n" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  Object.assign(process.env, {
    WORKBENCH_GIT: script,
    WORKBENCH_DEVICE_TOKEN: "fixture-device-token",
    WORKBENCH_SKILL_DESTINATION: join(root, "installed"),
    WORKBENCH_BACKOFF_TEST_LOG: log,
  });
  let at = Date.parse("2026-10-25T09:00:00Z");
  t.mock.method(Date, "now", () => at);
  let claims = 0;
  const results: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/device/jobs") {
      claims++;
      res.end(
        JSON.stringify({
          id: "job" + claims,
          fullName: "spec/repo",
          ref: "a".repeat(40),
          path: "skills/one",
          name: "one",
          attemptToken: "00000000-0000-4000-8000-000000000000",
        }),
      );
    } else {
      let body = "";
      for await (const c of req) body += c;
      results.push(JSON.parse(body));
      res.end('{"ok":true}');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  let c = new Connector(join(root, "state"));
  c.setting("server", origin);
  c.setting("deviceId", "fixture-device");
  try {
    await runInstallJob(c);
    assert.match(results[0].message, /GitHub.*限流/);
    assert.equal(c.setting("github-download-until"), String(at + 120000));
    c.close();
    c = new Connector(join(root, "state"));
    await runInstallJob(c);
    assert.equal(claims, 1);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
    at += 120001;
    await runInstallJob(c);
    assert.equal(claims, 2);
  } finally {
    c.close();
    await new Promise<void>((r) => server.close(() => r()));
    for (const k of keys)
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    rmSync(root, { recursive: true, force: true });
  }
});
