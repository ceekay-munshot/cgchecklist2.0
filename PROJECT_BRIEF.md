# PROJECT BRIEF — CG Checklist 2.0

> **Read this file first, every session.** It is the source of truth for what we
> are building, how the repo is structured, and the conventions to follow.
>
> Also read **`AGENTS.md`** / **`CLAUDE.md`**: this project runs on a
> **customized Next.js 16** — "NOT the Next.js you know." Before writing any
> Next.js code, read the relevant guide under `node_modules/next/dist/docs/`
> and heed deprecation notices.

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
data/                    # reference data: checklist seed (~106 items)
prisma/                  # schema.prisma + migrations/
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

## 6. Data model (Prisma — flag-based, no scores)

Models: `Company`, `Document`, `ChecklistItem`, `AnalysisRun`, `ItemResult`
(`flag`, `verdict`, `evidence`, `source`, `llmProvider`).
Enums: `Flag { GREEN, RED, NEUTRAL, NOT_AVAILABLE }`, `DocumentType`,
`RunStatus`. See `prisma/schema.prisma`. Initial migration lives in
`prisma/migrations/`.

---

## 7. Environment variables (`.env.example`)

`GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `NVIDIA_API_KEY`,
`FIRECRAWL_API_KEY`, `SCRAPEDO_API_KEY`, `DATABASE_URL`.
Optional model overrides: `GEMINI_MODEL`, `GROQ_MODEL`, `MISTRAL_MODEL`,
`NVIDIA_MODEL`. Copy `.env.example` → `.env` and fill in. `/health` shows any
blank provider as **not configured**.

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
```

Pages: `/` (dashboard), `/health` (provider statuses), `/api/health` (JSON).

---

## 9. Status & next steps

**Done:** project scaffold; Prisma schema + initial migration; `lib/llm`
(4 providers behind one interface + JSON-schema validation + role router);
`lib/scrape` (Firecrawl → Scrape.do fallback); `/health` page + `/api/health`;
`.env.example`; this brief.

**Stubs to implement next** (throw "not implemented" today):
`lib/ingest` (extract PDFs/filings), `lib/engine` (`evaluateItem`),
`lib/orchestrate` (`runAnalysis` end-to-end + persistence),
`lib/export` (xlsx/pdf/pptx). Seed the full **~106-item** checklist into
`data/` + the `ChecklistItem` table (starter sample in `data/checklist.ts`).

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
