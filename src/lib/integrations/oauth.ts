import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { integrationAccounts } from "@/lib/db/schema";
import {
  getIntegrationProvider,
  getProviderScopes,
  IntegrationProviderDefinition,
  IntegrationProviderId,
  isProviderConfigured,
} from "./providers";

export interface StoredIntegrationAccount {
  id: string;
  provider: string;
  kind: string;
  status: string;
  displayName: string | null;
  email: string | null;
  externalAccountId: string | null;
  scope: string | null;
  connectedAt: Date | null;
  updatedAt: Date | null;
  tokenExpiresAt: Date | null;
  metadata: unknown;
}

interface OAuthTokenPayload {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

export async function listIntegrationAccounts() {
  return db
    .select({
      id: integrationAccounts.id,
      provider: integrationAccounts.provider,
      kind: integrationAccounts.kind,
      status: integrationAccounts.status,
      displayName: integrationAccounts.displayName,
      email: integrationAccounts.email,
      externalAccountId: integrationAccounts.externalAccountId,
      scope: integrationAccounts.scope,
      connectedAt: integrationAccounts.connectedAt,
      updatedAt: integrationAccounts.updatedAt,
      tokenExpiresAt: integrationAccounts.tokenExpiresAt,
      metadata: integrationAccounts.metadata,
    })
    .from(integrationAccounts);
}

export async function getIntegrationAccount(providerId: IntegrationProviderId) {
  const rows = await db
    .select()
    .from(integrationAccounts)
    .where(eq(integrationAccounts.provider, providerId))
    .limit(1);

  return rows[0] || null;
}

export async function disconnectIntegrationAccount(
  providerId: IntegrationProviderId
) {
  await db
    .delete(integrationAccounts)
    .where(eq(integrationAccounts.provider, providerId));
}

export function getCallbackOrigin(origin: string): string {
  return (
    process.env.APP_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    origin
  );
}

export function getProviderCallbackUrl(
  providerId: IntegrationProviderId,
  origin: string
) {
  return `${getCallbackOrigin(origin)}/api/integrations/callback/${providerId}`;
}

export function createIntegrationState(providerId: IntegrationProviderId) {
  return `${providerId}:${crypto.randomUUID()}`;
}

export function getStateCookieName(providerId: IntegrationProviderId) {
  return `nicole_oauth_state_${providerId}`;
}

export function buildAuthorizationUrl(
  providerId: IntegrationProviderId,
  origin: string,
  state: string
) {
  const provider = getRequiredOAuthProvider(providerId);
  const redirectUri = getProviderCallbackUrl(providerId, origin);

  switch (providerId) {
    case "google_calendar": {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!.trim());
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("scope", getProviderScopes(providerId).join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    }
    case "zoho_mail": {
      const accountsOrigin =
        process.env.ZOHO_ACCOUNTS_BASE_URL?.trim() || "https://accounts.zoho.com";
      const url = new URL("/oauth/v2/auth", accountsOrigin);
      url.searchParams.set("client_id", process.env.ZOHO_CLIENT_ID!.trim());
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("scope", getProviderScopes(providerId).join(","));
      url.searchParams.set("state", state);
      return url.toString();
    }
    default:
      throw new Error(`OAuth is not supported for ${provider.title}.`);
  }
}

export async function handleOAuthCallback(
  providerId: IntegrationProviderId,
  code: string,
  origin: string
) {
  const redirectUri = getProviderCallbackUrl(providerId, origin);

  switch (providerId) {
    case "google_calendar": {
      const token = await exchangeGoogleCode(code, redirectUri);
      const profile = await fetchGoogleProfile(token.access_token);
      await upsertIntegrationAccount(providerId, token, {
        displayName: profile.name || "Google Calendar",
        email: profile.email || null,
        externalAccountId: profile.sub || null,
        metadata: profile,
      });
      return;
    }
    case "zoho_mail": {
      const token = await exchangeZohoCode(code, redirectUri);
      const profile = await fetchZohoProfile(token.access_token);
      await upsertIntegrationAccount(providerId, token, {
        displayName:
          profile.displayName || profile.emailAddress || "Zoho Mail",
        email: profile.emailAddress || null,
        externalAccountId: profile.accountId || null,
        metadata: profile.raw,
      });
      return;
    }
    default:
      throw new Error(`OAuth callback is not supported for ${providerId}.`);
  }
}

export async function getValidAccessToken(providerId: IntegrationProviderId) {
  const account = await getIntegrationAccount(providerId);
  if (!account || !account.accessToken) {
    return null;
  }

  if (
    account.tokenExpiresAt &&
    account.tokenExpiresAt.getTime() > Date.now() + 60_000
  ) {
    return account.accessToken;
  }

  if (!account.refreshToken) {
    return account.accessToken;
  }

  const refreshed =
    providerId === "google_calendar"
      ? await refreshGoogleToken(account.refreshToken)
      : providerId === "zoho_mail"
        ? await refreshZohoToken(account.refreshToken)
        : null;

  if (!refreshed) {
    return account.accessToken;
  }

  await upsertIntegrationAccount(providerId, refreshed, {
    displayName: account.displayName,
    email: account.email,
    externalAccountId: account.externalAccountId,
    metadata: account.metadata,
  });

  return refreshed.access_token;
}

async function upsertIntegrationAccount(
  providerId: IntegrationProviderId,
  token: OAuthTokenPayload,
  profile: {
    displayName: string | null;
    email: string | null;
    externalAccountId: string | null;
    metadata: unknown;
  }
) {
  const provider = getRequiredOAuthProvider(providerId);
  const expiresAt =
    typeof token.expires_in === "number"
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;

  const values = {
    provider: provider.id,
    kind: provider.kind,
    status: "connected",
    displayName: profile.displayName,
    email: profile.email,
    externalAccountId: profile.externalAccountId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    tokenType: token.token_type || null,
    scope: token.scope || getProviderScopes(providerId).join(" "),
    tokenExpiresAt: expiresAt,
    metadata: profile.metadata,
    connectedAt: new Date(),
    updatedAt: new Date(),
  };

  const existing = await getIntegrationAccount(providerId);

  if (existing) {
    await db
      .update(integrationAccounts)
      .set(values)
      .where(eq(integrationAccounts.provider, providerId));
    return;
  }

  await db.insert(integrationAccounts).values(values);
}

function getRequiredOAuthProvider(
  providerId: IntegrationProviderId
): IntegrationProviderDefinition {
  const provider = getIntegrationProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown integration provider: ${providerId}`);
  }

  if (provider.connectionType !== "oauth") {
    throw new Error(`${provider.title} does not use OAuth.`);
  }

  if (!isProviderConfigured(providerId)) {
    throw new Error(
      `${provider.title} is not configured yet. Add the required OAuth env vars first.`
    );
  }

  return provider;
}

async function exchangeGoogleCode(code: string, redirectUri: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
      client_secret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${await response.text()}`);
  }

  return (await response.json()) as OAuthTokenPayload;
}

