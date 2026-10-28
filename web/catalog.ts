export async function waitForCatalog<T>(
  load: () => Promise<T>,
  options: {
    isActive?: () => boolean;
    onPending?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const now = options.now || Date.now,
    start = now(),
    sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  while (true) {
    if (options.isActive && !options.isActive())
      throw new DOMException("已关闭技能检查", "AbortError");
    try {
      return await load();
    } catch (e) {
      if ((e as any).code !== "CATALOG_PENDING") throw e;
      if (now() - start >= (options.timeoutMs || 45000))
        throw new Error("本机尚未返回检查结果，请确认电脑在线后重新检查。");
      options.onPending?.((e as Error).message);
      await sleep(1500);
    }
  }
}
