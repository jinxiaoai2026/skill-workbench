import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
export function runtimeConfig() {
  const directory = resolve(process.env.WORKBENCH_DATA_DIR || ".local");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = directory + "/admin-credentials.json";
  let stored: { password: string; sessionKey: string };
  if (existsSync(file)) stored = JSON.parse(readFileSync(file, "utf8"));
  else {
    stored = {
      password: randomBytes(18).toString("base64url"),
      sessionKey: randomBytes(32).toString("hex"),
    };
    writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }
  const password = process.env.ADMIN_PASSWORD || stored.password;
  const sessionKey = Buffer.from(
    process.env.SESSION_KEY || stored.sessionKey,
    "hex",
  );
  if (password.length < 10 || sessionKey.length !== 32)
    throw new Error("管理员密码至少 10 位，SESSION_KEY 必须是 64 位十六进制");
  const port = Number(process.env.PORT || 4317);
  const origin = process.env.APP_ORIGIN || "http://127.0.0.1:" + port;
  if (
    process.env.NODE_ENV === "production" &&
    (!process.env.APP_ORIGIN ||
      !process.env.SESSION_KEY ||
      !process.env.ADMIN_PASSWORD)
  )
    throw new Error(
      "生产环境必须配置 APP_ORIGIN、SESSION_KEY 和 ADMIN_PASSWORD",
    );
  return {
    directory,
    password,
    sessionKey,
    origin,
    port,
    host: process.env.HOST || "127.0.0.1",
    database: process.env.DATABASE_URL || directory + "/workbench.sqlite",
  };
}
