import pg from "pg";

const { Client } = pg;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required. Run this through dotenv or set the variable first."
    );
  }

  const includePersonalSources = process.argv.includes("--include-personal-sources");
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();

  try {
    await client.query("begin");

    const counts = await Promise.all([
      client.query("select count(*)::int as count from tool_invocations"),
      client.query("select count(*)::int as count from conversation_summaries"),
      client.query("select count(*)::int as count from chat_messages"),
      client.query("select count(*)::int as count from memories"),
      includePersonalSources
        ? client.query(
            "select count(*)::int as count from sources where scope = 'personal'"
          )
        : Promise.resolve({ rows: [{ count: 0 }] }),
    ]);

    await client.query("delete from tool_invocations");
    await client.query("delete from conversation_summaries");
    await client.query("delete from chat_messages");
    await client.query("delete from memories");

    if (includePersonalSources) {
      await client.query("delete from sources where scope = 'personal'");
    }

    await client.query("commit");

    const [toolCount, summaryCount, messageCount, memoryCount, personalSourceCount] =
      counts.map((result) => result.rows[0]?.count ?? 0);

    console.log("Nicole state reset complete.");
    console.log(`- cleared tool invocations: ${toolCount}`);
    console.log(`- cleared conversation summaries: ${summaryCount}`);
    console.log(`- cleared chat messages: ${messageCount}`);
    console.log(`- cleared memories: ${memoryCount}`);

    if (includePersonalSources) {
      console.log(`- cleared personal sources: ${personalSourceCount}`);
    } else {
      console.log("- preserved all sources");
    }
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed to reset Nicole state:", error);
  process.exitCode = 1;
});
