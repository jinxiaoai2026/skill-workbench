import type { DB } from "./db.ts";
import { z } from "zod";
import {
  explanationHash,
  saveExplanations,
  translateWithCodex,
} from "./explanations.ts";
import {
  discoverSkills,
  validateRepository,
  type SkillCatalog,
} from "../core/catalog.ts";
import { githubJSON, GitHubQueryError } from "./github-query.ts";
import { readPublicRepository } from "./public-repository.ts";
import curatedGuideData from "./catalog-guides.json";
const curatedGuides: { fullName: string; sourceHash: string; guide: unknown }[] = curatedGuideData;
import { readGitRepository, PublicGitError } from "../core/public-git.ts";
import { parseSkillManifest } from "../core/skill-manifest.ts";
export { parseSkillManifest } from "../core/skill-manifest.ts";
import { CatalogTasks } from "./catalog-tasks.ts";
const flights = new WeakMap<DB, Map<string, Promise<SkillCatalog>>>();
const activePublic = new WeakSet<DB>();
const activeGit = new WeakSet<DB>();
export async function getCatalog(
  db: DB,
  fullName: string,
  options: {
    now?: () => number;
    forceRefresh?: boolean;
    publicCatalog?: typeof readPublicRepository;
    gitCatalog?: typeof readGitRepository | null;
  } = {},
): Promise<SkillCatalog> {
  validateRepository(fullName);
  const now = (options.now || Date.now)(),
    key = fullName.toLowerCase();
  const old = await db.get(
    "SELECT payload,checked_at FROM skill_catalogs WHERE lower(full_name)=?",
    [key],
  );
  if (
    old &&
    now - Date.parse(old.checked_at) < (options.forceRefresh ? 30000 : 86400000)
  )
    return JSON.parse(old.payload);
  let map = flights.get(db);
  if (!map) {
    map = new Map();
    flights.set(db, map);
  }
  if (map.has(key)) return map.get(key)!;
  const task = (async () => {
    if (options.gitCatalog === undefined)
      await new CatalogTasks(db, options.now || Date.now).request(fullName);
    const gitReader =
      options.gitCatalog === undefined ? readGitRepository : options.gitCatalog;
    let gitError: Error | undefined;
    if (gitReader) {
      const hold = await db.get("SELECT value FROM meta WHERE key=?", [
        "github-git-cooldown",
      ]);
      if (hold) {
        const state = JSON.parse(hold.value);
        if (state.until > now)
          throw new GitHubQueryError(
            state.message,
            "GITHUB_RATE_LIMITED",
            429,
            429,
            new Date(state.until).toISOString(),
          );
      }
      if (activeGit.has(db))
        throw new GitHubQueryError(
          "正在检查另一个项目，请几秒后重试。",
          "CATALOG_BUSY",
          503,
          undefined,
          new Date(now + 5000).toISOString(),
        );
      activeGit.add(db);
      try {
        const failed = await db.get("SELECT value FROM meta WHERE key=?", [
          "git-catalog-failure:" + key,
        ]);
        if (failed && JSON.parse(failed.value).until > now)
          throw new PublicGitError(
            JSON.parse(failed.value).message,
            "GIT_NETWORK",
          );
        const result = await gitReader(fullName);
        if (!/^[a-f0-9]{40}$/.test(result.ref))
          throw new Error("Git项目版本无效");
        const skills: SkillCatalog["skills"] = [];
        for (const skill of discoverSkills(result.tree)) {
          const text = result.manifests.get(skill.path);
          if (text === undefined) throw new Error("Git技能清单未完整读取");
          let manifest;
          try {
            manifest = parseSkillManifest(text);
          } catch {
            continue;
          }
          skills.push(skill);
          await db.run(
            "INSERT INTO skill_manifests VALUES(?,?,?,?,?) ON CONFLICT(full_name,ref,skill_path) DO NOTHING",
            [
              fullName,
              result.ref,
              skill.path,
              JSON.stringify(manifest),
              new Date(now).toISOString(),
            ],
          );
        }
        const catalog: SkillCatalog = {
          fullName,
          ref: result.ref,
          skills,
          checkedAt: new Date(now).toISOString(),
          source: "github-git",
          ...(result.omittedVariants
            ? {
                warning: `已优先选择适配 Codex 的目录，省略 ${result.omittedVariants} 个其他工具的同名适配目录。`,
              }
            : {}),
        };
        await db.run(
          "INSERT INTO skill_catalogs VALUES(?,?,?) ON CONFLICT(full_name) DO UPDATE SET payload=excluded.payload,checked_at=excluded.checked_at",
          [fullName, JSON.stringify(catalog), catalog.checkedAt],
        );
        return catalog;
      } catch (e) {
        gitError = e as Error;
        if (e instanceof PublicGitError && e.code === "GIT_RATE_LIMITED") {
          const until = Date.parse(e.retryAt || "") || now + 60000;
          await db.run(
            "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [
              "github-git-cooldown",
              JSON.stringify({ until, message: e.message }),
            ],
          );
          throw new GitHubQueryError(
            e.message,
            "GITHUB_RATE_LIMITED",
            429,
            429,
            new Date(until).toISOString(),
          );
        }
        if (old)
          return {
            ...JSON.parse(old.payload),
            source: "cache",
            stale: true,
            warning: "使用上次已核验的固定版本缓存。" + gitError.message,
          };
        await db.run(
          "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [
            "git-catalog-failure:" + key,
            JSON.stringify({ until: now + 10000, message: gitError.message }),
          ],
        );
      } finally {
        activeGit.delete(db);
      }
    }
    const failed = await db.get("SELECT value FROM meta WHERE key=?", [
      "catalog-failure:" + key,
    ]);
    if (failed && !gitReader) {
      const f = JSON.parse(failed.value);
      if (f.until > now)
        throw new GitHubQueryError(
          f.message,
          f.code,
          f.statusCode,
          f.upstreamStatus,
          f.retryAt,
          f.rate,
        );
    }
    let ref: string,
      skills: SkillCatalog["skills"],
      source: SkillCatalog["source"] = "github-api",
      warning: string | undefined,
      retryAt: string | undefined,
      rate: unknown;
    try {
      const commit = await githubJSON(
        db,
        "/repos/" + fullName + "/commits/HEAD",
        options,
      );
      ref = commit.sha;
      if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("无法确定项目提交版本");
      const tree = await githubJSON(
        db,
        "/repos/" + fullName + "/git/trees/" + ref + "?recursive=1",
        options,
      );
      if (tree.truncated || !Array.isArray(tree.tree))
        throw new Error("项目目录不完整，暂时无法确认可安装技能。");
      skills = discoverSkills(tree.tree);
    } catch (error) {
      const e = error as GitHubQueryError;
      if (old) {
        return {
          ...JSON.parse(old.payload),
          stale: true,
          source: "cache",
          warning:
            "使用上次已验证的固定版本缓存（" +
            old.checked_at +
            "）。" +
            e.message,
          retryAt: e.retryAt,
          rate: e.rate,
        };
      }
      if (e.code !== "GITHUB_RATE_LIMITED") throw e;
      if (
        gitReader &&
        !(gitError instanceof PublicGitError && gitError.code === "GIT_MISSING")
      )
        throw new GitHubQueryError(
          "GitHub查询接口暂时限流；按需下载连接也暂未成功，请稍后重新检查。" +
            (gitError?.message || ""),
          "GITHUB_UNAVAILABLE",
          503,
          e.upstreamStatus,
          new Date(now + 10000).toISOString(),
          e.rate,
        );
      if (activePublic.has(db))
        throw new GitHubQueryError(
          "正在核查另一个公开仓库，请几秒后重试。",
          "CATALOG_BUSY",
          503,
          undefined,
          new Date(now + 5000).toISOString(),
        );
      activePublic.add(db);
      try {
        const held = await db.get("SELECT value FROM meta WHERE key=?", [
          "catalog-public-cooldown",
        ]);
        if (held) {
          const hold = JSON.parse(held.value);
          if (hold.until > now)
            throw new GitHubQueryError(
              hold.message,
              "GITHUB_RATE_LIMITED",
              429,
              hold.upstreamStatus,
              hold.retryAt,
            );
        }
        await db.transaction(async (tx) => {
          await tx.run(
            "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO NOTHING",
            ["catalog-public-budget", JSON.stringify({ start: now, count: 0 })],
          );
          await tx.run("UPDATE meta SET value=value WHERE key=?", [
            "catalog-public-budget",
          ]);
          const row = await tx.get("SELECT value FROM meta WHERE key=?", [
            "catalog-public-budget",
          ]);
          const previous = JSON.parse(row!.value);
          const budget =
            now - previous.start < 3600000
              ? previous
              : { start: now, count: 0 };
          if (budget.count >= 10)
            throw new Error("公开预检已达到每小时10个仓库的请求上限");
          await tx.run("UPDATE meta SET value=? WHERE key=?", [
            JSON.stringify({ ...budget, count: budget.count + 1 }),
            "catalog-public-budget",
          ]);
        });
        const pub = await (options.publicCatalog || readPublicRepository)(
          fullName,
        );
        ref = pub.ref;
        if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("公开项目版本无效");
        skills = [];
        for (const skill of discoverSkills(pub.tree)) {
          const text = pub.manifests.get(skill.path);
          if (!text) throw new Error("公开归档缺少技能清单，无法完整核查。");
          let manifest;
          try {
            manifest = parseSkillManifest(text);
          } catch {
            continue;
          }
          skills.push({ ...skill, name: manifest.name });
          await db.run(
            "INSERT INTO skill_manifests VALUES(?,?,?,?,?) ON CONFLICT(full_name,ref,skill_path) DO NOTHING",
            [
              fullName,
              ref,
              skill.path,
              JSON.stringify(manifest),
              new Date(now).toISOString(),
            ],
          );
        }
        source = "github-public-archive";
        retryAt = e.retryAt;
        rate = e.rate;
        warning =
          "GitHub REST 接口暂时限流；已通过正常公开页面及固定提交归档完成核查，无需额外付费。";
      } catch (publicError) {
        const failure =
          publicError instanceof GitHubQueryError
            ? publicError
            : new GitHubQueryError(
                e.message +
                  " 公开文件检查也未完成：" +
                  (publicError instanceof Error
                    ? publicError.message
                    : "暂时无法完整核查"),
                e.code,
                e.statusCode,
                e.upstreamStatus,
                e.retryAt,
                e.rate,
              );
        if (publicError instanceof GitHubQueryError && publicError.retryAt)
          await db.run(
            "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [
              "catalog-public-cooldown",
              JSON.stringify({
                until: Date.parse(publicError.retryAt),
                message: publicError.message,
                upstreamStatus: publicError.upstreamStatus,
                retryAt: publicError.retryAt,
              }),
            ],
          );
        await db.run(
          "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [
            "catalog-failure:" + key,
            JSON.stringify({
              until: Math.max(
                now + 60000,
                publicError instanceof GitHubQueryError
                  ? Date.parse(publicError.retryAt || "") || 0
                  : 0,
              ),
              message: failure.message,
              code: failure.code,
              statusCode: failure.statusCode,
              upstreamStatus: failure.upstreamStatus,
              retryAt: failure.retryAt,
              rate: failure.rate,
            }),
          ],
        );
        throw failure;
      } finally {
        activePublic.delete(db);
      }
    }
    const catalog: SkillCatalog = {
      fullName,
      ref,
      skills,
      checkedAt: new Date(now).toISOString(),
      source,
      ...(warning ? { warning } : {}),
      ...(retryAt ? { retryAt } : {}),
      ...(rate ? { rate } : {}),
    };
    await db.run(
      "INSERT INTO skill_catalogs VALUES(?,?,?) ON CONFLICT(full_name) DO UPDATE SET payload=excluded.payload,checked_at=excluded.checked_at",
      [fullName, JSON.stringify(catalog), catalog.checkedAt],
    );
    return catalog;
  })();
  map.set(key, task);
  try {
    return await task;
  } finally {
    map.delete(key);
  }
}
async function loadManifest(fullName: string, ref: string, path: string) {
  const suffix = path === "." ? "SKILL.md" : path + "/SKILL.md";
  const url =
    "https://raw.githubusercontent.com/" +
    fullName +
    "/" +
    ref +
    "/" +
    suffix.split("/").map(encodeURIComponent).join("/");
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("无法读取所选技能的用途说明，请稍后重试");
  const reader = r.body?.getReader();
  if (!reader) throw new Error("技能清单为空");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 256000) {
      await reader.cancel();
      throw new Error("技能清单过大，无法自动读取");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
const pageRequests = new Map<string, Promise<any>>();
export async function getSkillPage(
  db: DB,
  query: { repo: string; offset?: string; search?: string },
  options: {
    loadManifest?: typeof loadManifest;
    translator?: typeof translateWithCodex;
  } = {},
) {
  const fullName = validateRepository(query.repo),
    offset = Number(query.offset || 0),
    search = (query.search || "").trim();
  if (!Number.isSafeInteger(offset) || offset < 0 || search.length > 100)
    throw new Error("无效的技能筛选条件");
  const catalog = await getCatalog(db, fullName);
  const key = [fullName, catalog.ref, offset, search].join(":");
  if (pageRequests.has(key)) return pageRequests.get(key)!;
  const task = (async () => {
    const cached = new Map(
      (
        await db.all(
          "SELECT skill_path,payload FROM skill_manifests WHERE lower(full_name)=lower(?) AND ref=?",
          [fullName, catalog.ref],
        )
      ).map((r) => [r.skill_path, JSON.parse(r.payload)]),
    );
    const aliases: Record<string, string> = {
      客服: "customer-support",
      工单: "ticket",
      营销: "marketing",
      销售: "sales",
      数据: "data",
      财务: "finance",
      法律: "legal",
      设计: "design",
      分析: "analy",
    };
    const candidates = catalog.skills
      .filter(
        (s) =>
          !search ||
          [s.path, s.name, cached.get(s.path)?.description || ""].some((v) =>
            v.toLowerCase().includes(search.toLowerCase()),
          ) ||
          s.path.toLowerCase().includes(aliases[search] || "\0"),
      )
      .sort((a, b) => {
        const priority = (p: string) =>
          /customer-support|marketing|sales|data|productivity|finance/.test(p)
            ? 0
            : 1;
        return (
          priority(a.path) - priority(b.path) || a.path.localeCompare(b.path)
        );
      });
    const page = candidates.slice(offset, offset + 8);
    const entries = await Promise.all(
      page.map(async (skill) => {
        let manifest = cached.get(skill.path);
        if (!manifest) {
          manifest = parseSkillManifest(
            await (options.loadManifest || loadManifest)(
              fullName,
              catalog.ref,
              skill.path,
            ),
          );
          await db.run(
            "INSERT INTO skill_manifests VALUES(?,?,?,?,?) ON CONFLICT(full_name,ref,skill_path) DO NOTHING",
            [
              fullName,
              catalog.ref,
              skill.path,
              JSON.stringify(manifest),
              new Date().toISOString(),
            ],
          );
        }
        return {
          ...skill,
          manifestName: manifest.name,
          description: manifest.description,
          input: {
            fullName: fullName + "#" + skill.path,
            description:
              "技能名称：" +
              manifest.name +
              "\n技能用途：" +
              manifest.description,
          },
        };
      }),
    );
    const guides = new Map(
      (
        await db.all(
          "SELECT * FROM repo_explanation_versions UNION ALL SELECT * FROM repo_explanations",
        )
      ).map((r) => [r.full_name + "\0" + r.source_hash, JSON.parse(r.payload)]),
    );
    for (const entry of entries) {
      const hash = explanationHash(entry.input),
        key = entry.input.fullName + "\0" + hash;
      const curated = curatedGuides.find(
        (g) => g.fullName === entry.input.fullName && g.sourceHash === hash,
      );
      if (!guides.has(key) && curated) {
        await saveExplanations(db, [entry.input], [curated.guide]);
        guides.set(key, curated.guide);
      }
    }
    const missing = entries.filter(
      (e) => !guides.has(e.input.fullName + "\0" + explanationHash(e.input)),
    );
    let warning: string | undefined;
    if (
      missing.length &&
      (options.translator || process.env.EXPLAIN_WITH_CODEX !== "0")
    ) {
      const inputs = missing.map((e) => e.input);
      try {
        const translated = await (options.translator || translateWithCodex)(
          inputs,
        );
        await saveExplanations(db, inputs, translated);
        for (const item of translated) {
          const input = inputs.find((i) => i.fullName === item.fullName)!;
          guides.set(item.fullName + "\0" + explanationHash(input), item);
        }
      } catch {
        warning =
          "技能清单已核验；中文说明暂不可用，先展示真实名称及用途原文。";
      }
    }
    for (const entry of missing.filter(
      (e) => !guides.has(e.input.fullName + "\0" + explanationHash(e.input)),
    )) {
      warning ||= "技能清单已核验；中文说明待生成，不影响发现和安装。";
      await db.run(
        "INSERT INTO explanation_requests VALUES(?,?,?,?) ON CONFLICT(full_name,source_hash) DO NOTHING",
        [
          entry.input.fullName,
          explanationHash(entry.input),
          JSON.stringify(entry.input),
          new Date().toISOString(),
        ],
      );
    }
    return {
      items: entries.map(({ input, ...e }) => ({
        ...e,
        guide: guides.get(input.fullName + "\0" + explanationHash(input)),
      })),
      total: candidates.length,
      hasMore: offset + page.length < candidates.length,
      offset,
      warning,
    };
  })();
  pageRequests.set(key, task);
  try {
    return await task;
  } finally {
    pageRequests.delete(key);
  }
}
