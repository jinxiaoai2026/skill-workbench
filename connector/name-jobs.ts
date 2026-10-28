import { Connector } from "./registry.ts";
import { readToken } from "./credentials.ts";
import { sync } from "./sync.ts";
import { requestServer } from "./transport.ts";
import { renameRegisteredSkill, type SkillNameJob } from "./skill-names.ts";

export async function runSkillNameJob(c: Connector) {
  const server = c.setting("server"),
    deviceId = c.setting("deviceId");
  if (!server || !deviceId) return;
  const headers = {
    "x-workbench-device-token": readToken(c.directory, deviceId),
    "content-type": "application/json",
  };
  const response = await requestServer(server, "/api/device/name-jobs", {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("无法领取启动名称任务");
  const job = (await response.json()) as SkillNameJob | null;
  if (!job) return;
  let result: any;
  try {
    result = renameRegisteredSkill(c, job);
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    console.error("本机启动名详情：" + error.message);
    const messages: Record<string, string> = {
      ENOENT: "本机技能文件不存在，请同步后重试",
      EACCES: "本机技能目录没有写入权限",
      EPERM: "本机未允许写入技能目录",
    };
    result = {
      status: "failed",
      message: error.code
        ? messages[error.code] || "本机操作未完成，请查看连接器日志"
        : error.message,
    };
  }
  const saved = await requestServer(
    server,
    "/api/device/name-jobs/" + encodeURIComponent(job.id) + "/result",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ ...result, attemptToken: job.attemptToken }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!saved.ok) throw new Error("启动名称结果尚未同步，稍后自动重试");
  if (result.status === "succeeded")
    await sync(c).catch(() =>
      console.error("启动名称已修改，稍后同步网页记录"),
    );
  console.log(
    result.status === "succeeded"
      ? "启动名称已同步：" + job.launchName
      : "启动名称未修改：" + result.message,
  );
}
