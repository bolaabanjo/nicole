import { NextResponse } from "next/server";
import { loadAllMessages } from "@/lib/ai/memory";

export async function GET() {
  try {
    const messages = await loadAllMessages();
    return NextResponse.json(messages);
  } catch (error) {
    console.error("History error:", error);
    return NextResponse.json([], { status: 500 });
  }
}
