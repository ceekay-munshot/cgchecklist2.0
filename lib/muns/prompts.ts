/**
 * MUNS Chat API — prompt text + wire formatting, ported VERBATIM from the sister
 * dashboard's fetch contract (only the fetch mechanics are ported; its 0/1/2
 * scoring is NOT — this repo's own green/red-flag classifier decides verdicts).
 */

/** Output-format suffix — appended to the mega prompt AND every question. Keep the leading space. */
export const SUFFIX = " Answer in THREE BULLET POINTS ONLY STRICTLY.";

/** The standing "how to answer" briefing — sent first to open a session (SUFFIX already included). */
export const MEGA_PROMPT =
  "Make structured tables answering the below questions for the company . If an answer is Not established or Not available in the annual report - Quickly Websearch and find it . Keep each answer specific to the company with exact figures, names and dates - never generic . State the finding directly and crisply : give the fact itself with the key number(s) . Do NOT narrate the evidence, the sources or the search process, and do NOT say what a report 'does or does not disclose' - just answer . No hedging, no filler . Use the exact name of the ceo/company/elements in each answer only . DOUBLE CHECK AND VERIFY EACH ANSWER BEFORE ANSWERING." +
  SUFFIX;

/**
 * The mega prompt ANCHORED to a specific company. The bare MEGA_PROMPT never
 * names the company ("for the company ."), so MUNS identifies it only from the
 * query_context — and for an obscure/unlisted name it can't resolve, it DRIFTS to
 * a different company and returns that firm's data (the MetalBook→AFCOM leak).
 * Naming the company here, and forbidding substitution, keeps every answer on the
 * requested company or an honest "Not available". Falls back to MEGA_PROMPT when
 * no name is available. SUFFIX-terminated like MEGA_PROMPT.
 */
export function megaPrompt(companyName?: string): string {
  const name = (companyName ?? "").trim();
  if (!name) return MEGA_PROMPT;
  return (
    `Make structured tables answering the below questions for ${name}. ` +
    `EVERY answer must be about ${name} SPECIFICALLY — the single company named "${name}". If you cannot ` +
    `find information about ${name} itself, answer "Not available"; do NOT answer about, or substitute data ` +
    `from, any other company, however similarly named. ` +
    `If an answer is Not established or Not available in the annual report - Quickly Websearch and find it . ` +
    `Keep each answer specific to the company with exact figures, names and dates - never generic . ` +
    `State the finding directly and crisply : give the fact itself with the key number(s) . ` +
    `Do NOT narrate the evidence, the sources or the search process, and do NOT say what a report ` +
    `'does or does not disclose' - just answer . No hedging, no filler . ` +
    `Use the exact name of the ceo/company/elements in each answer only . ` +
    `DOUBLE CHECK AND VERIFY EACH ANSWER BEFORE ANSWERING.` +
    SUFFIX
  );
}

// Corporate suffixes that mark the SUBJECT company of an answer. LLP / "& Co" /
// "Associates" are deliberately EXCLUDED — those are auditors / law firms an answer
// legitimately cites, not the company it's about, so they must not trip the gate.
const CORP_SUFFIX = "Private\\s+Limited|Pvt\\.?\\s*Ltd\\.?|Holdings\\s+Limited|Holdings\\s+Ltd\\.?|Holdings|Limited|Ltd\\.?|Incorporated|Inc\\.?|Corporation|Corp\\.?";
const COMPANY_NAME_RE = new RegExp(`((?:[A-Z][A-Za-z0-9&.]*\\s+){1,4}(?:${CORP_SUFFIX}))`, "g");

/** Company-like proper names in a text (phrases ending in a corporate suffix). */
export function extractCompanyNames(text: string): string[] {
  if (!text) return [];
  return [...text.matchAll(COMPANY_NAME_RE)].map((m) => m[1].trim());
}

