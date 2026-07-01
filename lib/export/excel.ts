import ExcelJS from "exceljs";
import type { CompanyReport, ReportItem, FlagName } from "@/lib/report";

/**
 * Build a polished, colour-graded multi-sheet .xlsx of a company's CG report.
 * Sheets: Summary (KPIs + section heat-map), Checklist (grouped by section, full
 * text auto-wrapped), Watchlist (reds / needs-review).
 */

// ---- palette (ARGB) ---------------------------------------------------------
const C = {
  ink: "FF0F172A",
  sub: "FF475569",
  line: "FFE2E8F0",
  zebra: "FFF8FAFC",
  band: "FF1E1B4B", // header band (indigo-950)
  section: "FF4338CA", // section band (indigo-700)
  bandText: "FFFFFFFF",
  green: "FF10B981",
  greenSoft: "FFD1FAE5",
  red: "FFF43F5E",
  redSoft: "FFFFE4E6",
  amber: "FFF59E0B",
  amberSoft: "FFFEF3C7",
  slate: "FF94A3B8",
  slateSoft: "FFF1F5F9",
  white: "FFFFFFFF",
} as const;

const FLAG_META: Record<FlagName | "NONE", { label: string; emoji: string; fill: string; soft: string; text: string }> = {
  GREEN: { label: "GREEN", emoji: "🟢", fill: C.green, soft: C.greenSoft, text: "FF065F46" },
  RED: { label: "RED", emoji: "🔴", fill: C.red, soft: C.redSoft, text: "FF9F1239" },
  NEUTRAL: { label: "NEUTRAL", emoji: "⚪", fill: C.amber, soft: C.amberSoft, text: "FF92400E" },
  NOT_AVAILABLE: { label: "N/A", emoji: "▫️", fill: C.slate, soft: C.slateSoft, text: "FF334155" },
  NONE: { label: "PENDING", emoji: "•", fill: C.slate, soft: C.slateSoft, text: "FF334155" },
};
const flagMeta = (it: ReportItem) => FLAG_META[(it.flag ?? "NONE") as FlagName | "NONE"];

const thin = { style: "thin" as const, color: { argb: C.line } };
const ALL_BORDERS = { top: thin, left: thin, bottom: thin, right: thin };
const box = (cell: ExcelJS.Cell) => (cell.border = ALL_BORDERS);
const fmtPct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
const solid = (argb: string): ExcelJS.FillPattern => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

