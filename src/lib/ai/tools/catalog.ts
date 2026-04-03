export type ToolCategory =
  | "memory"
  | "sources"
  | "research"
  | "writing"
  | "productivity"
  | "communication"
  | "browser"
  | "developer"
  | "vision"
  | "voice"
  | "smart_home"
  | "health"
  | "system";

export type ToolStatus = "ready" | "planned" | "disabled";
export type ToolSideEffectLevel = "read" | "write" | "actuate";
export type ToolAvailability = "local" | "remote" | "hybrid";

export interface ToolSchemaProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  enum?: string[];
}

export interface ToolObjectSchema {
  type: "object";
  properties: Record<string, ToolSchemaProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  title: string;
  description: string;
  whenToUse: string;
  sideEffectLevel: ToolSideEffectLevel;
  requiresConfirmation: boolean;
  availability: ToolAvailability;
  status: ToolStatus;
  inputSchema: ToolObjectSchema;
  outputDescription: string;
}

const emptySchema: ToolObjectSchema = {
  type: "object",
  properties: {},
};

function defineTool(tool: ToolDefinition): ToolDefinition {
  return tool;
}

export const TOOL_CATALOG: ToolDefinition[] = [
  defineTool({
    name: "tool_registry_list",
    category: "system",
    title: "List tools",
    description: "Lists Nicole's available and planned tools.",
    whenToUse: "Use when you need to inspect Nicole's capabilities or discover which tool to call next.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: emptySchema,
    outputDescription: "Returns the ready and planned tool catalog.",
  }),
  defineTool({
    name: "memory_search",
    category: "memory",
    title: "Search memory",
    description: "Searches Nicole's long-term memories for relevant facts and context.",
    whenToUse: "Use when the answer may depend on prior personal context, preferences, goals, or remembered project state.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search Nicole's memories for." },
        limit: { type: "number", description: "Maximum number of memory matches to return." },
      },
      required: ["query"],
    },
    outputDescription: "Returns structured memory matches with category, topic, source, and score.",
  }),
  defineTool({
    name: "memory_store",
    category: "memory",
    title: "Store memory",
    description: "Writes a memory intentionally into Nicole's memory system.",
    whenToUse: "Use when the user explicitly asks Nicole to remember something important long-term.",
    sideEffectLevel: "write",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory sentence to store." },
        category: { type: "string", description: "The memory category." },
        importance: { type: "number", description: "Importance from 1-10." },
        topic: { type: "string", description: "Optional topic anchor such as a person, project, or concept." },
      },
      required: ["content", "category"],
    },
    outputDescription: "Returns the stored memory payload after dedup or merge resolution.",
  }),
  defineTool({
    name: "memory_update",
    category: "memory",
    title: "Update memory",
    description: "Revises or replaces an existing memory.",
    whenToUse: "Use when Nicole has an exact memory id to revise directly.",
    sideEffectLevel: "write",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "The memory id to update." },
        content: { type: "string", description: "The new canonical memory sentence." },
      },
      required: ["memoryId", "content"],
    },
    outputDescription: "Returns the updated memory record.",
  }),
  defineTool({
    name: "conversation_summary_search",
    category: "memory",
    title: "Search conversation summaries",
    description: "Retrieves older compressed conversation summaries.",
    whenToUse: "Use when the answer depends on older conversations that may no longer be in the live recent-message window.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for in older summaries." },
      },
      required: ["query"],
    },
    outputDescription: "Returns matching conversation summaries.",
  }),
  defineTool({
    name: "source_search",
    category: "sources",
    title: "Search sources",
    description: "Searches ingested notes, PDFs, URLs, and library chunks semantically.",
    whenToUse: "Use when the answer should come from the user's own notes or ingested study material.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for inside ingested sources." },
        limit: { type: "number", description: "Maximum number of source chunks to return." },
      },
      required: ["query"],
    },
    outputDescription: "Returns relevant source chunks with titles, source ids, positions, and scores.",
  }),
  defineTool({
    name: "source_list",
    category: "sources",
    title: "List sources",
    description: "Lists ingested sources in Nicole's library.",
    whenToUse: "Use when you need to inspect what the user has already imported.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of sources to return." },
      },
    },
    outputDescription: "Returns sources with ids, titles, types, URLs, and chunk counts.",
  }),
  defineTool({
    name: "source_get",
    category: "sources",
    title: "Get source",
    description: "Fetches a specific source's metadata and content.",
    whenToUse: "Use when you already know the source id and need the source details.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "The source id to fetch." },
      },
      required: ["sourceId"],
    },
    outputDescription: "Returns a source record with metadata, summary, and raw text.",
  }),
  defineTool({
    name: "source_summarize",
    category: "sources",
    title: "Summarize source",
    description: "Summarizes a specific ingested source.",
    whenToUse: "Use when the user asks for a source-level summary instead of a targeted search.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "The source id to summarize." },
      },
      required: ["sourceId"],
    },
    outputDescription: "Returns a concise summary of the source.",
  }),
  defineTool({
    name: "concept_extract",
    category: "sources",
    title: "Extract concepts",
    description: "Extracts concepts and relations from text or sources.",
    whenToUse: "Use when Nicole needs to structure knowledge for study or graphing.",
    sideEffectLevel: "write",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Optional source id to extract concepts from." },
        text: { type: "string", description: "Optional raw text to analyze." },
      },
    },
    outputDescription: "Returns extracted concepts and optionally stores them.",
  }),
  defineTool({
    name: "study_start",
    category: "sources",
    title: "Start study session",
    description: "Starts a study session around a concept, source, or mode.",
    whenToUse: "Use when the user wants a focused study flow rather than open-ended chat.",
    sideEffectLevel: "write",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Study mode such as socratic or feynman." },
        conceptId: { type: "string", description: "Optional concept id." },
        sourceId: { type: "string", description: "Optional source id." },
      },
      required: ["mode"],
    },
    outputDescription: "Returns a study session id and opening context.",
  }),
  defineTool({
    name: "web_search",
    category: "research",
    title: "Web search",
    description: "Runs a fast web search through Nicole's search stack.",
    whenToUse: "Use for current facts, recent news, or when the answer depends on information outside Nicole's stored knowledge.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "hybrid",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The web query to search." },
        limit: { type: "number", description: "Maximum number of results to return." },
      },
      required: ["query"],
    },
    outputDescription: "Returns search result titles, URLs, and snippets.",
  }),
  defineTool({
    name: "web_open",
    category: "research",
    title: "Open web page",
    description: "Fetches and cleans readable text from a URL.",
    whenToUse: "Use after search when you need the page content instead of the search snippet.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "hybrid",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page URL to fetch." },
      },
      required: ["url"],
    },
    outputDescription: "Returns extracted page text.",
  }),
  defineTool({
    name: "deep_research",
    category: "research",
    title: "Deep research",
    description: "Searches, reads multiple pages, extracts facts, and stores durable findings.",
    whenToUse: "Use when the user asks Nicole to really research a person or topic thoroughly.",
    sideEffectLevel: "write",
    requiresConfirmation: false,
    availability: "hybrid",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The person or topic to research deeply." },
      },
      required: ["query"],
    },
    outputDescription: "Returns pages read and facts extracted, and writes research memories.",
  }),
  defineTool({
    name: "fact_check",
    category: "research",
    title: "Fact check",
    description: "Verifies a claim against current sources.",
    whenToUse: "Use when the user asks if something is true or when Nicole is uncertain about a claim.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "hybrid",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        claim: { type: "string", description: "The claim to verify." },
      },
      required: ["claim"],
    },
    outputDescription: "Returns a verdict with supporting evidence.",
  }),
  defineTool({
    name: "note_create",
    category: "writing",
    title: "Create note",
    description: "Creates a note or draft in Nicole's notes store.",
    whenToUse: "Use when the user wants something saved as a note, draft, or summary artifact.",
    sideEffectLevel: "write",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Optional note title." },
        content: { type: "string", description: "The note content." },
        type: { type: "string", description: "The note type, such as note or draft." },
      },
      required: ["content"],
    },
    outputDescription: "Returns the created note record.",
  }),
  defineTool({
    name: "note_update",
    category: "writing",
    title: "Update note",
    description: "Updates an existing note or draft.",
    whenToUse: "Use when the user wants to revise a saved note or draft by id.",
    sideEffectLevel: "write",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The note id to update." },
        title: { type: "string", description: "Optional new title." },
        content: { type: "string", description: "Optional new content." },
        type: { type: "string", description: "Optional new note type." },
      },
      required: ["id"],
    },
    outputDescription: "Returns the updated note record.",
  }),
  defineTool({
    name: "draft_rewrite",
    category: "writing",
    title: "Rewrite draft",
    description: "Rewrites an existing piece of text toward a goal.",
    whenToUse: "Use when the user asks Nicole to reshape writing with a clear direction.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The source text to rewrite." },
        goal: { type: "string", description: "How the writing should change." },
      },
      required: ["text", "goal"],
    },
    outputDescription: "Returns a rewritten draft.",
  }),
  defineTool({
    name: "calendar_read",
    category: "productivity",
    title: "Read calendar",
    description: "Checks upcoming events and availability.",
    whenToUse: "Use when the user asks about schedule or free time.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "hybrid",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Optional range start." },
        end: { type: "string", description: "Optional range end." },
        limit: { type: "number", description: "Maximum number of events to return." },
      },
    },
    outputDescription: "Returns upcoming events and availability.",
  }),
  defineTool({
    name: "calendar_create_event",
    category: "productivity",
    title: "Create calendar event",
    description: "Creates a new calendar event.",
    whenToUse: "Use when the user asks Nicole to schedule something specific.",
    sideEffectLevel: "write",
    requiresConfirmation: true,
    availability: "hybrid",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title." },
        start: { type: "string", description: "Start time." },
        end: { type: "string", description: "End time." },
        description: { type: "string", description: "Optional event description." },
        location: { type: "string", description: "Optional event location." },
      },
      required: ["title", "start", "end"],
    },
    outputDescription: "Returns the created calendar event.",
  }),
  defineTool({
    name: "reminder_create",
    category: "productivity",
    title: "Create reminder",
    description: "Creates a reminder or task.",
    whenToUse: "Use when the user asks Nicole to remember something at a time later.",
    sideEffectLevel: "write",
    requiresConfirmation: true,
    availability: "hybrid",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Reminder text." },
        dueAt: { type: "string", description: "Optional due time." },
        notes: { type: "string", description: "Optional reminder notes." },
      },
      required: ["title"],
    },
    outputDescription: "Returns the created reminder.",
  }),
  defineTool({
    name: "contacts_search",
    category: "productivity",
    title: "Search contacts",
    description: "Looks up a contact in Nicole's unified contact book.",
    whenToUse: "Use when the user refers to a person and contact lookup would help.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "hybrid",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Person or company to look up." },
      },
      required: ["query"],
    },
    outputDescription: "Returns matching contacts.",
  }),
  defineTool({
    name: "email_search",
    category: "communication",
    title: "Search email",
    description: "Searches emails.",
    whenToUse: "Use when the user asks Nicole to find or inspect emails.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "hybrid",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Email search query." },
      },
      required: ["query"],
    },
    outputDescription: "Returns matching emails or threads.",
  }),
  defineTool({
    name: "email_send",
    category: "communication",
    title: "Send email",
    description: "Sends an email.",
    whenToUse: "Use when the user explicitly asks Nicole to send a drafted email.",
    sideEffectLevel: "actuate",
    requiresConfirmation: true,
    availability: "hybrid",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email." },
        subject: { type: "string", description: "Email subject." },
        body: { type: "string", description: "Email body." },
      },
      required: ["to", "subject", "body"],
    },
    outputDescription: "Returns send status and message id.",
  }),
  defineTool({
    name: "message_send",
    category: "communication",
    title: "Send message",
    description: "Sends a message via a future messaging integration.",
    whenToUse: "Use when the user explicitly asks Nicole to send a message.",
    sideEffectLevel: "actuate",
    requiresConfirmation: true,
    availability: "hybrid",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel such as sms, whatsapp, or slack." },
        recipient: { type: "string", description: "Recipient identifier." },
        body: { type: "string", description: "Message content." },
      },
      required: ["channel", "recipient", "body"],
    },
    outputDescription: "Returns message delivery status.",
  }),
  defineTool({
    name: "browser_get_context",
    category: "browser",
    title: "Get browser context",
    description: "Gets active tab context, selected text, or page metadata.",
    whenToUse: "Use when Nicole is running beside the browser and current page context matters.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: emptySchema,
    outputDescription: "Returns browser context.",
  }),
  defineTool({
    name: "clipboard_read",
    category: "browser",
    title: "Read clipboard",
    description: "Reads the clipboard.",
    whenToUse: "Use when the user explicitly refers to copied content.",
    sideEffectLevel: "read",
    requiresConfirmation: true,
    availability: "local",
    status: "planned",
    inputSchema: emptySchema,
    outputDescription: "Returns clipboard text or metadata.",
  }),
  defineTool({
    name: "file_search",
    category: "browser",
    title: "Search files",
    description: "Searches local files or folders.",
    whenToUse: "Use when the user asks Nicole to find a local file.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "File search query." },
      },
      required: ["query"],
    },
    outputDescription: "Returns matching files.",
  }),
  defineTool({
    name: "terminal_run",
    category: "developer",
    title: "Run terminal command",
    description: "Runs a terminal command in a controlled environment.",
    whenToUse: "Use when Nicole needs to inspect or modify a codebase or run a command for the user.",
    sideEffectLevel: "actuate",
    requiresConfirmation: true,
    availability: "local",
    status: "ready",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
      },
      required: ["command"],
    },
    outputDescription: "Returns command stdout, stderr, and exit status.",
  }),
  defineTool({
    name: "git_status",
    category: "developer",
    title: "Git status",
    description: "Reads repository status and current diff state.",
    whenToUse: "Use when Nicole is helping with coding and needs repo state.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "ready",
    inputSchema: emptySchema,
    outputDescription: "Returns git status information.",
  }),
  defineTool({
    name: "screen_capture",
    category: "vision",
    title: "Capture screen",
    description: "Captures the current screen or window.",
    whenToUse: "Use when Nicole needs visual context from the device screen.",
    sideEffectLevel: "read",
    requiresConfirmation: true,
    availability: "local",
    status: "planned",
    inputSchema: emptySchema,
    outputDescription: "Returns a screen capture reference.",
  }),
  defineTool({
    name: "vision_describe",
    category: "vision",
    title: "Describe image or screen",
    description: "Describes visual input with a multimodal model.",
    whenToUse: "Use when the task depends on understanding what Nicole can see.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        imageRef: { type: "string", description: "Image or screenshot reference." },
      },
      required: ["imageRef"],
    },
    outputDescription: "Returns a visual description or structured UI understanding.",
  }),
  defineTool({
    name: "speech_to_text",
    category: "voice",
    title: "Speech to text",
    description: "Transcribes speech into text.",
    whenToUse: "Use in voice sessions or when the user provides audio input.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        audioRef: { type: "string", description: "Audio reference to transcribe." },
      },
      required: ["audioRef"],
    },
    outputDescription: "Returns a transcript.",
  }),
  defineTool({
    name: "text_to_speech",
    category: "voice",
    title: "Text to speech",
    description: "Speaks Nicole's response aloud.",
    whenToUse: "Use in voice mode when the response should be spoken.",
    sideEffectLevel: "actuate",
    requiresConfirmation: false,
    availability: "local",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to speak." },
      },
      required: ["text"],
    },
    outputDescription: "Returns speech playback status.",
  }),
  defineTool({
    name: "smart_home_light_set",
    category: "smart_home",
    title: "Set lights",
    description: "Controls smart-home lighting.",
    whenToUse: "Use when the user explicitly asks Nicole to change a light or scene.",
    sideEffectLevel: "actuate",
    requiresConfirmation: true,
    availability: "hybrid",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room or light group." },
        state: { type: "string", description: "Desired state such as on, off, or dimmed." },
      },
      required: ["room", "state"],
    },
    outputDescription: "Returns device control status.",
  }),
  defineTool({
    name: "music_play",
    category: "smart_home",
    title: "Play music",
    description: "Controls music playback.",
    whenToUse: "Use when the user explicitly asks Nicole to play or control music.",
    sideEffectLevel: "actuate",
    requiresConfirmation: true,
    availability: "hybrid",
    status: "planned",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Song, artist, playlist, or mood." },
      },
      required: ["query"],
    },
    outputDescription: "Returns playback state.",
  }),
  defineTool({
    name: "health_metric_read",
    category: "health",
    title: "Read health metrics",
    description: "Reads future tracked health metrics or sensor summaries.",
    whenToUse: "Use when the user asks Nicole about health trends or tracked data.",
    sideEffectLevel: "read",
    requiresConfirmation: true,
    availability: "hybrid",
    status: "planned",
    inputSchema: emptySchema,
    outputDescription: "Returns health or sensor metrics.",
  }),
  defineTool({
    name: "plugin_discover",
    category: "system",
    title: "Discover plugins",
    description: "Discovers installable Nicole plugins or tool packs.",
    whenToUse: "Use when Nicole needs to extend capabilities beyond built-in tools.",
    sideEffectLevel: "read",
    requiresConfirmation: false,
    availability: "hybrid",
    status: "planned",
    inputSchema: emptySchema,
    outputDescription: "Returns plugin options.",
  }),
];

export const READY_TOOL_NAMES = TOOL_CATALOG.filter(
  (tool) => tool.status === "ready"
).map((tool) => tool.name);
