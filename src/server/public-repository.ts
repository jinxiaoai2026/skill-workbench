import { gunzipSync } from "node:zlib";
import { load } from "cheerio";
import { validateRepository } from "../core/catalog.ts";
import { GitHubQueryError } from "./github-query.ts";

const MAX_ARCHIVE = 20 * 1024 * 1024,
  MAX_EXPANDED = 50 * 1024 * 1024;
async function bounded(r: Response, max: number) {
  if (r.status === 429 || (r.status === 403 && r.headers.has("retry-after"))) {
    const retry = r.headers.get("retry-after"),
      now = Date.now();
    const until =
      retry && /^\d+$/.test(retry)
        ? now + Number(retry) * 1000
        : retry && Number.isFinite(Date.parse(retry))
          ? Date.parse(retry)
          : now + 60000;
    await r.body?.cancel();
    throw new GitHubQueryError(
      "GitHub 公开文件访问也暂时限流，请在提示时间后重试；尚未判断该仓库没有 Skill。",
      "GITHUB_RATE_LIMITED",
      429,
      r.status,
      new Date(Math.max(now + 1000, until)).toISOString(),
    );
  }
  if (!r.ok)
    throw new Error(
      "公开文件暂时无法读取（" + r.status + "）；未将失败视为没有 Skill。",
    );
  if (Number(r.headers.get("content-length") || 0) > max) {
    await r.body?.cancel();
    throw new Error("项目超过公开预检大小上限，无法完整核查。");
  }
  const reader = r.body?.getReader();
  if (!reader) throw new Error("公开文件为空，无法完成预检。");
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.length;
    if (bytes > max) {
      await reader.cancel();
      throw new Error("项目超过公开预检大小上限，无法完整核查。");
    }
    parts.push(chunk.value);
  }
  return Buffer.concat(parts);
}
function pax(data: Buffer) {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) throw new Error("归档扩展头不完整");
    const count = Number(data.subarray(offset, space).toString());
    if (
      !Number.isSafeInteger(count) ||
      count <= space - offset + 1 ||
      offset + count > data.length
    )
      throw new Error("归档扩展头无效");
    const line = data.subarray(space + 1, offset + count - 1).toString();
    const eq = line.indexOf("=");
    if (eq > 0) result[line.slice(0, eq)] = line.slice(eq + 1);
    offset += count;
  }
  return result;
}

export async function readPublicRepository(
  fullName: string,
  options: { fetcher?: typeof fetch } = {},
) {
  validateRepository(fullName);
  const send = options.fetcher || fetch;
  const request = (url: string) =>
    send(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: { accept: "text/html,application/octet-stream" },
    });
  // A normal public repository page supplies its exact default-branch commit.
  // This uses no credential, mirror, alternate identity or REST retry loop.
  const html = (
    await bounded(
      await request("https://github.com/" + fullName),
      2 * 1024 * 1024,
    )
  ).toString("utf8");
  const $ = load(html);
  let ref = "";
  $('script[data-target="react-app.embeddedData"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).text());
      const value = j.payload?.codeViewRepoRoute?.refInfo?.currentOid;
      if (typeof value === "string" && /^[a-f0-9]{40}$/.test(value))
        ref = value;
    } catch {}
  });
  if (!ref)
    throw new Error(
      "公开页面未提供可核验的提交版本，暂时无法确认 Skill，未提交安装。",
    );
  const compressed = await bounded(
    await request("https://codeload.github.com/" + fullName + "/tar.gz/" + ref),
    MAX_ARCHIVE,
  );
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED });
  } catch {
    throw new Error("公开归档无效或解压后超过50MB，无法完整核查。");
  }
  const tree: { path: string; type: string; size: number; mode: string }[] = [];
  const manifests = new Map<string, string>();
  let offset = 0,
    root = "",
    pending: Record<string, string> = {},
    ended = false,
    entries = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((v) => v === 0)) {
      ended = true;
      break;
    }
    if (++entries > 20000)
      throw new Error("项目文件数量超过预检上限，无法完整核查。");
    const string = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const octal = (value: string) => {
      if (!/^[0-7]+$/.test(value.trim())) throw new Error("归档数值头无效");
      return parseInt(value.trim(), 8);
    };
    const expected = octal(string(148, 8).trim());
    const actual = header.reduce(
      (sum, v, i) => sum + (i >= 148 && i < 156 ? 32 : v),
      0,
    );
    if (expected !== actual) throw new Error("归档校验和不匹配");
    const size = octal(string(124, 12));
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + size > archive.length
    )
      throw new Error("归档文件不完整");
    const data = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const type = string(156, 1) || "0";
    if (type === "g") continue;
    if (type === "x") {
      if (size > 256000) throw new Error("归档扩展头过大");
      pending = pax(data);
      continue;
    }
    if (type === "L") {
      if (size > 256000) throw new Error("归档路径过长");
      pending.path = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const name =
      pending.path ||
      [string(345, 155), string(0, 100)].filter(Boolean).join("/");
    pending = {};
    if (
      !name ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").some((p) => p === "." || p === "..") ||
      name.includes("\0")
    )
      throw new Error("归档包含非法路径，已停止预检。");
    const first = name.split("/")[0];
    if (!root) root = first;
    if (first !== root) throw new Error("归档根目录不一致");
    const path = name.slice(root.length + 1).replace(/\/$/, "");
    if (!path || type !== "0") continue;
    tree.push({ path, type: "blob", size, mode: "100644" });
    if (/(^|\/)SKILL\.md$/.test(path)) {
      if (size > 256000) throw new Error("技能清单过大，无法核查");
      manifests.set(
        path === "SKILL.md" ? "." : path.slice(0, -9),
        data.toString("utf8"),
      );
    }
  }
  if (!ended) throw new Error("公开归档不完整，不能判断项目没有 Skill。");
  return { ref, tree, manifests };
}
