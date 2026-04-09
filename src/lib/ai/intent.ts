import { ChatMessage } from "./types";
import { looksLikeTopicFollowUp } from "./topic-routing";

/**
 * Nicole's deterministic intent classifier.
 *
 * Instead of asking the LLM "should I use a tool?", the code classifies
 * every message and routes to the appropriate tools automatically.
 * The model only does what it's good at — generating language.
 */

export type IntentType =
  | "factual_question"    // "who is X", "what is Y" → web_search
  | "personal_question"   // "my schedule", "do I have" → memory + calendar
  | "source_question"     // "in my notes", "that PDF" → source_search
  | "action_request"      // "remind me", "send email" → direct tool (already handled)
  | "workspace_question"  // "your files", "what do you know about me" → workspace tools
  | "weather_question"    // "what's the weather" → weather_get
  | "health_question"     // "how did I sleep" → health_metric_read
  | "casual"              // greetings, short responses → no tools
  | "ambiguous";          // everything else → auto-attach memory, let LLM respond

export interface IntentClassification {
  intent: IntentType;
  searchQuery?: string;       // For factual_question: what to search
  sourceQuery?: string;       // For source_question: what to look up
  weatherLocation?: string;   // For weather_question: optional location
  shouldSearchMemory: boolean; // Whether to auto-attach memory context
  shouldSearchSources: boolean; // Whether to auto-attach source context
}

// ---------------------------------------------------------------------------
// Casual patterns — never need tools
// ---------------------------------------------------------------------------

const CASUAL_PATTERNS = [
  /^(hi|hey|hello|yo|sup|what'?s up|how are you)[.!?,]*$/i,
  /^(thanks|thank you|thx|ty|ok|okay|k|cool|nice|lol|haha|hmm|yeah|nah|nope|yep|bet|got it|alright)[.!?]*$/i,
  /^(good morning|good night|gn|gm|morning)[.!?]*$/i,
  /^(i love you|i hate you|i miss you|fuck|shit|damn)[.!?]*$/i,
  /^(bye|goodbye|see you|later|peace|take care)[.!?]*$/i,
  /^\.+$/,
];

// ---------------------------------------------------------------------------
// Factual question patterns → web_search
// ---------------------------------------------------------------------------

const FACTUAL_PATTERNS: Array<{ pattern: RegExp; queryGroup: number }> = [
  { pattern: /^(?:who is|who are|who was|who were)\s+(.+?)(?:\?|\.)?$/i, queryGroup: 1 },
  { pattern: /^(?:what is|what are|what was|what were)\s+(.+?)(?:\?|\.)?$/i, queryGroup: 1 },
  { pattern: /^(?:where is|where are|where was)\s+(.+?)(?:\?|\.)?$/i, queryGroup: 1 },
  { pattern: /^(?:when is|when was|when did)\s+(.+?)(?:\?|\.)?$/i, queryGroup: 1 },
  { pattern: /^(?:how old is|how much is|how tall is|how far is)\s+(.+?)(?:\?|\.)?$/i, queryGroup: 1 },
  { pattern: /^(?:tell me about|what do you know about|what happened to|what happened with)\s+(.+?)(?:\?|\.)?$/i, queryGroup: 1 },
  { pattern: /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:search|search the web|google|look up|lookup)\s+(?:the web\s+)?(?:for\s+)?(.+)$/i, queryGroup: 1 },
  { pattern: /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:research|deep research|look into|find out about)\s+(.+)$/i, queryGroup: 1 },
];

// Factual subjects that DON'T need web search (basic knowledge)
const SKIP_SEARCH_SUBJECTS = [
  /^(photosynthesis|gravity|evolution|dna|the sun|the moon|the earth|water|oxygen|hydrogen|pi|infinity)$/i,
  /^(a |an |the )?(noun|verb|adjective|adverb|pronoun|preposition|conjunction)$/i,
  /^(addition|subtraction|multiplication|division|algebra|calculus|geometry|trigonometry)$/i,
];

