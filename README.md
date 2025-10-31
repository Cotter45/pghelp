<h1 align="center">🐘 pghelp</h1>

<p align="center">
  A powerful CLI tool for <b>PostgreSQL developers</b> — combining schema management, migrations, and TypeScript code generation into a single workflow.
</p>

### 🚀 Overview

pghelp is a command-line tool designed for PostgreSQL + TypeScript workflows.
It helps you:

- Bootstrap databases
- Run and revert migrations
- Dump schemas
- Generate TypeScript types, Zod schemas, and type-safe functions
- Keep configuration and environment setup clean and automated
- All with interactive prompts or fully non-interactive scripts.

---

### ✨ Features

- Database Setup — Quickly initialize a local Postgres database.
- Schema Dumping — Export your schema to a .sql file.
- Migrations — Create timestamped up/down migration files and run or revert them.
- Type Generation — Generate TypeScript types from your database tables.
- Function Type Generation — Derive TypeScript definitions for Postgres functions.
- Zod Schema Generation — Create fully-typed validators with optional coercion and defaults.
- Type-Safe SQL Wrappers — Generate TS functions for your queries.
- Interactive Prompts — Uses @clack/prompts for a friendly UX.
- .env Validation — Ensures DATABASE_URL exists and updates .env if missing.
- Config Management — Saves all paths/schemas in pghelp_config.json (auto-ignored in .gitignore).
- Schema Auto-Sync — Automatically updates config if new schemas are found in your database.
- Non-Interactive Mode — Perfect for CI/CD pipelines.

---

### 📦 Installation

Global install

```bash
npm install -g pghelp
# or
yarn global add pghelp
# or
pnpm add -g pghelp
```

Local install

```bash
npm install pghelp
# or
yarn add pghelp
# or
pnpm add pghelp
```

Then add it to your package.json scripts:

```json
{
  "scripts": {
    "pghelp": "pghelp",
    "migrate": "pghelp --action run",
    "revert": "pghelp --action revert --revert 1"
  }
}
```

---

### 💻 Usage

Start Interactive Mode

```bash
npx pghelp
```

Run Specific Actions

```bash
# Initialize local database
pghelp setup

# Dump your current schema
pghelp --action dump

# Create a new migration
pghelp create --name add_users_table

# Run all pending migrations
pghelp run

# Revert last 2 migrations
pghelp revert --revert 2

# Generate TypeScript types
pghelp gentypes

# Generate function types
pghelp genfunctypes

# Generate Zod schema files
pghelp genschema

# Generate type-safe TS wrappers around SQL functions
pghelp genfunctions

# Verify schema drift
pghelp verify

# Reconfigure pghelp interactively
pghelp config

# Display help
pghelp help
```

---

### ⚙️ Options & Flags

| Flag                        | Description                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--action <action>`         | Specify which action to perform (setup, dump, create, run, revert, gentypes, genfunctypes, genschema, genfunctions, verify, config, help). |
| `--schemas <list>`          | Comma-separated schema names (default: "public").                                                                                          |
| `--db-url <url>`            | Provide a Postgres connection string manually.                                                                                             |
| `--migration-path <path>`   | Base path for migration files (default: "db").                                                                                             |
| `--migrations-dir <dir>`    | Directory for migrations (default: "migrations").                                                                                          |
| `--migrations-table <name>` | Table used to track migrations (default: "migrations").                                                                                    |
| `--name`, `--migration`     | Specify migration name (for create).                                                                                                       |
| `--revert <count>`          | Number of migrations to revert (for revert).                                                                                               |
| `--non-interactive`         | Run in non-interactive mode (CI-friendly).                                                                                                 |
| `--force-optional`          | (for genschema) Force all fields to be optional.                                                                                           |
| `--coerce-dates`            | (for genschema) Use z.coerce.date() for date columns.                                                                                      |
| `--default-null`            | (for genschema) Add .default(null) for nullable fields (default: true).                                                                    |

---

### ⚡ Configuration

When pghelp runs for the first time, it asks for:

- .env path and database URL
- Base migration path
- Migrations directory name
- Migrations table name
- Schemas (comma-separated)

It saves them in `pghelp_config.json` at your project root.

Example:

```json
{
  "migrationPath": "db",
  "migrationsDir": "migrations",
  "migrationsTable": "migrations",
  "schemas": ["public"]
}
```

✅ Both `.env` and `pghelp_config.json` are automatically added to .gitignore.

You can reconfigure anytime with:

```bash
pghelp config
```

---

### 🧩 Schema & Type Generation

#### TypeScript Types

Generate per-schema types into /types/ (multi-schema supported):

```bash
pghelp gentypes
```

#### Function Types

Generate TS signatures for Postgres functions:

```bash
pghelp genfunctypes
```

#### Type-Safe Functions

Generate ready-to-use TypeScript wrappers around SQL functions:

```bash
pghelp genfunctions
```

#### Zod Schema Generation

```bash
pghelp genschema
```

Supports advanced flags:

```bash
# Fully automatic mode
pghelp genschema --non-interactive --force-optional --coerce-dates