async function refreshGoogleToken(refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
      client_secret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${await response.text()}`);
  }

  const payload = (await response.json()) as OAuthTokenPayload;
  payload.refresh_token = refreshToken;
  return payload;
}

async function fetchGoogleProfile(accessToken: string) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return { name: null, email: null, sub: null };
  }

  return (await response.json()) as {
    name?: string;
    email?: string;
    sub?: string;
  };
}

async function exchangeZohoCode(code: string, redirectUri: string) {
  const accountsOrigin =
    process.env.ZOHO_ACCOUNTS_BASE_URL?.trim() || "https://accounts.zoho.com";

  const response = await fetch(`${accountsOrigin}/oauth/v2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.ZOHO_CLIENT_ID!.trim(),
      client_secret: process.env.ZOHO_CLIENT_SECRET!.trim(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(`Zoho token exchange failed: ${await response.text()}`);
  }

  return (await response.json()) as OAuthTokenPayload;
}

async function refreshZohoToken(refreshToken: string) {
  const accountsOrigin =
    process.env.ZOHO_ACCOUNTS_BASE_URL?.trim() || "https://accounts.zoho.com";

  const response = await fetch(`${accountsOrigin}/oauth/v2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: process.env.ZOHO_CLIENT_ID!.trim(),
      client_secret: process.env.ZOHO_CLIENT_SECRET!.trim(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Zoho token refresh failed: ${await response.text()}`);
  }

  const payload = (await response.json()) as OAuthTokenPayload;
  payload.refresh_token = refreshToken;
  return payload;
}

async function fetchZohoProfile(accessToken: string) {
  const response = await fetch("https://mail.zoho.com/api/accounts", {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  if (!response.ok) {
    return {
      displayName: null,
      emailAddress: null,
      accountId: null,
      raw: null,
    };
  }

  const data = (await response.json()) as {
    data?: Array<{
      accountId?: string;
      displayName?: string;
      primaryEmailAddress?: string;
      emailAddress?: string;
    }>;
  };

  const account = data.data?.[0];

  return {
    displayName: account?.displayName || null,
    emailAddress:
      account?.primaryEmailAddress || account?.emailAddress || null,
    accountId: account?.accountId || null,
    raw: data,
  };
}
