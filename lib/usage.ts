import { prisma } from "@/lib/db";

/** Midnight-UTC bucket for today's per-provider usage row. */
export function usageDate(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Increment per-provider, per-day usage (free-tier quota tracking). Used by the
 * Screener harvester (`provider="screener"`) and later by the LLM processing
 * loop. Never throws — usage tracking must not break a run.
 */
export async function recordProviderUsage(
  provider: string,
  { requests = 1, tokens = 0 }: { requests?: number; tokens?: number } = {},
): Promise<void> {
  const date = usageDate();
  try {
    await prisma.providerUsage.upsert({
      where: { provider_date: { provider, date } },
      create: { provider, date, requests, tokens },
      update: {
        requests: { increment: requests },
        tokens: { increment: tokens },
      },
    });
  } catch {
    // swallow — quota bookkeeping is best-effort
  }
}

export async function getProviderUsage(provider: string, date: Date = usageDate()) {
  return prisma.providerUsage.findUnique({
    where: { provider_date: { provider, date } },
  });
}
