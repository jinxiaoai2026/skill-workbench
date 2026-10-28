import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { openDB } from "../src/server/db.ts";
import { seedDemo, buildDemoApp } from "../src/server/demo.ts";

if (!existsSync(resolve("dist/index.html")))
  throw new Error("请先运行 pnpm build，再运行 pnpm demo");
const directory = resolve(".local/demo");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = directory + "/admin-credentials.json";
if (!existsSync(file))
  writeFileSync(
    file,
    JSON.stringify(
      {
        password: randomBytes(18).toString("base64url"),
        sessionKey: randomBytes(32).toString("hex"),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
const credentials = JSON.parse(readFileSync(file, "utf8"));
const db = await openDB(directory + "/workbench.sqlite");
await seedDemo(db);
const port = Number(process.env.DEMO_PORT || 4325);
const origin = "http://127.0.0.1:" + port;
const app = await buildDemoApp({
  db,
  password: credentials.password,
  sessionKey: Buffer.from(credentials.sessionKey, "hex"),
  origin,
  allowCollection: false,
});
await app.listen({ host: "127.0.0.1", port });
console.log("只读演示已启动：" + origin + "；数据均为虚构，不连接真实 Codex。");
console.log(
  "管理员账户：admin；演示密码见 .local/demo/admin-credentials.json（不输出密码）。",
);
const close = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
