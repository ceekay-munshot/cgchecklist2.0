# data/

Reference data for the analysis engine.

- **`checklist.json`** — the corporate-governance framework: **16 sections /
  106 items**. Shape:
  ```jsonc
  { "title": "...", "meta": {...}, "sections": [
    { "code": "A1", "name": "...", "items": [
      { "id": "A1-01", "item": "...", "description": "...",
        "output_format": "...", "green_flag": "...", "red_flag": "...",
        "source_hint": "...", "is_non_negotiable": true, "threshold_logic": "..." }
    ]}
  ]}
  ```
  This file is the source of truth for the checklist and is committed to the repo.

## How it's consumed

- **`lib/checklist.ts`** — `getSections()`, `getItems()`, `getItem(id)`, and
  `itemKind(item)` → `'NUMERIC' | 'QUALITATIVE'`.
- **`prisma/seed.mts`** — idempotent upsert of every section + item into the
  `ChecklistSection` / `ChecklistItem` tables (`npm run db:seed`).

Every item is **flag-based** (GREEN / RED / NEUTRAL / NOT_AVAILABLE) via
`green_flag` / `red_flag` / `threshold_logic`. There is **no numeric scoring**
anywhere in this product.
