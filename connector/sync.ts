import { Connector } from "./registry.ts";
import { readToken } from "./credentials.ts";
import { requestServer } from "./transport.ts";
export { validateServer } from "./transport.ts";
export async function sync(
  c: Connector,
  options: { roots?: string[]; discover?: boolean } = {},
) {
  const url = c.setting("server");
  const deviceId = c.setting("deviceId");
  if (!url || !deviceId) throw new Error("连接器尚未配对");
  if (options.discover !== false) c.discover(options.roots);
  const events = c.pending();
  const skills = c.refresh().map(({ path, syncContent, ...s }) => s);
  const send = async (batch: typeof skills, pending: typeof events) => {
    const r = await requestServer(url, "/api/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workbench-device-token": readToken(c.directory, deviceId),
      },
      body: JSON.stringify({ skills: batch, events: pending }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`同步失败（${r.status}），事件保留在本地`);
    const result = (await r.json()) as { acked: string[] };
    c.ack(result.acked);
    return result.acked.length;
  };
  // Register every skill before sending events, including events for later batches.
  let batch: typeof skills = [],
    bytes = 0;
  for (const skill of skills) {
    const size = Buffer.byteLength(JSON.stringify(skill));
    if (batch.length && (batch.length >= 300 || bytes + size > 1500000)) {
      await send(batch, []);
      batch = [];
      bytes = 0;
    }
    batch.push(skill);
    bytes += size;
  }
  if (batch.length) await send(batch, []);
  const acked = events.length || !skills.length ? await send([], events) : 0;
  c.setting("lastSync", new Date().toISOString());
  return { skills: skills.length, events: acked };
}
