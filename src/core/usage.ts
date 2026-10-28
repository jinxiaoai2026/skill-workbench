export interface ManagedSkill {
  id: string;
  path: string;
  ownership: string;
  name: string;
  version?: string;
}
export function allowedSkill(s: { ownership: string; path?: string }): boolean {
  return (
    ["original", "derived", "imported", "local"].includes(s.ownership) &&
    !/(?:^|\/)(?:\.system|plugins\/cache)(?:\/|$)/.test(s.path || "")
  );
}
export function inferSkillReads(command: string, skills: ManagedSkill[]) {
  // A successful read is evidence of loading only, never proof of execution.
  if (
    !/(?:^|[\s;|])(?:cat|head|tail|sed|read_file)\b|readFile(?:Sync)?\s*\(/.test(
      command,
    )
  )
    return [];
  return skills
    .filter((s) => allowedSkill(s) && command.includes(s.path))
    .map((s) => ({
      skillId: s.id,
      evidence: "inferred" as const,
      reason: "读取了受管 Skill 的指令文件；未确认执行",
    }));
}
export type UsageEvent = {
  eventId: string;
  invocationId: string;
  skillId: string;
  occurredAt: string;
  type: "start" | "end";
  evidence: "confirmed" | "inferred";
  status?: "succeeded" | "failed" | "cancelled" | "unknown";
  source: "managed-entry" | "history-read" | "native-explicit";
  version?: string;
  sessionRef?: string;
  turnRef?: string;
};
