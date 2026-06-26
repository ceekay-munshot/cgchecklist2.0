"use client";

import { useState } from "react";
import type { HealthState, ProviderStatus } from "@/lib/health-types";

const BADGE: Record<HealthState, { dot: string; label: string; text: string }> = {
  green: {
    dot: "bg-emerald-500",
    label: "Operational",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  red: {
    dot: "bg-red-500",
    label: "Down",
    text: "text-red-700 dark:text-red-400",
  },
  not_configured: {
    dot: "bg-zinc-400",
    label: "Not configured",
    text: "text-zinc-500",
  },
};

const GROUPS: Array<{ key: ProviderStatus["category"]; title: string }> = [
  { key: "llm", title: "LLM providers" },
  { key: "scrape", title: "Web research" },
  { key: "database", title: "Database" },
];

export function HealthDashboard({ initial }: { initial: ProviderStatus[] }) {
  const [providers, setProviders] = useState<ProviderStatus[]>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { providers: ProviderStatus[] };
      setProviders(data.providers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Provider health</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Live status of every configured provider and the database.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
          Failed to refresh: {error}
        </p>
      )}

      <div className="mt-8 space-y-8">
        {GROUPS.map((group) => {
          const items = providers.filter((p) => p.category === group.key);
          if (items.length === 0) return null;
          return (
            <section key={group.key}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {group.title}
              </h2>
              <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {items.map((p) => {
                  const badge = BADGE[p.state];
                  return (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${badge.dot}`}
                            aria-hidden
                          />
                          <span className="font-medium">{p.label}</span>
                        </div>
                        <p className="mt-0.5 truncate text-sm text-zinc-500">{p.role}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className={`text-sm font-medium ${badge.text}`}>
                          {badge.label}
                        </div>
                        <p className="mt-0.5 text-xs text-zinc-400">
                          {p.message}
                          {typeof p.latencyMs === "number" ? ` · ${p.latencyMs}ms` : ""}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
