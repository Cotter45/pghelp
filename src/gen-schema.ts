#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { parse } from "@typescript-eslint/typescript-estree";
import type { TSESTree } from "@typescript-eslint/typescript-estree";

/**
 * Extracts all TSTypeAliasDeclaration nodes from a TypeScript file and returns
 * an object mapping type names to their string representation.
 */
function extractTypesFromFile(filePath: string): Record<string, string> {
  const code: string = fs.readFileSync(filePath, "utf8");
  const ast: TSESTree.Program = parse(code, { jsx: false, range: true });

  const types: Record<string, string> = {};
  traverseAST(ast, (node: any) => {
    if (
      node.type === "TSTypeAliasDeclaration" &&
      node.id?.type === "Identifier" &&
      node.range
    ) {
      const typeName = node.id.name;
      const typeString = code.slice(node.range[0], node.range[1]);
      types[typeName] = typeString;
    }
  });

  return types;
}

/**
 * Recursively traverses an AST and applies a callback to each node.
 */
function traverseAST(node: any, callback: (node: any) => void): void {
  callback(node);
  for (const key in node) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const child = (node as any)[key];
    if (Array.isArray(child)) {
      for (const c of child) traverseAST(c, callback);
    } else if (child && typeof child === "object") {
      traverseAST(child, callback);
    }
  }
}

/**
 * Return the main object literal body of a type alias like:
 *   type X = { ... };
 * Finds the first "{" after "=" and returns the substring between its
 * matching "}" (top-level balanced).
 */
