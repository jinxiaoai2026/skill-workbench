export function validateCustomName(value: string) {
  const name = value.normalize("NFC").trim();
  if (
    !/^[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9_-]{0,63}$/u.test(name)
  )
    throw new Error(
      "调用名称须为 1–64 个中文、英文字母、数字、短横线或下划线，不可含空格或路径",
    );
  return name;
}
