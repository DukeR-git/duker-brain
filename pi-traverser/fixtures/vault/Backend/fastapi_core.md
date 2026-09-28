---
id: fastapi_core
title: FastAPI Core
criteria: FastAPI routing and routers, middleware, Depends dependency injection, lifespan startup and teardown, uvicorn workers
---

# FastAPI Core

## Routing
Declare routers per domain and mount them with a prefix on the app object.
Path operations return Pydantic models; FastAPI handles serialisation.

## Dependency injection
`Depends()` resolves per request and caches within the request scope. A
dependency that yields runs its teardown after the response is sent, which is
where session cleanup belongs.

## Lifespan
Use the async `lifespan` context manager for anything expensive that must stay
resident: connection pools, model checkpoints, background schedulers. Do not
build these per request.

## uvicorn
Run a single worker when the process holds resident state. Multiple workers each
get their own copy of everything the lifespan builds.
