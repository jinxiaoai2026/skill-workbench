import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { InstallJob } from "./install.ts";
import { validateCustomName } from "../src/core/skill-names.ts";
import { validateRepository, validateSkillPath } from "../src/core/catalog.ts";
import { allowedSkill } from "../src/core/usage.ts";

export const manifestHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const receiptFile = ".workbench-alias.json";
export const fileExists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
export function plainFile(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("技能文件包含链接或不支持的类型");
  if (info.size > 256 * 1024) throw new Error("技能文件过大");
  return readFileSync(path, "utf8");
}
export interface AliasReceipt {
  type: "skill-alias";
  name: string;
  targetFile?: string;
  skillId?: string;
  fullName?: string;
  path?: string;
  ref?: string;
  targetName?: string;
  manifestHash: string;
  policyHash: string;
}
export function readAliasReceipt(directory: string): AliasReceipt {
  return JSON.parse(plainFile(join(directory, receiptFile)));
}
export function checkOwnedAlias(directory: string, receipt: AliasReceipt) {
  if (
    lstatSync(directory).isSymbolicLink() ||
    readdirSync(directory).sort().join(",") !==
      ".workbench-alias.json,SKILL.md,agents" ||
    lstatSync(join(directory, "agents")).isSymbolicLink() ||
    readdirSync(join(directory, "agents")).join(",") !== "openai.yaml" ||
    manifestHash(plainFile(join(directory, "SKILL.md"))) !==
      receipt.manifestHash ||
    manifestHash(plainFile(join(directory, "agents/openai.yaml"))) !==
      receipt.policyHash
  )
    throw new Error("原调用别名含有本地修改，请先在本机处理；未删除或覆盖文件");
}
/** Resolve receipts by their canonical local target; repository metadata alone is never identity. */
export function aliasTargetFile(
  directory: string,
  saved: AliasReceipt,
): string {
  if (saved.type !== "skill-alias") throw new Error("别名记录无效");
  let target: string;
  if (saved.targetFile !== undefined) {
    if (typeof saved.targetFile !== "string" || !isAbsolute(saved.targetFile))
      throw new Error("别名目标无效");
    target = realpathSync(saved.targetFile);
    if (target !== saved.targetFile) throw new Error("别名目标已变更");
  } else {
    // Receipts written before canonical targets were recorded referred to a sibling install.
    if (
      typeof saved.targetName !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(saved.targetName)
    )
      throw new Error("别名目标无效");
    target = realpathSync(
      join(dirname(directory), saved.targetName, "SKILL.md"),
    );
  }
  if (saved.fullName !== undefined || saved.targetFile === undefined) {
    const repo = validateRepository(saved.fullName!),
      path = validateSkillPath(saved.path!);
    const source = JSON.parse(
      plainFile(join(dirname(target), ".workbench-source.json")),
    );
    if (
      source.fullName !== repo ||
      source.path !== path ||
      source.ref !== saved.ref
    )
      throw new Error("别名来源不匹配");
  }
  return target;
}
/** Integrity and rendered target must agree, including when only a receipt was edited. */
export function validateAliasTarget(
  directory: string,
  saved: AliasReceipt,
  target: string,
) {
  checkOwnedAlias(directory, saved);
  const text = plainFile(join(directory, "SKILL.md"));
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = front && parse(front[1], { maxAliasCount: 20 });
  const policy = parse(plainFile(join(directory, "agents/openai.yaml")), {
    maxAliasCount: 20,
  });
  if (
    metadata?.name !== validateCustomName(saved.name) ||
    !text.includes("```text\n" + target + "\n```") ||
    !text.includes("```text\n" + dirname(target) + "\n```") ||
    policy?.policy?.allow_implicit_invocation !== false
  )
    throw new Error("原调用别名含有本地修改或目标不匹配；未删除或覆盖文件");
}

