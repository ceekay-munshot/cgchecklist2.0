"use client";

import { useRef, useState } from "react";
import { useAnalyzeRun } from "@/app/components/AnalyzeRun";

/**
 * Upload a private/unlisted company's documents (PDFs) and run the CG framework
 * on them. Posts to /api/unlisted/analyze (which extracts + stores the docs and
 * dispatches the analysis), then shows the same live loading modal, polling by
 * runId.
 */
export default function UnlistedUpload() {
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const { launchByRun, overlay } = useAnalyzeRun();

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const pdfs = Array.from(list).filter((f) => f.name.toLowerCase().endsWith(".pdf") || f.type.includes("pdf"));
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...pdfs.filter((f) => !seen.has(f.name + f.size))];
    });
  };

  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setSkipped([]);
    try {
      const fd = new FormData();
      fd.append("name", name.trim());
      for (const f of files) fd.append("files", f);
      const res = await fetch("/api/unlisted/analyze", { method: "POST", body: fd });
      const data = (await res.json()) as {
        runId?: string;
        skipped?: string[];
        dispatched?: boolean;
        dispatchError?: string;
        error?: string;
      };
      if (!res.ok || !data.runId) throw new Error(data.error ?? "Upload failed.");
      if (data.skipped?.length) setSkipped(data.skipped);
      launchByRun(data.runId, { label: name.trim(), dispatched: data.dispatched, dispatchError: data.dispatchError });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

  return (
    <>
      <form onSubmit={submit} className="rise mt-8 flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Company name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Private Limited"
            className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm font-medium text-slate-800 shadow-sm outline-none transition placeholder:font-normal placeholder:text-slate-400 focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Documents (PDF)</span>
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
            className={`grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-6 py-9 text-center transition ${
              dragging ? "border-indigo-400 bg-indigo-50/60" : "border-slate-300 bg-white/50 hover:border-indigo-300 hover:bg-slate-50"
            }`}
          >
            <div className="text-2xl">📄</div>
            <p className="mt-2 text-sm font-medium text-slate-700">
              Drop annual report / financial statements here, or <span className="text-indigo-600">browse</span>
            </p>
            <p className="mt-1 text-xs text-slate-400">Text-based PDFs · up to 15 MB each</p>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
          </div>
        </div>

        {files.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {files.map((f, i) => (
              <li key={f.name + f.size} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                <span className="text-slate-400">📄</span>
                <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{f.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-slate-400">{fmtSize(f.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  aria-label={`Remove ${f.name}`}
                  className="shrink-0 rounded-md px-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || !name.trim() || files.length === 0}
            className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Starting…" : "Analyse documents →"}
          </button>
          {files.length > 0 && <span className="text-xs text-slate-400">{files.length} file(s) ready</span>}
        </div>
      </form>

      {error && <p className="mt-3 text-sm font-medium text-rose-600">⚠️ {error}</p>}
      {skipped.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          Some files were skipped: {skipped.join("; ")}.
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        Unlisted analysis reads only your uploaded documents — market and listing items (stock, free float, research coverage) and
        the financial-database ratios show “Not available”. Everything the documents disclose (board, committees, related parties,
        contingent liabilities, auditor, remuneration) is analysed in full.
      </p>
      {overlay}
    </>
  );
}