# Example output:
# /schema/schema.ts
# /schema/index.ts
```

The generator will:

- Recreate /schema and /types folders
- Sync with your current DB schemas
- Ask whether to coerce dates, force optional fields, and use null defaults (if interactive)

---

### 🧮 Automatic Schema Sync

Every time pghelp connects to your database, it:

- Queries pg_namespace for non-system schemas.
- Compares with your config.
- Updates pghelp_config.json if differences are found.

No more manual schema mismatches. 🎉

---

### 🧯 Troubleshooting

| Problem                      | Cause                     | Fix                                   |
| ---------------------------- | ------------------------- | ------------------------------------- |
| pghelp: command not found    | Not installed globally    | Use npx pghelp or install globally    |
| Invalid database URL         | Missing or malformed .env | Add a valid DATABASE_URL              |
| Connection refused           | Postgres not running      | Start Postgres and check connection   |
| permission denied for schema | Insufficient privileges   | Grant USAGE and CREATE on schema      |
| Schema drift detected        | Migrations out of sync    | Run pghelp verify or rerun migrations |

---

### 🏗️ Query Builder

pghelp also exports a TypeScript-based query builder for constructing SQL queries with a fluent API. This library supports SELECT, INSERT, UPDATE, and DELETE operations, along with advanced features like joins, aggregates, subqueries, and window functions.

> **Note:** This is a static SQL builder. It only generates SQL and params—you bring your own database driver for execution.

### Features

- Fluent API for building SQL queries
- Support for SELECT, INSERT, UPDATE, and DELETE operations
- Joins (INNER and LEFT) and includes for related tables
- Aggregates (COUNT, SUM, AVG, MAX, MIN)
- Subqueries in SELECT and WHERE clauses
- Window functions (e.g., ROW_NUMBER, RANK)
- Parameterized queries to prevent SQL injection
- Support for Common Table Expressions (CTEs)

### Usage

#### Initialize the Query Builder

```typescript
import { createQueryBuilder } from "pghelp";

type DatabaseSchema = {
  users: {
    id: number;
    name: string;
    email: string;
  };
  posts: {
    id: number;
    user_id: number;
    title: string;
    content: string;
  };
};

const db = createQueryBuilder<DatabaseSchema>();
```

#### SELECT Queries

```typescript
const query = db.from("users").select("id", "name").toSQL();
console.log(query.sql); // SELECT id, name FROM users AS users
console.log(query.params); // []
```

#### SELECT with WHERE

```typescript
const query = db.from("users").select("id", "name").where("id", "=", 1).toSQL();
console.log(query.sql); // SELECT id, name FROM users AS users WHERE users.id = $1
console.log(query.params); // [1]
```

#### SELECT with JOIN

```typescript
const query = db
  .from("users")
  .join("INNER", "users", "posts", "id", "user_id", "posts", ["title"])
  .select("id", "name", "posts.title")
  .toSQL();
console.log(query.sql); // SELECT id, name, posts.title FROM users AS users INNER JOIN posts AS posts ON users.id = posts.user_id
console.log(query.params); // []
```

#### SELECT with Aggregates

```typescript
const query = db
  .from("users")
  .select("id")
  .count("id", "user_count")
  .groupBy("id")
  .toSQL();
console.log(query.sql); // SELECT id, COUNT(users.id) AS user_count FROM users AS users GROUP BY users.id
console.log(query.params); // []
```

#### SELECT with Subquery

```typescript
const subquery = db
  .from("posts")
  .select("user_id")
  .count("id", "post_count")
  .groupBy("user_id")
  .toSQL();

const query = db
  .from("users")
  .select("id", "name")
  .selectSubquery("post_count", subquery)
  .toSQL();
console.log(query.sql); // SELECT id, name, (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id) AS post_count FROM users AS users
console.log(query.params); // []
```

#### INSERT Queries

```typescript
const query = db
  .from("users")
  .insert({ id: 1, name: "Alice", email: "alice@example.com" })
  .returning("id", "email")
  .toSQL();
console.log(query.sql); // INSERT INTO users (id, name, email) VALUES ($1, $2, $3) RETURNING id, email
console.log(query.params); // [1, "Alice", "alice@example.com"]
```

#### UPDATE Queries

```typescript
const query = db
  .from("users")
  .update({ email: "alice@newdomain.com" })
  .where("id", "=", 1)
  .returning("id", "email")
  .toSQL();
console.log(query.sql); // UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email
console.log(query.params); // ["alice@newdomain.com", 1]
```

#### DELETE Queries

```typescript
const query = db
  .from("users")
  .delete()
  .where("id", "=", 1)
  .returning("id", "name")
  .toSQL();
console.log(query.sql); // DELETE FROM users WHERE id = $1 RETURNING id, name
console.log(query.params); // [1]
```

#### Common Table Expressions (CTEs)

```typescript
const cteQuery = db
  .from("posts")
  .select("user_id")
  .count("id", "post_count")
  .groupBy("user_id")
  .toSQL();

const query = db
  .from("users")
  .with("post_counts", cteQuery)
  .select("id", "name", "post_counts.post_count")
  .join("INNER", "users", "post_counts", "id", "user_id", "post_counts", [])
  .toSQL();
console.log(query.sql); // WITH post_counts AS (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id) SELECT id, name, post_counts.post_count FROM users AS users INNER JOIN post_counts ON users.id = post_counts.user_id
console.log(query.params); // []
```

#### Window Functions

```typescript
const query = db
  .from("users")
  .select("id", "name")
  .window(
    "ROW_NUMBER",
    "id",
    "row_num",
    ["id"],
    [{ column: "email", direction: "DESC" }]
  )
  .toSQL();
console.log(query.sql); // SELECT id, name, ROW_NUMBER(users.id) OVER (PARTITION BY users.id ORDER BY users.email DESC) AS row_num FROM users AS users
console.log(query.params); // []
```

---

### 🤝 Contributing

Contributions and feedback are always welcome!
If you’d like to improve pghelp, open a pull request or file an issue.

### 📜 License

© Forever Frameworks

<sub>Language: TypeScript • Database: PostgreSQL • License: MIT</sub>
