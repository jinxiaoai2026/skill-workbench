import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageGitSkill } from "../src/core/public-git.ts";
import { gunzipSync } from "node:zlib";
const exec = promisify(execFile);
test("selected Skill file bodies are fetched in a bounded number of Git HTTP requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-http-fixture-")),
    source = join(root, "source"),
    bare = join(root, "origin.git");
  mkdirSync(source);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = (args: string[], cwd = source) => exec("git", args, { cwd, env });
  let posts = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (req.method === "POST") posts++;
    const input: Buffer[] = [];
    for await (const p of req) input.push(Buffer.from(p));
    let body = Buffer.concat(input);
    if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    const child = spawn("git", ["http-backend"], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method!,
        CONTENT_TYPE: String(req.headers["content-type"] || ""),
        CONTENT_LENGTH: String(body.length),
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] || ""),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (x) => chunks.push(x));
    child.stderr.resume();
    child.stdin.end(body);
    child.on("close", () => {
      const data = Buffer.concat(chunks),
        end = data.indexOf("\r\n\r\n");
      if (end < 0) {
        res.writeHead(500);
        res.end();
        return;
      }
      for (const h of data.subarray(0, end).toString().split("\r\n")) {
        const i = h.indexOf(":");
        if (i < 1) continue;
        const k = h.slice(0, i),
          v = h.slice(i + 1).trim();
        if (k.toLowerCase() === "status")
          res.statusCode = Number(v.slice(0, 3));
        else res.setHeader(k, v);
      }
      res.end(data.subarray(end + 4));
    });
  });
  try {
    await run(["init", "-q"]);
    mkdirSync(join(source, "skills/one/references"), { recursive: true });
    writeFileSync(
      join(source, "skills/one/SKILL.md"),
      "---\nname: one\ndescription: Design skill\n---\nInstructions",
    );
    for (let i = 0; i < 50; i++)
      writeFileSync(
        join(source, "skills/one/references", i + ".txt"),
        "Skill resource " + i,
      );
    writeFileSync(join(source, "unrelated.bin"), "Excluded content");
    await run(["add", "."]);
    await run([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const ref = (await run(["rev-parse", "HEAD"])).stdout.trim();
    await run(["clone", "--bare", source, bare], root);
    await run(["config", "uploadpack.allowFilter", "true"], bare);
    await run(["config", "uploadpack.allowAnySHA1InWant", "true"], bare);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const runner = async (args: string[], options: any) => {
      const mapped = args.map((x) =>
        x === "https://github.com/spec/repo.git"
          ? `http://127.0.0.1:${port}/origin.git`
          : x,
      );
      const r = await exec(
        "git",
        ["-c", "protocol.http.allow=always", ...mapped],
        { ...options, env: options.env, encoding: "buffer" },
      );
      return Buffer.from(r.stdout);
    };
    const destination = join(root, "selected");
    await stageGitSkill("spec/repo", ref, "skills/one", destination, {
      runner,
    });
    assert.equal(readdirSync(join(destination, "references")).length, 50);
    assert.ok(
      posts <= 6,
      `Skill checkout used ${posts} HTTP POSTs for 51 files; file bodies should be batched`,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
