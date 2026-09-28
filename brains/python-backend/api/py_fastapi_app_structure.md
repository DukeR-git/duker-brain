---
id: py_fastapi_app_structure
title: FastAPI App Structure
criteria: Organising a FastAPI project - APIRouter per domain, lifespan startup and shutdown, Depends dependency injection, pydantic-settings configuration, sync versus async endpoints
---

# FastAPI App Structure

## Layout
One router per domain, one app that assembles them. Handlers stay thin: parse
input, call a service function, return a schema.

```
app/
  main.py          create_app(), lifespan, include_router calls
  config.py        Settings (pydantic-settings)
  deps.py          shared dependencies: settings, db session, current user
  users/
    router.py      APIRouter(prefix="/users", tags=["users"])
    schemas.py     Pydantic models for this domain
    service.py     business logic, no FastAPI imports
```

```python
app = FastAPI(lifespan=lifespan)
app.include_router(users_router)
```

Keeping `service.py` free of FastAPI types means it can be called from a CLI,
a worker or a test without a request.

## Lifespan, not on_event
`@app.on_event("startup")` is deprecated. Open shared resources (engine, HTTP
client) in a lifespan context manager and close them after `yield`:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=10)
    yield
    await app.state.http.aclose()
```

## Dependencies
Use `Annotated` aliases so signatures stay short and the dependency is defined once:

```python
SessionDep = Annotated[AsyncSession, Depends(get_session)]

@router.get("/{user_id}")
async def read_user(user_id: int, session: SessionDep) -> UserRead: ...
```

A dependency that `yield`s gets its cleanup run after the response. Within one
request a dependency is cached, so several dependents share one session.

## Settings
```python
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str
    debug: bool = False

@lru_cache
def get_settings() -> Settings:
    return Settings()
```
Read settings through the dependency, not a module-level global, so tests can
replace them with `app.dependency_overrides[get_settings]`.

## async def or def
- `async def` handlers run on the event loop: never call blocking code in them
  (requests, time.sleep, a sync DB driver, heavy CPU).
- Plain `def` handlers run in a thread pool, so blocking calls are acceptable there.
- Mixing is fine; choose per endpoint by what it calls.
