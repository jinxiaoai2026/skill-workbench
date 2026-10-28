import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  LayoutDashboard,
  Layers,
  ChartNoAxesCombined,
  Flame,
  Compass,
  Settings,
  Plus,
  Search,
  ArrowUpRight,
  ArrowRight,
  RefreshCw,
  CalendarDays,
  Download,
  Link2,
  Check,
  Star,
  ChevronRight,
  X,
  Code2,
  Monitor,
  ShieldCheck,
  LogOut,
  Copy,
  Clock,
  Terminal,
  BookOpen,
  ExternalLink,
  Filter,
  WifiOff,
  Sparkles,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { api, number, datetime } from "./api";
import { CloudChineseSettings } from "./cloud-chinese";
import { skillOwnershipLabels } from "../src/core/library";
import {
  SKILL_CATEGORIES,
  inferSkillCategory,
  groupSkillsByCategory,
} from "../src/core/skill-categories";
import { validateCustomName } from "../src/core/skill-names";
import {
  InstallButton,
  InstallPanel,
  SkillAliasEditor,
  chineseSummary,
} from "./install";
import type { Service } from "../src/server/service";
type State = Awaited<ReturnType<Service["state"]>> & { demo?: boolean };
type Page =
  "overview" | "skills" | "usage" | "trending" | "opportunities" | "settings";
