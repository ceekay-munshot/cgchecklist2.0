import Link from "next/link";
import UnlistedUpload from "@/app/components/UnlistedUpload";

export const metadata = { title: "Analyse an unlisted company — CG Checklist" };

export default function UnlistedNewPage() {
  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <Link href="/" className="text-sm font-medium text-slate-400 transition hover:text-slate-700">
        ← All reports
      </Link>
      <section className="rise mt-4">
        <span className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-indigo-600 ring-1 ring-indigo-100">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" /> Unlisted company
        </span>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900">Analyse a private company</h1>
        <p className="mt-3 leading-relaxed text-slate-600">
          Upload its annual report or financial statements (PDF) and we&apos;ll run the same governance checklist on those
          documents — same flags, evidence, and sources.
        </p>
        <UnlistedUpload />
      </section>
    </div>
  );
}
