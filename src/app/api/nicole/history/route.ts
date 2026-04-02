import { NextResponse } from "next/server";
import { loadAllMessages } from "@/lib/ai/memory";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const messages = await loadAllMessages();
    return NextResponse.json(messages, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    console.error("History error:", error);
    return NextResponse.json([], { status: 500 });
  }
}