const navigation = [
  ["overview", "工作台", LayoutDashboard],
  ["skills", "我的 Skill", Layers],
  ["usage", "调用统计", ChartNoAxesCombined],
  ["trending", "GitHub 热榜", Flame],
  ["opportunities", "电商机会", Compass],
  ["settings", "设置与连接", Settings],
] as const;
const platformOptions = ["淘宝/天猫", "京东", "拼多多", "抖音", "小红书"];
const categories = [
  "未分类",
  "选品研究",
  "内容制作",
  "广告投放",
  "客服售后",
  "经营分析",
  "效率工具",
];
const statusText: Record<string, string> = {
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果未知",
  partial: "部分成功",
};
function Empty({
  icon: Icon = FolderOpen,
  title,
  children,
  action,
}: {
  icon?: any;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={26} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Tag({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={"tag " + tone}>{children}</span>;
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="login-brand">
        <Code2 size={26} /> 技能工作台
      </div>
      <div className="login-card">
        <div className="eyebrow">你的个人创作空间</div>
        <h1>
          让每一次创造，
          <br />
          都有迹可循。
        </h1>
        <p>
          管理自己的 Skill，了解使用情况，
          <br />
          发现与你的电商业务相关的开源项目。
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("/login", "POST", { username, password });
              onLogin();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="username">管理员账户</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            required
            maxLength={100}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="输入管理员账户"
          />
          <label htmlFor="password">工作台密码</label>
          <input
            id="password"
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入你的管理员密码"
          />
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "正在登录…" : "进入工作台"}
            <ArrowRight size={17} />
          </button>
        </form>
        <small>
          <ShieldCheck size={14} /> 私人空间 · 仅本人可访问
        </small>
      </div>
      <div className="login-foot">个人技能 · 开源发现 · 日常创造</div>
    </main>
  );
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [page, setPage] = useState<Page>(
      (location.hash.slice(1) || "overview") as Page,
    ),
    [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [search, setSearch] = useState(""),
    [range, setRange] = useState("7d"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [month, setMonth] = useState(
      new Date()
        .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
        .slice(0, 7),
    ),
    [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [versions, setVersions] = useState<any[]>([]),
    [pairing, setPairing] = useState<any>(null),
    [installTarget, setInstallTarget] = useState<any>(null);
  const [usageFilters, setUsageFilters] = useState({
    skillId: "",
    deviceId: "",
    platform: "",
    category: "",
  });
  const request = useRef(0);
  const query = new URLSearchParams({
    range,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(month ? { month } : {}),
    ...(page === "usage" ? usageFilters : {}),
  }).toString();
  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 5000);
  };
  const refresh = useCallback(async () => {
    if (!authenticated) return;
    if (range === "custom" && (!from || !to)) return;
    const id = ++request.current;
    setLoading(true);
    try {
      const data = await api<State>("/state?" + query);
      if (id === request.current) {
        setState(data);
        setError("");
      }
    } catch (e) {
      if (id === request.current) {
        if ((e as any).status === 401) {
          setAuthenticated(false);
          setState(null);
        } else setError((e as Error).message);
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [authenticated, query, range, from, to]);
  useEffect(() => {
    api("/session")
      .then((s) => setAuthenticated(s.authenticated))
      .catch((e) => {
        setError(e.message);
        setAuthenticated(false);
      });
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const change = () => {
      const p = location.hash.slice(1);
      if (navigation.some((n) => n[0] === p)) setPage(p as Page);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const go = (p: Page) => {
    setPage(p);
    location.hash = p;
    setSearch("");
  };
  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      notify(message);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveBookmark = (repo: any) =>
    act(
      () =>
        api("/bookmarks", "POST", {
          fullName: repo.fullName,
          repoId: repo.repoId,
          description: repo.description,
          language: repo.language,
          url: repo.url,
        }),
      "已加入观察收藏",
    );
  if (authenticated === null)
    return (
      <div className="initial-loading">
        <Code2 />
        <span>正在打开个人工作台…</span>
      </div>
    );
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;
  const activeDevice = state?.devices.find(
    (d) =>
      !d.revoked && d.last_seen && Date.now() - Date.parse(d.last_seen) < 60000,
  );
  const title = navigation.find((n) => n[0] === page)?.[1] || "工作台";
  const match = (...text: any[]) =>
    text.join(" ").toLowerCase().includes(search.toLowerCase());
  const ownSkills = state?.skills.filter((s) => !s.archived) || [];
  const detailSkill = state?.skills.find((s) => s.id === detail?.id) || detail;
  const detailInstallation =
    detailSkill &&
    state?.installedSkills.find(
      (s) =>
        s.device_id === detailSkill.deviceId &&
        s.full_name === detailSkill.sourceRepo &&
        s.skill_path === detailSkill.sourcePath,
    );
  const newSkill = () =>
    setEditing({
      name: "",
      description: "",
      ownership: "original",
      category: "未分类",
      platforms: [],
      tags: [],
      createdDate: "",
      upstream: "",
    });
  const exportUrl = "/api/export?" + query;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => go("overview")}>
          <span className="brand-mark">
            <Code2 size={22} />
          </span>
          <div>
            Skill 工作台<small>个人专属空间</small>
          </div>
        </a>
        <div className="space-label">
          <span className="avatar">{state?.demo ? "演" : "我"}</span>
          <div>
            {state?.demo ? "只读演示空间" : "个人创作空间"}
            <small>
              {state?.demo
                ? "虚构数据 · 不连接真实设备"
                : "独立创作 · 持续生长"}
            </small>
          </div>
          <ChevronRight size={15} />
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          {navigation.map(([id, label, Icon]) => (
            <button
              key={id}
              className={"nav-item " + (page === id ? "active" : "")}
              onClick={() => go(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "skills" && (
                <span className="nav-count">{ownSkills.length}</span>
              )}
              {id === "trending" && <span className="new-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-card">
            <span className={"status-dot " + (activeDevice ? "online" : "")} />
            <strong>{activeDevice ? "Codex 已连接" : "连接你的 Codex"}</strong>
            <p>
              {activeDevice
                ? "个人 Skill 与调用记录同步中"
                : "配对本地连接器，记录 Skill 使用情况"}
            </p>
            <button onClick={() => go("settings")}>
              {activeDevice ? "管理连接" : "开始连接"}
              <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="sidebar-footer">
            <span>
              技能工作台 <b>v0.1</b>
            </span>
            <button
              className="icon-button"
              aria-label="退出登录"
              onClick={() =>
                act(async () => {
                  await api("/logout", "POST");
                  setAuthenticated(false);
                }, "已退出")
              }
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            个人空间 <ChevronRight size={13} />
            <span>{title}</span>
          </div>
          <div className="topbar-actions">
            <label className="search">
              <Search size={16} />
              <input
                aria-label="搜索当前页面"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索 Skill 或开源项目"
              />
              <kbd>⌕</kbd>
            </label>
            <button
              className="icon-button"
              onClick={() => void refresh()}
              title="刷新数据"
              aria-label="刷新数据"
            >
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>
            <span className="top-avatar">我</span>
          </div>
        </header>
        <main>
          {state?.demo && (
            <div className="demo-banner" role="note">
              隔离演示 · 技能、设备、调用与榜单均为虚构示例，非实时 GitHub 数据
            </div>
          )}
          <div className="page-intro">
            <div>
              <div className="eyebrow">
                {page === "overview"
                  ? "我的创作总览"
                  : page === "trending"
                    ? "开源项目雷达"
                    : page === "skills"
                      ? "我的技能库"
                      : page === "usage"
                        ? "每次使用都有记录"
                        : page === "opportunities"
                          ? "为我的电商业务服务"
                          : "连接与管理"}
              </div>
              <h1>
                {page === "overview" ? "每一份创造，都值得积累。" : title}
              </h1>
              <p>
                {page === "overview"
                  ? "把你的 Skill、使用记录和开源灵感，放在一个地方。"
                  : page === "skills"
                    ? "自动收录你制作的 Skill 和从 GitHub 导入的 Skill，在这里统一整理与使用。"
                    : page === "usage"
                      ? "按时间查看使用情况，确认调用与推断线索分别呈现。"
                      : page === "trending"
                        ? "持续记录开源世界的变化，发现值得花时间了解的项目。"
                        : page === "opportunities"
                          ? "从开源工具到实际业务，找到下一件可以省下时间的事。"
                          : "管理本地连接器、数据采集和你的私人空间。"}
              </p>
            </div>
            {page === "skills" || page === "overview" ? (
              <button className="primary" onClick={newSkill}>
                <Plus size={17} />
                新增 Skill
              </button>
            ) : page === "trending" ? (
              <button
                className="secondary"
                onClick={() =>
                  act(() => api("/collect", "POST"), "采集已启动，稍后自动更新")
                }
              >
                <RefreshCw size={16} />
                采集最新榜单
              </button>
            ) : null}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={17} />
              {error}
              <button onClick={() => setError("")} aria-label="关闭错误">
                <X size={16} />
              </button>
            </div>
          )}
          {page !== "settings" && (
            <div className="datebar">
              <div className="datebar-left">
                <CalendarDays size={16} />
                <span>统计周期</span>
                <div className="segmented">
                  {[
                    ["today", "今天"],
                    ["7d", "最近 7 天"],
                    ["30d", "最近 30 天"],
                    ["month", "本月"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={range === id ? "selected" : ""}
                      onClick={() => setRange(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <select
                  aria-label="其他日期范围"
                  value={
                    ["today", "7d", "30d", "month"].includes(range) ? "" : range
                  }
                  onChange={(e) => {
                    if (e.target.value) {
                      if (e.target.value === "custom") {
                        if (!from)
                          setFrom(
                            state?.range.from ||
                              new Date().toLocaleDateString("sv-SE", {
                                timeZone: "Asia/Shanghai",
                              }),
                          );
                        if (!to)
                          setTo(
                            state?.range.to ||
                              new Date().toLocaleDateString("sv-SE", {
                                timeZone: "Asia/Shanghai",
                              }),
                          );
                      }
                      setRange(e.target.value);
                    }
                  }}
                >
                  <option value="" disabled>
                    更多日期
                  </option>
                  <option value="yesterday">昨天</option>
                  <option value="previousMonth">上月</option>
                  <option value="calendar">指定月份</option>
                  <option value="custom">自定义日期</option>
                </select>
                {range === "custom" && (
                  <div className="custom-dates">
                    <input
                      aria-label="开始日期"
                      type="date"
                      value={from}
                      onInput={(e) => setFrom(e.currentTarget.value)}
                      onBlur={(e) => setFrom(e.currentTarget.value)}
                    />
                    <span>至</span>
                    <input
                      aria-label="结束日期"
                      type="date"
                      value={to}
                      onInput={(e) => setTo(e.currentTarget.value)}
                      onBlur={(e) => setTo(e.currentTarget.value)}
                    />
                  </div>
                )}
                {range === "calendar" && (
                  <input
                    aria-label="指定月份"
                    type="month"
                    value={month}
                    onInput={(e) => setMonth(e.currentTarget.value)}
                  />
                )}
              </div>
              <span className="range-label">
                {state?.range.from} — {state?.range.to}
                <span className="timezone">北京时间</span>
              </span>
            </div>
          )}
          {!state ? (
            <div className="panel">
              <Empty title="正在读取你的数据" icon={RefreshCw}>
                首次加载需要一点时间。
              </Empty>
            </div>
          ) : (
            <>
              {page === "overview" && (
                <>
                  <div className="metrics">
                    <Metric
                      title="我的 Skill"
                      value={ownSkills.length}
                      icon={Layers}
                      foot="自制与 GitHub 导入自动同步"
                    />
                    <Metric
                      title="期间确认调用"
                      value={state.usage.confirmed}
                      icon={Terminal}
                      foot={`${state.usage.inferred} 条推断线索，单独记录`}
                    />
                    <Metric
                      title="活跃 Skill"
                      value={state.usage.activeSkills}
                      icon={ChartNoAxesCombined}
                      foot="所选期间至少确认调用一次"
                    />
                    <Metric
                      title="开源发现"
                      value={state.trending.ranked.length}
                      icon={Compass}
                      foot={`已覆盖 ${state.trending.coveredDays} / ${state.trending.requestedDays} 天的榜单`}
                    />
                  </div>
                  <div className="overview-grid">
                    <section className="panel">
                      <PanelTitle
                        title="Skill 使用趋势"
                        subtitle="确认调用 · 按日统计"
                        action={
                          <button
                            className="text-button"
                            onClick={() => go("usage")}
                          >
                            查看统计
                            <ArrowUpRight size={14} />
                          </button>
                        }
                      />
                      <UsageChart days={state.usage.days} />
                      <div className="chart-note">
                        <span className="legend-dot" />
                        确认调用{" "}
                        <span className="muted">
                          {state.usage.confirmed
                            ? "每一次执行，都在这里积累。"
                            : "连接并使用个人 Skill 后，趋势会从这里开始。"}
                        </span>
                      </div>
                    </section>
                    <section className="panel personal-panel">
                      <PanelTitle
                        title="我的 Skill"
                        subtitle="你的经验，逐渐成为资产"
                        action={
                          <button
                            className="icon-button"
                            onClick={() => go("skills")}
                            aria-label="查看我的 Skill"
                          >
                            <ArrowUpRight size={17} />
                          </button>
                        }
                      />
                      {ownSkills.length ? (
                        <div className="mini-skills">
                          {ownSkills.slice(0, 4).map((s) => (
                            <button
                              key={s.id}
                              onClick={() => {
                                setDetail(s);
                                api("/skills/" + s.id + "/versions").then(
                                  setVersions,
                                );
                              }}
                            >
                              <span className="skill-icon">
                                <Code2 size={20} />
                              </span>
                              <div>
                                <strong>{s.name}</strong>
                                <small>
                                  {s.category} · {s.stats.period} 次确认调用
                                </small>
                              </div>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Empty
                          title="你的第一个 Skill，值得被记录"
                          icon={Code2}
                          action={
                            <button
                              className="secondary small"
                              onClick={newSkill}
                            >
                              <Plus size={15} />
                              登记个人 Skill
                            </button>
                          }
                        >
                          记录你创作的工作流程，
                          <br />
                          让每一次复用都有迹可循。
                        </Empty>
                      )}
                    </section>
                  </div>
                  <section className="panel discovery">
                    <PanelTitle
                      title="与你相关的开源发现"
                      subtitle="面向国内电商 · 内容、客服、选品与经营分析"
                      action={
                        <button
                          className="text-button"
                          onClick={() => go("opportunities")}
                        >
                          探索全部
                          <ArrowUpRight size={14} />
                        </button>
                      }
                    />
                    <div className="recommendations">
                      {state.trending.ranked
                        .filter((r) => r.relevance.score > 0)
                        .slice(0, 3)
                        .map((r) => (
                          <Opportunity
                            key={r.repoId || r.fullName}
                            repo={r}
                            saved={state.bookmarks.some(
                              (b) => b.fullName === r.fullName,
                            )}
                            onSave={() => void saveBookmark(r)}
                            state={state}
                            onInstall={setInstallTarget}
                          />
                        ))}
                      {!state.trending.ranked.some(
                        (r) => r.relevance.score > 0,
                      ) && (
                        <Empty title="让开源灵感慢慢积累" icon={Compass}>
                          完成首次榜单采集后，这里会显示与电商业务相关的项目。
                        </Empty>
                      )}
                    </div>
                  </section>
                  <div className="bottom-note">
                    <ShieldCheck size={14} />
                    个人 Skill 与系统技能分开管理
                    <span>
                      最后采集：{datetime(state.trending.lastCollectedAt)}
                    </span>
                  </div>
                </>
              )}
              {page === "skills" && (
                <Skills
                  state={state}
                  match={match}
                  onNew={newSkill}
                  onEdit={setEditing}
                  onDetail={(s) => {
                    setDetail(s);
                    setVersions([]);
                    api("/skills/" + s.id + "/versions")
                      .then(setVersions)
                      .catch((e) => setError(e.message));
                  }}
                  exportUrl={exportUrl}
                  act={act}
                />
              )}
              {page === "usage" && (
                <Usage
                  state={state}
                  exportUrl={exportUrl}
                  match={match}
                  filters={usageFilters}
                  setFilters={setUsageFilters}
                />
              )}
              {page === "trending" && (
                <Trending
                  state={state}
                  match={match}
                  onSave={saveBookmark}
                  onInstall={setInstallTarget}
                />
              )}
              {page === "opportunities" && (
                <Opportunities
                  state={state}
                  match={match}
                  onSave={saveBookmark}
                  onInstall={setInstallTarget}
                  onRemove={(id) =>
                    act(
                      () =>
                        api("/bookmarks/" + encodeURIComponent(id), "DELETE"),
                      "已移出收藏",
                    )
                  }
                />
              )}
              {page === "settings" && (
                <SettingsPage
                  state={state}
                  onChanged={refresh}
                  act={act}
                  pairing={pairing}
                  setPairing={setPairing}
                  notify={notify}
                />
              )}
            </>
          )}
        </main>
        <footer className="main-footer">
          <span>为持续创造的人而造。</span>
          <span>技能工作台 · 数据属于你</span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {installTarget && state && (
        <Modal title="添加技能到 Codex" onClose={() => setInstallTarget(null)}>
          <InstallPanel
            repo={
              state.trending.ranked.find(
                (r) => r.fullName === installTarget.fullName,
              ) || installTarget
            }
            state={state}
            onClose={() => setInstallTarget(null)}
            onChanged={refresh}
          />
        </Modal>
      )}
      {editing && (
        <SkillEditor
          skill={editing}
          onChanged={refresh}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            const saved = await api(
              "/skills" + (editing.id ? "/" + editing.id : ""),
              editing.id ? "PATCH" : "POST",
              data,
            );
            await refresh();
            if (!saved.launchNameJob) {
              setEditing(null);
              notify("Skill 已保存");
            }
            return saved;
          }}
        />
      )}
      {detail && (
        <Modal title={detailSkill.name} onClose={() => setDetail(null)}>
          <div className="detail-meta">
            <Tag tone="green">
              {skillOwnershipLabels[detailSkill.ownership] || "本地技能"}
            </Tag>
            <Tag>{detailSkill.category}</Tag>
          </div>
          <p className="detail-description">
            {detailSkill.description || "尚未填写用途说明"}
          </p>
          <div className="detail-stats">
            <div>
              <strong>{detailSkill.stats.total}</strong>
              <small>累计确认调用</small>
            </div>
            <div>
              <strong>{detailSkill.stats.period}</strong>
              <small>所选期间确认调用</small>
            </div>
            <div>
              <strong>{detailSkill.stats.inferred}</strong>
              <small>期间推断线索</small>
            </div>
          </div>
          <label>Skill ID</label>
          <div className="code-line">
            <code>{detailSkill.id}</code>
            <button
              className="icon-button"
              onClick={() => {
                void navigator.clipboard.writeText(detailSkill.id);
                notify("已复制 Skill ID");
              }}
              aria-label="复制 Skill ID"
            >
              <Copy size={15} />
            </button>
          </div>
          <label>Codex 调用提示</label>
          <div className="code-line">
            <code>
              请使用 ${detailSkill.codexName || detailSkill.name} 完成任务。
            </code>
            <button
              className="icon-button"
              aria-label="复制调用提示"
              onClick={() => {
                void navigator.clipboard.writeText(
                  "请使用 $" +
                    (detailSkill.codexName || detailSkill.name) +
                    " 完成任务。",
                );
                notify("已复制调用提示");
              }}
            >
              <Copy size={15} />
            </button>
          </div>
          {detailSkill.upstream && (
            <p className="hint">
              来源：
              <a href={detailSkill.upstream} target="_blank" rel="noreferrer">
                {detailSkill.sourceRepo || "查看原始项目"}
                <ExternalLink size={12} />
              </a>
            </p>
          )}
          {detailInstallation && (
            <SkillAliasEditor
              installed={detailInstallation}
              state={state}
              onChanged={refresh}
            />
          )}
          <p className="hint">
            在 Codex 输入
            $启动名称可自动记录一次明确唤起，同一轮同一技能只计一次。唤起次数不代表任务成功；普通名称提及不计数。
          </p>
          <h3>版本记录</h3>
          {versions.length ? (
            versions.map((v) => (
              <div className="version-row" key={v.version}>
                <code>{v.version}</code>
                <span>{datetime(v.created_at)}</span>
              </div>
            ))
          ) : (
            <p className="muted">连接器同步后显示实际文件版本。</p>
          )}
          {detailSkill.content && (
            <>
              <h3>同步的 SKILL.md</h3>
              <pre className="skill-content">{detailSkill.content}</pre>
            </>
          )}
          <div className="modal-actions">
            <button
              className="secondary"
              onClick={() => {
                setEditing(detailSkill);
                setDetail(null);
              }}
            >
              编辑记录
            </button>
            <button className="primary" onClick={() => setDetail(null)}>
              完成
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function Metric({
  title,
  value,
  icon: Icon,
  foot,
}: {
  title: string;
  value: number;
  icon: any;
  foot: string;
}) {
  return (
    <div className="metric">
      <div className="metric-heading">
        <span>{title}</span>
        <Icon size={18} />
      </div>
      <strong>{number(value)}</strong>
      <small>{foot}</small>
    </div>
  );
}
function PanelTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-title">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
function UsageChart({
  days,
}: {
  days: { date: string; confirmed: number; inferred: number }[];
}) {
  const max = Math.max(4, ...days.map((d) => d.confirmed));
  return (
    <div className="chart">
      <div className="chart-y">
        {[max, Math.round(max / 2), 0].map((n, i) => (
          <span key={i}>{n}</span>
        ))}
      </div>
      <div className="chart-plot">
        <div className="chart-grid">
          <i />
          <i />
          <i />
        </div>
        <div className="chart-bars">
          {days.map((d, i) => (
            <div
              className="chart-column"
              key={d.date}
              title={`${d.date}：确认 ${d.confirmed} 次，推断 ${d.inferred} 条`}
            >
              <div className="chart-bar-space">
                <div
                  className={"chart-bar " + (d.confirmed ? "" : "zero")}
                  style={{
                    height: Math.max(2, (d.confirmed / max) * 100) + "%",
                  }}
                />
              </div>
              <span>
                {days.length <= 10 || i % Math.ceil(days.length / 7) === 0
                  ? d.date.slice(5).replace("-", "/")
                  : " "}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
function SkillEditor({
  skill,
  onClose,
  onSave,
  onChanged,
}: {
  skill: any;
  onClose: () => void;
  onSave: (s: any) => Promise<any>;
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState({
      ...skill,
      categoryMode:
        skill.categoryMode ||
        (skill.category && skill.category !== "未分类" ? "manual" : "auto"),
    }),
    [tagInput, setTagInput] = useState((skill.tags || []).join(",")),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [launchName, setLaunchName] = useState(
      skill.codexName || skill.sourceName || skill.name || "",
    ),
    [nameJob, setNameJob] = useState<any>(null);
  const linked = !!(skill.id && skill.deviceId && skill.version);
  const pending = nameJob && ["queued", "running"].includes(nameJob.status);
  const completed = nameJob?.status === "succeeded";
  let launchError = "";
  if (
    linked &&
    launchName.trim() !== (skill.codexName || skill.name) &&
    launchName.trim() !== skill.sourceName
  ) {
    try {
      validateCustomName(launchName);
    } catch (e) {
      launchError = (e as Error).message;
    }
  }
  useEffect(() => {
    if (!nameJob?.id || !pending) return;
    let active = true,
      polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const status = await api(
          "/skill-name-jobs/" + encodeURIComponent(nameJob.id),
        );
        if (!active) return;
        setNameJob(status);
        if (["succeeded", "failed"].includes(status.status)) await onChanged();
      } catch {
        if (active) setError("暂时无法查询同步状态，连接恢复后会继续更新。");
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [nameJob?.id, pending, onChanged]);
  const set = (k: string, v: any) => setForm({ ...form, [k]: v });
  return (
    <Modal title={skill.id ? "编辑 Skill" : "登记 Skill"} onClose={onClose}>
      <form
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (pending || completed || launchError) return;
          setBusy(true);
          setError("");
          try {
            const saved = await onSave({
              name: form.name,
              description: form.description,
              ownership: form.ownership,
              category: form.category,
              categoryMode: form.categoryMode,
              platforms: form.platforms,
              upstream: form.upstream,
              createdDate: form.createdDate,
              ...(linked ? { launchName: launchName.trim() } : {}),
              tags: tagInput
                .split(/[,，]/)
                .map((s: string) => s.trim())
                .filter(Boolean),
            });
            if (saved.launchNameJob) setNameJob(saved.launchNameJob);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset
          className="skill-editor-fields"
          disabled={busy || !!pending || completed}
        >
          <label>
            显示名称
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="例如：商品卖点提炼"
            />
          </label>
          <label>
            启动名称（Codex）
            <input
              aria-label="启动名称（Codex）"
              value={launchName}
              maxLength={100}
              disabled={!linked}
              required={linked}
              onChange={(e) => setLaunchName(e.target.value)}
              placeholder="例如：详情页设计"
            />
          </label>
          <p className="hint">
            {linked ? (
              <>
                同步成功后，在下一轮 Codex 对话输入{" "}
                <code>使用 ${launchName.trim() || "启动名称"}</code>{" "}
                即可调用。原始启动名：{skill.sourceName || skill.codexName}。
              </>
            ) : (
              "此记录尚未关联本机文件，连接器同步后即可修改启动名称。"
            )}
          </p>
          {launchError && (
            <p className="form-error" role="alert">
              {launchError}
            </p>
          )}
          <label>
            用途说明
            <textarea
              rows={3}
              maxLength={4000}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="解决什么问题，在什么情况下使用？"
            />
          </label>
          <div className="form-grid">
            <label>
              来源与归属
              <select
                value={form.ownership}
                onChange={(e) => set("ownership", e.target.value)}
              >
                <option value="original">本人原创</option>
                <option value="derived">本人二次创作</option>
                <option value="imported">GitHub 导入</option>
                <option value="local">本地新增（来源待确认）</option>
              </select>
            </label>
            <label>
              技能分类
              <select
                aria-label="技能分类"
                value={form.categoryMode === "auto" ? "__auto" : form.category}
                onChange={(e) =>
                  setForm({
                    ...form,
                    categoryMode:
                      e.target.value === "__auto" ? "auto" : "manual",
                    category:
                      e.target.value === "__auto"
                        ? inferSkillCategory(form)
                        : e.target.value,
                  })
                }
              >
                <option value="__auto">
                  自动判断（{inferSkillCategory(form)}）
                </option>
                {[
                  ...new Set(
                    [...SKILL_CATEGORIES, form.category].filter(
                      (c) => c && c !== "未分类",
                    ),
                  ),
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <label>适用平台</label>
          <div className="platform-choices">
            {platformOptions.map((p) => (
              <button
                type="button"
                key={p}
                className={form.platforms?.includes(p) ? "chosen" : ""}
                onClick={() =>
                  set(
                    "platforms",
                    form.platforms?.includes(p)
                      ? form.platforms.filter((x: string) => x !== p)
                      : [...(form.platforms || []), p],
                  )
                }
              >
                {form.platforms?.includes(p) && <Check size={13} />} {p}
              </button>
            ))}
          </div>
          <div className="form-grid">
            <label>
              创作日期（可留空）
              <input
                type="date"
                value={form.createdDate || ""}
                onChange={(e) => set("createdDate", e.target.value)}
              />
            </label>
            <label>
              标签（逗号分隔）
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="文案, 工作流"
              />
            </label>
          </div>
          {["derived", "imported", "local"].includes(form.ownership) && (
            <label>
              原始项目来源
              <input
                type="url"
                value={form.upstream || ""}
                onChange={(e) => set("upstream", e.target.value)}
                placeholder="https://github.com/..."
              />
            </label>
          )}
          <p className="hint">
            分类默认按用途自动判断，也可手动选择。显示名称用于整理，启动名称会同步到本机
            Codex。
          </p>
        </fieldset>
        {nameJob && (
          <div
            className={
              "installation-progress " +
              (nameJob.status === "failed" ? "failed" : "")
            }
            role="status"
          >
            {completed ? (
              <CheckCircle2 size={22} />
            ) : nameJob.status === "failed" ? (
              <AlertCircle size={22} />
            ) : (
              <RefreshCw className="spin" size={22} />
            )}
            <div>
              <h3>
                {completed
                  ? "启动名称已同步"
                  : nameJob.status === "failed"
                    ? "启动名称未修改"
                    : "正在同步启动名称"}
              </h3>
              <p>{nameJob.message}</p>
              <small>
                {completed ? (
                  <>
                    现在可使用 <code>${nameJob.launchName}</code> 调用。
                  </>
                ) : nameJob.status === "failed" ? (
                  "原启动名称保持可用，可调整后重新保存。"
                ) : (
                  "请保持本机连接器运行。关闭窗口后仍会继续同步。"
                )}
              </small>
            </div>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {nameJob ? "关闭" : "取消"}
          </button>
          {completed ? (
            <button type="button" className="primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !!pending || !!launchError}
            >
              {busy
                ? "保存中…"
                : pending
                  ? "等待本机同步…"
                  : nameJob?.status === "failed"
                    ? "重新保存并同步"
                    : "保存 Skill"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
function Skills({
  state,
  match,
  onNew,
  onEdit,
  onDetail,
  exportUrl,
  act,
}: {
  state: State;
  match: (...s: any[]) => boolean;
  onNew: () => void;
  onEdit: (s: any) => void;
  onDetail: (s: any) => void;
  exportUrl: string;
  act: any;
}) {
  const [showArchived, setShowArchived] = useState(false),
    [category, setCategory] = useState("全部分类"),
    [source, setSource] = useState("all");
  const rows = state.skills.filter(
    (s) =>
      !!s.archived === showArchived &&
      match(s.name, s.description, s.codexName, s.sourceRepo, ...s.tags) &&
      (category === "全部分类" || s.category === category) &&
      (source === "all" ||
        (source === "mine" && ["original", "derived"].includes(s.ownership)) ||
        (source === "github" && (s.sourceRepo || s.ownership === "imported")) ||
        (source === "local" && s.ownership === "local")),
  );
  return (
    <>
      <div className="info-note">
        <RefreshCw size={17} />
        <p>
          连接器在线时，每 15 秒自动检查本机技能目录。新建与 GitHub
          导入会进入此处，并按用途自动分类。你也可以在编辑中调整分类和启动名称。
        </p>
      </div>
      <div className="section-toolbar">
        <div className="tabbar">
          <button
            className={!showArchived ? "selected" : ""}
            onClick={() => setShowArchived(false)}
          >
            全部 Skill <b>{state.skills.filter((s) => !s.archived).length}</b>
          </button>
          <button
            className={showArchived ? "selected" : ""}
            onClick={() => setShowArchived(true)}
          >
            已归档
          </button>
        </div>
        <div className="inline-actions">
          <select
            aria-label="筛选技能来源"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="all">全部来源</option>
            <option value="mine">我创作的</option>
            <option value="github">GitHub 导入</option>
            <option value="local">本地新增</option>
          </select>
          <select
            aria-label="筛选技能分类"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option>全部分类</option>
            {[
              ...new Set([
                ...SKILL_CATEGORIES,
                ...state.skills.map((s) => s.category),
              ]),
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <a className="secondary small" href={exportUrl + "&kind=skills"}>
            <Download size={15} />
            导出
          </a>
        </div>
      </div>
      {rows.length ? (
        <div className="skill-groups">
          {groupSkillsByCategory(rows).map((group) => (
            <section
              className="skill-category-group"
              key={group.category}
              aria-label={group.category + " Skill"}
            >
              <header className="skill-category-heading">
                <h2>{group.category}</h2>
                <span>{group.skills.length} 个 Skill</span>
              </header>
              <div className="skill-grid">
                {group.skills.map((s) => (
                  <article className="panel skill-card" key={s.id}>
                    <div className="skill-card-top">
                      <span className="skill-icon">
                        <Code2 size={23} />
                      </span>
                      <button
                        className={"icon-button " + (s.favorite ? "saved" : "")}
                        aria-label={
                          s.favorite ? "取消收藏 Skill" : "收藏 Skill"
                        }
                        onClick={() =>
                          act(
                            () =>
                              api("/skills/" + s.id, "PATCH", {
                                favorite: !s.favorite,
                              }),
                            "已更新收藏",
                          )
                        }
                      >
                        <Star
                          size={17}
                          fill={s.favorite ? "currentColor" : "none"}
                        />
                      </button>
                    </div>
                    <button className="skill-name" onClick={() => onDetail(s)}>
                      {s.name}
                      <ArrowUpRight size={16} />
                    </button>
                    <p>{s.description || "为这个 Skill 添加用途说明。"}</p>
                    <div className="tags">
                      <Tag tone="green">
                        {skillOwnershipLabels[s.ownership] || "本地技能"}
                      </Tag>
                      <Tag>{s.category}</Tag>
                      {s.platforms.slice(0, 2).map((p: string) => (
                        <Tag key={p}>{p}</Tag>
                      ))}
                    </div>
                    <p className="skill-call-name">
                      调用名：<code>${s.codexName || s.name}</code>
                      {s.sourceRepo && <span> · {s.sourceRepo}</span>}
                    </p>
                    <div className="skill-count">
                      <span>
                        <strong>{s.stats.period}</strong> 次期间调用
                      </span>
                      <span>累计 {s.stats.total} 次</span>
                    </div>
                    <div className="skill-card-foot">
                      <span>
                        <Clock size={12} />
                        {datetime(s.stats.last)}
                      </span>
                      <button onClick={() => onEdit(s)}>编辑</button>
                      <button
                        onClick={() =>
                          act(
                            () =>
                              api("/skills/" + s.id, "PATCH", {
                                archived: !s.archived,
                              }),
                            s.archived ? "已恢复" : "已归档",
                          )
                        }
                      >
                        {s.archived ? "恢复" : "归档"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            title={
              showArchived
                ? "暂无归档 Skill"
                : searchless(rows, state)
                  ? "还没有同步的 Skill"
                  : "没有符合条件的 Skill"
            }
            icon={Layers}
            action={
              !showArchived && (
                <button className="primary" onClick={onNew}>
                  <Plus size={16} />
                  登记第一个 Skill
                </button>
              )
            }
          >
            连接器在线后会自动收录本机用户技能目录中的新建和导入
            Skill，也可以先手动登记。
            <br />
            本地新增的来源可在编辑中整理；系统自带 Skill 会被排除。
          </Empty>
        </section>
      )}
    </>
  );
}
function searchless(_rows: any[], s: State) {
  return s.skills.length === 0;
}
function Usage({
  state,
  exportUrl,
  match,
  filters,
  setFilters,
}: {
  state: State;
  exportUrl: string;
  match: (...s: any[]) => boolean;
  filters: {
    skillId: string;
    deviceId: string;
    platform: string;
    category: string;
  };
  setFilters: (f: {
    skillId: string;
    deviceId: string;
    platform: string;
    category: string;
  }) => void;
}) {
  const [evidence, setEvidence] = useState("all");
  const rows = state.usage.events.filter(
    (e) =>
      match(e.name, e.device) &&
      (evidence === "all" || e.evidence === evidence),
  );
  return (
    <>
      <div className="metrics three">
        <Metric
          title="确认调用"
          value={state.usage.confirmed}
          icon={Terminal}
          foot="Codex 直接唤起或受管执行"
        />
        <Metric
          title="推断线索"
          value={state.usage.inferred}
          icon={BookOpen}
          foot="文件读取线索，不加入确认次数"
        />
        <Metric
          title="活跃 Skill"
          value={state.usage.activeSkills}
          icon={Layers}
          foot="所选日期内有确认调用"
        />
      </div>
      <section className="panel">
        <PanelTitle title="调用趋势" subtitle={state.usage.coverage} />
        <UsageChart days={state.usage.days} />
      </section>
      <section className="panel usage-table">
        <PanelTitle
          title="调用明细"
          subtitle="最多展示最近 200 条，可导出当前范围"
          action={
            <a className="secondary small" href={exportUrl + "&kind=usage"}>
              <Download size={14} />
              导出 CSV
            </a>
          }
        />
        <div className="table-filters">
          <select
            aria-label="筛选调用证据"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          >
            <option value="all">全部证据</option>
            <option value="confirmed">确认调用</option>
            <option value="inferred">推断线索</option>
          </select>
          <select
            aria-label="筛选 Skill"
            value={filters.skillId}
            onChange={(e) =>
              setFilters({ ...filters, skillId: e.target.value })
            }
          >
            <option value="">全部 Skill</option>
            {state.skills.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选调用设备"
            value={filters.deviceId}
            onChange={(e) =>
              setFilters({ ...filters, deviceId: e.target.value })
            }
          >
            <option value="">全部设备</option>
            {state.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选适用平台"
            value={filters.platform}
            onChange={(e) =>
              setFilters({ ...filters, platform: e.target.value })
            }
          >
            <option value="">全部平台</option>
            {platformOptions.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select
            aria-label="筛选调用技能分类"
            value={filters.category}
            onChange={(e) =>
              setFilters({ ...filters, category: e.target.value })
            }
          >
            <option value="">全部分类</option>
            {[
              ...new Set([
                ...SKILL_CATEGORIES,
                ...state.skills.map((s) => s.category),
              ]),
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>执行时间</th>
                  <th>证据</th>
                  <th>结果</th>
                  <th>设备</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.device_id + e.invocation_id}>
                    <td>
                      <Code2 size={15} />
                      {e.name}
                    </td>
                    <td>{datetime(e.started_at)}</td>
                    <td>
                      <Tag tone={e.evidence === "confirmed" ? "green" : ""}>
                        {e.source === "native-explicit"
                          ? "直接唤起"
                          : e.evidence === "confirmed"
                            ? "已确认执行"
                            : "推断读取"}
                      </Tag>
                    </td>
                    <td>{statusText[e.status] || e.status}</td>
                    <td>{e.device || "未知设备"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="这个日期范围内还没有调用记录"
            icon={ChartNoAxesCombined}
          >
            连接本地 Codex，在对话中使用 $启动名称唤起个人 Skill 后，
            <br />
            这里会显示真实调用次数与结果。
          </Empty>
        )}
      </section>
    </>
  );
}
function Opportunity({
  repo,
  saved,
  onSave,
  state,
  onInstall,
}: {
  repo: any;
  saved: boolean;
  onSave: () => void;
  state: State;
  onInstall: (r: any) => void;
}) {
  return (
    <article className="opportunity">
      <div className="opportunity-top">
        <Tag tone="green">{repo.relevance.category}</Tag>
        <button
          className={"icon-button " + (saved ? "saved" : "")}
          disabled={saved}
          onClick={onSave}
          aria-label={saved ? "已收藏" : "收藏项目"}
        >
          <Star size={16} fill={saved ? "currentColor" : "none"} />
        </button>
      </div>
      <a
        href={repo.url || "https://github.com/" + repo.fullName}
        target="_blank"
        rel="noreferrer"
      >
        <h3>
          {repo.fullName.split("/").at(-1)}
          <ArrowUpRight size={15} />
        </h3>
      </a>
      <p className="opportunity-description">{chineseSummary(repo)}</p>
      <p className="opportunity-reason">{repo.relevance.reason}</p>
      <div className="opportunity-meta">
        <span>
          <i className="language-dot" />
          {repo.language || "未标注"}
        </span>
        <span>
          <Star size={12} />
          {number(repo.stars || 0)}
        </span>
      </div>
      <InstallButton repo={repo} state={state} onInstall={onInstall} />
      <div className="integration-note">{repo.relevance.integration}</div>
    </article>
  );
}
function Trending({
  state,
  match,
  onSave,
  onInstall,
}: {
  state: State;
  match: (...s: any[]) => boolean;
  onSave: (r: any) => void;
  onInstall: (r: any) => void;
}) {
  const [view, setView] = useState("ranked"),
    [ecom, setEcom] = useState(false),
    [period, setPeriod] = useState("daily"),
    [source, setSource] = useState("all"),
    [language, setLanguage] = useState("全部语言");
  const official = state.trending.snapshots.find(
    (s) => s.period === period && s.source === source,
  );
  const raw =
    view === "ranked"
      ? state.trending.ranked
      : (official?.entries || []).map((r, i) => ({
          ...r,
          rank: i + 1,
          relevance: { score: 0 },
        }));
  const rows = raw.filter(
    (r: any) =>
      match(
        r.fullName,
        r.description,
        r.guide?.titleZh,
        r.guide?.summaryZh,
        r.guide?.useZh,
      ) &&
      (!ecom || r.relevance.score > 0) &&
      (language === "全部语言" || r.language === language),
  );
  return (
    <>
      <div className="coverage-note">
        <span className="status-dot online" />
        <div>
          <strong>
            已采集 {state.trending.coveredDays} / {state.trending.requestedDays}{" "}
            天
          </strong>
          <span>
            综合榜采用跟踪候选池 · 热度积分 v1 · 不足 100 项时展示实际数量
          </span>
        </div>
        <span className="coverage-last">
          更新于 {datetime(state.trending.lastCollectedAt)}
        </span>
      </div>
      <section className="panel">
        <div className="ranking-toolbar">
          <div className="tabbar">
            <button
              className={view === "ranked" ? "selected" : ""}
              onClick={() => setView("ranked")}
            >
              综合前 100 名
            </button>
            <button
              className={view === "official" ? "selected" : ""}
              onClick={() => setView("official")}
            >
              GitHub 官方榜单快照
            </button>
          </div>
          <div className="inline-actions">
            {view === "ranked" ? (
              <button
                className={"filter-button " + (ecom ? "chosen" : "")}
                onClick={() => setEcom(!ecom)}
              >
                <Filter size={14} />
                电商相关
              </button>
            ) : (
              <>
                <select
                  aria-label="官方榜周期"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                >
                  <option value="daily">日榜</option>
                  <option value="weekly">周榜</option>
                  <option value="monthly">月榜</option>
                </select>
                <select
                  aria-label="官方榜语言来源"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  {[
                    ...new Set(state.trending.snapshots.map((s) => s.source)),
                  ].map((s) => (
                    <option key={s} value={s}>
                      {s === "all" ? "全语言" : s}
                    </option>
                  ))}
                </select>
              </>
            )}
            <select
              aria-label="筛选编程语言"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option>全部语言</option>
              {[
                ...new Set(raw.map((r: any) => r.language).filter(Boolean)),
              ].map((l) => (
                <option key={String(l)}>{String(l)}</option>
              ))}
            </select>
          </div>
        </div>
        {view === "official" && official && (
          <div className="source-note">
            原站{" "}
            {
              (
                { daily: "日榜", weekly: "周榜", monthly: "月榜" } as Record<
                  string,
                  string
                >
              )[period]
            }{" "}
            · 抓取于 {datetime(official.collectedAt)} · 共{" "}
            {official.entries.length} 项，周期遵循原站定义
          </div>
        )}
        <div className="repo-list">
          {rows.map((repo: any) => (
            <article className="repo-row" key={repo.repoId || repo.fullName}>
              <span className={"repo-rank " + (repo.rank <= 3 ? "top" : "")}>
                {String(repo.rank).padStart(2, "0")}
              </span>
              <div className="repo-body">
                <div className="repo-name-line">
                  <a target="_blank" rel="noreferrer" href={repo.url}>
                    {repo.fullName.split("/")[0]}
                    <span> / {repo.fullName.split("/")[1]}</span>
                    <ArrowUpRight size={14} />
                  </a>
                  {repo.relevance.score > 0 && (
                    <Tag tone="green">{repo.relevance.category}</Tag>
                  )}
                </div>
                {repo.guide?.titleZh && (
                  <h3 className="repo-title-zh">{repo.guide.titleZh}</h3>
                )}
                <p>{chineseSummary(repo)}</p>
                {repo.guide?.useZh && (
                  <p className="repo-use-zh">
                    <b>可以用来：</b>
                    {repo.guide.useZh}
                  </p>
                )}
                {repo.relevance.score > 0 && (
                  <div className="repo-relevance">
                    <Sparkles size={12} />
                    {repo.relevance.reason}
                  </div>
                )}
                <div className="repo-meta">
                  <span>
                    <i className="language-dot" />
                    {repo.language || "未标注"}
                  </span>
                  <span>
                    <Star size={12} />
                    {number(repo.stars)}
                  </span>
                  {repo.license && <span>{repo.license}</span>}
                  {view === "ranked" && <span>上榜 {repo.days} 天</span>}
                  {repo.observedDelta !== undefined &&
                    repo.observedDelta !== null && (
                      <span
                        title={`${datetime(repo.observedFrom)} 至 ${datetime(repo.observedTo)}`}
                      >
                        观测净增 {repo.observedDelta > 0 ? "+" : ""}
                        {number(repo.observedDelta)}
                      </span>
                    )}
                </div>
              </div>
              <div className="repo-actions">
                <InstallButton
                  repo={repo}
                  state={state}
                  onInstall={onInstall}
                />
                <div className="repo-score">
                  {view === "ranked" ? (
                    <>
                      <strong>{repo.score}</strong>
                      <small>热度积分</small>
                    </>
                  ) : (
                    <>
                      <strong>+{number(repo.periodStars || 0)}</strong>
                      <small>原站周期 Star</small>
                    </>
                  )}
                </div>
                <button
                  className={
                    "save-button " +
                    (state.bookmarks.some((b) => b.fullName === repo.fullName)
                      ? "saved"
                      : "")
                  }
                  disabled={state.bookmarks.some(
                    (b) => b.fullName === repo.fullName,
                  )}
                  onClick={() => onSave(repo)}
                  aria-label={"收藏 " + repo.fullName}
                >
                  <Star size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
        {!rows.length && (
          <Empty title="暂无符合条件的榜单" icon={Flame}>
            可以调整日期和筛选条件，或采集最新数据。历史数据会逐日积累。
          </Empty>
        )}
      </section>
      <p className="footnote">
        积分反映候选池中的上榜热度，不等同于全 GitHub 新增 Star
        排名。月榜按北京时间自然月归档。
      </p>
    </>
  );
}
function Opportunities({
  state,
  match,
  onSave,
  onInstall,
  onRemove,
}: {
  state: State;
  match: (...s: any[]) => boolean;
  onSave: (r: any) => void;
  onInstall: (r: any) => void;
  onRemove: (id: string) => void;
}) {
  const [tab, setTab] = useState("discover"),
    [category, setCategory] = useState("全部环节");
  const repos = state.trending.ranked.filter(
    (r) =>
      r.relevance.score > 0 &&
      match(r.fullName, r.description, r.guide?.summaryZh, r.guide?.titleZh) &&
      (category === "全部环节" || r.relevance.category === category),
  );
  return (
    <>
      <div className="business-banner">
        <div className="business-icon">
          <Compass size={27} />
        </div>
        <div>
          <h2>把开源能力，变成你的业务效率。</h2>
          <p>关注淘宝/天猫、京东、拼多多、抖音与小红书的日常经营场景。</p>
        </div>
        <span>你的业务雷达</span>
      </div>
      <div className="section-toolbar">
        <div className="tabbar">
          <button
            className={tab === "discover" ? "selected" : ""}
            onClick={() => setTab("discover")}
          >
            值得关注 <b>{repos.length}</b>
          </button>
          <button
            className={tab === "saved" ? "selected" : ""}
            onClick={() => setTab("saved")}
          >
            观察收藏 <b>{state.bookmarks.length}</b>
          </button>
        </div>
        <select
          aria-label="业务环节"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option>全部环节</option>
          {categories.slice(1).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      {tab === "discover" ? (
        <div className="opportunity-grid">
          {repos.map((r) => (
            <Opportunity
              key={r.repoId || r.fullName}
              repo={r}
              saved={state.bookmarks.some((b) => b.fullName === r.fullName)}
              onSave={() => onSave(r)}
              state={state}
              onInstall={onInstall}
            />
          ))}
        </div>
      ) : (
        <div className="panel">
          {state.bookmarks
            .filter((r) =>
              match(
                r.fullName,
                r.description,
                r.guide?.summaryZh,
                r.guide?.titleZh,
              ),
            )
            .map((r) => (
              <div className="bookmark-row" key={r.fullName}>
                <div>
                  <a
                    href={"https://github.com/" + r.fullName}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.fullName}
                    <ArrowUpRight size={14} />
                  </a>
                  <p>{chineseSummary(r)}</p>
                  <InstallButton repo={r} state={state} onInstall={onInstall} />
                  <small>收藏于 {datetime(r.savedAt)}</small>
                </div>
                <button
                  className="text-button"
                  onClick={() => onRemove(r.repoId || r.fullName)}
                >
                  移出收藏
                </button>
              </div>
            ))}
          {!state.bookmarks.length && (
            <Empty title="把值得研究的项目留在这里" icon={Star}>
              在热榜或开源发现中点击收藏，方便以后继续探索。
            </Empty>
          )}
        </div>
      )}
      {tab === "discover" && !repos.length && (
        <div className="panel">
          <Empty title="暂未发现符合条件的项目" icon={Compass}>
            尝试其他日期或环节，采集后会持续更新。
          </Empty>
        </div>
      )}
      <p className="footnote">
        相关性依据仓库公开描述推断，具体平台适配与运行成本需要试用验证。收藏项目不会自动加入个人
        Skill 库。
      </p>
    </>
  );
}
function SettingsPage({
  state,
  onChanged,
  act,
  pairing,
  setPairing,
  notify,
}: {
  state: State;
  onChanged: () => Promise<void>;
  act: any;
  pairing: any;
  setPairing: (p: any) => void;
  notify: (s: string) => void;
}) {
  const [password, setPassword] = useState({ current: "", newPassword: "" });
  return (
    <div className="settings-grid">
      <section className="panel">
        <PanelTitle
          title="连接本地 Codex"
          subtitle="Skill 文件留在电脑，最小使用记录同步到工作台"
          action={<Monitor size={20} />}
        />
        <div className="setup-steps">
          <div>
            <b>1</b>
            <p>在这台 Mac 的项目目录安装依赖，运行本地连接器。</p>
          </div>
          <div>
            <b>2</b>
            <p>生成一次性配对码，将设备关联到你的个人空间。</p>
          </div>
          <div>
            <b>3</b>
            <p>
              本机自制和 GitHub 导入的 Skill 自动同步，在对话中使用
              $启动名称即可自动记录明确唤起。
            </p>
          </div>
        </div>
        <button
          className="primary"
          onClick={() =>
            act(
              async () => setPairing(await api("/pairings", "POST")),
              "配对码已生成，10 分钟内有效",
            )
          }
        >
          <Link2 size={16} />
          {pairing ? "重新生成配对码" : "生成配对码"}
        </button>
        {pairing && (
          <div className="pairing-box">
            <span>一次性配对码</span>
            <strong>{pairing.code}</strong>
            <small>有效至 {datetime(pairing.expiresAt)}</small>
            <code>
              pnpm connector pair {location.origin} {pairing.code}
            </code>
            <button
              className="text-button"
              onClick={() => {
                void navigator.clipboard.writeText(
                  `pnpm connector pair ${location.origin} ${pairing.code}`,
                );
                notify("已复制配对命令");
              }}
            >
              <Copy size={14} />
              复制命令
            </button>
          </div>
        )}
        <div className="connector-help">
          <h3>日常使用</h3>
          <code>pnpm connector watch</code>
          <code>pnpm connector roots /你的其他Skill目录</code>
          <code>pnpm connector run &lt;skill-id&gt; -- &lt;执行命令&gt;</code>
          <p>
            在其他设备查看时，服务器地址需替换为部署后的 HTTPS
            地址。连接器只主动上传，不开放 Mac 的公网端口。
          </p>
        </div>
      </section>
      <section className="panel">
        <PanelTitle
          title="已配对设备"
          subtitle="可随时撤销单个设备的同步权限"
        />
        {state.devices.length ? (
          state.devices.map((d) => (
            <div className="device-row" key={d.id}>
              <Monitor size={20} />
              <div>
                <strong>{d.name}</strong>
                <small>
                  {d.revoked ? "已撤销" : "最后同步：" + datetime(d.last_seen)}
                </small>
              </div>
              {!d.revoked && (
                <button
                  className="text-button"
                  onClick={() =>
                    act(() => api("/devices/" + d.id, "DELETE"), "设备已撤销")
                  }
                >
                  撤销
                </button>
              )}
            </div>
          ))
        ) : (
          <Empty title="还没有连接设备" icon={Monitor}>
            完成左侧的配对步骤后，设备会出现在这里。
          </Empty>
        )}
        <div className="info-note">
          <ShieldCheck size={17} />
          <p>
            主计数只包含确认调用。原生 Codex
            读取指令的线索单列为推断；没有证据时保持未知。
          </p>
        </div>
      </section>
      <section className="panel">
        <PanelTitle
          title="热榜采集状态"
          subtitle="日榜、周榜、月榜快照 · 多语言综合排名"
          action={
            <button
              className="secondary small"
              onClick={() =>
                act(() => api("/collect", "POST"), "采集任务已启动")
              }
            >
              <RefreshCw size={14} />
              立即采集
            </button>
          }
        />
        <div className="settings-facts">
          <div>
            <span>首次采集</span>
            <strong>{datetime(state.trending.firstCollectedAt)}</strong>
          </div>
          <div>
            <span>最近采集</span>
            <strong>{datetime(state.trending.lastCollectedAt)}</strong>
          </div>
          <div>
            <span>排名口径</span>
            <strong>综合热度 v1 · 北京时间</strong>
          </div>
        </div>
        <div className="job-list">
          {state.jobs.map((j) => (
            <div className="job-row" key={j.id}>
              <span className={"job-status " + j.status}>
                {statusText[j.status] || j.status}
              </span>
              <span>{datetime(j.started_at)}</span>
              <small>
                {j.kind === "chinese"
                  ? `中文说明：${j.details.completed || 0} / ${j.details.total || "待统计"} 个`
                  : `${j.details.results?.filter((r: any) => !r.error).length || 0} / ${j.details.results?.length || 0} 来源`}
              </small>
              {j.details.results?.some((r: any) => r.error) && (
                <details>
                  <summary>查看缺口</summary>
                  {j.details.results
                    .filter((r: any) => r.error)
                    .map((r: any) => (
                      <p key={r.source + r.period}>
                        {r.source} / {r.period}：{r.error}
                      </p>
                    ))}
                </details>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <PanelTitle
          title="日期归档与数据"
          subtitle="每日归档与自然月榜保留历史修订"
        />
        <ArchivesBrowser />
        <div className="info-note">
          <Clock size={17} />
          <p>
            部署后的任务进程每小时采集，次日生成日归档、每月生成上月榜。当前本机进程停止时，本机任务也会暂停。
          </p>
        </div>
        <a className="secondary small" href="/api/export?kind=skills">
          <Download size={14} />
          导出个人 Skill 清单
        </a>
      </section>
      <section className="panel">
        <PanelTitle
          title="已添加到 Codex 的第三方技能"
          subtitle="已自动同步至“我的 Skill”，这里保留安装来源与调用名称管理"
        />
        {state.installedSkills.length ? (
          state.installedSkills.map((s) => (
            <div
              className="device-row"
              key={s.device_id + s.full_name + s.skill_path}
            >
              <CheckCircle2 size={20} />
              <div>
                <strong>{s.custom_name || s.name}</strong>
                <small>
                  原技能 {s.name} · {s.full_name} · {s.device_name} ·{" "}
                  {datetime(s.installed_at)}
                </small>
                <SkillAliasEditor
                  installed={s}
                  state={state}
                  onChanged={onChanged}
                />
              </div>
            </div>
          ))
        ) : (
          <p className="muted">
            还没有通过工作台添加第三方技能。可在 GitHub 热榜点击“添加到 Codex”。
          </p>
        )}
        {state.installationJobs
          .filter((j) => j.status !== "succeeded")
          .slice(0, 5)
          .map((j) => (
            <div className="device-row" key={j.id}>
              <Download size={16} />
              <div>
                <strong>{j.name}</strong>
                <small>{j.message}</small>
              </div>
              <Tag>
                {j.status === "failed"
                  ? "添加失败"
                  : j.status === "running"
                    ? "安装中"
                    : "等待本机"}
              </Tag>
            </div>
          ))}
      </section>
      <CloudChineseSettings />
      <section className="panel">
        <PanelTitle
          title="中文用途说明"
          subtitle="按原始用途生成，缓存后用于技能库、热榜与收藏页面"
        />
        <p className="muted">
          热榜介绍可在上方启用云端生成；未启用时由本机 Codex
          自动处理。技能库名称、用途元数据沿用本机流程，不读取技能正文或聊天记录。已有中文复用缓存，原始描述变化后再更新。
        </p>
        <button
          className="secondary small"
          onClick={() =>
            act(() => api("/explanations", "POST"), "已开始补充中文说明")
          }
        >
          <RefreshCw size={14} />
          补充缺失的中文说明
        </button>
      </section>
      <section className="panel">
        <PanelTitle title="更新工作台密码" subtitle="使用至少 10 位的新密码" />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("/password", "POST", password);
              setPassword({ current: "", newPassword: "" });
            }, "密码已更新");
          }}
        >
          <label>
            当前密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password.current}
              onChange={(e) =>
                setPassword({ ...password, current: e.target.value })
              }
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              value={password.newPassword}
              onChange={(e) =>
                setPassword({ ...password, newPassword: e.target.value })
              }
            />
          </label>
          <button className="secondary small">更新密码</button>
        </form>
      </section>
    </div>
  );
}

function ArchivesBrowser() {
  const [month, setMonth] = useState(""),
    [items, setItems] = useState<any[]>([]),
    [hasMore, setHasMore] = useState(false),
    [error, setError] = useState(""),
    [view, setView] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const request = useRef(0);
  const load = useCallback(
    async (offset = 0) => {
      const id = ++request.current;
      setBusy(true);
      try {
        const response = await api(
          "/archives?" + new URLSearchParams({ month, offset: String(offset) }),
        );
        if (id === request.current) {
          setItems((old) =>
            offset ? [...old, ...response.items] : response.items,
          );
          setHasMore(response.hasMore);
          setError("");
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (id === request.current) setBusy(false);
      }
    },
    [month],
  );
  useEffect(() => {
    void load(0);
  }, [load]);
  return (
    <>
      <div className="archive-controls">
        <label>
          查找历史月份
          <input
            aria-label="归档月份"
            type="month"
            value={month}
            onInput={(e) => setMonth(e.currentTarget.value)}
          />
        </label>
        <button className="text-button" onClick={() => setMonth("")}>
          全部月份
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="archive-list">
        {items.map((a) => (
          <button
            className="archive-link"
            key={a.id}
            onClick={async () => {
              try {
                setView(await api("/archives/" + encodeURIComponent(a.id)));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <CalendarDays size={15} />
            <span>
              {a.from_day} — {a.to_day}
              <small>归档于 {datetime(a.created_at)}</small>
            </span>
            <Tag>{a.period === "month" ? "月榜" : "日榜"}</Tag>
            <ChevronRight size={13} />
          </button>
        ))}
        {!items.length && !busy && (
          <p className="muted">
            此范围暂无正式归档。完成自然日后生成日榜，历史数据会逐步积累。
          </p>
        )}
      </div>
      {hasMore && (
        <button
          className="text-button archive-more"
          disabled={busy}
          onClick={() => void load(items.length)}
        >
          {busy ? "加载中…" : "加载更早的归档"}
        </button>
      )}
      {view && (
        <Modal
          title={view.period === "month" ? "历史月榜" : "历史日榜"}
          onClose={() => setView(null)}
        >
          <p className="muted">
            {view.from_day} — {view.to_day} · 已覆盖 {view.coveredDays} 天
          </p>
          <div className="archived-ranking">
            {view.ranked?.map((r: any) => (
              <a
                href={r.url}
                key={r.repoId || r.fullName}
                target="_blank"
                rel="noreferrer"
              >
                <span>{String(r.rank).padStart(2, "0")}</span>
                <strong>{r.fullName}</strong>
                <small>{r.score} 分</small>
                <ArrowUpRight size={13} />
              </a>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
