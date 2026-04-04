import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8888";
const SEARXNG_ENGINES = process.env.SEARXNG_ENGINES || "google";
const ALLOW_NON_GOOGLE_SEARCH_FALLBACK =
  process.env.ALLOW_NON_GOOGLE_SEARCH_FALLBACK?.trim().toLowerCase() === "true";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_WORDS = 4000;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchResponse {
  results: SearchResult[];
  provider: "google" | "duckduckgo";
  error?: string;
}

export interface PageContent {
  title: string;
  url: string;
  text: string;
  wordCount: number;
}

// ---------------------------------------------------------------------------
// Primary: SearXNG
// ---------------------------------------------------------------------------

async function searchSearXNG(
  query: string,
  limit: number,
  categories: string
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories,
    engines: SEARXNG_ENGINES,
  });

  const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`SearXNG returned ${res.status}`);
  }

  const data = await res.json();
  const results = (data.results || []).slice(0, limit).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    content: r.content || "",
  }));

  console.log(`[SearXNG] query="${query}" → ${results.length} results from ${SEARXNG_ENGINES}${results.length === 0 ? " (EMPTY)" : ""}`);
  if (results.length > 0) {
    console.log(`[SearXNG] top result: "${results[0].title}" → ${results[0].url}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fallback: DuckDuckGo HTML (no API key needed)
// ---------------------------------------------------------------------------

async function searchDuckDuckGo(
  query: string,
  limit: number
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });

  const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...FETCH_HEADERS,
      Accept: "text/html",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo returned ${res.status}`);
  }

  const html = await res.text();
  const results: SearchResult[] = [];

  // Parse DDG HTML results — each result lives in a .result class
  const resultBlocks = html.split(/class="result\s/);

  for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
    const block = resultBlocks[i];

    // Extract title and URL from the result link
    const linkMatch = block.match(
      /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/
    );
    if (!linkMatch) continue;

    let url = linkMatch[1];
    const title = linkMatch[2].replace(/<[^>]+>/g, "").trim();

    // DDG wraps URLs in a redirect — extract the actual URL
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    // Extract snippet
    const snippetMatch = block.match(
      /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/
    );
    const content = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";

    if (url && title) {
      results.push({ title, url, content });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public search API: SearXNG → DuckDuckGo
// ---------------------------------------------------------------------------

/**
 * Search the web. Google results via SearXNG, DuckDuckGo as fallback.
 */
export async function searchWeb(
  query: string,
  limit = 5,
  categories = "general"
): Promise<SearchResponse> {
  // 1. Google via SearXNG
  try {
    const results = await searchSearXNG(query, limit, categories);
    return { results, provider: "google" };
  } catch (error) {
    console.error("Google search via SearXNG failed:", error);
  }

  // 2. DuckDuckGo fallback
  if (ALLOW_NON_GOOGLE_SEARCH_FALLBACK) {
    try {
      const results = await searchDuckDuckGo(query, limit);
      return { results, provider: "duckduckgo" };
    } catch (error) {
      console.error("DuckDuckGo fallback also failed:", error);
    }
  }

  return {
    results: [],
    provider: "google",
    error: "Google search via SearXNG is unavailable.",
  };
}

// ---------------------------------------------------------------------------
// Page content extraction
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and extract readable content using Mozilla Readability.
 * Falls back to basic tag stripping if Readability can't parse the page.
 */
export async function fetchPageContent(url: string): Promise<PageContent> {
  const empty: PageContent = { title: "", url, text: "", wordCount: 0 };

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: FETCH_HEADERS,
      redirect: "follow",
    });

    if (!res.ok) return empty;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return empty;
    }

    const html = await res.text();
    const { document } = parseHTML(html);

    // Try Readability first — it extracts the article body cleanly
    const reader = new Readability(document as any);
    const article = reader.parse();

    let text: string;
    let title: string;

    if (article && article.textContent && article.textContent.trim().length > 100) {
      text = article.textContent;
      title = article.title || "";
    } else {
      // Fallback: strip tags manually
      text = fallbackExtract(html);
      title = document.querySelector("title")?.textContent || "";
    }

    // Clean up whitespace and limit length
    text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
    const words = text.split(/\s+/);
    if (words.length > MAX_WORDS) {
      text = words.slice(0, MAX_WORDS).join(" ");
    }

    return { title, url, text, wordCount: Math.min(words.length, MAX_WORDS) };
  } catch {
    return empty;
  }
}

/**
 * Legacy plain-text extraction. Used as fallback when Readability fails.
 */
function fallbackExtract(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Backward-compatible wrapper. Returns plain text string.
 */
export async function fetchPageText(url: string): Promise<string> {
  const page = await fetchPageContent(url);
  return page.text;
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
