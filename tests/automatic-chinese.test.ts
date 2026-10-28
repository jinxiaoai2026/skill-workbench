import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/server/db.ts";
import { collect } from "../src/server/collector.ts";
const html =
  '<article class="Box-row"><h2><a href="/shop/report">shop/report</a></h2><p>Inventory report tool</p></article>';
test("collecting a new public project queues its Chinese description without anyone opening a page", async () => {
  const db = await openDB(":memory:");
  try {
    const result = await collect(db, {
      sources: ["all"],
      fetcher: async () => html,
      enrich: false,
    });
    assert.equal(result.status, "succeeded");
    const requests = await db.all(
      "SELECT full_name,payload FROM explanation_requests",
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].full_name, "shop/report");
    assert.equal(
      JSON.parse(requests[0].payload).description,
      "Inventory report tool",
    );
  } finally {
    await db.close();
  }
});
