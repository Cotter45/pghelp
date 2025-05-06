#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { red } from "picocolors";

import type { Client } from "pg";
import type { Config } from "./types";

export async function runMigrations(
  client: Client,
  direction: "up" | "down",
  config: Config,
  numberOfMigrations: number = 1
): Promise<void> {
  const absPath = path.resolve(config.migrationPath, config.migrationsDir);
  const upDir = path.join(absPath, "up");
  const downDir = path.join(absPath, "down");

  // Ensure the migrations table exists
  const tableCheck = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_name = '${config.migrationsTable}'
    )
  `);
  if (!tableCheck.rows[0].exists) {
    await client.query(`
      CREATE TABLE ${config.migrationsTable} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  const appliedRes = await client.query<{ name: string }>(
    `SELECT name FROM ${config.migrationsTable} ORDER BY id`
  );
  const applied = new Set(appliedRes.rows.map((row) => row.name));

  let migrationFiles = fs
    .readdirSync(direction === "up" ? upDir : downDir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => file.replace(".sql", ""))
    .sort((a, b) => {
      const aNum = Number(a.split("_")[0]);
      const bNum = Number(b.split("_")[0]);
      return aNum - bNum;
    });

  if (direction === "down") {
    migrationFiles = migrationFiles.reverse().slice(0, numberOfMigrations);
  }

  for (const fileName of migrationFiles) {
    const shouldRun =
      (direction === "up" && !applied.has(fileName)) ||
      (direction === "down" && applied.has(fileName));

    if (shouldRun) {
      const filePath = path.join(
        direction === "up" ? upDir : downDir,
        `${fileName}.sql`
      );
      const sql = fs.readFileSync(filePath, "utf8");

      try {
        await client.query("BEGIN");
        await client.query(sql);
        if (direction === "up") {
          await client.query(
            `INSERT INTO ${config.migrationsTable} (name) VALUES ($1)`,
            [fileName]
          );
        } else {
          await client.query(
            `DELETE FROM ${config.migrationsTable} WHERE name = $1`,
            [fileName]
          );
        }
        await client.query("COMMIT");
      } catch (error: any) {
        await client.query("ROLLBACK");
        console.error(
          red(`Failed to run migration "${fileName}": ${error.message}`)
        );
        throw error;
      }
    }
  }
}
