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
- **Harvest ONCE, then iterate offline.** Harvested documents persist to a real
  database — hosted **Neon Postgres** in CI via the `DATABASE_URL` secret — so
  Screener is scraped **once**. Re-running a harvest is **idempotent**: it
  reuses rows (unique `(runId, sourceUrl)`), refreshes the page's
  `structuredData`, and only re-fetches missing/FAILED documents (a second run
  is cheap and never re-downloads what we already have).

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
- **Harvester (Phase 3):** `playwright-core` (uses the preinstalled Chromium),
  `cheerio` (pure HTML parsing), `unpdf` (PDF text + page map), `tsx` (run TS
  scripts/CLI).

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
  usage.ts               # ProviderUsage (per-provider daily quota) helper
  harvest/               # Phase-3 Screener harvester (Playwright + cheerio)
    browser.ts           # one reused logged-in Chromium context (login, fetch, download)
    parse.ts             # pure cheerio parsers (structured data + doc links) — tested
    documents.ts         # download + unpdf text extract, WebResearcher fallback
    index.ts             # harvestCompany() orchestrator (idempotent, resilient)
    types.ts
  llm/                   # LLM provider clients — ONE LlmClient interface
    types.ts             # CompleteOpts, LlmClient, ProviderModule, errors
    json.ts              # JSON extraction + ajv validation + retry driver
    openai-compatible.ts # factory for Groq/Mistral/Nvidia
    gemini.ts groq.ts mistral.ts nvidia.ts
    index.ts             # registry + role-based router (`llm`)
  scrape/                # web researchers — ONE WebResearcher interface
    types.ts firecrawl.ts scrapedo.ts index.ts
  ingest/                # document ingestion (STUB)
  engine/                # analysis CORE: evidence → analyze → flag (tested)
    thresholds.ts        # deterministic numeric band parser (pure)
    types.ts             # EngineItem, Evidence, Analysis, FlagResult, ItemEvaluation
    evidence.ts          # getEvidence — route to Screener structuredData / docs / web
    analyzeItem.ts       # extract a concise fact (direct-map / Groq / Mistral / Gemini)
    flag.ts              # assignFlag — numeric bands (deterministic) + qualitative judge + NN gate
    evaluateItem.ts      # getEvidence → analyzeItem → assignFlag → upsert ItemResult
    llm.ts               # role-routed completeJSON + ProviderUsage tracking
  orchestrate/           # resumable, quota-aware batch over a run (tested)
    run.ts               # runAnalysis(runId) + drainQueue + summarize + prune
    index.ts
    quota.ts             # (in lib/engine) per-provider daily caps + fallback gating
  export/                # Excel / PDF / PPTX writers (STUB)
data/                    # checklist.json (16 sections / 106 items)
prisma/                  # schema.prisma + migrations/ + seed.mts
scripts/                 # harvest.ts (npm run harvest), analyze-validate.ts (npm run analyze),
                         #   analyze-run.ts (npm run analyze-run — full 106-item batch)
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
- **`AnalysisRun`** — `status` (QUEUED|HARVESTING|HARVESTED|PROCESSING|PARTIAL|DONE|ERROR),
  `createdBy?`, `createdAt`, `lastProcessedAt?`,
  `itemsTotal`/`itemsDone`/`itemsError`, `summaryJson?`.
- **`SourceDoc`** — harvested doc, unique `(runId, sourceUrl)` so re-runs upsert
  (never duplicate): `type`, `name`, `sourceUrl`, `fetchedVia`, `fetchStatus`,
  `storageRef?`, `pages?`, `structuredData?` (Tier-1 typed JSON),
  `extractedText?` (Tier-2 durable text), `contentHash?` (sha256 — de-dups
  identical docs within a run, e.g. concall "REC" landing pages → the first is
  stored, later identical ones become lightweight OK markers).
- **`ItemResult`** — resumable per-item state, unique `(runId, itemId)`:
  `status`, `flag?`, `verdict?`, `value?`, `evidenceQuote?`, `sourceDocId?`,
  `sourcePage?`, `sourceUrl?` (self-contained citation that survives text
  pruning), `confidence?`, `isNonNegotiable`, `gatePass?`, `providerUsed?`,
  `attempts`, `lastError?`, `processedAt?`, `analystOverride`, `overrideNote?`.
  **No score field.**
  - `AnalysisRun.summaryJson` (set on completion) = per-section flag rollups
    (green/red/neutral/NA), `totalReds`, and the **non-negotiable gate**
    (`gatePass=false` if ANY non-negotiable item is RED). On `DONE` the heavy
    `SourceDoc.extractedText` is pruned (kept while in-progress / PARTIAL).
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

