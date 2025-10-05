import type {
  IncludeClause,
  JoinClause,
  JoinSource,
  MergeTypes,
  Operator,
  PickSubset,
  QueryResult,
  WhereClause,
  WindowFunction,
} from "./types";

/**
 * A simple builder for projecting columns on an included table.
 */
class IncludeBuilder<T, R = T> {
  private selects: (keyof T)[] = [];
  select<K extends keyof T>(...columns: K[]): IncludeBuilder<T, Pick<T, K>> {
    this.selects = columns;
    return this as unknown as IncludeBuilder<T, Pick<T, K>>;
  }
  getSelects(): (keyof T)[] {
    return this.selects;
  }
}

// --- Root & SELECT with Joins, Include, and (optionally) CTEs ---

class QueryBuilder<DB extends Record<string, any>> {
  private alias: string = "base";

  from<K extends keyof DB>(
    table: K,
    alias?: string
  ): TableQueryBuilder<DB, K, DB[K]> {
    this.alias = alias || String(table);
    return new TableQueryBuilder<DB, K, DB[K]>(table, this.alias);
  }
}

/**
 * TableQueryBuilder now constrains R to have a required "base" property.
 */
class TableQueryBuilder<
  DB extends Record<string, any>,
  T extends keyof DB,
  R = DB[T]
