import { createQueryBuilder } from "../query-builder";

type Schema = {
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
  comments: {
    id: number;
    post_id: number;
    content: string;
  };
};

describe("QueryBuilder", () => {
  const db = createQueryBuilder<Schema>();

  // --- SELECT Tests ---
  describe("SELECT Queries", () => {
    it("should generate a SELECT query with all columns", () => {
      const query = db.from("users", "u").select().toSQL();
      expect(query.sql).toBe("SELECT u.* FROM users AS u");
    });

    it("should generate a SELECT query with selected columns", () => {
      const query = db.from("users").select("id", "name").toSQL();

      expect(query.sql).toBe("SELECT id, name FROM users AS users");
    });

    it("should select * from the base table when no columns are specified", () => {
      const query = db.from("users").select().toSQL();
      expect(query.sql).toBe("SELECT users.* FROM users AS users");
    });
  });

  // --- WHERE Tests ---
  describe("WHERE Queries", () => {
    it("should generate a WHERE clause with a single condition", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .where("id", "=", 1)
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users WHERE users.id = $1"
      );
      expect(query.params).toEqual([1]);
    });

    it("should generate a WHERE clause with multiple conditions", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .where("id", "=", 1)
        .where("name", "LIKE", "%Alice%")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users WHERE users.id = $1 AND users.name LIKE $2"
      );
      expect(query.params).toEqual([1, "%Alice%"]);
    });

    it("should generate a WHERE clause with OR conditions", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .where("id", "=", 1)
        .orWhere("name", "LIKE", "%Alice%")
        .orWhere("email", "=", "test@test.com")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users WHERE users.id = $1 AND (users.name LIKE $2 OR users.email = $3)"
      );
      expect(query.params).toEqual([1, "%Alice%", "test@test.com"]);
    });

    it("should generate a WHERE clause with IN conditions", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .where("id", "IN", [1, 2, 3])
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users WHERE users.id IN ($1, $2, $3)"
      );
      expect(query.params).toEqual([1, 2, 3]);
    });
  });

  // --- INSERT Tests ---
  describe("INSERT Queries", () => {
    it("should generate an INSERT query", () => {
      const query = db
        .from("users")
        .insert({ id: 1, name: "Alice", email: "alice@example.com" })
        .returning("id", "email")
        .toSQL();

      expect(query.sql).toBe(
        "INSERT INTO users (id, name, email) VALUES ($1, $2, $3) RETURNING id, email"
      );
      expect(query.params).toEqual([1, "Alice", "alice@example.com"]);
    });

    it("should throw an error when no rows are provided for INSERT", () => {
      expect(() => {
        db.from("users").insert([]).toSQL();
      }).toThrow("No rows provided for insert.");
    });

    it("should generate an INSERT query with multiple rows", () => {
      const query = db
        .from("users")
        .insert([
          { id: 1, name: "Alice", email: "alice@example.com" },
          { id: 2, name: "Bob", email: "bob@example.com" },
        ])
        .returning("id", "email")
        .toSQL();

      expect(query.sql).toBe(
        "INSERT INTO users (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6) RETURNING id, email"
      );
      expect(query.params).toEqual([
        1,
        "Alice",
        "alice@example.com",
        2,
        "Bob",
        "bob@example.com",
      ]);
    });
  });

  // --- UPDATE Tests ---
  describe("UPDATE Queries", () => {
    it("should generate an UPDATE query", () => {
      const query = db
        .from("users")
        .update({ email: "alice@newdomain.com" })
        .where("id", "=", 1)
        .returning("id", "email")
        .toSQL();

      expect(query.sql).toBe(
        "UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email"
      );
      expect(query.params).toEqual(["alice@newdomain.com", 1]);
    });

    it("should generate an UPDATE query with multiple WHERE clauses", () => {
      const query = db
        .from("users")
        .update({ email: "new@example.com" })
        .where("id", "=", 1)
        .where("name", "LIKE", "%Alice%")
        .returning("id", "email")
        .toSQL();

      expect(query.sql).toBe(
        "UPDATE users SET email = $1 WHERE id = $2 AND name LIKE $3 RETURNING id, email"
      );
      expect(query.params).toEqual(["new@example.com", 1, "%Alice%"]);
    });

    it("should generate an UPDATE query with no WHERE clause", () => {
      const query = db
        .from("users")
        .update({ email: "new@example.com" })
        .allowUnsafeUpdate()
        .toSQL();

      expect(query.sql).toBe("UPDATE users SET email = $1");
      expect(query.params).toEqual(["new@example.com"]);
    });

    it("should handle batch updates arrays", () => {
      const query = db
        .from("users")
        .update({ email: "new@example.com" })
        .where("id", "IN", [1, 2, 3])
        .returning("id", "email")
        .toSQL();

      expect(query.sql).toBe(
        "UPDATE users SET email = $1 WHERE id = ANY($2) RETURNING id, email"
      );
      expect(query.params).toEqual(["new@example.com", [1, 2, 3]]);
    });

    it("should generate correct SQL and parameters for batch updates", () => {
      const db = createQueryBuilder<Schema>();

      const batchUpdates = [
        {
          where: { id: 1 },
          set: { name: "Test", email: "user1@example.com" },
        },
        {
          where: { id: 2 },
          set: { name: "Again", email: "user2@example.com" },
        },
      ];

      const query = db
        .from("users")
        .batchUpdate(batchUpdates)
        .returning("id", "name", "email")
        .toSQL();

      // Expected SQL
      const expectedSQL = `
      UPDATE users
      SET name = CASE
          WHEN id = $1 THEN $2
          WHEN id = $3 THEN $4 
        ELSE name END, email = CASE
          WHEN id = $5 THEN $6
          WHEN id = $7 THEN $8
        ELSE email END WHERE id = $9 OR id = $10
        RETURNING id, name, email
    `.trim();

      // Expected parameters
      const expectedParams = [
        1,
        "Test",
        2,
        "Again",
        1,
        "user1@example.com",
        2,
        "user2@example.com",
        1,
        2,
      ];

      // Assertions
      expect(query.sql.replace(/\s+/g, " ")).toBe(
        expectedSQL.replace(/\s+/g, " ")
      );
      expect(query.params).toEqual(expectedParams);
    });
  });

  // --- DELETE Tests ---
  describe("DELETE Queries", () => {
    it("should generate a DELETE query", () => {
      const query = db.from("users").delete().where("id", "=", 1).toSQL();

      expect(query.sql).toBe("DELETE FROM users WHERE id = $1");
      expect(query.params).toEqual([1]);
    });

    it("should generate a DELETE query with RETURNING", () => {
      const query = db
        .from("users")
        .delete()
        .where("id", "=", 1)
        .returning("id", "name")
        .toSQL();

      expect(query.sql).toBe(
        "DELETE FROM users WHERE id = $1 RETURNING id, name"
      );
      expect(query.params).toEqual([1]);
    });

    it("should generate a DELETE query without a WHERE clause", () => {
      const query = db.from("users").delete().allowUnsafeDelete().toSQL();

      expect(query.sql).toBe("DELETE FROM users");
      expect(query.params).toEqual([]);
    });

    it("should generate a DELETE query with IN clause", () => {
      const query = db
        .from("users")
        .delete()
        .where("id", "IN", [1, 2, 3])
        .toSQL();

      expect(query.sql).toBe("DELETE FROM users WHERE id IN ($1, $2, $3)");
      expect(query.params).toEqual([1, 2, 3]);
    });
  });

  // --- JOIN Tests ---
  describe("JOIN Queries", () => {
    it("should generate an INNER JOIN query without a projection", () => {
      const query = db
        .from("users")
        .join("INNER", "users", "posts", "id", "user_id", "posts", [])
        .select("id", "name", "posts.title")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, posts.title FROM users AS users INNER JOIN posts AS posts ON users.id = posts.user_id"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- INCLUDE Tests ---
  describe("INCLUDE Queries", () => {
    it("should generate a SELECT query with an include", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .include("posts", "id", "user_id", "p", (qb) =>
          qb.select("id", "title")
        )
        .toSQL();

      expect(query.sql).toContain(
        "LEFT JOIN posts AS p ON p.user_id = users.id"
      );
      expect(query.sql).toContain(
        "COALESCE(json_agg(json_build_object('id', p.id, 'title', p.title)) FILTER (WHERE p.id IS NOT NULL), '[]') AS p"
      );
    });

    it("should generate a SELECT query with an include and no projection", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .include("posts", "id", "user_id")
        .toSQL();

      expect(query.sql).toContain(
        "LEFT JOIN posts AS posts ON posts.user_id = users.id"
      );
      expect(query.sql).toContain(
        "COALESCE(json_agg(posts.*) FILTER (WHERE posts.id IS NOT NULL), '[]') AS posts"
      );
    });

    it("should generate a SELECT query with multiple includes", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .include("posts", "id", "user_id", "p", (qb) =>
          qb.select("id", "title")
        )
        .include("comments", "id", "post_id", "c", (qb) =>
          qb.select("id", "content")
        )
        .toSQL();

      expect(query.sql).toContain(
        "LEFT JOIN posts AS p ON p.user_id = users.id"
      );
      expect(query.sql).toContain(
        "COALESCE(json_agg(json_build_object('id', p.id, 'title', p.title)) FILTER (WHERE p.id IS NOT NULL), '[]') AS p"
      );
      expect(query.sql).toContain(
        "LEFT JOIN comments AS c ON c.post_id = users.id"
      );
      expect(query.sql).toContain(
        "COALESCE(json_agg(json_build_object('id', c.id, 'content', c.content)) FILTER (WHERE c.id IS NOT NULL), '[]') AS c"
      );
    });

    it("should generate an include query without an alias", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .include("posts", "id", "user_id") // No alias provided
        .toSQL();

      expect(query.sql).toContain(
        "LEFT JOIN posts AS posts ON posts.user_id = users.id"
      );
      expect(query.sql).toContain(
        "COALESCE(json_agg(posts.*) FILTER (WHERE posts.id IS NOT NULL), '[]') AS posts"
      );
    });

    it("should generate an include query with an alias", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .include("posts", "id", "user_id", "customAlias") // Alias provided
        .toSQL();

      expect(query.sql).toContain(
        "LEFT JOIN posts AS customAlias ON customAlias.user_id = users.id"
      );
      expect(query.sql).toContain(
        "COALESCE(json_agg(customAlias.*) FILTER (WHERE customAlias.id IS NOT NULL), '[]') AS customAlias"
      );
    });
  });

  // --- Error Handling Tests ---
  describe("Error Handling", () => {
    it("should throw an error when WHERE clause is missing a value", () => {
      expect(() => {
        // @ts-ignore
        db.from("users").where("id", "=", undefined).toSQL();
      }).toThrow();
    });

    it("should throw an error when using include without selecting base columns", () => {
      expect(() => {
        db.from("users")
          .include("posts", "id", "user_id", "p", (qb) =>
            qb.select("id", "title")
          )
          .toSQL();
      }).toThrow(
        "When using include, please explicitly call select() with at least one column."
      );
    });
  });

  // --- ORDER BY Tests ---
  describe("ORDER BY Queries", () => {
    it("should generate a query with ORDER BY ASC", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .orderBy("name", "ASC")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users ORDER BY users.name ASC"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with ORDER BY DESC", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .orderBy("name", "DESC")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users ORDER BY users.name DESC"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with multiple ORDER BY clauses", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .orderBy("name", "ASC")
        .orderBy("id", "DESC") // Multiple ORDER BY clauses
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users ORDER BY users.name ASC, users.id DESC"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- LIMIT and OFFSET Tests ---
  describe("LIMIT and OFFSET Queries", () => {
    it("should generate a query with LIMIT", () => {
      const query = db.from("users").select("id", "name").limit(10).toSQL();

      expect(query.sql).toBe("SELECT id, name FROM users AS users LIMIT 10");
      expect(query.params).toEqual([]);
    });

    it("should generate a query with OFFSET", () => {
      const query = db.from("users").select("id", "name").offset(5).toSQL();

      expect(query.sql).toBe("SELECT id, name FROM users AS users OFFSET 5");
      expect(query.params).toEqual([]);
    });

    it("should generate a query with LIMIT and OFFSET", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .limit(10)
        .offset(5)
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users LIMIT 10 OFFSET 5"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- GROUP BY Tests ---
  describe("GROUP BY Queries", () => {
    it("should generate a query with GROUP BY", () => {
      const query = db
        .from("users")
        .select("id") // Select base column
        .count("id", "user_count") // Use count method for aggregate
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, COUNT(users.id) AS user_count FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- HAVING Tests ---
  describe("HAVING Queries", () => {
    it("should generate a query with HAVING", () => {
      const query = db
        .from("users")
        .select("id") // Select base column
        .count("id", "user_count") // Use count method for aggregate
        .groupBy("id")
        .having("COUNT(id)", ">", 5) // HAVING clause remains the same
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, COUNT(users.id) AS user_count FROM users AS users GROUP BY users.id HAVING COUNT(id) > $1"
      );
      expect(query.params).toEqual([5]);
    });
  });

  // --- DISTINCT Tests ---
  describe("DISTINCT Queries", () => {
    it("should generate a query with DISTINCT", () => {
      const query = db.from("users").select("email").distinct().toSQL();

      expect(query.sql).toBe("SELECT DISTINCT email FROM users AS users");
      expect(query.params).toEqual([]);
    });
  });

  // --- COUNT Tests ---
  describe("COUNT Queries", () => {
    it("should generate a query with COUNT with an alias", () => {
      const query = db
        .from("users")
        .select("id")
        .count("id", "user_count") // Alias provided
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, COUNT(users.id) AS user_count FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- AGGREGATE Tests ---
  describe("Aggregate Queries", () => {
    it("should generate a query with SUM", () => {
      const query = db
        .from("users")
        .select("id")
        .aggregate("SUM", "id", "total_id")
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, SUM(users.id) AS total_id FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with AVG", () => {
      const query = db
        .from("users")
        .select("id")
        .aggregate("AVG", "id", "average_id")
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, AVG(users.id) AS average_id FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with MAX with an alias", () => {
      const query = db
        .from("users")
        .select("id")
        .aggregate("MAX", "id", "max_id") // Alias provided
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, MAX(users.id) AS max_id FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with MIN with an alias", () => {
      const query = db
        .from("users")
        .select("id")
        .aggregate("MIN", "id", "min_id") // Alias provided
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, MIN(users.id) AS min_id FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with COUNT with an alias", () => {
      const query = db
        .from("users")
        .select("id")
        .aggregate("COUNT", "id", "count_id") // Alias provided
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, COUNT(users.id) AS count_id FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with AVG with an alias", () => {
      const query = db
        .from("users")
        .select("id")
        .aggregate("AVG", "id", "average_id") // Alias provided
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, AVG(users.id) AS average_id FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with MAX with an alias", () => {
      const query = db
        .from("users")
        .select("id")
        .aggregate("MAX", "id", "max_id") // Alias provided
        .groupBy("id")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, MAX(users.id) AS max_id FROM users AS users GROUP BY users.id"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- CTE Queries ---
  describe("CTE Queries", () => {
    const db = createQueryBuilder<Schema>();

    it("should generate a query with a single CTE", () => {
      const cteQuery = db
        .from("posts")
        .select("user_id")
        .count("id", "post_count")
        .groupBy("user_id")
        .toSQL();

      const query = db
        .from("users")
        .with("post_counts", cteQuery) // Add the CTE
        .select("id", "name", "post_counts.post_count")
        .join(
          "INNER",
          "users",
          "post_counts",
          "id",
          "user_id",
          "post_counts",
          []
        )
        .toSQL();

      expect(query.sql).toBe(
        "WITH post_counts AS (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id) " +
          "SELECT id, name, post_counts.post_count FROM users AS users INNER JOIN post_counts ON users.id = post_counts.user_id"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with multiple CTEs", () => {
      const cte1 = db
        .from("posts")
        .select("user_id")
        .count("id", "post_count")
        .groupBy("user_id")
        .toSQL();

      const cte2 = db
        .from("comments")
        .select("post_id")
        .count("id", "comment_count")
        .groupBy("post_id")
        .toSQL();

      const query = db
        .from("users")
        .with("post_counts", cte1)
        .with("comment_counts", cte2)
        .select(
          "id",
          "name",
          "post_counts.post_count",
          "comment_counts.comment_count"
        )
        .join(
          "INNER",
          "users",
          "post_counts",
          "id",
          "user_id",
          "post_counts",
          []
        )
        .join(
          "INNER",
          "posts",
          "comment_counts",
          "id",
          "post_id",
          "comment_counts",
          []
        )
        .toSQL();

      expect(query.sql).toBe(
        "WITH post_counts AS (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id), " +
          "comment_counts AS (SELECT post_id, COUNT(comments.id) AS comment_count FROM comments AS comments GROUP BY comments.post_id) " +
          "SELECT id, name, post_counts.post_count, comment_counts.comment_count " +
          "FROM users AS users " +
          "INNER JOIN post_counts ON users.id = post_counts.user_id " +
          "INNER JOIN comment_counts ON posts.id = comment_counts.post_id"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with a CTE and WHERE clause", () => {
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
        .join(
          "INNER",
          "users",
          "post_counts",
          "id",
          "user_id",
          "post_counts",
          []
        )
        .where("post_counts.post_count", ">", 5)
        .toSQL();

      expect(query.sql).toBe(
        "WITH post_counts AS (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id) " +
          "SELECT id, name, post_counts.post_count FROM users AS users " +
          "INNER JOIN post_counts ON users.id = post_counts.user_id " +
          "WHERE post_counts.post_count > $1"
      );
      expect(query.params).toEqual([5]);
    });

    it("should generate a query with a CTE and ORDER BY clause", () => {
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
        .join(
          "INNER",
          "users",
          "post_counts",
          "id",
          "user_id",
          "post_counts",
          []
        )
        .orderBy("id", "DESC")
        .toSQL();

      expect(query.sql).toBe(
        "WITH post_counts AS (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id) " +
          "SELECT id, name, post_counts.post_count FROM users AS users " +
          "INNER JOIN post_counts ON users.id = post_counts.user_id " +
          "ORDER BY users.id DESC"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with a CTE and LIMIT clause", () => {
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
        .join(
          "INNER",
          "users",
          "post_counts",
          "id",
          "user_id",
          "post_counts",
          []
        )
        .limit(10)
        .toSQL();

      expect(query.sql).toBe(
        "WITH post_counts AS (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id) " +
          "SELECT id, name, post_counts.post_count FROM users AS users " +
          "INNER JOIN post_counts ON users.id = post_counts.user_id " +
          "LIMIT 10"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- Subqueries ---
  describe("Subqueries", () => {
    it("should generate a query with a subquery in SELECT", () => {
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

      expect(query.sql).toBe(
        "SELECT id, name, (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id) AS post_count FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generage a subquery in select with where", () => {
      const subquery = db
        .from("posts")
        .select("user_id")
        .count("id", "post_count")
        .where("user_id", "=", 1) // Add a WHERE clause to the subquery
        .groupBy("user_id")
        .toSQL();

      const query = db
        .from("users")
        .select("id", "name")
        .selectSubquery("post_count", subquery)
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts WHERE posts.user_id = $1 GROUP BY posts.user_id) AS post_count FROM users AS users"
      );
      expect(query.params).toEqual([1]);
    });

    it("should generate a query with a subquery in SELECT that includes parameters", () => {
      const subquery = db
        .from("posts")
        .select("user_id")
        .where("title", "LIKE", "%example%")
        .count("id", "post_count")
        .groupBy("user_id")
        .toSQL();

      const query = db
        .from("users")
        .select("id", "name")
        .selectSubquery("post_count", subquery)
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts WHERE posts.title LIKE $1 GROUP BY posts.user_id) AS post_count FROM users AS users"
      );
      expect(query.params).toEqual(["%example%"]);
    });

    it("should generate a query with a subquery in SELECT that selects multiple columns", () => {
      const subquery = db
        .from("posts")
        .select("user_id", "title")
        .count("id", "post_count")
        .groupBy("user_id", "title")
        .toSQL();

      const query = db
        .from("users")
        .select("id", "name")
        .selectSubquery("post_details", subquery)
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, (SELECT user_id, title, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id, posts.title) AS post_details FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with a subquery in WHERE", () => {
      const subquery = db
        .from("posts")
        .select("user_id")
        .count("id", "post_count")
        .groupBy("user_id")
        .toSQL();

      const query = db
        .from("users")
        .select("id", "name")
        .whereSubquery("id", "IN", subquery)
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name FROM users AS users WHERE id IN (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id)"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- Window Functions ---
  describe("Window Functions", () => {
    it("should generate a query with ROW_NUMBER", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "ROW_NUMBER",
          "id",
          "row_num",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "DESC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, ROW_NUMBER(users.id) OVER (PARTITION BY users.id ORDER BY users.email DESC) AS row_num FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with RANK", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "RANK",
          "id",
          "rank",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "ASC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, RANK(users.id) OVER (PARTITION BY users.id ORDER BY users.email ASC) AS rank FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with DENSE_RANK", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "DENSE_RANK",
          "id",
          "dense_rank",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "ASC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, DENSE_RANK(users.id) OVER (PARTITION BY users.id ORDER BY users.email ASC) AS dense_rank FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with NTILE", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "NTILE",
          "id",
          "ntile_4",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "ASC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, NTILE(users.id) OVER (PARTITION BY users.id ORDER BY users.email ASC) AS ntile_4 FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with LAG", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "LAG",
          "id",
          "lag_value",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "ASC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, LAG(users.id) OVER (PARTITION BY users.id ORDER BY users.email ASC) AS lag_value FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with LEAD", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "LEAD",
          "id",
          "lead_value",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "ASC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, LEAD(users.id) OVER (PARTITION BY users.id ORDER BY users.email ASC) AS lead_value FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with FIRST_VALUE", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "FIRST_VALUE",
          "id",
          "first_value",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "ASC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, FIRST_VALUE(users.id) OVER (PARTITION BY users.id ORDER BY users.email ASC) AS first_value FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with LAST_VALUE", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "LAST_VALUE",
          "id",
          "last_value",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "ASC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, LAST_VALUE(users.id) OVER (PARTITION BY users.id ORDER BY users.email ASC) AS last_value FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with NTH_VALUE", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "NTH_VALUE",
          "id",
          "nth_value_2",
          ["id"], // Use a valid column for partitioning
          [{ column: "email", direction: "ASC" }] // Use a valid column for ordering
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, NTH_VALUE(users.id) OVER (PARTITION BY users.id ORDER BY users.email ASC) AS nth_value_2 FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });
    it("should generate a query with a window function and PARTITION BY clause", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "ROW_NUMBER",
          "id",
          "row_num",
          ["email"], // Partition by email
          [{ column: "id", direction: "DESC" }] // Order by created_at
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, ROW_NUMBER(users.id) OVER (PARTITION BY users.email ORDER BY users.id DESC) AS row_num FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });
    it("should generate a query with a window function without PARTITION BY clause", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "RANK",
          "id",
          "rank",
          undefined, // No partitionBy
          [{ column: "id", direction: "ASC" }] // Order by created_at
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, RANK(users.id) OVER (ORDER BY users.id ASC) AS rank FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with a window function and multiple PARTITION BY columns", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "DENSE_RANK",
          "id",
          "dense_rank",
          ["email", "id"], // Partition by email and group_id
          [{ column: "id", direction: "DESC" }] // Order by created_at
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, DENSE_RANK(users.id) OVER (PARTITION BY users.email, users.id ORDER BY users.id DESC) AS dense_rank FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with a window function without PARTITION BY or ORDER BY", () => {
      const query = db
        .from("users")
        .select("id", "name")
        .window(
          "NTILE",
          "id",
          "ntile_4",
          undefined, // No partitionBy
          undefined // No orderBy
        )
        .toSQL();

      expect(query.sql).toBe(
        "SELECT id, name, NTILE(users.id) OVER () AS ntile_4 FROM users AS users"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- Upsert Tests ---
  describe("Upserts (ON CONFLICT)", () => {
    it("should generate an INSERT ON CONFLICT query", () => {
      const query = db
        .from("users")
        .insert({ id: 1, name: "Alice", email: "alice@example.com" })
        .onConflict(["id"], {
          name: "Alice Updated",
          email: "alice.updated@example.com",
        })
        .toSQL();

      expect(query.sql).toBe(
        "INSERT INTO users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email"
      );
      expect(query.params).toEqual([1, "Alice", "alice@example.com"]);
    });
  });

  // --- Transactions ---
  describe("Validation", () => {
    it("should throw an error for UPDATE without WHERE clause", () => {
      expect(() => {
        db.from("users").update({ name: "Alice" }).toSQL();
      }).toThrow("WHERE clause is required for UPDATE or DELETE operations.");
    });

    it("should throw an error for DELETE without WHERE clause", () => {
      expect(() => {
        db.from("users").delete().toSQL();
      }).toThrow("WHERE clause is required for UPDATE or DELETE operations.");
    });
  });

  // --- Aliases ---
  describe("Aliases", () => {
    it("should generate a query with aliases for tables and columns", () => {
      const query = db
        .from("users", "u")
        .select("u.id AS user_id", "u.name AS user_name")
        .toSQL();

      expect(query.sql).toBe(
        "SELECT u.id AS user_id, u.name AS user_name FROM users AS u"
      );
      expect(query.params).toEqual([]);
    });

    it("should generate a query with aliases for subqueries", () => {
      const subquery = db
        .from("posts")
        .select("user_id")
        .count("id", "post_count")
        .groupBy("user_id")
        .toSQL();

      const query = db
        .from("users", "u")
        .select("u.id AS user_id", "u.name AS user_name")
        .selectSubquery("p", subquery) // Alias provided
        .toSQL();

      expect(query.sql).toBe(
        "SELECT u.id AS user_id, u.name AS user_name, (SELECT user_id, COUNT(posts.id) AS post_count FROM posts AS posts GROUP BY posts.user_id) AS p FROM users AS u"
      );
      expect(query.params).toEqual([]);
    });
  });

  // --- Validation ---
  describe("Validation", () => {
    it("should throw an error if update or delete without where clause", () => {
      expect(() => {
        db.from("users").update({ name: "Alice" }).toSQL();
      }).toThrow("WHERE clause is required for UPDATE or DELETE operations.");

      expect(() => {
        db.from("users").delete().toSQL();
      }).toThrow("WHERE clause is required for UPDATE or DELETE operations.");
    });

    it("should not throw an error if unsafe delete is allowed", () => {
      const query = db.from("users").delete().allowUnsafeDelete().toSQL();
      expect(query.sql).toBe("DELETE FROM users");
      expect(query.params).toEqual([]);
    });
  });
});
