---
name: db
description: Design schemas, write migrations, or fix query and data problems. Use when adding a table, writing a migration, debugging a slow query, or choosing keys and indexes.
---

# Databases

The schema is the hardest thing to change in the whole system. Design it for the queries, not
the object model.

## Keys and constraints are the real schema

- Every table has a primary key; prefer a surrogate `id` unless a natural key is truly stable.
- Foreign keys and `NOT NULL` are not optional decoration — they are the constraints that stop
  bad data at the door instead of in application code six months later.
- Unique constraints belong on the thing that must be unique (email, slug), enforced by the
  database, not by a check-then-insert that races.

## Migrations are one-way and additive where possible

- Never edit a migration that has run anywhere. Add a new one.
- Destructive changes (drop column, rename, change type) are two migrations: add the new shape,
  deploy code that writes both, then remove the old in a later release. A single migration that
  renames a column breaks every old copy of the app still running.
- Test a migration against real data volume. `ALTER` on ten rows is instant; on ten million it
  locks the table.

## Indexes follow the queries

Index the columns you filter and join on, in the order the query uses them. A composite index
`(a, b)` serves `WHERE a` and `WHERE a, b` but not `WHERE b` alone. Read the query plan
(`EXPLAIN`) before adding one — a guess is an index that costs writes and serves nothing.

## The N+1 is the default bug

A query per row in a loop is the most common database performance defect. Fetch the set with a
join or a batched `WHERE id IN (...)`. If a page does one query per item, that is the fix
before any caching.
