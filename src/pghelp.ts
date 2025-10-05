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
import { promisify } from "util";
import fsPromises from "fs/promises";
import { exec } from "child_process";
import { log, text, select, isCancel, spinner } from "@clack/prompts";

import { generateSchema } from "./gen-schema";
import { runMigrations } from "./run-migration";
import { createMigration } from "./create-migration";
import {
  generateFunctionTypes,
  generateTypes,
  generateTypeSafeFunctions,
} from "./gen-types";

import type { Action, Config } from "./types";

// Promisify exec for async/await usage.
const execPromise = promisify(exec);

// Default configuration values.
const baseConfig: Config = {
  migrationsDir: "migrations",
  migrationPath: "db",
  migrationsTable: "migrations",
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

  return {
    migrationPath: path.isAbsolute(migrationPath)
      ? migrationPath
      : path.resolve(migrationPath),
    migrationsDir,
    migrationsTable,
  };
}

/**
 * Loads configuration from the config file. If the file does not exist or cannot be parsed,
 * prompts the user for configuration details and writes them to the config file.
 *
 * @returns A Config object.
 */
async function loadConfig(parsedArgs: Record<string, string>): Promise<Config> {
  let config: Config = baseConfig;

  if (fs.existsSync(configFile)) {
    try {
      const configContent = await fsPromises.readFile(configFile, "utf8");
      const parsed = JSON.parse(configContent);
      config = { ...baseConfig, ...parsed };
    } catch (error) {
      log.warn("Error reading config file. Let's set it up.");
      config = await promptConfig();
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
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
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
  }
  return config;
}

/**
 * Updates the configuration interactively.
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
    } catch (error) {
      log.warn("Error reading existing config file. Starting fresh.");
    }
  }

  const migrationPath = await text({
    message: "Enter base migration path:",
    initialValue: currentConfig.migrationPath,
  });
  if (isCancel(migrationPath)) {
    log.error("Cancelled");
    process.exit(0);
  }

  const migrationsDir = await text({
    message: "Enter migrations directory name:",
    initialValue: currentConfig.migrationsDir,
  });
  if (isCancel(migrationsDir)) {
    log.error("Cancelled");
    process.exit(0);
  }

  const migrationsTable = await text({
    message: "Enter migrations table name:",
    initialValue: currentConfig.migrationsTable,
  });
  if (isCancel(migrationsTable)) {
    log.error("Cancelled");
    process.exit(0);
  }

  const updatedConfig: Config = {
    migrationPath: path.isAbsolute(migrationPath)
      ? migrationPath
      : path.resolve(migrationPath),
    migrationsDir,
    migrationsTable,
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
  config             - Update the configuration interactively.
  help               - Show this help message.

Options:
  --action             - Specify the action to perform.
  --db-url             - Provide the database connection string.
  --migration-path     - Specify the base migration path (default: "db").
  --migrations-dir     - Specify the migrations directory name (default: "migrations").
  --migrations-table   - Specify the migrations table name (default: "migrations").
  --migration, --name  - Specify the migration name (for "create").
  --revert             - Specify the number of migrations to revert (for "revert").

Examples:
  pghelp --action setup
  pghelp --action create --name add_users_table
  pghelp --action revert --revert 1
  pghelp --action gentypes
  pghelp --action help
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

  // Check if .gitignore in root
  const gitignorePath = path.join(
    removePackagePath(process.env.INIT_CWD || process.cwd()),
    ".gitignore"
  );
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
    if (!gitignoreContent.includes("pghelp_config.json")) {
      fs.appendFileSync(gitignorePath, "\npghelp_config.json\n");
      log.success("Added pghelp_config.json to .gitignore");
    }

    if (!gitignoreContent.includes(".env")) {
      fs.appendFileSync(gitignorePath, "\n.env\n");
      log.success("Added .env to .gitignore");
    }
  } else {
    // create .gitignore if it doesn't exist
    fs.writeFileSync(gitignorePath, "\npghelp_config.json\n");
    log.success("Created .gitignore and added pghelp_config.json to it");

    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");

    if (!gitignoreContent.includes(".env")) {
      fs.appendFileSync(gitignorePath, "\n.env\n");
      log.success("Added .env to .gitignore");
    }
  }

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

  try {
    if (action === "setup") {
      const s = spinner();
      s.start("Setting up local database...");
      const url = new URL(connectionString);
      const dbUser = url.username;
      const dbPassword = url.password;
      const dbHost = url.hostname;
      const dbPort = url.port;
      const dbName = url.pathname.split("/")[1];

      process.env.PGPASSWORD = dbPassword;
      try {
        await execPromise(
          `psql -U ${dbUser} -h ${dbHost} -p ${dbPort} -c "CREATE DATABASE ${dbName}"`
        );
      } catch (error) {
        s.stop("Database already exists.");
      }
      try {
        await execPromise(
          `psql -U ${dbUser} -h ${dbHost} -p ${dbPort} -c "CREATE ROLE pg_su;"`
        );
        await execPromise(
          `psql -U ${dbUser} -h ${dbHost} -p ${dbPort} -c "CREATE ROLE pg_admin;"`
        );
      } catch (error) {
        s.stop("Roles already exist.");
      }
      const initPath = path.join(absPath, "init.sql");
      if (!fs.existsSync(initPath)) {
        s.stop("init.sql not found.");
        process.exit(0);
      }
      await execPromise(
        `psql -U ${dbUser} -h ${dbHost} -p ${dbPort} -d ${dbName} -f ${initPath}`
      );
      s.stop("Database setup complete.");
    } else if (action === "help") {
      printHelp();
      process.exit(0);
    } else if (action === "config") {
      await updateConfig(configFile);
    } else if (action === "dump") {
      const s = spinner();
      s.start("Dumping schema...");
      const dumpPath = path.join(absPath, "init.sql");
      const url = new URL(connectionString);
      const dbUser = url.username;
      const dbPassword = url.password;
      const dbHost = url.hostname;
      const dbPort = url.port;
      const dbName = url.pathname.split("/")[1];

      process.env.PGPASSWORD = dbPassword;
      await execPromise(
        `pg_dump -U ${dbUser} -h ${dbHost} -p ${dbPort} -d ${dbName} -f ${dumpPath}`
      );
      delete process.env.PGPASSWORD;
      s.stop("Schema dump complete.");
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
      s.start("Generating types...");
      const outPath = path.join(absPath, "../types");
      if (!fs.existsSync(outPath)) {
        fs.mkdirSync(outPath, { recursive: true });
      }
      await generateTypes(client!, outPath);
      s.stop("Types generated.");
    } else if (action === "genfunctypes") {
      const s = spinner();
      s.start("Generating function types...");
      const outPath = path.join(absPath, "../types");
      if (!fs.existsSync(outPath)) {
        fs.mkdirSync(outPath, { recursive: true });
      }
      await generateFunctionTypes(client!, outPath);
      s.stop("Function types generated.");
    } else if (action === "genfunctions") {
      const s = spinner();
      s.start("Generating functions...");
      const outPath = path.join(absPath, "../functions");
      if (!fs.existsSync(outPath)) {
        fs.mkdirSync(outPath, { recursive: true });
      }
      await generateTypeSafeFunctions(client!, outPath);
      s.stop("Functions generated.");
    } else if (action === "genschema") {
      const s = spinner();
      s.start("Preparing to generate Zod schema...");

      const typesPath = path.join(absPath, "../types");
      const outPath = path.join(absPath, "../schema");

      // Ensure types directory exists and is up to date
      if (!fs.existsSync(typesPath)) {
        fs.mkdirSync(typesPath, { recursive: true });
        await generateTypes(client!, typesPath);
      }

      if (!fs.existsSync(outPath)) {
        fs.mkdirSync(outPath, { recursive: true });
      }

      s.stop("Ready to configure schema generation.");

      // --- NEW interactive step ---
      const forceOptional =
        (await select({
          message: "Should all fields be optional?",
          options: [
            { value: true, label: "Yes, make all fields optional" },
            { value: false, label: "No, keep original optionality" },
          ],
        })) ?? false;

      if (isCancel(forceOptional)) {
        log.error("Cancelled");
        process.exit(0);
      }

      const useCoerceDates = await select({
        message: "How should Date fields be handled?",
        options: [
          {
            value: false,
            label: "As strings (z.string()) — good for DB/API responses",
          },
          {
            value: true,
            label:
              "Coerce into JS Dates (z.coerce.date()) — good for app-level validation",
          },
        ],
      });

      if (isCancel(useCoerceDates)) {
        log.error("Cancelled");
        process.exit(0);
      }

      const s2 = spinner();
      s2.start("Generating Zod schema...");

      await generateSchema(outPath, forceOptional, useCoerceDates);

      s2.stop(
        `Zod schema generated successfully with${
          forceOptional ? " forced optional fields" : " original optionality"
        } and ${
          useCoerceDates
            ? "z.coerce.date() for Date fields"
            : "z.string() for Date fields"
        }.`
      );
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
