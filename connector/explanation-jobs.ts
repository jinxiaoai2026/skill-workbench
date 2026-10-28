import { z } from "zod";
import { Connector } from "./registry.ts";
import { requestServer } from "./transport.ts";
import { readToken } from "./credentials.ts";
import {
  explanationSchema,
  explanationHash,
  translateWithCodex,
  type Explanation,
} from "../src/core/explanations.ts";
import { validateRepository } from "../src/core/catalog.ts";
const jobSchema = z
  .object({
    id: z.string().uuid(),
    attemptToken: z.string().uuid(),
    inputs: z
      .array(
        z
          .object({
            fullName: z.string().transform(validateRepository),
            description: z.string().max(4000),
            sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export async function runExplanationJob(
  c: Connector,
  translator: typeof translateWithCodex = translateWithCodex,
) {
  const server = c.setting("server"),
    deviceId = c.setting("deviceId");
  if (!server || !deviceId) return;
  const headers = {
    "x-workbench-device-token": readToken(c.directory, deviceId),
    "content-type": "application/json",
  };
  const send = async (entry: { id: string; result: unknown }) => {
    const response = await requestServer(
      server,
      "/api/device/explanation-jobs/" +
        encodeURIComponent(entry.id) +
        "/result",
      {
        method: "POST",
        headers,
        body: JSON.stringify(entry.result),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (response.ok || response.status === 409) {
      c.setting("chinese-result-outbox", "");
      return;
    }
    throw new Error("中文介绍已保存在本机，稍后自动重传");
  };
  const pending = c.setting("chinese-result-outbox");
  if (pending) {
    await send(JSON.parse(pending));
    return;
  }
  if (Number(c.setting("chinese-retry-until") || 0) > Date.now()) return;
  const claimed = await requestServer(server, "/api/device/explanation-jobs", {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (claimed.status === 404) return;
  if (!claimed.ok) throw new Error("暂时无法领取中文介绍任务");
  const raw = await claimed.json();
  if (!raw) return;
  const job = jobSchema.parse(raw);
  if (
    new Set(job.inputs.map((r) => r.fullName)).size !== job.inputs.length ||
    job.inputs.some((r) => explanationHash(r) !== r.sourceHash)
  )
    throw new Error("中文任务来源版本无效");
  let result: unknown;
  try {
    const guides = new Map<string, Explanation>(),
      missing: typeof job.inputs = [];
    for (const repo of job.inputs) {
      const cached = c.setting("chinese-cache:" + repo.sourceHash);
      let guide;
      try {
        guide = cached
          ? explanationSchema.parse(JSON.parse(cached))
          : undefined;
      } catch {}
      if (guide?.fullName === repo.fullName) guides.set(repo.fullName, guide);
      else missing.push(repo);
    }
    if (missing.length) {
      const generated = z
        .array(explanationSchema)
        .parse(
          await translator(
            missing.map(({ fullName, description }) => ({
              fullName,
              description,
            })),
          ),
        );
      if (
        generated.length !== missing.length ||
        new Set(generated.map((r) => r.fullName)).size !== missing.length ||
        generated.some((r) => !missing.some((x) => x.fullName === r.fullName))
      )
        throw new Error("生成的中文介绍与项目不匹配");
      for (const guide of generated) {
        const repo = missing.find((r) => r.fullName === guide.fullName)!;
        c.setting("chinese-cache:" + repo.sourceHash, JSON.stringify(guide));
        guides.set(guide.fullName, guide);
      }
    }
    result = {
      attemptToken: job.attemptToken,
      status: "succeeded",
      items: job.inputs.map((repo) => ({
        ...guides.get(repo.fullName)!,
        sourceHash: repo.sourceHash,
      })),
    };
  } catch {
    c.setting("chinese-retry-until", String(Date.now() + 300000));
    result = {
      attemptToken: job.attemptToken,
      status: "failed",
      message: "本机中文引擎暂未完成，将在5分钟后自动重试；已有介绍已保留。",
    };
  }
  const entry = { id: job.id, result };
  c.setting("chinese-result-outbox", JSON.stringify(entry));
  await send(entry);
}