function isBasicKnowledge(subject: string): boolean {
  const trimmed = subject.trim().toLowerCase();
  // Very short generic words
  if (trimmed.length <= 3) return true;
  return SKIP_SEARCH_SUBJECTS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Personal question patterns → memory + calendar/reminders
// ---------------------------------------------------------------------------

const PERSONAL_PATTERNS = [
  /\b(my schedule|my calendar|my events|my meetings|what do i have|am i free|do i have anything)\b/i,
  /\b(my reminder|my reminders|what did i need to|what was i supposed to)\b/i,
  /\b(my email|my emails|any emails|inbox)\b/i,
];

// ---------------------------------------------------------------------------
// Source/study patterns → source_search
// ---------------------------------------------------------------------------

const SOURCE_PATTERNS: Array<{ pattern: RegExp; queryGroup?: number }> = [
  { pattern: /\b(?:in my notes?|from my notes?|my notes? (?:on|about))\s+(.+)/i, queryGroup: 1 },
  { pattern: /\b(?:that pdf|the pdf|that paper|the paper|that document|the document)\s*(?:about|on|regarding)?\s*(.*)/i, queryGroup: 1 },
  { pattern: /\b(?:in my library|from my library|my sources?|my materials?)\b/i },
  { pattern: /\b(?:what did i (?:read|save|ingest|upload|import) about)\s+(.+)/i, queryGroup: 1 },
  { pattern: /\b(?:summarize|summarise)\s+(?:the |my )?(?:source|pdf|document|paper|notes?)\b/i },
];

// ---------------------------------------------------------------------------
// Workspace patterns → workspace tools (already handled by direct routing,
// but we classify here for completeness)
// ---------------------------------------------------------------------------

const WORKSPACE_PATTERNS = [
  /\b(your workspace|your files|your home|your memory|your notes|your daily|your context)\b/i,
  /\b(what do you know about me)\b/i,
  /\b(update your|write that down|jot this down|note that|daily note)\b/i,
];

// ---------------------------------------------------------------------------
// Action patterns → already handled by detectDirectToolCall, classify here
// so we don't accidentally auto-attach memory for simple commands
// ---------------------------------------------------------------------------

const ACTION_PATTERNS = [
  /\bconnect (?:my |to )?(?:google calendar|calendar|zoho|zoho mail|gmail|google mail|email)\b/i,
  /\bdisconnect (?:my |from )?(?:google calendar|calendar|zoho|zoho mail|gmail|google mail|email)\b/i,
  /\bwhat integrations\b/i,
  /\bwhat'?s connected\b/i,
  /\bremind me to\b/i,
  /\bset a reminder\b/i,
  /\bcreate (?:a |an )?(?:reminder|event|note)\b/i,
  /\badd .* to (?:my )?calendar\b/i,
  /\bsend (?:an? )?email\b/i,
  /\b(?:read|open|show) (?:the )?(?:email|mail|message|thread|conversation)\b/i,
  /\bwhat(?:\s+else)?\s+did\s+.+\s+say\b/i,
  /\btell me more about .+(?:email|mail|message)\b/i,
  /\bwhat(?:'s| is| else is) in (?:that|this|the) (?:email|mail|message)\b/i,
  /\bdraft (?:a )?reply\b/i,
  /\bwrite (?:a )?reply\b/i,
  /\bsend (?:that|the|this)?\s*reply\b/i,
  /\bgit status\b/i,
  /\brepo status\b/i,
  /\brun [`'"]/i,
];

// ---------------------------------------------------------------------------
// Weather patterns → weather_get (direct tool, skip web search)
// ---------------------------------------------------------------------------

const WEATHER_PATTERNS: Array<{ pattern: RegExp; locationGroup?: number }> = [
  { pattern: /^(?:what(?:'s| is) the )?weather\s*(?:in|at|for|near)?\s*(.+?)(?:\?|\.)?$/i, locationGroup: 1 },
  { pattern: /^(?:how(?:'s| is) the )?weather\s*(?:today|tomorrow|this week|right now)?(?:\?|\.)?$/i },
  { pattern: /^(?:what(?:'s| is) (?:it |the )?(?:temperature|temp)\s*(?:in|at|for)?\s*(.+?)?)(?:\?|\.)?$/i, locationGroup: 1 },
  { pattern: /^(?:is it (?:going to |gonna )?(?:rain|snow|storm|hot|cold|warm|freezing))\s*(?:today|tomorrow|this week)?(?:\s+in\s+(.+?))?(?:\?|\.)?$/i, locationGroup: 1 },
  { pattern: /^(?:do i need (?:an? )?(?:umbrella|jacket|coat|sunscreen))\s*(?:today|tomorrow)?(?:\?|\.)?$/i },
  { pattern: /^(?:will it (?:rain|snow|storm|be (?:hot|cold|warm)))\s*(?:today|tomorrow|this week)?(?:\s+in\s+(.+?))?(?:\?|\.)?$/i, locationGroup: 1 },
  { pattern: /\b(?:weather forecast|weather report)\b(?:\s+(?:for|in)\s+(.+?))?(?:\?|\.)?$/i, locationGroup: 1 },
];

// ---------------------------------------------------------------------------
// Health patterns → health_metric_read
// ---------------------------------------------------------------------------

const HEALTH_PATTERNS = [
  /\b(?:how did i|how was my|how's my|how much did i)\s+(?:sleep|rest)\b/i,
  /\b(?:my |how many )?(?:steps|step count)\b/i,
  /\b(?:my |what's my |what is my )?(?:heart rate|resting heart rate|resting hr|hr)\b/i,
  /\b(?:my |how's my |how is my )?(?:health|fitness|activity|exercise|workout)\b/i,
  /\b(?:my |how many )?(?:calories|active minutes|active time)\b/i,
  /\b(?:sleep|sleep quality|sleep data|sleep score|sleep hours)\b/i,
  /\b(?:health (?:data|metrics|summary|stats|check|report|update))\b/i,
  /\b(?:how (?:am i|have i been) doing (?:health|physical|fitness|physically))\b/i,
];

// ---------------------------------------------------------------------------
// Signals that a question likely needs current/external information
// even if it doesn't match factual patterns exactly
// ---------------------------------------------------------------------------

const CURRENT_INFO_KEYWORDS =
  /\b(latest|current|recent|today|yesterday|this week|this month|right now|news|update|happening|price|stock|score|result|release|announce|launch|trending)\b/i;

// ---------------------------------------------------------------------------
// Conversational prefix stripping
// ---------------------------------------------------------------------------

const CONVERSATIONAL_PREFIXES = /^(?:good|great|nice|cool|okay|ok|alright|sure|fine|perfect|right|hey nicole|hey|yo|so|well|oh|ah|hmm|also|and|but|now|please|actually|oh and|ok so|yeah|yep|yea)[,.:;!?\s]+/i;
/**
 * Strips natural conversational prefixes so the real intent gets matched.
 * "good, search the web for X" → "search the web for X"
 * "hey nicole, what's the weather" → "what's the weather"
 * "ok so who is elon musk" → "who is elon musk"
 */
function stripConversationalPrefix(message: string): string {
  let result = message;
  // Apply up to 2 times to handle stacked prefixes like "ok so, search..."
  for (let i = 0; i < 2; i++) {
    const stripped = result.replace(CONVERSATIONAL_PREFIXES, "").trim();
    if (stripped.length === 0 || stripped === result) break;
    result = stripped;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function classifyIntent(
  message: string,
  recentMessages: ChatMessage[] = []
): IntentClassification {
  const raw = message.trim();
  const rawLower = raw.toLowerCase();

  // 1. Casual — check BEFORE stripping prefixes (if the whole message is casual, it's casual)
  if (CASUAL_PATTERNS.some((p) => p.test(rawLower))) {
    return {
      intent: "casual",
      shouldSearchMemory: false,
      shouldSearchSources: false,
    };
  }

  // Strip conversational prefixes for all remaining classification
  const trimmed = stripConversationalPrefix(raw);
  const normalized = trimmed.toLowerCase();

  // 2. Action request — direct tool handles it, minimal context
  if (ACTION_PATTERNS.some((p) => p.test(normalized))) {
    return {
      intent: "action_request",
      shouldSearchMemory: false,
      shouldSearchSources: false,
    };
  }

  // 3. Workspace question
  if (WORKSPACE_PATTERNS.some((p) => p.test(normalized))) {
    return {
      intent: "workspace_question",
      shouldSearchMemory: false,
      shouldSearchSources: false,
    };
  }

  // 4. Source/study question
  for (const { pattern, queryGroup } of SOURCE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        intent: "source_question",
        sourceQuery: queryGroup && match[queryGroup]
          ? match[queryGroup].trim()
          : trimmed,
        shouldSearchMemory: true,
        shouldSearchSources: true,
      };
    }
  }

  // 5. Personal question — schedule, reminders, email
  if (PERSONAL_PATTERNS.some((p) => p.test(normalized))) {
    return {
      intent: "personal_question",
      shouldSearchMemory: true,
      shouldSearchSources: false,
    };
  }

  // 6. Weather question — direct routing to weather_get
  for (const { pattern, locationGroup } of WEATHER_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const loc = locationGroup && match[locationGroup]
        ? match[locationGroup].trim()
        : undefined;
      // Filter out empty/noise location matches
      const cleanLoc = loc && loc.length > 1 && !/^(today|tomorrow|this week|right now|now)$/i.test(loc)
        ? loc
        : undefined;
      return {
        intent: "weather_question",
        weatherLocation: cleanLoc,
        shouldSearchMemory: false,
        shouldSearchSources: false,
      };
    }
  }

  // 7. Health question — "how did I sleep", "my steps"
  if (HEALTH_PATTERNS.some((p) => p.test(normalized))) {
    return {
      intent: "health_question",
      shouldSearchMemory: false,
      shouldSearchSources: false,
    };
  }

  // 8. Factual question — "who is X", "what is Y"
  for (const { pattern, queryGroup } of FACTUAL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[queryGroup]) {
      const subject = match[queryGroup].trim();
      if (!isBasicKnowledge(subject)) {
        return {
          intent: "factual_question",
          searchQuery: subject,
          shouldSearchMemory: true,
          shouldSearchSources: false,
        };
      }
    }
  }

  // 8. Contains current-info keywords — treat as factual
  if (CURRENT_INFO_KEYWORDS.test(normalized)) {
    return {
      intent: "factual_question",
      searchQuery: trimmed.replace(/[?.!]+$/, "").trim(),
      shouldSearchMemory: true,
      shouldSearchSources: false,
    };
  }

  // 9. Short conversational follow-up — stay with the current turn instead of
  // spraying broad memory/source retrieval unless a real tool/action was matched above.
  if (
    recentMessages.some((entry) => entry.role === "assistant") &&
    looksLikeTopicFollowUp(normalized)
  ) {
    return {
      intent: "ambiguous",
      shouldSearchMemory: false,
      shouldSearchSources: false,
    };
  }

  // 10. Long questions (>20 chars ending with ?) — probably need context
  if (normalized.endsWith("?") && normalized.length > 20) {
    return {
      intent: "ambiguous",
      shouldSearchMemory: true,
      shouldSearchSources: true,
    };
  }

  // 11. Ambiguous — auto-attach memory for anything non-trivial
  const isSubstantive = normalized.length > 15 && !/^[a-z]{1,10}[.!?]*$/.test(normalized);
  return {
    intent: "ambiguous",
    shouldSearchMemory: isSubstantive,
    shouldSearchSources: false,
  };
}
