---
id: asyncpg_pooling
title: asyncpg Connection Pooling
criteria: PostgreSQL connections, asyncpg pool sizing and lifespan setup, acquiring and releasing connections, PgBouncer transaction mode, statement cache errors
---

# asyncpg Connection Pooling

## Creating the pool
Create one pool in the FastAPI lifespan and reuse it. `asyncpg.create_pool()`
returns a pool that must be awaited, and closing it in the lifespan teardown
avoids leaked sockets on reload.

## Sizing
`min_size` should cover steady-state concurrency; `max_size` should stay below
`max_connections / number_of_app_instances`. A pool larger than the server
allows fails at checkout, not at startup, so the error surfaces under load.

## Acquiring
`async with pool.acquire() as conn:` returns the connection on exit even when
the body raises. Never hold a connection across an await that does I/O of its
own; that is how a pool of 20 ends up serving 3 requests.

## Transactions
`async with conn.transaction():` nests as a savepoint when one is already open.

## Statement cache
asyncpg caches prepared statements per connection. Behind PgBouncer in
transaction mode, set `statement_cache_size=0` or connections fail after the
first reuse.
