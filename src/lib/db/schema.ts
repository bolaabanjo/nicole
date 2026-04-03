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
