import { runtimeConfig } from "../src/server/config.ts";
import { openDB } from "../src/server/db.ts";
import { collect } from "../src/server/collector.ts";
const db = await openDB(runtimeConfig().database);
try {
  console.log(JSON.stringify(await collect(db), null, 2));
} finally {
  await db.close();
}
