import { log, spinner } from "@clack/prompts";
import { Client } from "pg";

/**
 * Pads and formats side-by-side diff output for clarity.
 */
function formatSideBySide(
  baseLabel: string,
  baseVal: string,
  targetLabel: string,
  targetVal: string
): string {
  const pad = Math.max(baseLabel.length, targetLabel.length) + 2;
  const padLabel = (l: string) => l.padEnd(pad);
  return `\n      ${padLabel(baseLabel)}| ${baseVal}\n      ${padLabel(
    targetLabel
  )}| ${targetVal}`;
}

/**
 * Normalizes schema-qualified or sequence-specific names
 * so identical structures across schemas don't produce false positives.
 */
function normalizeForComparison(text: string): string {
  if (!text) return "";
  return (
    text
      // Remove schema prefixes from nextval() calls
      .replace(/nextval\('.*?\.(.*?)'::regclass\)/g, "nextval('$1'::regclass)")
      // Remove schema-qualified identifiers (e.g. canada.users -> users)
      .replace(/\b[a-zA-Z0-9_]+\./g, "")
      // Normalize whitespace
      .replace(/\s+/g, " ")
      // Remove trailing semicolons and spaces
      .replace(/;$/, "")
      .trim()
  );
}

/**
 * Compares tables, columns, constraints, indexes, views, sequences,
 * functions, and triggers across configured schemas.
 */
