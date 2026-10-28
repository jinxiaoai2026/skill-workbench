import test from "node:test";
import assert from "node:assert/strict";
import { mergeBatchSelection } from "../src/core/batch-selection.ts";

test("select page deduplicates existing choices before enforcing the batch size", () => {
  const selected = Array.from({ length: 299 }, (_, i) => "path-" + i);
  const next = mergeBatchSelection(
    selected,
    ["path-0", "path-1", "new-path"],
    [],
  );
  assert.equal(next.size, 300);
  assert.equal(next.has("new-path"), true);
});
test("device-specific installed paths are removed before adding new choices and never exceed the API limit", () => {
  const selected = Array.from({ length: 300 }, (_, i) => "path-" + i);
  const installed = selected.slice(0, 200);
  const next = mergeBatchSelection(
    selected,
    Array.from({ length: 300 }, (_, i) => "new-" + i),
    installed,
  );
  assert.equal(next.size, 300);
  assert.equal(next.has("path-0"), false);
  assert.equal(next.has("path-299"), true);
  assert.equal(next.has("new-199"), true);
  assert.equal(next.has("new-200"), false);
});
