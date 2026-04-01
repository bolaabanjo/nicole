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
 * Fetch and extract text from a URL.
 */
export async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Nicole/1.0; Personal Research)",
      },
    });

    if (!res.ok) return "";

    const html = await res.text();

    // Strip HTML tags, scripts, styles
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Limit to ~3000 words to keep it manageable
    return text.split(/\s+/).slice(0, 3000).join(" ");
  } catch {
    return "";
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
