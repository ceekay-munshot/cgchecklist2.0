# PROJECT BRIEF — CG Checklist 2.0

> **Read this file first, every session.** It is the source of truth for what we
> are building, how the repo is structured, and the conventions to follow.
>
> Also read **`AGENTS.md`** / **`CLAUDE.md`**: this project runs on a
> **customized Next.js 16** — "NOT the Next.js you know." Before writing any
> Next.js code, read the relevant guide under `node_modules/next/dist/docs/`
> and heed deprecation notices.

---

## 0. North stars (read first — these shape every design choice)

**1. Acquisition is FULLY AUTOMATED — no manual upload in the primary flow.**
The analyst supplies only a company (name / ticker / exchange). The system
harvests documents itself:
- **Screener.in via Playwright**, using credentials from env
  (`SCREENER_EMAIL`, `SCREENER_PASSWORD`, sourced from GitHub secrets).
- **Web research (Firecrawl → Scrape.do)** covers subsidiaries / private cos.
- **NO manual upload in the primary flow.** Manual upload is a **DEFERRED
  fallback only** — keep a clean interface seam (`SourceDocType.MANUAL_UPLOAD`,
  `FetchedVia.MANUAL`) but build **no upload UI now**.

**2. A run is a LONG-LIVED, RESUMABLE, QUOTA-AWARE BATCH (may span ~5–6 days).**
Processing runs on **free-tier LLMs under daily rate limits**, so a run is never
"all at once":
- Per-item processing state: `ItemResult.status`
  (`PENDING | PROCESSING | DONE | ERROR | DEFERRED | NEEDS_REVIEW`), `attempts`,
  `lastError`, `processedAt` — so a run resumes exactly where it paused.
- Per-provider daily usage: `ProviderUsage(provider, date)` → `requests`,
  `tokens` — so the batch stays under free-tier quotas.
- `RunStatus.PARTIAL` = paused, waiting for the next day's quota.

---

## 1. What we are building

An internal **Corporate Governance (CG) Checklist** analysis dashboard for
**Indian listed companies** (SEBI LODR / Ind AS framework). It:

1. Ingests a company's **annual report + filings**.
2. Evaluates **~106 governance checklist items**.
3. Produces a **flag-based report** — **NO numeric scoring** — where each item has:
   - a **flag**: `GREEN` / `RED` / `NEUTRAL` / `NOT_AVAILABLE`
   - a **one-liner verdict**
   - **evidence**
   - a **source** (citation)
4. Is **exportable to Excel and PPT/PDF**.

### Non-negotiables
- **No numeric scoring anywhere.** Flags only.
- **Never hardcode API keys.** Everything comes from env (see `.env.example`).
- Every structured LLM call goes through `completeJSON` with **JSON-schema
  validation + 2 retries** on invalid JSON.
- Web research uses a **fallback chain** and returns a typed `not_available`
  instead of throwing.

---

## 2. Stack & versions

- **Next.js 16.2.9** — App Router, Turbopack by default. **Customized build**
  (ships docs in `node_modules/next/dist/docs/`).
- **React 19.2**, **TypeScript 5.9**, **Tailwind CSS v4** (CSS-first `@theme`,
  no `tailwind.config.js`).
- **Postgres** via **Prisma 6** (`prisma-client-js`; client imported from
  `@prisma/client`).
- **ajv** for JSON-schema validation.

### Next.js 16 gotchas already handled (keep following these)
- `next lint` is **removed** → `npm run lint` runs `eslint` directly.
- Async request APIs (`cookies` / `headers` / `params` / `searchParams`) are
  **Promises** — always `await` them.
- `serverRuntimeConfig` / `publicRuntimeConfig` **removed** → read
  `process.env` directly in server code.
- To force request-time rendering (fresh env + live data), use
  `await connection()` from `next/server` — **not** the deprecated
  `export const dynamic` (removed under Cache Components).
- `@prisma/client` is **auto-externalized** by Next; no `serverExternalPackages`
  entry needed.

---

## 3. Folder layout

