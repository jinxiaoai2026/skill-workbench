#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Connector } from "./registry.ts";
import { runManaged } from "./runner.ts";
import { scanHistory } from "./history.ts";
import { sync } from "./sync.ts";
import { normalizeServer, requestServer } from "./transport.ts";
import { storeToken } from "./credentials.ts";
import { runExplanationJob } from "./explanation-jobs.ts";
import { runCatalogJob } from "./catalog-jobs.ts";
import { runInstallJob } from "./jobs.ts";
import { runSkillNameJob } from "./name-jobs.ts";
const c = new Connector(
  process.env.WORKBENCH_CONNECTOR_DIR || join(homedir(), ".skill-workbench"),
);
const [cmd, ...args] = process.argv.slice(2);
const flag = (key: string) => {
  const i = args.indexOf("--" + key);
  return i < 0 ? undefined : args[i + 1];
};
try {
  if (cmd === "adopt")
    console.log(
      c.adopt(
        args[0],
        flag("ownership") || "original",
        flag("id"),
        args.includes("--sync-content"),
      ),
    );
  else if (cmd === "list")
    console.log(c.skills().map(({ content, ...s }) => s));
  else if (cmd === "roots") {
    c.setting("skillRoots", JSON.stringify(args.map((p) => resolve(p))));
    console.log("已保存额外技能目录，下次同步自动检查。");
  } else if (cmd === "pair") {
    const server = normalizeServer(args[0]);
    const r = await requestServer(server, "/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: args[1], name: flag("name") || "我的 Mac" }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error("配对失败：配对码错误或已过期");
    const result = (await r.json()) as { deviceId: string; token: string };
    storeToken(c.directory, result.deviceId, result.token);
    c.setting("server", server);
    c.setting("deviceId", result.deviceId);
    c.setting("history-cursor", String(Date.now()));
    console.log("连接器已配对，凭证已安全保存。");
    await sync(c);
  } else if (cmd === "run") {
    const divider = args.indexOf("--");
    if (divider < 1 || !args[divider + 1])
      throw new Error(
        "用法：connector run <skill-id> -- <command> [arguments]",
      );
    const code = await runManaged(
      c,
      args[0],
      args[divider + 1],
      args.slice(divider + 2),
    );
    if (c.setting("server"))
      await sync(c).catch((e) => console.error(e.message));
    process.exitCode = code;
  } else if (cmd === "sync") {
    c.discover();
    console.log(
      scanHistory(c, process.env.CODEX_HOME || join(homedir(), ".codex")),
    );
    console.log(await sync(c, { discover: false }));
  } else if (cmd === "watch") {
    let running = true;
    process.once("SIGTERM", () => (running = false));
    process.once("SIGINT", () => (running = false));
    console.log("连接器运行中，每 15 秒同步一次。");
    let installing: Promise<void> | undefined;
    let cataloging: Promise<void> | undefined;
    let translating: Promise<void> | undefined;
    let nextChinese = 0;
    let nextSync = 0;
    while (running) {
      try {
        if (!cataloging)
          cataloging = runCatalogJob(c)
            .catch((e) => console.error((e as Error).message))
            .finally(() => {
              cataloging = undefined;
            });
        if (!translating && Date.now() >= nextChinese) {
          nextChinese = Date.now() + 15000;
          translating = runExplanationJob(c)
            .catch((e) => console.error((e as Error).message))
            .finally(() => {
              translating = undefined;
            });
        }
        if (Date.now() >= nextSync) {
          nextSync = Date.now() + 15000;
          c.discover();
          scanHistory(c, process.env.CODEX_HOME || join(homedir(), ".codex"));
          await sync(c, { discover: false });
          if (!installing)
            installing = runSkillNameJob(c)
              .then(() => runInstallJob(c))
              .catch((e) => console.error((e as Error).message))
              .finally(() => {
                installing = undefined;
              });
        }
      } catch (e) {
        console.error((e as Error).message);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (installing) await installing;
    if (cataloging) await cataloging;
    if (translating) await translating;
  } else
    console.log(
      "命令：adopt <目录> --ownership original|derived|imported|local [--sync-content] [--id UUID] / roots [额外目录...] / list / pair <服务器> <配对码> / run <skill-id> -- <command> / sync / watch",
    );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  c.close();
}
