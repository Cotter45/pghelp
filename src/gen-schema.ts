#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { Project, ts, Type, Symbol as MorphSymbol } from "ts-morph";

/* ----------------------------------------------
 * Zod Mapper (ts-morph-based)
 * ---------------------------------------------- */

function mapTypeToZod(t: Type | undefined, depth = 0): string {
  if (!t) return "z.unknown()";

  // ✅ Literal types
  if (t.isStringLiteral?.())
    return `z.literal(${JSON.stringify(t.getLiteralValue())})`;
  if (t.isNumberLiteral?.()) return `z.literal(${t.getLiteralValue()})`;

  // ✅ Union types
  if (t.isUnion?.()) {
    const parts = t.getUnionTypes();
    const nonNullParts = parts.filter(
      (x) => !x.isNull?.() && !x.isUndefined?.()
    );

    // Handle boolean | null | undefined
    const hasBool = parts.some((x) => {
      const txt = x.getText();
      return txt === "boolean" || txt === "true" || txt === "false";
    });
    if (hasBool && parts.length <= 3) {
      return "z.boolean().nullable()";
    }

    // Collapse T | null | undefined
    if (nonNullParts.length === 1) {
      const inner = mapTypeToZod(nonNullParts[0], depth + 1);
      // just mark nullable, don't add .default(null) here
      return `${inner}.nullable()`;
    }

    // ✅ Literal unions → prefer z.enum([...]) if all are literal values
    const literalValues = parts
      .map((x) =>
        x.isStringLiteral?.() || x.isNumberLiteral?.()
          ? x.getLiteralValue()
          : undefined
      )
      .filter((v) => v !== undefined);

    // Allow null/undefined/unknown in union but still treat as enum
    const allLiterals =
      literalValues.length > 0 &&
      parts.every(
        (x) =>
          x.isStringLiteral?.() ||
          x.isNumberLiteral?.() ||
          x.isNull?.() ||
          x.isUndefined?.() ||
          x.getText() === "unknown"
      );

    if (allLiterals) {
      const joined = literalValues.map((v) => JSON.stringify(v)).join(", ");
      // still allow nullable() if null present
      const nullable = parts.some((x) => x.isNull?.());
      return nullable
        ? `z.enum([${joined}]).nullable()`
        : `z.enum([${joined}])`;
    }

    // General union
    return `z.union([${parts
      .map((x) => mapTypeToZod(x, depth + 1))
      .join(", ")}])`;
  }

  // ✅ Arrays
  if (t.isArray?.()) {
    const elem = t.getArrayElementType();
    return `z.array(${mapTypeToZod(elem, depth + 1)})`;
  }

  // ✅ Primitives
  const text = t.getText?.() || "";
  if (text === "Date") return "z.string().datetime()";
  if (text === "string") return "z.string()";
  if (text === "number") return "z.number()";
  if (text === "boolean") return "z.boolean()";

  // ✅ Record<K, V>
  if (text.startsWith("Record<")) {
    const typeArgs = t.getTypeArguments?.() || [];
    const valType = typeArgs[1] || typeArgs[0];
    return `z.record(z.string(), ${mapTypeToZod(valType, depth + 1)})`;
  }

  // ✅ Object types
  if (t.isObject?.() && !t.isArray?.() && !t.isTuple?.()) {
    const props = t.getProperties?.() || [];
    const fields = props.map((p: MorphSymbol) => {
      const name = p.getName();
      const decl = p.getValueDeclaration?.() || p.getDeclarations?.()[0];
      const propType: Type | undefined = decl
        ? p.getTypeAtLocation(decl)
        : p.getDeclaredType?.();

      const isOptional = p.hasFlags?.(ts.SymbolFlags.Optional);
      let zType = mapTypeToZod(propType, depth + 1);

      // Nullable detection
      const isNullable =
        propType?.isNullable?.() ||
        (propType?.isUnion?.() &&
          propType.getUnionTypes().some((u: Type) => u.isNull?.()));

      // prevent double nullable — skip if already ends with ".nullable()"
      if (isNullable && !zType.endsWith(".nullable()")) {
        zType += ".nullable().default(null)";
      }
      if (isOptional) zType += ".optional()";

      return `  ${JSON.stringify(name)}: ${zType}`;
    });

    if (fields.length === 0) return "z.object({}).passthrough()";
    return `z.object({\n${fields.join(",\n")}\n})`;
  }

  // Fallback
  return "z.unknown()";
}

/* ----------------------------------------------
 * Zod Schema Generator (per file)
 * ---------------------------------------------- */

function generateZodFromFile(filePath: string, outFile: string): void {
  const project = new Project({ tsConfigFilePath: "./tsconfig.json" });
  const source = project.addSourceFileAtPath(filePath);
  const typeAliases = source.getTypeAliases();

  if (typeAliases.length === 0) {
    console.warn(`⚠️ No type aliases found in ${filePath}`);
    return;
  }

  const output: string[] = [`import { z } from "zod";`, ""];
  for (const alias of typeAliases) {
    const name = alias.getName();

    // 🚫 Skip meta schemas
    if (name.startsWith("DatabaseSchema")) continue;

    const type = alias.getType();
    const schemaName = name.replace(/_Type$/, "");
    const zodExpr = mapTypeToZod(type);

    output.push(`export const ${schemaName}_Schema = ${zodExpr};`);
    output.push(
      `export type ${schemaName} = z.infer<typeof ${schemaName}_Schema>;`
    );
    output.push("");
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output.join("\n"), "utf8");
  console.log(`✅ Generated Zod schemas → ${outFile}`);
}

/* ----------------------------------------------
 * Multi-schema Orchestration
 * ---------------------------------------------- */

export async function generateSchema(
  outPath: string,
  _forceOptional = false,
  _useCoerceDates = false,
  _addDefaultNull = false,
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
        `⚠️ No types found for schema "${schema}" at ${typesFilePath}`
      );
      continue;
    }

    const schemaOutDir =
      schemas.length > 1 ? path.join(outPath, schema) : outPath;
    const outputFilePath = path.join(schemaOutDir, "generated-schemas.ts");
    fs.mkdirSync(schemaOutDir, { recursive: true });

    console.log(`🧩 Generating Zod schemas for "${schema}"...`);
    try {
      generateZodFromFile(typesFilePath, outputFilePath);
    } catch (err) {
      console.error(`❌ Failed to generate Zod schema for "${schema}":`, err);
    }
  }
}

/* ----------------------------------------------
 * Index Generator
 * ---------------------------------------------- */

export async function generateSchemaIndex(
  root: string,
  schemas: string[]
): Promise<void> {
  const lines = schemas.map((s) =>
    schemas.length > 1
      ? `export * from "./${s}/generated-schemas";`
      : `export * from "./generated-schemas";`
  );
  const outFile = path.join(root, "index.ts");
  fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
  console.log(`📦 Wrote schema index → ${outFile}`);
}

export default generateSchema;