**`DATABASE_URL` is REQUIRED** and points at the **persistent** Postgres — a
hosted **Neon** database in CI (set as a GitHub secret), a local Postgres in dev
— so a harvest is written once and analysis iterates against it offline. (The CI
workflow can fall back to a throwaway service-container DB for pure smoke tests;
see §10.)

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
npm run harvest -- <TICKER> [NSE|BSE]   # Phase-3 Screener harvest of one company
npm run analyze -- <TICKER>             # Phase-4 analysis core on a company's latest run
npm run analyze-run -- <TICKER|runId>   # Phase-5 FULL 106-item resumable batch (no arg = drain queue)
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

**Done (Phase 3 — Screener harvester):** two-tier, fully-automated acquisition
in `lib/harvest/` + CLI `scripts/harvest.ts` (`npm run harvest -- <TICKER>`):
- **Tier 1** — Playwright logs in (creds from env) and fetches the rendered
  company page; a pure cheerio parser (`parse.ts`) extracts top ratios,
  P&L/BS/CF/ratios tables, quarters, shareholding incl. **pledged %**, peers,
  pros/cons → one `SCREENER_PAGE` SourceDoc with rich `structuredData` (answers
  most NUMERIC items, ~zero LLM).
- **Tier 2** — discovers annual reports / concalls / credit ratings /
  announcements, downloads each (browser → WebResearcher fallback), extracts
  text + page count via `unpdf` → one SourceDoc each with durable
  `extractedText` (persists for processing days later).
- `harvestCompany({companyId, runId})` sets `status=HARVESTING`, runs Tier 1 →
  Tier 2, leaves the run `HARVESTED` (acquisition complete, ready for
  processing). **Idempotent + resumable** (upsert
  by `(runId, sourceUrl)`; skips OK, retries FAILED). **Graceful** — never
  crashes; login/table/download failures become FAILED/EMPTY + a `note`. Tracks
  `ProviderUsage("screener")`; one reused logged-in context per harvest + polite
  rate-limit; prefers the preinstalled Chromium.

**Done (Phase 3b — harvest hardening / lock):** the harvester is now safe to
build analysis on top of.
- **Persistent DB.** The CI workflow writes to the `DATABASE_URL` secret
  (hosted Neon) by default and runs `prisma migrate deploy` (never reset) +
  idempotent `db:seed` — Screener is scraped **once**, analysis iterates offline.
  A `workflow_dispatch` boolean `ephemeral` (default false) falls back to a
  throwaway `postgres:16` service container for smoke tests.
- **Idempotent re-runs.** `harvestCompany` always refreshes Tier-1
  `structuredData` (one cheap request; keeps the stored OK page if the refresh
  fails) and only re-fetches missing/FAILED Tier-2 docs — a second run never
  re-downloads what is already OK.
- **Harvest hygiene.** The parser drops "View all"/"All" listing links (no more
  stray ~12k-char listing SourceDoc) and ranks concall links
  transcript→PPT→notes→…→recording so the per-category cap keeps the richest
  docs; Tier 2 de-duplicates identical documents by `contentHash` (sha256) so
  duplicate concall "REC" landing pages don't persist (or re-download) twice.

**Done (Phase 4 — analysis core):** `lib/engine` turns harvested SourceDocs into
flag-based ItemResults — `evaluateItem(item, runId)` = `getEvidence` →
`analyzeItem` → `assignFlag`. Validated on ~6 TCS items via
`analyze-validate.yml` (NOT the full 106, NOT the daily orchestration yet).

Key design choices (record + obey):
- **Token-thrift / retrieve-then-judge.** NEVER feed a whole 300-page report to
  an LLM. `getEvidence` routes by item: **NUMERIC** → read the Tier-1
  `SCREENER_PAGE` `structuredData` (ratios / shareholding / P&L / BS / CF; D/E
  falls back to *computing* Borrowings ÷ (Equity + Reserves) from the balance
  sheet); **document items** (incl. numeric-from-document like board
  independence) → keyword-score the stored `extractedText` per page and return
  only the top passages (capped ~6k chars) with `(sourceDocId + page)`
  citations; **fallback** → WebResearcher (Firecrawl → Scrape.do), else
  "not available".
- **Provider routing (analysis):** Groq = cheap structured extraction (e.g.
  board counts); Mistral = qualitative judgment; Gemini = long passage sets
  (>12k chars); Nvidia = fallback. Tier-1 numerics are **direct-mapped — zero
  LLM**. Every structured call is schema-validated (`completeJSON`, 2 retries)
  and tracked in `ProviderUsage`.
- **Flags, never scores.** NUMERIC flags are **deterministic**: `thresholds.ts`
  parses the `green_flag`/`red_flag` bands (`<0.5–1.0`, `>25%`, `≥50%`, ranges)
  into comparable thresholds — green if it meets the green band, red if the red
  band, else neutral (unit-tested on the real seeded bands). QUALITATIVE flags
  are LLM-judged against the green/red descriptions → flag + one-sentence reason.
  "not available" → `NOT_AVAILABLE`. `confidence` is a model confidence
  (mapped to a Float on persist), **not** a governance score.
