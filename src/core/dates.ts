const DAY = 86400000;
export function shanghaiDay(value: string | Date): string {
  const d = new Date(value);
  if (!Number.isFinite(+d)) throw new Error("无效时间");
  return new Date(+d + 8 * 3600000).toISOString().slice(0, 10);
}
export function validDay(s: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    throw new Error("日期无效");
  return s;
}
export function addDays(s: string, n: number): string {
  return new Date(Date.parse(validDay(s)) + n * DAY).toISOString().slice(0, 10);
}
export function dateRange(
  preset = "7d",
  now = new Date(),
  from?: string,
  to?: string,
  month?: string,
) {
  const today = shanghaiDay(now);
  switch (preset) {
    case "today":
      from = to = today;
      break;
    case "yesterday":
      from = to = addDays(today, -1);
      break;
    case "7d":
      from = addDays(today, -6);
      to = today;
      break;
    case "30d":
      from = addDays(today, -29);
      to = today;
      break;
    case "month":
      from = today.slice(0, 7) + "-01";
      to = today;
      break;
    case "previousMonth":
      to = addDays(today.slice(0, 7) + "-01", -1);
      from = to.slice(0, 7) + "-01";
      break;
    case "calendar": {
      if (!/^\d{4}-\d{2}$/.test(month || "")) throw new Error("请选择月份");
      from = month + "-01";
      validDay(from);
      const d = new Date(from);
      d.setUTCMonth(d.getUTCMonth() + 1);
      to = addDays(d.toISOString().slice(0, 10), -1);
      if (to > today) to = today;
      break;
    }
    case "custom":
      break;
    default:
      throw new Error("未知日期范围");
  }
  validDay(from || "");
  validDay(to || "");
  if (from! > to!) throw new Error("开始日期不能晚于结束日期");
  if ((Date.parse(to!) - Date.parse(from!)) / DAY > 3660)
    throw new Error("日期范围不能超过十年");
  return {
    from: from!,
    to: to!,
    start: new Date(from + "T00:00:00+08:00").toISOString(),
    end: new Date(addDays(to!, 1) + "T00:00:00+08:00").toISOString(),
  };
}
