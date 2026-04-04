import { NextResponse } from "next/server";
import { listIntegrationAccounts } from "@/lib/integrations/oauth";
import {
  INTEGRATION_PROVIDERS,
  isProviderConfigured,
} from "@/lib/integrations/providers";

export async function GET() {
  try {
    const accounts = await listIntegrationAccounts();
    const byProvider = new Map(accounts.map((account) => [account.provider, account]));

    const payload = INTEGRATION_PROVIDERS.map((provider) => {
      const account = byProvider.get(provider.id);
      return {
        ...provider,
        configured: isProviderConfigured(provider.id),
        connected: Boolean(account),
        account: account
          ? {
              provider: account.provider,
              status: account.status,
              displayName: account.displayName,
              email: account.email,
              connectedAt: account.connectedAt,
              updatedAt: account.updatedAt,
            }
          : null,
      };
    });

    return NextResponse.json(payload);
  } catch (error) {
    console.error("Failed to load integrations:", error);
    return NextResponse.json(
      { error: "Failed to load integrations." },
      { status: 500 }
    );
  }
}
