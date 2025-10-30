import fs from "fs";
import path from "path";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { Client } from "pg";
import { spinner, log } from "@clack/prompts";

const execPromise = promisify(exec);

/**
 * checkCommandExists
 * ------------------
 * Detects whether a shell command is available on the current PATH.
 */
function checkCommandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * dumpSchemaViaNodePg
 * -------------------
 * Comprehensive schema dumper implemented purely in Node.js.
 *
 * Includes:
 *  - CREATE SEQUENCE and ALTER SEQUENCE OWNED BY
 *  - CREATE TABLE (with defaults and NOT NULL)
 *  - Constraints (PK, FK, UNIQUE, CHECK)
 *  - Indexes (skipping redundant or inherited ones)
 *  - Views
 *
 * Adds `SET session_replication_role = replica;` around dump
 * and defers foreign key creation until after all tables exist.
 */
export async function dumpSchemaViaNodePg(
  connectionString: string,
  dumpPath: string
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  const writeStream = fs.createWriteStream(dumpPath, { encoding: "utf8" });
  writeStream.write("-- Auto-generated schema dump (Node.js fallback)\n\n");
  writeStream.write("SET session_replication_role = replica;\n\n");

  await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;");

  /** ------------------------------------------------------------------
   * 1. Sequences
   * ------------------------------------------------------------------ */
  const { rows: sequences } = await client.query(`
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname;
  `);

  for (const seq of sequences) {
    writeStream.write(`CREATE SEQUENCE "${seq.schema}"."${seq.name}";\n`);
  }
  writeStream.write("\n");

  /** ------------------------------------------------------------------
   * 2. Tables and Constraints
   * ------------------------------------------------------------------ */
  const { rows: tables } = await client.query(`
    SELECT
      t.table_schema,
      t.table_name,
      c.relkind,
      EXISTS (
        SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid
      ) AS is_partition
    FROM information_schema.tables t
    JOIN pg_class c
      ON t.table_name = c.relname
     AND t.table_schema = c.relnamespace::regnamespace::text
    WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_schema, t.table_name;
  `);

  const deferredFKs: string[] = [];

  for (const { table_schema, table_name, is_partition } of tables) {
    try {
      // CREATE TABLE
      const ddlResult = await client.query(
        `
        SELECT
          'CREATE TABLE ' || quote_ident($1) || '.' || quote_ident($2) || E' (\n' ||
          string_agg(
            '  ' || quote_ident(a.attname) || ' ' ||
            pg_catalog.format_type(a.atttypid, a.atttypmod) ||
            coalesce(' DEFAULT ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') ||
            CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
            E',\n'
          ) || E'\n);\n' AS ddl
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE n.nspname = $1
          AND c.relname = $2
          AND a.attnum > 0
          AND NOT a.attisdropped
        GROUP BY c.relname;
        `,
        [table_schema, table_name]
      );

      const ddl = ddlResult.rows[0]?.ddl;
      if (!ddl) continue;
      writeStream.write(`${ddl}\n`);
      if (is_partition)
        writeStream.write(
          `-- Note: ${table_schema}.${table_name} is a partitioned child table\n`
        );

      // Constraints
      if (!is_partition) {
        const { rows: constraints } = await client.query(
          `
          SELECT conname, contype, pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = $2
          ORDER BY contype DESC;
          `,
          [table_schema, table_name]
        );

        for (const con of constraints) {
          if (!["p", "u", "f", "c"].includes(con.contype)) continue;
          const statement = `ALTER TABLE "${table_schema}"."${table_name}" ADD CONSTRAINT "${con.conname}" ${con.definition};`;
          if (con.contype === "f") deferredFKs.push(statement);
          else writeStream.write(statement + "\n");
        }
      }

      // Indexes — skip redundant PK/UNIQUE indexes
      if (!is_partition) {
        const { rows: constraintIndexes } = await client.query(
          `
          SELECT conname
          FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = $2;
          `,
          [table_schema, table_name]
        );
        const constraintSet = new Set(constraintIndexes.map((c) => c.conname));

        const { rows: indexes } = await client.query(
          `
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = $1 AND tablename = $2;
          `,
          [table_schema, table_name]
        );

        for (const idx of indexes) {
          if (constraintSet.has(idx.indexname)) continue; // skip duplicates
          writeStream.write(`${idx.indexdef};\n`);
        }
      }

      writeStream.write("\n");
    } catch (err: any) {
      log.warn(`Skipping ${table_schema}.${table_name}: ${err.message}`);
    }
  }

  /** ------------------------------------------------------------------
   * 3. Deferred Foreign Keys (after all tables)
   * ------------------------------------------------------------------ */
  writeStream.write("\n-- Deferred foreign key constraints\n");
  for (const fk of deferredFKs) writeStream.write(fk + "\n");
  writeStream.write("\n");

  /** ------------------------------------------------------------------
   * 4. ALTER SEQUENCE OWNED BY
   * ------------------------------------------------------------------ */
  const { rows: owned } = await client.query(`
    SELECT n.nspname AS schema, c.relname AS seqname, t.relname AS tablename, a.attname AS colname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_depend d ON d.objid = c.oid
    JOIN pg_class t ON d.refobjid = t.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE c.relkind = 'S'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema');
  `);
  for (const seq of owned) {
    writeStream.write(
      `ALTER SEQUENCE "${seq.schema}"."${seq.seqname}" OWNED BY "${seq.schema}"."${seq.tablename}"."${seq.colname}";\n`
    );
  }

  /** ------------------------------------------------------------------
   * 5. Views
   * ------------------------------------------------------------------ */
  const { rows: views } = await client.query(`
    SELECT table_schema, table_name, view_definition
    FROM information_schema.views
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name;
  `);
  for (const view of views) {
    writeStream.write(
      `CREATE OR REPLACE VIEW "${view.table_schema}"."${view.table_name}" AS ${view.view_definition};\n\n`
    );
  }

  writeStream.write("SET session_replication_role = DEFAULT;\n");
  await client.query("COMMIT;");
  await client.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.end(() => resolve());
    writeStream.on("error", reject);
  });

  log.success(`✅ Schema dump written (Node.js fallback) → ${dumpPath}`);
}

