export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const retryRead =
    method === "GET" && /^\/catalog(?:\?|$|\/skills(?:\?|$))/.test(path);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch("/api" + path, {
        method,
        credentials: "same-origin",
        headers:
          body !== undefined ? { "content-type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (retryRead && attempt === 0 && e instanceof TypeError) {
        await pause();
        continue;
      }
      throw new Error("工作台连接暂时中断，请检查网络后重试。");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      // Only repeat idempotent metadata reads after a non-JSON gateway response.
      // A provider error, rate limit, or installation POST is never replayed here.
      if (
        retryRead &&
        attempt === 0 &&
        [404, 502, 503, 504].includes(response.status)
      ) {
        await pause();
        continue;
      }
      const error = new Error(
        `工作台连接暂时中断（HTTP ${response.status}），请重试；若仍失败，请刷新页面。`,
      ) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(
        result.error || "请求失败，请稍后重试",
      ) as Error & { status: number; code?: string; retryAt?: string };
      error.status = response.status;
      error.code = result.code;
      error.retryAt = result.retryAt;
      throw error;
    }
    return result;
  }
}
export const number = (n: number) =>
  new Intl.NumberFormat("zh-CN", {
    notation: n >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n);
export const datetime = (s: string | null | undefined) =>
  s
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(s))
    : "暂无记录";
