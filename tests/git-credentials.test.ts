import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readGitRepository } from "../src/core/public-git.ts";
const exec = promisify(execFile);
test("a public Git authentication rejection never invokes inherited credential prompts", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-public-auth-")),
    helper = join(root, "askpass"),
    marker = join(root, "called");
  const oldAsk = process.env.SSH_ASKPASS,
    oldMarker = process.env.WORKBENCH_AUTH_TEST_MARKER;
  writeFileSync(
    helper,
    '#!/bin/sh\necho called >> "$WORKBENCH_AUTH_TEST_MARKER"\necho fixture\n',
    { mode: 0o700 },
  );
  process.env.SSH_ASKPASS = helper;
  process.env.WORKBENCH_AUTH_TEST_MARKER = marker;
  const auth: string[] = [];
  const server = createServer((req, res) => {
    if (req.headers.authorization) auth.push(req.headers.authorization);
    res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' });
    res.end("Authentication required");
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const runner = async (args: string[], options: any) => {
      const r = await exec(
        "git",
        [
          "-c",
          "protocol.http.allow=always",
          ...args.map((x) =>
            x === "https://github.com/spec/repo.git"
              ? `http://127.0.0.1:${port}/repo.git`
              : x,
          ),
        ],
        { ...options, env: options.env, encoding: "buffer" },
      );
      return Buffer.from(r.stdout);
    };
    await assert.rejects(() => readGitRepository("spec/repo", { runner }));
    assert.equal(existsSync(marker), false);
    assert.ok(
      auth.every((x) => x === "Basic Og=="),
      "Only empty authentication is allowed for a public download",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (oldAsk === undefined) delete process.env.SSH_ASKPASS;
    else process.env.SSH_ASKPASS = oldAsk;
    if (oldMarker === undefined) delete process.env.WORKBENCH_AUTH_TEST_MARKER;
    else process.env.WORKBENCH_AUTH_TEST_MARKER = oldMarker;
    rmSync(root, { recursive: true, force: true });
  }
});
test("Git Retry-After dates retain the server-specified wait rather than falling back to one minute", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-public-rate-")),
    script = join(root, "git-probe"),
    previous = process.env.WORKBENCH_GIT;
  writeFileSync(
    script,
    '#!/bin/sh\nprintf "HTTP/2 429\\nRetry-After: Fri, 01 Jan 2100 00:00:00 GMT\\n" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  process.env.WORKBENCH_GIT = script;
  try {
    await assert.rejects(
      () => readGitRepository("spec/repo"),
      (e: any) =>
        e.code === "GIT_RATE_LIMITED" &&
        e.retryAt === "2100-01-01T00:00:00.000Z",
    );
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_GIT;
    else process.env.WORKBENCH_GIT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test("a fast successful Git subprocess cannot bypass the download directory cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-public-cap-")),
    script = join(root, "git-probe"),
    previous = process.env.WORKBENCH_GIT;
  writeFileSync(
    script,
    "#!/bin/sh\ndd if=/dev/zero of=oversize bs=1024 count=2048 2>/dev/null\nexit 0\n",
    { mode: 0o700 },
  );
  process.env.WORKBENCH_GIT = script;
  try {
    await assert.rejects(
      () => readGitRepository("spec/repo", { maxDirectoryBytes: 1024 }),
      (e: any) => e.code === "GIT_TOO_LARGE",
    );
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_GIT;
    else process.env.WORKBENCH_GIT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test("a Git tree process terminated by a signal cannot be cached as an empty repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-public-signal-")),
    script = join(root, "git-probe"),
    previous = process.env.WORKBENCH_GIT;
  writeFileSync(
    script,
    '#!/bin/sh\ncase "$*" in\n*rev-parse*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;\n*ls-tree*) kill -TERM $$ ;;\n*) exit 0 ;;\nesac\n',
    { mode: 0o700 },
  );
  process.env.WORKBENCH_GIT = script;
  try {
    await assert.rejects(
      () => readGitRepository("spec/repo"),
      (e: any) => e.code === "GIT_NETWORK",
    );
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_GIT;
    else process.env.WORKBENCH_GIT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
