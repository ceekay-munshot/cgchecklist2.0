# data/

Reference / seed data for the analysis engine.

- **`checklist.ts`** — `CHECKLIST_SEED`, a representative starter sample of the
  governance checklist. The full framework is **~106 items** across SEBI LODR /
  Ind AS. Extend this list (or load from a maintained spreadsheet) and seed it
  into the `ChecklistItem` table.

Every item is **flag-based** (GREEN / RED / NEUTRAL / NOT_AVAILABLE) — the
`guidance` field describes what makes an item green vs red. There is **no
numeric scoring** anywhere in this product.
