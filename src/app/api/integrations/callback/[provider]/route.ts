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

  if (!provider) {
    return NextResponse.redirect(
      new URL("/integrations?error=unknown_provider", request.url)
    );
  }

  const error = request.nextUrl.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(
      new URL(
        `/integrations?error=${encodeURIComponent(`${provider.id}:${error}`)}`,
        request.url
      )
    );
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(getStateCookieName(provider.id))?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(
      new URL(
        `/integrations?error=${encodeURIComponent(`${provider.id}:state_mismatch`)}`,
        request.url
      )
    );
  }

  try {
    await handleOAuthCallback(provider.id, code, request.nextUrl.origin);
    const response = NextResponse.redirect(
      new URL(`/integrations?connected=${provider.id}`, request.url)
    );
    response.cookies.delete(getStateCookieName(provider.id));
    return response;
  } catch (callbackError) {
    console.error("Integration callback failed:", callbackError);
    return NextResponse.redirect(
      new URL(
        `/integrations?error=${encodeURIComponent(
          `${provider.id}:callback_failed`
        )}`,
        request.url
      )
    );
  }
}
