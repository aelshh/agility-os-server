import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

await client.connect();

const emp = await client.query("SELECT count(*)::int AS n FROM employees");
console.log("employees:", emp.rows[0].n);

const mgr = await client.query(
  "SELECT count(*)::int AS total, count(external_manager_id)::int AS with_mgr, count(*) FILTER (WHERE external_manager_id IS NULL)::int AS null_mgr FROM employees",
);
console.log("manager refs:", mgr.rows[0]);

const sample = await client.query("SELECT externalHrmsId, external_manager_id, name FROM employees LIMIT 8");
console.log("sample:", JSON.stringify(sample.rows, null, 1));

await client.end();