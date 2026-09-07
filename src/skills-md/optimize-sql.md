---
name: optimize-sql
description: Diagnose and fix a slow SQL query. Use when a query is slow, a page makes too many queries, or an execution plan needs reading.
---

# SQL optimisation

Read the plan before changing anything. `EXPLAIN` (or `EXPLAIN ANALYZE`) tells you what the
database actually does; guessing at it is how you add an index that helps nothing.

## Read the plan for the expensive node

Find the node with the highest cost: a sequential scan over a large table, a nested loop over
many rows, a sort that spills to disk. Optimise that node. A plan with ten cheap nodes and one
expensive one has exactly one thing to fix.

## The index that matches the query

- Index the columns in the `WHERE` and `JOIN` clauses, and for a sort, the `ORDER BY`.
- A composite index `(a, b, c)` serves a leftmost prefix: `a`, `a,b`, `a,b,c` — not
  `b` alone. Order the columns by the equality filters first, then the range, then the sort.
- A covering index includes every column the query reads, so the table is never touched. That
  is the fastest a read gets.

## Write the query so the index is usable

- `WHERE lower(email) = ...` cannot use a plain index on `email`; either store it lowered or
  use a functional index. A function on the column defeats the index.
- Leading `LIKE '%x'` cannot use a B-tree index; `LIKE 'x%'` can.
- `OR` across different columns often defeats an index; `UNION` of two indexed queries can be
  faster.

## Kill the N+1 first

Before any index: if the page runs one query per row, that is the fix. Batch with
`WHERE id IN (...)` or a join. Ten queries become one beats ten individually-fast queries.

## Measure the change

`EXPLAIN ANALYZE` before and after, against realistic data volume. An index that helps a
100-row table may not justify its write cost at 100 million. Report the timing you actually
measured, not the improvement you expected.
