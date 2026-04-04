"use client";

import { useEffect, useMemo, useState } from "react";

interface IntegrationProviderPayload {
  id: string;
  kind: string;
  title: string;
  description: string;
  connectionType: "oauth" | "native_mac";
  status: "ready" | "planned";
  capabilities: string[];
  configured: boolean;
  connected: boolean;
  account: {
    provider: string;
    status: string;
    displayName: string | null;
    email: string | null;
    connectedAt: string | null;
    updatedAt: string | null;
  } | null;
}

const KIND_ORDER = ["calendar", "email", "reminders"];

export default function IntegrationsPage() {
  const [providers, setProviders] = useState<IntegrationProviderPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [disconnectingProvider, setDisconnectingProvider] = useState<string | null>(
    null
  );
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadProviders = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/integrations", {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("Failed to load integrations.");
      }

      const data = (await response.json()) as IntegrationProviderPayload[];
      setProviders(data);
    } catch (error) {
      console.error(error);
      setFeedback("I couldn't load integrations right now.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");

    if (connected) {
      setFeedback(`${humanizeProviderId(connected)} connected.`);
      window.history.replaceState({}, "", "/integrations");
      void loadProviders();
      return;
    }

    if (error) {
      setFeedback(`Connection issue: ${error.replace(/_/g, " ")}`);
      window.history.replaceState({}, "", "/integrations");
    }
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, IntegrationProviderPayload[]>();

    for (const kind of KIND_ORDER) {
      map.set(kind, []);
    }

    for (const provider of providers) {
      const current = map.get(provider.kind) || [];
      current.push(provider);
      map.set(provider.kind, current);
    }

    return map;
  }, [providers]);

  const disconnectProvider = async (providerId: string) => {
    setDisconnectingProvider(providerId);
    try {
      const response = await fetch(`/api/integrations/disconnect/${providerId}`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to disconnect provider.");
      }

      setFeedback(`${humanizeProviderId(providerId)} disconnected.`);
      await loadProviders();
    } catch (error) {
      console.error(error);
      setFeedback(`I couldn't disconnect ${humanizeProviderId(providerId)}.`);
    } finally {
      setDisconnectingProvider(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-28">
      <div className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>
          <p className="text-sm text-[var(--muted)]">
            Connect Nicole to the services you actually use. Banjo stays the
            canonical brain; these providers just give her real-world reach.
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[color:rgba(255,255,255,0.02)] px-4 py-3 text-xs text-[var(--muted)]">
          OAuth providers need app credentials in Banjo&apos;s `.env.local`.
          Native Mac integrations like Apple Calendar will come through
          `nicole-macos`, not this page.
        </div>

        {feedback && (
          <div className="rounded-xl border border-[var(--border)] bg-[color:rgba(255,255,255,0.02)] px-4 py-3 text-sm">
            {feedback}
          </div>
        )}
      </div>

      <div className="mt-8 space-y-8">
        {KIND_ORDER.map((kind) => {
          const items = grouped.get(kind) || [];
          if (items.length === 0) return null;

          return (
            <section key={kind} className="space-y-4">
              <div className="space-y-1">
                <div className="text-xs font-mono uppercase tracking-[0.24em] text-[var(--muted)]">
                  {kind}
                </div>
                <h2 className="text-lg font-medium">
                  {kind === "calendar"
                    ? "Scheduling"
                    : kind === "email"
                      ? "Mail"
                      : "Tasks"}
                </h2>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {items.map((provider) => {
                  const isOAuth = provider.connectionType === "oauth";
                  const canConnect =
                    provider.status === "ready" &&
                    provider.configured &&
                    isOAuth &&
                    !provider.connected;

                  return (
                    <article
                      key={provider.id}
                      className="rounded-3xl border border-[var(--border)] bg-[color:rgba(255,255,255,0.02)] p-5"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <h3 className="text-base font-semibold">
                              {provider.title}
                            </h3>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em] ${
                                provider.connected
                                  ? "border border-emerald-500/40 text-emerald-300"
                                  : provider.status === "ready"
                                    ? "border border-white/15 text-[var(--muted)]"
                                    : "border border-amber-500/30 text-amber-200"
                              }`}
                            >
                              {provider.connected
                                ? "connected"
                                : provider.status === "ready"
                                  ? "available"
                                  : "planned"}
                            </span>
                          </div>

                          <p className="text-sm leading-6 text-[var(--muted)]">
                            {provider.description}
                          </p>
                        </div>

                        {provider.connected ? (
                          <button
                            onClick={() => disconnectProvider(provider.id)}
                            disabled={disconnectingProvider === provider.id}
                            className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--foreground)] disabled:opacity-50"
                          >
                            {disconnectingProvider === provider.id
                              ? "Disconnecting..."
                              : "Disconnect"}
                          </button>
                        ) : isOAuth ? (
                          <a
                            href={canConnect ? `/api/integrations/connect/${provider.id}` : "#"}
                            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                              canConnect
                                ? "border-[var(--foreground)] hover:bg-[var(--foreground)] hover:text-[var(--background)]"
                                : "pointer-events-none border-[var(--border)] text-[var(--muted)] opacity-50"
                            }`}
                          >
                            Connect
                          </a>
                        ) : (
                          <span className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)]">
                            Native later
                          </span>
                        )}
                      </div>

                      <div className="mt-5 grid gap-4 text-sm sm:grid-cols-[1.1fr,0.9fr]">
                        <div className="space-y-2">
                          <div className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--muted)]">
                            Tools
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {provider.capabilities.map((capability) => (
                              <span
                                key={capability}
                                className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-mono text-[var(--muted)]"
                              >
                                {capability}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--muted)]">
                            Status
                          </div>
                          {provider.connected && provider.account ? (
                            <div className="space-y-1 text-sm leading-6 text-[var(--muted)]">
                              <div className="text-[var(--foreground)]">
                                {provider.account.displayName || provider.title}
                              </div>
                              {provider.account.email && (
                                <div>{provider.account.email}</div>
                              )}
                              {provider.account.connectedAt && (
                                <div>
                                  Connected{" "}
                                  {new Date(
                                    provider.account.connectedAt
                                  ).toLocaleString()}
                                </div>
                              )}
                            </div>
                          ) : provider.connectionType === "oauth" ? (
                            <div className="space-y-1 text-sm leading-6 text-[var(--muted)]">
                              <div>
                                {provider.configured
                                  ? "Ready to connect from the browser."
                                  : "Missing OAuth client env vars on Banjo."}
                              </div>
                              <div className="text-xs">
                                Callback is handled automatically through Nicole&apos;s
                                own auth routes.
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-1 text-sm leading-6 text-[var(--muted)]">
                              <div>
                                This will come through the native Mac client,
                                not Banjo&apos;s web OAuth flow.
                              </div>
                              <div className="text-xs">
                                Best for Apple permissions and device-local
                                capabilities.
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {loading && (
        <div className="mt-8 text-xs font-mono text-[var(--muted)]">
          Loading integrations...
        </div>
      )}
    </div>
  );
}

function humanizeProviderId(providerId: string) {
  return providerId
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}
