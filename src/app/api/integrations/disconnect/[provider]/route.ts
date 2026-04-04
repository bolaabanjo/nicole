import { NextRequest, NextResponse } from "next/server";
import { disconnectIntegrationAccount } from "@/lib/integrations/oauth";
import { getIntegrationProvider } from "@/lib/integrations/providers";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider: providerId } = await context.params;
  const provider = getIntegrationProvider(providerId);

  if (!provider) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }

  try {
    await disconnectIntegrationAccount(provider.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to disconnect integration:", error);
    return NextResponse.json(
      { error: "Failed to disconnect integration." },
      { status: 500 }
    );
  }
}
