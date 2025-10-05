#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import type { Client } from "pg";
import type { PgUserFunction } from "./types";

/* ----------------------------------------------
 * Helpers
 * ---------------------------------------------- */

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

const oidMap: Record<number, string> = {
  16: "boolean",
  20: "bigint",
  21: "number",
  23: "number",
  700: "number",
  701: "number",
  1700: "number",
  18: "string",
  19: "string",
  25: "string",
  1042: "string",
  1043: "string",
  1082: "Date",
  1114: "Date",
  1184: "Date",
  1083: "string",
  1266: "string",
  1186: "string",
  114: "Record<string, unknown>",
  3802: "Record<string, unknown>",
  2950: "string",
  17: "Buffer",
  1000: "boolean[]",
  1001: "Buffer[]",
  1007: "number[]",
  1015: "string[]",
  1115: "Date[]",
  1182: "string[]",
  1231: "number[]",
  600: "{ x: number, y: number }",
  601: "{ x1: number, y1: number, x2: number, y2: number }",
  718: "{ x: number, y: number, r: number }",
  3904: "{ lower: number, upper: number }",
  3912: "{ lower: string, upper: string }",
  3926: "{ lower: bigint, upper: bigint }",
  3613: "string",
  869: "string",
  650: "string",
  774: "string",
  829: "string",
  2278: "null",
  2249: "Record<string, unknown>",
};

function mapPostgresTypeToTsType(oid: number): string {
  return oidMap[oid] || "any";
}

