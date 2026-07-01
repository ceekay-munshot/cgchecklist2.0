// Idempotent seed: upserts the 16 sections + 106 items from data/checklist.json.
// Run with `npm run db:seed` (or automatically via `prisma migrate reset`).
// Runnable directly: `node prisma/seed.ts` (Node 22 strips the TS types).
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

// Seed runs as a setup task in Node (GitHub Actions / local), never on Workers.
// Use the DIRECT Postgres connection (DIRECT_URL) so it works with the standard
// engine even when DATABASE_URL is the Accelerate ("prisma://") URL.
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

interface RawItem {
  id: string;
  item: string;
  description?: string;
  output_format?: string;
  green_flag?: string;
  red_flag?: string;
  source_hint?: string;
  is_non_negotiable?: boolean;
  threshold_logic?: string;
}

interface RawSection {
  code: string;
  name: string;
  items: RawItem[];
}

interface RawFile {
  title?: string;
  sections: RawSection[];
}

async function main() {
  const file = path.join(process.cwd(), "data", "checklist.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `data/checklist.json not found at ${file}. Add the 106-item file before seeding.`,
    );
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as RawFile;

  let sections = 0;
  let items = 0;

  for (const [sIdx, section] of data.sections.entries()) {
    await prisma.checklistSection.upsert({
      where: { code: section.code },
      create: { code: section.code, name: section.name, orderIndex: sIdx },
      update: { name: section.name, orderIndex: sIdx },
    });
    sections++;

    for (const [iIdx, item] of section.items.entries()) {
      const fields = {
        sectionCode: section.code,
        item: item.item,
        description: item.description ?? null,
        outputFormat: item.output_format ?? null,
        greenFlag: item.green_flag ?? null,
        redFlag: item.red_flag ?? null,
        sourceHint: item.source_hint ?? null,
        isNonNegotiable: item.is_non_negotiable ?? false,
        thresholdLogic: item.threshold_logic ?? null,
        orderIndex: iIdx,
      };
      await prisma.checklistItem.upsert({
        where: { id: item.id },
        create: { id: item.id, ...fields },
        update: fields,
      });
      items++;
    }
  }

  console.log(`Seeded ${sections} sections and ${items} items.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
