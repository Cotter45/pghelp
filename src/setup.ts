import fs from "fs";
import path from "path";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { Client } from "pg";
import { spinner, log, text, confirm, isCancel } from "@clack/prompts";

const execPromise = promisify(exec);

function checkCommandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function resolveDatabaseTarget(
  connectionString: string
): Promise<string> {
  const url = new URL(connectionString);
  const dbName = url.pathname.split("/")[1];

  if (!dbName || ["postgres", "template1"].includes(dbName)) {
    log.warn(`⚠️  Your current database is "${dbName || "(none)"}".`);
    log.message(
      "That’s a system or default database and cannot be safely dropped or used for app migrations."
    );

    const createNew = await confirm({
      message: "Would you like to create and use a new database?",
      initialValue: true,
    });
    if (isCancel(createNew)) process.exit(0);

    const newDb = await text({
      message: "Enter a name for your new database (e.g. my_app_dev):",
      placeholder: "my_app_dev",
    });
    if (isCancel(newDb)) process.exit(0);

    const newUrl = new URL(connectionString);
    newUrl.pathname = "/" + newDb.trim();
    log.info(`Using new connection string: ${newUrl.toString()}`);
    return newUrl.toString();
  }

  return connectionString;
}

/**
 * setupDatabase
 * Creates database (if needed) and applies init.sql.
 */
export async function setupDatabase(
  connectionString: string,
  absPath: string,
  parsedArgs: Record<string, any>
): Promise<void> {
  const s = spinner();
  connectionString = await resolveDatabaseTarget(connectionString);

  s.start("🔧 Setting up local database...");
  const url = new URL(connectionString);
  const dbUser = url.username;
  const dbPassword = url.password;
  const dbHost = url.hostname;
  const dbPort = url.port;
  const dbName = url.pathname.split("/")[1];
  const skipPsql = parsedArgs["skip-psql"] ?? false;
  const cleanFlag = parsedArgs["clean"] ?? false;

  const initPath = path.join(absPath, "init.sql");
  if (!fs.existsSync(initPath)) {
    s.stop("❌ init.sql not found.");
    log.error(`Missing init.sql at ${initPath}`);
    process.exit(1);
  }

  const controlDb = dbName === "postgres" ? "template1" : "postgres";

  /* ────────────────
   * CASE 1: Use psql
   * ──────────────── */
  if (!skipPsql && checkCommandExists("psql")) {
    process.env.PGPASSWORD = dbPassword;
    try {
      if (cleanFlag) {
        s.message(`Dropping existing database "${dbName}"...`);
        await execPromise(
          `psql -U ${dbUser} -h ${dbHost} -p ${dbPort} -d ${controlDb} -c "DROP DATABASE IF EXISTS \\"${dbName}\\";"`
        );
        log.info(`🗑️  Dropped database "${dbName}".`);
      }

      s.message(`Creating database "${dbName}"...`);
      await execPromise(
        `psql -U ${dbUser} -h ${dbHost} -p ${dbPort} -d ${controlDb} -c "CREATE DATABASE \\"${dbName}\\";"`
      );
      log.info(`✅ Database "${dbName}" created.`);

      s.message("Applying init.sql via psql...");
      await execPromise(
        `psql -U ${dbUser} -h ${dbHost} -p ${dbPort} -d ${dbName} -f ${initPath}`
      );

      s.stop("✅ Database setup complete (psql CLI).");
    } catch (err: any) {
      s.stop("❌ Error during psql setup.");
      log.error(err.message);
    } finally {
      delete process.env.PGPASSWORD;
    }
    return;
  }

  /* ────────────────────────────────
   * CASE 2: Node.js fallback
   * ──────────────────────────────── */
  s.message("⚙️  psql not found or skipped, using Node.js fallback...");

  const sysClient = new Client({
    user: dbUser,
    password: dbPassword,
    host: dbHost,
    port: Number(dbPort),
    database: controlDb,
  });

  try {
    await sysClient.connect();

    if (cleanFlag) {
      const res = await sysClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      );
      if (res?.rowCount && res.rowCount > 0) {
        s.message(`Dropping existing database "${dbName}"...`);
        await sysClient.query(`DROP DATABASE "${dbName}";`);
        log.info(`🗑️  Dropped existing database "${dbName}".`);
      } else {
        log.info(`ℹ️  No existing database "${dbName}" found to drop.`);
      }
    }

    s.message(`Creating database "${dbName}"...`);
    await sysClient.query(`CREATE DATABASE "${dbName}";`);
    log.info(`✅ Database "${dbName}" created.`);
  } catch (err: any) {
    if (/already exists/i.test(err.message)) {
      log.info(`ℹ️  Database "${dbName}" already exists.`);
    } else {
      log.warn(`⚠️  Could not create database: ${err.message}`);
    }
  } finally {
    await sysClient.end();
  }

  s.message(`Connecting to "${dbName}"...`);
  const newDbClient = new Client({
    user: dbUser,
    password: dbPassword,
    host: dbHost,
    port: Number(dbPort),
    database: dbName,
  });

  try {
    await newDbClient.connect();
    log.info(`✅ Connected to database "${dbName}".`);

    s.message("Applying init.sql...");
    const fileStream = fs.createReadStream(initPath, { encoding: "utf8" });
    let buffer = "";

    for await (const chunk of fileStream) {
      buffer += chunk;
      const statements = buffer.split(";");
      buffer = statements.pop() || "";
      for (const statement of statements) {
        const trimmed = statement.trim();
        if (!trimmed) continue;
        try {
          await newDbClient.query(trimmed);
        } catch (err: any) {
          log.warn(`⚠️  Failed executing: ${trimmed.slice(0, 60)}...`);
          log.warn(err.message);
        }
      }
    }

    if (buffer.trim()) await newDbClient.query(buffer.trim());

    s.stop("✅ Database setup complete (Node fallback).");
  } catch (err: any) {
    s.stop("❌ Error applying init.sql.");
    log.error(`Failed to apply init.sql: ${err.message}`);
    process.exit(1);
  } finally {
    await newDbClient.end();
  }
}
