interface ConnectCompletePageProps {
  searchParams?: Promise<{
    provider?: string;
    status?: string;
    reason?: string;
  }>;
}

function humanizeProviderId(value: string | undefined) {
  if (!value) return "This integration";

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function humanizeReason(value: string | undefined) {
  if (!value) return "The connection did not complete.";
  return value.replace(/_/g, " ");
}

export default async function ConnectCompletePage({
  searchParams,
}: ConnectCompletePageProps) {
  const params = (await searchParams) || {};
  const providerLabel = humanizeProviderId(params.provider);
  const connected = params.status === "connected";

  return (
    <main className="min-h-screen bg-background px-6 py-16 text-foreground">
      <div className="mx-auto max-w-xl rounded-3xl border border-border/40 bg-background/70 p-8 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur">
        <div className="space-y-3">
          <div className="text-xs font-mono uppercase tracking-[0.24em] text-muted-foreground">
            Nicole Connection
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {connected
              ? `${providerLabel} connected`
              : `${providerLabel} connection issue`}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {connected
              ? "You can close this tab and go back to Nicole."
              : `Nicole couldn't finish the connection: ${humanizeReason(
                  params.reason
                )}. You can close this tab and try again from Nicole.`}
          </p>
        </div>
      </div>
    </main>
  );
}