// ---- Summary ----------------------------------------------------------------
function summarySheet(wb: ExcelJS.Workbook, r: CompanyReport) {
  const ws = wb.addWorksheet("Summary", { properties: { defaultRowHeight: 18 }, views: [{ showGridLines: false }] });
  ws.columns = [{ width: 3 }, { width: 30 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }];

  ws.mergeCells("B2:G3");
  const title = ws.getCell("B2");
  title.value = `${r.company}${r.ticker ? `  ·  ${r.ticker}` : ""}`;
  title.font = { size: 20, bold: true, color: { argb: C.bandText } };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  for (let c = 2; c <= 7; c++) {
    ws.getCell(2, c).fill = solid(C.band);
    ws.getCell(3, c).fill = solid(C.band);
  }
  ws.mergeCells("B4:G4");
  const sub = ws.getCell("B4");
  sub.value = `Corporate Governance Checklist  ·  ${r.exchange ?? "—"}${r.sector ? `  ·  ${r.sector}` : ""}  ·  run ${r.status}`;
  sub.font = { italic: true, color: { argb: C.sub } };
  sub.alignment = { indent: 1 };

  const gate = r.summary?.nonNegotiable?.gatePass;
  ws.mergeCells("B6:G6");
  const gb = ws.getCell("B6");
  const pass = gate !== false;
  gb.value = pass ? "✓  NON-NEGOTIABLE GATE: PASS" : "✕  NON-NEGOTIABLE GATE: FAIL";
  gb.font = { bold: true, size: 12, color: { argb: pass ? "FF065F46" : "FF9F1239" } };
  gb.fill = solid(pass ? C.greenSoft : C.redSoft);
  gb.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(6).height = 24;

  const totals = r.summary?.totals ?? { green: 0, red: 0, neutral: 0, na: 0 };
  const kpis: Array<[string, number | string, string, string]> = [
    ["Green flags", totals.green, C.greenSoft, "FF065F46"],
    ["Red flags", totals.red, C.redSoft, "FF9F1239"],
    ["Neutral", totals.neutral, C.amberSoft, "FF92400E"],
    ["Not available", totals.na, C.slateSoft, "FF334155"],
    ["Answered", `${r.answered}/${r.total}`, "FFEEF2FF", "FF3730A3"],
  ];
  let col = 2;
  for (const [label, val, fill, text] of kpis) {
    const head = ws.getCell(8, col);
    head.value = label;
    head.font = { bold: true, size: 10, color: { argb: text } };
    head.fill = solid(fill);
    head.alignment = { horizontal: "center" };
    box(head);
    const num = ws.getCell(9, col);
    num.value = val;
    num.font = { bold: true, size: 18, color: { argb: text } };
    num.fill = solid(fill);
    num.alignment = { horizontal: "center" };
    box(num);
    col++;
  }
  ws.getRow(9).height = 30;

  const startRow = 12;
  ["Section", "Green", "Red", "Neutral", "N/A", "Answered"].forEach((h, i) => {
    const cell = ws.getCell(startRow, 2 + i);
    cell.value = h;
    cell.font = { bold: true, color: { argb: C.bandText } };
    cell.fill = solid(C.band);
    cell.alignment = { horizontal: i === 0 ? "left" : "center", indent: i === 0 ? 1 : 0 };
    box(cell);
  });
  r.sections.forEach((s, idx) => {
    const row = startRow + 1 + idx;
    const c = s.counts;
    const cells: Array<[number, string | number, string?]> = [
      [2, `${s.code}  ${s.name}`],
      [3, c.green, c.green ? C.greenSoft : undefined],
      [4, c.red, c.red ? C.redSoft : undefined],
      [5, c.neutral, c.neutral ? C.amberSoft : undefined],
      [6, c.na, c.na ? C.slateSoft : undefined],
      [7, fmtPct(c.green + c.red + c.neutral, c.total)],
    ];
    for (const [cc, val, fill] of cells) {
      const cell = ws.getCell(row, cc);
      cell.value = val;
      cell.alignment = { horizontal: cc === 2 ? "left" : "center", indent: cc === 2 ? 1 : 0 };
      cell.font = { color: { argb: C.ink }, bold: cc !== 2 };
      if (fill) cell.fill = solid(fill);
      else if (idx % 2 === 1) cell.fill = solid(C.zebra);
      box(cell);
    }
  });
  const foot = ws.getCell(startRow + r.sections.length + 3, 2);
  foot.value = "Flags only — no numeric scoring. Generated by CG Checklist.";
  foot.font = { italic: true, size: 9, color: { argb: C.sub } };
}

// ---- Checklist (grouped by section, wrapped) --------------------------------
const NCOLS = 7; // ID, Item, Flag, Finding, Assessment, Conf, Source

function checklistSheet(wb: ExcelJS.Workbook, r: CompanyReport) {
  const ws = wb.addWorksheet("Checklist", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { key: "id", width: 9 },
    { key: "item", width: 30 },
    { key: "flag", width: 14 },
    { key: "value", width: 34 },
    { key: "verdict", width: 52 },
    { key: "conf", width: 8 },
    { key: "source", width: 14 },
  ];

  // header row
  ["ID", "Checklist item", "Flag", "Finding", "Assessment", "Conf.", "Source"].forEach((h, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: C.bandText } };
    cell.fill = solid(C.band);
    cell.alignment = { vertical: "middle", horizontal: i === 2 || i === 5 ? "center" : "left", indent: i === 2 || i === 5 ? 0 : 1 };
    box(cell);
  });
  ws.getRow(1).height = 24;

  let row = 2;
  for (const s of r.sections) {
    // section band
    ws.mergeCells(row, 1, row, NCOLS);
    for (let c = 1; c <= NCOLS; c++) {
      ws.getCell(row, c).fill = solid(C.section);
      box(ws.getCell(row, c));
    }
    const c = s.counts;
    const band = ws.getCell(row, 1);
    band.value = `${s.code}  ·  ${s.name}       ${c.green} Green · ${c.red} Red · ${c.neutral} Neutral · ${c.na} N/A`;
    band.font = { bold: true, size: 11, color: { argb: C.bandText } };
    band.alignment = { vertical: "middle", indent: 1 };
    ws.getRow(row).height = 22;
    row++;

    // items
    s.items.forEach((it, idx) => {
      const m = flagMeta(it);
      const rowObj = ws.getRow(row);
      rowObj.getCell(1).value = it.id;
      rowObj.getCell(2).value = it.item;
      rowObj.getCell(3).value = m.label;
      rowObj.getCell(4).value = it.value && it.value.toLowerCase() !== "not available" ? it.value : "—";
      rowObj.getCell(5).value = it.verdict ?? "—";
      rowObj.getCell(6).value = it.confidence != null ? `${Math.round(it.confidence * 100)}%` : "—";
      if (it.source.url) {
        const src = rowObj.getCell(7);
        src.value = { text: "open ↗", hyperlink: it.source.url } as ExcelJS.CellHyperlinkValue;
        src.font = { color: { argb: "FF2563EB" }, underline: true };
      }

      for (let cc = 1; cc <= NCOLS; cc++) {
        const cell = rowObj.getCell(cc);
        box(cell);
        const wrap = cc === 2 || cc === 4 || cc === 5;
        cell.alignment = { vertical: "top", wrapText: wrap, horizontal: cc === 3 || cc === 6 ? "center" : "left", indent: wrap || cc === 1 ? 1 : 0 };
        if (idx % 2 === 1 && cc !== 3) cell.fill = solid(C.zebra);
      }
      rowObj.getCell(1).font = { bold: true, size: 10, color: { argb: C.sub } };
      const flag = rowObj.getCell(3);
      flag.fill = solid(m.fill);
      flag.font = { bold: true, size: 10, color: { argb: C.white } };
      flag.alignment = { vertical: "middle", horizontal: "center" };
      // IMPORTANT: no explicit row height → Excel auto-fits the wrapped text.
      row++;
    });
  }
}

