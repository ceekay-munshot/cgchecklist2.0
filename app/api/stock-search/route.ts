import { connection } from "next/server";

/**
 * Typeahead company search — proxies the MUNS birdnest stock-search API so the
 * token never reaches the browser. Reads MUNS_TOKEN from the Worker env.
 *
 *   GET /api/stock-search?q=<text>
 *   → { results: [{ ticker, name, industry?, country? }] }
 */
export interface StockSuggestion {
  ticker: string;
  name: string;
  industry?: string;
  country?: string;
}

export async function GET(req: Request) {
  await connection();
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q || q.length < 2) return Response.json({ results: [] });

  const token = process.env.MUNS_TOKEN;
  if (!token) return Response.json({ results: [], error: "MUNS_TOKEN not set on this environment" });

  try {
    const res = await fetch("https://birdnest.muns.io/stock/search", {
      method: "POST",
      headers: {
        accept: "*/*",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: q, user_index: 124 }),
    });
    if (!res.ok) return Response.json({ results: [], error: `search ${res.status}` });

    const body = (await res.json()) as { data?: { results?: Record<string, (string | null)[]> } };
    const raw = body?.data?.results ?? {};
    // Each value is [country, companyName, industry].
    const results: StockSuggestion[] = Object.entries(raw).map(([ticker, arr]) => ({
      ticker,
      name: (arr?.[1] as string) || ticker,
      industry: (arr?.[2] as string) || undefined,
      country: (arr?.[0] as string) || undefined,
    }));
    return Response.json({ results });
  } catch {
    return Response.json({ results: [] });
  }
}
