#!/usr/bin/env node

/**
 * This script is the entry point for database-related actions:
 * - Setup local database
 * - Dump schema
 * - Create migration
 * - Run migrations
 * - Revert migrations
 * - Generate types, function types, or Zod schema
 *
 * It uses minimist to parse named command-line arguments (e.g. --action, --migration, --revert, --db-url).
 * Missing values are prompted interactively via @clack/prompts.
 * It also ensures the DATABASE_URL environment variable is set from a .env file located in the project root.
 */

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { Client } from "pg";
import minimist from "minimist";
import fsPromises from "fs/promises";
import { log, text, select, isCancel, spinner } from "@clack/prompts";

import { generateSchema, generateSchemaIndex } from "./gen-schema";
import { runMigrations } from "./run-migration";
import { createMigration } from "./create-migration";
import {
  generateFunctionTypes,
  generateTypes,
  generateTypeSafeFunctions,
  generateTypesIndex,
} from "./gen-types";

import type { Action, Config } from "./types";
import { dumpSchema, dumpSchemaViaNodePg } from "./node-dump";
import { setupDatabase } from "./setup";
import { verifySchemas } from "./verify";

// Default configuration values.
const baseConfig: Config = {
  migrationsDir: "migrations",
  migrationPath: "db",
  migrationsTable: "migrations",
  schemas: ["public"],
};

/**
 * Removes segments from a file path that come from node_modules or packages/postgres.
 * Helps to determine the "project root" even when the script is run from within a package.
 */
const removePackagePath = (filePath: string): string => {
  return filePath
    .replace(/(\/|\\)node_modules(\/|\\)[^\/\\]+(\/|\\)?/g, "/")
    .replace(/(\/|\\)packages(\/|\\)postgres(\/|\\)?/g, "/");
};

// Determine the config file location relative to the project root.
const configFile = path.resolve(
  removePackagePath(process.env.INIT_CWD || process.cwd()),
  "./pghelp_config.json"
);

/**
 * Checks for a .env file in the project root and ensures that the
 * DATABASE_URL variable is defined. If not, prompts for it,
 * writes (appends) it to the .env file, reloads environment variables, and returns the value.
 */
