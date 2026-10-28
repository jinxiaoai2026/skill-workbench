import { openDB } from "../src/server/db.ts";
import { runtimeConfig } from "../src/server/config.ts";
import { explainMissing } from "../src/server/explanations.ts";
const db = await openDB(runtimeConfig().database);
try {
  console.log(await explainMissing(db));
} finally {
  await db.close();
}
