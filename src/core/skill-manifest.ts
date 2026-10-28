import { parse as parseYaml } from "yaml";
import { z } from "zod";
export const manifestSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(10000),
});
export function parseSkillManifest(
  text: string,
): z.infer<typeof manifestSchema> {
  const front = text
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!front) throw new Error("技能清单缺少有效元信息");
  return manifestSchema.parse(parseYaml(front, { maxAliasCount: 20 }));
}