async function checkAndPromptForDbUrl(): Promise<string> {
  const targetDir = process.env.INIT_CWD || process.cwd();
  const targetRoot = removePackagePath(targetDir);
  let envFilePath = path.join(targetRoot, ".env");

  if (!fs.existsSync(envFilePath)) {
    const envFilePathInput = await text({
      message: "Enter the path to your .env file:",
      initialValue: envFilePath,
    });
    if (isCancel(envFilePathInput)) {
      log.error("Cancelled");
      process.exit(0);
    }
    envFilePath = envFilePathInput;
    if (!envFilePath.endsWith(".env")) {
      log.error("Invalid .env file path. Please provide a valid path.");
      process.exit(0);
    }
    if (!fs.existsSync(envFilePath)) {
      log.error(
        `The specified .env file does not exist at ${envFilePath}. Please create it.`
      );
      process.exit(0);
    }
    dotenv.config({ path: envFilePath });
  } else {
    log.success(`Loaded .env file at ${envFilePath}`);
  }

  let envVars: Record<string, string> = dotenv.parse(
    fs.readFileSync(envFilePath)
  );
  const sanitizeUrl = (url: string) => url.replace(/"/g, "").trim();

  if (!envVars.DATABASE_URL) {
    const dbUrlInput = await text({
      message: "Enter your Postgres database URL:",
      initialValue: "postgres://username:password@host:port/database",
    });
    if (isCancel(dbUrlInput)) {
      log.error("Cancelled");
      process.exit(0);
    }
    const dbUrl = sanitizeUrl(dbUrlInput);
    const newEnvContent = `DATABASE_URL=${dbUrl}\n`;
    try {
      await fsPromises.appendFile(envFilePath, newEnvContent, "utf8");
      log.success(`.env file updated at ${envFilePath}`);
    } catch (err) {
      log.error("Error writing .env file: " + err);
      process.exit(0);
    }
    dotenv.config({ path: envFilePath });
    return dbUrl;
  } else {
    log.success(`Using Postgres database URL from .env at ${envFilePath}`);
    return sanitizeUrl(envVars.DATABASE_URL);
  }
}

/**
 * Prompts the user for configuration details (migration path, migrations directory, table name).
 *
 * @returns A Config object with the provided values.
 */
/**
 * Prompts the user for configuration details (migration path, migrations directory, table name, schemas).
 *
 * @returns A Config object with the provided values.
 */
async function promptConfig(): Promise<Config> {
  const migrationPath = await text({
    message: "Enter base migration path:",
    initialValue: removePackagePath(
      path.join(process.env.INIT_CWD || process.cwd(), baseConfig.migrationPath)
    ),
  });
  if (isCancel(migrationPath)) {
    log.error("Cancelled");
    process.exit(0);
  }

  const migrationsDir = await text({
    message: "Enter migrations directory name:",
    initialValue: baseConfig.migrationsDir,
  });
  if (isCancel(migrationsDir)) {
    log.error("Cancelled");
    process.exit(0);
  }

  const migrationsTable = await text({
    message: "Enter migrations table name:",
    initialValue: baseConfig.migrationsTable,
  });
  if (isCancel(migrationsTable)) {
    log.error("Cancelled");
    process.exit(0);
  }

  // 🔹 Ask for schemas (comma-separated)
  const schemasInput = await text({
    message: "Enter schemas (comma-separated):",
    initialValue: (baseConfig.schemas ?? ["public"]).join(", "),
  });
  if (isCancel(schemasInput)) {
    log.error("Cancelled");
    process.exit(0);
  }

  const schemas = schemasInput
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    migrationPath: path.isAbsolute(migrationPath)
      ? migrationPath
      : path.resolve(migrationPath),
    migrationsDir,
    migrationsTable,
    schemas: schemas.length > 0 ? schemas : ["public"],
  };
}

/**
 * Loads configuration from the config file. If the file does not exist or cannot be parsed,
 * prompts the user for configuration details and writes them to the config file.
 *
 * @returns A Config object.
 */
async function loadConfig(parsedArgs: Record<string, string>): Promise<Config> {
  let config: Config = { ...baseConfig };

  if (fs.existsSync(configFile)) {
    try {
      const configContent = await fsPromises.readFile(configFile, "utf8");
      const parsed = JSON.parse(configContent);
      config = { ...baseConfig, ...parsed };
    } catch (error) {
      log.warn("Error reading config file. Let's set it up.");
      config = await promptConfig();
      await fsPromises.writeFile(configFile, JSON.stringify(config, null, 2));
    }
  } else {
    const migrationPath = parsedArgs["migration-path"];
    const migrationsDir = parsedArgs["migrations-dir"];
    const migrationsTable = parsedArgs["migrations-table"];

    if (migrationPath && migrationsDir && migrationsTable) {
      config = {
        migrationPath: path.isAbsolute(migrationPath)
          ? migrationPath
          : path.resolve(migrationPath),
        migrationsDir,
        migrationsTable,
      };
    } else {
      log.warn("Config file not found. Let's set it up.");
      config = await promptConfig();
      await fsPromises.writeFile(configFile, JSON.stringify(config, null, 2));
    }
  }

  // 🔹 Normalize schemas support (non-breaking)
  if (
    !config.schemas ||
    !Array.isArray(config.schemas) ||
    config.schemas.length === 0
  ) {
    config.schemas = ["public"];
  }

  // 🔹 Allow overriding schemas via CLI flag (--schemas us,canada)
  if (parsedArgs.schemas) {
    const parsedSchemas = String(parsedArgs.schemas)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parsedSchemas.length > 0) {
      config.schemas = parsedSchemas;
    }
  }

  // 🔹 Always normalize to lowercase for Postgres safety
  config.schemas = config.schemas.map((s) => s.toLowerCase());

  return config;
}

