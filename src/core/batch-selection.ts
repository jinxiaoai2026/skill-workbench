export function mergeBatchSelection(
  current: Iterable<string>,
  added: Iterable<string>,
  installed: Iterable<string>,
): Set<string> {
  const excluded = new Set(installed);
  const unique = [...new Set([...current, ...added])].filter(
    (path) => !excluded.has(path),
  );
  return new Set(unique.slice(0, 300));
}