function getTypeObjectBody(typeDef: string): string | null {
  const eqIdx = typeDef.indexOf("=");
  if (eqIdx === -1) return null;

  // Find first top-level '{' after '='
  let i = eqIdx + 1;
  while (i < typeDef.length && typeDef[i] !== "{") i++;
  if (i >= typeDef.length) return null;

  let start = i;
  let depth = 0;
  for (; i < typeDef.length; i++) {
    const ch = typeDef[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // Include braces in return
        return typeDef.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extract fields from an object type body string like "{ a: string; b?: number; }"
 * Handles nested braces/brackets/angles/parentheses and splits fields on top-level semicolons.
 */
function extractFieldsFromObjectBody(body: string): Array<{
  name: string;
  optional: boolean;
  type: string;
}> {
  // strip outer braces if present
  body = body.trim();
  if (body.startsWith("{") && body.endsWith("}")) {
    body = body.slice(1, -1);
  }

  const fields: string[] = [];
  let current = "";
  let depthCurly = 0;
  let depthAngle = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  let prev = "";

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    // string literal guards
    if (!inDouble && !inBack && ch === "'" && prev !== "\\")
      inSingle = !inSingle;
    else if (!inSingle && !inBack && ch === '"' && prev !== "\\")
      inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`" && prev !== "\\")
      inBack = !inBack;

    if (!inSingle && !inDouble && !inBack) {
      if (ch === "{") depthCurly++;
      else if (ch === "}") depthCurly--;
      else if (ch === "<") depthAngle++;
      else if (ch === ">") depthAngle--;
      else if (ch === "(") depthParen++;
      else if (ch === ")") depthParen--;
      else if (ch === "[") depthBracket++;
      else if (ch === "]") depthBracket--;

      // split on semicolon only when at top-level in the object
      if (
        ch === ";" &&
        depthCurly === 0 &&
        depthAngle === 0 &&
        depthParen === 0 &&
        depthBracket === 0
      ) {
        const trimmed = current.trim();
        if (trimmed) fields.push(trimmed);
        current = "";
        prev = ch;
        continue;
      }
    }

    current += ch;
    prev = ch;
  }

  const tail = current.trim();
  if (tail) fields.push(tail);

  // Now parse "name?: type" from each field
  const parsed = [];
  for (const f of fields) {
    const m = f.match(/^\s*(\w+)(\?)?\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    const [, name, opt, t] = m;
    parsed.push({
      name,
      optional: Boolean(opt),
      type: t.trim(),
    });
  }
  return parsed;
}

/** Split by a delimiter at top-level (not inside <>, {}, (), [] or string literals). */
function splitTopLevel(input: string, delimiter: string): string[] {
  const out: string[] = [];
  let part = "";
  let depthCurly = 0,
    depthAngle = 0,
    depthParen = 0,
    depthBracket = 0;
  let inSingle = false,
    inDouble = false,
    inBack = false;
  let prev = "";

  function atTop(): boolean {
    return (
      depthCurly === 0 &&
      depthAngle === 0 &&
      depthParen === 0 &&
      depthBracket === 0 &&
      !inSingle &&
      !inDouble &&
      !inBack
    );
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    // handle string states
    if (!inDouble && !inBack && ch === "'" && prev !== "\\")
      inSingle = !inSingle;
    else if (!inSingle && !inBack && ch === '"' && prev !== "\\")
      inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`" && prev !== "\\")
      inBack = !inBack;

    if (!inSingle && !inDouble && !inBack) {
      if (ch === "{") depthCurly++;
      else if (ch === "}") depthCurly--;
      else if (ch === "<") depthAngle++;
      else if (ch === ">") depthAngle--;
      else if (ch === "(") depthParen++;
      else if (ch === ")") depthParen--;
      else if (ch === "[") depthBracket++;
      else if (ch === "]") depthBracket--;
    }

    if (atTop() && input.slice(i, i + delimiter.length) === delimiter) {
      out.push(part.trim());
      part = "";
      i += delimiter.length - 1;
      prev = ch;
      continue;
    }

    part += ch;
    prev = ch;
  }
  if (part.trim()) out.push(part.trim());
  return out;
}

/**
 * Generates a set of Zod schemas from TypeScript type definitions.
 */
function generateZodSchemas(
  types: Record<string, string>,
  forceOptional = false,
  useCoerceDates = false,
  addDefaultNull = false
): Record<string, string> {
  const zodSchemas: Record<string, string> = {};

  // Build a quick set of known type names for linking
  const knownTypeNames = new Set(Object.keys(types));

  for (const [typeName, typeDef] of Object.entries(types)) {
    if (typeName === "DatabaseSchema") continue;

    const objBody = getTypeObjectBody(typeDef);
    if (!objBody) continue;

    const fields = extractFieldsFromObjectBody(objBody);
    if (!fields.length) continue;

    const zFields: string[] = [];

    for (const f of fields) {
      // Optional vs Nullable handling
      const isNullable = /\|\s*null\b/.test(f.type);
      const cleaned = f.type.replace(/\|\s*null\b/g, "").trim();

      const base = mapToZodType(cleaned, knownTypeNames, useCoerceDates);
      let finalType = base;
      if (isNullable) {
        finalType += ".nullable()";
        if (addDefaultNull) finalType += ".default(null)";
      }
      if (f.optional || forceOptional) finalType += ".optional()";

      zFields.push(`  ${f.name}: ${finalType}`);
    }

    zodSchemas[typeName] = `z.object({\n${zFields.join(",\n")}\n})`;
  }

  return zodSchemas;
}

/**
 * Maps TypeScript type (string) to Zod schema (string), recursively.
 * Supports:
 *  - primitives (string, number, boolean, bigint)
 *  - Date -> z.coerce.date()
 *  - unknown, any
 *  - arrays: T[] and Array<T>
 *  - Record<K,V>
 *  - unions (including literal-only to z.enum)
 *  - type references (links to *_Schema if known)
 */
function mapToZodType(
  type: string,
  knownTypeNames: Set<string>,
  useCoerceDates = false
): string {
  let t = type.trim();

  // Strip parens around types like `(string | number)`
  if (t.startsWith("(") && t.endsWith(")")) {
    // only strip if balanced and top-level pair
    const inner = t.slice(1, -1);
    if (splitTopLevel(inner, "|").length > 0) t = inner.trim();
  }

  // Handle unions
  if (t.includes("|")) {
    const parts = splitTopLevel(t, "|")
      .map((p) => p.trim())
      .filter(Boolean);

    // Detect all-string-literal union -> z.enum([...])
    const allStringLiterals = parts.every((p) => /^(['"]).*\1$/.test(p));
    if (allStringLiterals) {
      const values = parts.map((p) => p.slice(1, -1));
      return `z.enum([${values.map((v) => JSON.stringify(v)).join(", ")}])`;
    }

    // Otherwise, build z.union([...])
    const mapped = parts.map((p) => mapToZodType(p, knownTypeNames));
    return `z.union([${mapped.join(", ")}])`;
  }

  // Null alone (should be stripped before) but be safe
  if (/^null$/.test(t)) return "z.null()";

  // Literals
  if (/^(['"]).*\1$/.test(t)) {
    return `z.literal(${t})`;
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return `z.literal(${t})`;
  }
  if (/^(true|false)$/.test(t)) {
    return `z.literal(${t})`;
  }

  // Arrays: T[] (top-level)
  if (/\[\]$/.test(t)) {
    const inner = t.slice(0, -2).trim();
    return `z.array(${mapToZodType(inner, knownTypeNames)})`;
  }

  // Arrays: Array<T>
  const arrayMatch = t.match(/^Array\s*<([\s\S]+)>$/);
  if (arrayMatch) {
    const inner = arrayMatch[1].trim();
    return `z.array(${mapToZodType(inner, knownTypeNames)})`;
  }

  // Record<K, V>
  const recordMatch = t.match(/^Record\s*<([\s\S]+)>$/);
  if (recordMatch) {
    const inner = recordMatch[1].trim();
    const kv = splitTopLevel(inner, ",");
    if (kv.length === 2) {
      const key = kv[0].trim();
      const val = kv[1].trim();
      // Key in Zod must be string/number/symbol; TS Record typically string | number
      const zKey =
        key === "string"
          ? "z.string()"
          : key === "number"
          ? "z.number()"
          : "z.string()"; // fallback
      return `z.record(${zKey}, ${mapToZodType(val, knownTypeNames)})`;
    }
    // Fallback
    return `z.record(z.string(), z.unknown())`;
  }

  // Inline object literal -> allow passthrough (we are not deeply parsing nested fields here)
  if (t.startsWith("{") && t.endsWith("}")) {
    // Minimal: accept arbitrary keys
    return "z.object({}).passthrough()";
  }

  // Known type reference linking (User_Type -> User_Schema)
  if (knownTypeNames.has(t)) {
    return `${t.replace(/_Type$/, "")}_Schema`;
  }

  // Common primitives & special cases
  switch (t) {
    case "string":
      return "z.string()";
    case "number":
      return "z.number()";
    case "bigint":
      // Store bigints as strings for JSON compatibility
      return "z.string().refine(v => /^-?\\d+$/.test(v), { message: 'Invalid bigint string' })";
    case "boolean":
      return "z.boolean()";
    case "Date":
      return useCoerceDates ? "z.coerce.date()" : "z.string()";
    case "Buffer":
      return "z.instanceof(Buffer)";
    case "unknown":
      return "z.unknown()";
    case "any":
      return "z.any()";
    case "never":
      return "z.never()";
    case "void":
      return "z.void()";
    default:
      break;
  }

  // Generic T<X, Y> (not handled above) -> z.any() fallback
  if (/^[A-Za-z0-9_]+\s*<[\s\S]+>$/.test(t)) {
    return "z.any()";
  }

  // Fallback
  return "z.any()";
}

/**
 * Writes generated Zod schemas and inferred types to a file.
 * Adds schema prefix to differentiate between identical names across schemas.
 */
function writeZodSchemasToFile(
  zodSchemas: Record<string, string>,
  outputPath: string,
  schemaName?: string
): void {
  const importZod = `import { z } from "zod";\n\n`;
  const suffix = schemaName ? `_${schemaName}` : "";

  const schemas = Object.entries(zodSchemas)
    .map(([typeName, schema]) => {
      const baseName = typeName.replace(/_Type$/, "");
      const schemaConst = `${baseName}${suffix}_Schema`;
      return `export const ${schemaConst} = ${schema};`;
    })
    .join("\n\n");

  const inferred = Object.keys(zodSchemas)
    .map((typeName) => {
      const baseName = typeName.replace(/_Type$/, "");
      const schemaConst = `${baseName}${suffix}_Schema`;
      const typeNameWithSuffix = `${baseName}${suffix}`;
      return `export type ${typeNameWithSuffix} = z.infer<typeof ${schemaConst}>;`;
    })
    .join("\n");

  fs.writeFileSync(
    outputPath,
    importZod + schemas + "\n\n" + inferred + "\n",
    "utf8"
  );
}

/**
 * Orchestrates extraction, conversion, and output of Zod schemas.
 */
export async function generateSchema(
  outPath: string,
  forceOptional = false,
  useCoerceDates = false,
  addDefaultNull = false,
  schemas: string[] = ["public"]
): Promise<void> {
  for (const schema of schemas) {
    const typesDir =
      schemas.length > 1
        ? path.resolve(outPath, `../types/${schema}`)
        : path.resolve(outPath, "../types");

    const typesFilePath = path.join(typesDir, "generated-types.ts");
    if (!fs.existsSync(typesFilePath)) {
      console.warn(
        `⚠️  No types found for schema "${schema}" at ${typesFilePath}`
      );
      continue;
    }

    const schemaOutDir =
      schemas.length > 1 ? path.join(outPath, schema) : outPath;
    fs.mkdirSync(schemaOutDir, { recursive: true });

    const outputFilePath = path.join(schemaOutDir, "generated-schemas.ts");

    console.log(`🧩 Generating Zod schemas for "${schema}"...`);

    const types = extractTypesFromFile(typesFilePath);
    const zodSchemas = generateZodSchemas(
      types,
      forceOptional,
      useCoerceDates,
      addDefaultNull
    );
    writeZodSchemasToFile(zodSchemas, outputFilePath);

    console.log(
      `✅ Wrote ${Object.keys(zodSchemas).length} schemas → ${outputFilePath}`
    );
  }
}

/**
 * Generates an index.ts that exports all schema files.
 * Example output for multiple schemas:
 *   export * from "./us/generated-schemas";
 *   export * from "./canada/generated-schemas";
 */
export async function generateSchemaIndex(
  schemaRoot: string,
  schemas: string[]
): Promise<void> {
  const lines: string[] = [];

  for (const schema of schemas) {
    const subdir =
      schemas.length > 1
        ? `./${schema}/generated-schemas`
        : `./generated-schemas`;
    lines.push(`export * from "${subdir}";`);
  }

  const outFile = path.join(schemaRoot, "index.ts");
  fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
  console.log(`📦 Wrote schema index → ${outFile}`);
}

export default generateSchema;