> {
  tableName: T;
  baseAlias: string = "base";
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE" = "SELECT";

  selectedColumns: string[] = [];
  params: any[] = [];

  whereClauses: string[] = [];
  joins: JoinClause<DB, R, T>[] = [];
  includes: IncludeClause<DB, R, T>[] = [];
  ctes: { name: string; query: QueryResult }[] = [];
  tableAliases: Record<string, string> = {};

  orderByClauses: string[] = [];
  limitValue?: number;
  offsetValue?: number;
  groupByClauses: string[] = [];
  havingClauses: string[] = [];
  isDistinct: boolean = false;

  constructor(table: T, alias?: string) {
    this.tableName = table;

    if (alias) {
      this.baseAlias = alias;
    }
  }

  /**
   * Add a Common Table Expression (CTE) to the query.
   *
   * @param name - The name of the CTE.
   * @param query - The query for the CTE (can be a SQL string or another query builder instance).
   */
  with<K extends string, CTE extends Record<string, any>>(
    name: K,
    query: QueryResult<CTE>
  ): TableQueryBuilder<DB, T, R & { [P in K]: CTE }> {
    this.ctes.push({ name, query });
    return this as unknown as TableQueryBuilder<DB, T, R & { [P in K]: CTE }>;
  }

  /**
   * Select base columns using fully qualified keys.
   * For example: "base.id", "base.name", etc.
   * The compiler enforces that these keys exist on the nested result.
   *
   * @param columns - The columns to select.
   * @returns A new TableQueryBuilder instance with the selected columns.
   * @throws Error if no columns are selected when using include.
   */
  select<S extends (keyof R | `${string}.${string}`)[]>(
    ...columns: S
  ): TableQueryBuilder<DB, T, PickSubset<R, Extract<S[number], keyof R>[]>> {
    this.operation = "SELECT";

    for (const col of columns) {
      this.selectedColumns.push(String(col));
    }

    return this as unknown as TableQueryBuilder<
      DB,
      T,
      PickSubset<R, Extract<S[number], keyof R>[]>
    >;
  }

  /**
   * Add a WHERE clause.
   * The column must be given in its fully qualified form (e.g. "base.id").
   *
   * @param column - The column to filter on.
   * @param operator - The comparison operator (e.g., "=", "<>", ">", "<", etc.).
   * @param value - The value to compare against.
   * @returns The current instance of TableQueryBuilder.
   * @throws Error if the value is undefined or null.
   */
  where<K extends keyof DB[T] | keyof R | `${string}.${string}`>(
    column: K,
    operator: Operator,
    value: DB[T][K] | DB[T][K][]
  ): this {
    if (value === undefined || value === null) {
      throw new Error(`Invalid value for WHERE clause: ${value}`);
    }

    if (operator === "IN" && Array.isArray(value)) {
      if (value.length === 0) {
        throw new Error(
          `Invalid value for WHERE clause: IN operator requires a non-empty array`
        );
      }

      const placeholders = value.map(
        (_, index) => `$${this.params.length + index + 1}`
      );
      this.params.push(...value);
      if (String(column).includes(".")) {
        this.whereClauses.push(
          `${String(column)} ${operator} (${placeholders.join(", ")})`
        );
      } else {
        this.whereClauses.push(
          `${this.baseAlias}.${String(column)} ${operator} (${placeholders.join(
            ", "
          )})`
        );
      }
    } else {
      this.params.push(value);
      const placeholder = `$${this.params.length}`;
      if (String(column).includes(".")) {
        this.whereClauses.push(`${String(column)} ${operator} ${placeholder}`);
      } else {
        this.whereClauses.push(
          `${this.baseAlias}.${String(column)} ${operator} ${placeholder}`
        );
      }
    }

    return this;
  }

  /**
   * Add an OR WHERE clause.
   *
   * @param column - The column to filter on.
   * @param operator - The comparison operator (e.g., "=", "<>", ">", "<", etc.).
   * @param value - The value to compare against.
   * @returns The current instance of TableQueryBuilder.
   */
  orWhere<K extends keyof DB[T] | keyof R | `${string}.${string}`>(
    column: K,
    operator: Operator,
    value: DB[T][K] | DB[T][K][]
  ): this {
    if (value === undefined || value === null) {
      throw new Error(`Invalid value for WHERE clause: ${value}`);
    }

    if (operator === "IN" && Array.isArray(value)) {
      if (value.length === 0) {
        throw new Error(
          `Invalid value for WHERE clause: IN operator requires a non-empty array`
        );
      }

      const placeholders = value.map(
        (_, index) => `$${this.params.length + index + 1}`
      );
      this.params.push(...value);
      if (String(column).includes(".")) {
        this.whereClauses.push(
          `OR ${String(column)} ${operator} (${placeholders.join(", ")})`
        );
      } else {
        this.whereClauses.push(
          `OR ${this.baseAlias}.${String(
            column
          )} ${operator} (${placeholders.join(", ")})`
        );
      }
    } else {
      this.params.push(value);
      const placeholder = `$${this.params.length}`;
      if (String(column).includes(".")) {
        this.whereClauses.push(
          `OR ${String(column)} ${operator} ${placeholder}`
        );
      } else {
        this.whereClauses.push(
          `OR ${this.baseAlias}.${String(column)} ${operator} ${placeholder}`
        );
      }
    }

    return this;
  }

  /**
   * Add a JOIN clause.
   * The column must be given in its fully qualified form (e.g. "base.id").
   *
   * @param type - The type of join (INNER or LEFT).
   * @param table - The table to join.
   * @param localColumn - The column from the base table to join on.
   * @param foreignColumn - The column from the joined table to join on.
   * @param alias - Optional alias for the joined table (defaults to the table name).
   * @param selects - Optional array of columns to select from the joined table.
   * @returns The current instance of TableQueryBuilder.
   * @throws Error if the value is undefined or null.
   */
  join<
    K extends string,
    S extends (keyof JoinSource<DB, R, K>)[],
    A extends string = K
  >(
    type: "INNER" | "LEFT",
    localTable: T | keyof DB,
    foreignTable: K,
    localColumn: keyof DB[T],
    foreignColumn: keyof JoinSource<DB, R, K>,
    alias: A,
    selects: S
  ): TableQueryBuilder<
    DB,
    T,
    R & {
      [P in A]: Pick<JoinSource<DB, R, K>, S[number]>;
    }
  > {
    this.joins.push({
      type,
      alias,
      localTable: String(localTable),
      foreignTable: String(foreignTable),
      localColumn: String(localColumn),
      foreignColumn: String(foreignColumn),
      projection: selects,
    });

    return this as unknown as TableQueryBuilder<
      DB,
      T,
      R & {
        [P in A]: Pick<JoinSource<DB, R, K>, S[number]>;
      }
    >;
  }

  /**
   * Include a related table as a JSON array.
   *
   * @param table - The related table name.
   * @param localColumn - The column from the base table to join on.
   * @param foreignColumn - The column from the related table to join on.
   * @param alias - Optional alias for the included table (defaults to the table name).
   * @param projection - Optional projection callback to select specific columns.
   * @returns The current instance of TableQueryBuilder.
   * @throws Error if no columns are selected when using include.
   */
  include<
    K extends keyof DB,
    A extends string = Extract<K, string>,
    R2 = DB[K]
  >(
    table: K,
    localColumn: keyof DB[T],
    foreignColumn: keyof DB[K],
    alias?: A,
    projection?: (qb: IncludeBuilder<DB[K]>) => IncludeBuilder<DB[K], R2>
  ): TableQueryBuilder<DB, T, MergeTypes<R, { [P in A]: R2[] }>> {
    const actualAlias = alias ?? String(table);
    let proj: (keyof DB[K])[] | undefined = undefined;
    if (projection) {
      const builder = new IncludeBuilder<DB[K]>();
      const projected = projection(builder);
      proj = projected.getSelects();
    }
    this.includes.push({
      alias: actualAlias,
      table,
      localColumn: `${this.baseAlias}.${String(localColumn)}`, // Fully qualify the local column
      foreignColumn: String(foreignColumn),
      projection: proj, // May be undefined if no projection provided
    });
    return this as unknown as TableQueryBuilder<
      DB,
      T,
      MergeTypes<R, { [P in A]: R2[] }>
    >;
  }

  /**
   * Add a COUNT aggregate function to the SELECT clause.
   *
   * @param column - The column to count (e.g., "base.id").
   * @param alias - Optional alias for the result (e.g., "user_count").
   */
  count<K extends keyof DB[T], A extends string>(
    column: K,
    alias: A
  ): TableQueryBuilder<DB, T, MergeTypes<R, { [P in A]: number }>> {
    const countExpression = `COUNT(${this.baseAlias}.${String(
      column
    )}) AS ${alias}`;
    this.selectedColumns.push(countExpression);
    return this as unknown as TableQueryBuilder<
      DB,
      T,
      MergeTypes<R, { [P in A]: number }>
    >;
  }

  /**
   * Add an aggregate function to the SELECT clause.
   *
   * @param functionName - The aggregate function (e.g., "COUNT", "SUM").
   * @param column - The column to aggregate (e.g., "base.id").
   * @param alias - Optional alias for the result (e.g., "user_count").
   */
  aggregate<K extends keyof DB[T], A extends string>(
    functionName: "COUNT" | "SUM" | "AVG" | "MAX" | "MIN",
    column: K,
    alias: A
  ): TableQueryBuilder<DB, T, MergeTypes<R, { [P in A]: number }>> {
    const aggregateExpression = `${functionName}(${this.baseAlias}.${String(
      column
    )}) AS ${alias}`;
    this.selectedColumns.push(aggregateExpression);
    return this as unknown as TableQueryBuilder<
      DB,
      T,
      MergeTypes<R, { [P in A]: number }>
    >;
  }

  /**
   * Add an ORDER BY clause.
   *
   * @param column - The column to order by (e.g., "base.id").
   * @param direction - The sort direction ("ASC" or "DESC").
   * @returns The current instance of TableQueryBuilder.
   * @throws Error if the value is undefined or null.
   */
  orderBy<K extends keyof DB[T]>(column: K, direction: "ASC" | "DESC"): this {
    if (direction !== "ASC" && direction !== "DESC") {
      throw new Error(`Invalid sort direction: ${direction}`);
    }
    this.orderByClauses.push(
      `${this.baseAlias}.${String(column)} ${direction}`
    );
    return this;
  }

  /**
   * Add a LIMIT clause.
   *
   * @param value - The maximum number of rows to return.
   * @returns The current instance of TableQueryBuilder.
   */
  limit(value: number): this {
    this.limitValue = value;
    return this;
  }

  /**
   * Add an OFFSET clause.
   *
   * @param value - The number of rows to skip before returning results.
   * @returns The current instance of TableQueryBuilder.
   */
  offset(value: number): this {
    this.offsetValue = value;
    return this;
  }

  /**
   * Add a GROUP BY clause.
   *
   * @param columns - The columns to group by (e.g., "base.id").
   * @returns The current instance of TableQueryBuilder.
   */
  groupBy<K extends keyof DB[T]>(...columns: K[]): this {
    this.groupByClauses.push(
      ...columns.map((col) => `${this.baseAlias}.${String(col)}`)
    );
    return this;
  }

  /**
   * Add a HAVING clause.
   *
   * @param column - The column to filter on.
   * @param operator - The comparison operator (e.g., "=", "<>", ">", "<", etc.).
   * @param value - The value to compare against.
   * @returns The current instance of TableQueryBuilder.
   */
  having(column: string, operator: Operator, value: any): this {
    this.params.push(value);
    const placeholder = `$${this.params.length}`;
    this.havingClauses.push(`${column} ${operator} ${placeholder}`);
    return this;
  }

  /**
   * Add DISTINCT to the SELECT clause.
   *
   * @returns The current instance of TableQueryBuilder.
   */
  distinct(): this {
    this.isDistinct = true;
    return this;
  }

  /**
   * Add a subquery as a selected column.
   *
   * @param alias - The alias for the subquery result.
   * @param subquery - The subquery to include.
   * @returns The current instance of TableQueryBuilder.
   */
  selectSubquery(alias: string, subquery: QueryResult): this {
    const subqueryAlias = alias; // Use tableAlias if provided, otherwise fallback to alias
    this.selectedColumns.push(`(${subquery.sql}) AS ${subqueryAlias}`);
    this.params.push(...subquery.params);
    return this;
  }

  /**
   * Add a WHERE clause with a subquery.
   *
   * @param column - The column to compare against the subquery.
   * @param operator - The comparison operator.
   * @param subquery - The subquery to use for the comparison.
   * @returns The current instance of TableQueryBuilder.
   */
  whereSubquery<K extends keyof DB[T]>(
    column: K,
    operator: Operator,
    subquery: QueryResult
  ): this {
    // Adjust subquery placeholders to account for existing parameters
    const offset = this.params.length;
    const adjustedSQL = subquery.sql.replace(
      /\$(\d+)/g,
      (_, index) => `$${+index + offset}`
    );

    // Add the adjusted subquery SQL to the WHERE clause
    const placeholder = `(${adjustedSQL})`;
    this.whereClauses.push(`${String(column)} ${operator} ${placeholder}`);

    // Append the subquery's parameters to the main query's parameters
    this.params.push(...subquery.params);

    return this;
  }

  /**
   * Add a window function to the SELECT clause.
   *
   * @param functionName - The window function (e.g., "ROW_NUMBER", "RANK").
   * @param column - The column to apply the window function to.
   * @param alias - The alias for the result.
   * @param partitionBy - Optional columns to partition by.
   * @param orderBy - Optional columns to order by.
   * @returns The current instance of TableQueryBuilder.
   */
  window<K extends keyof DB[T]>(
    functionName: WindowFunction,
    column: K,
    alias: string,
    partitionBy?: (keyof DB[T])[],
    orderBy?: { column: keyof DB[T]; direction: "ASC" | "DESC" }[]
  ): this {
    const partitionClause =
      partitionBy && partitionBy.length
        ? `PARTITION BY ${partitionBy
            .map((col) => `${this.baseAlias}.${String(col)}`)
            .join(", ")}`
        : "";
    const orderByClause =
      orderBy && orderBy.length
        ? `ORDER BY ${orderBy
            .map((o) => `${this.baseAlias}.${String(o.column)} ${o.direction}`)
            .join(", ")}`
        : "";

    // Combine clauses while filtering out empty strings.
    const overClause = [partitionClause, orderByClause]
      .filter((clause) => clause)
      .join(" ");

    // Generate the window function expression with the alias.
    this.selectedColumns.push(
      `${functionName}(${this.baseAlias}.${String(
        column
      )}) OVER (${overClause}) AS ${alias}`
    );
    return this;
  }

  /**
   * Reset the state of the query builder.
   */
  private resetState(): void {
    this.selectedColumns = [];
    this.params = [];
    this.whereClauses = [];
    this.joins = [];
    this.includes = [];
    this.ctes = [];
    this.orderByClauses = [];
    this.limitValue = undefined;
    this.offsetValue = undefined;
    this.groupByClauses = [];
    this.havingClauses = [];
    this.isDistinct = false;
  }

  /**
   * Generate the SQL string and parameters for the query.
   *
   * @returns The SQL string and parameters for the query.
   * @throws Error if no columns are selected when using include.
   */
  toSQL(): QueryResult<R> {
    // If include() was used, ensure that at least one column was explicitly selected.
    if (this.includes.length > 0 && this.selectedColumns.length === 0) {
      throw new Error(
        "When using include, please explicitly call select() with at least one column."
      );
    }

    // Determine the table name and alias.
    const baseTable = String(this.tableName);
    const tableAlias =
      this.tableAliases[this.tableName as string] || this.baseAlias;

    // Build the SELECT clause.
    const selectClause = [
      `${this.isDistinct ? "DISTINCT " : ""}${
        this.selectedColumns.length > 0
          ? this.selectedColumns.join(", ")
          : `${tableAlias}.*`
      }`,
      ...this.includes.map((inc) => {
        if (inc.projection && inc.projection.length > 0) {
          const objParts = inc.projection
            .map(
              (col: string | number | symbol) =>
                `'${String(col)}', ${inc.alias}.${String(col)}`
            )
            .join(", ");
          return `COALESCE(json_agg(json_build_object(${objParts})) FILTER (WHERE ${inc.alias}.id IS NOT NULL), '[]') AS ${inc.alias}`;
        } else {
          return `COALESCE(json_agg(${inc.alias}.*) FILTER (WHERE ${inc.alias}.id IS NOT NULL), '[]') AS ${inc.alias}`;
        }
      }),
    ].join(", ");

    // Generate any Common Table Expressions (CTEs).
    const cteClause =
      this.ctes.length > 0
        ? `WITH ${this.ctes
            .map((cte) => `${cte.name} AS (${cte.query.sql})`)
            .join(", ")} `
        : "";

    // Begin constructing the SQL.
    let sql = `${cteClause}SELECT ${selectClause} FROM ${baseTable} AS ${tableAlias}`;

    // Append JOIN clauses.
    for (const join of this.joins) {
      const isCTE = this.ctes.some((cte) => cte.name === join.foreignTable);
      sql += ` ${join.type} JOIN ${String(join.foreignTable)}${
        isCTE ? "" : ` AS ${join.alias}`
      } ON ${String(join.localTable)}.${join.localColumn} = ${join.alias}.${
        join.foreignColumn
      }`;
    }

    // Append INCLUDE clauses (only the JOIN logic, as the SELECT logic is handled above).
    for (const inc of this.includes) {
      sql += ` LEFT JOIN ${String(inc.table)} AS ${inc.alias} ON ${inc.alias}.${
        inc.foreignColumn
      } = ${inc.localColumn}`;
    }

    // Append WHERE clauses.
    if (this.whereClauses.length > 0) {
      const orClauses = this.whereClauses.filter((w) => w.startsWith("OR"));
      const andClauses = this.whereClauses.filter((w) => !w.startsWith("OR"));

      sql += ` WHERE ${andClauses.join(" AND ")}`;
      if (orClauses.length > 1) {
        const orClausesString = orClauses
          .map((clause) => clause.replace(/^OR /, ""))
          .join(" OR ");
        sql += ` AND (${orClausesString})`;
      } else if (orClauses.length === 1) {
        sql += ` ${orClauses[0]}`;
      }
      // sql += ` WHERE ${this.whereClauses.join(" AND ")}`;
    }

    // Append GROUP BY clause.
    if (this.groupByClauses.length > 0) {
      sql += ` GROUP BY ${this.groupByClauses.join(", ")}`;
    }

    // Append HAVING clause.
    if (this.havingClauses.length > 0) {
      sql += ` HAVING ${this.havingClauses.join(" AND ")}`;
    }

    // Append ORDER BY clause.
    if (this.orderByClauses.length > 0) {
      sql += ` ORDER BY ${this.orderByClauses.join(", ")}`;
    }

    // Append LIMIT clause.
    if (this.limitValue !== undefined) {
      sql += ` LIMIT ${this.limitValue}`;
    }

    // Append OFFSET clause.
    if (this.offsetValue !== undefined) {
      sql += ` OFFSET ${this.offsetValue}`;
    }

    const result: QueryResult<R> = {
      sql,
      params: this.params,
      __resultType: undefined as unknown as R,
    };

    // Reset state after generating the query.
    this.resetState();
    return result;
  }

  // --- Non-SELECT operations (using parameterized queries) ---

  insert<V extends DB[T] | DB[T][]>(
    values: Partial<V> | Partial<V>[]
  ): InsertQueryBuilder<DB, T, V> {
    this.operation = "INSERT";
    return new InsertQueryBuilder<DB, T, V>(this.tableName, values);
  }

  update(setClause: Partial<DB[T]>): UpdateQueryBuilder<DB, T> {
    this.operation = "UPDATE";
    return new UpdateQueryBuilder<DB, T>(this.tableName, setClause);
  }

  batchUpdate(
    values: { where: Partial<DB[T]>; set: Partial<DB[T]> }[]
  ): UpdateQueryBuilder<DB, T> {
    this.operation = "UPDATE";
    return new UpdateQueryBuilder<DB, T>(
      this.tableName,
      {} as Partial<DB[T]>
    ).batchUpdate(values);
  }

  delete(): DeleteQueryBuilder<DB, T> {
    this.operation = "DELETE";
    return new DeleteQueryBuilder<DB, T>(this.tableName);
  }
}