/** Lowercase a company name and drop corporate-form words, so only the distinctive core remains. */
function normalizeCompany(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\b(private|limited|ltd|holdings|pvt|incorporated|inc|corporation|corp|company|co)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Do two normalized company cores share a distinctive token / concatenated form? (Handles subsidiaries + spacing.) */
function companiesRelated(aNorm: string, bNorm: string): boolean {
  const a = aNorm.split(" ").filter((t) => t.length >= 3);
  const b = bNorm.split(" ").filter((t) => t.length >= 3);
  for (const x of a) for (const y of b) if (x.includes(y) || y.includes(x)) return true;
  const ac = aNorm.replace(/ /g, "");
  const bc = bNorm.replace(/ /g, "");
  return ac.length >= 4 && bc.length >= 4 && (ac.includes(bc) || bc.includes(ac));
}

/**
 * True when a MUNS answer is about a DIFFERENT company than `targetName` — i.e. it
 * never names the target yet prominently names another company. Used to drop leaked
 * answers so a foreign firm's data never enters the report (the item stays NA).
 * Conservative: a generic answer (no company named) or one that mentions the target
 * is kept; only a clearly foreign-subject answer is rejected.
 */
export function mentionsForeignCompany(answer: string, targetName: string): boolean {
  const target = normalizeCompany(targetName);
  if (!target || !answer) return false;
  const lower = answer.toLowerCase();

  // Target mentioned? concatenated name as a substring, or a distinctive (>=5-char)
  // token as a whole word → treat the answer as on-target and keep it.
  const stripped = lower.replace(/[^a-z0-9]+/g, "");
  const targetConcat = target.replace(/ /g, "");
  if (targetConcat.length >= 4 && stripped.includes(targetConcat)) return false;
  for (const tok of target.split(" ").filter((t) => t.length >= 5)) {
    if (new RegExp(`\\b${tok}\\b`).test(lower)) return false;
  }

  // Otherwise: is some OTHER (non-target) company named as the subject?
  for (const name of extractCompanyNames(answer)) {
    if (!companiesRelated(normalizeCompany(name), target)) return true;
  }
  return false;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** a, b, …, z, aa, ab, … for the item index within a section. */
export function letterFor(index: number): string {
  if (index < 26) return LETTERS[index];
  return LETTERS[Math.floor(index / 26) - 1] + LETTERS[index % 26];
}

/**
 * Format one parameter as the wire message. Tabs / blank lines are LITERAL
 * characters, exactly per the sister contract:
 *  - first item of a section: "<n>\t<Section Title>\n\n\t<letter>)<text><SUFFIX>"
 *  - later items:             "\t<letter>)\t<text><SUFFIX>"
 */
export function formatQuestion(args: {
  sectionNumber: number;
  sectionTitle: string;
  indexInSection: number; // 0-based
  text: string;
}): string {
  const letter = letterFor(args.indexInSection);
  if (args.indexInSection === 0) {
    return `${args.sectionNumber}\t${args.sectionTitle}\n\n\t${letter})${args.text}${SUFFIX}`;
  }
  return `\t${letter})\t${args.text}${SUFFIX}`;
}

/**
 * Turn a raw MUNS response body into the clean answer prose.
 * Primary: join every <ans>…</ans>, strip <doc_source>/<docsource> citations,
 * strip remaining XML tags, unescape entities. Fallbacks: SSE "data:" frames,
 * then JSON response/answer/text/content/message fields.
 */
export function parseAnswer(body: string): string {
  const ans = [...body.matchAll(/<ans>([\s\S]*?)<\/ans>/gi)].map((m) => m[1]);
  if (ans.length) return cleanup(ans.join("\n\n"));

  // SSE fallback: concat content / text / delta.text from data: frames.
  const sse = [...body.matchAll(/^data:\s*(.+)$/gim)]
    .map((m) => m[1].trim())
    .filter((s) => s && s !== "[DONE]");
  if (sse.length) {
    const parts: string[] = [];
    for (const frame of sse) {
      try {
        const j = JSON.parse(frame);
        const piece = j.content ?? j.text ?? j.delta?.text ?? j.choices?.[0]?.delta?.content;
        if (typeof piece === "string") parts.push(piece);
      } catch {
        parts.push(frame);
      }
    }
    if (parts.length) return cleanup(parts.join(""));
  }

  // JSON fallback.
  try {
    const j = JSON.parse(body);
    const field = j.response ?? j.answer ?? j.text ?? j.content ?? j.message;
    if (typeof field === "string") return cleanup(field);
  } catch {
    /* not json */
  }
  return "";
}

/**
 * Extract source URLs from a RAW MUNS response body. MUNS returns its citations
 * inside <doc_source>/<docsource> tags (and sometimes inline) — `cleanup()` strips
 * those from the displayed prose, but they are exactly the "source per line item"
 * the client wants, so we harvest the http(s) URLs BEFORE they're discarded and
 * persist the top one as the item's source. Returns unique URLs in first-seen
 * order; empty when the body carries no URL (then the item keeps no web source —
 * no regression). Trailing sentence punctuation is trimmed from each URL.
 */
export function extractSourceUrls(body: string): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function cleanup(s: string): string {
  return s
    .replace(/<doc_source>[\s\S]*?<\/doc_source>/gi, "")
    .replace(/<docsource>[\s\S]*?<\/docsource>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
