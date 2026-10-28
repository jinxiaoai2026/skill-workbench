import { mkdir, writeFile } from "node:fs/promises";
import { parseTrending } from "../src/core/trending.ts";
await mkdir(".local/validation", { recursive: true });
const report = [];
for (const period of ["daily", "weekly", "monthly"]) {
  const url = "https://github.com/trending?since=" + period;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("GitHub HTTP " + r.status);
  const html = await r.text();
  const entries = parseTrending(html);
  const record = {
    url,
    collectedAt: new Date().toISOString(),
    period,
    status: r.status,
    count: entries.length,
    entries,
  };
  report.push(record);
  console.log({ period, count: entries.length, first: entries[0].fullName });
}
await writeFile(
  ".local/validation/github-live.json",
  JSON.stringify(report, null, 2),
);
