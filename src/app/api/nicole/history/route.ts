import { NextRequest, NextResponse } from "next/server";
import { loadAllMessages } from "@/lib/ai/memory";
import {
  requireTrustedDeviceForIOS,
  TrustedDeviceAuthError,
} from "@/lib/auth/trusted-devices";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    await requireTrustedDeviceForIOS(req);
    const messages = await loadAllMessages();
    return NextResponse.json(messages, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    if (error instanceof TrustedDeviceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("History error:", error);
    return NextResponse.json([], { status: 500 });
  }
}
