---
id: py_packaging_uv
title: Packaging and Dependencies with uv
criteria: Managing a Python project's dependencies and environment - pyproject.toml, uv add, lockfiles, dev dependency groups, uv sync in CI and Docker, Python version pinning
---

# Packaging and Dependencies with uv

## One file describes the project
`pyproject.toml` holds metadata, dependencies and tool settings; no
`setup.py`, `requirements.txt` or `setup.cfg` in a new project.

```toml
[project]
name = "orders-api"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi>=0.115", "sqlalchemy[asyncio]>=2.0", "asyncpg"]

[dependency-groups]
dev = ["pytest", "pytest-asyncio", "ruff", "mypy"]
```

## Everyday commands
| Task | Command |
|---|---|
| start a project | `uv init` |
| add a dependency | `uv add httpx` |
| add a dev-only one | `uv add --dev pytest` |
| remove one | `uv remove httpx` |
| install exactly the lockfile | `uv sync --locked` |
| run a tool in the env | `uv run pytest` |
| pin the Python version | `uv python pin 3.12` (writes `.python-version`) |

`uv add` updates both `pyproject.toml` and `uv.lock`. Commit `uv.lock` for
applications so every machine and CI run gets the same versions; `--locked`
fails if the lockfile is out of date instead of silently re-resolving.

## Docker
Install dependencies before copying the source so the layer is cached until
the lockfile changes:

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY . .
RUN uv sync --locked --no-dev
```

## Version constraints
- Applications: lower bounds in `pyproject.toml`, exact versions in the lockfile.
- Libraries: lower bounds only; upper caps (`<2`) cause resolution conflicts for
  everyone who installs you.
- Upgrade deliberately: `uv lock --upgrade-package sqlalchemy`, then run the tests.

## Tool configuration
Keep ruff, pytest and mypy settings in `pyproject.toml` under `[tool.ruff]`,
`[tool.pytest.ini_options]` and `[tool.mypy]`, so there is one place to look.
