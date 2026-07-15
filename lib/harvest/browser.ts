import fs from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { recordProviderUsage } from "@/lib/usage";

// Prefer the runtime's preinstalled Chromium (do NOT download per run).
const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const LOGIN_URL = "https://www.screener.in/login/";
const SEARCH_API = "https://www.screener.in/api/company/search/";
const MIN_REQUEST_INTERVAL_MS = 1500; // be polite to Screener
const NAV_TIMEOUT_MS = 45_000;

/** One hit from Screener's public company-search API (name → canonical URL). */
export interface CompanySearchResult {
  id: number;
  name: string;
  url: string; // e.g. "/company/544224/"
}

export interface FetchedPage {
  ok: boolean;
  status: number;
  finalUrl: string;
  html: string;
}

export interface DownloadResult {
  ok: boolean;
  status: number;
  buffer?: Buffer;
  contentType?: string;
}

export interface ScreenerSession {
  loggedIn: boolean;
  note?: string;
  fetchRenderedHtml(url: string): Promise<FetchedPage>;
  downloadBuffer(url: string): Promise<DownloadResult>;
  /**
   * Resolve a ticker/name to Screener's canonical company page(s) via its public
   * search API. This is how we recover when the guessed `/company/<TICKER>/` URL
   * 404s (Screener lists many companies — esp. BSE-only ones — under a numeric
   * code, e.g. AFCOM → /company/544224/). Best-effort: returns [] on any failure.
   */
  searchCompany(query: string): Promise<CompanySearchResult[]>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Open ONE logged-in browser context for a single harvest. Reused for every
 * page fetch + document download (polite, one session). Login is best-effort:
 * if it fails (bad creds / blocked / no creds) the session still works
 * logged-out and records a note — the harvest degrades, never crashes.
 *
 * Throws only if Chromium itself cannot launch; the orchestrator catches that
 * and degrades the whole run.
 */
export async function openScreenerSession(): Promise<ScreenerSession> {
  const proxyServer =
    process.env.HTTPS_PROXY || process.env.https_proxy || undefined;

  const browser: Browser = await chromium.launch({
    executablePath: fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined,
    headless: true,
    proxy: proxyServer ? { server: proxyServer } : undefined,
    // --no-sandbox is required to run Chromium as root in CI containers.
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    // Only relax cert checks if explicitly opted in (e.g. behind a TLS-MITM
    // egress proxy). Off by default so normal/CI runs verify TLS.
    ignoreHTTPSErrors: process.env.HARVEST_INSECURE_TLS === "1",
  });
  context.setDefaultTimeout(NAV_TIMEOUT_MS);
  const page: Page = await context.newPage();

  let lastRequestAt = 0;
  async function polite() {
    const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  let loggedIn = false;
  let note: string | undefined;
  const email = process.env.SCREENER_EMAIL?.trim();
  const password = process.env.SCREENER_PASSWORD?.trim();

  if (email && password) {
    try {
      await polite();
      await recordProviderUsage("screener");
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
      await page.fill("#id_username, input[name=username]", email);
      await page.fill("#id_password, input[name=password]", password);
      await page.click("button[type=submit], button:has-text('Login')");
      await page.waitForLoadState("networkidle").catch(() => {});
      loggedIn = !/\/login\/?$/.test(page.url());
      if (!loggedIn) {
        note = "login submitted but still on /login (check SCREENER_* creds)";
      }
    } catch (e) {
      note = `login failed: ${(e as Error).message}`;
    }
  } else {
    note = "SCREENER_EMAIL/PASSWORD not set — proceeding logged-out";
  }

  return {
    loggedIn,
    note,
    async fetchRenderedHtml(url: string): Promise<FetchedPage> {
      await polite();
      await recordProviderUsage("screener");
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      const html = await page.content();
      return {
        ok: resp?.ok() ?? false,
        status: resp?.status() ?? 0,
        finalUrl: page.url(),
        html,
      };
    },
    async downloadBuffer(url: string): Promise<DownloadResult> {
      await polite();
      await recordProviderUsage("screener");
      const resp = await context.request.get(url, { timeout: NAV_TIMEOUT_MS });
      if (!resp.ok()) return { ok: false, status: resp.status() };
      const buffer = await resp.body();
      return {
        ok: true,
        status: resp.status(),
        buffer,
        contentType: resp.headers()["content-type"],
      };
    },
    async searchCompany(query: string): Promise<CompanySearchResult[]> {
      const q = query.trim();
      if (!q) return [];
      await polite();
      await recordProviderUsage("screener");
      try {
        const resp = await context.request.get(`${SEARCH_API}?q=${encodeURIComponent(q)}`, {
          timeout: NAV_TIMEOUT_MS,
          headers: { accept: "application/json" },
        });
        if (!resp.ok()) return [];
        const data = (await resp.json()) as unknown;
        if (!Array.isArray(data)) return [];
        return data.filter(
          (r): r is CompanySearchResult =>
            !!r && typeof (r as CompanySearchResult).url === "string",
        );
      } catch {
        return [];
      }
    },
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
