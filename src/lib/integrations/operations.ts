import { spawn } from "node:child_process";
import {
  disconnectIntegrationAccount,
  getIntegrationAccount,
  listIntegrationAccounts,
} from "./oauth";
import {
  getIntegrationProvider,
  INTEGRATION_PROVIDERS,
  IntegrationProviderDefinition,
  IntegrationProviderId,
  isProviderConfigured,
} from "./providers";

export interface IntegrationStatusRecord {
  providerId: IntegrationProviderId;
  title: string;
  kind: string;
  connectionType: string;
  status: "ready" | "planned";
  configured: boolean;
  connected: boolean;
  account: {
    displayName: string | null;
    email: string | null;
    connectedAt: string | null;
  } | null;
}

export interface IntegrationOperationResult {
  ok: boolean;
  action: "status" | "connect" | "disconnect";
  provider: IntegrationStatusRecord | null;
  message: string;
  connectUrl?: string | null;
  browserOpened?: boolean;
  browserOpenError?: string | null;
  requiresUserAction?: boolean;
  unsupportedService?: string | null;
  suggestions?: string[];
  allProviders?: IntegrationStatusRecord[];
}

interface IntegrationAccountLike {
  displayName: string | null;
  email: string | null;
  connectedAt: Date | null;
}

interface ProviderResolution {
  provider: IntegrationProviderDefinition | null;
  unsupportedService?: string;
  ambiguous?: boolean;
  suggestions?: string[];
}

const INTEGRATION_PROVIDER_ALIASES: Record<IntegrationProviderId, string[]> = {
  google_calendar: [
    "google calendar",
    "google cal",
    "gcal",
    "google calender",
    "google calandar",
  ],
  gmail: [
    "gmail",
    "g mail",
    "google mail",
    "google email",
    "google inbox",
  ],
  zoho_mail: [
    "zoho",
    "zoho mail",
    "zoho email",
    "zoho inbox",
  ],
  apple_calendar: [
    "apple calendar",
    "icloud calendar",
    "mac calendar",
    "apple calender",
  ],
  apple_reminders: [
    "apple reminders",
    "icloud reminders",
    "apple reminder",
    "mac reminders",
  ],
};

const PROVIDER_QUERY_MAP: Array<{
  providerId: IntegrationProviderId;
  patterns: RegExp[];
}> = [
  {
    providerId: "gmail",
    patterns: [
      /\bgmail\b/i,
      /\bgoogle mail\b/i,
      /\bgoogle email\b/i,
      /\bgoogle inbox\b/i,
    ],
  },
  {
    providerId: "google_calendar",
    patterns: [
      /\bgoogle calendar\b/i,
      /\bgoogle cal\b/i,
      /\bgcal\b/i,
      /\bcalendar\b/i,
      /\bschedule\b/i,
    ],
  },
  {
    providerId: "zoho_mail",
    patterns: [/\bzoho mail\b/i, /\bzoho email\b/i, /\bzoho\b/i],
  },
  {
    providerId: "apple_calendar",
    patterns: [/\bapple calendar\b/i, /\bicloud calendar\b/i, /\bmac calendar\b/i],
  },
  {
    providerId: "apple_reminders",
    patterns: [/\bapple reminders?\b/i, /\bicloud reminders?\b/i, /\breminders?\b/i],
  },
];

export async function getIntegrationStatus(
  providerQuery?: string
): Promise<IntegrationOperationResult> {
  const resolution = resolveIntegrationProviderQuery(providerQuery);

  if (resolution.unsupportedService) {
    return {
      ok: false,
      action: "status",
      provider: null,
      message: buildUnsupportedMessage(resolution.unsupportedService),
      unsupportedService: resolution.unsupportedService,
      suggestions: resolution.suggestions,
    };
  }

  if (resolution.ambiguous) {
    return {
      ok: false,
      action: "status",
      provider: null,
      message:
        "Be more specific about which integration you want. Right now I can connect Gmail, Google Calendar, and Zoho Mail.",
      suggestions: resolution.suggestions,
    };
  }

  if (!resolution.provider) {
    const allProviders = await buildAllProviderStatuses();
    return {
      ok: true,
      action: "status",
      provider: null,
      message: "Here’s Nicole’s current integration status.",
      allProviders,
    };
  }

  const providerStatus = await buildProviderStatus(resolution.provider.id);
  return {
    ok: true,
    action: "status",
    provider: providerStatus,
    message: providerStatus.connected
      ? `${providerStatus.title} is connected.`
      : providerStatus.status === "planned"
        ? `${providerStatus.title} is planned, not wired yet.`
        : providerStatus.configured
          ? `${providerStatus.title} is available but not connected yet.`
          : `${providerStatus.title} is not configured on this Mac yet.`,
  };
}

