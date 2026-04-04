import { NextRequest, NextResponse } from "next/server";
import {
  buildAuthorizationUrl,
  createIntegrationState,
  getStateCookieName,
} from "@/lib/integrations/oauth";
import { getIntegrationProvider } from "@/lib/integrations/providers";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider: providerId } = await context.params;
  const provider = getIntegrationProvider(providerId);

  if (!provider) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }

  if (provider.connectionType !== "oauth") {
    return NextResponse.json(
      { error: `${provider.title} does not use OAuth from the web app.` },
      { status: 400 }
    );
  }

  try {
    const state = createIntegrationState(provider.id);
    const authUrl = buildAuthorizationUrl(
      provider.id,
      request.nextUrl.origin,
      state
    );

    const response = NextResponse.redirect(authUrl);
    response.cookies.set(getStateCookieName(provider.id), state, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 10,
    });

    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start connection.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
