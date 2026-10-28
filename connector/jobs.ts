import { Connector } from "./registry.ts";
import { sync } from "./sync.ts";
import { requestServer } from "./transport.ts";
import { readToken } from "./credentials.ts";
import { installSkill, type InstallJob } from "./install.ts";
import { PublicGitError } from "../src/core/public-git.ts";
export async function runInstallJob(c: Connector) {
  const server = c.setting("server"),
    deviceId = c.setting("deviceId");
  if (!server || !deviceId) return;
  if (Number(c.setting("github-download-until") || 0) > Date.now()) return;
  const headers = {
    "x-workbench-device-token": readToken(c.directory, deviceId),
    "content-type": "application/json",
  };
  const claim = await requestServer(server, "/api/device/jobs", {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!claim.ok) throw new Error("无法领取安装任务");
  const job = (await claim.json()) as InstallJob | null;
  if (!job) return;
  let result;
  try {
    const hold = Number(c.setting("github-download-until") || 0);
    if (hold > Date.now())
      throw new PublicGitError(
        "GitHub 下载暂时限流，尚未开始下载。",
        "GIT_RATE_LIMITED",
        new Date(hold).toISOString(),
      );
    result = await installSkill(job);
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    const generic: Record<string, string> = {
      EACCES: "本机技能目录没有写入权限",
      EPERM: "本机未允许写入技能目录",
      EXDEV: "技能目录位于其他磁盘，请在本机调整安装位置",
      ENOENT: "本机缺少必要文件，请检查安装器与技能目录",
    };
    if (e instanceof PublicGitError && e.code === "GIT_RATE_LIMITED") {
      const until = Math.max(
        Date.now() + 1000,
        Date.parse(e.retryAt || "") || Date.now() + 60000,
        Number(c.setting("github-download-until") || 0),
      );
      c.setting("github-download-until", String(until));
    }
    const message =
      e instanceof PublicGitError
        ? e.message +
          (e.code === "GIT_RATE_LIMITED"
            ? " 预计北京时间 " +
              new Date(
                Number(c.setting("github-download-until")),
              ).toLocaleTimeString("zh-CN", {
                timeZone: "Asia/Shanghai",
                hour12: false,
              }) +
              " 后可继续添加。"
            : "")
        : error.code
          ? generic[error.code] || "本机文件操作未完成，请检查连接器日志"
          : error.message;
    result = { status: "failed", message };
    console.error("本机安装详情：" + error.message);
  }
  const response = await requestServer(
    server,
    "/api/device/jobs/" + encodeURIComponent(job.id) + "/result",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ ...result, attemptToken: job.attemptToken }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw new Error("安装结果尚未同步，稍后会自动重试");
  if (result.status === "succeeded")
    await sync(c).catch(() =>
      console.error("技能已添加，稍后自动同步至“我的 Skill”"),
    );
  console.log(
    result.status === "succeeded"
      ? "已添加第三方技能：" + job.name
      : "技能添加失败：" + result.message,
  );
}
