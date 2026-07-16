import { prisma } from "@/lib/db";

/**
 * Company-level cache of MUNS web-research answers.
 *
 * Live web research (MUNS) is the dominant source of run-to-run variance: two
 * runs of the same company can retrieve different pages and land on different
 * flags. This cache lets a repeat run REUSE a company's prior research (keyed by
 * checklist item) instead of re-querying the web, so the report is stable across
 * runs. A cached answer is reused only while it is fresh (< TTL, default aligned
 * with the 90-day run-freshness window); after that — or on `force` — the item is
 * re-researched and the cache refreshed.
 *
 * SAFE BY CONSTRUCTION: every DB access is wrapped so a missing table / DB hiccup
 * degrades to "no cache" — i.e. exactly today's live-research behaviour — never a
 * thrown error that would break the backfill. `MUNS_CACHE=0` disables it entirely.
 */

/** Same window the on-demand flow reuses a finished run for (lib/analyze/progress). */
const DEFAULT_TTL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function munsCacheEnabled(): boolean {
  const v = process.env.MUNS_CACHE;
  return v !== "0" && v !== "false" && v !== "off";
}

export function cacheTtlDays(): number {
  const n = Number(process.env.MUNS_CACHE_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

export interface CachedAnswer {
  answer: string;
  sources: string[];
}

export interface MunsCacheEntry {
  itemId: string;
  question: string;
  answer: string;
  sources: string[];
  fromDate: string;
  toDate: string;
}

/** Which target items can reuse a cached answer vs must be researched live. Pure. */
export function planMunsResearch(
  targetIds: string[],
  cachedIds: ReadonlySet<string>,
): { reuse: string[]; live: string[] } {
  const reuse: string[] = [];
  const live: string[] = [];
  for (const id of targetIds) (cachedIds.has(id) ? reuse : live).push(id);
  return { reuse, live };
}

function parseSources(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Fresh cached MUNS answers for a company, keyed by itemId. Skips stale (> TTL)
 * entries and prior error answers. Returns an empty map (no reuse) if the cache is
 * disabled or unavailable — the caller then researches everything live, as before.
 */
export async function getCachedAnswers(
  companyId: string,
  itemIds: string[],
  now: Date = new Date(),
): Promise<Map<string, CachedAnswer>> {
  const out = new Map<string, CachedAnswer>();
  if (!munsCacheEnabled() || itemIds.length === 0) return out;
  const cutoff = new Date(now.getTime() - cacheTtlDays() * DAY_MS);
  try {
    const rows = await prisma.munsAnswer.findMany({
      where: { companyId, itemId: { in: itemIds }, updatedAt: { gte: cutoff } },
    });
    for (const r of rows) {
      if (!r.answer || r.answer.startsWith("[Error]")) continue;
      out.set(r.itemId, { answer: r.answer, sources: parseSources(r.sources) });
    }
  } catch {
    // Table missing (schema not yet applied) or a transient DB error → behave as
    // if nothing is cached. The backfill proceeds with a full live research pass.
  }
  return out;
}

/** Upsert freshly-fetched MUNS answers for a company. Never throws; skips errors. */
export async function putCachedAnswers(companyId: string, entries: MunsCacheEntry[]): Promise<number> {
  if (!munsCacheEnabled() || entries.length === 0) return 0;
  let written = 0;
  for (const e of entries) {
    if (!e.answer || e.answer.startsWith("[Error]")) continue;
    const payload = {
      question: e.question,
      answer: e.answer,
      sources: JSON.stringify(e.sources ?? []),
      fromDate: e.fromDate,
      toDate: e.toDate,
    };
    try {
      await prisma.munsAnswer.upsert({
        where: { companyId_itemId: { companyId, itemId: e.itemId } },
        create: { companyId, itemId: e.itemId, ...payload },
        update: payload,
      });
      written++;
    } catch {
      // Ignore a single failed write (e.g. table missing) — caching is best-effort.
    }
  }
  return written;
}
