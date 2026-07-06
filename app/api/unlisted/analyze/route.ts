import { connection } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import { prisma } from "@/lib/db";
import { stripNul } from "@/lib/harvest/sanitize";
import { triggerRunAnalysis, isDispatchConfigured } from "@/lib/analyze/dispatch";

/**
 * Analyse an UNLISTED company from uploaded documents (no Screener harvest).
 *
 *   POST /api/unlisted/analyze   multipart: name, cin?, sector?, files[] (PDFs)
 *
 * We extract each PDF's text right here, store them as the run's SourceDocs
 * (exactly what the harvester would have produced), then dispatch analyze-run
 * to process the run against those documents + the web-research fill. The
 * Screener-derived items simply come back "not available" — an unlisted company
 * has no financial database — which is the agreed MVP behaviour.
 */

const MAX_FILES = 15;
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB per file (Worker-friendly)
const MAX_TEXT_CHARS = 800_000;

async function pdfToText(buffer: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: false });
  const pages: number = result.totalPages;
  const perPage: string[] = ([] as string[]).concat(result.text as string | string[]);
  // Page markers (===== PAGE n =====) so the engine can cite page numbers.
  const text = perPage
    .map((t, i) => `===== PAGE ${i + 1} =====\n${(t ?? "").trim()}`)
    .join("\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  return { text: stripNul(text), pages };
}

export async function POST(req: Request) {
  await connection();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected an upload (multipart form data)." }, { status: 400 });
  }

  const name = (form.get("name") as string | null)?.trim();
  if (!name) return Response.json({ error: "Company name is required." }, { status: 400 });
  const cin = (form.get("cin") as string | null)?.trim() || null;
  const sector = (form.get("sector") as string | null)?.trim() || null;

  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return Response.json({ error: "Upload at least one PDF." }, { status: 400 });
  if (files.length > MAX_FILES) return Response.json({ error: `Upload at most ${MAX_FILES} files.` }, { status: 400 });

  // Unlisted company = no ticker. Create it + a run to hold the uploaded docs.
  const company = await prisma.company.create({ data: { name, ticker: null, cin, sector } });
  const run = await prisma.analysisRun.create({
    data: { companyId: company.id, status: "QUEUED", createdBy: "web:unlisted-upload" },
  });

  let ingested = 0;
  const skipped: string[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      skipped.push(`${file.name} — too large (max 15 MB)`);
      continue;
    }
    const isPdf = file.type.toLowerCase().includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      skipped.push(`${file.name} — not a PDF`);
      continue;
    }
    let text = "";
    let pages: number | null = null;
    let ok = true;
    try {
      const r = await pdfToText(await file.arrayBuffer());
      text = r.text;
      pages = r.pages;
      if (!text) ok = false;
    } catch {
      ok = false;
    }
    await prisma.sourceDoc
      .create({
        data: {
          runId: run.id,
          type: "ANNUAL_REPORT", // read by the engine's document strategies
          name: file.name,
          sourceUrl: `upload://${encodeURIComponent(file.name)}`,
          fetchedVia: "MANUAL",
          fetchStatus: ok ? "OK" : "EMPTY",
          pages,
          extractedText: ok ? text : null,
          note: ok ? null : "no extractable text (likely a scanned PDF)",
        },
      })
      .catch(() => {});
    if (ok) ingested++;
    else skipped.push(`${file.name} — no readable text (scanned PDF?)`);
  }

  if (ingested === 0) {
    await prisma.analysisRun.update({ where: { id: run.id }, data: { status: "ERROR" } }).catch(() => {});
    return Response.json(
      { error: "None of the uploaded PDFs had readable text — they may be scanned. Please upload text-based PDFs.", skipped },
      { status: 422 },
    );
  }

  // Documents ready → HARVESTED, then dispatch the analysis (no Screener step).
  await prisma.analysisRun.update({ where: { id: run.id }, data: { status: "HARVESTED" } });

  let dispatched = true;
  let dispatchError: string | undefined;
  if (isDispatchConfigured()) {
    const d = await triggerRunAnalysis(run.id);
    dispatched = d.ok;
    dispatchError = d.ok ? undefined : d.error;
  } else {
    dispatched = false;
    dispatchError = "dispatch_not_configured";
  }

  return Response.json({
    status: "started",
    runId: run.id,
    ticker: null,
    company: name,
    ingested,
    skipped,
    dispatched,
    dispatchError,
  });
}
