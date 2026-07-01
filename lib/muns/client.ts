import { parseAnswer } from "./prompts";

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

/** today (UTC) and today−2y as YYYY-MM-DD. */
export function defaultDateWindow(now: Date = new Date()): { fromDate: string; toDate: string } {
  const toDate = now.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), now.getUTCDate()));
  return { fromDate: from.toISOString().slice(0, 10), toDate };
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
      return { ok: false, answer: "[Error] MUNS auth failed (bad/expired token)", chatId: newChatId, status: res.status, error: "auth" };
    }
    if (!res.ok) {
      return { ok: false, answer: `[Error] MUNS HTTP ${res.status}`, chatId: newChatId, status: res.status, error: text.slice(0, 200) };
    }
    const answer = parseAnswer(text);
    if (!answer) {
      return { ok: false, answer: "[Error] MUNS returned no parseable answer", chatId: newChatId, status: res.status, error: "empty" };
    }
    return { ok: true, answer, chatId: newChatId, status: res.status };
  } catch (e) {
    return { ok: false, answer: `[Error] ${(e as Error).message}`, chatId, status: 0, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
