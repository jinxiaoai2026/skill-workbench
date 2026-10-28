import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Connector } from "./registry.ts";
export async function runManaged(
  c: Connector,
  skillId: string,
  command: string,
  args: string[],
): Promise<number> {
  const skill = c.refresh(skillId).find((s) => s.id === skillId);
  if (!skill) throw new Error("请先登记个人 Skill");
  const invocationId = randomUUID();
  const common = {
    invocationId,
    skillId,
    evidence: "confirmed" as const,
    source: "managed-entry" as const,
    version: skill.version,
  };
  c.enqueue({
    ...common,
    eventId: randomUUID(),
    type: "start",
    occurredAt: new Date().toISOString(),
  });
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    const onInterrupt = () => child.kill("SIGINT");
    process.once("SIGINT", onInterrupt);
    const finish = (
      code: number,
      status: "failed" | "succeeded" | "cancelled",
    ) => {
      if (done) return;
      done = true;
      process.off("SIGINT", onInterrupt);
      c.enqueue({
        ...common,
        eventId: randomUUID(),
        type: "end",
        status,
        occurredAt: new Date().toISOString(),
      });
      resolve(code);
    };
    child.once("error", () => finish(127, "failed"));
    child.once("exit", (code, signal) =>
      finish(
        code ?? 130,
        signal ? "cancelled" : code === 0 ? "succeeded" : "failed",
      ),
    );
  });
}
