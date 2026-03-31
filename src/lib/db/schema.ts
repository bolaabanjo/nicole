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

// Sources: everything you ingest (PDFs, URLs, notes, videos)
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  type: text("type").notNull(), // 'pdf', 'url', 'note', 'youtube'
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
