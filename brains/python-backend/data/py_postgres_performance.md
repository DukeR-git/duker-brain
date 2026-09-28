---
id: py_postgres_performance
title: PostgreSQL Query Performance
criteria: Slow PostgreSQL queries - EXPLAIN ANALYZE, choosing and ordering indexes, partial and trigram indexes, N+1 query patterns, keyset pagination instead of OFFSET
---

# PostgreSQL Query Performance

## Measure first
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```
Look for a `Seq Scan` on a large table where you expected an index, row
estimates far from actual rows (run `ANALYZE`), and sorts spilling to disk.
`ANALYZE` executes the query: wrap writes in a transaction you roll back.
Enable `pg_stat_statements` to find which queries cost the most in total.

## Indexes
- Index the columns in `WHERE`, `JOIN` and `ORDER BY` of hot queries; foreign
  keys are **not** indexed automatically in PostgreSQL.
- In a composite index put equality columns first, then the range or sort
  column: `(tenant_id, created_at)` serves
  `WHERE tenant_id = $1 ORDER BY created_at DESC`.
- Partial index for a hot subset: `CREATE INDEX ... WHERE status = 'pending'`.
- A function on the column (`lower(email)`) needs an expression index on that
  same expression.
- `LIKE 'abc%'` can use a btree index only with `text_pattern_ops` (or the C
  collation); `LIKE '%abc%'` needs `pg_trgm` with a GIN index.
- Every index slows writes and takes space: drop the ones `pg_stat_user_indexes`
  shows are never scanned.

## N+1 queries
Loading a list and then one query per row is the most common ORM slowdown.
Symptoms: many identical queries in the log for one request. Fix with eager
loading (`selectinload`) or a single join, and assert query counts in tests for
important endpoints.

## Pagination
`OFFSET 100000` still reads and discards 100,000 rows. Use keyset pagination:

```sql
SELECT * FROM orders
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT 50;
```
backed by an index on `(created_at, id)`. Return the last row's values as the cursor.

## Other habits
- Select only the columns you need for large rows and lists.
- `count(*)` on a big table is a full scan; show "more than N" or use an estimate.
- Batch inserts and updates instead of one round-trip per row.
- Set `statement_timeout` for web traffic so one bad query cannot hold a
  connection for minutes.
