export type Config = {
  migrationsDir: string;
  migrationPath: string;
  migrationsTable: string;
};

export type PgUserFunction = {
  schema: string;
  function_name: string;
  args: string;
  return_type: string;
  returns_set: boolean;
};

export type Direction = "up" | "down";

export type Action =
  | "dump"
  | "setup"
  | "create"
  | "run"
  | "revert"
  | "gentypes"
  | "genfunctypes"
  | "genfunctions"
  | "genschema";

export type Operator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "LIKE" | "IN";

export type WindowFunction =
  | "ROW_NUMBER"
  | "RANK"
  | "DENSE_RANK"
  | "NTILE"
  | "FIRST_VALUE"
  | "LAST_VALUE"
  | "NTH_VALUE"
  | "LEAD"
  | "LAG"
  | "CUME_DIST"
  | "PERCENT_RANK"
  | "PERCENTILE_CONT"
  | "PERCENTILE_DISC";

export type WhereClause<T> = {
  type: "AND" | "OR" | null;
  column: keyof T;
  operator: Operator;
  value: any;
};

export type JoinClause<DB, R, K extends keyof DB> = {
  type: "INNER" | "LEFT";
  alias: string;
  localTable: keyof DB;
  foreignTable: keyof DB;
  localColumn: string;
  foreignColumn: string;
  projection?: (keyof DB[K])[];
};

// Updated to allow an optional projection of selected columns.
export type IncludeClause<DB, R, K extends keyof DB> = {
  alias: string;
  table: keyof DB;
  localColumn: string;
  foreignColumn: string;
  projection?: (keyof DB[K])[];
};

// --- QueryResult ---

export type JoinSource<DB, R, K extends string> = K extends keyof DB
  ? DB[K]
  : K extends keyof R
  ? R[K]
  : never;

export type QueryResult<T = any> = {
  sql: string;
  params: any[];
  __resultType: T;
};

export type PickSubset<T, K extends (keyof T)[]> = {
  [P in K[number]]: T[P];
};

export type MergeTypes<T, U> = {
  [P in keyof T]: P extends keyof U ? T[P] & U[P] : T[P];
} & {
  [P in keyof U]: P extends keyof T ? T[P] & U[P] : U[P];
};

export type MergeTypesAlt<T, U> = Omit<T, keyof U> & U;

// selected columns subset
export type MergeSelected<DBT, R, Selected> = {
  base: Partial<DBT> & Selected;
};

export type QueryResultType<T extends QueryResult<any>> = T["__resultType"];
