import ExcelJS from "exceljs";
import type { CompanyReport, ReportItem, FlagName } from "@/lib/report";

/**
 * Build a polished, colour-graded multi-sheet .xlsx of a company's CG report.
 * Sheets: Summary (KPIs + section heat-map), All Items (the full checklist,
 * filterable), Watchlist (reds / needs-review / non-negotiable fails).
 */

// ---- palette (ARGB) ---------------------------------------------------------
const C = {
  ink: "FF0F172A", // slate-900
  sub: "FF475569", // slate-600
  line: "FFE2E8F0", // slate-200
  zebra: "FFF8FAFC", // slate-50
  band: "FF1E1B4B", // indigo-950 (header band)
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
  NOT_AVAILABLE: { label: "NOT AVAILABLE", emoji: "▫️", fill: C.slate, soft: C.slateSoft, text: "FF334155" },
  NONE: { label: "PENDING", emoji: "•", fill: C.slate, soft: C.slateSoft, text: "FF334155" },
};

function flagMeta(it: ReportItem) {
  return FLAG_META[(it.flag ?? "NONE") as FlagName | "NONE"];
}

const thin = { style: "thin" as const, color: { argb: C.line } };
const ALL_BORDERS = { top: thin, left: thin, bottom: thin, right: thin };

function box(cell: ExcelJS.Cell) {
  cell.border = ALL_BORDERS;
}

function fmtPct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

// ---- sheets -----------------------------------------------------------------

function summarySheet(wb: ExcelJS.Workbook, r: CompanyReport) {
  const ws = wb.addWorksheet("Summary", {
    properties: { defaultRowHeight: 18 },
    views: [{ showGridLines: false }],
  });
  ws.columns = [{ width: 3 }, { width: 26 }, { width: 16 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }];

  // Title band
  ws.mergeCells("B2:G3");
  const title = ws.getCell("B2");
  title.value = `${r.company}${r.ticker ? `  ·  ${r.ticker}` : ""}`;
  title.font = { name: "Calibri", size: 20, bold: true, color: { argb: C.bandText } };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  for (let c = 2; c <= 7; c++) {
    ws.getCell(2, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.band } };
    ws.getCell(3, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.band } };
  }
  ws.mergeCells("B4:G4");
  const sub = ws.getCell("B4");
  sub.value = `Corporate Governance Checklist  ·  ${r.exchange ?? "—"}${r.sector ? `  ·  ${r.sector}` : ""}  ·  run ${r.status}`;
  sub.font = { italic: true, color: { argb: C.sub } };
  sub.alignment = { indent: 1 };

  // Gate banner
  const gate = r.summary?.nonNegotiable?.gatePass;
  ws.mergeCells("B6:G6");
  const gb = ws.getCell("B6");
  const gatePass = gate !== false;
  gb.value = gatePass ? "✓  NON-NEGOTIABLE GATE: PASS" : "✕  NON-NEGOTIABLE GATE: FAIL";
  gb.font = { bold: true, size: 12, color: { argb: gatePass ? "FF065F46" : "FF9F1239" } };
  gb.fill = { type: "pattern", pattern: "solid", fgColor: { argb: gatePass ? C.greenSoft : C.redSoft } };
  gb.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(6).height = 24;

  // KPI cards (row 8)
  const totals = r.summary?.totals ?? { green: 0, red: 0, neutral: 0, na: 0 };
  const kpis: Array<[string, number | string, string, string]> = [
    ["🟢 Green", totals.green, C.greenSoft, "FF065F46"],
    ["🔴 Red", totals.red, C.redSoft, "FF9F1239"],
    ["⚪ Neutral", totals.neutral, C.amberSoft, "FF92400E"],
    ["▫️ Not available", totals.na, C.slateSoft, "FF334155"],
    ["✅ Answered", `${r.answered}/${r.total}`, "FFEEF2FF", "FF3730A3"],
  ];
  let col = 2;
  for (const [label, val, fill, text] of kpis) {
    const head = ws.getCell(8, col);
    head.value = label;
    head.font = { bold: true, size: 10, color: { argb: text } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    head.alignment = { horizontal: "center" };
    box(head);
    const num = ws.getCell(9, col);
    num.value = val;
    num.font = { bold: true, size: 18, color: { argb: text } };
    num.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    num.alignment = { horizontal: "center" };
    box(num);
    col++;
  }
  ws.getRow(9).height = 30;

  // Section heat-map table
  const startRow = 12;
  const headers = ["Section", "🟢", "🔴", "⚪", "▫️", "Answered"];
  headers.forEach((h, i) => {
    const cell = ws.getCell(startRow, 2 + i);
    cell.value = h;
    cell.font = { bold: true, color: { argb: C.bandText } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.band } };
    cell.alignment = { horizontal: i === 0 ? "left" : "center", indent: i === 0 ? 1 : 0 };
    box(cell);
  });
  r.sections.forEach((s, idx) => {
    const row = startRow + 1 + idx;
    const c = s.counts;
    const answered = c.green + c.red + c.neutral;
    const cells: Array<[number, string | number, string?]> = [
      [2, `${s.code}  ${s.name}`],
      [3, c.green, c.green ? C.greenSoft : undefined],
      [4, c.red, c.red ? C.redSoft : undefined],
      [5, c.neutral, c.neutral ? C.amberSoft : undefined],
      [6, c.na, c.na ? C.slateSoft : undefined],
      [7, fmtPct(answered, c.total)],
    ];
    for (const [cc, val, fill] of cells) {
      const cell = ws.getCell(row, cc);
      cell.value = val;
      cell.alignment = { horizontal: cc === 2 ? "left" : "center", indent: cc === 2 ? 1 : 0 };
      cell.font = { color: { argb: C.ink }, bold: cc !== 2 };
      if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      else if (idx % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.zebra } };
      box(cell);
    }
  });

  ws.getCell(startRow + r.sections.length + 3, 2).value = "Flags only — no numeric scoring. Generated by CG Checklist.";
  ws.getCell(startRow + r.sections.length + 3, 2).font = { italic: true, size: 9, color: { argb: C.sub } };
}

