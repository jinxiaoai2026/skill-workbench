import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Connector } from "../connector/registry.ts";
import { runInstallJob } from "../connector/jobs.ts";
import { runCatalogJob } from "../connector/catalog-jobs.ts";
import { PublicGitError } from "../src/core/public-git.ts";
test("install rechecks a download hold received while awaiting its claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-git-race-")),
    c = new Connector(join(root, "registry")),
    marker = join(root, "git-started"),
    script = join(root, "git-fixture");
  const keys = [
    "WORKBENCH_DEVICE_TOKEN",
    "WORKBENCH_SKILL_DESTINATION",
    "WORKBENCH_GIT",
  ];
  const old = new Map(keys.map((k) => [k, process.env[k]]));
  let release!: () => void, claimed!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (claimed = r));
  const uuid = "00000000-0000-4000-8000-000000000001";
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/device/jobs") {
      claimed();
      await barrier;
      res.end(
        JSON.stringify({
          id: "fixture",
          attemptToken: uuid,
          fullName: "spec/repo",
          ref: "a".repeat(40),
          path: "skills/one",
          name: "one",
        }),
      );
    } else if (req.url?.startsWith("/api/device/catalog-jobs?"))
      res.end(
        JSON.stringify({ id: uuid, attemptToken: uuid, fullName: "spec/repo" }),
      );
    else {
      for await (const chunk of req) {
      }
      res.end('{"ok":true}');
    }
  });
  try {
    process.env.WORKBENCH_DEVICE_TOKEN = "fixture_token";
    process.env.WORKBENCH_SKILL_DESTINATION = join(root, "skill-destination");
    process.env.WORKBENCH_GIT = script;
    writeFileSync(script, `#!/bin/sh\necho started > '${marker}'\nexit 1\n`, {
      mode: 0o700,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    c.setting("server", `http://127.0.0.1:${(server.address() as any).port}`);
    c.setting("deviceId", "fixture");
    const installation = runInstallJob(c);
    await started;
    await runCatalogJob(c, async () => {
      throw new PublicGitError(
        "limited",
        "GIT_RATE_LIMITED",
        new Date(Date.now() + 120000).toISOString(),
      );
    });
    assert.ok(Number(c.setting("github-download-until")) > Date.now());
    release();
    await installation;
    assert.equal(existsSync(marker), false);
  } finally {
    for (const key of keys) {
      const v = old.get(key);
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    c.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
