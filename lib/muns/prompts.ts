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