export async function startIntegrationConnection(
  providerQuery: string,
  options?: { clientSurface?: string }
): Promise<IntegrationOperationResult> {
  const resolution = resolveIntegrationProviderQuery(providerQuery);

  if (resolution.unsupportedService) {
    return {
      ok: false,
      action: "connect",
      provider: null,
      message: buildUnsupportedMessage(resolution.unsupportedService),
      unsupportedService: resolution.unsupportedService,
      suggestions: resolution.suggestions,
    };
  }

  if (resolution.ambiguous || !resolution.provider) {
    return {
      ok: false,
      action: "connect",
      provider: null,
      message:
        "Be specific about which integration you want. Right now the ready conversational connections are Gmail, Google Calendar, and Zoho Mail.",
      suggestions: resolution.suggestions || ["gmail", "google calendar", "zoho mail"],
    };
  }

  const providerStatus = await buildProviderStatus(resolution.provider.id);

  if (providerStatus.status !== "ready") {
    return {
      ok: false,
      action: "connect",
      provider: providerStatus,
      message: `${providerStatus.title} is planned, but it is not wired yet.`,
    };
  }

  if (resolution.provider.connectionType !== "oauth") {
    return {
      ok: false,
      action: "connect",
      provider: providerStatus,
      message: `${providerStatus.title} needs a native Mac permission bridge, not a web OAuth flow.`,
    };
  }

  if (!providerStatus.configured) {
    return {
      ok: false,
      action: "connect",
      provider: providerStatus,
      message: `${providerStatus.title} is not configured on this Mac yet. The OAuth client credentials still need to be set in Nicole's local environment.`,
    };
  }

  if (providerStatus.connected) {
    return {
      ok: true,
      action: "connect",
      provider: providerStatus,
      message: `${providerStatus.title} is already connected.`,
    };
  }

  const connectUrl = buildLocalConnectUrl(resolution.provider.id);
  const shouldOpenBrowser = options?.clientSurface === "macos";
  let browserOpened = false;
  let browserOpenError: string | null = null;

  if (shouldOpenBrowser) {
    const launched = await openExternalUrl(connectUrl);
    browserOpened = launched.ok;
    browserOpenError = launched.error ?? null;
  }

  return {
    ok: true,
    action: "connect",
    provider: providerStatus,
    message: browserOpened
      ? `I opened the ${providerStatus.title} sign-in flow. Finish the consent in your browser, then come back to me.`
      : `Open the ${providerStatus.title} connection flow and finish the consent there.`,
    connectUrl,
    browserOpened,
    browserOpenError,
    requiresUserAction: true,
  };
}

export async function disconnectIntegration(
  providerQuery: string
): Promise<IntegrationOperationResult> {
  const resolution = resolveIntegrationProviderQuery(providerQuery);

  if (resolution.unsupportedService) {
    return {
      ok: false,
      action: "disconnect",
      provider: null,
      message: buildUnsupportedMessage(resolution.unsupportedService),
      unsupportedService: resolution.unsupportedService,
      suggestions: resolution.suggestions,
    };
  }

  if (resolution.ambiguous || !resolution.provider) {
    return {
      ok: false,
      action: "disconnect",
      provider: null,
      message:
        "Be specific about which integration you want me to disconnect.",
      suggestions: resolution.suggestions || ["gmail", "google calendar", "zoho mail"],
    };
  }

  const providerStatus = await buildProviderStatus(resolution.provider.id);

  if (!providerStatus.connected) {
    return {
      ok: true,
      action: "disconnect",
      provider: providerStatus,
      message: `${providerStatus.title} is not connected.`,
    };
  }

  await disconnectIntegrationAccount(resolution.provider.id);
  const disconnectedStatus = await buildProviderStatus(resolution.provider.id);

  return {
    ok: true,
    action: "disconnect",
    provider: disconnectedStatus,
    message: `${providerStatus.title} is disconnected.`,
  };
}

