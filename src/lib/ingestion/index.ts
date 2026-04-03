import { db } from "@/lib/db/client";
import { sources, chunks } from "@/lib/db/schema";
import { parsePdf } from "./parsers/pdf";
import { parseUrl } from "./parsers/url";
import { parseMarkdown } from "./parsers/markdown";
import { chunkText } from "./chunker";
import { embed, isEmbeddingAvailable } from "@/lib/ai/router";
import { eq } from "drizzle-orm";

interface IngestResult {
  sourceId: string;
  title: string;
  chunkCount: number;
  embeddingsGenerated: boolean;
}

/**
 * Ingest a source into Nicole's knowledge base.
 *
 * 1. Parse to text (works offline)
 * 2. Chunk semantically (works offline)
 * 3. Store source + chunks in Postgres (works offline)
 * 4. Generate embeddings via the configured embedding provider.
 */
export async function ingest(input: {
  type: "pdf" | "url" | "note";
  title: string;
  filePath?: string;
  url?: string;
  content?: string;
}): Promise<IngestResult> {
  // 1. Parse to text
  let rawText: string;

  switch (input.type) {
    case "pdf":
      if (!input.filePath) throw new Error("filePath required for PDF");
      rawText = await parsePdf(input.filePath);
      break;
    case "url":
      if (!input.url) throw new Error("url required");
      rawText = await parseUrl(input.url);
      break;
    case "note":
      if (!input.content) throw new Error("content required for note");
      rawText = parseMarkdown(input.content);
      break;
    default:
      throw new Error(`Unknown type: ${input.type}`);
  }

  // 2. Chunk
  const textChunks = chunkText(rawText);

  // 3. Store source
  const [source] = await db
    .insert(sources)
    .values({
      title: input.title,
      type: input.type,
      filePath: input.filePath || null,
      url: input.url || null,
      rawText,
    })
    .returning();

  // 4. Store chunks
  const chunkRecords = textChunks.map((content, i) => ({
    sourceId: source.id,
    content,
    position: i,
  }));

  if (chunkRecords.length > 0) {
    await db.insert(chunks).values(chunkRecords);
  }

  // 5. Generate embeddings when an embedding provider is configured
  let embeddingsGenerated = false;

  if (isEmbeddingAvailable()) {
    try {
      // Fetch the inserted chunks to get their IDs
      const insertedChunks = await db.query.chunks.findMany({
        where: (c, { eq }) => eq(c.sourceId, source.id),
        orderBy: (c, { asc }) => [asc(c.position)],
      });

      for (const chunk of insertedChunks) {
        const embedding = await embed(chunk.content);
        await db
          .update(chunks)
          .set({ embedding })
          .where(eq(chunks.id, chunk.id));
      }

      embeddingsGenerated = true;
    } catch (error) {
      console.error("Embedding generation failed:", error);
      // Not critical — chunks are stored, embeddings can be generated later
    }
  }

  return {
    sourceId: source.id,
    title: input.title,
    chunkCount: textChunks.length,
    embeddingsGenerated,
  };
}