export function writeSkillAlias(
  originalFile: string,
  name: string | undefined,
  destination: string,
  discoveryRoots: string[] = [destination],
  identity: {
    skillId?: string;
    legacy?: Pick<InstallJob, "fullName" | "path" | "ref" | "name">;
  } = {},
) {
  const targetFile = realpathSync(originalFile),
    original = dirname(targetFile);
  const manifest = plainFile(targetFile);
  const header = manifest.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = header ? parse(header[1], { maxAliasCount: 20 }) : null;
  if (
    typeof metadata?.name !== "string" ||
    typeof metadata?.description !== "string"
  )
    throw new Error("原技能清单缺少名称或用途说明");
  if (name !== undefined) name = validateCustomName(name);
  destination = resolve(destination);
  if (!allowedSkill({ ownership: "local", path: destination }))
    throw new Error("只能在用户技能目录设置调用名称，系统目录与插件缓存除外");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  destination = realpathSync(destination);
  if (!allowedSkill({ ownership: "local", path: destination }))
    throw new Error("只能在用户技能目录设置调用名称，系统目录与插件缓存除外");

  const owned: { directory: string; receipt: AliasReceipt }[] = [];
  const directories: string[] = [],
    visited = new Set<string>();
  const scan = (root: string, depth: number) => {
    if (!existsSync(root) || depth > 6) return;
    let actual: string;
    try {
      actual = realpathSync(root);
      if (!statSync(root).isDirectory()) return;
    } catch {
      return;
    }
    const linked = lstatSync(root).isSymbolicLink();
    if (visited.has(actual) && !linked) return;
    visited.add(actual);
    const marker = join(actual, receiptFile);
    if (fileExists(marker)) {
      const saved = readAliasReceipt(actual);
      let target: string | undefined;
      try {
        target = aliasTargetFile(actual, saved);
      } catch {
        // An unrelated invalid receipt cannot authorize deletion.
        if (saved.skillId === identity.skillId && identity.skillId)
          throw new Error("原调用别名目标不存在或含有本地修改");
      }
      if (target === targetFile) {
        if (linked) throw new Error("原调用别名目录包含链接，已停止修改");
        if (!allowedSkill({ ownership: "local", path: actual }))
          throw new Error("系统目录与插件缓存中的别名不能修改");
        validateAliasTarget(actual, saved, targetFile);
        owned.push({ directory: actual, receipt: saved });
        return;
      }
    }
    const file = join(actual, "SKILL.md");
    if (existsSync(file)) {
      directories.push(actual);
      return;
    }
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if ([".git", "node_modules"].includes(item.name)) continue;
      if (item.isDirectory() || item.isSymbolicLink())
        scan(join(root, item.name), depth + 1);
    }
  };
  for (const root of new Set([
    destination,
    ...discoveryRoots,
    dirname(original),
  ]))
    scan(root, 0);

  if (name === undefined) {
    for (const previous of owned) {
      checkOwnedAlias(previous.directory, previous.receipt);
      rmSync(previous.directory, { recursive: true });
    }
    return { customName: undefined, manifestHash: manifestHash(manifest) };
  }
  for (const directory of directories) {
    try {
      const file = join(directory, "SKILL.md");
      if (statSync(file).size > 256 * 1024) continue;
      const front = readFileSync(file, "utf8").match(
        /^---\r?\n([\s\S]*?)\r?\n---/,
      );
      const metadata = front && parse(front[1], { maxAliasCount: 20 });
      if (
        typeof metadata?.name === "string" &&
        metadata.name.toLowerCase() === name.toLowerCase()
      )
        throw new Error("同名技能已存在，请使用其他调用名称");
    } catch (e) {
      if ((e as Error).message.includes("同名技能")) throw e;
      /* Unreadable or malformed unrelated skills cannot provide a valid name. */
    }
  }
  const target = join(destination, name);
  const existing = owned.find((a) => a.directory === target);
  const targetInfo =
    !existing && fileExists(target) ? lstatSync(target) : undefined;
  const caseOnly =
    targetInfo && !targetInfo.isSymbolicLink()
      ? owned.find(
          (a) =>
            a.directory.toLowerCase() === target.toLowerCase() &&
            lstatSync(a.directory).ino === targetInfo.ino &&
            lstatSync(a.directory).dev === targetInfo.dev,
        )
      : undefined;
  if (fileExists(target) && !existing && !caseOnly)
    throw new Error("同名技能已存在，请使用其他调用名称");
  if (!existing) {
    const description = `仅在用户明确要求 $${name} 或使用“${name}”技能时调用。原技能：${metadata.name}。用途：${metadata.description.slice(0, 600)}`;
    const alias = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n这是用户为已安装技能设置的调用别名。\n\n1. 读取并遵循原技能清单：\n\n\`\`\`text\n${targetFile}\n\`\`\`\n\n2. 原技能里的相对文件、脚本和资源路径均以原技能目录为基准：\n\n\`\`\`text\n${original}\n\`\`\`\n\n3. 按原技能的适用范围和要求完成用户当前任务。\n`;
    const policy = `interface:\n  display_name: ${JSON.stringify(name)}\n  short_description: ${JSON.stringify("调用已安装的 " + metadata.name + " 技能")}\n  default_prompt: ${JSON.stringify("使用 $" + name + " 技能完成当前任务。")}\npolicy:\n  allow_implicit_invocation: false\n`;
    let backup: string | undefined,
      created = false;
    try {
      if (caseOnly) {
        backup = mkdtempSync(
          join(dirname(destination), ".workbench-alias-change-"),
        );
        renameSync(caseOnly.directory, join(backup, "previous"));
      }
      mkdirSync(target);
      created = true;
      mkdirSync(join(target, "agents"));
      writeFileSync(join(target, "SKILL.md"), alias, {
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(join(target, "agents/openai.yaml"), policy, {
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(
        join(target, receiptFile),
        JSON.stringify({
          type: "skill-alias",
          targetFile,
          skillId: identity.skillId,
          ...(identity.legacy
            ? {
                fullName: identity.legacy.fullName,
                path: identity.legacy.path,
                ref: identity.legacy.ref,
                targetName: identity.legacy.name,
              }
            : {}),
          name,
          manifestHash: manifestHash(alias),
          policyHash: manifestHash(policy),
        }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (e) {
      if (created) rmSync(target, { recursive: true, force: true });
      if (backup) {
        if (
          fileExists(join(backup, "previous")) &&
          !fileExists(caseOnly!.directory)
        )
          renameSync(join(backup, "previous"), caseOnly!.directory);
        if (!fileExists(join(backup, "previous")))
          rmSync(backup, { recursive: true, force: true });
      }
      throw e;
    }
    if (backup) rmSync(backup, { recursive: true });
  }
  for (const previous of owned) {
    if (previous.directory !== target && previous !== caseOnly) {
      checkOwnedAlias(previous.directory, previous.receipt);
      rmSync(previous.directory, { recursive: true });
    }
  }
  return { customName: name, manifestHash: manifestHash(manifest) };
}

export function setSkillAlias(
  job: InstallJob,
  destination: string,
  discoveryRoots: string[] = [destination],
) {
  const name = validateCustomName(job.customName!);
  const original = join(destination, job.name);
  if (!fileExists(original))
    throw new Error("未找到已安装的原技能，请先重新添加");
  if (lstatSync(original).isSymbolicLink())
    throw new Error("原技能目录包含链接，已停止修改");
  const source = JSON.parse(
    plainFile(join(original, ".workbench-source.json")),
  );
  const manifest = plainFile(join(original, "SKILL.md"));
  if (
    source.fullName !== job.fullName ||
    source.path !== job.path ||
    source.ref !== job.ref ||
    source.manifestHash !== manifestHash(manifest)
  )
    throw new Error("原技能来源不匹配或含有本地修改，请先在本机处理");
  const front = manifest.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = front && parse(front[1], { maxAliasCount: 20 });
  if (
    [job.name, metadata?.name].some(
      (n) => typeof n === "string" && n.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error("自定义调用名称与原技能同名，请换一个名称");
  return writeSkillAlias(
    join(original, "SKILL.md"),
    name,
    destination,
    discoveryRoots,
    { legacy: job },
  );
}