```
app/                     # App Router
  page.tsx               # dashboard landing
  layout.tsx             # root layout + nav
  health/
    page.tsx             # /health — server-rendered statuses
    HealthDashboard.tsx  # client component (live refresh)
  api/health/route.ts    # GET → JSON health of all providers + DB
lib/
  db.ts                  # Prisma client singleton
  health.ts              # aggregates provider + DB health
  health-types.ts        # ProviderStatus + interpretHttpPing (shared)
  checklist.ts           # checklist loaders + itemKind (NUMERIC|QUALITATIVE)
  llm/                   # LLM provider clients — ONE LlmClient interface
    types.ts             # CompleteOpts, LlmClient, ProviderModule, errors
    json.ts              # JSON extraction + ajv validation + retry driver
    openai-compatible.ts # factory for Groq/Mistral/Nvidia
    gemini.ts groq.ts mistral.ts nvidia.ts
    index.ts             # registry + role-based router (`llm`)
  scrape/                # web researchers — ONE WebResearcher interface
    types.ts firecrawl.ts scrapedo.ts index.ts
  ingest/                # document ingestion (STUB)
  engine/                # checklist evaluation engine (STUB)
  orchestrate/           # end-to-end pipeline (STUB)
  export/                # Excel / PDF / PPTX writers (STUB)
data/                    # checklist.json (16 sections / 106 items)
prisma/                  # schema.prisma + migrations/ + seed.mts
```

---

## 4. Provider routing  (record + obey)

| Provider | Role key | Used for |
| --- | --- | --- |
| **Gemini** | `longContext` | Long-context document reading (annual reports, auditor notes) |
| **Groq** | `bulkClassify` | Fast / cheap bulk classification across many items |
| **Mistral** | `reasoning` | Qualitative reasoning + tie-breaks |
| **Nvidia NIM** | `fallback` | Fallback capacity |
| **Firecrawl → Scrape.do** | — | Web research fallback chain |

**Select an LLM by role, not by name**, so the table can change in one place:

```ts
import { llm } from "@/lib/llm";
await llm.longContext.completeJSON(opts, schema); // Gemini
await llm.bulkClassify.complete(opts);            // Groq
```

---

## 5. Core interfaces

### `LlmClient` (`lib/llm/types.ts`)
```ts
interface LlmClient {
  complete(opts): Promise<{ text: string }>;
  completeJSON<T>(opts, schema: object): Promise<T>; // JSON-schema validated, 2 retries
}
```
Implemented by `gemini.ts` (native Generative Language API) and
`groq.ts` / `mistral.ts` / `nvidia.ts` (OpenAI-compatible, via
`createOpenAICompatibleProvider`). Each module also exports `isConfigured()`
and `ping()` for `/health`. Keys/models are read from env **at call time**.

### `WebResearcher` (`lib/scrape/types.ts`)
```ts
interface WebResearcher {
  fetchUrl(url): Promise<FetchResult>;   // { status: "ok" | "not_available", ... }
  search(query): Promise<SearchResult>;
}
```
`lib/scrape/index.ts` exports `webResearcher`, which tries **Firecrawl** then
**Scrape.do**, returning a typed `not_available` if both fail. (Scrape.do has no
search API, so its `search()` is always `not_available`.)

---

## 6. Data model (Prisma — flag-based, NO score field anywhere)

**Reference data** (seeded idempotently from `data/checklist.json`):
- **`ChecklistSection`** (16) — `code`, `name`.
- **`ChecklistItem`** (106) — mirrors the JSON: `item`, `description`,
  `outputFormat`, `greenFlag`, `redFlag`, `sourceHint`, `isNonNegotiable`,
  `thresholdLogic`. PK = the JSON item id (e.g. `A1-01`).

**Run data:**
- **`Company`** — `name`, `ticker`, `exchange` (NSE|BSE), `sector`, `cin?`,
  `screenerUrl?`. (Analyst supplies only this; docs are harvested.)
- **`AnalysisRun`** — `status` (QUEUED|HARVESTING|PROCESSING|PARTIAL|DONE|ERROR),
  `createdBy?`, `createdAt`, `lastProcessedAt?`,
  `itemsTotal`/`itemsDone`/`itemsError`, `summaryJson?`.
- **`SourceDoc`** — harvested doc: `type`, `name`, `sourceUrl`, `fetchedVia`,
  `fetchStatus`, `storageRef?`, `pages?`.
