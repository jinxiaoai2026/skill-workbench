import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateRepository, validateSkillPath } from "../src/core/catalog.ts";
import { validateCustomName } from "../src/core/skill-names.ts";
import { setSkillAlias } from "./aliases.ts";
import { stageGitSkill, PublicGitError } from "../src/core/public-git.ts";
export interface InstallJob {
  id: string;
  fullName: string;
  ref: string;
  path: string;
  name: string;
  attemptToken?: string;
  customName?: string;
  kind?: "install" | "alias";
}
export interface InstallResult {
  status: "succeeded";
  installedName: string;
  manifestHash: string;
  message: string;
  customName?: string;
}
const runFile = promisify(execFile),
  digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function stageOfficial(
  job: InstallJob,
  directory: string,
): Promise<string> {
  const script =
    process.env.SKILL_INSTALLER_SCRIPT ||
    join(
      process.env.CODEX_HOME || join(homedir(), ".codex"),
      "skills/.system/skill-installer/scripts/install-skill-from-github.py",
    );
  if (!existsSync(script)) throw new Error("本机未找到 Codex 官方技能安装器");
  const bundled = join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
  );
  const python =
    process.env.WORKBENCH_PYTHON || (existsSync(bundled) ? bundled : "python3");
  try {
    await runFile(
      python,
      [
        script,
        "--repo",
        job.fullName,
        "--path",
        job.path,
        "--ref",
        job.ref,
        "--dest",
        directory,
        "--name",
        job.name,
        "--method",
        "download",
      ],
      { timeout: 150000, maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw new Error("下载技能失败，请检查 GitHub 连通性后重试；未修改现有技能");
  }
  return join(directory, job.name);
}
export async function stageSelected(
  job: InstallJob,
  directory: string,
  options: { git?: typeof stageGitSkill; official?: typeof stageOfficial } = {},
): Promise<string> {
  try {
    return await (options.git || stageGitSkill)(
      job.fullName,
      job.ref,
      job.path,
      join(directory, job.name),
    );
  } catch (e) {
    if (e instanceof PublicGitError && e.code === "GIT_MISSING")
      return (options.official || stageOfficial)(job, directory);
    throw e;
  }
}
export async function installSkill(
  job: InstallJob,
  options: {
    destination?: string;
    stage?: typeof stageOfficial;
    discoveryRoots?: string[];
  } = {},
): Promise<InstallResult> {
  validateRepository(job.fullName);
  validateSkillPath(job.path);
  if (job.customName !== undefined)
    job = { ...job, customName: validateCustomName(job.customName) };
  if (
    !/^[a-f0-9]{40}$/.test(job.ref) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(job.name) ||
    job.name === "." ||
    job.name === ".."
  )
    throw new Error("安装参数无效");
  const destination = resolve(
    options.destination ||
      process.env.WORKBENCH_SKILL_DESTINATION ||
      (process.env.CODEX_HOME
        ? join(process.env.CODEX_HOME, "skills")
        : join(homedir(), ".agents/skills")),
  );
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const discoveryRoots =
    options.discoveryRoots ||
    (options.destination || process.env.WORKBENCH_SKILL_DESTINATION
      ? [destination]
      : [
          destination,
          join(homedir(), ".agents/skills"),
          join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
          "/etc/codex/skills",
        ]);
  const withAlias = (result: {
    status: "succeeded";
    installedName: string;
    manifestHash: string;
    message: string;
  }) =>
    job.customName
      ? {
          ...result,
          ...setSkillAlias(job, destination, discoveryRoots),
          message: `已设置调用名称：${job.customName}，可使用 $${job.customName}`,
        }
      : result;
  if (job.kind === "alias") {
    if (!job.customName) throw new Error("缺少自定义调用名称");
    return {
      status: "succeeded" as const,
      installedName: job.name,
      ...setSkillAlias(job, destination, discoveryRoots),
      message: `调用名称已更新，可使用 $${job.customName}`,
    };
  }
  const target = join(destination, job.name);
  const sourceFile = ".workbench-source.json";
  const targetExists = () => {
    try {
      lstatSync(target);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  };
  if (targetExists()) {
    if (
      !lstatSync(target).isSymbolicLink() &&
      existsSync(join(target, sourceFile)) &&
      existsSync(join(target, "SKILL.md"))
    ) {
      const saved = JSON.parse(readFileSync(join(target, sourceFile), "utf8"));
      const hash = digest(readFileSync(join(target, "SKILL.md"), "utf8"));
      if (
        saved.fullName === job.fullName &&
        saved.ref === job.ref &&
        saved.path === job.path &&
        saved.manifestHash === hash
      )
        return withAlias({
          status: "succeeded" as const,
          installedName: job.name,
          manifestHash: hash,
          message: "该版本已添加到 Codex",
        });
    }
    throw new Error(
      "同名技能已存在或含有本地修改，请先在本机处理；未覆盖现有文件",
    );
  }
  const staging = mkdtempSync(
    join(dirname(destination), ".workbench-install-"),
  );
  try {
    const staged = await (options.stage || stageSelected)(job, staging);
    if (!resolve(staged).startsWith(resolve(staging) + "/"))
      throw new Error("下载目录异常");
    let files = 0,
      bytes = 0;
    const inspect = (path: string) => {
      const info = lstatSync(path);
      if (info.isSymbolicLink())
        throw new Error("技能包含符号链接，已停止添加");
      if (info.isDirectory())
        for (const name of readdirSync(path)) inspect(join(path, name));
      else if (info.isFile()) {
        files++;
        bytes += info.size;
        if (files > 5000 || bytes > 50 * 1024 * 1024)
          throw new Error("技能文件超过添加限制");
      } else throw new Error("技能包含不支持的文件类型");
    };
    inspect(staged);
    const manifest = join(staged, "SKILL.md");
    if (!existsSync(manifest)) throw new Error("所选目录未包含 SKILL.md");
    const text = readFileSync(manifest, "utf8");
    if (
      !/^---\r?\n/.test(text) ||
      !/^name:\s*\S/m.test(text) ||
      !/^description:\s*\S/m.test(text)
    )
      throw new Error("技能清单缺少名称或用途说明");
    const manifestHash = digest(text);
    writeFileSync(
      join(staged, sourceFile),
      JSON.stringify({
        fullName: job.fullName,
        path: job.path,
        ref: job.ref,
        manifestHash,
        installedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    if (targetExists()) throw new Error("同名技能已存在，未覆盖");
    renameSync(staged, target);
    return withAlias({
      status: "succeeded" as const,
      installedName: job.name,
      manifestHash,
      message: "已添加到 Codex，下一轮对话可使用",
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