// --- INSERT with RETURNING (parameterized) ---

class InsertQueryBuilder<
  DB extends Record<string, any>,
  T extends keyof DB,
  V extends Partial<DB[T]> | Partial<DB[T]>[],
  R = V extends Partial<DB[T]>[] ? Partial<DB[T]>[] : Partial<DB[T]>
> {
  private table: T;
  private values: Partial<V> | Partial<V>[];
  private returningColumns?: (keyof DB[T])[];
  private conflictClause?: string;

  constructor(table: T, values: Partial<V> | Partial<V>[]) {
    this.table = table;
    this.values = values;
  }

  /**
   * Specify the columns to return after the insert operation.
   *
   * @param columns - The columns to return.
   * @returns A new InsertQueryBuilder instance with the specified returning columns.
   */
  returning<K extends keyof DB[T]>(
    ...columns: K[]
  ): InsertQueryBuilder<DB, T, V, Pick<DB[T], K>> {
    this.returningColumns = columns;
    return this as unknown as InsertQueryBuilder<DB, T, V, Pick<DB[T], K>>;
  }

  /**
   * Add a conflict clause for INSERT ON CONFLICT.
   *
   * @param conflictColumns - The columns to check for conflicts.
   * @param updateColumns - The columns to update on conflict.
   */
  onConflict(
    conflictColumns: (keyof DB[T])[],
    updateColumns: Partial<DB[T]>
  ): this {
    const conflictClause = `ON CONFLICT (${conflictColumns.join(
      ", "
    )}) DO UPDATE SET ${Object.entries(updateColumns)
      .map(([col, val]) => `${col} = EXCLUDED.${col}`)
      .join(", ")}`;
    this.conflictClause = conflictClause;
    return this;
  }

  private resetState(): void {
    this.returningColumns = undefined;
    this.conflictClause = undefined;
    this.values = [];
  }

  /**
   * Generate the SQL string and parameters for the INSERT operation.
   *
   * @returns The SQL string and parameters for the INSERT operation.
   * @throws Error if no rows are provided for insert.
   */
  toSQL(): QueryResult<R> {
    const table = String(this.table);
    const rows: DB[T][] = Array.isArray(this.values)
      ? (this.values as DB[T][])
      : ([this.values] as DB[T][]);
    if (rows.length === 0) {
      throw new Error("No rows provided for insert.");
    }
    const columns = Object.keys(rows[0]);
    const columnList = columns.join(", ");
    let params: any[] = [];
    const valuesList = rows
      .map((row) => {
        const placeholders = columns.map((col) => {
          params.push((row as any)[col]);
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      })
      .join(", ");
    let sql = `INSERT INTO ${table} (${columnList}) VALUES ${valuesList}`;

    if (this.conflictClause) {
      sql += ` ${this.conflictClause}`;
    }
    if (this.returningColumns) {
      sql += ` RETURNING ${this.returningColumns.join(", ")}`;
    }

    const result = { sql, params } as QueryResult<R>;

    // Reset state after generating the query.
    this.resetState();

    return result;
  }
}

// --- UPDATE with RETURNING (parameterized) ---

class UpdateQueryBuilder<
  DB extends Record<string, any>,
  T extends keyof DB,
  R = Partial<DB[T]>
> {
  private table: T;
  private setClause: Partial<DB[T]>;
  private allowUnsafe: boolean = false;
  private wheres: WhereClause<DB[T]>[] = [];
  private returningColumns?: (keyof DB[T])[];
  private batchUpdates?: { where: Partial<DB[T]>; set: Partial<DB[T]> }[];

  constructor(table: T, setClause: Partial<DB[T]>) {
    this.table = table;
    this.setClause = setClause;
  }

  /**
   * Allow unsafe updates without a WHERE clause.
   * This is not recommended for production use.
   */
  allowUnsafeUpdate(): this {
    this.wheres = [];
    this.allowUnsafe = true;
    return this;
  }

  /**
   * Specify the columns to return after the update operation.
   *
   * @param columns - The columns to return.
   * @returns A new UpdateQueryBuilder instance with the specified returning columns.
   */
  batchUpdate(values: { where: Partial<DB[T]>; set: Partial<DB[T]> }[]): this {
    this.batchUpdates = values;
    return this;
  }

  /**
   * Add a WHERE clause.
   *
   * @param column - The column to filter on.
   * @param operator - The comparison operator (e.g., "=", "<>", ">", "<", etc.).
   * @param value - The value to compare against.
   * @returns The current instance of UpdateQueryBuilder.
   */
  where(column: keyof DB[T], operator: Operator, value: any): this {
    this.wheres.push({ type: "AND", column, operator, value });
    return this;
  }

  /**
   * Add an OR WHERE clause.
   *
   * @param column - The column to filter on.
   * @param operator - The comparison operator (e.g., "=", "<>", ">", "<", etc.).
   * @param value - The value to compare against.
   * @returns The current instance of DeleteQueryBuilder.
   */
  orWhere(column: keyof DB[T], operator: Operator, value: any): this {
    this.wheres.push({ type: "OR", column, operator, value });
    return this;
  }

  /**
   * Specify the columns to return after the update operation.
   *
   * @param columns - The columns to return.
   * @returns A new UpdateQueryBuilder instance with the specified returning columns.
   */
  returning<K extends keyof DB[T]>(
    ...columns: K[]
  ): UpdateQueryBuilder<DB, T, Pick<DB[T], K>> {
    this.returningColumns = columns;
    return this as unknown as UpdateQueryBuilder<DB, T, Pick<DB[T], K>>;
  }

  private resetState(): void {
    this.wheres = [];
    this.returningColumns = undefined;
    this.batchUpdates = undefined;
  }

  /**
   * Generate the SQL string and parameters for the UPDATE operation.
   *
   * @returns The SQL string and parameters for the UPDATE operation.
   * @throws Error if no WHERE clause is provided.
   */
  toSQL(): QueryResult<R> {
    const table = String(this.table);

    if (!this.allowUnsafe && this.wheres.length === 0 && !this.batchUpdates) {
      throw new Error(
        "WHERE clause is required for UPDATE or DELETE operations."
      );
    }

    let params: any[] = [];
    let sql = `UPDATE ${table}`;

    if (this.batchUpdates) {
      // Extract columns to update
      const updateColumns = new Set<string>();
      this.batchUpdates.forEach((update) => {
        Object.keys(update.set).forEach((col) => updateColumns.add(col));
      });

      // Generate SET clause with CASE expressions
      const setClause = Array.from(updateColumns)
        .map((col) => {
          const cases = (this.batchUpdates || [])
            .map(
              (update) =>
                `WHEN ${Object.entries(update.where)
                  .map(([whereCol, whereVal]) => {
                    params.push(whereVal);
                    return `${whereCol} = $${params.length}`;
                  })
                  .join(" AND ")} THEN $${params.push(update.set[col])}`
            )
            .join(" ");
          return `${col} = CASE ${cases} ELSE ${col} END`;
        })
        .join(", ");

      sql += ` SET ${setClause}`;

      // Generate WHERE clause to limit updates to relevant rows
      const whereConditions = this.batchUpdates
        .map((update) =>
          Object.entries(update.where)
            .map(([col, val]) => {
              params.push(val);
              return `${col} = $${params.length}`;
            })
            .join(" AND ")
        )
        .join(" OR ");
      sql += ` WHERE ${whereConditions}`;
    } else {
      // Handle regular updates
      const setParts = Object.entries(this.setClause).map(([col, val]) => {
        params.push(val);
        return `${col} = $${params.length}`;
      });

      sql += ` SET ${setParts.join(", ")}`;

      const whereParts = this.wheres.map((w) => {
        if (w.operator === "IN" && Array.isArray(w.value)) {
          if (w.value.length === 0) {
            throw new Error(
              `Invalid value for WHERE clause: IN operator requires a non-empty array`
            );
          }

          // Use = ANY for IN operator
          params.push(w.value);
          return `${String(w.column)} = ANY($${params.length})`;
        } else {
          params.push(w.value);
          return `${String(w.column)} ${w.operator} $${params.length}`;
        }
      });

      if (whereParts.length) {
        sql += ` WHERE ${whereParts.join(" AND ")}`;
      }
    }

    if (this.returningColumns) {
      sql += ` RETURNING ${this.returningColumns.join(", ")}`;
    }

    const result = { sql, params } as QueryResult<R>;

    // Reset state after generating the query.
    this.resetState();

    return result;
  }
}

// --- DELETE with RETURNING (parameterized) ---

class DeleteQueryBuilder<
  DB extends Record<string, any>,
  T extends keyof DB,
  R = null
> {
  private table: T;
  private wheres: WhereClause<DB[T]>[] = [];
  private returningColumns?: (keyof DB[T])[];
  private allowDeleteWithoutWhere: boolean = false;

  constructor(table: T) {
    this.table = table;
  }

  /**
   * Allow DELETE without a WHERE clause.
   * This is not recommended for production use.
   *
   * @returns The current instance of DeleteQueryBuilder.
   */
  allowUnsafeDelete(): this {
    this.allowDeleteWithoutWhere = true;
    return this;
  }

  /**
   * Add a WHERE clause.
   *
   * @param column - The column to filter on.
   * @param operator - The comparison operator (e.g., "=", "<>", ">", "<", etc.).
   * @param value - The value to compare against.
   * @returns The current instance of DeleteQueryBuilder.
   */
  where(column: keyof DB[T], operator: Operator, value: any): this {
    this.wheres.push({ type: "AND", column, operator, value });
    return this;
  }

  /**
   * Add an OR WHERE clause.
   *
   * @param column - The column to filter on.
   * @param operator - The comparison operator (e.g., "=", "<>", ">", "<", etc.).
   * @param value - The value to compare against.
   * @returns The current instance of DeleteQueryBuilder.
   */
  orWhere(column: keyof DB[T], operator: Operator, value: any): this {
    this.wheres.push({ type: "OR", column, operator, value });
    return this;
  }

  /**
   * Specify the columns to return after the delete operation.
   *
   * @param columns - The columns to return.
   * @returns A new DeleteQueryBuilder instance with the specified returning columns.
   */
  returning<K extends keyof DB[T]>(
    ...columns: K[]
  ): DeleteQueryBuilder<DB, T, Pick<DB[T], K>[]> {
    this.returningColumns = columns;
    return this as unknown as DeleteQueryBuilder<DB, T, Pick<DB[T], K>[]>;
  }

  private resetState(): void {
    this.wheres = [];
    this.returningColumns = undefined;
    this.allowDeleteWithoutWhere = false;
  }

  /**
   * Generate the SQL string and parameters for the DELETE operation.
   *
   * @returns The SQL string and parameters for the DELETE operation.
   * @throws Error if no WHERE clause is provided.
   */
  toSQL(): QueryResult<R> {
    const table = String(this.table);

    if (this.wheres.length === 0 && !this.allowDeleteWithoutWhere) {
      throw new Error(
        "WHERE clause is required for UPDATE or DELETE operations."
      );
    }

    let params: any[] = [];
    const whereParts = this.wheres.map((w) => {
      if (w.operator === "IN" && Array.isArray(w.value)) {
        if (w.value.length === 0) {
          throw new Error(
            `Invalid value for WHERE clause: IN operator requires a non-empty array`
          );
        }

        const placeholders = w.value.map(
          (_, index) => `$${params.length + index + 1}`
        );
        params.push(...w.value);
        return `${String(w.column)} ${w.operator} (${placeholders.join(", ")})`;
      } else {
        params.push(w.value);
        const placeholder = `$${params.length}`;
        return `${String(w.column)} ${w.operator} ${placeholder}`;
      }
    });

    let sql = `DELETE FROM ${table}`;
    if (whereParts.length) {
      sql += ` WHERE ${whereParts.join(" AND ")}`;
    }
    if (this.returningColumns) {
      sql += ` RETURNING ${this.returningColumns.join(", ")}`;
    }

    const result = { sql, params } as QueryResult<R>;

    // Reset state after generating the query.
    this.resetState();

    return result;
  }
}

/**
 * Factory function to create a new query builder.
 */
export function createQueryBuilder<DB extends Record<string, any>>() {
  return new QueryBuilder<DB>();
}

// --- Example Usage ---

// type Schema = {
//   users: {
//     id: number
//     name: string
//     email: string
//   }
//   posts: {
//     id: number
//     user_id: number
//     title: string
//     content: string
//   }
// }

// const db = createQueryBuilder<Schema>()

// Example SELECT:
// Start from "users" (nested result is { base: Schema["users"] }).
// Then join "posts" with alias "posts" using the overload with a projection.
// That overload requires an explicit alias and a list of keys (here, "id" and "title").
// The nested type for "posts" becomes Pick<Schema["posts"], "id" | "title">.
// const usersQuery = db.from('users').select('id', 'name').toSQL()

// const selectQuery = db
//   .from('users')
//   .join('LEFT', 'users', 'posts', 'id', 'user_id', 'posts', ['title'])
//   .select('id', 'name', 'email', 'posts.title')
//   .where('id', '=', 42)
//   .toSQL()

// console.log('SELECT SQL:', selectQuery.sql)
// console.log('SELECT Params:', selectQuery.params)

// const includeQuery = db
//   .from('users')
//   .include('posts', 'id', 'user_id', 'posts', (qb) => qb.select('id', 'title', 'user_id'))
//   .select('id', 'name', 'email')
//   .where('id', '=', 42)
//   .toSQL()

// console.log('INCLUDE SQL:', includeQuery.sql)
// console.log('INCLUDE Params:', includeQuery.params)

// // INSERT example:
// const insertQuery = db
//   .from('users')
//   .insert({ id: 1, name: 'Alice', email: 'alice@example.com' })
//   .returning('id', 'email')
//   .toSQL()

// console.log('INSERT SQL:', insertQuery.sql)
// console.log('INSERT Params:', insertQuery.params)

// // UPDATE example:
// const updateQuery = db
//   .from('users')
//   .update({ email: 'alice@newdomain.com' })
//   .where('id', '=', 1)
//   .returning('id', 'email', 'name')
//   .toSQL()

// console.log('UPDATE SQL:', updateQuery.sql)
// console.log('UPDATE Params:', updateQuery.params)

// // DELETE example:
// const deleteQuery = db.from('users').delete().where('id', '=', 1).toSQL()

// console.log('DELETE SQL:', deleteQuery.sql)
// console.log('DELETE Params:', deleteQuery.params)
