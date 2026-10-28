import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverSkills,
  validateRepository,
  validateSkillPath,
} from "./catalog.ts";

type Entry = {
  path: string;
  type: string;
  mode: string;
  oid: string;
  size?: number;
};
type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
};
export type GitRunner = (
  args: string[],
  options: RunOptions,
) => Promise<Buffer>;
type Options = {
  runner?: GitRunner;
  timeoutMs?: number;
  maxDirectoryBytes?: number;
};
export class PublicGitError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryAt?: string,
  ) {
    super(message);
  }
}
export function parseGitTree(data: Buffer): Entry[] {
  if (data.length > 4 * 1024 * 1024) throw new Error("Git目录不完整或过大");
  if (data.length && data.at(-1) !== 0) throw new Error("Git目录不完整");
  const rows = data.toString("utf8").split("\0").filter(Boolean);
  if (rows.length > 20000) throw new Error("项目目录超过预检上限");
  const seen = new Set<string>();
  return rows.map((row) => {
    const m = row.match(
      /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t([^\r\n\0]+)$/,
    );
    if (!m) throw new Error("Git目录格式无效");
    const path = validateSkillPath(m[4]);
    if (
      (m[1] === "160000") !== (m[2] === "commit") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      path === "." ||
      path.split("/").some((p) => p.toLowerCase() === ".git") ||
      seen.has(path)
    )
      throw new Error("Git目录路径无效");
    seen.add(path);
    return { mode: m[1], type: m[2], oid: m[3], path };
  });
}
function bytesIn(directory: string): number {
  let bytes = 0,
    files = 0;
  const scan = (p: string) => {
    let names: string[];
    try {
      names = readdirSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const name of names) {
      const path = join(p, name);
      let s;
      try {
        s = lstatSync(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (++files > 50000) throw new Error("临时目录条目过多");
      if (s.isDirectory()) scan(path);
      else bytes += s.size;
    }
  };
  scan(directory);
  return bytes;
}
async function nativeRun(
  args: string[],
  options: RunOptions,
  maxDirectoryBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.WORKBENCH_GIT || "git", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const parts: Buffer[] = [];
    let out = 0,
      err = "",
      done = false;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const finish = (error?: Error) => {
      if (done) return;
      if (!error) {
        try {
          if (bytesIn(options.cwd) > maxDirectoryBytes)
            error = new PublicGitError(
              "GitHub临时下载超过大小上限，已停止。",
              "GIT_TOO_LARGE",
            );
        } catch {
          error = new PublicGitError(
            "临时下载目录无法完整核查，已停止。",
            "GIT_INVALID",
          );
        }
      }
      done = true;
      clearTimeout(timer);
      clearInterval(storage);
      if (error) {
        kill();
        reject(error);
      } else resolve(Buffer.concat(parts));
    };
    const timer = setTimeout(
      () =>
        finish(
          new PublicGitError(
            "GitHub下载连接超时，请稍后重试。",
            "GIT_NETWORK",
            new Date(Date.now() + 10000).toISOString(),
          ),
        ),
      options.timeout,
    );
    const storage = setInterval(() => {
      try {
        if (bytesIn(options.cwd) > maxDirectoryBytes)
          finish(
            new PublicGitError(
              "GitHub临时下载超过大小上限，已停止并保留现有技能。",
              "GIT_TOO_LARGE",
            ),
          );
      } catch {
        finish(
          new PublicGitError(
            "临时下载目录无法完整核查，已停止。",
            "GIT_INVALID",
          ),
        );
      }
    }, 100);
    child.stdout.on("data", (part: Buffer) => {
      out += part.length;
      if (out > options.maxBuffer)
        finish(
          new PublicGitError("GitHub返回内容超过预检上限。", "GIT_TOO_LARGE"),
        );
      else parts.push(part);
    });
    child.stderr.on("data", (part: Buffer) => {
      err = (err + part.toString()).slice(-64000);
    });
    child.once("error", (e: NodeJS.ErrnoException) =>
      finish(
        new PublicGitError(
          e.code === "ENOENT"
            ? "当前运行环境未安装Git。"
            : "无法启动GitHub下载连接。",
          e.code === "ENOENT" ? "GIT_MISSING" : "GIT_NETWORK",
        ),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) return finish();
      const limited = /HTTP\/\S+\s+429|rate limit exceeded|retry-after:/i.test(
        err,
      );
      if (limited) {
        const retry = [...err.matchAll(/retry-after:\s*([^\r\n]+)/gi)]
          .at(-1)?.[1]
          .trim();
        const at = Date.now();
        const until =
          retry && /^\d+$/.test(retry)
            ? at + Number(retry) * 1000
            : Date.parse(retry || "");
        return finish(
          new PublicGitError(
            "GitHub文件下载暂时限流，已按要求暂停。",
            "GIT_RATE_LIMITED",
            new Date(
              Number.isFinite(until) ? Math.max(at + 1000, until) : at + 60000,
            ).toISOString(),
          ),
        );
      }
      finish(
        new PublicGitError(
          /repository not found|could not read Username|authentication failed/i.test(
            err,
          )
            ? "GitHub公开仓库或固定版本无法读取，请核对项目地址和访问权限。"
            : "GitHub下载连接失败，请稍后重试。",
          "GIT_NETWORK",
          new Date(Date.now() + 10000).toISOString(),
        ),
      );
    });
  });
}
async function withRepository<T>(
  fullName: string,
  ref: string | undefined,
  options: Options,
  fn: (repo: {
    ref: string;
    tree: Entry[];
    checkout: (paths: string[]) => Promise<void>;
    directory: string;
  }) => Promise<T>,
): Promise<T> {
  validateRepository(fullName);
  if (ref && !/^[a-f0-9]{40}$/.test(ref)) throw new Error("项目固定版本无效");
  const directory = mkdtempSync(join(tmpdir(), "workbench-public-git-")),
    deadline = Date.now() + (options.timeoutMs || 20000);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  delete env.SSH_ASKPASS;
  const noAskPass = process.platform === "win32" ? "" : "/usr/bin/false";
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: noAskPass,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TRACE_CURL: "1",
    GIT_TRACE_CURL_NO_DATA: "1",
  });
  const common = [
    "-c",
    "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=" + noAskPass,
    "-c",
    "http.emptyAuth=true",
    "-c",
    "http.followRedirects=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "--literal-pathspecs",
  ];
  const run = async (args: string[], maxBuffer = 4 * 1024 * 1024) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0)
      throw new PublicGitError(
        "GitHub下载连接超时，请稍后重试。",
        "GIT_NETWORK",
      );
    return options.runner
      ? options.runner([...common, ...args], {
          cwd: directory,
          env,
          timeout,
          maxBuffer,
        })
      : nativeRun(
          [...common, ...args],
          { cwd: directory, env, timeout, maxBuffer },
          options.maxDirectoryBytes || 64 * 1024 * 1024,
        );
  };
  try {
    await run(["init", "-q", "--template=", "."]);
    await run([
      "remote",
      "add",
      "origin",
      "https://github.com/" + fullName + ".git",
    ]);
    await run([
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "--no-recurse-submodules",
      "origin",
      ref || "HEAD",
    ]);
    const actual = (await run(["rev-parse", "FETCH_HEAD"], 100))
      .toString()
      .trim();
    if (!/^[a-f0-9]{40}$/.test(actual) || (ref && ref !== actual))
      throw new Error("下载版本与核验版本不一致");
    const tree = parseGitTree(
      await run(["ls-tree", "-rz", "--full-tree", "FETCH_HEAD"]),
    );
    return await fn({
      ref: actual,
      tree,
      directory,
      checkout: async (paths) => {
        for (const p of paths) validateSkillPath(p);
        if (paths.length > 300)
          throw new Error("单次技能清单过多，请选择更具体的项目");
        if (paths.length) {
          const escape = (p: string) =>
            [...p]
              .map((c) => ("\\*?[]#! ".includes(c) ? "\\" + c : c))
              .join("");
          const patterns = paths.map((p) =>
            p === "."
              ? "/*"
              : "/" + escape(p) + (tree.some((e) => e.path === p) ? "" : "/"),
          );
          await run(["config", "core.sparseCheckout", "true"]);
          await run(["config", "core.sparseCheckoutCone", "false"]);
          mkdirSync(join(directory, ".git/info"), {
            recursive: true,
            mode: 0o700,
          });
          writeFileSync(
            join(directory, ".git/info/sparse-checkout"),
            patterns.join("\n") + "\n",
            { mode: 0o600 },
          );
          // Switching the sparse worktree batches all selected missing file bodies.
          await run(
            ["checkout", "--detach", "--force", "FETCH_HEAD"],
            1024 * 1024,
          );
        }
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
export async function readGitRepository(
  fullName: string,
  options: Options = {},
) {
  return withRepository(fullName, undefined, options, async (repo) => {
    const skills = discoverSkills(repo.tree),
      paths = skills.map((s) =>
        s.path === "." ? "SKILL.md" : s.path + "/SKILL.md",
      );
    await repo.checkout(paths);
    const manifests = new Map<string, string>();
    for (let i = 0; i < paths.length; i++) {
      const f = join(repo.directory, paths[i]),
        s = lstatSync(f);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 256000)
        throw new Error("技能清单无效或超过大小上限");
      manifests.set(skills[i].path, readFileSync(f, "utf8"));
    }
    return {
      ref: repo.ref,
      tree: repo.tree,
      manifests,
      omittedVariants:
        discoverSkills(repo.tree, { preferCodex: false }).length -
        skills.length,
    };
  });
}
export async function stageGitSkill(
  fullName: string,
  ref: string,
  path: string,
  destination: string,
  options: Options = {},
) {
  validateSkillPath(path);
  if (existsSync(destination)) throw new Error("下载目标已存在，未覆盖");
  return withRepository(
    fullName,
    ref,
    { timeoutMs: 120000, maxDirectoryBytes: 128 * 1024 * 1024, ...options },
    async (repo) => {
      const files = repo.tree.filter(
        (e) => path === "." || e.path.startsWith(path + "/"),
      );
      if (
        !files.length ||
        files.length > 5000 ||
        files.some(
          (e) => e.type !== "blob" || !["100644", "100755"].includes(e.mode),
        )
      )
        throw new Error("所选技能包含不支持的文件或超过文件上限");
      const manifest = path === "." ? "SKILL.md" : path + "/SKILL.md";
      if (!files.some((e) => e.path === manifest))
        throw new Error("所选目录没有SKILL.md");
      // Checkout only this path; no hooks, scripts, submodules, sibling files or history.
      await repo.checkout([path]);
      let bytes = 0;
      for (const file of files) {
        const s = lstatSync(join(repo.directory, file.path));
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          (bytes += s.size) > 50 * 1024 * 1024 ||
          (file.path === manifest && s.size > 256000)
        )
          throw new Error("所选技能文件无效或超过大小上限");
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      mkdirSync(destination, { mode: 0o700 });
      try {
        for (const file of files) {
          const relative =
              path === "." ? file.path : file.path.slice(path.length + 1),
            target = resolve(destination, relative);
          if (!target.startsWith(resolve(destination) + "/"))
            throw new Error("技能下载路径异常");
          mkdirSync(join(target, ".."), { recursive: true });
          cpSync(join(repo.directory, file.path), target, {
            dereference: false,
          });
        }
        return destination;
      } catch (e) {
        rmSync(destination, { recursive: true, force: true });
        throw e;
      }
    },
  );
}