function itemRows(ws: ExcelJS.Worksheet, rows: ReportItem[], startRow: number) {
  rows.forEach((it, idx) => {
    const m = flagMeta(it);
    const row = ws.getRow(startRow + idx);
    row.values = {
      section: it.sectionCode,
      id: it.id,
      item: it.item,
      flag: `${m.emoji} ${m.label}`,
      value: it.value && it.value.toLowerCase() !== "not available" ? it.value : it.verdict ?? "—",
      verdict: it.verdict ?? "—",
      conf: it.confidence != null ? `${Math.round(it.confidence * 100)}%` : "—",
      source: it.source.url ?? "",
    } as Record<string, ExcelJS.CellValue>;
    row.height = 30;
    row.eachCell((cell, col) => {
      box(cell);
      cell.alignment = { vertical: "middle", wrapText: col === 3 || col === 5 || col === 6, indent: 1 };
      if (idx % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.zebra } };
    });
    // colour the flag cell + id strongly
    const flagCell = row.getCell(4);
    flagCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: m.soft } };
    flagCell.font = { bold: true, color: { argb: m.text } };
    flagCell.alignment = { vertical: "middle", horizontal: "center" };
    row.getCell(2).font = { bold: true, color: { argb: C.sub } };
    if (it.source.url) {
      const src = row.getCell(8);
      src.value = { text: "open source ↗", hyperlink: it.source.url } as ExcelJS.CellHyperlinkValue;
      src.font = { color: { argb: "FF2563EB" }, underline: true };
    }
  });
}

function itemsSheet(wb: ExcelJS.Workbook, r: CompanyReport) {
  const ws = wb.addWorksheet("All Items", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Sec", key: "section", width: 7 },
    { header: "ID", key: "id", width: 9 },
    { header: "Checklist item", key: "item", width: 34 },
    { header: "Flag", key: "flag", width: 18 },
    { header: "Value", key: "value", width: 40 },
    { header: "Verdict", key: "verdict", width: 46 },
    { header: "Conf.", key: "conf", width: 8 },
    { header: "Source", key: "source", width: 16 },
  ];
  const header = ws.getRow(1);
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: C.bandText } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.band } };
    cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    box(cell);
  });
  const all = r.sections.flatMap((s) => s.items);
  itemRows(ws, all, 2);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } };
}

function watchlistSheet(wb: ExcelJS.Workbook, r: CompanyReport) {
  const all = r.sections.flatMap((s) => s.items);
  const reds = all.filter((i) => i.flag === "RED");
  const review = all.filter((i) => i.needsReview && i.flag !== "RED");
  const ws = wb.addWorksheet("Watchlist", { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 3 }, { width: 10 }, { width: 40 }, { width: 60 }, { width: 16 }];

  ws.mergeCells("B2:E2");
  const t = ws.getCell("B2");
  t.value = reds.length ? `⚠  ${reds.length} RED flag(s) need attention` : "✓  No red flags — clean report";
  t.font = { bold: true, size: 14, color: { argb: reds.length ? "FF9F1239" : "FF065F46" } };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: reds.length ? C.redSoft : C.greenSoft } };
  t.alignment = { vertical: "middle", indent: 1 };
  ws.getRow(2).height = 26;

  let row = 4;
  const block = (titleText: string, items: ReportItem[], titleColor: string, soft: string) => {
    if (!items.length) return;
    ws.mergeCells(row, 2, row, 5);
    const h = ws.getCell(row, 2);
    h.value = titleText;
    h.font = { bold: true, color: { argb: titleColor } };
    h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: soft } };
    h.alignment = { indent: 1 };
    row++;
    ["ID", "Item", "Verdict", "Source"].forEach((hh, i) => {
      const cell = ws.getCell(row, 2 + i);
      cell.value = hh;
      cell.font = { bold: true, color: { argb: C.bandText } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.band } };
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
      for (let c = 2; c <= 5; c++) {
        const cell = ws.getCell(row, c);
        box(cell);
        cell.alignment = { vertical: "middle", wrapText: c === 3 || c === 4, indent: 1 };
      }
      ws.getRow(row).height = 28;
      row++;
    }
    row++;
  };
  block(`🔴  Red flags (${reds.length})`, reds, "FF9F1239", C.redSoft);
  block(`🟠  Needs review (${review.length})`, review, "FF92400E", C.amberSoft);
  if (!reds.length && !review.length) {
    ws.getCell(row, 2).value = "Nothing on the watchlist. 🎉";
    ws.getCell(row, 2).font = { italic: true, color: { argb: C.sub } };
  }
}

/** Build the workbook and return an xlsx buffer. */
export async function buildExcelReport(r: CompanyReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CG Checklist";
  wb.created = r.lastProcessedAt ? new Date(r.lastProcessedAt) : new Date(r.createdAt);
  summarySheet(wb, r);
  itemsSheet(wb, r);
  watchlistSheet(wb, r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** A safe filename like "TCS-cg-report.xlsx". */
export function reportFilename(r: CompanyReport): string {
  const base = (r.ticker || r.company || "report").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${base}-cg-report.xlsx`;
}
