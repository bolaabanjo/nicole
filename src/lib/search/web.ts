import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8888";
const SEARXNG_ENGINES = process.env.SEARXNG_ENGINES || "";
const ALLOW_NON_GOOGLE_SEARCH_FALLBACK =
  process.env.ALLOW_NON_GOOGLE_SEARCH_FALLBACK?.trim().toLowerCase() === "true";
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const HEALTH_CACHE_TTL_MS = 5_000;
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 10_000;
const MIN_STRONG_SEARCH_RESULTS = 2;
const MAX_WORDS = 4000;
let searxngHealthCache: { checkedAt: number; available: boolean } | null = null;

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
  status: "ok" | "weak" | "unavailable";
  liveSearchAvailable: boolean;
  error?: string;
  warning?: string;
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
  });

  if (SEARXNG_ENGINES) {
    params.set("engines", SEARXNG_ENGINES);
  }

  const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`SearXNG returned ${res.status}`);
  }

  const data = await res.json();
  const results = normalizeSearchResults(data.results, limit, query);

  console.log(`[SearXNG] query="${query}" → ${results.length} results from ${SEARXNG_ENGINES || "all engines"}${results.length === 0 ? " (EMPTY)" : ""}`);
  if (results.length > 0) {
    console.log(`[SearXNG] top result: "${results[0].title}" → ${results[0].url}`);
  }

  return results;
}

async function checkSearXNGAvailability(): Promise<boolean> {
  const now = Date.now();

  if (
    searxngHealthCache &&
    now - searxngHealthCache.checkedAt < HEALTH_CACHE_TTL_MS
  ) {
    return searxngHealthCache.available;
  }

  try {
    const res = await fetch(SEARXNG_URL, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      redirect: "follow",
    });
    const available = res.ok;
    searxngHealthCache = { checkedAt: now, available };
    return available;
  } catch {
    searxngHealthCache = { checkedAt: now, available: false };
    return false;
  }
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

  return normalizeSearchResults(results, limit, query);
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
  const searxngAvailable = await checkSearXNGAvailability();

  if (!searxngAvailable) {
    const fallback = await tryDuckDuckGoFallback(query, limit);
    if (fallback) {
      return fallback;
    }

    return {
      results: [],
      provider: "google",
      status: "unavailable",
      liveSearchAvailable: false,
      error: "Live Google search is unavailable right now.",
      warning: "Live Google search is unavailable right now.",
    };
  }

  // 1. Google via SearXNG
  try {
    const results = await searchSearXNG(query, limit, categories);
    if (results.length === 0) {
      return {
        results,
        provider: "google",
        status: "weak",
        liveSearchAvailable: true,
        warning: "Live Google search returned no usable results.",
      };
    }

    if (results.length < Math.min(limit, MIN_STRONG_SEARCH_RESULTS)) {
      return {
        results,
        provider: "google",
        status: "weak",
        liveSearchAvailable: true,
        warning: "Live Google search returned thin or inconclusive results.",
      };
    }

    return {
      results,
      provider: "google",
      status: "ok",
      liveSearchAvailable: true,
    };
  } catch (error) {
    console.error("Google search via SearXNG failed:", error);
    searxngHealthCache = { checkedAt: Date.now(), available: false };
  }

  // 2. DuckDuckGo fallback
  const fallback = await tryDuckDuckGoFallback(query, limit);
  if (fallback) {
    return fallback;
  }

  return {
    results: [],
    provider: "google",
    status: "unavailable",
    liveSearchAvailable: false,
    error: "Live Google search is unavailable right now.",
    warning: "Live Google search is unavailable right now.",
  };
}

async function tryDuckDuckGoFallback(
  query: string,
  limit: number
): Promise<SearchResponse | null> {
  if (!ALLOW_NON_GOOGLE_SEARCH_FALLBACK) {
    return null;
  }

  try {
    const results = await searchDuckDuckGo(query, limit);
    if (results.length === 0) {
      return {
        results,
        provider: "duckduckgo",
        status: "weak",
        liveSearchAvailable: false,
        warning:
          "Live Google search was unavailable and the non-Google fallback returned no usable results.",
      };
    }

    return {
      results,
      provider: "duckduckgo",
      status:
        results.length < Math.min(limit, MIN_STRONG_SEARCH_RESULTS)
          ? "weak"
          : "ok",
      liveSearchAvailable: false,
      warning:
        "Live Google search was unavailable, so these results came from a non-Google fallback.",
    };
  } catch (error) {
    console.error("DuckDuckGo fallback also failed:", error);
    return null;
  }
}

function normalizeSearchResults(rawResults: unknown, limit: number, query = ""): SearchResult[] {
  if (!Array.isArray(rawResults)) {
    return [];
  }

  // 1. Parse all raw results
  const parsed: SearchResult[] = [];
  for (const rawResult of rawResults) {
    const result = {
      title:
        rawResult && typeof rawResult === "object" && "title" in rawResult
          ? String((rawResult as { title?: unknown }).title || "").trim()
          : "",
      url:
        rawResult && typeof rawResult === "object" && "url" in rawResult
          ? String((rawResult as { url?: unknown }).url || "").trim()
          : "",
      content:
        rawResult && typeof rawResult === "object" && "content" in rawResult
          ? String((rawResult as { content?: unknown }).content || "").trim()
          : "",
    };

    if (isUsableSearchResult(result)) {
      parsed.push(result);
    }
  }

  // 2. Score by relevance to query
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const scored = parsed.map((result) => ({
    result,
    score: scoreResult(result, queryTerms),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 3. Dedupe by domain — keep the highest-scored result per domain
  const seenDomains = new Set<string>();
  const seenUrls = new Set<string>();
  const results: SearchResult[] = [];

  for (const { result } of scored) {
    const urlKey = result.url.replace(/\/$/, "");
    if (seenUrls.has(urlKey)) continue;
    seenUrls.add(urlKey);

    const domain = extractDomain(result.url);
    if (domain && seenDomains.has(domain)) continue;
    if (domain) seenDomains.add(domain);

    results.push(result);
    if (results.length >= limit) break;
  }

  return results;
}

function scoreResult(result: SearchResult, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;

  const titleLower = result.title.toLowerCase();
  const contentLower = result.content.toLowerCase();
  const urlLower = result.url.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    // Title matches are most valuable
    if (titleLower.includes(term)) score += 3;
    // URL matches (domain/path) are strong signals
    if (urlLower.includes(term)) score += 2;
    // Content/snippet matches
    if (contentLower.includes(term)) score += 1;
  }

  // Bonus: title contains the full query as a phrase
  const fullQuery = queryTerms.join(" ");
  if (titleLower.includes(fullQuery)) score += 5;

  // Bonus: shorter, more focused content tends to be more relevant
  if (result.content.length > 20) score += 1;

  return score;
}

function extractDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    // Strip www. and collapse to registrable domain (simple version)
    const parts = host.replace(/^www\./, "").split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return null;
  }
}

function isUsableSearchResult(result: SearchResult): boolean {
  if (result.title.trim().length < 2 || result.url.trim().length < 8) {
    return false;
  }

  try {
    const parsed = new URL(result.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
  } catch {
    return false;
  }

  return result.title.trim().toLowerCase() !== result.url.trim().toLowerCase();
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
