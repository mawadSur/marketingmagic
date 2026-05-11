// Mustache-lite template engine: {{ var.path }} substitution against a JSON payload.
// Keeps the surface tiny so we don't ship a full templating dep.

export function render(template: string, payload: unknown): string {
  return template.replace(/\{\{\s*([\w.[\]-]+)\s*\}\}/g, (_, path: string) => {
    const value = pluck(payload, path);
    if (value == null) return "";
    return String(value);
  });
}

function pluck(obj: unknown, path: string): unknown {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((acc, segment) => {
      if (acc == null || typeof acc !== "object") return undefined;
      return (acc as Record<string, unknown>)[segment];
    }, obj);
}