- **Non-negotiable gate.** `gatePass` = green→true / red→false / else null. A RED
  on a non-negotiable qualitative item is cross-checked by a second, cheaper
  model; RED is confirmed only if both agree, else it becomes NEUTRAL + "needs
  review". (The seeded checklist currently has 0 non-negotiable items, so this is
  unit-tested with a synthetic item.)
- **Resumable.** `evaluateItem` upserts the `ItemResult` by `(runId, itemId)`
  (status DONE / NEEDS_REVIEW / ERROR, `attempts++`), so the later orchestrator
  resumes per-item.

**Done (Phase 5 — orchestration):** `lib/orchestrate` runs the FULL 106-item
batch for a run — `runAnalysis(runId)` evaluates every item via
`evaluateItem` (Phase 4). Validated on real TCS data via `analyze-run.yml`
(manual trigger; scheduling is a one-line `cron` add later).
- **Resumable.** Processes only non-terminal items (PENDING / ERROR / DEFERRED);
  skips DONE / NEEDS_REVIEW — a re-run continues where it stopped.
  Concurrency-limited (`p-limit`, `ANALYZE_CONCURRENCY` default **2** — low
  enough to stay under free-tier per-minute limits) with a long 429 backoff
  (**5s → 15s → 30s**, base `LLM_BACKOFF_MS`) that rides out transient rate
  limits within the run so the call succeeds instead of deferring.
- **Quota-aware (the free-tier engine).** `lib/engine/quota.ts` holds per-provider
  daily caps (defaults; override via `LLM_DAILY_CAP` / `<PROVIDER>_DAILY_CAP`).
  Before each LLM call `callJSON` picks the role's provider, **falling back**
  through the chain to any provider under its cap; a persistent 429 marks a
  provider exhausted. If NO provider can serve it → `QuotaExhaustedError` → the
  item is **DEFERRED**, the run goes **PARTIAL**, and the next run resumes.
  **Tier-1 zero-LLM numeric items always complete** regardless of quota.
- **Completion + storage thrift.** When no items remain pending/error/deferred:
  compute `summaryJson` (section rollups + totalReds + non-negotiable gate), set
  `status=DONE`, update counters, then **prune** the heavy `SourceDoc.extractedText`
  — keeping structuredData, the ItemResults (evidence quote + source ref + page),
  and SourceDoc metadata incl. `sourceUrl` (re-fetchable on demand). Text is kept
  while a run is in-progress / PARTIAL across days.
- **Queue drainer.** `drainQueue()` processes eligible runs (HARVESTED / PARTIAL)
  in order — the on-demand queue and the future daily-schedule entry point.

**Later phases:** `lib/export` (xlsx/pdf/pptx); a **daily schedule** for
`analyze-run` (drain the queue under quota). (`lib/ingest` is now largely
covered by `lib/harvest`.)

---

## 10. CI — live harvest (GitHub Actions)

`/.github/workflows/harvest-validate.yml` runs the **live** Screener harvest on
a GitHub runner (open egress; creds from repo secrets) — this is where the rich
Tier-1/Tier-2 path is exercised end-to-end (the sandbox blocks `screener.in`).
By default it writes to the **persistent** database, so this is the canonical
way to harvest a company **once** and keep the data.

**How to run (manual only):** GitHub repo → **Actions** tab → **harvest-validate**
(left sidebar) → **Run workflow** → enter **ticker** (required), **exchange**
(NSE/BSE, default NSE), and **ephemeral** (default **false**) → **Run workflow**.
It's `workflow_dispatch`-only (no schedule yet); the "Run workflow" button
appears because the file is on the default branch.
- **`ephemeral=false` (default):** persists to the `DATABASE_URL` secret
  (hosted Neon). Re-running the same ticker is **idempotent** — it reuses the
  company's run, refreshes Tier-1 `structuredData`, and only re-fetches
  missing/FAILED docs.
- **`ephemeral=true`:** uses a throwaway `postgres:16` service container — a
  pure smoke test; **nothing is kept**.

**Required repo secrets** (Settings → Secrets and variables → Actions):
- `DATABASE_URL` — **required for persistent runs** (hosted Neon Postgres
  connection string). If it's unset and `ephemeral=false`, the job fails fast
  with a clear error; re-run with `ephemeral=true` for a no-DB smoke test.
- `SCREENER_EMAIL`, `SCREENER_PASSWORD` — Screener login (needed for the rich scrape).
- `FIRECRAWL_API_KEY`, `SCRAPEDO_API_KEY` — optional; enable the document
  download fallback.