export function normalizeIntegrationProviderQuery(providerQuery?: string): string {
  return (providerQuery || "")
    .trim()
    .toLowerCase()
    .replace(/\bcalender\b/g, "calendar")
    .replace(/\bcalandar\b/g, "calendar")
    .replace(/\bg mail\b/g, "gmail")
    .replace(/\bgoogel\b/g, "google")
    .replace(/\bremider\b/g, "reminder")
    .replace(/\breminderss\b/g, "reminders")
    .replace(/[?.!,;:()/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveIntegrationProviderQuery(
  providerQuery?: string
): ProviderResolution {
  const query = normalizeIntegrationProviderQuery(providerQuery);

  if (!query) {
    return { provider: null };
  }

  if (/^(?:calendar)$/i.test(query)) {
    return {
      provider: null,
      ambiguous: true,
      suggestions: ["google calendar", "apple calendar"],
    };
  }

  if (/^(?:mail|email|inbox)$/i.test(query)) {
    return {
      provider: null,
      ambiguous: true,
      suggestions: ["gmail", "zoho mail"],
    };
  }

  if (/^(?:reminder|reminders)$/i.test(query)) {
    return {
      provider: getIntegrationProvider("apple_reminders"),
    };
  }

  const scored = INTEGRATION_PROVIDERS.map((provider) => ({
    provider,
    score: scoreIntegrationProviderMatch(query, provider.id),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1) {
    return { provider: scored[0].provider };
  }

  if (scored.length > 1) {
    const [first, second] = scored;
    if (first.score > second.score) {
      return { provider: first.provider };
    }

    return {
      provider: null,
      ambiguous: true,
      suggestions: scored.slice(0, 3).map((entry) => entry.provider.title.toLowerCase()),
    };
  }

  return {
    provider: null,
    ambiguous: true,
    suggestions: ["gmail", "google calendar", "zoho mail"],
  };
}

function scoreIntegrationProviderMatch(
  query: string,
  providerId: IntegrationProviderId
): number {
  const aliases = INTEGRATION_PROVIDER_ALIASES[providerId] || [];
  let bestScore = 0;

  for (const alias of aliases) {
    const normalizedAlias = normalizeIntegrationProviderQuery(alias);
    if (query === normalizedAlias) {
      bestScore = Math.max(bestScore, 100);
      continue;
    }

    if (query.includes(normalizedAlias)) {
      bestScore = Math.max(bestScore, 85);
      continue;
    }

    const queryTokens = new Set(query.split(" "));
    const aliasTokens = normalizedAlias.split(" ");
    const tokenMatches = aliasTokens.filter((token) => queryTokens.has(token)).length;

    if (tokenMatches > 0 && tokenMatches === aliasTokens.length) {
      bestScore = Math.max(bestScore, 72);
      continue;
    }

    if (tokenMatches > 0) {
      bestScore = Math.max(bestScore, 40 + tokenMatches * 10);
    }
  }

  return bestScore;
}

async function buildAllProviderStatuses(): Promise<IntegrationStatusRecord[]> {
  const accounts = await listIntegrationAccounts();
  const byProvider = new Map(accounts.map((account) => [account.provider, account]));

  return INTEGRATION_PROVIDERS.map((provider) =>
    toIntegrationStatusRecord(provider, byProvider.get(provider.id) || null)
  );
}

async function buildProviderStatus(
  providerId: IntegrationProviderId
): Promise<IntegrationStatusRecord> {
  const provider = getIntegrationProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const account = await getIntegrationAccount(providerId);
  return toIntegrationStatusRecord(provider, account);
}

function toIntegrationStatusRecord(
  provider: IntegrationProviderDefinition,
  account: IntegrationAccountLike | null
): IntegrationStatusRecord {
  return {
    providerId: provider.id,
    title: provider.title,
    kind: provider.kind,
    connectionType: provider.connectionType,
    status: provider.status,
    configured: isProviderConfigured(provider.id),
    connected: Boolean(account),
    account: account
      ? {
          displayName: account.displayName,
          email: account.email,
          connectedAt: account.connectedAt
            ? account.connectedAt.toISOString()
            : null,
        }
      : null,
  };
}

function buildLocalConnectUrl(providerId: IntegrationProviderId): string {
  const origin =
    process.env.APP_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3000";

  return `${origin.replace(/\/+$/, "")}/api/integrations/connect/${providerId}`;
}

async function openExternalUrl(
  url: string
): Promise<{ ok: boolean; error?: string }> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "linux"
        ? "xdg-open"
        : null;

  if (!command) {
    return {
      ok: false,
      error: `Automatic browser launch is not supported on ${process.platform}.`,
    };
  }

  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to open the browser.",
    };
  }
}

function buildUnsupportedMessage(service: string): string {
  return `${service} is not wired yet.`;
}
