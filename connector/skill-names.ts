import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import type { Connector, LocalSkill } from "./registry.ts";
import { allowedSkill } from "../src/core/usage.ts";
import { validateCustomName } from "../src/core/skill-names.ts";
import { defaultSkillRoots } from "./discovery.ts";
import { fileExists, plainFile, writeSkillAlias } from "./aliases.ts";
import { validateRepository, validateSkillPath } from "../src/core/catalog.ts";

export type SkillNameJob = {
  id: string;
  skillId: string;
  launchName: string;
  sourceVersion: string;
  attemptToken?: string;
};
type InstallationIdentity = {
  fullName: string;
  path: string;
  ref: string;
  installedName: string;
};
function confirmedInstallation(
  skill: LocalSkill,
  destination: string,
): InstallationIdentity | undefined {
  try {
    const directory = dirname(skill.path),
      installedName = basename(directory);
    if (
      basename(skill.path) !== "SKILL.md" ||
      dirname(directory) !== realpathSync(destination) ||
      realpathSync(join(destination, installedName, "SKILL.md")) !==
        skill.path ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(installedName)
    )
      return;
    const receipt = JSON.parse(
      plainFile(join(directory, ".workbench-source.json")),
    );
    if (
      typeof receipt.fullName !== "string" ||
      typeof receipt.path !== "string" ||
      typeof receipt.ref !== "string" ||
      !/^[a-f0-9]{40}$/.test(receipt.ref) ||
      receipt.fullName !== skill.sourceRepo ||
      receipt.path !== skill.sourcePath
    )
      return;
    return {
      fullName: validateRepository(receipt.fullName),
      path: validateSkillPath(receipt.path),
      ref: receipt.ref,
      installedName,
    };
  } catch {
    // A generic alias does not require a valid legacy installation receipt.
    return;
  }
}
export function renameRegisteredSkill(
  c: Connector,
  job: SkillNameJob,
  options: { destination?: string; discoveryRoots?: string[] } = {},
): {
  status: "succeeded";
  launchName: string;
  sourceVersion: string;
  customName?: string;
  manifestHash: string;
  installation?: InstallationIdentity;
} {
  const saved = c.skills().find((s) => s.id === job.skillId);
  if (!saved) throw new Error("未登记的用户 Skill");
  if (!allowedSkill(saved))
    throw new Error("只能修改用户 Skill，系统目录与插件缓存除外");
  if (fileExists(join(dirname(saved.path), ".workbench-alias.json")))
    throw new Error("调用别名不能单独改名，请修改原技能");
  const skill = c.refresh(job.skillId).find((s) => s.id === job.skillId)!;
  if (!allowedSkill(skill))
    throw new Error("只能修改用户 Skill，系统目录与插件缓存除外");
  if (skill.path !== saved.path || realpathSync(skill.path) !== skill.path)
    throw new Error("原技能路径已变更，请重新同步");
  if (skill.version !== job.sourceVersion)
    throw new Error("原技能版本已变更或含有本地修改，请同步后重试");
  const customName =
    job.launchName === skill.name
      ? undefined
      : validateCustomName(job.launchName);
  const destination = resolve(
    options.destination ||
      process.env.WORKBENCH_SKILL_DESTINATION ||
      (process.env.CODEX_HOME
        ? join(process.env.CODEX_HOME, "skills")
        : join(homedir(), ".agents/skills")),
  );
  const result = writeSkillAlias(
    skill.path,
    customName,
    destination,
    [
      ...(options.discoveryRoots || [
        ...defaultSkillRoots(c),
        destination,
        "/etc/codex/skills",
      ]),
      ...c
        .skills()
        .filter(allowedSkill)
        .map((s) => dirname(s.path)),
    ],
    { skillId: skill.id },
  );
  c.adopt(skill.path, skill.ownership, skill.id, skill.syncContent, {
    customName: result.customName,
  });
  const installation = confirmedInstallation(skill, destination);
  return {
    status: "succeeded",
    launchName: result.customName || skill.name,
    sourceVersion: skill.version,
    ...result,
    ...(installation ? { installation } : {}),
  };
}
