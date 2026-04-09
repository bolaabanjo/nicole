import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  vector,
} from "drizzle-orm/pg-core";

export const SOURCE_SCOPES = ["personal", "study"] as const;
export type SourceScope = (typeof SOURCE_SCOPES)[number];

// Sources: everything you ingest (PDFs, URLs, notes, videos)
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  type: text("type").notNull(), // 'pdf', 'url', 'note', 'youtube'
  scope: text("scope").notNull().default("study"), // 'personal' | 'study'
  filePath: text("file_path"),
  url: text("url"),
  summary: text("summary"),
  rawText: text("raw_text"),
  ingestedAt: timestamp("ingested_at").defaultNow(),
});

// Chunks: semantic pieces of a source
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
    content: text("content").notNull(),
    position: integer("position"),
    embedding: vector("embedding", { dimensions: 768 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [index("chunks_embedding_idx").using("ivfflat", table.embedding.op("vector_cosine_ops"))]
);

// Concepts: extracted knowledge nodes
export const concepts = pgTable("concepts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").unique().notNull(),
  description: text("description"),
  domain: text("domain"), // 'physics', 'cs', 'engineering', etc.
  understanding: integer("understanding").default(1), // 1-5 depth
  lastTested: timestamp("last_tested"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Concept relationships
export const conceptLinks = pgTable(
  "concept_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromId: uuid("from_id")
      .references(() => concepts.id, { onDelete: "cascade" })
      .notNull(),
    toId: uuid("to_id")
      .references(() => concepts.id, { onDelete: "cascade" })
      .notNull(),
    relation: text("relation").notNull(), // 'depends_on', 'related_to', 'contradicts'
  },
  (table) => [
    uniqueIndex("concept_links_unique").on(
      table.fromId,
      table.toId,
      table.relation
    ),
  ]
);

// Concept ↔ Chunk mapping
export const conceptChunks = pgTable(
  "concept_chunks",
  {
    conceptId: uuid("concept_id")
      .references(() => concepts.id, { onDelete: "cascade" })
      .notNull(),
    chunkId: uuid("chunk_id")
      .references(() => chunks.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => [
    uniqueIndex("concept_chunks_pk").on(table.conceptId, table.chunkId),
  ]
);

// Research threads
export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  question: text("question"),
  status: text("status").default("active"), // 'active', 'paused', 'completed'
  createdAt: timestamp("created_at").defaultNow(),
});

// Thread ↔ Source mapping
export const threadSources = pgTable(
  "thread_sources",
  {
    threadId: uuid("thread_id")
      .references(() => threads.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: uuid("source_id")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => [
    uniqueIndex("thread_sources_pk").on(table.threadId, table.sourceId),
  ]
);

// Study sessions
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  mode: text("mode").notNull(), // 'socratic', 'feynman', 'review'
  conceptId: uuid("concept_id").references(() => concepts.id),
  threadId: uuid("thread_id").references(() => threads.id),
  messages: jsonb("messages"), // full conversation history
  score: integer("score"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Memories: things Nicole remembers
export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  category: text("category").notNull(), // 'personal', 'preference', 'goal', 'fact', 'context', 'career', 'project', 'achievement', 'education', 'public'
  importance: integer("importance").default(5), // 1-10
  source: text("source").default("conversation"), // 'conversation', 'research', 'ingestion'
  topic: text("topic"), // what/who this memory is about — e.g. "Bola Banjo", "quantum computing"
  embedding: vector("embedding", { dimensions: 768 }),
  lastReferencedAt: timestamp("last_referenced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Chat messages: the one continuous conversation with Nicole
export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  role: text("role").notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Conversation summaries: compressed snapshots of older chat windows
export const conversationSummaries = pgTable("conversation_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  startMessageId: uuid("start_message_id").references(() => chatMessages.id, {
    onDelete: "set null",
  }),
  endMessageId: uuid("end_message_id").references(() => chatMessages.id, {
    onDelete: "set null",
  }),
  startCreatedAt: timestamp("start_created_at"),
  endCreatedAt: timestamp("end_created_at"),
  messageCount: integer("message_count").notNull().default(0),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Conversation state: short-lived operational thread anchors for follow-up turns
export const conversationState = pgTable("conversation_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Turn artifacts: grounded evidence Nicole used in a turn, grouped by active topic
export const turnArtifacts = pgTable("turn_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatMessageId: uuid("chat_message_id").references(() => chatMessages.id, {
    onDelete: "set null",
  }),
  scopeKey: text("scope_key").notNull().default("global"),
  topicKind: text("topic_kind").notNull(),
  topicLabel: text("topic_label"),
  artifactKind: text("artifact_kind").notNull(), // 'tool_result' | 'vision' | 'source' | 'workspace' | 'assistant_answer'
  summary: text("summary").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const turnLinks = pgTable(
  "turn_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .references(() => chatMessages.id, { onDelete: "cascade" })
      .notNull(),
    linkedMessageId: uuid("linked_message_id")
      .references(() => chatMessages.id, { onDelete: "cascade" })
      .notNull(),
    scopeKey: text("scope_key").notNull().default("global"),
    linkType: text("link_type").notNull(), // 'follow_up_to' | 'responds_to'
    topicKind: text("topic_kind"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("turn_links_message_idx").on(table.messageId),
    index("turn_links_linked_message_idx").on(table.linkedMessageId),
    index("turn_links_scope_idx").on(table.scopeKey),
  ]
);

// Voice turns: speculative and final voice-runtime state scoped by surface/session
export const voiceTurns = pgTable(
  "voice_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeKey: text("scope_key").notNull().default("web:voice"),
    surface: text("surface").notNull().default("web"),
    sessionId: text("session_id").notNull().default("voice"),
    transcript: text("transcript").notNull(),
    intentClass: text("intent_class").notNull().default("conversational"),
    topicKind: text("topic_kind"),
    ackPolicy: text("ack_policy").notNull().default("none"),
    deterministicMode: text("deterministic_mode").notNull().default("false"),
    preActionText: text("pre_action_text"),
    statusText: text("status_text"),
    plannedToolCalls: jsonb("planned_tool_calls"),
    groundedArtifactIds: jsonb("grounded_artifact_ids"),
    replyToTurnId: uuid("reply_to_turn_id"),
    interruptedByTurnId: uuid("interrupted_by_turn_id"),
    preparedAt: timestamp("prepared_at").defaultNow(),
    consumedAt: timestamp("consumed_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("voice_turns_scope_idx").on(table.scopeKey),
    index("voice_turns_surface_idx").on(table.surface),
    index("voice_turns_session_idx").on(table.sessionId),
    index("voice_turns_prepared_idx").on(table.preparedAt),
  ]
);

// Tool invocations: audit trail for Nicole's tool system
export const toolInvocations = pgTable("tool_invocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  toolName: text("tool_name").notNull(),
  status: text("status").notNull(), // 'success', 'error', 'skipped'
  sideEffectLevel: text("side_effect_level").notNull(), // 'read' | 'write' | 'actuate'
  requiresConfirmation: text("requires_confirmation").default("false"),
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Integration accounts: external providers Nicole can connect to
export const integrationAccounts = pgTable(
  "integration_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(), // 'calendar' | 'email' | 'reminders'
    status: text("status").notNull().default("connected"), // 'connected' | 'error' | 'revoked'
    displayName: text("display_name"),
    email: text("email"),
    externalAccountId: text("external_account_id"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenType: text("token_type"),
    scope: text("scope"),
    tokenExpiresAt: timestamp("token_expires_at"),
    metadata: jsonb("metadata"),
    connectedAt: timestamp("connected_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [uniqueIndex("integration_accounts_provider_unique").on(table.provider)]
);

// Trusted devices: lightweight device-token auth for private mobile clients
export const trustedDevices = pgTable(
  "trusted_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").notNull(), // 'ios' | 'macos' | 'web'
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    lastUsedAt: timestamp("last_used_at").defaultNow(),
    revokedAt: timestamp("revoked_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("trusted_devices_token_hash_unique").on(table.tokenHash),
    index("trusted_devices_platform_idx").on(table.platform),
  ]
);

// Calendar events: Nicole's local scheduling store
export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  startAt: timestamp("start_at").notNull(),
  endAt: timestamp("end_at").notNull(),
  source: text("source").default("nicole"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Reminders: lightweight task/reminder store for Nicole
export const reminders = pgTable("reminders", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  notes: text("notes"),
  dueAt: timestamp("due_at"),
  status: text("status").default("pending"), // 'pending' | 'completed' | 'cancelled'
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Health metrics: daily health snapshots pushed from iPhone
export const healthMetrics = pgTable(
  "health_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: text("date").notNull(), // YYYY-MM-DD
    sleepHours: integer("sleep_hours"),
    sleepMinutes: integer("sleep_minutes"),
    sleepQuality: text("sleep_quality"), // 'poor' | 'fair' | 'good' | 'excellent'
    steps: integer("steps"),
    activeMinutes: integer("active_minutes"),
    restingHeartRate: integer("resting_heart_rate"),
    heartRateAvg: integer("heart_rate_avg"),
    heartRateMax: integer("heart_rate_max"),
    caloriesBurned: integer("calories_burned"),
    waterMl: integer("water_ml"),
    weight: integer("weight"), // grams (e.g. 75000 = 75kg)
    mood: text("mood"), // 'great' | 'good' | 'okay' | 'low' | 'bad'
    notes: text("notes"),
    rawData: jsonb("raw_data"), // full HealthKit dump for anything we don't have a column for
    pushedAt: timestamp("pushed_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [uniqueIndex("health_metrics_date_unique").on(table.date)]
);

// Notes / writing drafts
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").references(() => threads.id),
  title: text("title"),
  content: text("content"),
  type: text("type").default("note"), // 'note', 'draft', 'thesis'
  updatedAt: timestamp("updated_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});
