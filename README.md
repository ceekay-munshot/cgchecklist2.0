# cgchecklist2.0

Internal **Corporate Governance (CG) Checklist** analysis dashboard for Indian
listed companies (SEBI LODR / Ind AS framework). It ingests a company's annual
report + filings, evaluates ~106 governance checklist items, and produces a
**flag-based** report (no numeric scoring) with green / red / neutral /
not-available flags, a one-liner verdict per item, evidence, and source —
exportable to Excel and PPT/PDF.

> **Read [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) first.** It is the source of
> truth for the product, architecture, provider-routing table, and conventions.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS v4**
- **Postgres** via **Prisma 6**
- LLM providers behind one `LlmClient` interface: Gemini, Groq, Mistral, Nvidia NIM
- Web research behind one `WebResearcher` interface: Firecrawl → Scrape.do fallback

> This project uses a **customized Next.js 16**. Before writing any Next.js code,
> read the relevant guide under `node_modules/next/dist/docs/` (see `AGENTS.md`).

## Getting started

```bash
npm install
cp .env.example .env   # then fill in keys + DATABASE_URL
npx prisma migrate dev # create/apply the database schema
npm run dev            # http://localhost:3000
```

- `/` — dashboard landing
- `/health` — live green/red status for every configured provider + the database
- `/api/health` — JSON health of all providers

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Run the production build |
| `npm run lint` | ESLint |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:generate` | `prisma generate` |
| `npm run db:studio` | `prisma studio` |
