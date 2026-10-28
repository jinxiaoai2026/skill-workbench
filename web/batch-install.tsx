import { useEffect, useState } from "react";
import {
  Download,
  CheckCircle2,
  LoaderCircle,
  AlertCircle,
} from "lucide-react";
import { api, datetime } from "./api";
import { validateCustomName } from "../src/core/skill-names";
import { mergeBatchSelection } from "../src/core/batch-selection";

type Item = {
  path: string;
  name: string;
  status: string;
  message: string;
  job?: { id: string; status: string; message: string };
};
const status = (item: Item) => item.job?.status || item.status;
function nameError(name: string) {
  if (!name.trim()) return "";
  try {
    validateCustomName(name);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}
export function BatchInstallPanel({
  repo,
  catalog,
  state,
  onChanged,
}: {
  repo: any;
  catalog: any;
  state: any;
  onChanged: () => Promise<void>;
}) {
  const devices = state.devices.filter((d: any) => !d.revoked);
  const [device, setDevice] = useState(
      devices.length === 1 ? devices[0].id : "",
    ),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [names, setNames] = useState<Record<string, string>>({}),
    [titles, setTitles] = useState<Record<string, string>>({}),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [page, setPage] = useState<any>({ items: [], total: 0, hasMore: false }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [submitting, setSubmitting] = useState(false),
    [items, setItems] = useState<Item[] | null>(null);
  const installed = new Set<string>(
    state.installedSkills
      .filter(
        (s: any) => s.device_id === device && s.full_name === repo.fullName,
      )
      .map((s: any) => s.skill_path),
  );
  const eligible = catalog.skills.filter((s: any) => !installed.has(s.path));
  const chosen = catalog.skills.filter(
    (s: any) => selected.has(s.path) && !installed.has(s.path),
  );
  const invalidNames = chosen.some(
    (s: any) => !!nameError(names[s.path] || ""),
  );
  const pending =
    items?.some((i) => ["queued", "running"].includes(status(i))) || false;
  const jobIds = items?.flatMap((i) => (i.job ? [i.job.id] : [])) || [];
  const idsKey = jobIds.join(",");
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api(
          "/catalog/skills?" +
            new URLSearchParams({
              repo: repo.fullName,
              search,
              offset: String(offset),
            }),
        );
        if (!active) return;
        setPage(data);
        setTitles((old) => ({
          ...old,
          ...Object.fromEntries(
            data.items.map((s: any) => [s.path, s.guide?.titleZh || s.name]),
          ),
        }));
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [repo.fullName, search, offset]);
  useEffect(() => {
    if (!pending || !idsKey) return;
    let active = true,
      busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const rows = await api("/install/status", "POST", {
          ids: idsKey.split(","),
        });
        if (!active) return;
        const latest = new Map(rows.map((r: any) => [r.id, r]));
        setItems(
          (old) =>
            old?.map((i) =>
              i.job && latest.has(i.job.id)
                ? { ...i, job: latest.get(i.job.id) as any }
                : i,
            ) || null,
        );
        await onChanged();
      } catch {
        if (active) setError("暂时无法更新安装状态，连接恢复后会继续查询。");
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pending, idsKey, onChanged]);
  const toggle = (path: string) => {
    setSelected((old) => {
      const next = mergeBatchSelection(old, [], installed);
      if (next.has(path)) next.delete(path);
      else if (next.size < 300) next.add(path);
      else setError("一次最多导入 300 项，请分批选择。");
      return next;
    });
  };
  const submit = async (paths: string[], retry = false) => {
    setSubmitting(true);
    setError("");
    try {
      const result = await api("/install/batch", "POST", {
        fullName: repo.fullName,
        deviceId: device,
        skills: paths.map((path) => ({
          path,
          ...(names[path]?.trim() ? { customName: names[path].trim() } : {}),
        })),
      });
      setItems((previous) =>
        retry && previous
          ? previous.map(
              (i) => result.items.find((n: Item) => n.path === i.path) || i,
            )
          : result.items,
      );
      await onChanged();
    } catch (e) {
      setError("此批未提交：" + (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  if (items) {
    const completed = items.filter((i) =>
      ["installed", "succeeded"].includes(status(i)),
    ).length;
    const failed = items.filter((i) => status(i) === "failed");
    return (
      <div className="batch-import">
        <div className="batch-summary" role="status">
          <h3>
            {pending
              ? "正在批量导入"
              : failed.length
                ? "部分技能未完成"
                : "批量导入完成"}
          </h3>
          <p>
            已添加 {completed} / {items.length} 项
            {failed.length ? ` · 失败 ${failed.length} 项` : ""}
            {pending
              ? ` · 等待或执行中 ${items.length - completed - failed.length} 项`
              : ""}
          </p>
          <small>
            关闭窗口后仍会继续安装，成功的技能会自动进入“我的 Skill”。
          </small>
        </div>
        <div className="batch-results">
          {items.map((i) => (
            <div className="batch-result" key={i.path}>
              {["installed", "succeeded"].includes(status(i)) ? (
                <CheckCircle2 size={18} />
              ) : status(i) === "failed" ? (
                <AlertCircle size={18} />
              ) : (
                <LoaderCircle size={18} className="spin" />
              )}
              <div>
                <strong>
                  {names[i.path]?.trim() || titles[i.path] || i.name}
                </strong>
                <small>{i.path}</small>
                <p>{i.job?.message || i.message}</p>
              </div>
            </div>
          ))}
        </div>
        {!!failed.length && (
          <button
            className="primary"
            disabled={submitting || pending}
            onClick={() =>
              void submit(
                failed.map((i) => i.path),
                true,
              )
            }
          >
            {submitting ? "正在重试…" : `仅重试失败的 ${failed.length} 项`}
          </button>
        )}
        {!pending && (
          <button
            className="secondary"
            disabled={submitting}
            onClick={() => {
              setItems(null);
              setSelected(new Set());
              setError("");
            }}
          >
            返回技能选择
          </button>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="batch-import">
      <fieldset className="batch-controls" disabled={submitting}>
        <div className="catalog-count">
          找到 {catalog.skills.length} 个可添加的技能，可一次导入多个
        </div>
        <label>
          添加到哪台电脑
          <select
            aria-label="选择安装设备"
            value={device}
            onChange={(e) => {
              setDevice(e.target.value);
              const alreadyInstalled = state.installedSkills
                .filter(
                  (s: any) =>
                    s.device_id === e.target.value &&
                    s.full_name === repo.fullName,
                )
                .map((s: any) => s.skill_path);
              setSelected((old) =>
                mergeBatchSelection(old, [], alreadyInstalled),
              );
              setError("");
            }}
          >
            <option value="">请选择本地连接器</option>
            {devices.map((d: any) => (
              <option key={d.id} value={d.id}>
                {d.name}（最近同步 {datetime(d.last_seen)}）
              </option>
            ))}
          </select>
        </label>
        {!devices.length && (
          <p className="hint">请先到“设置与连接”配对你的电脑。</p>
        )}
        <div className="batch-selection-tools">
          <button
            className="secondary small"
            disabled={!eligible.length || eligible.length > 300}
            onClick={() =>
              setSelected(new Set(eligible.map((s: any) => s.path)))
            }
          >
            全选全部 {eligible.length} 项
          </button>
          <button
            className="secondary small"
            disabled={loading}
            onClick={() =>
              setSelected((old) =>
                mergeBatchSelection(
                  old,
                  page.items.map((s: any) => s.path),
                  installed,
                ),
              )
            }
          >
            选择本页
          </button>
          <button
            className="secondary small"
            onClick={() => setSelected(new Set())}
          >
            清空选择
          </button>
          <span>已选 {chosen.length} 项</span>
        </div>
        <p className="hint">
          “全选全部”包含整个仓库，跨页生效；搜索和翻页会保留已勾选项。已添加的{" "}
          {installed.size} 项会跳过。
          {eligible.length > 300 && "一次最多导入300项，请分批勾选。"}
        </p>
        <label>
          搜索技能
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
            placeholder="输入中文用途、名称或路径"
          />
        </label>
        {loading ? (
          <div className="install-loading">
            <LoaderCircle size={18} className="spin" />
            正在读取中文用途…
          </div>
        ) : (
          <div className="catalog-list">
            {page.items.map((s: any, index: number) => (
              <div
                key={s.path}
                className={
                  "catalog-option batch-option " +
                  (selected.has(s.path) ? "selected" : "")
                }
              >
                <input
                  id={"batch-skill-" + index}
                  aria-label={"选择技能：" + s.path}
                  type="checkbox"
                  disabled={installed.has(s.path)}
                  checked={selected.has(s.path) && !installed.has(s.path)}
                  onChange={() => toggle(s.path)}
                />
                <div>
                  <label htmlFor={"batch-skill-" + index}>
                    <strong>
                      {s.guide?.titleZh || "中文用途待生成"}
                      {installed.has(s.path) ? "（已添加）" : ""}
                    </strong>
                  </label>
                  <p>
                    {s.guide?.summaryZh || "暂时无法读取这项技能的中文用途。"}
                  </p>
                  <small>{s.path}</small>
                  {!installed.has(s.path) && (
                    <label className="batch-custom-name">
                      自定义调用名（选填）
                      <input
                        aria-label={"自定义调用名称：" + s.path}
                        disabled={!selected.has(s.path)}
                        value={names[s.path] || ""}
                        maxLength={64}
                        placeholder="留空使用原名称"
                        onChange={(e) =>
                          setNames((old) => ({
                            ...old,
                            [s.path]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  )}
                  {selected.has(s.path) && nameError(names[s.path] || "") && (
                    <p className="form-error" role="alert">
                      {nameError(names[s.path] || "")}
                    </p>
                  )}
                </div>
              </div>
            ))}
            {!page.items.length && (
              <p className="hint">没有匹配的技能，请尝试其他关键词。</p>
            )}
          </div>
        )}
        <div className="catalog-pagination">
          <button
            className="secondary small"
            disabled={!offset || loading}
            onClick={() => setOffset(Math.max(0, offset - 8))}
          >
            上一页
          </button>
          <span>
            第 {Math.floor(offset / 8) + 1} 页 · 匹配 {page.total} 项
          </span>
          <button
            className="secondary small"
            disabled={!page.hasMore || loading}
            onClick={() => setOffset(offset + 8)}
          >
            下一页
          </button>
        </div>
        <p className="hint">
          每项保留独立的调用名。导入使用固定版本，遇到同名文件或本地修改会保留原文件并提示结果。
        </p>
        <button
          className="primary"
          disabled={
            !chosen.length ||
            !devices.some((d: any) => d.id === device) ||
            submitting ||
            invalidNames ||
            loading
          }
          onClick={() => void submit(chosen.map((s: any) => s.path))}
        >
          <Download size={15} />
          {submitting ? "正在提交…" : `导入选中的 ${chosen.length} 个技能`}
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </fieldset>
    </div>
  );
}
