import { randomUUID } from "node:crypto";
import { buildApp, requestPath } from "./app.ts";
import type { DB } from "./db.ts";
import { Service } from "./service.ts";
import { hash } from "./auth.ts";
import { saveExplanations } from "./explanations.ts";
import { type RepoEntry, type Snapshot } from "../core/trending.ts";

/** Explicitly fictional data for local screenshots; never loads user files. */
export async function seedDemo(db: DB, at = new Date()) {
  const marker = "public-demo-v1";
  if (await db.get("SELECT value FROM meta WHERE key=?", [marker]))
    return { reused: true };
  for (const table of ["skills", "devices", "snapshots", "events", "meta"]) {
    if (Number((await db.get(`SELECT COUNT(*) AS n FROM ${table}`))?.n))
      throw new Error("演示数据只能写入专用空库，现有数据未修改");
  }
  const deviceId = randomUUID();
  const stamp = at.toISOString();
  await db.run(
    "INSERT INTO devices(id,name,token_hash,last_seen,created_at) VALUES(?,?,?,?,?)",
    [deviceId, "演示设备（非真实连接）", hash(randomUUID()), stamp, stamp],
  );
  const specs = [
    [
      "商品文案助手",
      "根据已提供的商品资料整理卖点与中文详情文案。",
      "内容制作",
      "original",
      "商品文案",
      ["商品资料", "写作"],
    ],
    [
      "活动页面设计",
      "为品牌活动页面设计清晰的布局与交互。",
      "网页设计",
      "imported",
      "活动页",
      ["网页", "设计"],
    ],
    [
      "经营报表整理",
      "整理导出的库存、订单与利润报表，辅助复盘。",
      "经营分析",
      "original",
      "经营分析",
      ["表格", "经营"],
    ],
    [
      "周报演示制作",
      "把工作记录组织成结构清楚的汇报材料。",
      "演示与汇报",
      "original",
      "做周报",
      ["演示", "周报"],
    ],
    [
      "知识库检索",
      "从用户指定的本地资料中检索并归纳答案。",
      "知识管理",
      "imported",
      "查资料",
      ["知识库", "检索"],
    ],
    [
      "短视频字幕整理",
      "整理提供的视频口播文字和字幕结构。",
      "视频与动效",
      "derived",
      "字幕整理",
      ["视频", "字幕"],
    ],
    [
      "文档摘要",
      "为提供的文档整理重点和行动清单。",
      "文档与写作",
      "original",
      "文档摘要",
      ["文档", "总结"],
    ],
    [
      "客服知识整理",
      "依据提供的商品与售后资料整理答复建议。",
      "客服售后",
      "original",
      "客服助手",
      ["客服", "知识"],
    ],
  ] as const;
  const skills = specs.map(
    ([name, description, category, ownership, customName, tags], i) => ({
      id: randomUUID(),
      name,
      description,
      category,
      categoryMode: "manual" as const,
      ownership,
      customName,
      version: "demo-version-" + String(i).padStart(4, "0"),
      tags: [...tags],
      platforms: i < 3 ? ["淘宝/天猫", "京东", "抖音"] : [],
      createdDate: stamp.slice(0, 10),
      ...(ownership === "imported"
        ? {
            sourceRepo: "demo-lab/workflow-tools",
            sourcePath: "skills/demo-" + i,
          }
        : {}),
    }),
  );
  const events: any[] = [];
  const counts = [12, 10, 8, 6, 5, 4, 3, 2];
  let sequence = 0;
  for (const [index, skill] of skills.entries())
    for (let i = 0; i < counts[index]; i++) {
      sequence++;
      events.push({
        eventId: "demo-explicit-" + sequence,
        invocationId: "demo-call-" + sequence,
        skillId: skill.id,
        occurredAt: new Date(
          at.getTime() - (i % 5) * 86400000 - sequence * 60000,
        ).toISOString(),
        type: "start",
        evidence: "confirmed",
        source: "native-explicit",
        status: "unknown",
        sessionRef: sequence.toString(16).padStart(20, "0"),
        turnRef: (sequence + 1000).toString(16).padStart(20, "0"),
        version: skill.version,
      });
    }
  for (let i = 0; i < 6; i++)
    events.push({
      eventId: "demo-inferred-" + i,
      invocationId: "demo-inferred-call-" + i,
      skillId: skills[i].id,
      occurredAt: new Date(at.getTime() - i * 3600000 - 120000).toISOString(),
      type: "start",
      evidence: "inferred",
      source: "history-read",
      status: "unknown",
      version: skills[i].version,
    });
  const service = new Service(db);
  await service.ingest(deviceId, { skills, events });
  const names = [
    "语音配音工具",
    "表格分析工具",
    "图片文字识别",
    "客服知识工具",
    "网页设计工具",
    "视频字幕工具",
    "选品评论分析",
    "通用开发工具",
  ];
  const descriptions = [
    "Text to speech for narrated product videos",
    "Spreadsheet inventory and profit analysis",
    "OCR document parsing for product documents",
    "Customer support knowledge base retrieval",
    "Website UI design and landing page tools",
    "Video editing and subtitle tools",
    "Product research and review analysis",
    "Developer code review and unit tests",
  ];
  const entries: RepoEntry[] = names.map((_, i) => ({
    repoId: "demo-" + i,
    fullName:
      "demo-lab/" +
      [
        "voice-tool",
        "sheet-analysis",
        "document-ocr",
        "support-knowledge",
        "page-design",
        "video-captions",
        "review-research",
        "dev-helper",
      ][i],
    url: "https://example.com/projects/demo-" + i,
    description: descriptions[i],
    language: i % 2 ? "TypeScript" : "Python",
    stars: 1200 + i * 140,
    periodStars: 12 + i * 7,
  }));
  for (let day = 0; day < 5; day++)
    for (const source of ["all", "python"]) {
      const items = [
        ...entries.slice(day % 3),
        ...entries.slice(0, day % 3),
      ].map((r, i) => ({
        ...r,
        stars: r.stars + day * 25,
        periodStars: 12 + i * 7 + day,
      }));
      const snapshot: Snapshot = {
        id: randomUUID(),
        source,
        period: "daily",
        collectedAt: new Date(
          at.getTime() - (4 - day) * 86400000 - 300000,
        ).toISOString(),
        entries: items,
      };
      await db.run("INSERT INTO snapshots VALUES(?,?,?,?,?)", [
        snapshot.id,
        source,
        "daily",
        snapshot.collectedAt,
        JSON.stringify(snapshot),
      ]);
    }
  for (const period of ["weekly", "monthly"]) {
    const snapshot: Snapshot = {
      id: randomUUID(),
      source: "all",
      period,
      collectedAt: new Date(at.getTime() - 240000).toISOString(),
      entries,
    };
    await db.run("INSERT INTO snapshots VALUES(?,?,?,?,?)", [
      snapshot.id,
      "all",
      period,
      snapshot.collectedAt,
      JSON.stringify(snapshot),
    ]);
  }
  await saveExplanations(
    db,
    entries,
    entries.map((r, i) => ({
      fullName: r.fullName,
      titleZh: names[i],
      summaryZh:
        "演示项目：" +
        [
          "生成语音旁白，辅助整理商品讲解素材。",
          "根据导出表格整理库存、订单和利润。",
          "从示例文档中识别文字并整理结构。",
          "整理知识资料并提供客服答复参考。",
          "设计网站与活动页面的布局。",
          "整理视频内容和字幕。",
          "归纳评论与竞品需求线索。",
          "辅助代码评审与开发验证。",
        ][i],
      useZh: "这是一项用于展示工作台功能的虚构项目，不对应真实服务或平台接入。",
    })),
  );
  for (const skill of skills.filter((s) => s.ownership === "imported")) {
    await db.run("INSERT INTO installed_skills VALUES(?,?,?,?,?,?,?)", [
      deviceId,
      skill.sourceRepo!,
      skill.sourcePath!,
      "a".repeat(40),
      skill.name,
      "b".repeat(64),
      stamp,
    ]);
    await db.run("INSERT INTO skill_aliases VALUES(?,?,?,?,?)", [
      deviceId,
      skill.sourceRepo!,
      skill.sourcePath!,
      skill.customName,
      stamp,
    ]);
  }
  await db.run("INSERT INTO job_runs VALUES(?,?,?,?,?,?)", [
    randomUUID(),
    "collection",
    new Date(at.getTime() - 420000).toISOString(),
    new Date(at.getTime() - 240000).toISOString(),
    "succeeded",
    JSON.stringify({
      demo: true,
      results: [
        { source: "all", period: "daily", count: 8 },
        { source: "python", period: "daily", count: 8 },
        { source: "all", period: "weekly", count: 8 },
        { source: "all", period: "monthly", count: 8 },
      ],
    }),
  ]);
  await db.run("INSERT INTO meta VALUES(?,?)", [marker, stamp]);
  return { reused: false };
}

export async function buildDemoApp(options: Parameters<typeof buildApp>[0]) {
  const app = await buildApp({ ...options, allowCollection: false });
  app.addHook("onRequest", async (req, reply) => {
    const path = requestPath(req);
    if (
      path.startsWith("/api/") &&
      ((!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        !["/api/login", "/api/logout"].includes(path)) ||
        path === "/api/catalog" ||
        path.startsWith("/api/catalog/"))
    )
      return reply
        .code(403)
        .send({ error: "这是只读演示，安装、配对、模型调用和数据修改已禁用" });
  });
  app.addHook("preSerialization", async (req, _reply, payload) =>
    requestPath(req) === "/api/state"
      ? { ...(payload as object), demo: true }
      : payload,
  );
  return app;
}
