import { db } from "@/lib/db/client";
import { chunks, sources } from "@/lib/db/schema";
import { embed } from "@/lib/ai/router";
import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  ilike,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";

const DEFAULT_RESULT_LIMIT = 8;
const MAX_CHUNKS_PER_SOURCE = 2;
const MAX_CONTEXT_CHARS = 5000;

export interface SourceChunkMatch {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: string;
  content: string;
  position: number | null;
  score: number | null;
  matchType: "semantic" | "keyword";
}

export async function searchRelevantSourceChunks(
  query: string,
  limit = DEFAULT_RESULT_LIMIT
): Promise<SourceChunkMatch[]> {
  const trimmed = query.trim();

  if (!trimmed) return [];

  const semanticMatches = await semanticChunkSearch(trimmed, limit);
  if (semanticMatches.length > 0) {
    return semanticMatches;
  }

  return keywordChunkSearch(trimmed, limit);
}

export async function loadRelevantSourceContext(
  query: string,
  limit = DEFAULT_RESULT_LIMIT
): Promise<string> {
  if (!shouldUseSourceRetrieval(query)) {
    return "";
  }

  const matches = await searchRelevantSourceChunks(query, limit);
  if (matches.length === 0) {
    return "";
  }

  return formatRelevantSourceContext(matches);
}

function shouldUseSourceRetrieval(query: string): boolean {
  const normalized = query.trim().toLowerCase();

  if (!normalized) return false;

  const casualPatterns = [
    /^hi[.!?]*$/,
    /^hey[.!?]*$/,
    /^hello[.!?]*$/,
    /^yo[.!?]*$/,
    /^sup[.!?]*$/,
    /^what'?s up[.!?]*$/,
    /^how are you[.!?]*$/,
  ];

  if (casualPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  if (
    /\b(notes?|source|sources|document|pdf|paper|chapter|library|study|quiz|summari[sz]e|explain|according to|from my)\b/.test(
      normalized
    )
  ) {
    return true;
  }

  return normalized.length >= 18;
}

async function semanticChunkSearch(
  query: string,
  limit: number
): Promise<SourceChunkMatch[]> {
  try {
    const queryEmbedding = await embed(query);
    const distance = cosineDistance(chunks.embedding, queryEmbedding);

    const rows = await db
      .select({
        chunkId: chunks.id,
        sourceId: sources.id,
        sourceTitle: sources.title,
        sourceType: sources.type,
        content: chunks.content,
        position: chunks.position,
        score: distance,
      })
      .from(chunks)
      .innerJoin(sources, eq(chunks.sourceId, sources.id))
      .where(isNotNull(chunks.embedding))
      .orderBy(distance, asc(chunks.position))
      .limit(limit * 3);

    return diversifyMatches(
      rows.map((row) => ({
        ...row,
        score: typeof row.score === "number" ? row.score : Number(row.score),
        matchType: "semantic" as const,
      })),
      limit
    );
  } catch (error) {
    console.error("Semantic source retrieval failed:", error);
    return [];
  }
}

async function keywordChunkSearch(
  query: string,
  limit: number
): Promise<SourceChunkMatch[]> {
  const terms = extractSearchTerms(query);

  if (terms.length === 0) {
    return [];
  }

  const conditions = terms.flatMap((term) => {
    const pattern = `%${term}%`;
    return [ilike(chunks.content, pattern), ilike(sources.title, pattern)];
  });

  const keywordScore = sql<number>`(
    ${sql.join(
      terms.flatMap((term) => {
        const pattern = `%${term}%`;
        return [
          sql<number>`case when ${sources.title} ilike ${pattern} then 3 else 0 end`,
          sql<number>`case when ${chunks.content} ilike ${pattern} then 1 else 0 end`,
        ];
      }),
      sql` + `
    )}
  )`;

  const rows = await db
    .select({
      chunkId: chunks.id,
      sourceId: sources.id,
      sourceTitle: sources.title,
      sourceType: sources.type,
      content: chunks.content,
      position: chunks.position,
      score: keywordScore,
    })
    .from(chunks)
    .innerJoin(sources, eq(chunks.sourceId, sources.id))
    .where(and(or(...conditions), isNotNull(chunks.content)))
    .orderBy(desc(keywordScore), asc(chunks.position))
    .limit(limit * 3);

  return diversifyMatches(
    rows.map((row) => ({
      ...row,
      score: typeof row.score === "number" ? row.score : Number(row.score),
      matchType: "keyword" as const,
    })),
    limit
  );
}

function extractSearchTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
        .slice(0, 6)
    )
  );
}

function diversifyMatches(
  matches: SourceChunkMatch[],
  limit: number
): SourceChunkMatch[] {
  const perSourceCounts = new Map<string, number>();
  const selected: SourceChunkMatch[] = [];

  for (const match of matches) {
    const currentCount = perSourceCounts.get(match.sourceId) ?? 0;
    if (currentCount >= MAX_CHUNKS_PER_SOURCE) {
      continue;
    }

    selected.push(match);
    perSourceCounts.set(match.sourceId, currentCount + 1);

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

export function formatRelevantSourceContext(
  matches: SourceChunkMatch[],
  maxChars = MAX_CONTEXT_CHARS
): string {
  let remainingChars = maxChars;
  const sections: string[] = [];

  for (const match of matches) {
    const body =
      match.content.length > 900
        ? `${match.content.slice(0, 900).trim()}...`
        : match.content;
    const section = `[${match.sourceTitle}]\n${body}`;

    if (section.length > remainingChars && sections.length > 0) {
      break;
    }

    sections.push(
      section.length > remainingChars
        ? section.slice(0, Math.max(remainingChars - 3, 0)).trimEnd() + "..."
        : section
    );
    remainingChars -= section.length;

    if (remainingChars <= 0) {
      break;
    }
  }

  return sections.join("\n\n---\n\n");
}
