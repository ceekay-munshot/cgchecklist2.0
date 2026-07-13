import { parseAnswer, extractSourceUrls } from "./prompts";

/**
 * Thin MUNS Chat API client. ONE POST per turn; the session id comes from the
 * x-chat-id RESPONSE header (never the body). Context is controlled entirely by
 * the chatHistory we send, not server memory. Never throws — a failed turn
 * returns { ok:false, answer:"[Error] …" } so a lane keeps going.
 */

const ENDPOINT = "https://birdnest.muns.io/chat/chat-muns";

export interface MunsEnv {
  token: string;
  userIndex: number;
  contextEmail: string;
}

export interface MunsQueryContext {
  ticker: string;
  companyName: string;
  fromDate: string; // YYYY-MM-DD (UTC)
  toDate: string; // YYYY-MM-DD (UTC)
}

export interface MunsCallArgs {
  env: MunsEnv;
  ctx: MunsQueryContext;
  task: string; // this turn's single message
  chatId?: string; // omit on the first (mega) call
  chatHistory: string[]; // limited history ("User: …", "AI: …")
}

export interface MunsCallResult {
  ok: boolean;
  answer: string;
  /** Source URLs harvested from the raw MUNS body (citations) — for the item's source. */
  sources: string[];
  chatId?: string;
  status: number;
  error?: string;
}

export function munsConfigured(): boolean {
  return !!process.env.MUNS_TOKEN;
}

export function munsEnv(): MunsEnv {
  return {
    token: process.env.MUNS_TOKEN ?? "",
    userIndex: Number(process.env.USER_INDEX) || 1,
    contextEmail: process.env.CONTEXT_EMAIL || "tech@muns.io",
  };
}

/** A YYYY-MM-DD window from `now` back `years`, clamped to `now` as the upper bound. */
function windowYears(years: number, now: Date): { fromDate: string; toDate: string } {
  const toDate = now.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return { fromDate: from.toISOString().slice(0, 10), toDate };
}

/** today (UTC) and today−2y as YYYY-MM-DD. */
export function defaultDateWindow(now: Date = new Date()): { fromDate: string; toDate: string } {
  return windowYears(2, now);
}

/**
 * The extended historical window is the DEFAULT: almost every governance question
 * is a track-record / history one (a promoter's past conduct, litigation,
 * resignations, mergers, multi-year trends, reputation) where a trailing 2-year
 * window structurally HIDES exactly what it asks about — the AFCOM promoter's
 * pre-2024 collapsed business was invisible because the search only looked back
 * two years. So we look back DECADES by default and keep the short window ONLY for
 * items that are inherently about the CURRENT market state: stock volatility,
 * traded volume / liquidity, and live analyst coverage (all of section A15). For
 * those, "recent" is the correct question; for everything else, older facts matter.
 */
const RECENCY_SECTIONS = new Set(["A15"]);
const RECENCY_ITEMS = new Set<string>([]);

/** Inherently CURRENT market-state item (short window) vs a track-record one (wide)? */
export function isRecencyItem(itemId: string, sectionCode: string): boolean {
  return RECENCY_SECTIONS.has(sectionCode) || RECENCY_ITEMS.has(itemId);
}

/**
 * The search date window for a specific checklist item. Track-record / history
 * items (the DEFAULT) get a long lookback (default 25y, `MUNS_HISTORY_LOOKBACK_YEARS`);
 * only inherently-current market-state items keep the short window (default 2y,
 * `MUNS_LOOKBACK_YEARS`). `toDate` is always today, so a wide window never loses
 * recent data — it only ADDS history.
 */
export function dateWindowForItem(
  itemId: string,
  sectionCode: string,
  now: Date = new Date(),
): { fromDate: string; toDate: string } {
  if (isRecencyItem(itemId, sectionCode)) {
    return windowYears(Number(process.env.MUNS_LOOKBACK_YEARS) || 2, now);
  }
  return windowYears(Number(process.env.MUNS_HISTORY_LOOKBACK_YEARS) || 25, now);
}

export async function munsCall(args: MunsCallArgs): Promise<MunsCallResult> {
  const { env, ctx, task, chatId, chatHistory } = args;
  const body: Record<string, unknown> = {
    user_index: env.userIndex,
    tasks: [task],
    query_context: {
      TICKER_SYMBOL: [ctx.ticker],
      FROM_DATE: ctx.fromDate,
      TO_DATE: ctx.toDate,
      ANNOUNCEMENT_FORM_TYPE: "all",
      DOCUMENT_IDS: [],
      CATEGORIES: [],
      WEB_SEARCH_ENABLED: true,
      COUNTRY: [],
      CONTEXT_EMAIL: env.contextEmail,
      CONTEXT_COMPANY_NAME: [ctx.companyName],
      GET_ANNOUNCEMENTS_ENABLED: false,
      chatHistory,
      mode: "expert",
    },
    autoAddUpcoming: false,
  };
  if (chatId) body.chat_id = chatId; // OMIT on the first call

  const timeoutMs = Number(process.env.MUNS_TIMEOUT_MS) || 180_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        accept: "*/*",
        Authorization: `Bearer ${env.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const newChatId = res.headers.get("x-chat-id") ?? chatId;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, answer: "[Error] MUNS auth failed (bad/expired token)", sources: [], chatId: newChatId, status: res.status, error: "auth" };
    }
    if (!res.ok) {
      return { ok: false, answer: `[Error] MUNS HTTP ${res.status}`, sources: [], chatId: newChatId, status: res.status, error: text.slice(0, 200) };
    }
    const answer = parseAnswer(text);
    if (!answer) {
      return { ok: false, answer: "[Error] MUNS returned no parseable answer", sources: [], chatId: newChatId, status: res.status, error: "empty" };
    }
    // Harvest citation URLs from the RAW body before cleanup() strips them — this
    // is the item's source ("source per line item"). Empty when none present.
    return { ok: true, answer, sources: extractSourceUrls(text), chatId: newChatId, status: res.status };
  } catch (e) {
    return { ok: false, answer: `[Error] ${(e as Error).message}`, sources: [], chatId, status: 0, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
