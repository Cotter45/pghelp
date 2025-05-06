#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { parse } from "@typescript-eslint/typescript-estree";

import type { TSESTree } from "@typescript-eslint/typescript-estree";

/**
 * Extracts all TSTypeAliasDeclaration nodes from a TypeScript file and returns
 * an object mapping type names to their string representation.
 *
 * @param filePath - The path to the TypeScript file containing type definitions.
 * @returns A record where keys are type names and values are the type definition strings.
 */
function extractTypesFromFile(filePath: string): Record<string, string> {
  const code: string = fs.readFileSync(filePath, "utf8");
  const ast: TSESTree.Program = parse(code, { jsx: false, range: true });

  const types: Record<string, string> = {};

  traverseAST(ast, (node: any) => {
    if (
      node.type === "TSTypeAliasDeclaration" &&
      node.id &&
      node.id.type === "Identifier" &&
      node.range
    ) {
      const typeName: string = node.id.name;
      const typeString: string = code.slice(node.range[0], node.range[1]);
      types[typeName] = typeString;
    }
  });

  return types;
}

/**
 * Recursively traverses an AST, calling the provided callback on each node.
 *
 * @param node - The current AST node.
 * @param callback - A function to call with each node.
 */
function traverseAST(node: any, callback: (node: any) => void): void {
  callback(node);
  for (const key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach((c) => traverseAST(c, callback));
      } else if (typeof child === "object" && child !== null) {
        traverseAST(child, callback);
      }
    }
  }
}

/**
 * Converts a snake_case string to camelCase.
 *
 * @param str - The snake_case string.
 * @returns The camelCase version.
 */
function snakeToCamel(str: string): string {
  return str.replace(/(_\w)/g, (m) => m[1].toUpperCase());
}

/**
 * Generates a set of Zod schemas from a set of TypeScript type definitions.
 *
 * @param types - An object mapping type names to type definitions.
 * @returns A record where keys are type names and values are Zod schema strings.
 */
function generateZodSchemas(
  types: Record<string, string>
): Record<string, string> {
  const zodSchemas: Record<string, string> = {};

  for (const [typeName, typeDef] of Object.entries(types)) {
    // Exclude DatabaseSchema type from generation.
    if (typeName === "DatabaseSchema") continue;

    // Updated regex to capture field name, an optional "?" marker, and full type (which may include spaces and "| null").
    const fieldMatches = typeDef.match(/\s+(\w+)(\?)?:\s+([^;]+);/g);
    const fields =
      fieldMatches
        ?.map((field: string) => {
          const match = field.match(/\s+(\w+)(\?)?:\s+([^;]+);/);
          if (!match) return "";
          const [, fieldName, optionalMarker, fieldTypeRaw] = match;
          // Check for "| null" in the type
          const isNullable = fieldTypeRaw.includes("| null");
          // Remove any "| null" occurrences from the type string
          const cleanedFieldType = fieldTypeRaw
            .replace(/\s*\|\s*null\s*/g, "")
            .trim();
          const baseZodType = mapToZodType(cleanedFieldType);
          let finalZodType = baseZodType;
          if (isNullable) {
            finalZodType += ".nullable()";
          }
          if (optionalMarker) {
            finalZodType += ".optional()";
          }
          return `  ${snakeToCamel(fieldName)}: ${finalZodType}`;
        })
        .filter((f) => f !== "") || [];

    if (fields.length > 0) {
      zodSchemas[typeName] = `z.object({\n${fields.join(",\n")}\n})`;
    }
  }

  return zodSchemas;
}

/**
 * Maps a TypeScript type (as a string) to a base Zod schema definition.
 *
 * @param type - The TypeScript type.
 * @returns A Zod schema as a string (without .optional() or .nullable()).
 */
function mapToZodType(type: string): string {
  const typeMap: Record<string, string> = {
    string: "z.string()",
    number: "z.number()",
    bigint: "z.number()",
    boolean: "z.boolean()",
    "Record<string, unknown>": "z.record(z.unknown())",
    "string[]": "z.array(z.string())",
    "number[]": "z.array(z.number())",
    "boolean[]": "z.array(z.boolean())",
    Date: "z.string()",
    Buffer: "z.instanceof(Buffer)",
    "{x: number, y: number}": "z.object({ x: z.number(), y: z.number() })",
    "{x1: number, y1: number, x2: number, y2: number}":
      "z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })",
    "{x: number, y: number, r: number}":
      "z.object({ x: z.number(), y: z.number(), r: z.number() })",
    "{lower: number, upper: number}":
      "z.object({ lower: z.number(), upper: z.number() })",
    "{lower, upper}": "z.object({ lower: z.string(), upper: z.string() })",
  };

  if (type.includes("Record")) {
    return typeMap["Record<string, unknown>"];
  }

  return typeMap[type] || "z.any()";
}

/**
 * Writes the generated Zod schemas and inferred types to a file.
 *
 * @param zodSchemas - An object mapping type names to Zod schema strings.
 * @param outputPath - The file path to write the schemas.
 */
function writeZodSchemasToFile(
  zodSchemas: Record<string, string>,
  outputPath: string
): void {
  const importZod = `import { z } from "zod";\n\n`;

  const content = Object.entries(zodSchemas)
    .map(
      ([typeName, schema]) =>
        `export const ${typeName.replace("_Type", "")}_Schema = ${schema};`
    )
    .join("\n\n");

  const bufferLines = "\n\n";

  const inferTypeContent = Object.entries(zodSchemas)
    .map(
      ([typeName]) =>
        `export type ${typeName.replace(
          "_",
          ""
        )} = z.infer<typeof ${typeName.replace("_Type", "")}_Schema>;`
    )
    .join("\n");

  fs.writeFileSync(
    outputPath,
    importZod + content + bufferLines + inferTypeContent,
    "utf8"
  );
}

/**
 * Generates Zod schemas by extracting type aliases from a generated types file,
 * converting them into Zod schemas, and writing the output to a new file.
 *
 * @param outPath - The directory where the generated types and schemas reside.
 */
export async function generateSchema(outPath: string): Promise<void> {
  const typesFilePath = path.resolve(outPath, "../types/generated-types.ts");
  const outputFilePath = path.resolve(outPath, "generated-schemas.ts");

  const types = extractTypesFromFile(typesFilePath);
  const zodSchemas = generateZodSchemas(types);

  writeZodSchemasToFile(zodSchemas, outputFilePath);
}

export default generateSchema;
