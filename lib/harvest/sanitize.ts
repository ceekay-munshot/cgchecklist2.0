// Postgres TEXT/JSONB cannot store NUL (0x00) bytes — writes fail with 22021
// (text) or 22P05 (jsonb). PDF-extracted and scraped content sometimes contain
// them, so strip before persisting.

export function stripNul(s: string): string {
  return s.replace(/\u0000/g, "");
}

/**
 * Recursively strip NUL bytes from every string in a JSON-like value.
 * (A JSON.stringify round-trip does NOT work: stringify escapes a runtime NUL
 * to the 6-char sequence "\\u0000", which a runtime-NUL strip never matches.)
 */
export function stripNulDeep<T>(value: T): T {
  if (typeof value === "string") return stripNul(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripNulDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        stripNulDeep(v),
      ]),
    ) as T;
  }
  return value;
}
