import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    analysisRun: { findUnique: vi.fn() },
    sourceDoc: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/engine/unlistedFinancials", () => ({ extractUnlistedFinancials: vi.fn() }));

import { ensureUnlistedFinancials } from "./unlistedTier1";
import { prisma } from "@/lib/db";
import { extractUnlistedFinancials } from "@/lib/engine/unlistedFinancials";

const asMock = (fn: unknown) => fn as unknown as Mock;

const unlistedRun = { id: "run1", company: { ticker: null, name: "Nora Enterprises" } };

beforeEach(() => {
  vi.clearAllMocks();
  asMock(prisma.analysisRun.findUnique).mockResolvedValue(unlistedRun);
  asMock(prisma.sourceDoc.findFirst).mockResolvedValue(null);
  asMock(prisma.sourceDoc.findMany).mockResolvedValue([
    { name: "Nora_FS_FY25.pdf", extractedText: "Provisional Balance Sheet ..." },
  ]);
  asMock(prisma.sourceDoc.create).mockResolvedValue({});
  asMock(extractUnlistedFinancials).mockResolvedValue({ ticker: "", url: "", ratios: {}, pros: [], cons: [], capturedAt: "" });
});

describe("ensureUnlistedFinancials", () => {
  it("builds + persists a SCREENER_PAGE doc for an unlisted run", async () => {
    const made = await ensureUnlistedFinancials("run1");
    expect(made).toBe(true);
    expect(asMock(prisma.sourceDoc.create)).toHaveBeenCalledTimes(1);
    const arg = asMock(prisma.sourceDoc.create).mock.calls[0][0];
    expect(arg.data.type).toBe("SCREENER_PAGE");
    expect(arg.data.structuredData).toBeDefined();
  });

  it("is a no-op for a LISTED run (keeps the real Screener page)", async () => {
    asMock(prisma.analysisRun.findUnique).mockResolvedValue({ id: "run1", company: { ticker: "TCS", name: "TCS" } });
    expect(await ensureUnlistedFinancials("run1")).toBe(false);
    expect(asMock(extractUnlistedFinancials)).not.toHaveBeenCalled();
    expect(asMock(prisma.sourceDoc.create)).not.toHaveBeenCalled();
  });

  it("is idempotent — skips when a SCREENER_PAGE already exists", async () => {
    asMock(prisma.sourceDoc.findFirst).mockResolvedValue({ id: "existing" });
    expect(await ensureUnlistedFinancials("run1")).toBe(false);
    expect(asMock(extractUnlistedFinancials)).not.toHaveBeenCalled();
  });

  it("does nothing when there are no readable documents", async () => {
    asMock(prisma.sourceDoc.findMany).mockResolvedValue([]);
    expect(await ensureUnlistedFinancials("run1")).toBe(false);
    expect(asMock(prisma.sourceDoc.create)).not.toHaveBeenCalled();
  });

  it("does not persist when extraction yields nothing", async () => {
    asMock(extractUnlistedFinancials).mockResolvedValue(null);
    expect(await ensureUnlistedFinancials("run1")).toBe(false);
    expect(asMock(prisma.sourceDoc.create)).not.toHaveBeenCalled();
  });
});
