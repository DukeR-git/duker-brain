"""Settings parsing and the latency recorder."""

from __future__ import annotations

from app.config import Settings
from app.metrics import LatencyStats


def test_bad_numbers_fall_back_instead_of_crashing(monkeypatch):
    monkeypatch.setenv("LAYA_REQUEST_TIMEOUT_S", "soon")
    monkeypatch.setenv("LAYA_PORT", "eighty")
    settings = Settings()
    assert settings.request_timeout_s == 30.0
    assert settings.port == 8081


def test_api_key_and_blank_values(monkeypatch):
    monkeypatch.setenv("LAYA_API_KEY", "  secret  ")
    monkeypatch.setenv("LAYA_DEVICE", "   ")
    settings = Settings()
    assert settings.api_key == "secret"
    assert settings.device == "auto", "a blank value means the default"


def test_metrics_count_every_request():
    stats = LatencyStats()
    for ms in (10.0, 20.0, 30.0):
        stats.observe(ms)
    stats.observe_error()
    snapshot = stats.snapshot()
    assert snapshot["requests"] == 4
    assert snapshot["succeeded"] == 3
    assert snapshot["errors"] == 1
    assert snapshot["p50_ms"] == 20.0
    assert snapshot["max_ms"] == 30.0


def test_empty_metrics():
    snapshot = LatencyStats().snapshot()
    assert snapshot["requests"] == 0
    assert snapshot["p99_ms"] == 0.0
