export const SKILL_CATEGORIES: readonly string[] = [
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

type SkillMetadata = {
  name?: string;
  sourceName?: string;
  description?: string;
  sourceDescription?: string;
  sourceRepo?: string;
  tags?: string[];
};

const knownSkills: Record<string, string> = {
  hallmark: "网页设计",
  "web-design-engineer": "网页设计",
  "beautiful-article": "文档与写作",
  "gpt-image-2": "图像创作",
  "kb-retriever": "知识管理",
  "motion-showreel": "视频与动效",
  "jianying-video-editing": "视频与动效",
  "web-video-presentation": "演示与汇报",
  "ego-browser": "自动化工具",
};

// Specific purposes precede shared formats: a slide deck can also be a web page,
// and a customer support tool can also retrieve from a knowledge base.
const rules: { category: string; pattern: RegExp }[] = [
  {
    category: "演示与汇报",
    pattern:
      /presentation|powerpoint|slide\s*decks?|google\s*slides|\bpptx?\b|演示|幻灯片|汇报/iu,
  },
  {
    category: "客服售后",
    pattern: /customer\s*(?:support|service)|after\s*sales|客服|售后|退款/iu,
  },
  {
    category: "广告投放",
    pattern:
      /\bads?\s*(?:analytics|analysis|campaigns?|optimization)|advertis(?:ing|ement)|marketing\s*attribution|广告|投放|营销归因/iu,
  },
  {
    category: "选品研究",
    pattern:
      /product\s*research|competitor|competing\s*products|review\s*analysis|sentiment\s*analysis|选品|竞品|评论分析/iu,
  },
  {
    category: "内容制作",
    pattern:
      /copywrit|product\s*listing|content\s*(?:creat|market|produc)|text\s*to\s*speech|speech\s*(?:generation|synthesis)|\btts\b|商品文案|内容营销|内容创作|配音|语音合成/iu,
  },
  {
    category: "文档与写作",
    pattern:
      /beautiful\s*article|technical\s*writ|\b(?:word|docx|pdf)\b|documents?|article\s*(?:writ|conversion)|文档|写作|网页文章|文章排版/iu,
  },
  {
    category: "网页设计",
    pattern:
      /web\s*design|websites?|front\s*end|\bfrontend\b|landing\s*pages?|\b(?:ui|ux)\s*design|html\s*\/\s*css|网页|网站|前端|界面设计/iu,
  },
  {
    category: "图像创作",
    pattern:
      /image\s*(?:gen(?:eration)?|edit|creat)|(?:generat|edit|creat)\w*\s+(?:and\s+\w+\s+)?images?|\bimagegen\b|\b(?:illustration|illustrator|photoshop)\b|图像|图片|绘画|插画|海报/iu,
  },
  {
    category: "视频与动效",
    pattern:
      /video|motion|animation|showreel|subtitle|剪映|剪辑|视频|动效|动画|字幕/iu,
  },
  {
    category: "经营分析",
    pattern:
      /inventory|profit|orders?|spreadsheets?|business\s*(?:intelligence|analytics)|sales\s*analysis|库存|利润|订单|经营分析|销售分析|数据分析/iu,
  },
  {
    category: "知识管理",
    pattern:
      /knowledge\s*base|knowledge\s*management|\b(?:rag|retriev\w*)\b|知识库|知识管理|知识检索|笔记整理/iu,
  },
  {
    category: "编程开发",
    pattern:
      /programming|developer|development|debug|unit\s*tests?|code\s*(?:review|generat)|\b(?:python|typescript|javascript|backend|cli)\b|编程|开发|代码|调试|单元测试/iu,
  },
  {
    category: "自动化工具",
    pattern:
      /automat|browser|workflow|scheduler?|fill\s*forms|自动化|浏览器|定时任务|工作流/iu,
  },
  {
    category: "效率工具",
    pattern:
      /productivity|task\s*management|meeting\s*(?:notes|minutes)|\btodo\b|效率|待办|会议纪要|日程|任务管理/iu,
  },
];

function normalize(value = ""): string {
  return value.normalize("NFC").toLowerCase().replace(/[-_]+/gu, " ").trim();
}

function matchCategory(value?: string): string | undefined {
  if (!value) return;
  // Excluded uses must not become evidence for the skill's actual purpose.
  const positive = normalize(value).replace(
    /(?:\bnot\s+(?:for|intended\s+for)\b|\bdo\s+not\s+use\b|不用于|不适用于|不要用于)[^.!?。！？\n]*/giu,
    " ",
  );
  return rules.find((rule) => rule.pattern.test(positive))?.category;
}

export function inferSkillCategory(skill: SkillMetadata): string {
  for (const name of [skill.sourceName, skill.name]) {
    const identity = name?.normalize("NFC").toLowerCase().trim() || "";
    const known = Object.hasOwn(knownSkills, identity)
      ? knownSkills[identity]
      : undefined;
    const category = known || matchCategory(name);
    if (category) return category;
  }
  for (const tag of skill.tags || []) {
    const category =
      SKILL_CATEGORIES.find((value) => value === tag.trim()) ||
      matchCategory(tag);
    if (category) return category;
  }
  for (const description of [skill.sourceDescription, skill.description]) {
    const category = matchCategory(description);
    if (category) return category;
  }
  const category = matchCategory(skill.sourceRepo);
  if (category) return category;
  return "通用效率";
}

const nameOrder = new Intl.Collator("zh-CN", { numeric: true });

export function groupSkillsByCategory<
  T extends { category?: string; name?: string; favorite?: boolean },
>(skills: T[]): { category: string; skills: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const skill of skills) {
    const category = skill.category?.trim() || "通用效率";
    const entries = groups.get(category) || [];
    entries.push(skill);
    groups.set(category, entries);
  }
  const customCategories = [...groups.keys()]
    .filter((category) => !SKILL_CATEGORIES.includes(category))
    .sort(nameOrder.compare);

  return [...SKILL_CATEGORIES, ...customCategories].flatMap((category) => {
    const entries = groups.get(category);
    if (!entries) return [];
    entries.sort(
      (a, b) =>
        Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
        nameOrder.compare(a.name || "", b.name || ""),
    );
    return [{ category, skills: entries }];
  });
}