/**
 * Returns the list of schemas to operate on based on the configuration.
 *
 * @param config - The configuration object.
 * @returns An array of schema names.
 */
function getSchemas(config: Config): string[] {
  return config.schemas && config.schemas.length > 0
    ? config.schemas
    : ["public"];
}

/**
 * Updates the configuration interactively.
 *
 * @param configFile - The path to the configuration file.
 */
/**
 * Updates the configuration interactively, including schemas.
 *
 * @param configFile - The path to the configuration file.
 */
async function updateConfig(configFile: string): Promise<void> {
  log.info("Updating configuration...");

  let currentConfig: Config = baseConfig;
  if (fs.existsSync(configFile)) {
    try {
      const configContent = await fsPromises.readFile(configFile, "utf8");
      currentConfig = { ...baseConfig, ...JSON.parse(configContent) };
    } catch {
      log.warn("Error reading existing config file. Starting fresh.");
    }
  }

  const migrationPath = await text({
    message: "Enter base migration path:",
    initialValue: currentConfig.migrationPath,
  });
  if (isCancel(migrationPath)) process.exit(0);

  const migrationsDir = await text({
    message: "Enter migrations directory name:",
    initialValue: currentConfig.migrationsDir,
  });
  if (isCancel(migrationsDir)) process.exit(0);

  const migrationsTable = await text({
    message: "Enter migrations table name:",
    initialValue: currentConfig.migrationsTable,
  });
  if (isCancel(migrationsTable)) process.exit(0);

  // 🔹 Add schema editing
  const schemasInput = await text({
    message: "Enter schemas (comma-separated):",
    initialValue: (currentConfig.schemas ?? ["public"]).join(", "),
  });
  if (isCancel(schemasInput)) process.exit(0);

  const schemas = schemasInput
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const updatedConfig: Config = {
    migrationPath: path.isAbsolute(migrationPath)
      ? migrationPath
      : path.resolve(migrationPath),
    migrationsDir,
    migrationsTable,
    schemas: schemas.length > 0 ? schemas : ["public"],
  };

  try {
    await fsPromises.writeFile(
      configFile,
      JSON.stringify(updatedConfig, null, 2),
      "utf8"
    );
    log.success("Configuration updated successfully.");
  } catch (error) {
    log.error("Failed to update configuration: " + error);
    process.exit(0);
  }
}

/**
 * Queries the connected database for all non-system schemas
 * and updates the config file if they differ from what's stored.
 */
async function syncSchemasFromDatabase(
  client: Client,
  config: Config
): Promise<Config> {
  const { rows } = await client.query(`
    SELECT nspname AS schema_name
    FROM pg_namespace
    WHERE nspname NOT LIKE 'pg_%'
      AND nspname NOT LIKE 'information_schema'
      AND nspname NOT LIKE 'pg_toast%'
      AND nspname NOT LIKE 'pg_temp%'
      AND nspname NOT LIKE 'catalog%'
      AND nspname NOT LIKE '_timescaledb%'
      AND nspname NOT LIKE 'pglogical%'
      AND nspname NOT LIKE 'repack%'
      AND nspname != 'public'
    ORDER BY nspname;
  `);

  const dbSchemas = rows.map((r) => r.schema_name.toLowerCase());
  const existing = (config.schemas ?? []).map((s) => s.toLowerCase());

  const areDifferent =
    dbSchemas.length !== existing.length ||
    dbSchemas.some((s) => !existing.includes(s));

  if (areDifferent) {
    log.info(
      `Detected schema update in database. Syncing pghelp_config.json → [${dbSchemas.join(
        ", "
      )}]`
    );
    config.schemas = dbSchemas;
    await fsPromises.writeFile(
      configFile,
      JSON.stringify(config, null, 2),
      "utf8"
    );
  }

  return config;
}

/**
 * Prints all available actions and their descriptions.
 */
