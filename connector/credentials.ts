import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// Tokens go to macOS Keychain through stdin, never through shell interpolation.
export function storeToken(directory: string, deviceId: string, token: string) {
  if (process.platform === "darwin") {
    if (!/^[a-zA-Z0-9_-]+$/.test(token) || !/^[a-zA-Z0-9-]+$/.test(deviceId))
      throw new Error("无效设备凭证");
    const command = `add-generic-password -U -a ${deviceId} -s skill-workbench -w ${token}\n`;
    const result = spawnSync("/usr/bin/security", ["-i"], {
      input: command,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0)
      throw new Error("无法保存到钥匙串，请检查 macOS 钥匙串权限");
  } else writeFileSync(join(directory, "device-token"), token, { mode: 0o600 });
}
export function readToken(directory: string, deviceId: string): string {
  if (process.env.WORKBENCH_DEVICE_TOKEN)
    return process.env.WORKBENCH_DEVICE_TOKEN;
  if (process.platform === "darwin") {
    const r = spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", deviceId, "-s", "skill-workbench", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (r.status !== 0) throw new Error("无法读取设备凭证，请重新配对");
    return r.stdout.trim();
  }
  const path = join(directory, "device-token");
  if (!existsSync(path)) throw new Error("请先配对");
  return readFileSync(path, "utf8").trim();
}
