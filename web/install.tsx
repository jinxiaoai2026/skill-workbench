import { waitForCatalog } from "./catalog.ts";
import { useEffect, useState } from "react";
import {
  Download,
  CheckCircle2,
  LoaderCircle,
  ExternalLink,
  Package,
  AlertCircle,
} from "lucide-react";
import { api, datetime } from "./api";
import { validateCustomName } from "../src/core/skill-names";
import { BatchInstallPanel } from "./batch-install";
function nameError(value: string) {
  if (!value.trim()) return "";
  try {
    validateCustomName(value);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}
export function SkillAliasEditor({
  installed,
  state,
  onChanged,
}: {
  installed: any;
  state: any;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(installed.custom_name || ""),
    [error, setError] = useState(""),
    [job, setJob] = useState<any>(null),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(installed.custom_name || "");
  }, [installed.custom_name]);
  const current =
    state.installationJobs.find((j: any) => j.id === job?.id) || job;
  const pending =
    state.installationJobs.some(
      (j: any) =>
        j.device_id === installed.device_id &&
        j.full_name === installed.full_name &&
        j.skill_path === installed.skill_path &&
        ["queued", "running"].includes(j.status),
    ) ||
    (current && ["queued", "running"].includes(current.status));
  const device = state.devices.find(
    (d: any) => d.id === installed.device_id && !d.revoked,
  );
  const invalid = nameError(name);
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const result = await api("/install/alias", "POST", {
        fullName: installed.full_name,
        path: installed.skill_path,
        deviceId: installed.device_id,
        customName: name.trim(),
      });
      setJob(result);
      setEditing(false);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="skill-alias-editor">
      {installed.custom_name ? (
        <p className="invocation-preview">
          在 Codex 输入 <code>${installed.custom_name}</code> 即可调用
        </p>
      ) : (
        <p className="hint">
          设置一个好记的中文或英文调用名称，例如“网页设计”。
        </p>
      )}
      {editing ? (
        <div className="alias-edit-form">
          <label>
            自定义调用名称
            <input
              aria-label="自定义调用名称"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：网页设计"
            />
          </label>
          <p className="hint">
            支持中文、英文字母、数字、短横线和下划线，不含空格。保存后在下一轮
            Codex 对话使用 <code>${name.trim() || "自定义名称"}</code>。
          </p>
          {invalid && (
            <p className="form-error" role="alert">
              {invalid}
            </p>
          )}
          <div className="alias-edit-actions">
            <button
              className="primary small"
              disabled={
                saving || !name.trim() || !!invalid || !!pending || !device
              }
              onClick={() => void save()}
            >
              {saving ? "正在提交…" : "保存调用名称"}
            </button>
            <button
              className="secondary small"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setError("");
                setName(installed.custom_name || "");
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          className="secondary small"
          disabled={!!pending || !device}
          onClick={() => {
            setEditing(true);
            setJob(null);
          }}
        >
          {pending
            ? "正在同步调用名称…"
            : installed.custom_name
              ? "修改调用名称"
              : "设置调用名称"}
        </button>
      )}
      {current && (
        <p
          role="status"
          className={current.status === "failed" ? "form-error" : "hint"}
        >
          {current.status === "succeeded"
            ? "调用名称已同步，下一轮 Codex 对话即可使用。"
            : current.message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!device && <p className="hint">该设备连接已撤销，请先重新配对。</p>}
    </div>
  );
}
export function chineseSummary(repo: any) {
  return (
    repo.guide?.summaryZh ||
    (/\p{Script=Han}/u.test(repo.description || "")
      ? repo.description
      : "中文用途说明正在生成，完成后会自动显示。")
  );
}
export function InstallButton({
  repo,
  state,
  onInstall,
}: {
  repo: any;
  state: any;
  onInstall: (r: any) => void;
}) {
  const installed =
    state.installedSkills?.filter((s: any) => s.full_name === repo.fullName) ||
    [];
  const pending = state.installationJobs?.some(
    (j: any) =>
      j.full_name === repo.fullName && ["queued", "running"].includes(j.status),
  );
  const software = repo.skillCatalog?.count === 0;
  const unknown = !repo.skillCatalog;
  return (
    <button
      className={"install-button " + (installed.length ? "installed" : "")}
      onClick={() => onInstall(repo)}
      aria-label={
        (software
          ? "查看项目说明："
          : unknown
            ? "检查是否含 Skill："
            : "添加到 Codex：") + repo.fullName
      }
    >
      {pending ? (
        <LoaderCircle size={14} className="spin" />
      ) : installed.length ? (
        <CheckCircle2 size={14} />
      ) : (
        <Download size={14} />
      )}
      <span>
        {pending
          ? "正在添加"
          : installed.length
            ? repo.skillCatalog?.count === 1
              ? "管理调用名称"
              : "添加更多技能"
            : software
              ? "查看项目说明"
              : unknown
                ? "检查可用技能"
                : "添加到 Codex"}
      </span>
    </button>
  );
}
export function InstallPanel({
  repo,
  state,
  onClose,
  onChanged,
}: {
  repo: any;
  state: any;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [device, setDevice] = useState(""),
    [customName, setCustomName] = useState(""),
    [loading, setLoading] = useState(true),
    [loadingMessage, setLoadingMessage] =
      useState("正在检查技能文件并读取中文用途…"),
    [error, setError] = useState(""),
    [retryAt, setRetryAt] = useState<string | undefined>(),
    [requestVersion, setRequestVersion] = useState(0),
    [clock, setClock] = useState(Date.now()),
    [submitting, setSubmitting] = useState(false),
    [job, setJob] = useState<any>(null),
    [skillPage, setSkillPage] = useState<any>({
      items: [],
      hasMore: false,
      total: 0,
    });
  const devices = state.devices.filter((d: any) => !d.revoked);
  const current =
    state.installationJobs.find((j: any) => j.id === job?.id) || job;
  const submit = async (path: string, deviceId: string) => {
    setSubmitting(true);
    setError("");
    try {
      const result = await api("/install", "POST", {
        fullName: repo.fullName,
        path,
        deviceId,
        ...(customName.trim() ? { customName: customName.trim() } : {}),
      });
      setJob(result);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setRetryAt(undefined);
    (async () => {
      try {
        const result = await waitForCatalog(
          () =>
            api(
              "/catalog?repo=" +
                encodeURIComponent(repo.fullName) +
                (requestVersion ? "&refresh=1" : ""),
            ),
          {
            isActive: () => active,
            onPending: (message) => {
              if (active) setLoadingMessage(message);
            },
          },
        );
        if (!active) return;
        setCatalog(result);
        const valid = state.devices.filter((d: any) => !d.revoked);
        if (valid.length === 1) setDevice(valid[0].id);
        if (result.skills.length === 1) {
          setSelected(result.skills[0].path);
          const details = await api(
            "/catalog/skills?repo=" + encodeURIComponent(repo.fullName),
          );
          if (!active) return;
          setSkillPage(details);
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setRetryAt((e as Error & { retryAt?: string }).retryAt);
          setClock(Date.now());
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [repo.fullName, requestVersion]);
  const single = skillPage.items[0];
  const installed = state.installedSkills.find(
    (s: any) =>
      s.full_name === repo.fullName &&
      s.skill_path === selected &&
      s.device_id === device,
  );
  const invalidName = nameError(customName);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  useEffect(() => {
    setCustomName("");
  }, [selected, device]);
  return (
    <div className="install-panel">
      <div className="install-project">
        <Package size={22} />
        <div>
          <strong>{repo.guide?.titleZh || repo.fullName}</strong>
          <small>{repo.fullName}</small>
        </div>
      </div>
      <p className="install-summary">{chineseSummary(repo)}</p>
      {repo.guide?.useZh && (
        <p className="install-use">
          <b>可以用来：</b>
          {repo.guide.useZh}
        </p>
      )}
      {catalog?.warning && (
        <p className="hint" role="status">
          {catalog.warning} 核验时间：{datetime(catalog.checkedAt)}
        </p>
      )}
      {skillPage.warning && (
        <p className="hint" role="status">
          {skillPage.warning}
        </p>
      )}
      {loading ? (
        <div className="install-loading">
          <LoaderCircle size={20} className="spin" />
          {loadingMessage}
        </div>
      ) : catalog && catalog.skills.length === 0 ? (
        <div className="install-software">
          <h3>
            {catalog.stale
              ? "上次检查未发现可直接安装的 Skill"
              : "此仓库未提供可直接安装的 Skill"}
          </h3>
          <p>
            只有包含有效 SKILL.md
            名称及用途说明的技能目录才能添加。资源清单和普通软件不能作为 Skill
            直接安装；可先查看项目文档。
          </p>
          <a
            className="secondary"
            href={repo.url || "https://github.com/" + repo.fullName}
            target="_blank"
            rel="noreferrer"
          >
            查看项目文档
            <ExternalLink size={14} />
          </a>
        </div>
      ) : catalog?.skills.length > 1 ? (
        <BatchInstallPanel
          repo={repo}
          catalog={catalog}
          state={state}
          onChanged={onChanged}
        />
      ) : (
        catalog && (
          <>
            {catalog.skills.length === 1 && single?.manifestName && (
              <div className="actual-skill-guide">
                <h3>
                  将添加的技能：{single.guide?.titleZh || single.manifestName}
                </h3>
                <p>
                  {single.guide?.summaryZh ||
                    "此技能清单已核验，以下为上游用途原文："}
                </p>
                {!single.guide && <p>{single.description}</p>}
                {single.guide?.useZh && <p>{single.guide.useZh}</p>}
                <small>技能清单：{single.path}</small>
              </div>
            )}
            {current ? (
              <div
                className={
                  "installation-progress " +
                  (current.status === "failed" ? "failed" : "")
                }
                role="status"
              >
                {current.status === "succeeded" ? (
                  <CheckCircle2 size={24} />
                ) : current.status === "failed" ? (
                  <AlertCircle size={24} />
                ) : (
                  <LoaderCircle size={24} className="spin" />
                )}
                <div>
                  <h3>
                    {current.status === "succeeded"
                      ? "已添加到 Codex"
                      : current.status === "failed"
                        ? "添加未完成"
                        : current.status === "running"
                          ? "本机正在安装技能"
                          : "等待本机连接器"}
                  </h3>
                  <p>{current.message}</p>
                  {current.status === "succeeded" && (
                    <small>
                      Codex 下一轮对话即可发现。
                      {customName.trim() && (
                        <>
                          输入 <code>${customName.trim()}</code> 即可调用。
                        </>
                      )}
                      安装完成后会自动同步至“我的 Skill”。
                    </small>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="catalog-count">
                  找到 {catalog.skills.length} 个可添加的技能
                </div>
                <label>
                  添加到哪台电脑
                  <select
                    aria-label="选择安装设备"
                    value={device}
                    onChange={(e) => setDevice(e.target.value)}
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
                {installed ? (
                  <div className="actual-skill-guide">
                    <h3>已添加到 {installed.device_name || "这台电脑"}</h3>
                    <SkillAliasEditor
                      key={
                        installed.device_id +
                        installed.full_name +
                        installed.skill_path
                      }
                      installed={installed}
                      state={state}
                      onChanged={onChanged}
                    />
                  </div>
                ) : (
                  <>
                    <label>
                      自定义调用名称（选填）
                      <input
                        aria-label="自定义调用名称"
                        value={customName}
                        maxLength={64}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder="例如：网页设计；留空使用原名称"
                      />
                    </label>
                    <p className="hint">
                      中文或英文均可，不含空格。
                      {customName.trim() ? (
                        <>
                          添加后，在 Codex 输入{" "}
                          <code>${customName.trim()}</code> 即可调用。
                        </>
                      ) : (
                        "留空时保留原技能名称；以后也可以修改调用名称。"
                      )}
                    </p>
                    {invalidName && (
                      <p className="form-error" role="alert">
                        {invalidName}
                      </p>
                    )}
                    <p className="hint">
                      添加的是项目提供的技能文件。项目依赖仍需按文档配置，同名文件和本地修改会保留。
                    </p>
                    <button
                      className="primary"
                      disabled={
                        !selected ||
                        !single?.manifestName ||
                        !device ||
                        submitting ||
                        !!invalidName
                      }
                      onClick={() => void submit(selected, device)}
                    >
                      <Download size={15} />
                      {submitting ? "正在提交…" : "添加到 Codex"}
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        {error && !loading && (
          <button
            className="secondary"
            disabled={!!retryAt && clock < Date.parse(retryAt)}
            onClick={() => setRequestVersion((v) => v + 1)}
          >
            {retryAt && clock < Date.parse(retryAt)
              ? "预计 " + datetime(retryAt) + " 后可重试"
              : "重新检查技能"}
          </button>
        )}
        {current?.status === "failed" && (
          <button className="secondary" onClick={() => setJob(null)}>
            重新选择
          </button>
        )}
        <button className="secondary" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
