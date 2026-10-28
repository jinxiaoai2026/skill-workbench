import test from "node:test";
import assert from "node:assert/strict";
import { waitForCatalog } from "../web/catalog.ts";
test("web waits only for pending catalog and stops on rate limits or close", async () => {
  let count = 0;
  const pending = Object.assign(new Error("正在通过 Mac 检查"), {
    code: "CATALOG_PENDING",
  });
  const value = await waitForCatalog(
    async () => {
      if (++count < 3) throw pending;
      return { source: "device-git" };
    },
    { sleep: async () => {} },
  );
  assert.equal(count, 3);
  assert.equal(value.source, "device-git");
  count = 0;
  await assert.rejects(() =>
    waitForCatalog(
      async () => {
        count++;
        throw Object.assign(new Error("limited"), {
          code: "GITHUB_RATE_LIMITED",
        });
      },
      { sleep: async () => {} },
    ),
  );
  assert.equal(count, 1);
  let active = true;
  await assert.rejects(
    () =>
      waitForCatalog(
        async () => {
          throw pending;
        },
        {
          isActive: () => active,
          sleep: async () => {
            active = false;
          },
        },
      ),
    (e: any) => e.name === "AbortError",
  );
});
