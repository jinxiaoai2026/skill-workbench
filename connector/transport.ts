type GateSession = {
  cookie?: string;
  expiresAt?: number;
  loading?: Promise<void>;
};
const gates = new Map<string, GateSession>();

export function normalizeServer(value: string): string {
  let url: URL;
  try {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new Error();
    url = new URL(value);
  } catch {
    throw new Error("无效服务器地址");
  }
  if (url.username || url.password || /^\w+:\/\/[^/?#]*@/.test(value.trim()))
    throw new Error("服务器地址不能包含登录凭证");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("远程连接必须使用 HTTPS");
  const codes = url.searchParams.getAll("sharecode");
  if (
    codes.length > 1 ||
    codes.some(
      (code) => !code || code.length > 2048 || /[\s\x00-\x1f\x7f]/.test(code),
    )
  )
    throw new Error("无效服务器访问码");
  return codes.length
    ? `${url.origin}/?${new URLSearchParams({ sharecode: codes[0] })}`
    : url.origin;
}

export function validateServer(value: string): string {
  return new URL(normalizeServer(value)).origin;
}

async function fetchServer(url: string, init: RequestInit) {
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      credentials: "omit",
    });
  } catch {
    throw new Error("无法连接服务器，请检查连接地址或网络");
  }
}

function storeGateCookie(session: GateSession, response: Response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair, ...attributes] = value.split(";");
    const match = pair.match(/^__wb_rsc=([^;\s,]*)$/);
    if (!match) continue;
    let expiresAt: number | undefined;
    let maxAge: number | undefined;
    for (const attribute of attributes) {
      const equals = attribute.indexOf("=");
      const name = attribute.slice(0, equals).trim().toLowerCase();
      const content = attribute.slice(equals + 1).trim();
      if (name === "max-age" && /^-?\d+$/.test(content))
        maxAge = Number(content);
      if (name === "expires" && Number.isFinite(Date.parse(content)))
        expiresAt = Date.parse(content);
    }
    if (maxAge !== undefined) expiresAt = Date.now() + maxAge * 1000;
    session.cookie =
      match[1] && (expiresAt === undefined || expiresAt > Date.now())
        ? `__wb_rsc=${match[1]}`
        : undefined;
    session.expiresAt = expiresAt;
  }
}

async function openGate(
  server: string,
  session: GateSession,
  signal?: AbortSignal | null,
) {
  if (session.loading) return session.loading;
  if (
    session.cookie &&
    (session.expiresAt === undefined || session.expiresAt > Date.now())
  )
    return;
  session.cookie = undefined;
  session.expiresAt = undefined;
  if (!session.loading)
    session.loading = (async () => {
      let current = server;
      let checkedRoot = false;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await fetchServer(current, {
          method: "GET",
          headers: session.cookie ? { cookie: session.cookie } : undefined,
          signal,
        });
        storeGateCookie(session, response);
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          let next: URL;
          try {
            if (
              !location ||
              /[\x00-\x1f\x7f]/.test(location) ||
              /^\w+:\/\/[^/?#]*@/.test(location.trim())
            )
              throw new Error();
            next = new URL(location, current);
            if (
              next.origin !== new URL(server).origin ||
              next.username ||
              next.password
            )
              throw new Error();
          } catch {
            throw new Error("服务器访问入口返回了不安全的重定向");
          }
          current = next.href;
          continue;
        }
        // The host can issue a valid share cookie while its entry request
        // returns a plain 404. Verify that cookie at the same-origin root;
        // this remains anonymous and never forwards a device token or payload.
        if (
          !checkedRoot &&
          response.status === 404 &&
          session.cookie &&
          response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/plain") &&
          new URL(current).searchParams.has("sharecode")
        ) {
          checkedRoot = true;
          current = new URL("/", server).href;
          continue;
        }
        if (!response.ok || !session.cookie)
          throw new Error("无法打开服务器访问入口，请检查连接地址");
        return;
      }
      throw new Error("服务器访问入口重定向次数过多");
    })()
      .catch((error) => {
        session.cookie = undefined;
        session.expiresAt = undefined;
        throw error;
      })
      .finally(() => {
        session.loading = undefined;
      });
  await session.loading;
}

export async function requestServer(
  server: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const normalized = normalizeServer(server);
  const origin = new URL(normalized).origin;
  let target: URL;
  try {
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(path)
    )
      throw new Error();
    target = new URL(path, origin);
    if (target.origin !== origin || target.username || target.password)
      throw new Error();
  } catch {
    throw new Error("无效服务器 API 路径");
  }
  const signal = init.signal ?? AbortSignal.timeout(20000);
  let session: GateSession | undefined;
  if (new URL(normalized).searchParams.has("sharecode")) {
    session = gates.get(normalized) || {};
    gates.set(normalized, session);
    await openGate(normalized, session, signal);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let headers: Headers;
    try {
      headers = new Headers(init.headers);
      headers.delete("cookie");
      if (session?.cookie) headers.set("cookie", session.cookie);
    } catch {
      throw new Error("无效服务器请求头");
    }
    const response = await fetchServer(target.href, {
      ...init,
      headers,
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("服务器 API 返回了重定向，请检查连接地址");
    }
    if (session) storeGateCookie(session, response);
    if (
      session &&
      attempt === 0 &&
      [403, 404].includes(response.status) &&
      response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("text/plain")
    ) {
      await response.body?.cancel();
      session.cookie = undefined;
      session.expiresAt = undefined;
      await openGate(normalized, session, signal);
      continue;
    }
    return response;
  }
  throw new Error("服务器请求未完成");
}
