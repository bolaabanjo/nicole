import { ChatMessage } from "./types";

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
  | "casual"              // greetings, short responses → no tools
  | "ambiguous";          // everything else → auto-attach memory, let LLM respond

export interface IntentClassification {
  intent: IntentType;
  searchQuery?: string;       // For factual_question: what to search
  sourceQuery?: string;       // For source_question: what to look up
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
  /\bremind me to\b/i,
  /\bset a reminder\b/i,
  /\bcreate (?:a |an )?(?:reminder|event|note)\b/i,
  /\badd .* to (?:my )?calendar\b/i,
  /\bsend (?:an? )?email\b/i,
  /\bgit status\b/i,
  /\brepo status\b/i,
  /\brun [`'"]/i,
];

// ---------------------------------------------------------------------------
// Signals that a question likely needs current/external information
// even if it doesn't match factual patterns exactly
// ---------------------------------------------------------------------------

const CURRENT_INFO_KEYWORDS =
  /\b(latest|current|recent|today|yesterday|this week|this month|right now|news|update|happening|weather|price|stock|score|result|release|announce|launch|trending)\b/i;

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function classifyIntent(
  message: string,
  _recentMessages: ChatMessage[] = []
): IntentClassification {
  const trimmed = message.trim();
  const normalized = trimmed.toLowerCase();

  // 1. Casual — no tools, no memory
  if (CASUAL_PATTERNS.some((p) => p.test(normalized))) {
    return {
      intent: "casual",
      shouldSearchMemory: false,
      shouldSearchSources: false,
    };
  }

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

  // 6. Factual question — "who is X", "what is Y"
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

  // 7. Contains current-info keywords — treat as factual
  if (CURRENT_INFO_KEYWORDS.test(normalized)) {
    return {
      intent: "factual_question",
      searchQuery: trimmed.replace(/[?.!]+$/, "").trim(),
      shouldSearchMemory: true,
      shouldSearchSources: false,
    };
  }

  // 8. Long questions (>20 chars ending with ?) — probably need context
  if (normalized.endsWith("?") && normalized.length > 20) {
    return {
      intent: "ambiguous",
      shouldSearchMemory: true,
      shouldSearchSources: true,
    };
  }

  // 9. Ambiguous — auto-attach memory for anything non-trivial
  const isSubstantive = normalized.length > 15 && !/^[a-z]{1,10}[.!?]*$/.test(normalized);
  return {
    intent: "ambiguous",
    shouldSearchMemory: isSubstantive,
    shouldSearchSources: false,
  };
}
