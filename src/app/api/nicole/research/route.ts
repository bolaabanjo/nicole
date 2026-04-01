import { NextRequest, NextResponse } from "next/server";
import { deepResearch } from "@/lib/search/research";

export async function POST(req: NextRequest) {
  try {
    const { query }: { query: string } = await req.json();

    if (!query?.trim()) {
      return NextResponse.json(
        { error: "Query is required" },
        { status: 400 }
      );
    }

    const result = await deepResearch(query);

    return NextResponse.json({
      message: `Done. Read ${result.pagesRead} pages, extracted ${result.factsExtracted} facts.`,
      ...result,
    });
  } catch (error) {
    console.error("Research error:", error);
    return NextResponse.json(
      { error: "Research failed" },
      { status: 500 }
    );
  }
}
