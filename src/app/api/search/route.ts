import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  // TODO: Semantic search across all chunks
  // 1. Embed the query via Cencori
  // 2. Vector similarity search in pgvector
  // 3. Return ranked chunks with source metadata

  return NextResponse.json(
    { message: "Search not yet implemented" },
    { status: 501 }
  );
}
