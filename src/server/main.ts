import { runtimeConfig } from "./config.ts";
import { openDB } from "./db.ts";
import { buildApp } from "./app.ts";
import { startWorker } from "./jobs.ts";
import { explainMissing } from "./explanations.ts";
import { CloudChinese, startCloudChineseWorker } from "./cloud-chinese.ts";
const config = runtimeConfig();
const db = await openDB(config.database);
const app = await buildApp({ ...config, db });
await app.listen({ host: config.host, port: config.port });
console.log("Skill 工作台已启动：" + config.origin);
console.log(
  "本机首次登录凭证位于 .local/admin-credentials.json（未输出密码）。",
);
const cloudChinese = new CloudChinese(db, config.sessionKey);
const stopWorker =
  process.env.RUN_WORKER === "1"
    ? startWorker(db, { cloudEnabled: () => cloudChinese.enabled() })
    : () => {};
const stopCloud = startCloudChineseWorker(cloudChinese);
if (process.env.EXPLAIN_WITH_CODEX !== "0")
  void explainMissing(db, {
    localMetadataOnly: await cloudChinese.enabled(),
  }).catch((e) => console.error("中文说明：" + e.message));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  stopWorker();
  await stopCloud();
  await app.close();
  await db.close();
  process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