- **`ItemResult`** — resumable per-item state, unique `(runId, itemId)`:
  `status`, `flag?`, `verdict?`, `value?`, `evidenceQuote?`, `sourceDocId?`,
  `confidence?`, `isNonNegotiable`, `gatePass?`, `providerUsed?`, `attempts`,
  `lastError?`, `processedAt?`, `analystOverride`, `overrideNote?`.
  **No score field.**
- **`ProviderUsage`** — free-tier quota, unique `(provider, date)`: `requests`,
  `tokens`.

Enums: `Flag`, `Exchange`, `RunStatus`, `SourceDocType`, `FetchedVia`,
`FetchStatus`, `ItemStatus`. See `prisma/schema.prisma`; migrations in
`prisma/migrations/`.

---

## 7. Environment variables (`.env.example`)

`GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `NVIDIA_API_KEY`,
`FIRECRAWL_API_KEY`, `SCRAPEDO_API_KEY`, `SCREENER_EMAIL`, `SCREENER_PASSWORD`,
`DATABASE_URL`.
Optional model overrides: `GEMINI_MODEL`, `GROQ_MODEL`, `MISTRAL_MODEL`,
`NVIDIA_MODEL`. Copy `.env.example` → `.env` and fill in. `/health` shows any
blank provider as **not configured**. `SCREENER_*` feed the Phase-3 Playwright
harvester (sourced from GitHub secrets in CI).

---

## 8. Commands

```
npm run dev          # dev server (Turbopack)   → http://localhost:3000
npm run build        # production build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run db:migrate   # prisma migrate dev
npm run db:generate  # prisma generate
npm run db:studio    # prisma studio
npm run db:seed      # prisma db seed (loads data/checklist.json)
npm test             # vitest run
```

Pages: `/` (dashboard), `/health` (provider statuses), `/api/health` (JSON).

---

## 9. Status & next steps

**Done (Phase 1):** project scaffold; `lib/llm` (4 providers behind one
interface + JSON-schema validation + role router); `lib/scrape` (Firecrawl →
Scrape.do fallback); `/health` page + `/api/health`; `.env.example`; this brief.

**Done (Phase 2 — data model):** reconciled Prisma schema for the automated,
resumable, quota-aware design (ChecklistSection/ChecklistItem mirroring
`data/checklist.json`; Company w/ ticker+exchange+screenerUrl; AnalysisRun w/
new status enum + counters + summaryJson; SourceDoc; resumable ItemResult;
ProviderUsage) + fresh `init` migration; `SCREENER_*` env added.

**Done (Phase 2b — checklist):** `data/checklist.json` (the real **Daksham CG
Checklist**, 16 sections / 106 items) is committed and seeded. `lib/checklist.ts`
(`getSections`/`getItems`/`getItem`/`itemKind`) + idempotent `prisma/seed.mts`
load it (`npm run db:seed` → 16 sections / 106 items, re-runnable). vitest (6/6)
covers `itemKind` on the five samples (A1-01, A3-02, A13-02, A2-01, A8-01), the
106 / 16 counts, and id uniqueness.

**Later phases:** `lib/ingest` (extract PDFs/filings), `lib/engine`
(`evaluateItem`), `lib/orchestrate` (resumable `runAnalysis` + persistence +
quota gating), `lib/export` (xlsx/pdf/pptx); **Phase 3** Playwright Screener
harvester.

---

## 10. Local environment notes (this sandbox)

- A local Postgres 16 cluster is used for development
  (`DATABASE_URL=postgresql://cg:cg@localhost:5432/cgchecklist`).
- The egress proxy blocks Prisma's **engine binary download** (it bypasses the
  proxy). If `npm install` fails on `@prisma/engines` postinstall, install with
  `--ignore-scripts` and fetch the engines for the
  `debian-openssl-3.0.x` target from `https://binaries.prisma.sh/all_commits/<enginesVersion>/...`
  with `curl` (which honors the proxy). In a normal environment a plain
  `npm install` handles engines automatically — do **not** commit engine paths.

---

## 11. Acceptance (initial session) — ✔

`npm run dev` boots · `/health` renders provider statuses · the Prisma schema
migrates · `PROJECT_BRIEF.md` exists.
