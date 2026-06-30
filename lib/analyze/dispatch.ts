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

export function dispatchConfig(): DispatchConfig | null {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) return null;
  return {
    token,
    repo,
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

export async function triggerAnalysisWorkflow(
  ticker: string,
  opts: { exchange?: string; force?: boolean } = {},
): Promise<DispatchResult> {
  const cfg = dispatchConfig();
  if (!cfg) return { ok: false, error: "dispatch_not_configured" };

  const url = `https://api.github.com/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: cfg.ref,
        inputs: {
          ticker,
          ...(opts.exchange ? { exchange: opts.exchange } : {}),
          force: opts.force ? "true" : "false",
        },
      }),
    });
    if (res.status === 204) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, error: `github ${res.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
