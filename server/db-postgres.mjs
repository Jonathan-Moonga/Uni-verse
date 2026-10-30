import pg from "pg";

const { Pool } = pg;

export async function openPostgresDatabase({ connectionString }) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE || 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false }
  });

  await pool.query("select 1");

  async function transaction(setup, fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (setup) await setup(client);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    kind: "postgres",
    pg: pool,
    asUser(userId, fn) {
      return transaction(async (client) => {
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
      }, fn);
    },
    asAnon(fn) {
      return transaction(async (client) => {
        await client.query("set local role anon");
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      }, fn);
    },
    asService(fn) {
      return transaction(null, fn);
    },
    close() {
      return pool.end();
    }
  };
}
