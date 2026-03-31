import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  // TODO: Phase 2 — Ingestion pipeline
  // 1. Accept file upload or URL
  // 2. Parse to text (pdf.ts, url.ts, markdown.ts, youtube.ts)
  // 3. Chunk semantically
  // 4. Generate embeddings via Cencori (queue if offline)
  // 5. Extract concepts via Cencori (queue if offline)
  // 6. Store in Postgres

  return NextResponse.json(
    { message: "Ingestion pipeline not yet implemented" },
    { status: 501 }
  );
}