function printHelp(): void {
  console.log(`
Usage: pghelp [--action <action>] [options]

Available Actions:
  setup              - Setup a local database.
  dump               - Dump the database schema to a file.
  create             - Create a new migration file.
  run                - Run all pending migrations.
  revert             - Revert the last migration(s).
  gentypes           - Generate TypeScript types from the database schema.
  genfunctypes       - Generate TypeScript types for database functions.
  genschema          - Generate a Zod schema from the database schema.
  genfunctions       - Generate TypeScript functions for database queries.
  verify             - Compare schemas for drift (structure differences).
  config             - Update the configuration interactively.
  help               - Show this help message.

Options:
  --schemas            - Comma-separated list of schemas to include (default: "public").
  --action             - Specify the action to perform.
  --db-url             - Provide the database connection string.
  --migration-path     - Specify the base migration path (default: "db").
  --migrations-dir     - Specify the migrations directory name (default: "migrations").
  --migrations-table   - Specify the migrations table name (default: "migrations").
  --migration, --name  - Specify the migration name (for "create").
  --revert             - Specify the number of migrations to revert (for "revert").
  --verify             - Compare schemas for drift (structure differences).


Examples:
  pghelp --action setup
  pghelp --action create --name add_users_table
  pghelp --action revert --revert 1
  pghelp --action gentypes
  pghelp --action help

Flags
  --non-interactive    - Run in non-interactive mode (will error if prompts are needed).
  --force-optional     - (for genschema) - Default: false. Force all fields to be optional.
  --coerce-dates       - (for genschema) - Default: false. Use z.coerce.date() for Date fields.
  --default-null       - (for genschema) - Default: true. Add default(null) for nullable fields.
`);
}

/**
 * Main entry point.
 * Parses command-line arguments using minimist for named arguments:
 *  --action (or first positional argument),
 *  --migration / --name (for create),
 *  --revert (for revert),
 *  --db-url (database connection string).
 * Prompts interactively for missing values, then executes the selected action.
 */