**What it does:** resolve `DATABASE_URL` (persistent secret, or the ephemeral
service when toggled) → `npm ci` → install the matching Playwright Chromium →
`prisma generate` + **`migrate deploy` (never reset)** + idempotent `db:seed`
→ `npm run harvest -- <ticker> <exchange>`. It prints a summary to the log and
uploads an artifact **`harvest-<ticker>`** containing `structuredData.json` (the
`SCREENER_PAGE` structured JSON), `documents.json` (each document SourceDoc:
type, pages, fetchStatus, fetchedVia) and `summary.txt`. A graceful harvest
degradation does **not** fail the job — `fetchStatus` is surfaced in the report.

### `analyze-validate.yml` — analysis core on real data (manual only)

`/.github/workflows/analyze-validate.yml` validates the **analysis core** on a
company that has **already been harvested**. Actions → **analyze-validate** → Run
workflow → **ticker** (default `TCS`). It connects to the persistent Neon DB
(`DATABASE_URL` secret), runs `prisma migrate deploy` + idempotent `db:seed`,
finds the ticker's latest run, and evaluates **6 items** spanning every evidence
path: `A14-01` (leverage D/E, Tier-1), `A3-02` (pledging, Tier-1), `A3-01`
(promoter-holding trend, Tier-1 series), `A1-01` (board independence — numeric
from the annual report), `A4-01` (auditor identity — qualitative from the AR),
`A13-02` (view on the CEO — qualitative; web fallback / "not available").
**Required secrets:** `DATABASE_URL`, plus the LLM keys `GROQ_API_KEY`,
`MISTRAL_API_KEY`, `GEMINI_API_KEY` (and optionally `NVIDIA_API_KEY`,
`FIRECRAWL_API_KEY`, `SCRAPEDO_API_KEY`). It uploads **`analyze-<ticker>`**
(`results.json` + `summary.md`): per item → value, flag, verdict, evidence quote,
source (`sourceDocId`/page or URL), provider used, confidence. LLM calls are
tracked in `ProviderUsage`. It needs no Playwright (it reads stored text).

### `analyze-run.yml` — full 106-item batch (manual only)

`/.github/workflows/analyze-run.yml` runs the **full resumable, quota-aware
batch** for a ticker against the persistent Neon DB. Actions → **analyze-run** →
Run workflow → **ticker** (default `TCS`, or an `AnalysisRun` id). It
`migrate deploy`s + seeds, runs all 106 items, and uploads
**`analyze-run-<ticker>`** (`results.json` grouped by section + `summary.md`):
per item flag/value/verdict/source, the per-section rollups, and the
**non-negotiable gate**. Re-running **resumes** (DONE items skipped); under an
exhausted quota it ends **PARTIAL** and the next run continues. Force a low cap
to exercise the PARTIAL→resume path by setting `LLM_DAILY_CAP` in the job env.
**Required secrets:** `DATABASE_URL` + the LLM keys (`GROQ_API_KEY`,
`MISTRAL_API_KEY`, `GEMINI_API_KEY`, optionally `NVIDIA_API_KEY`). It's
`workflow_dispatch`-only; a daily `cron:` is a one-line add (noted in the file).

---

## 11. Local environment notes (this sandbox)

- A local Postgres 16 cluster is used for development
  (`DATABASE_URL=postgresql://cg:cg@localhost:5432/cgchecklist`).
- The egress proxy blocks Prisma's **engine binary download** (it bypasses the
  proxy). If `npm install` fails on `@prisma/engines` postinstall, install with
  `--ignore-scripts` and fetch the engines for the
  `debian-openssl-3.0.x` target from `https://binaries.prisma.sh/all_commits/<enginesVersion>/...`
  with `curl` (which honors the proxy). In a normal environment a plain
  `npm install` handles engines automatically — do **not** commit engine paths.
- **`screener.in` is blocked by this sandbox's egress policy (HTTP 403 at the
  proxy)** and `SCREENER_*` creds are blank, so a *live* harvest cannot run
  here. Chromium IS preinstalled (`/opt/pw-browsers/chromium`) and launches. The
  harvester is verified offline (cheerio parser fixture tests) and live via its
  **graceful-degradation + idempotency** paths (`npm run harvest -- TCS` →
  `SCREENER_PAGE` FAILED with a note, run still completes → HARVESTED, re-run
  upserts the same row). The rich-data path is unit-tested against a
  Screener-structured fixture; verifying it end-to-end needs a reachable
  Screener + real creds (e.g. CI with the GitHub secrets).

---

## 12. Acceptance (initial session) — ✔

`npm run dev` boots · `/health` renders provider statuses · the Prisma schema
migrates · `PROJECT_BRIEF.md` exists.
