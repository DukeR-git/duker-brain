"""The HTTP layer, against a stub engine: no torch, no checkpoint, no GPU."""

from __future__ import annotations

import asyncio
import dataclasses
import threading
import time
from typing import Any, Dict, Optional

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.errors import BadQuestion  # noqa: E402
from app.main import create_app  # noqa: E402

PAYLOAD = {
    "model": "jev-latest",
    "state": "How do I pool asyncpg connections?",
    "questions": {
        "route_selection": {
            "type": "choice",
            "instructions": "pick one",
            "criteria": {"backend": "server things", "frontend": "browser things"},
        }
    },
}


class StubEngine:
    """Stands in for LayaEngine: same surface, scripted behaviour."""

    def __init__(self, *, loads: bool = True, answer: Any = None, delay: float = 0.0):
        self._loads = loads
        self._ready = threading.Event()
        self.load_error: Optional[str] = None
        self.answer = answer if answer is not None else {"route_selection": {"choice": "backend", "probabilities": {"backend": 0.9, "frontend": 0.1}}}
        self.delay = delay
        self.tokenizer = None
        self.release = threading.Event()

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    @property
    def status(self) -> str:
        return "ok" if self.ready else ("failed" if self.load_error else "loading")

    def start_loading(self):
        def run():
            self.release.wait(5)
            if self._loads:
                self._ready.set()
            else:
                self.load_error = "RuntimeError: no XPU device"

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread

    def unload(self) -> None:
        self._ready.clear()

    def active_device(self) -> str:
        return "cpu"

    def info(self) -> Dict[str, Any]:
        return {"ready": self.ready, "status": self.status, "error": self.load_error, "device_active": "cpu"}

    async def predict(self, state: Any, questions: Dict[str, Any]) -> Any:
        if self.delay:
            await asyncio.sleep(self.delay)
        if isinstance(self.answer, Exception):
            raise self.answer
        return {"answers": self.answer, "usage": {"input_tokens": 7}}


def client_for(engine: StubEngine, **overrides: Any) -> TestClient:
    settings = dataclasses.replace(Settings(), log_decisions=False, **overrides)
    # Real clients get the 500 response, not the exception, so the tests do too.
    return TestClient(create_app(settings, engine), raise_server_exceptions=False)


def wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while not predicate():
        if time.time() > deadline:
            raise AssertionError("condition never became true")
        time.sleep(0.01)


def test_reports_loading_then_serves():
    engine = StubEngine()
    with client_for(engine) as client:
        health = client.get("/healthz").json()
        assert health["status"] == "loading"
        busy = client.post("/v1/systemone", json=PAYLOAD)
        assert busy.status_code == 503
        assert busy.headers["retry-after"] == "5"

        engine.release.set()
        wait_until(lambda: engine.ready)
        assert client.get("/healthz").json()["status"] == "ok"
        response = client.post("/v1/systemone", json=PAYLOAD)
        assert response.status_code == 200
        body = response.json()
        assert body["answers"]["route_selection"]["choice"] == "backend"
        assert body["usage"]["input_tokens"] == 7


def test_reports_a_failed_load():
    engine = StubEngine(loads=False)
    engine.release.set()
    with client_for(engine) as client:
        wait_until(lambda: engine.load_error is not None)
        health = client.get("/healthz").json()
        assert health["status"] == "failed"
        response = client.post("/v1/decisions", json=PAYLOAD)
        assert response.status_code == 503
        assert "failed to load" in response.json()["error"]["message"]


def test_api_key_guards_v1_but_not_health():
    engine = StubEngine()
    engine.release.set()
    with client_for(engine, api_key="secret") as client:
        wait_until(lambda: engine.ready)
        assert client.get("/healthz").status_code == 200
        assert client.get("/v1/models").status_code == 401
        assert client.post("/v1/systemone", json=PAYLOAD).status_code == 401
        wrong = {"Authorization": "Bearer nope"}
        assert client.post("/v1/systemone", json=PAYLOAD, headers=wrong).status_code == 401
        right = {"Authorization": "Bearer secret"}
        assert client.get("/v1/models", headers=right).status_code == 200
        assert client.post("/v1/systemone", json=PAYLOAD, headers=right).status_code == 200


def test_slow_decisions_time_out_with_504():
    engine = StubEngine(delay=0.5)
    engine.release.set()
    with client_for(engine, request_timeout_s=0.05) as client:
        wait_until(lambda: engine.ready)
        response = client.post("/v1/systemone", json=PAYLOAD)
        assert response.status_code == 504


def test_unusable_answers_are_502_and_errors_do_not_leak_details():
    engine = StubEngine(answer={})
    engine.release.set()
    with client_for(engine) as client:
        wait_until(lambda: engine.ready)
        assert client.post("/v1/systemone", json=PAYLOAD).status_code == 502

    engine = StubEngine(answer=RuntimeError("secret internals at /opt/venv"))
    engine.release.set()
    with client_for(engine) as client:
        wait_until(lambda: engine.ready)
        response = client.post("/v1/systemone", json=PAYLOAD)
        assert response.status_code == 500
        assert "secret internals" not in response.text


def test_validation_errors_are_readable():
    engine = StubEngine()
    engine.release.set()
    with client_for(engine) as client:
        wait_until(lambda: engine.ready)
        bad = {**PAYLOAD, "questions": {"q": {"type": "choice", "instructions": "x", "criteria": {"only": "one"}}}}
        response = client.post("/v1/systemone", json=bad)
        assert response.status_code == 422
        message = response.json()["error"]["message"]
        assert "at least 2 criteria" in message
        assert "[{" not in message, "not a Python repr"

        engine.answer = BadQuestion("options exceed head_max_len=192")
        assert client.post("/v1/systemone", json=PAYLOAD).status_code == 422


def test_option_limit_warns_or_rejects():
    many = {f"o{i}": "option" for i in range(16)}
    payload = {**PAYLOAD, "questions": {"route_selection": {"type": "choice", "instructions": "x", "criteria": many}}}
    answer = {"route_selection": {"choice": "o1", "probabilities": {"o1": 0.9}}}

    engine = StubEngine(answer=answer)
    engine.release.set()
    with client_for(engine) as client:
        wait_until(lambda: engine.ready)
        body = client.post("/v1/systemone", json=payload).json()
        assert "16 options" in body["warnings"][0]

    engine = StubEngine(answer=answer)
    engine.release.set()
    with client_for(engine, choice_option_limit_enforce=True) as client:
        wait_until(lambda: engine.ready)
        assert client.post("/v1/systemone", json=payload).status_code == 422


def test_importing_the_app_module_does_not_import_torch():
    import sys

    import app.main  # noqa: F401

    assert "torch" not in sys.modules or "app.engine" in sys.modules
