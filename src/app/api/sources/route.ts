import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sources, chunks } from "@/lib/db/schema";
import { count, desc, eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    const scope = req.nextUrl.searchParams.get("scope");
    const allSources = await db
      .select({
        id: sources.id,
        title: sources.title,
        type: sources.type,
        scope: sources.scope,
        url: sources.url,
        ingestedAt: sources.ingestedAt,
        chunkCount: count(chunks.id),
      })
      .from(sources)
      .leftJoin(chunks, eq(sources.id, chunks.sourceId))
      .where(scope ? eq(sources.scope, scope) : undefined)
      .groupBy(sources.id)
      .orderBy(desc(sources.ingestedAt));

    return NextResponse.json(allSources);
  } catch (error) {
    console.error("Sources error:", error);
    return NextResponse.json(
      { error: "Failed to fetch sources" },
      { status: 500 }
    );
  }
}
