import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "CG Checklist — Corporate Governance Analysis",
  description:
    "Flag-based corporate governance checklist analysis for Indian listed companies (SEBI LODR / Ind AS).",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <header className="sticky top-0 z-40 border-b border-white/60 bg-white/70 backdrop-blur-xl">
          <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-300">
                <span className="text-base">◆</span>
              </span>
              <span className="font-semibold tracking-tight text-slate-900">
                CG&nbsp;Checklist
                <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600 ring-1 ring-indigo-100">
                  beta
                </span>
              </span>
            </Link>
            <div className="flex items-center gap-1 text-sm font-medium text-slate-600">
              <Link href="/" className="rounded-lg px-3 py-1.5 transition hover:bg-slate-100 hover:text-slate-900">
                Reports
              </Link>
              <Link href="/health" className="rounded-lg px-3 py-1.5 transition hover:bg-slate-100 hover:text-slate-900">
                Health
              </Link>
            </div>
          </nav>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-slate-200/70 py-6 text-center text-xs text-slate-400">
          Flags only — no numeric scoring · SEBI LODR / Ind AS framework
        </footer>
      </body>
    </html>
  );
}
