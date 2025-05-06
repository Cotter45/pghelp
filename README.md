# pghelp

A versatile CLI tool for PostgreSQL developers, offering schema dumps, migrations, and TypeScript code generation out of the box.

## Features

- Setup Local Database: Create a new database and roles, then run an initial SQL script.
- Dump Schema: Export your database schema to init.sql.
- Create Migrations: Scaffold up/down SQL files with timestamped names.
- Run/Revert Migrations: Apply or roll back migrations.
- Generate Types: Produce TypeScript types from tables.
- Generate Function Types: Type definitions for user‑defined Postgres functions.
- Generate Zod Schema: Create Zod validators for your tables.
- Generate Type‑Safe Functions: Auto‑generate TS wrappers around SQL functions.
- Interactive Prompts: Fallbacks for missing CLI args via @clack/prompts.
- Env Management: Ensures DATABASE_URL in .env, prompts if missing. Ensures .env exists in .gitignore.
- Config File: Persist migration settings in pghelp_config.json. Also adds to .gitignore.
- Query Builder: TypeSafe query builder for constructing SQL queries with a fluent API.

## Installation

1. npm

```bash
npm install -g pghelp
```

2. yarn

```bash
yarn global add pghelp
```

3. pnpm

```bash
pnpm add -g pghelp
```

4. Or, if you prefer to use it as a local dependency, install it in your project:

```bash
npm install pghelp
```

```bash
yarn add pghelp
```

```bash
pnpm add pghelp
```

- then add a script to your package.json:

```json
{
  "scripts": {
    "pghelp": "pghelp",
    "dump": "pghelp --action dump"
    // etc...
  }
}
```

## CLI Usage

````bash
# Start Interactive CLI
pghelp

# Dump your schema
pghelp --action dump

# Setup a fresh local database
pghelp setup

# Create a new migration
pghelp create --name add_users_table

# Run all pending migrations
pghelp run

# Revert last 2 migrations
pghelp revert --revert 2

# Generate TypeScript types for tables
pghelp gentypes

# Generate TS types for Postgres functions
pghelp genfunctypes

# Generate Zod schemas
pghelp genschema

# Generate type-safe TS function wrappers
pghelp genfunctions```
````

### Flags

```bash
--action <dump|setup|create|run|revert|gentypes|genfunctypes|genschema|genfunctions>
--name or --migration (for create)
--revert <count> (for revert)
--db-url <DATABASE_URL>
```

### Configuration

On first run, you’ll be prompted for:

- .env file path
- DATABASE_URL if not found
- Base migration path
- Migrations directory name
- Migrations table name (syncs with postgres)

These are saved to pghelp_config.json and auto‑ignored in .gitignore.

#### Defaults

```json
{
  "migrationPath": "db",
  "migrationsDir": "migrations",
  "migrationsTable": "migrations"
}
```

## Query Builder

This package also exports a TypeSafe query builder. It's a TypeScript-based query builder for constructing SQL queries with a fluent API. This library supports SELECT, INSERT, UPDATE, and DELETE operations, along with advanced features like joins, aggregates, subqueries, and window functions.

### BYO DRIVER. This only generates the SQL and params, it does not execute them.

### Features

- **Fluent API** for building SQL queries.
- Support for **SELECT**, **INSERT**, **UPDATE**, and **DELETE** operations.
- **Joins** (INNER and LEFT) and **includes** for related tables.
- **Aggregates** (COUNT, SUM, AVG, MAX, MIN).
- **Subqueries** in SELECT and WHERE clauses.
- **Window functions** (e.g., ROW_NUMBER, RANK).
- **Parameterized queries** to prevent SQL injection.
- Support for **Common Table Expressions (CTEs)**.

### Usage

Initialize the Query Builder

```typescript
import { createQueryBuilder } from "pghelp";

type DatabaseSchema = {
  users: {
    id: number;
    name: string;
  };
}; // Import YOUR schema generated with pghelp

export const qb = createQueryBuilder<DatabaseSchema>();
```

SELECT Queries

```typescript
const query = db.from("users").select("id", "name").toSQL();
console.log(query.sql); // SELECT id, name FROM users AS users
console.log(query.params); // []
```

SELECT with WHERE

```typescript
const query = db.from("users").select("id", "name").where("id", "=", 1).toSQL();
console.log(query.sql); // SELECT id, name FROM users AS users WHERE users.id = $1
console.log(query.params); // [1]
```

SELECT with JOIN

```typescript
const query = db
  .from("users")
  .join("INNER", "users", "posts", "id", "user_id", "posts", ["title"])
  .select("id", "name", "posts.title")
  .toSQL();
console.log(query.sql); // SELECT id, name, posts.title FROM users AS users INNER JOIN posts AS posts ON users.id = posts.user_id
console.log(query.params); // []
```

SELECT with Aggregates

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

SELECT with Subquery

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

INSERT Queries

```typescript
const query = db
  .from("users")
  .insert({ id: 1, name: "Alice", email: "alice@example.com" })
  .returning("id", "email")
  .toSQL();
console.log(query.sql); // INSERT INTO users (id, name, email) VALUES ($1, $2, $3) RETURNING id, email
console.log(query.params); // [1, "Alice", "alice@example.com"]
```

UPDATE Queries

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

DELETE Queries

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

Common Table Expressions (CTEs)

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

Window Functions

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

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the MIT License.
