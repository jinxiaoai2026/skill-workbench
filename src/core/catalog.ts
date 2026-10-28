export interface CatalogSkill {
  name: string;
  path: string;
  fileCount: number;
  totalBytes: number | null;
}
export interface SkillCatalog {
  fullName: string;
  ref: string;
  skills: CatalogSkill[];
  checkedAt: string;
  source?:
    | "github-api"
    | "github-public-archive"
    | "github-git"
    | "device-git"
    | "cache";
  stale?: boolean;
  warning?: string;
  retryAt?: string;
  rate?: unknown;
}
export function validateRepository(value: string) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(value) ||
    value.split("/").some((s) => s === "." || s === "..")
  )
    throw new Error("无效的 GitHub 仓库标识");
  return value;
}
export function validateSkillPath(value: string) {
  if (value === ".") return value;
  if (
    !value ||
    value.length > 500 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.startsWith("-"))
  )
    throw new Error("技能路径无效");
  return value;
}
export function discoverSkills(
  tree: { path: string; type: string; size?: number; mode?: string }[],
  options: { preferCodex?: boolean } = {},
): CatalogSkill[] {
  const forbidden =
    /(^|\/)(\.system|node_modules|\.git|__tests__|tests|test|fixtures)(\/|$)/;
  const candidates = tree
    .filter(
      (e) =>
        e.type === "blob" &&
        (!e.mode || ["100644", "100755"].includes(e.mode)) &&
        /(^|\/)SKILL\.md$/.test(e.path) &&
        !forbidden.test(e.path),
    )
    .map((e) => {
      const path = e.path === "SKILL.md" ? "." : e.path.slice(0, -9);
      validateSkillPath(path);
      const files = tree.filter(
        (f) =>
          f.type === "blob" && (path === "." || f.path.startsWith(path + "/")),
      );
      return {
        name: path === "." ? "root-skill" : path.split("/").at(-1)!,
        path,
        fileCount: files.length,
        totalBytes: files.every((f) => f.size !== undefined)
          ? files.reduce((n, f) => n + f.size!, 0)
          : null,
      };
    })
    .filter(
      (s) =>
        s.fileCount <= 5000 &&
        (s.totalBytes === null || s.totalBytes <= 50 * 1024 * 1024),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  if (options.preferCodex === false) return candidates;
  const native = new Map<string, string>();
  for (const skill of candidates)
    if (/^\.(agents|codex)\/skills\/[^/]+$/.test(skill.path)) {
      const previous = native.get(skill.name);
      if (!previous || skill.path.startsWith(".agents/"))
        native.set(skill.name, skill.path);
    }
  return candidates.filter((skill) => {
    const preferred = native.get(skill.name);
    if (!preferred || preferred === skill.path) return true;
    return !/^(\.(agent|agents|codex|claude|cursor|dsh|gemini|github|grok|hermes|kiro|omp|opencode|pi|qoder|rovodev|trae-cn|trae|veto|vibe)|cursor-plugin|plugin)\/skills\/[^/]+$/.test(
      skill.path,
    );
  });
}
