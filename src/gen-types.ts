#!/usr/bin/env node

import fs from "fs";
import path from "path";

import type { Client } from "pg";
import type { PgUserFunction } from "./types";

// Helper to map Postgres data types (by name) to TypeScript types
function mapPostgresTypeByName(dataType: string): string {
  const typeMap: Record<string, string> = {
    integer: "number",
    bigint: "bigint",
    smallint: "number",
    numeric: "number",
    real: "number",
    "double precision": "number",
    serial: "number",
    bigserial: "bigint",
    smallserial: "number",
    money: "string",
    "character varying": "string",
    varchar: "string",
    character: "string",
    char: "string",
    text: "string",
    bytea: "Buffer",
    timestamp: "Date",
    "timestamp without time zone": "Date",
    "timestamp with time zone": "Date",
    date: "Date",
    time: "string",
    "time without time zone": "string",
    "time with time zone": "string",
    interval: "string",
    boolean: "boolean",
    json: "Record<string, unknown>",
    jsonb: "Record<string, unknown>",
    uuid: "string",
    xml: "string",
    point: "{ x: number, y: number }",
    line: "string",
    lseg: "string",
    box: "string",
    path: "string",
    polygon: "string",
    circle: "{ x: number, y: number, r: number }",
    cidr: "string",
    inet: "string",
    macaddr: "string",
    bit: "string",
    "bit varying": "string",
    tsvector: "string",
    tsquery: "string",
    ARRAY: "any[]",
    unknown: "any",
  };

  return typeMap[dataType] || "any";
}

// Mapping based on Postgres OIDs to TypeScript types
const typeMap: Record<number, string> = {
  // Boolean
  16: "boolean",

  // Numeric
  20: "bigint",
  21: "number",
  23: "number",
  700: "number",
  701: "number",
  1700: "number",

  // String
  18: "string",
  19: "string",
  25: "string",
  1042: "string",
  1043: "string",

  // Date/Time
  1082: "Date",
  1114: "Date",
  1184: "Date",
  1083: "string",
  1266: "string",
  1186: "string",

  // JSON
  114: "Record<string, unknown>",
  3802: "Record<string, unknown>",

  // UUID
  2950: "string",

  // Binary
  17: "Buffer",

  // Arrays
  1000: "boolean[]",
  1001: "Buffer[]",
  1007: "number[]",
  1015: "string[]",
  1115: "Date[]",
  1182: "string[]",
  1231: "number[]",

  // Geometric types
  600: "{ x: number, y: number }",
  601: "{ x1: number, y1: number, x2: number, y2: number }",
  718: "{ x: number, y: number, r: number }",
  603: "unknown",
  604: "unknown",

  // Range Types
  3904: "{ lower: number, upper: number }",
  3912: "{ lower: string, upper: string }",
  3926: "{ lower: bigint, upper: bigint }",

  // Full-text search
  3613: "string",

  // Network types
  869: "string",
  650: "string",
  774: "string",
  829: "string",

  // Miscellaneous
  2278: "null",
  2249: "Record<string, unknown>",
};

function mapPostgresTypeToTsType(oid: number): string {
  return typeMap[oid] || "any";
}

function capitalize(str: string): string {
  return str
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("_");
}

/**
 * Generates TypeScript types for every table in the public schema.
 *
 * @param client - The PostgreSQL client.
 * @param outPath - The directory where the generated file should be saved.
 */
