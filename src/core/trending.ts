import { load } from "cheerio";
import { shanghaiDay } from "./dates.ts";
export interface RepoEntry {
  repoId?: string;
  fullName: string;
  url: string;
  description: string;
  language: string;
  stars: number;
  periodStars: number;
  license?: string | null;
  updatedAt?: string;
  topics?: string[];
}
export interface Snapshot {
  id?: string;
  source: string;
  period: string;
  collectedAt: string;
  entries: RepoEntry[];
}
export interface RankedRepo extends RepoEntry {
  score: number;
  days: number;
  allDays: number;
  rank: number;
  observedDelta: number | null;
  observedFrom: string;
  observedTo: string;
}
export function parseTrending(html: string): RepoEntry[] {
  const $ = load(html);
  const entries: RepoEntry[] = [];
  $("article.Box-row").each((_, el) => {
    const row = $(el);
    const href = row.find("h2 a").attr("href")?.trim();
    if (!href || !/^\/[\w.-]+\/[\w.-]+$/.test(href)) return;
    const fullName = href.slice(1);
    const count = (s: string) => Number(s.replace(/[^\d]/g, "")) || 0;
    let repoId: string | undefined;
    row.find("[data-hydro-click]").each((_, e) => {
      try {
        const id = JSON.parse($(e).attr("data-hydro-click") || "{}")?.payload
          ?.repository_id;
        if (Number.isSafeInteger(id) && id > 0) repoId = String(id);
      } catch {}
    });
    entries.push({
      repoId,
      fullName,
      url: "https://github.com" + href,
      description: row.find("p").text().trim().replace(/\s+/g, " "),
      language: row.find('[itemprop="programmingLanguage"]').text().trim(),
      stars: count(row.find(`a[href="${href}/stargazers"]`).text()),
      periodStars: count(row.find(".float-sm-right").text()),
    });
  });
  if (entries.length === 0)
    throw new Error(
      "未解析到仓库：可能是页面结构变化、限流或空榜，保留上一次有效快照",
    );
  if (
    new Set(entries.map((e) => e.fullName.toLowerCase())).size !==
    entries.length
  )
    throw new Error("来源榜单存在重复仓库");
  return entries;
}
export function rankSnapshots(
  snapshots: Snapshot[],
  from: string,
  to: string,
): RankedRepo[] {
  const latest = new Map<string, Snapshot>();
  for (const s of snapshots) {
    const d = shanghaiDay(s.collectedAt);
    if (s.period !== "daily" || d < from || d > to) continue;
    const key = d + ":" + s.source;
    const old = latest.get(key);
    if (!old || old.collectedAt < s.collectedAt) latest.set(key, s);
  }
  const daily = new Map<
    string,
    Map<string, { entry: RepoEntry; score: number; all: boolean }>
  >();
  const observations = new Map<string, { at: string; entry: RepoEntry }[]>();
  for (const s of latest.values()) {
    const day = shanghaiDay(s.collectedAt);
    const rows = daily.get(day) || new Map();
    daily.set(day, rows);
    s.entries.forEach((entry, i) => {
      const id = entry.repoId || entry.fullName.toLowerCase();
      const score =
        ((100 * (s.entries.length - i)) / s.entries.length) *
        (s.source === "all" ? 1 : 0.7);
      const old = rows.get(id);
      rows.set(id, {
        entry,
        score: Math.max(old?.score || 0, score),
        all: !!old?.all || s.source === "all",
      });
      const obs = observations.get(id) || [];
      obs.push({ at: s.collectedAt, entry });
      observations.set(id, obs);
    });
  }
  const sums = new Map<string, RankedRepo>();
  for (const rows of daily.values())
    for (const [id, item] of rows) {
      const old = sums.get(id);
      sums.set(id, {
        ...item.entry,
        score: (old?.score || 0) + item.score,
        days: (old?.days || 0) + 1,
        allDays: (old?.allDays || 0) + (item.all ? 1 : 0),
        rank: 0,
        observedDelta: null,
        observedFrom: "",
        observedTo: "",
      });
    }
  for (const [id, repo] of sums) {
    const obs = observations.get(id)!.sort((a, b) => a.at.localeCompare(b.at));
    const first = obs[0],
      last = obs.at(-1)!;
    Object.assign(repo, last.entry, {
      observedDelta:
        first.at === last.at ? null : last.entry.stars - first.entry.stars,
      observedFrom: first.at,
      observedTo: last.at,
      score: Math.round(repo.score * 100) / 100,
    });
  }
  return [...sums.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.allDays - a.allDays ||
        String(a.repoId || a.fullName).localeCompare(
          String(b.repoId || b.fullName),
        ),
    )
    .slice(0, 100)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}
