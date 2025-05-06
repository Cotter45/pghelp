#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { red } from "picocolors";

import type { Client } from "pg";
import type { Config } from "./types";

export async function createMigration(
  client: Client,
  migrationName: string,
  config: Config
): Promise<void> {
  if (!migrationName) {
    console.log(red("Migration name is required."));
    process.exit(0);
  }

  // Ensure the migrations table exists.
  const tableCheckResult = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_name = '${config.migrationsTable}'
    )
  `);
  if (!tableCheckResult.rows[0].exists) {
    await client.query(`
      CREATE TABLE ${config.migrationsTable} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  // Query current migration records from the DB.
  const { rows } = await client.query(
    `SELECT * FROM ${config.migrationsTable}`
  );
  const dbCount = rows.length;

  // Compute absolute paths for migrations folder.
  const absPath = path.resolve(config.migrationPath, config.migrationsDir);
  const upDir = path.join(absPath, "up");
  const downDir = path.join(absPath, "down");

  // Create directories if needed.
  if (!fs.existsSync(absPath)) {
    fs.mkdirSync(absPath, { recursive: true });
    fs.mkdirSync(upDir);
    fs.mkdirSync(downDir);
  } else {
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir);
    if (!fs.existsSync(downDir)) fs.mkdirSync(downDir);
  }

  // Count how many migration files already exist in the "up" folder.
  let fileCount = 0;
  if (fs.existsSync(upDir)) {
    const files = fs.readdirSync(upDir).filter((file) => file.endsWith(".sql"));
    fileCount = files.length;
  }

  // Use the greater of the two counts and add 1.
  const migrationNumber = Math.max(dbCount, fileCount) + 1;
  const timestamp = new Date().getTime();
  const sanitizedName = migrationName.replaceAll(" ", "_");
  const migrationFileName = `${migrationNumber}_${sanitizedName}_${timestamp}`;

  const upPath = path.join(upDir, `${migrationFileName}.sql`);
  const downPath = path.join(downDir, `${migrationFileName}.sql`);

  fs.writeFileSync(upPath, "-- Write your migration here");
  fs.writeFileSync(downPath, "-- Write your rollback here");
}