export async function generateTypes(
  client: Client,
  outPath: string
): Promise<void> {
  // Fetch all tables in the public schema
  const tables = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public';
  `);

  let typeDefinitions = "// Auto-generated types from database schema\n";

  for (const row of tables.rows) {
    const tableName = row.table_name;

    // Fetch columns with their data types and OIDs
    const columns = await client.query<{
      column_name: string;
      udt_name: string;
      data_type: string;
      is_nullable: string;
      oid: number;
    }>(`
      SELECT
        column_name,
        udt_name,
        data_type,
        is_nullable,
        a.atttypid AS oid
      FROM
        information_schema.columns
      JOIN pg_attribute a ON a.attname = column_name
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE
        table_name = '${tableName}'
        AND c.relname = '${tableName}';
    `);

    const fields = columns.rows
      .map((col) => {
        const tsType =
          (mapPostgresTypeToTsType(col.oid) ||
            mapPostgresTypeByName(col.data_type)) +
          (col.is_nullable === "YES" ? " | null" : "");
        return `  ${col.column_name}: ${tsType};`;
      })
      .join("\n");

    typeDefinitions += `
export type ${capitalize(tableName)}_Type = {
${fields}
};
    `;
  }

  // Create a DatabaseSchema type that includes every table type.
  typeDefinitions += `
export type DatabaseSchema = {
  ${tables.rows
    .map((row) => `${row.table_name}: ${capitalize(row.table_name)}_Type`)
    .join(";\n  ")}
};
export type DatabaseSchemaKeys = keyof DatabaseSchema;
`;

  const typeFilePath = path.resolve(outPath, "./generated-types.ts");
  fs.writeFileSync(typeFilePath, typeDefinitions, "utf8");
}

/**
 * Generates TypeScript types for every function in the public schema.
 *
 * @param client - The PostgreSQL client.
 * @param outPath - The directory where the generated file should be saved.
 */
export async function generateFunctionTypes(
  client: Client,
  outPath: string
): Promise<void> {
  const functions = await listUserFunctions(client);

  let typeDefinitions = "// Auto-generated types from database functions\n";

  for (const func of functions) {
    const { function_name, args, return_type, returns_set } = func;

    // Parse arguments
    const params = args
      .split(", ")
      .map((arg) => {
        const [paramName, paramType] = arg.split(" ");
        const tsType = mapPostgresTypeByName(paramType);
        return `  ${paramName}: ${tsType};`;
      })
      .join("\n");

    // Parse return type
    const returnTsType = await getReturnTypeFromList(return_type, returns_set);

    // Generate TypeScript types for the function
    typeDefinitions += `
export type ${capitalize(function_name)}_Params = ${
      params.trim() === ""
        ? "never"
        : `{
${params}
};`
    }

export type ${capitalize(function_name)}_Return = ${returnTsType};
    `;
  }

  // Write the generated types to a file
  const outFilePath = path.resolve(outPath, "./generated-function-types.ts");
  fs.writeFileSync(outFilePath, typeDefinitions, "utf8");
}

/**
 * Generates TypeScript functions for every PostgreSQL function in the public schema.
 *
 * @param client - The PostgreSQL client.
 * @param outPath - The directory where the generated file should be saved.
 */
export async function generateTypeSafeFunctions(
  client: Client,
  outPath: string
): Promise<void> {
  const functions = await listUserFunctions(client);

  let functionDefinitions =
    "// Auto-generated TypeScript functions for PostgreSQL\n";

  for (const func of functions) {
    const { function_name, args } = func;

    // Parse arguments
    const params = args
      .split(", ")
      .map((arg, index) => {
        const [_, paramType] = arg.split(" ");
        const tsType = mapPostgresTypeByName(paramType);
        return `param${index + 1}: ${tsType}`;
      })
      .join(", ");

    const paramPlaceholders = args
      .split(", ")
      .map((_, index) => `$${index + 1}`) // Use positional placeholders
      .join(", ");

    // Generate TypeScript function
    functionDefinitions += `
export function ${function_name}(${params}): { sql: string; params: any[] } {
  const sql = \`SELECT * FROM ${function_name}(${paramPlaceholders})\`;
  const paramsArray = [${args
    .split(", ")
    .map((_, index) => `param${index + 1}`)
    .join(", ")}];
  return { sql, params: paramsArray };
}
`;
  }

  // Write the generated functions to a file
  const outFilePath = path.resolve(outPath, "./generated-functions.ts");
  fs.writeFileSync(outFilePath, functionDefinitions, "utf8");
}

function generateQuery(functionName: string, params: string[]): string {
  if (params.length === 0) {
    return `SELECT * FROM ${functionName}()`;
  }

  const paramPlaceholders = params
    .map((param) => `\${params.${param}}`) // Use the actual parameter names
    .join(", ");

  return `SELECT * FROM ${functionName}(${paramPlaceholders})`;
}

async function listUserFunctions(client: Client): Promise<PgUserFunction[]> {
  const { rows } = await client.query(`
    SELECT
      n.nspname   AS schema,
      p.proname   AS function_name,
      pg_catalog.pg_get_function_arguments(p.oid)  AS args,
      CASE
        WHEN t.typtype = 'p' THEN
          pg_catalog.pg_get_function_result(p.oid)
        ELSE
          pg_catalog.format_type(p.prorettype, NULL)
      END AS return_type,
      p.proretset AS returns_set
    FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_type t      ON t.oid = p.prorettype
    WHERE
      n.nspname NOT IN ('pg_catalog','information_schema')
      AND pg_catalog.pg_function_is_visible(p.oid)
    ORDER BY schema, function_name;
  `);
  return rows;
}

async function getReturnTypeFromList(
  returnType: string,
  returnsSet: boolean
): Promise<string> {
  if (returnType.startsWith("TABLE(")) {
    // Extract the columns from the TABLE definition
    const columns = returnType
      .replace("TABLE(", "")
      .replace(")", "")
      .split(", ")
      .map((col) => {
        const [columnName, columnType] = col.split(" ");
        const tsType = mapPostgresTypeByName(columnType);
        return `  ${columnName}: ${tsType};`;
      })
      .join("\n");

    return `{
${columns}
}${returnsSet ? "[]" : ""}`;
  }

  // Handle scalar return types
  const tsType = mapPostgresTypeByName(returnType);
  return returnsSet ? `${tsType}[]` : tsType;
}
