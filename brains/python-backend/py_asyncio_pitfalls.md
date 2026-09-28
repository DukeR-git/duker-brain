---
id: py_asyncio_pitfalls
title: asyncio Pitfalls
criteria: Correct asyncio code - blocking calls on the event loop, asyncio.to_thread, TaskGroup and gather, timeouts, cancellation, background tasks, limiting concurrency, shared HTTP clients
---

# asyncio Pitfalls

## Never block the event loop
One blocking call in an `async def` stalls every request the process is serving.

| Blocking | Async replacement |
|---|---|
| `requests.get` | `httpx.AsyncClient().get` |
| `time.sleep` | `await asyncio.sleep` |
| sync DB drivers (psycopg2) | asyncpg, or psycopg 3 async |
| file or CPU-heavy work | `await asyncio.to_thread(fn, *args)` |

CPU-bound work that takes seconds belongs in a process pool or a job queue,
not a thread: the GIL still serialises it.

## Run things concurrently, safely
Prefer `asyncio.TaskGroup` (Python 3.11+). If one task fails, the others are
cancelled and the errors are raised together:

```python
async with asyncio.TaskGroup() as tg:
    user = tg.create_task(fetch_user(uid))
    orders = tg.create_task(fetch_orders(uid))
```
`asyncio.gather` keeps the other tasks running after one fails unless you
handle it; with `return_exceptions=True` you must check every result.

## Timeouts
```python
async with asyncio.timeout(5):
    await client.get(url)
```
Every network call needs a timeout; httpx has a default of 5 seconds, most
other clients have none.

## Cancellation
`asyncio.CancelledError` is how shutdown and timeouts stop your code. Do not
swallow it: an `except Exception` does not catch it, but a bare `except:` or
`except BaseException` does, so re-raise it. Put cleanup in `finally`.

## Background tasks
`asyncio.create_task` holds only a weak reference: a task nobody keeps a
reference to can be garbage-collected before it finishes. Keep tasks in a set
and discard them when done, or use FastAPI's `BackgroundTasks` for small
after-response work. Anything that must survive a restart belongs in a queue.

## Bound concurrency
Firing 10,000 requests at once exhausts sockets and gets you rate-limited:

```python
limit = asyncio.Semaphore(20)
async def fetch(url):
    async with limit:
        return await client.get(url)
```

## Share clients
Create one `httpx.AsyncClient` per application (in the lifespan) and reuse it;
a client per request throws away connection pooling and TLS sessions.
