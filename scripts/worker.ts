import { runtimeConfig } from "../src/server/config.ts";
import { openDB } from "../src/server/db.ts";
import { startWorker } from "../src/server/jobs.ts";
import {
  CloudChinese,
  startCloudChineseWorker,
} from "../src/server/cloud-chinese.ts";
const config = runtimeConfig();
const db = await openDB(config.database);
const cloudChinese = new CloudChinese(db, config.sessionKey);
const stop = startWorker(db, { cloudEnabled: () => cloudChinese.enabled() });
const stopCloud = startCloudChineseWorker(cloudChinese);
console.log("热榜任务进程已启动。");
process.once("SIGTERM", async () => {
  stop();
  await stopCloud();
  await db.close();
  process.exit(0);
});