async function main(): Promise<void> {
  const parsedArgs = minimist(process.argv.slice(2));

  // Flags
  const nonInteractiveFlag = parsedArgs["non-interactive"] ?? false;
  const forceOptionalFlag = parsedArgs["force-optional"] ?? false;
  const coerceDatesFlag = parsedArgs["coerce-dates"] ?? false;
  const defaultNullFlag = parsedArgs["default-null"] ?? true;

  // Determine action from --action or first positional argument.
  let action: Action;
  if (parsedArgs.action) {
    action = parsedArgs.action as Action;
  } else if (parsedArgs._.length > 0) {
    action = parsedArgs._[0] as Action;
  } else {
    const response = await select({
      message: "Select action",
      options: [
        { value: "help", label: "Help" },
        { value: "config", label: "Update Config" },
        { value: "dump", label: "Dump schema" },
        { value: "setup", label: "Setup local" },
        { value: "create", label: "Create migration" },
        { value: "run", label: "Run migrations" },
        { value: "revert", label: "Revert migrations" },
        { value: "gentypes", label: "Generate types" },
        { value: "genfunctypes", label: "Generate function types" },
        { value: "genschema", label: "Generate Zod schema" },
        { value: "genfunctions", label: "Generate Typescript functions" },
        { value: "verify", label: "Check for schema drift" },
      ],
    });
    if (isCancel(response)) {
      log.error("Cancelled");
      process.exit(0);
    }
    action = response as Action;
  }

  // For "create", allow a migration name via --migration or --name.
  let migrationName = "";
  if (action === "create") {
    if (parsedArgs.migration) {
      migrationName = parsedArgs.migration;
    } else if (parsedArgs.name) {
      migrationName = parsedArgs.name;
    } else {
      const migrationResp = await text({
        message: "Enter migration name",
      });
      if (isCancel(migrationResp)) {
        log.error("Cancelled");
        process.exit(0);
      }
      migrationName = migrationResp;
    }
  }

  // For "revert", allow a revert count via --revert.
  let numberOfMigrations = 0;
  if (action === "revert") {
    if (parsedArgs.revert) {
      numberOfMigrations = Number(parsedArgs.revert);
      if (isNaN(numberOfMigrations) || numberOfMigrations <= 0) {
        log.error("Invalid number of migrations to revert.");
        process.exit(0);
      }
    } else {
      const revertResp = await text({
        message: "Enter number of migrations to revert",
      });
      if (isCancel(revertResp)) {
        log.error("Cancelled");
        process.exit(0);
      }
      numberOfMigrations = Number(revertResp);
      if (isNaN(numberOfMigrations) || numberOfMigrations <= 0) {
        log.error("Invalid number of migrations to revert.");
        process.exit(0);
      }
    }
  }

  // Allow passing a database URL via --db-url.
  let connectionString: string;
  if (parsedArgs["db-url"]) {
    connectionString = parsedArgs["db-url"];
    log.success("Using database URL from command line argument.");
  } else {
    connectionString = await checkAndPromptForDbUrl();
  }

  // Validate the connection string.
  try {
    new URL(connectionString);
  } catch (err) {
    log.error("Invalid Postgres database URL: " + err);
    process.exit(0);
  }

  // Load additional configuration.
  const config = await loadConfig(parsedArgs);

  // Determine the absolute path for migrations.
  const absPath = path.resolve(config.migrationPath, config.migrationsDir);
  if (!fs.existsSync(absPath)) {
    log.warn(`Directory ${absPath} does not exist. Creating...`);
    try {
      fs.mkdirSync(absPath, { recursive: true });
      fs.mkdirSync(path.join(absPath, "up"));
      fs.mkdirSync(path.join(absPath, "down"));
    } catch (error) {
      log.error(`Failed to create directories at ${absPath}: ${error}`);
      process.exit(0);
    }
  }

  // Ensure .gitignore has pghelp_config.json and .env
  const gitignorePath = path.join(
    removePackagePath(process.env.INIT_CWD || process.cwd()),
    ".gitignore"
  );
  const ensureIgnored = (entry: string) => {
    const content = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, "utf8")
      : "";
    if (!content.includes(entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`);
      log.success(`Added ${entry} to .gitignore`);
    }
  };
  ensureIgnored("pghelp_config.json");
  ensureIgnored(".env");

  let client: Client | undefined;
  if (!["setup", "dump"].includes(action)) {
    client = new Client({ connectionString });
    try {
      await client.connect();
    } catch (error) {
      log.error("Failed to connect to the database: " + error);
      process.exit(0);
    }
  }

  let schemas: string[] = [];

  if (client) {
    // 🔹 Automatically sync schemas from database
    config.schemas = (await syncSchemasFromDatabase(client, config)).schemas;
    schemas = getSchemas(config);
  } else {
    schemas = config.schemas || ["public"];
  }

  try {
    if (action === "setup") {
      await setupDatabase(connectionString, absPath, parsedArgs);
    } else if (action === "help") {
      printHelp();
    } else if (action === "config") {
      await updateConfig(configFile);
    } else if (action === "dump") {
      await dumpSchema(connectionString, absPath, parsedArgs);
    } else if (action === "create") {
      const s = spinner();
      s.start("Creating migration...");
      await createMigration(client!, migrationName, config);
      s.stop("Migration created.");
    } else if (action === "run") {
      const s = spinner();
      s.start("Running migrations...");
      await runMigrations(client!, "up", config);
      s.stop("Migrations run successfully.");
    } else if (action === "revert") {
      const s = spinner();
      s.start("Reverting migrations...");
      await runMigrations(client!, "down", config, numberOfMigrations);
      s.stop("Migrations reverted successfully.");
    } else if (action === "gentypes") {
      const s = spinner();
      for (const schema of schemas) {
        const outPath =
          schemas.length > 1
            ? path.join(absPath, `../types/${schema}`)
            : path.join(absPath, "../types");

        fs.mkdirSync(outPath, { recursive: true });
        s.start(`Generating types for schema "${schema}"...`);
        await generateTypes(client!, outPath, schema);
        s.stop(`Types generated for "${schema}".`);
      }
      await generateTypesIndex(path.join(absPath, "../types"), schemas);
      s.stop("All types generated.");
    } else if (action === "genfunctypes") {
      const s = spinner();
      s.start("Generating function types...");
      const outPath = path.join(absPath, "../types");
      fs.mkdirSync(outPath, { recursive: true });
      await generateFunctionTypes(client!, outPath);
      s.stop("Function types generated.");
    } else if (action === "genfunctions") {
      const s = spinner();
      s.start("Generating functions...");
      const outPath = path.join(absPath, "../functions");
      fs.mkdirSync(outPath, { recursive: true });
      await generateTypeSafeFunctions(client!, outPath);
      s.stop("Functions generated.");
    } else if (action === "verify") {
      const s = spinner();
      s.start("Verifying schemas...");
      await verifySchemas(client!, schemas);
      s.stop("Verification complete.");
    } else if (action === "genschema") {
      const s = spinner();
      s.start("Preparing to generate Zod schema...");

      try {
        // normalize output roots
        const projectRoot = path.resolve(absPath, "../");
        const typesRoot = path.join(projectRoot, "types");
        const schemaRoot = path.join(projectRoot, "schema");

        fs.mkdirSync(typesRoot, { recursive: true });
        fs.mkdirSync(schemaRoot, { recursive: true });

        log.info(
          `Generating types for ${schemas.length} schema${
            schemas.length > 1 ? "s" : ""
          }...`
        );

        // generate per schema
        for (const schema of schemas) {
          const typesOut =
            schemas.length > 1 ? path.join(typesRoot, schema) : typesRoot;

          fs.mkdirSync(typesOut, { recursive: true });

          const sType = spinner();
          sType.start(`Generating types for schema "${schema}"...`);
          try {
            await generateTypes(client!, typesOut, schema);
            sType.stop(`Types generated for ${schema}.`);
          } catch (err) {
            sType.stop(`❌ Failed generating types for ${schema}.`);
            log.error(err instanceof Error ? err.message : String(err));
          }
        }

        s.stop("Type generation complete.");
      } catch (err) {
        s.stop("Error preparing type generation.");
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // now handle zod schema generation options
      const outPath = path.resolve(absPath, "../schema");
      fs.mkdirSync(outPath, { recursive: true });

      let forceOptional: boolean;
      let useCoerceDates: boolean;
      let addDefaultNull: boolean;

      if (nonInteractiveFlag) {
        forceOptional = forceOptionalFlag;
        useCoerceDates = coerceDatesFlag;
        addDefaultNull = defaultNullFlag;
      } else {
        const ask = async <T>(
          message: string,
          yesLabel: string,
          noLabel: string
        ) => {
          const choice = await select({
            message,
            options: [
              { value: true, label: `Yes — ${yesLabel}` },
              { value: false, label: `No — ${noLabel}` },
            ],
          });
          if (isCancel(choice)) process.exit(0);
          return choice;
        };

        forceOptional = await ask(
          "Should all fields be forced optional?",
          "make all fields optional",
          "use type definition optionality"
        );
        useCoerceDates = await ask(
          "Should Date fields use z.coerce.date()?",
          "coerce date strings",
          "keep as strings"
        );
        addDefaultNull = await ask(
          "Add default(null) for nullable fields?",
          "default to null",
          "leave undefined"
        );
      }

      const s2 = spinner();
      s2.start("Generating Zod schema files...");

      try {
        // ✅ FIXED: now passing schemas as the 5th argument
        await generateSchema(
          outPath,
          forceOptional,
          useCoerceDates,
          addDefaultNull,
          schemas
        );

        await generateSchemaIndex(outPath, schemas);

        s2.stop("Zod schema generated successfully.");
        log.success(`Schema output → ${outPath}`);
      } catch (err) {
        s2.stop("❌ Failed to generate Zod schema.");
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
  } catch (error: any) {
    log.error("An error occurred: " + error);
  } finally {
    if (client) {
      await client.end();
      log.success("Database connection closed.");
    }
  }
}

main()
  .then(() => {
    log.info("");
    process.exit(0);
  })
  .catch((error) => {
    log.error("Unexpected error: " + error);
    process.exit(0);
  });
