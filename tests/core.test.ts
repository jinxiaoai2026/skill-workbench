import test from "node:test";
import assert from "node:assert/strict";
import { dateRange, shanghaiDay } from "../src/core/dates.ts";
import { parseTrending, rankSnapshots } from "../src/core/trending.ts";
import { inferSkillReads, allowedSkill } from "../src/core/usage.ts";
import { relevance } from "../src/core/relevance.ts";

test("custom date includes end day and handles Shanghai midnight and leap days", () => {
  const r = dateRange(
    "custom",
    new Date("2026-10-24T05:00:00Z"),
    "2024-02-29",
    "2024-03-01",
  );
  assert.equal(r.start, "2024-02-28T16:00:00.000Z");
  assert.equal(r.end, "2024-03-01T16:00:00.000Z");
  assert.equal(shanghaiDay("2026-10-23T16:00:00Z"), "2026-10-24");
  assert.throws(() =>
    dateRange("custom", new Date(), "2026-02-30", "2026-03-01"),
  );
  assert.throws(() =>
    dateRange("custom", new Date(), "2026-10-25", "2026-10-24"),
  );
});
test("rolling 30 days differs from calendar month", () => {
  const now = new Date("2026-10-24T01:00:00Z");
  assert.equal(dateRange("30d", now).from, "2026-09-25");
  assert.equal(dateRange("month", now).from, "2026-10-01");
  assert.equal(dateRange("previousMonth", now).to, "2026-09-30");
});
const html = `<html><title>Trending repositories on GitHub</title><article class="Box-row"><h2><a href="/owner/repo">owner / repo</a></h2><p>中文语音 synthesis</p><span itemprop="programmingLanguage">Python</span><a href="/owner/repo/stargazers">1,234</a><span class="float-sm-right">123 stars today</span></article></html>`;
test("extract actual repo anchors and numeric fields, reject error or empty pages", () => {
  const rows = parseTrending(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fullName, "owner/repo");
  assert.equal(rows[0].stars, 1234);
  assert.equal(rows[0].periodStars, 123);
  assert.throws(() => parseTrending("<h1>Rate limit</h1>"));
  assert.throws(() =>
    parseTrending("<title>Trending repositories on GitHub</title>"),
  );
});
test("ranking uses latest daily snapshot per source, daily maximum and skips weekly duplicates", () => {
  const repo = (fullName: string) => ({
    fullName,
    repoId: fullName,
    url: "https://github.com/" + fullName,
    description: "",
    language: "",
    stars: 0,
    periodStars: 0,
  });
  const ss = [
    {
      source: "all",
      period: "daily",
      collectedAt: "2026-10-23T02:00:00Z",
      entries: [repo("a/a"), repo("b/b")],
    },
    {
      source: "all",
      period: "daily",
      collectedAt: "2026-10-23T12:00:00Z",
      entries: [repo("b/b"), repo("a/a")],
    },
    {
      source: "python",
      period: "daily",
      collectedAt: "2026-10-23T12:00:00Z",
      entries: [repo("a/a")],
    },
    {
      source: "all",
      period: "weekly",
      collectedAt: "2026-10-23T12:00:00Z",
      entries: [repo("a/a")],
    },
    {
      source: "all",
      period: "daily",
      collectedAt: "2026-10-24T02:00:00Z",
      entries: [repo("a/a")],
    },
  ];
  const ranked = rankSnapshots(ss, "2026-10-23", "2026-10-24");
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].fullName, "a/a");
  assert.equal(ranked[0].score, 170);
  assert.equal(ranked[0].days, 2);
  assert.equal(ranked[1].score, 100);
});
test("file reads stay inferred; listing and mentions do not become confirmations", () => {
  const skills = [
    { id: "s1", path: "/mine/a/SKILL.md", ownership: "original", name: "a" },
  ];
  assert.equal(inferSkillReads("cat /mine/a/SKILL.md", skills).length, 1);
  assert.equal(
    inferSkillReads("cat /mine/a/SKILL.md", skills)[0].evidence,
    "inferred",
  );
  assert.equal(inferSkillReads("ls /mine/a/SKILL.md", skills).length, 0);
  assert.equal(inferSkillReads("echo use a", skills).length, 0);
  assert.equal(
    allowedSkill({ ownership: "thirdParty", path: "/mine/a" }),
    false,
  );
  assert.equal(
    allowedSkill({ ownership: "original", path: "/x/.codex/skills/.system/a" }),
    false,
  );
});
test("ecommerce classification provides concrete capability and avoids generic AI false positives", () => {
  assert.equal(
    relevance({
      fullName: "x/tts",
      description: "Chinese text-to-speech voice synthesis",
    }).category,
    "内容制作",
  );
  assert.equal(
    relevance({ fullName: "x/ai", description: "AI coding framework" }).score,
    0,
  );
  assert.match(
    relevance({
      fullName: "x/ocr",
      description: "OCR table document extraction",
    }).reason,
    /资料|图片|文档/,
  );
  assert.equal(
    relevance({
      fullName: "Renhuai123/ziwei-doushu",
      description: "紫微斗数开源排盘引擎，含格局知识库、古籍原文数据",
    }).score,
    0,
  );
});
