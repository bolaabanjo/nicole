/**
 * Semantic chunker — splits text into meaningful pieces.
 * Chunks by paragraphs, respecting natural boundaries.
 * Target: 200-500 words per chunk.
 */

const MIN_CHUNK_WORDS = 100;
const MAX_CHUNK_WORDS = 500;

export function chunkText(text: string): string[] {
  // Split by double newlines (paragraphs) or section headers
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const currentWords = wordCount(currentChunk);
    const paragraphWords = wordCount(paragraph);

    // If adding this paragraph exceeds max, flush current chunk
    if (currentWords + paragraphWords > MAX_CHUNK_WORDS && currentWords >= MIN_CHUNK_WORDS) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