export async function verifySchemas(
  client: Client,
  schemas: string[]
): Promise<void> {
  if (schemas.length < 2) {
    log.info("Only one schema configured — nothing to verify.");
    return;
  }

  const s = spinner();
  s.start(`Verifying schema drift across [${schemas.join(", ")}]...`);

  try {
    const baseSchema = schemas[0];
    const diffs: Record<string, string[]> = {};

    const tableQuery = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `;
    const { rows: baseTables } = await client.query(tableQuery, [baseSchema]);
    const baseTableNames = baseTables.map((r) => r.table_name);

    for (const schema of schemas.slice(1)) {
      const { rows: compareTables } = await client.query(tableQuery, [schema]);
      const compareTableNames = compareTables.map((r) => r.table_name);
      const schemaDiffs: string[] = [];

      // --- TABLES ---
      for (const t of baseTableNames) {
        if (!compareTableNames.includes(t))
          schemaDiffs.push(`🟥 Missing table: ${t}`);
      }
      for (const t of compareTableNames) {
        if (!baseTableNames.includes(t))
          schemaDiffs.push(`🟩 Extra table: ${t}`);
      }

      // --- COLUMNS ---
      const colQuery = `
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = $1
        ORDER BY table_name, ordinal_position;
      `;
      const { rows: baseCols } = await client.query(colQuery, [baseSchema]);
      const { rows: compareCols } = await client.query(colQuery, [schema]);

      const baseColMap = new Map(
        baseCols.map((r) => [
          `${r.table_name}.${r.column_name}`,
          normalizeForComparison(
            `${r.data_type} ${
              r.is_nullable === "NO" ? "NOT NULL" : "NULL"
            } default=${r.column_default ?? "null"}`
          ),
        ])
      );
      const compareColMap = new Map(
        compareCols.map((r) => [
          `${r.table_name}.${r.column_name}`,
          normalizeForComparison(
            `${r.data_type} ${
              r.is_nullable === "NO" ? "NOT NULL" : "NULL"
            } default=${r.column_default ?? "null"}`
          ),
        ])
      );

      for (const [key, baseVal] of baseColMap.entries()) {
        const targetVal = compareColMap.get(key);
        if (!targetVal) {
          schemaDiffs.push(`🟥 Missing column: ${key}`);
        } else if (targetVal !== baseVal) {
          schemaDiffs.push(
            `🟨 Column differs: ${key}${formatSideBySide(
              baseSchema,
              baseVal,
              schema,
              targetVal
            )}`
          );
        }
      }
      for (const key of compareColMap.keys()) {
        if (!baseColMap.has(key)) schemaDiffs.push(`🟩 Extra column: ${key}`);
      }

      // --- CONSTRAINTS ---
      const constraintQuery = `
        SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
               kcu.column_name, ccu.table_name AS foreign_table,
               ccu.column_name AS foreign_column
        FROM information_schema.table_constraints AS tc
        LEFT JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        LEFT JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema = $1
        ORDER BY tc.table_name, tc.constraint_name;
      `;
      const { rows: baseCons } = await client.query(constraintQuery, [
        baseSchema,
      ]);
      const { rows: compareCons } = await client.query(constraintQuery, [
        schema,
      ]);

      const normalizeConstraint = (r: any) =>
        normalizeForComparison(
          `${r.table_name}.${r.constraint_name}:${r.constraint_type}:${
            r.column_name || ""
          }->${r.foreign_table || ""}.${r.foreign_column || ""}`
        );

      const baseConsSet = new Set(baseCons.map(normalizeConstraint));
      const compareConsSet = new Set(compareCons.map(normalizeConstraint));

      for (const c of baseConsSet) {
        if (!compareConsSet.has(c))
          schemaDiffs.push(`🟥 Missing constraint: ${c}`);
      }
      for (const c of compareConsSet) {
        if (!baseConsSet.has(c)) schemaDiffs.push(`🟩 Extra constraint: ${c}`);
      }

      // --- INDEXES ---
      const indexQuery = `
        SELECT t.relname AS table_name,
               i.relname AS index_name,
               pg_get_indexdef(ix.indexrelid) AS index_def
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1
        ORDER BY t.relname, i.relname;
      `;
      const { rows: baseIdx } = await client.query(indexQuery, [baseSchema]);
      const { rows: compareIdx } = await client.query(indexQuery, [schema]);

      const baseIdxMap = new Map(
        baseIdx.map((r) => [
          `${r.table_name}.${r.index_name}`,
          normalizeForComparison(r.index_def),
        ])
      );
      const compareIdxMap = new Map(
        compareIdx.map((r) => [
          `${r.table_name}.${r.index_name}`,
          normalizeForComparison(r.index_def),
        ])
      );

      for (const [key, baseVal] of baseIdxMap.entries()) {
        const targetVal = compareIdxMap.get(key);
        if (!targetVal) {
          schemaDiffs.push(`🟥 Missing index: ${key}`);
        } else if (targetVal !== baseVal) {
          schemaDiffs.push(
            `🟨 Index differs: ${key}${formatSideBySide(
              baseSchema,
              baseVal,
              schema,
              targetVal
            )}`
          );
        }
      }
      for (const key of compareIdxMap.keys()) {
        if (!baseIdxMap.has(key)) schemaDiffs.push(`🟩 Extra index: ${key}`);
      }

      // --- VIEWS ---
      const viewQuery = `
        SELECT table_name, view_definition
        FROM information_schema.views
        WHERE table_schema = $1
        ORDER BY table_name;
      `;
      const { rows: baseViews } = await client.query(viewQuery, [baseSchema]);
      const { rows: compareViews } = await client.query(viewQuery, [schema]);

      const baseViewMap = new Map(
        baseViews.map((r) => [
          r.table_name,
          normalizeForComparison(r.view_definition),
        ])
      );
      const compareViewMap = new Map(
        compareViews.map((r) => [
          r.table_name,
          normalizeForComparison(r.view_definition),
        ])
      );

      for (const [name, def] of baseViewMap.entries()) {
        if (!compareViewMap.has(name))
          schemaDiffs.push(`🟥 Missing view: ${name}`);
        else if (compareViewMap.get(name) !== def)
          schemaDiffs.push(
            `🟨 View differs: ${name}${formatSideBySide(
              baseSchema,
              def,
              schema,
              compareViewMap.get(name)!
            )}`
          );
      }
      for (const name of compareViewMap.keys()) {
        if (!baseViewMap.has(name)) schemaDiffs.push(`🟩 Extra view: ${name}`);
      }

      // --- SEQUENCES ---
      const seqQuery = `
        SELECT sequence_name, data_type, start_value, minimum_value, maximum_value, increment, cycle_option
        FROM information_schema.sequences
        WHERE sequence_schema = $1
        ORDER BY sequence_name;
      `;
      const { rows: baseSeq } = await client.query(seqQuery, [baseSchema]);
      const { rows: compareSeq } = await client.query(seqQuery, [schema]);

      const baseSeqMap = new Map(
        baseSeq.map((r) => [r.sequence_name, JSON.stringify(r)])
      );
      const compareSeqMap = new Map(
        compareSeq.map((r) => [r.sequence_name, JSON.stringify(r)])
      );

      for (const [name, def] of baseSeqMap.entries()) {
        if (!compareSeqMap.has(name))
          schemaDiffs.push(`🟥 Missing sequence: ${name}`);
        else if (compareSeqMap.get(name) !== def)
          schemaDiffs.push(`🟨 Sequence differs: ${name}`);
      }
      for (const name of compareSeqMap.keys()) {
        if (!baseSeqMap.has(name))
          schemaDiffs.push(`🟩 Extra sequence: ${name}`);
      }

      // --- FUNCTIONS ---
      const funcQuery = `
        SELECT p.proname AS function_name, pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
        ORDER BY p.proname;
      `;
      const { rows: baseFuncs } = await client.query(funcQuery, [baseSchema]);
      const { rows: compareFuncs } = await client.query(funcQuery, [schema]);

      const baseFuncMap = new Map(
        baseFuncs.map((r) => [
          r.function_name,
          normalizeForComparison(r.definition),
        ])
      );
      const compareFuncMap = new Map(
        compareFuncs.map((r) => [
          r.function_name,
          normalizeForComparison(r.definition),
        ])
      );

      for (const [name, def] of baseFuncMap.entries()) {
        if (!compareFuncMap.has(name))
          schemaDiffs.push(`🟥 Missing function: ${name}`);
        else if (compareFuncMap.get(name) !== def)
          schemaDiffs.push(
            `🟨 Function differs: ${name}${formatSideBySide(
              baseSchema,
              def,
              schema,
              compareFuncMap.get(name)!
            )}`
          );
      }
      for (const name of compareFuncMap.keys()) {
        if (!baseFuncMap.has(name))
          schemaDiffs.push(`🟩 Extra function: ${name}`);
      }

      // --- TRIGGERS ---
      const trigQuery = `
        SELECT tgname AS trigger_name, pg_get_triggerdef(oid) AS trigger_def
        FROM pg_trigger
        WHERE tgrelid IN (
          SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
        )
        AND NOT tgisinternal
        ORDER BY tgname;
      `;
      const { rows: baseTrigs } = await client.query(trigQuery, [baseSchema]);
      const { rows: compareTrigs } = await client.query(trigQuery, [schema]);

      const baseTrigMap = new Map(
        baseTrigs.map((r) => [
          r.trigger_name,
          normalizeForComparison(r.trigger_def),
        ])
      );
      const compareTrigMap = new Map(
        compareTrigs.map((r) => [
          r.trigger_name,
          normalizeForComparison(r.trigger_def),
        ])
      );

      for (const [name, def] of baseTrigMap.entries()) {
        if (!compareTrigMap.has(name))
          schemaDiffs.push(`🟥 Missing trigger: ${name}`);
        else if (compareTrigMap.get(name) !== def)
          schemaDiffs.push(`🟨 Trigger differs: ${name}`);
      }
      for (const name of compareTrigMap.keys()) {
        if (!baseTrigMap.has(name))
          schemaDiffs.push(`🟩 Extra trigger: ${name}`);
      }

      if (schemaDiffs.length > 0) diffs[schema] = schemaDiffs;
    }

    s.stop("Verification complete.");

    if (Object.keys(diffs).length === 0) {
      log.success("✅ All schemas are structurally identical.");
    } else {
      log.warn("⚠️ Schema drift detected:");
      for (const [schema, diffList] of Object.entries(diffs)) {
        log.info(`\n🔹 Schema: ${schema}`);
        diffList.forEach((d) => console.log(`  ${d}`));
        console.log(`  — ${diffList.length} differences total —`);
      }

      const summary = Object.entries(diffs).map(
        ([schema, arr]) => `  • ${schema}: ${arr.length} differences`
      );
      log.warn(`\n📊 Summary:\n${summary.join("\n")}`);

      process.exitCode = 1;
    }
  } catch (error) {
    s.stop("Error during verification.");
    log.error("Schema verification failed: " + error);
  }
}
