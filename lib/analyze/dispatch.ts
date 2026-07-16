/**
 * Kick off the long-running on-demand analysis.
 *
 * The work itself can't run inside a serverless request — it scrapes documents
 * and makes minutes of LLM calls — so we dispatch the `analyze-company` GitHub
 * Actions workflow as the background worker. It harvests + analyses the ticker
 * against the SAME Neon DB the web app reads, writing each ItemResult as it goes
 * (the status endpoint polls those for the live % bar).
 *
 * Configure in the deployed app's env:
 *   GITHUB_DISPATCH_TOKEN   a PAT / fine-grained token with `actions:write`
 *   GITHUB_REPO             "owner/name" (e.g. ceekay-munshot/cgchecklist2.0)
 *   GITHUB_DISPATCH_REF     branch to run on (default "main")
 *   GITHUB_DISPATCH_WORKFLOW  workflow file (default "analyze-company.yml")
 *
 * When unset, triggerAnalysisWorkflow() reports `dispatch_not_configured` and
 * the API still creates a QUEUED run — the existing manual Action can process it.
 */

export interface DispatchConfig {
  token: string;
  repo: string;
  ref: string;
  workflow: string;
}

// The repo is public info (this app's own repo), so it defaults in code — this
// avoids depending on a plain-text Worker var, which Cloudflare wipes on every
// rebuild. Only the token must be provided, and a Worker SECRET persists across
// deploys. Override the default with GITHUB_REPO if you fork/rename.
const DEFAULT_REPO = "ceekay-munshot/cgchecklist2.0";

export function dispatchConfig(): DispatchConfig | null {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return null;
  return {
    token,
    repo: process.env.GITHUB_REPO || DEFAULT_REPO,
    ref: process.env.GITHUB_DISPATCH_REF || "main",
    workflow: process.env.GITHUB_DISPATCH_WORKFLOW || "analyze-company.yml",
  };
}

export function isDispatchConfigured(): boolean {
  return dispatchConfig() != null;
}

export interface DispatchResult {
  ok: boolean;
  error?: string;
}

/** POST a workflow_dispatch to a specific workflow file with the given inputs. */
async function dispatchWorkflow(
  workflow: string,
  inputs: Record<string, string>,
): Promise<DispatchResult> {
  const cfg = dispatchConfig();
  if (!cfg) return { ok: false, error: "dispatch_not_configured" };

  const url = `https://api.github.com/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        // GitHub's REST API REQUIRES a User-Agent header; without it the request
        // is rejected with "403 forbidden by administrative rules".
        "User-Agent": "cgchecklist-ondemand",
      },
      body: JSON.stringify({ ref: cfg.ref, inputs }),
    });
    if (res.status === 204) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, error: `github ${res.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function triggerAnalysisWorkflow(
  ticker: string,
  opts: { exchange?: string; force?: boolean } = {},
): Promise<DispatchResult> {
  const cfg = dispatchConfig();
  if (!cfg) return { ok: false, error: "dispatch_not_configured" };
  return dispatchWorkflow(cfg.workflow, {
    ticker,
    ...(opts.exchange ? { exchange: opts.exchange } : {}),
    force: opts.force ? "true" : "false",
  });
}

/**
 * Analyse an ALREADY-INGESTED run (unlisted uploads, or a re-analyse) — no
 * Screener harvest. Dispatches analyze-run.yml, whose script resolves the arg as a
 * runId and processes the run's stored SourceDocs, then the MUNS fill. Pass
 * `force` to re-evaluate ALL items (a re-analyse of a DONE run, e.g. after an
 * engine fix), not just resume the unfinished ones.
 *
 * Pass `sectionCode` or `itemId` for a TARGETED re-run — the workflow then
 * re-evaluates only that section / item and skips the whole-report MUNS + QA
 * backfill, so one parameter (or one section) can be redone without disturbing
 * the rest of the report.
 */
export async function triggerRunAnalysis(
  runId: string,
  opts: { force?: boolean; sectionCode?: string; itemId?: string } = {},
): Promise<DispatchResult> {
  const workflow = process.env.GITHUB_ANALYZE_RUN_WORKFLOW || "analyze-run.yml";
  return dispatchWorkflow(workflow, {
    ticker: runId,
    force: opts.force ? "true" : "false",
    ...(opts.sectionCode ? { section: opts.sectionCode } : {}),
    ...(opts.itemId ? { item: opts.itemId } : {}),
  });
}
