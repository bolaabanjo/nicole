import { NextRequest, NextResponse } from "next/server";
import { ingest } from "@/lib/ingestion";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const type = formData.get("type") as string;
    const title = formData.get("title") as string;

    if (!type || !title) {
      return NextResponse.json(
        { error: "type and title are required" },
        { status: 400 }
      );
    }

    if (type === "pdf") {
      const file = formData.get("file") as File;
      if (!file) {
        return NextResponse.json(
          { error: "file is required for PDF" },
          { status: 400 }
        );
      }

      // Save file to uploads/
      const uploadsDir = path.join(process.cwd(), "uploads");
      await mkdir(uploadsDir, { recursive: true });
      const filePath = path.join(uploadsDir, `${Date.now()}-${file.name}`);
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(filePath, buffer);

      const result = await ingest({ type: "pdf", title, filePath });
      return NextResponse.json(result);
    }

    if (type === "url") {
      const url = formData.get("url") as string;
      if (!url) {
        return NextResponse.json(
          { error: "url is required" },
          { status: 400 }
        );
      }

      const result = await ingest({ type: "url", title, url });
      return NextResponse.json(result);
    }

    if (type === "note") {
      const content = formData.get("content") as string;
      if (!content) {
        return NextResponse.json(
          { error: "content is required for note" },
          { status: 400 }
        );
      }

      const result = await ingest({ type: "note", title, content });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  } catch (error) {
    console.error("Ingest error:", error);
    return NextResponse.json(
      { error: "Failed to ingest source" },
      { status: 500 }
    );
  }
}
