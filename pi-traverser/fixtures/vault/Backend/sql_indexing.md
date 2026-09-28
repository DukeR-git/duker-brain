---
id: sql_indexing
title: SQL Indexing
criteria: Slow SQL queries, EXPLAIN ANALYZE query plans, B-tree and partial indexes, composite index column order, vacuum and bloat
---

# SQL Indexing

## Reading a plan
`EXPLAIN (ANALYZE, BUFFERS)` shows actual rows against estimated rows. A large
gap between the two is a statistics problem, not an index problem.

## Choosing an index
B-tree covers equality and range. Column order in a composite index matters:
the leading column must appear in the predicate for the index to be usable.

## Partial indexes
`WHERE deleted_at IS NULL` on the index keeps it small when most queries filter
the same way.

## Maintenance
Autovacuum reclaims dead tuples. A table with heavy updates and no vacuum grows
its index bloat until scans get slower despite the index existing.
