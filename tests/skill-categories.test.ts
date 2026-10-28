import test from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_CATEGORIES,
  groupSkillsByCategory,
  inferSkillCategory,
} from "../src/core/skill-categories.ts";

test("the existing library is categorized by each skill's purpose", () => {
  const examples = [
    {
      name: "hallmark",
      description: "Design websites and new pages that look designed.",
      category: "网页设计",
    },
    {
      name: "web-design-engineer",
      description:
        "Build polished HTML/CSS/JavaScript/React pages, dashboards and prototypes. Not for back-end, CLI, non-visual coding, article conversion, or video presentations.",
      category: "网页设计",
    },
    {
      name: "beautiful-article",
      description: "把素材设计成可离线打开和分享的单文件 HTML 网页文章。",
      category: "文档与写作",
    },
    {
      name: "gpt-image-2",
      description: "图像生成与编辑，覆盖海报、UI、学术图和技术架构图。",
      category: "图像创作",
    },
    {
      name: "kb-retriever",
      description: "从本地知识库目录检索 PDF、Excel 文件并回答问题。",
      category: "知识管理",
    },
    {
      name: "motion-showreel",
      description: "用代码制作图形、文字或界面动画视频，输出 MP4 和源码。",
      category: "视频与动效",
    },
    {
      name: "jianying-video-editing",
      description: "使用剪映编辑短视频、字幕、口播、画中画和关键帧。",
      category: "视频与动效",
    },
    {
      name: "web-video-presentation",
      description: "把文章和口播稿做成点击驱动的 16:9 网页演示。",
      category: "演示与汇报",
    },
    {
      name: "ego-browser",
      description:
        "Open websites, fill forms, take screenshots and automate tasks.",
      category: "自动化工具",
    },
  ];

  for (const example of examples) {
    assert.equal(inferSkillCategory(example), example.category, example.name);
  }
});

test("original skill identity survives display renames and broad descriptions", () => {
  assert.equal(
    inferSkillCategory({
      name: "我的常用工具",
      sourceName: "web-design-engineer",
      description: "Not for backend, CLI, video editing or technical writing.",
    }),
    "网页设计",
  );
  assert.equal(
    inferSkillCategory({
      name: "商品设计",
      sourceName: "gpt-image-2",
      sourceDescription:
        "Create product websites, slides and technical diagrams.",
    }),
    "图像创作",
  );
});

test("Chinese and English business metadata map to useful ecommerce categories", () => {
  const examples = [
    { name: "竞品评论分析", category: "选品研究" },
    { name: "product-research", category: "选品研究" },
    {
      description: "Compare customer reviews to research competing products.",
      category: "选品研究",
    },
    { name: "广告投放复盘", category: "广告投放" },
    { name: "ad-analytics", category: "广告投放" },
    { tags: ["marketing", "广告投放"], category: "广告投放" },
    { name: "售后退款助手", category: "客服售后" },
    {
      description:
        "Customer support replies using an enterprise knowledge base.",
      category: "客服售后",
    },
    {
      sourceDescription: "Analyze inventory, profit and order spreadsheets.",
      category: "经营分析",
    },
    { name: "库存利润分析", category: "经营分析" },
    { name: "product-listing-copywriter", category: "内容制作" },
    { description: "生成商品文案和小红书内容营销稿。", category: "内容制作" },
    { name: "定时任务自动化", category: "自动化工具" },
    {
      description: "Automate browser workflows and fill forms.",
      category: "自动化工具",
    },
    { name: "代码审查", category: "编程开发" },
    {
      description: "Debug Python programs and run unit tests.",
      category: "编程开发",
    },
    { name: "会议纪要与待办", category: "效率工具" },
    {
      description: "Improve productivity with task management.",
      category: "效率工具",
    },
  ];

  for (const example of examples) {
    assert.equal(
      inferSkillCategory(example),
      example.category,
      JSON.stringify(example),
    );
  }
});

