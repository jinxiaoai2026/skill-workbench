import { z } from "zod";
import { Connector } from "./registry.ts";
import { requestServer } from "./transport.ts";
import { readToken } from "./credentials.ts";
import { readGitRepository, PublicGitError } from "../src/core/public-git.ts";
import { discoverSkills, validateRepository } from "../src/core/catalog.ts";
import { parseSkillManifest } from "../src/core/skill-manifest.ts";
export async function runCatalogJob(
  c: Connector,
  reader: typeof readGitRepository = readGitRepository,
) {
  const server = c.setting("server"),
    deviceId = c.setting("deviceId");
  if (!server || !deviceId) return;
  const hold = Number(c.setting("github-download-until") || 0);
  const headers = {
    "x-workbench-device-token": readToken(c.directory, deviceId),
    "content-type": "application/json",
  };
  const response = await requestServer(
    server,
    "/api/device/catalog-jobs?pauseUntil=" + Math.max(0, hold),
    { headers, signal: AbortSignal.timeout(20000) },
  );
  if (response.status === 404) return; // Compatible with a server still being updated.
  if (!response.ok) throw new Error("无法领取技能检查任务");
  const value = await response.json();
  if (value === null) return;
  const job = z
    .object({
      id: z.string().uuid(),
      fullName: z.string().transform(validateRepository),
      attemptToken: z.string().uuid(),
    })
    .parse(value);
  let result: unknown;
  try {
    // A cooldown can also have been set by the concurrent installation worker.
    const until = Number(c.setting("github-download-until") || 0);
    if (until > Date.now())
      throw new PublicGitError(
        "GitHub 下载暂时限流",
        "GIT_RATE_LIMITED",
        new Date(until).toISOString(),
      );
    const git = await reader(job.fullName);
    const skills = [];
    for (const skill of discoverSkills(git.tree)) {
      const text = git.manifests.get(skill.path);
      if (text === undefined) throw new Error("目录未完整读取");
      let manifest;
      try {
        manifest = parseSkillManifest(text);
      } catch {
        continue;
      }
      skills.push({ ...skill, manifest });
    }
    result = {
      attemptToken: job.attemptToken,
      status: "succeeded",
      ref: git.ref,
      skills,
      omittedVariants: git.omittedVariants || 0,
    };
    if (
      skills.length > 300 ||
      Buffer.byteLength(JSON.stringify(result)) > 1500000
    )
      throw new Error("目录超出检查上限");
  } catch (e) {
    if (e instanceof PublicGitError && e.code === "GIT_RATE_LIMITED") {
      const until = Math.max(
        Date.now() + 1000,
        Date.parse(e.retryAt || "") || Date.now() + 60000,
        Number(c.setting("github-download-until") || 0),
      );
      c.setting("github-download-until", String(until));
      result = {
        attemptToken: job.attemptToken,
        status: "failed",
        errorCode: "GIT_RATE_LIMITED",
        message: "GitHub 下载暂时限流，请在暂停结束后重新检查。",
        retryAt: new Date(until).toISOString(),
      };
    } else
      result = {
        attemptToken: job.attemptToken,
        status: "failed",
        errorCode: "GIT_NETWORK",
        message: "本机暂未完成项目文件检查，请检查网络后重新检查。",
      };
  }
  const sent = await requestServer(
    server,
    "/api/device/catalog-jobs/" + encodeURIComponent(job.id) + "/result",
    {
      method: "POST",
      headers,
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!sent.ok) throw new Error("技能检查结果尚未同步，请稍后重新检查");
}
