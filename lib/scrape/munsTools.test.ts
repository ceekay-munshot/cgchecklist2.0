import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { munsTools } from "./munsTools";

const OLD_ENV = { ...process.env };

type Payload = { ok?: boolean; status?: number; json: unknown };
function route(map: Record<string, Payload>) {
  // 2-arg signature so `fetch` call tuples type as [url, init] at the assert sites.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    const p = key ? map[key] : { ok: false, status: 404, json: {} };
    return {
      ok: p.ok ?? true,
      status: p.status ?? 200,
      json: async () => p.json,
      text: async () => JSON.stringify(p.json),
    } as unknown as Response;
  });
}

beforeEach(() => {
  process.env.MUNS_TOKEN = "tkn";
  delete process.env.MUNS_TOOLS;
  delete process.env.MUNS_TOOLS_COUNTRY;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("munsTools.isConfigured", () => {
  it("needs a token and is killable via MUNS_TOOLS=0", () => {
    expect(munsTools.isConfigured()).toBe(true);
    process.env.MUNS_TOOLS = "0";
    expect(munsTools.isConfigured()).toBe(false);
    process.env.MUNS_TOOLS = "1";
    delete process.env.MUNS_TOKEN;
    expect(munsTools.isConfigured()).toBe(false);
  });
});

describe("munsTools.fetchUrl (web-reader)", () => {
  it("reads a URL's content → ok, with the right request shape", async () => {
    const f = route({ "web-reader": { json: { results: [{ url: "u", content: "# Hello\ntext" }] } } });
    vi.stubGlobal("fetch", f);
    const r = await munsTools.fetchUrl("https://x.com/a");
    expect(r.status).toBe("ok");
    expect(r.content).toContain("Hello");
    expect(r.contentType).toBe("markdown");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://hostapi.muns.io/tools/web-reader");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.urls).toEqual(["https://x.com/a"]);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tkn" });
  });

  it("degrades to not_available on HTTP error, empty content, or no token", async () => {
    vi.stubGlobal("fetch", route({ "web-reader": { ok: false, status: 500, json: {} } }));
    expect((await munsTools.fetchUrl("https://x.com")).status).toBe("not_available");

    vi.stubGlobal("fetch", route({ "web-reader": { json: { results: [{ url: "u" }] } } }));
    expect((await munsTools.fetchUrl("https://x.com")).status).toBe("not_available");

    delete process.env.MUNS_TOKEN;
    const r = await munsTools.fetchUrl("https://x.com");
    expect(r.status).toBe("not_available");
    expect(r.error).toMatch(/MUNS_TOKEN/);
  });
});

describe("munsTools.search (web-search + news blend)", () => {
  it("merges web + news hits, de-duped by url, mapped to SearchHit", async () => {
    const f = route({
      "web-search": { json: { results: [{ title: "W1", link: "https://a", snippet: "sa" }, { title: "W2", link: "https://b", snippet: "sb" }] } },
      "news-search": { json: { results: [{ title: "N1", url: "https://b", description: "db" }, { title: "N2", url: "https://c", description: "dc" }] } },
    });
    vi.stubGlobal("fetch", f);
    const r = await munsTools.search("Metal Book promoter fraud");
    expect(r.status).toBe("ok");
    expect(r.results.map((h) => h.url)).toEqual(["https://a", "https://b", "https://c"]); // b de-duped
    expect(r.results[2]).toEqual({ title: "N2", url: "https://c", snippet: "dc" });
    // country defaults to India
    const webBody = JSON.parse((f.mock.calls.find((c) => (c[0] as string).includes("web-search"))![1] as RequestInit).body as string);
    expect(webBody).toEqual({ query: "Metal Book promoter fraud", country: "India" });
  });

  it("a news failure never drops the web hits (news is best-effort)", async () => {
    vi.stubGlobal("fetch", route({
      "web-search": { json: { results: [{ title: "W1", link: "https://a" }] } },
      "news-search": { ok: false, status: 500, json: {} },
    }));
    const r = await munsTools.search("q");
    expect(r.status).toBe("ok");
    expect(r.results.map((h) => h.url)).toEqual(["https://a"]);
  });

  it("no hits from either → not_available", async () => {
    vi.stubGlobal("fetch", route({ "web-search": { json: { results: [] } }, "news-search": { json: { results: [] } } }));
    expect((await munsTools.search("q")).status).toBe("not_available");
  });
});

describe("munsTools.newsSearch (date-scoped, new capability)", () => {
  it("passes from_date/to_date and maps description → snippet", async () => {
    const f = route({ "news-search": { json: { results: [{ title: "N", url: "https://n", description: "d" }] } } });
    vi.stubGlobal("fetch", f);
    const r = await munsTools.newsSearch("promoter default", { fromDate: "2001-01-01", toDate: "2026-07-16" });
    expect(r.status).toBe("ok");
    expect(r.results[0]).toEqual({ title: "N", url: "https://n", snippet: "d" });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ query: "promoter default", from_date: "2001-01-01", to_date: "2026-07-16" });
  });

  it("honours MUNS_TOOLS_COUNTRY override", async () => {
    const f = route({ "news-search": { json: { results: [{ title: "N", url: "https://n" }] } } });
    vi.stubGlobal("fetch", f);
    process.env.MUNS_TOOLS_COUNTRY = "United States";
    await munsTools.newsSearch("q");
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.country).toBe("United States");
  });
});