/** Convert snake_case → PascalCase */
function pascalCase(str: string): string {
  return str
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/* ----------------------------------------------
 * Core: Generate table types
 * ---------------------------------------------- */
export async function generateTypes(
  client: Client,
  outPath: string,
  schema = "public"
): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1;`,
    [schema]
  );

  let typeDefs = "// Auto-generated types from database schema\n";

  for (const { table_name } of tables.rows) {
    const columns = await client.query<{
      column_name: string;
      udt_name: string;
      data_type: string;
      not_null: boolean;
      description: string | null;
      oid: number;
    }>(
      `
      SELECT
        a.attname AS column_name,
        t.typname AS udt_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnotnull AS not_null,
        col_description(c.oid, a.attnum) AS description,
        a.atttypid AS oid
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_type t ON a.atttypid = t.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped;
    `,
      [schema, table_name]
    );

    const fieldStrings: string[] = [];

    for (const col of columns.rows) {
      let tsType = mapPostgresTypeToTsType(col.oid);
      if (tsType === "any") tsType = mapPostgresTypeByName(col.data_type);

      // Handle array udt names like "_text", "_uuid"
      if (col.udt_name.startsWith("_")) {
        const base = col.udt_name.slice(1);
        tsType = `${mapPostgresTypeByName(base)}[]`;
      }

      // Detect enum types
      const enumRes = await client.query<{ enumlabel: string }>(
        `
        SELECT e.enumlabel
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        WHERE t.typname = $1;
      `,
        [col.udt_name]
      );
      if (enumRes?.rows?.length > 0) {
        const values = enumRes.rows.map((r) => `"${r.enumlabel}"`).join(" | ");
        tsType = values;
      }

      // Nullability
      if (!col.not_null) tsType += " | null";

      // Optional inline JSDoc with description
      const comment = col.description
        ? `  /** ${col.description.trim()} */\n`
        : "";
      fieldStrings.push(`${comment}  ${col.column_name}: ${tsType};`);
    }

    typeDefs += `
export type ${pascalCase(table_name)}_Type = {
${fieldStrings.join("\n")}
};
`;
  }

  // Schema aggregator
  typeDefs += `
export type DatabaseSchema = {
  ${tables.rows
    .map((row) => `${row.table_name}: ${pascalCase(row.table_name)}_Type`)
    .join(";\n  ")}
};
export type DatabaseSchemaKeys = keyof DatabaseSchema;
`;

  const typeFilePath = path.resolve(outPath, "./generated-types.ts");
  await fs.writeFile(typeFilePath, typeDefs, "utf8");
  console.log(`✅ Types written to ${typeFilePath}`);
}

/* ----------------------------------------------
 * Core: Generate function types
 * ---------------------------------------------- */
export async function generateFunctionTypes(
  client: Client,
  outPath: string,
  schema = "public"
): Promise<void> {
  const functions = await listUserFunctions(client, schema);
  let typeDefs = "// Auto-generated types from database functions\n";

  for (const func of functions) {
    const { function_name, args, return_type, returns_set } = func;
    if (return_type === "void") continue;

    const params = args
      .split(", ")
      .map((arg) => {
        const match = arg.match(/^(\w+)\s+(VARIADIC\s+)?(\S+)/);
        const paramName = match?.[1];
        const paramType = match?.[3];
        if (!paramName || !paramType) return null;
        const tsType = mapPostgresTypeByName(paramType);
        return `  ${paramName}: ${tsType};`;
      })
      .filter(Boolean)
      .join("\n");

    const returnTsType = await getReturnTypeFromList(
      client,
      return_type,
      returns_set
    );

    typeDefs += `
export type ${pascalCase(func.function_name)}_Params = ${
      params.trim() === "" ? "never" : `{\n${params}\n}`
    };
export type ${pascalCase(func.function_name)}_Return = ${returnTsType};
`;
  }

  const filePath = path.resolve(outPath, "./generated-function-types.ts");
  await fs.writeFile(filePath, typeDefs, "utf8");
  console.log(`✅ Function types written to ${filePath}`);
}

/* ----------------------------------------------
 * Core: Generate SQL helpers
 * ---------------------------------------------- */
export async function generateTypeSafeFunctions(
  client: Client,
  outPath: string,
  schema = "public"
): Promise<void> {
  const functions = await listUserFunctions(client, schema);
  let defs = "// Auto-generated SQL helpers for PostgreSQL functions\n";

  for (const func of functions) {
    const { function_name, args } = func;
    const argList = args
      .split(", ")
      .map((arg, i) => {
        const match = arg.match(/^(\w+)/);
        const name = match?.[1] || `param${i + 1}`;
        return name;
      })
      .filter(Boolean);

    const paramsDef = argList.map((p) => `${p}: any`).join(", ");
    const placeholders = argList.map((_, i) => `$${i + 1}`).join(", ");

    defs += `
export function ${function_name}(${paramsDef}): { sql: string; params: any[] } {
  const sql = \`SELECT * FROM ${schema}.${function_name}(${placeholders})\`;
  const params = [${argList.join(", ")}];
  return { sql, params };
}
`;
  }

  const filePath = path.resolve(outPath, "./generated-functions.ts");
  await fs.writeFile(filePath, defs, "utf8");
  console.log(`✅ SQL helpers written to ${filePath}`);
}

/* ----------------------------------------------
 * Utility helpers
 * ---------------------------------------------- */
async function listUserFunctions(
  client: Client,
  schema = "public"
): Promise<PgUserFunction[]> {
  const { rows } = await client.query(`
    SELECT
      n.nspname   AS schema,
      p.proname   AS function_name,
      pg_catalog.pg_get_function_arguments(p.oid)  AS args,
      pg_catalog.pg_get_function_result(p.oid)     AS return_type,
      p.proretset AS returns_set
    FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = '${schema}'
      AND pg_catalog.pg_function_is_visible(p.oid)
    ORDER BY schema, function_name;
  `);
  return rows;
}

async function getReturnTypeFromList(
  client: Client,
  returnType: string,
  returnsSet: boolean
): Promise<string> {
  if (returnType.startsWith("TABLE(")) {
    const columns = returnType
      .replace(/^TABLE\(/, "")
      .replace(/\)$/, "")
      .split(", ")
      .map((col) => {
        const [name, type] = col.split(" ");
        const tsType = mapPostgresTypeByName(type);
        return `  ${name}: ${tsType};`;
      })
      .join("\n");
    return `{\n${columns}\n}${returnsSet ? "[]" : ""}`;
  }

  const tsType = mapPostgresTypeByName(returnType);
  return returnsSet ? `${tsType}[]` : tsType;
}
