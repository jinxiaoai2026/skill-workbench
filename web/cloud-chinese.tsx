import { useEffect, useRef, useState } from "react";
import { api, datetime } from "./api";
import type { CloudSettings } from "../src/server/cloud-chinese";

export function CloudChineseSettings() {
  const [status, setStatus] = useState<CloudSettings | null>(null);
  const initialized = useRef(false);
  const [form, setForm] = useState({
    enabled: false,
    provider: "deepseek",
    model: "deepseek-flash",
    dailyLimit: 50,
    apiKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const saved = await api<CloudSettings>("/settings/chinese");
        if (!active) return;
        setStatus(saved);
        if (!initialized.current) {
          setForm({
            enabled: saved.enabled,
            provider: saved.provider,
            model: saved.model,
            dailyLimit: saved.dailyLimit,
            apiKey: "",
          });
          initialized.current = true;
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const save = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await api<CloudSettings>("/settings/chinese", "POST", form);
      setStatus(saved);
      setForm({
        enabled: saved.enabled,
        provider: saved.provider,
        model: saved.model,
        dailyLimit: saved.dailyLimit,
        apiKey: "",
      });
      setMessage(
        saved.enabled
          ? "已启用云端自动生成，服务器将处理待生成项目。"
          : "配置已保存，云端自动生成已关闭。",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ message: string }>(
        "/settings/chinese/test",
        "POST",
      );
      setMessage(result.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void api<CloudSettings>("/settings/chinese")
        .then(setStatus)
        .catch(() => {});
    }
  };
  const dirty =
    status &&
    (form.enabled !== status.enabled ||
      form.provider !== status.provider ||
      form.model !== status.model ||
      form.dailyLimit !== status.dailyLimit ||
      Boolean(form.apiKey));
  const current = !status
    ? "正在读取配置…"
    : !status.configured
      ? "未配置云端模型，当前仍使用本机 Codex"
      : !status.enabled
        ? "云端已关闭，当前仍使用本机 Codex"
        : status.usedToday >= status.dailyLimit
          ? "已达今日请求上限，北京时间次日恢复"
          : status.cooldownUntil
            ? `模型暂时不可用，${datetime(status.cooldownUntil)} 后自动重试`
            : "云端自动生成已启用，Mac 关机也可处理热榜介绍";
  return (
    <section
      className="panel cloud-chinese"
      aria-labelledby="cloud-chinese-heading"
    >
      <div className="panel-title">
        <div>
          <h2 id="cloud-chinese-heading">云端中文介绍</h2>
          <p>新增热榜项目由服务器生成，无需保持 Mac 在线</p>
        </div>
      </div>
      <p className="cloud-status" role="status" aria-live="polite">
        {current}
      </p>
      {status && (
        <p className="muted">
          今日模型请求 {status.usedToday} / {status.dailyLimit} 次 ·
          公开项目待处理 {status.pending} 项
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-grid">
          <label htmlFor="cloud-provider">
            模型服务
            <select
              id="cloud-provider"
              value={form.provider}
              disabled={busy || !status}
              onChange={(e) =>
                setForm({
                  ...form,
                  provider: e.target.value,
                  model:
                    e.target.value === "deepseek"
                      ? "deepseek-flash"
                      : "gpt-4.1-mini",
                  apiKey: "",
                })
              }
            >
              <option value="deepseek">DeepSeek</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>
          <label htmlFor="cloud-model">
            模型名称
            <input
              id="cloud-model"
              value={form.model}
              required
              maxLength={128}
              disabled={busy || !status}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              aria-describedby="cloud-model-help"
            />
          </label>
        </div>
        <p id="cloud-model-help" className="muted">
          使用账户可调用、支持 JSON 输出的模型。
          <a
            href={
              form.provider === "deepseek"
                ? "https://api-docs.deepseek.com/guides/json_mode/"
                : "https://developers.openai.com/api/reference/resources/chat"
            }
            target="_blank"
            rel="noreferrer"
          >
            查看服务文档
          </a>
        </p>
        <label htmlFor="cloud-api-key">
          API Key 密钥
          <input
            id="cloud-api-key"
            type="password"
            autoComplete="new-password"
            value={form.apiKey}
            maxLength={512}
            disabled={busy || !status}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder={
              status?.configured && form.provider === status.provider
                ? "已保存密钥，留空保留；填写可替换"
                : "填写所选模型服务的 API Key"
            }
            aria-describedby="cloud-key-help"
          />
        </label>
        <p id="cloud-key-help" className="muted">
          仅加密保存在服务器，页面不会回显密钥。更换服务时请填写对应的新密钥。
        </p>
        <label htmlFor="cloud-daily-limit">
          每日最多请求次数
          <input
            id="cloud-daily-limit"
            type="number"
            min={1}
            max={500}
            step={1}
            required
            disabled={busy || !status}
            value={form.dailyLimit}
            onChange={(e) =>
              setForm({ ...form, dailyLimit: Number(e.target.value) })
            }
            aria-describedby="cloud-limit-help"
          />
        </label>
        <p id="cloud-limit-help" className="muted">
          每次最多生成 5
          项；失败与连接测试也计数，北京时间零点重置。已有中文复用缓存。
        </p>
        <label className="cloud-enable" htmlFor="cloud-enabled">
          <input
            id="cloud-enabled"
            type="checkbox"
            checked={form.enabled}
            disabled={busy || !status}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          启用云端自动生成
        </label>
        <p className="muted">
          启用后会自动调用所选模型服务并产生 API
          费用，每日次数上限不等于金额上限。只发送公开项目名称与简介；本机的
          Skill 文件和调用记录仍在 Mac 开机后同步。服务器需保持运行。
        </p>
        <div className="cloud-actions">
          <button className="primary small" disabled={busy || !status}>
            {busy
              ? "处理中…"
              : form.enabled
                ? "保存并启用云端生成"
                : "保存配置"}
          </button>
          <button
            type="button"
            className="secondary small"
            onClick={() => void test()}
            disabled={busy || !status?.configured || Boolean(dirty)}
            title={dirty ? "请先保存修改后的配置" : undefined}
          >
            测试连接（调用一次）
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {status?.lastJob && (
        <p className="muted">
          最近云端生成：{datetime(status.lastJob.at)} ·{" "}
          {status.lastJob.status === "succeeded"
            ? `完成 ${status.lastJob.completed} 项`
            : status.lastJob.status === "running"
              ? "处理中"
              : status.lastJob.message || "未完成，将自动重试"}
        </p>
      )}
    </section>
  );
}
