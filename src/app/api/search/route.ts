import { NextRequest, NextResponse } from "next/server";
import { searchRelevantSourceChunks } from "@/lib/search/semantic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      query?: string;
      limit?: number;
    };
    const query = body.query?.trim();

    if (!query) {
      return NextResponse.json(
        { error: "query is required" },
        { status: 400 }
      );
    }

    const results = await searchRelevantSourceChunks(
      query,
      Math.min(Math.max(body.limit ?? 8, 1), 12)
    );

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json(
      { error: "Failed to search sources" },
      { status: 500 }
    );
  }
}
