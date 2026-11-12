const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (s: string) =>
  s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function mapKeys(v: unknown, f: (k: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => mapKeys(x, f));
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        f(k),
        mapKeys(x, f),
      ]),
    );
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** SDK models are camelCase, PayPal REST JSON is snake_case. */
export const toSnake = <T>(v: unknown): T => mapKeys(v, snake) as T;
export const toCamel = <T>(v: unknown): T => mapKeys(v, camel) as T;
