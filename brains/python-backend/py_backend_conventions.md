---
id: py_backend_conventions
title: Python Backend Conventions
criteria: General Python backend conventions when no specific guide applies - typing, ruff, logging, configuration, time zones, errors and project hygiene
fallback: true
---

# Python Backend Conventions

The catch-all for Python backend work: used when a prompt is about Python
server code but no more specific guide fits.

- **Types**: annotate public functions and check them in CI (mypy or pyright).
  Use `X | None`, `list[str]` and `collections.abc` types, not `typing.List`.
- **Lint and format** with ruff (`ruff check`, `ruff format`); do not
  hand-format or argue about style in review.
- **Logging, not print**: `logger = logging.getLogger(__name__)` per module,
  configured once at startup. Log with context (request id, user id), never
  secrets or full request bodies.
- **Configuration from the environment**, validated at startup
  (pydantic-settings), so a missing variable fails the deploy, not the first request.
- **Time**: store and compute in UTC with aware datetimes,
  `datetime.now(UTC)`. `datetime.utcnow()` returns a naive value and is
  deprecated since Python 3.12. Convert to local time only for display.
- **Errors**: catch the narrowest exception you can handle; let the rest reach
  the framework's handler. Never `except Exception: pass`.
- **Paths**: `pathlib.Path`, not string concatenation.
- **No import-time side effects**: no connections or network calls at module
  level; create them in the app's startup.
- **Money** is `Decimal` (or integer cents), never `float`.
- **Idempotency**: retried requests and jobs should be safe to run twice; use
  unique constraints or idempotency keys rather than hoping.
