const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8888";

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

/**
 * Search the web via local SearXNG instance.
 */
export async function searchWeb(
  query: string,
  limit = 5
): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({
      q: query,
      format: "json",
      categories: "general",
    });

    const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`SearXNG error: ${res.status}`);
      return [];
    }

    const data = await res.json();

    return (data.results || []).slice(0, limit).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      content: r.content || "",
    }));
  } catch (error) {
    console.error("Web search failed:", error);
    return [];
  }
}

/**
 * Format search results into context for Nicole.
 */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "";

  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\n${r.url}`)
    .join("\n\n");
}
