import { NextRequest, NextResponse } from "next/server";
import {
  getStateCookieName,
  handleOAuthCallback,
} from "@/lib/integrations/oauth";
import { getIntegrationProvider } from "@/lib/integrations/providers";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider: providerId } = await context.params;
  const provider = getIntegrationProvider(providerId);
  const buildCompletionUrl = (status: "connected" | "error", reason?: string) => {
    const url = new URL("/connect/complete", request.url);
    url.searchParams.set("provider", providerId);
    url.searchParams.set("status", status);
    if (reason) {
      url.searchParams.set("reason", reason);
    }
    return url;
  };

  if (!provider) {
    return NextResponse.redirect(buildCompletionUrl("error", "unknown_provider"));
  }

  const error = request.nextUrl.searchParams.get("error");
  if (error) {
    const response = NextResponse.redirect(buildCompletionUrl("error", error));
    response.cookies.delete(getStateCookieName(provider.id));
    return response;
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(getStateCookieName(provider.id))?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    const response = NextResponse.redirect(
      buildCompletionUrl("error", "state_mismatch")
    );
    response.cookies.delete(getStateCookieName(provider.id));
    return response;
  }

  try {
    await handleOAuthCallback(provider.id, code, request.nextUrl.origin);
    const response = NextResponse.redirect(
      buildCompletionUrl("connected")
    );
    response.cookies.delete(getStateCookieName(provider.id));
    return response;
  } catch (callbackError) {
    console.error("Integration callback failed:", callbackError);
    const response = NextResponse.redirect(
      buildCompletionUrl("error", "callback_failed")
    );
    response.cookies.delete(getStateCookieName(provider.id));
    return response;
  }
}
