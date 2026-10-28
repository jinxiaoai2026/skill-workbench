import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import type { Connector } from "./registry.ts";
import { allowedSkill } from "../src/core/usage.ts";
import { validateRepository, validateSkillPath } from "../src/core/catalog.ts";
import { validateCustomName } from "../src/core/skill-names.ts";
import {
  aliasTargetFile,
  readAliasReceipt,
  validateAliasTarget,
} from "./aliases.ts";

function readJSON(file: string) {
  if (statSync(file).size > 32 * 1024) throw new Error("技能来源记录过大");
  return JSON.parse(readFileSync(file, "utf8"));
}
export function defaultSkillRoots(c: Connector) {
  const extra =
    process.env.WORKBENCH_SKILL_ROOTS || c.setting("skillRoots") || "[]";
  const configured = JSON.parse(extra);
  if (
    !Array.isArray(configured) ||
    configured.some((p) => typeof p !== "string" || !p)
  )
    throw new Error("技能目录配置须为路径数组");
  return [
    ...new Set(
      [
        join(homedir(), ".agents/skills"),
        join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
        join(process.cwd(), ".agents/skills"),
        ...(process.env.WORKBENCH_SKILL_DESTINATION
          ? [process.env.WORKBENCH_SKILL_DESTINATION]
          : []),
        ...configured,
      ].map((p) => resolve(p)),
    ),
  ];
}
function githubRepository(value: string): string | undefined {
  let path: string;
  if (/^git@github\.com:/.test(value)) path = value.slice(15);
  else {
    try {
      const url = new URL(value);
      if (url.hostname !== "github.com") return;
      path = url.pathname.slice(1);
    } catch {
      return;
    }
  }
  try {
    return validateRepository(path.replace(/\.git\/?$/, "").replace(/\/$/, ""));
  } catch {
    return;
  }
}
function gitSource(directory: string) {
  for (let at = directory, depth = 0; depth < 10; depth++) {
    const dotGit = join(at, ".git");
    if (existsSync(dotGit)) {
      let gitdir = dotGit;
      if (statSync(dotGit).isFile()) {
        const pointer = readFileSync(dotGit, "utf8").match(
          /^gitdir:\s*(.+)/,
        )?.[1];
        if (!pointer) return;
        gitdir = resolve(at, pointer);
      }
      let config = join(gitdir, "config");
      if (!existsSync(config) && existsSync(join(gitdir, "commondir")))
        config = resolve(
          gitdir,
          readFileSync(join(gitdir, "commondir"), "utf8").trim(),
          "config",
        );
      if (!existsSync(config) || statSync(config).size > 256 * 1024) return;
      let origin = false;
      for (const line of readFileSync(config, "utf8").split(/\r?\n/)) {
        if (/^\s*\[/.test(line))
          origin = /^\s*\[remote\s+"origin"\]\s*$/.test(line);
        else if (origin) {
          const raw = line
            .match(/^\s*url\s*=\s*(.+?)\s*$/)?.[1]
            ?.replace(/^"|"$/g, "");
          const fullName = raw && githubRepository(raw);
          if (fullName)
            return {
              sourceRepo: fullName,
              sourcePath: validateSkillPath(
                relative(at, directory).split("\\").join("/") || ".",
              ),
              upstream: "https://github.com/" + fullName,
            };
        }
      }
      return;
    }
    const parent = dirname(at);
    if (parent === at) return;
    at = parent;
  }
}
export function discoverSkills(c: Connector, roots = defaultSkillRoots(c)) {
  const files = new Set<string>(),
    visited = new Set<string>();
  const aliases = new Map<string, string>();
  const existing = new Map(c.skills().map((s) => [s.path, s]));
  const errors: string[] = [];
  let scanned = 0;
  const scan = (input: string, depth = 0) => {
    if (
      depth > 6 ||
      scanned >= 5000 ||
      !allowedSkill({ ownership: "local", path: input })
    )
      return;
    try {
      const directory = realpathSync(input);
      if (
        !allowedSkill({ ownership: "local", path: directory }) ||
        visited.has(directory) ||
        !statSync(directory).isDirectory()
      )
        return;
      visited.add(directory);
      scanned++;
      const marker = join(directory, ".workbench-alias.json");
      if (existsSync(marker)) {
        const saved = readAliasReceipt(directory);
        const target = aliasTargetFile(directory, saved);
        validateAliasTarget(directory, saved, target);
        const registered = existing.get(target);
        // Generic receipts can describe only an already registered canonical file.
        const generic =
          saved.skillId !== undefined || saved.fullName === undefined;
        if (
          allowedSkill({ ownership: "local", path: target }) &&
          !existsSync(join(dirname(target), ".workbench-alias.json")) &&
          (!generic ||
            (registered && (!saved.skillId || registered.id === saved.skillId)))
        ) {
          aliases.set(target, validateCustomName(saved.name));
          files.add(target);
        }
        return;
      }
      const file = join(directory, "SKILL.md");
      if (existsSync(file)) {
        files.add(realpathSync(file));
        return;
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (
          [
            ".git",
            ".system",
            "node_modules",
            "tests",
            "test",
            "__tests__",
            "fixtures",
          ].includes(entry.name)
        )
          continue;
        if (entry.isDirectory() || entry.isSymbolicLink())
          scan(join(directory, entry.name), depth + 1);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push("部分技能目录暂不可读");
    }
  };
  for (const root of roots) scan(resolve(root));
  let found = 0;
  for (const file of files) {
    try {
      if (!allowedSkill({ ownership: "local", path: file })) continue;
      const dir = dirname(file),
        saved = existing.get(file),
        receiptFile = join(dir, ".workbench-source.json");
      let source: ReturnType<typeof gitSource>;
      if (existsSync(receiptFile)) {
        try {
          const receipt = readJSON(receiptFile);
          const sourceRepo = validateRepository(receipt.fullName),
            sourcePath = validateSkillPath(receipt.path);
          source = {
            sourceRepo,
            sourcePath,
            upstream: "https://github.com/" + sourceRepo,
          };
        } catch {
          errors.push("部分来源记录无效，技能仍按本地文件同步");
        }
      }
      if (!source) {
        try {
          source = gitSource(dir);
        } catch {
          errors.push("部分 Git 来源记录不可读，技能仍按本地文件同步");
        }
      }
      if (!source && saved?.sourceRepo && saved.sourcePath)
        source = {
          sourceRepo: saved.sourceRepo,
          sourcePath: saved.sourcePath,
          upstream: saved.upstream || "https://github.com/" + saved.sourceRepo,
        };
      const ownership =
        saved && ["original", "derived"].includes(saved.ownership)
          ? saved.ownership
          : source
            ? "imported"
            : "local";
      c.adopt(file, ownership, saved?.id, saved?.syncContent || false, {
        ...source,
        customName: aliases.get(file),
      });
      found++;
    } catch {
      errors.push("部分 Skill 清单无效，已保留原有记录");
    }
  }
  const result = { scanned, found, errors: [...new Set(errors)] };
  c.setting(
    "lastDiscovery",
    JSON.stringify({ ...result, at: new Date().toISOString() }),
  );
  return result;
}
