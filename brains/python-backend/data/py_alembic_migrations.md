---
id: py_alembic_migrations
title: Alembic Migrations
criteria: Changing a PostgreSQL schema with Alembic - autogenerate and reviewing revisions, constraint naming conventions, zero-downtime column changes, data migrations, running upgrades on deploy
---

# Alembic Migrations

## Setup
- For async projects start from the async template: `alembic init -t async migrations`.
- In `env.py`, set `target_metadata = Base.metadata`, and import every model
  module before it, or autogenerate will not see those tables.
- Give the metadata a naming convention so constraint names are stable across
  environments and migrations can drop them by name:

```python
Base.metadata.naming_convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}
```

## Autogenerate is a draft
`alembic revision --autogenerate -m "add orders.status"` compares models to the
database. Always read the result before committing it:
- a renamed table or column comes out as drop plus add, which loses data;
  rewrite it as `op.alter_column(..., new_column_name=...)` or `op.rename_table`
- some changes are not detected (for example server defaults unless
  `compare_server_default=True`, and some constraint changes)
- enum changes on PostgreSQL usually need hand-written SQL

## Changes that do not lock or break a live system
- **New NOT NULL column**: add it nullable, backfill in batches, then set NOT NULL
  in a later migration (or give it a server default).
- **Index on a large table**: `CREATE INDEX CONCURRENTLY`, which cannot run in
  a transaction:

```python
def upgrade():
    with op.get_context().autocommit_block():
        op.create_index("ix_orders_created_at", "orders", ["created_at"], postgresql_concurrently=True)
```
- **Dropping a column**: first deploy code that no longer reads it, then drop it.

## Data migrations
Do not import application models in a migration: they will change later and
the old migration breaks. Use `op.execute(...)` or a minimal table defined in
the migration with `sa.table(...)`.

## Running them
Run `alembic upgrade head` as a deploy step (a release job or init container),
not on application startup: several replicas starting at once would race.
Keep every migration reversible where possible, and test `downgrade` on a copy.
