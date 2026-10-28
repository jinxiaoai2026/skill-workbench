export const platforms = ["淘宝/天猫", "京东", "拼多多", "抖音", "小红书"];
const rules = [
  {
    pattern: /\b(ocr|document parsing|table extraction)\b|文字识别|文档解析/i,
    category: "经营分析",
    reason: "识别商品图片、供应商资料与运营文档，减少手工录入。",
    score: 90,
  },
  {
    pattern:
      /text.to.speech|speech (generation|synthesis)|\btts\b|配音|语音合成/i,
    category: "内容制作",
    reason: "用于商品讲解和短视频配音；先测试中文效果与运行成本。",
    score: 92,
  },
  {
    pattern:
      /video (generation|editing)|subtitle|image (editing|generation)|视频生成|字幕|图像编辑/i,
    category: "内容制作",
    reason: "可辅助制作商品图、短视频和字幕，适合内容素材工作流。",
    score: 86,
  },
  {
    pattern:
      /customer (service|support)|enterprise knowledge base|企业知识库|客服知识库|智能客服|retrieval.augmented/i,
    category: "客服售后",
    reason: "可整理商品与售后知识，生成有依据的客服答复建议。",
    score: 84,
  },
  {
    pattern:
      /inventory|profit|spreadsheet|business intelligence|库存|利润|经营分析/i,
    category: "经营分析",
    reason: "基于导出的订单、库存和报表进行整理分析。",
    score: 82,
  },
  {
    pattern:
      /review analysis|sentiment analysis|product research|评论分析|选品|竞品/i,
    category: "选品研究",
    reason: "可整理商品评论、发现需求和比较竞品卖点。",
    score: 85,
  },
  {
    pattern: /ad analytics|advertising analytics|广告分析|投放分析|营销归因/i,
    category: "广告投放",
    reason: "可分析导出的投放报表和素材效果，辅助复盘。",
    score: 88,
  },
];
export function relevance(repo: {
  fullName: string;
  description?: string;
  topics?: string[];
}) {
  const text = [repo.fullName, repo.description, ...(repo.topics || [])].join(
    " ",
  );
  const rule = rules.find((r) => r.pattern.test(text));
  const direct = platforms.filter((p) =>
    p.split("/").some((n) => text.includes(n)),
  );
  return {
    score: rule?.score || 0,
    category: rule?.category || "通用工具",
    reason: rule?.reason || "暂未找到明确的电商业务用途。",
    platforms: direct.length ? direct : platforms,
    integration: "通用能力，需要接入；尚未验证电商平台接口",
    basis: "基于仓库名称、描述及主题的规则判断，可手动纠正",
  };
}