/**
 * dumpSchema
 * ----------
 * Unified high-level wrapper that:
 *  1. Uses pg_dump if available and not skipped.
 *  2. Falls back to Node.js dumper otherwise.
 */
export async function dumpSchema(
  connectionString: string,
  absPath: string,
  parsedArgs: Record<string, any>
): Promise<void> {
  const s = spinner();
  s.start("Dumping schema...");

  const dumpPath = path.join(absPath, "init.sql");
  const url = new URL(connectionString);
  const dbUser = url.username;
  const dbPassword = url.password;
  const dbHost = url.hostname;
  const dbPort = url.port;
  const dbName = url.pathname.split("/")[1];
  const skipPsql = parsedArgs["skip-psql"] ?? false;

  process.env.PGPASSWORD = dbPassword;

  try {
    if (checkCommandExists("pg_dump") && !skipPsql) {
      s.message("Using native pg_dump...");
      await execPromise(
        `pg_dump --schema-only --no-owner --no-acl -U ${dbUser} -h ${dbHost} -p ${dbPort} -d ${dbName} -f ${dumpPath}`
      );
      s.stop("✅ Schema dump complete (pg_dump).");
    } else {
      s.message(
        "pg_dump not found or skipped; switching to Node.js fallback..."
      );
      // Stop spinner before streaming logs from Node.js fallback
      s.stop("⚙️  Using Node.js fallback...");
      await dumpSchemaViaNodePg(connectionString, dumpPath);
      // Resume spinner for final message
      s.start("Finalizing schema dump...");
      s.stop("✅ Schema dump complete (Node.js fallback).");
    }
  } catch (err: any) {
    s.stop("❌ Schema dump failed.");
    log.error(err.message);
  } finally {
    delete process.env.PGPASSWORD;
  }
}
