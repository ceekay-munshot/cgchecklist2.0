import { extractText, getDocumentProxy } from "unpdf";
import type { FetchedVia } from "@prisma/client";
import { webResearcher } from "@/lib/scrape";
import type { DocFetchResult, DocumentLink } from "./types";
import type { ScreenerSession } from "./browser";
import { stripNul } from "./sanitize";

const MAX_TEXT_CHARS = 800_000; // guard against pathological docs


async function pdfToText(
  buffer: Uint8Array,
): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: false });
  const pages: number = result.totalPages;
  // text is string[] for mergePages:false; normalise defensively.
  const perPage: string[] = ([] as string[]).concat(result.text as string | string[]);
  const text = perPage
    .map((t, i) => `===== PAGE ${i + 1} =====\n${(t ?? "").trim()}`)
    .join("\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  return { text: stripNul(text), pages };
}

function looksLikePdf(buffer: Buffer, contentType?: string): boolean {
  if (contentType?.toLowerCase().includes("pdf")) return true;
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

function viaForProvider(provider?: string): FetchedVia {
  if (provider === "firecrawl") return "FIRECRAWL";
  if (provider === "scrapedo") return "SCRAPEDO";
  return "DIRECT";
}

/**
 * Download a document and extract its text (+ page count). Tries the authed,
 * proxied browser session first; on any failure falls back to the
 * WebResearcher (Firecrawl → Scrape.do). Never throws — returns a typed status
 * (OK / EMPTY / FAILED) so the harvest can continue.
 */
export async function downloadAndExtract(
  link: DocumentLink,
  session: ScreenerSession | null,
): Promise<DocFetchResult> {
  let note: string | undefined;

  // 1) direct download via the browser context (cookies + proxy)
  if (session) {
    try {
      const dl = await session.downloadBuffer(link.url);
      if (dl.ok && dl.buffer && dl.buffer.length > 0) {
        if (looksLikePdf(dl.buffer, dl.contentType)) {
          try {
            const { text, pages } = await pdfToText(dl.buffer);
            return text
              ? { ok: true, status: "OK", via: "SCREENER", text, pages }
              : {
                  ok: true,
                  status: "EMPTY",
                  via: "SCREENER",
                  pages,
                  note: "PDF had no extractable text (likely scanned)",
                };
          } catch (e) {
            note = `pdf parse error: ${(e as Error).message}`;
          }
        } else {
          const text = stripNul(dl.buffer.toString("utf8").slice(0, MAX_TEXT_CHARS));
          return { ok: true, status: "OK", via: "SCREENER", text };
        }
      } else {
        note = `screener download HTTP ${dl.status}`;
      }
    } catch (e) {
      note = `screener download error: ${(e as Error).message}`;
    }
  }

  // 2) fallback: WebResearcher (Firecrawl → Scrape.do)
  try {
    const res = await webResearcher.fetchUrl(link.url);
    if (res.status === "ok" && res.content) {
      return {
        ok: true,
        status: "OK",
        via: viaForProvider(res.provider),
        text: stripNul(res.content.slice(0, MAX_TEXT_CHARS)),
        note,
      };
    }
    return {
      ok: false,
      status: "FAILED",
      via: "SCREENER",
      note: note ?? res.error ?? "download failed (no researcher available)",
    };
  } catch (e) {
    return {
      ok: false,
      status: "FAILED",
      via: "SCREENER",
      note: note ?? `fallback error: ${(e as Error).message}`,
    };
  }
}