// ---- Watchlist --------------------------------------------------------------
function watchlistSheet(wb: ExcelJS.Workbook, r: CompanyReport) {
  const all = r.sections.flatMap((s) => s.items);
  const reds = all.filter((i) => i.flag === "RED");
  const review = all.filter((i) => i.needsReview && i.flag !== "RED");
  const ws = wb.addWorksheet("Watchlist", { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 3 }, { width: 10 }, { width: 38 }, { width: 64 }, { width: 14 }];

  ws.mergeCells("B2:E2");
  const t = ws.getCell("B2");
  t.value = reds.length ? `${reds.length} RED flag(s) need attention` : "No red flags — clean report";
  t.font = { bold: true, size: 14, color: { argb: reds.length ? "FF9F1239" : "FF065F46" } };
  t.fill = solid(reds.length ? C.redSoft : C.greenSoft);
  t.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(2).height = 26;

  let row = 4;
  const block = (titleText: string, items: ReportItem[], titleColor: string, soft: string) => {
    if (!items.length) return;
    ws.mergeCells(row, 2, row, 5);
    const h = ws.getCell(row, 2);
    h.value = titleText;
    h.font = { bold: true, color: { argb: titleColor } };
    h.fill = solid(soft);
    h.alignment = { indent: 1 };
    ws.getRow(row).height = 20;
    row++;
    ["ID", "Item", "Assessment", "Source"].forEach((hh, i) => {
      const cell = ws.getCell(row, 2 + i);
      cell.value = hh;
      cell.font = { bold: true, color: { argb: C.bandText } };
      cell.fill = solid(C.band);
      box(cell);
    });
    row++;
    for (const it of items) {
      ws.getCell(row, 2).value = it.id;
      ws.getCell(row, 3).value = it.item;
      ws.getCell(row, 4).value = it.verdict ?? it.value ?? "—";
      if (it.source.url) {
        const src = ws.getCell(row, 5);
        src.value = { text: "open ↗", hyperlink: it.source.url } as ExcelJS.CellHyperlinkValue;
        src.font = { color: { argb: "FF2563EB" }, underline: true };
      }
      for (let cc = 2; cc <= 5; cc++) {
        const cell = ws.getCell(row, cc);
        box(cell);
        cell.alignment = { vertical: "top", wrapText: cc === 3 || cc === 4, indent: 1 };
      }
      ws.getCell(row, 2).font = { bold: true, color: { argb: C.sub } };
      // no explicit height → auto-fit wrapped text
      row++;
    }
    row++;
  };
  block(`Red flags (${reds.length})`, reds, "FF9F1239", C.redSoft);
  block(`Needs review (${review.length})`, review, "FF92400E", C.amberSoft);
  if (!reds.length && !review.length) {
    ws.getCell(row, 2).value = "Nothing on the watchlist.";
    ws.getCell(row, 2).font = { italic: true, color: { argb: C.sub } };
  }
}

/** Build the workbook and return an xlsx buffer. */
export async function buildExcelReport(r: CompanyReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CG Checklist";
  wb.created = r.lastProcessedAt ? new Date(r.lastProcessedAt) : new Date(r.createdAt);
  summarySheet(wb, r);
  checklistSheet(wb, r);
  watchlistSheet(wb, r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** A safe filename like "TCS-cg-report.xlsx". */
export function reportFilename(r: CompanyReport): string {
  const base = (r.ticker || r.company || "report").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${base}-cg-report.xlsx`;
}
