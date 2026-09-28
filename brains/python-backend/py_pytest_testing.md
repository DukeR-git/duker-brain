---
id: py_pytest_testing
title: Testing with pytest
criteria: Writing Python backend tests - pytest fixtures and conftest, async tests, testing FastAPI endpoints with httpx, dependency_overrides, database isolation, mocking HTTP and time
---

# Testing with pytest

## Fixtures
Put shared fixtures in `conftest.py`; pytest finds them without imports. Scope
expensive ones (`scope="session"` for an engine or a container) and keep
per-test state function-scoped. A fixture that `yield`s cleans up after the test.

## Async tests
Use one async plugin and configure it once: `pytest-asyncio`
(`asyncio_mode = "auto"` in `[tool.pytest.ini_options]`) or AnyIO's plugin
(`@pytest.mark.anyio`), which FastAPI's own docs use.

## Testing FastAPI endpoints
```python
@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

async def test_read_user(client):
    response = await client.get("/users/1")
    assert response.status_code == 200
```
`ASGITransport` does not run the app's lifespan. If startup code matters, use
`asgi-lifespan`'s `LifespanManager`, or the synchronous `TestClient` inside a
`with` block, which does run it.

## Replace dependencies, not internals
```python
app.dependency_overrides[get_session] = lambda: test_session
app.dependency_overrides[current_user] = lambda: make_user(admin=True)
...
app.dependency_overrides.clear()   # in fixture teardown
```

## Database isolation
Test against real PostgreSQL (a container, or a test database), not SQLite:
the SQL dialects, types and locking differ. Isolate each test by running it
in a transaction that is rolled back, or by truncating tables between tests.
Run migrations once per session so tests also cover them.

## No network, no clock
- Mock outbound HTTP at the transport level: `respx` for httpx.
- Freeze time with `time-machine` or `freezegun` instead of sleeping.
- `monkeypatch.setenv` for settings; clear any `lru_cache` on `get_settings`.

## Habits
- `@pytest.mark.parametrize` for input tables instead of loops in one test.
- Assert on status code and body, and on side effects (rows written, calls made).
- `pytest -x --lf` reruns the last failures first while fixing them.
