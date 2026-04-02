import { NextRequest, NextResponse } from "next/server";
import {
  formatWorkspaceContextForPrompt,
  normalizeWorkspaceContext,
} from "@/lib/ai/context";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { context?: unknown };
    const context = normalizeWorkspaceContext(body.context);
    const summary = formatWorkspaceContextForPrompt(context);

    return NextResponse.json({
      context: context ?? null,
      summary: summary ?? null,
      ready: Boolean(summary),
    });
  } catch (error) {
    console.error("Nicole context error:", error);
    return NextResponse.json(
      { error: "Invalid workspace context payload." },
      { status: 400 }
    );
  }
}
