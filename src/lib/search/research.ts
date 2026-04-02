import { searchWeb, fetchPageText } from "./web";
import { chat } from "@/lib/ai/router";
import { storeMemory } from "@/lib/ai/memory";

const EXTRACT_PERSON_FACTS_PROMPT = `You are extracting facts about a specific person from a web page. Given the person's name/query and the page content, extract every relevant fact about them.

Rules:
- Only extract facts directly about this person or their work.
- Each fact should be a single, clear sentence.
- Include a short "topic" field when obvious, usually the person's name or a specific project.
- Include: biography, career, projects, achievements, education, companies, roles, public statements, publications, social profiles.
- Categorize each as: personal, career, project, achievement, education, or public.
- Rate importance 1-10 (10 = defining career/identity fact, 1 = trivial mention).
- Skip generic content that isn't about this person.
- If the page has nothing about this person, return an empty array.

Return ONLY valid JSON array, no markdown:
[{"content": "...", "category": "...", "importance": 7, "topic": "..."}]`;

interface ResearchProgress {
  query: string;
  pagesSearched: number;
  pagesRead: number;
  factsExtracted: number;
  status: "searching" | "reading" | "extracting" | "done" | "error";
}

/**
 * Deep research: search for a person/topic, read pages, extract and store memories.
 * Runs multiple search queries to be thorough.
 */
export async function deepResearch(
  query: string,
  onProgress?: (progress: ResearchProgress) => void
): Promise<{ factsExtracted: number; pagesRead: number }> {
  const progress: ResearchProgress = {
    query,
    pagesSearched: 0,
    pagesRead: 0,
    factsExtracted: 0,
    status: "searching",
  };

  const report = () => onProgress?.(progress);

  // Run multiple search queries for thorough coverage
  const queries = [
    query,
    `${query} software engineer`,
    `${query} projects portfolio`,
    `${query} linkedin github`,
  ];

  const allUrls = new Set<string>();
  const allResults: { title: string; url: string }[] = [];

  // Search phase
  for (const q of queries) {
    progress.status = "searching";
    report();

    const results = await searchWeb(q, 10);
    progress.pagesSearched += results.length;

    for (const r of results) {
      if (!allUrls.has(r.url)) {
        allUrls.add(r.url);
        allResults.push({ title: r.title, url: r.url });
      }
    }
  }

  // Read and extract phase — process up to 15 unique pages
  const pagesToRead = allResults.slice(0, 15);

  for (const page of pagesToRead) {
    progress.status = "reading";
    report();

    const text = await fetchPageText(page.url);
    if (!text || text.length < 100) continue;

    progress.pagesRead++;
    progress.status = "extracting";
    report();

    try {
      const response = await chat([
        { role: "system", content: EXTRACT_PERSON_FACTS_PROMPT },
        {
          role: "user",
          content: `Person/query: "${query}"\n\nPage title: ${page.title}\nPage URL: ${page.url}\n\nContent:\n${text}`,
        },
      ]);

      const responseText =
        typeof response === "string" ? response : String(response);
      const cleaned = responseText
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      const facts = JSON.parse(cleaned);

      if (Array.isArray(facts)) {
        for (const fact of facts) {
          if (fact.content && fact.category) {
            await storeMemory({
              content: fact.content,
              category: fact.category,
              importance: fact.importance || 5,
              source: "research",
              topic:
                typeof fact.topic === "string" && fact.topic.trim()
                  ? fact.topic.trim()
                  : query,
            });
            progress.factsExtracted++;
          }
        }
      }
    } catch {
      // Extraction failed for this page — continue with others
    }
  }

  progress.status = "done";
  report();

  return {
    factsExtracted: progress.factsExtracted,
    pagesRead: progress.pagesRead,
  };
}