test("metadata supports creative, knowledge and presentation skills beyond known names", () => {
  const examples = [
    {
      name: "新工具",
      description: "Design responsive websites with HTML and CSS.",
      category: "网页设计",
    },
    {
      name: "绘画助手",
      description: "Generate and edit images from prompts.",
      category: "图像创作",
    },
    {
      name: "新工具",
      sourceDescription: "剪辑视频并添加转场、字幕和动效。",
      category: "视频与动效",
    },
    { name: "技术写作", category: "文档与写作" },
    {
      description: "Create and edit Word documents and PDF reports.",
      category: "文档与写作",
    },
    { name: "知识库检索", category: "知识管理" },
    {
      description: "Search a local knowledge base and retrieve cited notes.",
      category: "知识管理",
    },
    {
      name: "周报演示",
      description: "Create PowerPoint slide decks.",
      category: "演示与汇报",
    },
    { sourceRepo: "owner/image-generation-tools", category: "图像创作" },
  ];

  for (const example of examples) {
    assert.equal(
      inferSkillCategory(example),
      example.category,
      JSON.stringify(example),
    );
  }
});

test("negative scope does not turn a web design skill into a backend or video tool", () => {
  assert.equal(
    inferSkillCategory({
      description:
        "Design polished browser-rendered websites with HTML/CSS and React. Not for backend programming, CLI automation or video editing.",
    }),
    "网页设计",
  );
  assert.equal(
    inferSkillCategory({
      description:
        "This is a general helper. Not for video editing or backend development.",
    }),
    "通用效率",
  );
});

test("unknown or empty metadata always receives the general efficiency category", () => {
  for (const skill of [
    {},
    { name: "mystery-helper" },
    { name: "constructor" },
    { name: "__proto__" },
    { description: "   " },
    { tags: [] },
  ]) {
    assert.equal(inferSkillCategory(skill), "通用效率");
  }
});

test("groups follow purpose order, preserve custom labels, and account for every skill once", () => {
  const categories = [
    "网页设计",
    "图像创作",
    "视频与动效",
    "文档与写作",
    "知识管理",
    "演示与汇报",
    "编程开发",
    "自动化工具",
    "选品研究",
    "广告投放",
    "客服售后",
    "经营分析",
    "内容制作",
    "效率工具",
    "通用效率",
  ];
  const skills = [
    { name: "manual-z", category: "自定义乙" },
    ...categories
      .toReversed()
      .map((category) => ({ name: category, category })),
    { name: "manual-a", category: "自定义甲" },
  ];
  const groups = groupSkillsByCategory(skills);

  assert.deepEqual(
    groups.slice(0, 15).map((group) => group.category),
    categories,
  );
  assert.deepEqual(SKILL_CATEGORIES, categories);
  assert.deepEqual(
    groups.slice(15).map((group) => group.category),
    ["自定义甲", "自定义乙"],
  );
  assert.equal(groups.flatMap((group) => group.skills).length, skills.length);
  assert.equal(
    new Set(groups.flatMap((group) => group.skills)).size,
    skills.length,
  );
});

test("grouping omits empty categories, defaults missing labels and sorts favorites before names without mutation", () => {
  const skills = [
    { id: "z", name: "Zulu", category: "网页设计" },
    { id: "b", name: "Beta", category: "网页设计", favorite: true },
    { id: "a", name: "Alpha", category: "网页设计", favorite: true },
    { id: "c", name: "Charlie", category: "网页设计" },
    { id: "unknown", name: "Unknown" },
    { id: "blank", name: "Blank", category: "  " },
  ];
  const originalOrder = skills.map((skill) => skill.id);
  const groups = groupSkillsByCategory(skills);

  assert.deepEqual(
    groups.map((group) => group.category),
    ["网页设计", "通用效率"],
  );
  assert.deepEqual(
    groups[0].skills.map((skill) => skill.id),
    ["a", "b", "c", "z"],
  );
  assert.deepEqual(
    groups[1].skills.map((skill) => skill.id),
    ["blank", "unknown"],
  );
  assert.deepEqual(
    skills.map((skill) => skill.id),
    originalOrder,
  );
  assert.deepEqual(groupSkillsByCategory([]), []);
});
