"""Environment-driven configuration for the Laya decisions host."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

log = logging.getLogger("laya.config")


def _env_str(key: str, default: str) -> str:
    value = os.environ.get(key)
    return default if value is None or value.strip() == "" else value.strip()


def _env_int(key: str, default: int) -> int:
    raw = _env_str(key, str(default))
    try:
        return int(raw)
    except ValueError:
        log.warning("%s=%r is not a whole number; using %s", key, raw, default)
        return default


def _env_float(key: str, default: float) -> float:
    raw = _env_str(key, str(default))
    try:
        return float(raw)
    except ValueError:
        log.warning("%s=%r is not a number; using %s", key, raw, default)
        return default


def _env_bool(key: str, default: bool) -> bool:
    return _env_str(key, "true" if default else "false").lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # --- Model ---------------------------------------------------------
    # Laya checkpoint to keep resident. "english" == ModernBERT-large 421M.
    checkpoint: str = field(default_factory=lambda: _env_str("LAYA_CHECKPOINT", "english"))
    # Repo id used by the direct-load fallback when Router refuses the checkpoint.
    repo_id: str = field(default_factory=lambda: _env_str("LAYA_REPO_ID", "convaiinnovations/laya"))
    # Optional subfolder for the direct-load fallback ("" for the English root).
    repo_subfolder: str = field(default_factory=lambda: _env_str("LAYA_REPO_SUBFOLDER", ""))
    # Name reported back to clients in the `model` response field.
    served_model_name: str = field(default_factory=lambda: _env_str("LAYA_SERVED_MODEL_NAME", "laya-english"))

    # --- Device --------------------------------------------------------
    # auto | xpu | cuda | cpu.  auto => xpu, then cuda, then cpu.
    device: str = field(default_factory=lambda: _env_str("LAYA_DEVICE", "auto").lower())
    # auto | float32 | float16 | bfloat16.  auto => float32 (safest).
    dtype: str = field(default_factory=lambda: _env_str("LAYA_DTYPE", "auto").lower())
    # If the requested accelerator cannot be used, fall back to CPU instead of failing startup.
    allow_cpu_fallback: bool = field(default_factory=lambda: _env_bool("LAYA_ALLOW_CPU_FALLBACK", True))

    # --- Runtime -------------------------------------------------------
    host: str = field(default_factory=lambda: _env_str("LAYA_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("LAYA_PORT", 8081))
    # Dummy predictions issued at startup so the first real request is not paying
    # for kernel JIT / lazy allocator warmup.
    warmup_iterations: int = field(default_factory=lambda: _env_int("LAYA_WARMUP_ITERATIONS", 3))
    # A decision that takes longer than this gets a 504 instead of holding the
    # client open. Forward passes are serialised, so this also bounds queueing.
    request_timeout_s: float = field(default_factory=lambda: _env_float("LAYA_REQUEST_TIMEOUT_S", 30.0))

    # --- Access ----------------------------------------------------------
    # When set, every /v1/* route requires `Authorization: Bearer <key>`; the
    # brain-traverse client sends it from BRAIN_DECISIONS_API_KEY. /healthz and
    # /metrics stay open so the container healthcheck and monitoring still work.
    api_key: str = field(default_factory=lambda: _env_str("LAYA_API_KEY", ""))

    # --- Brain-tree invariant -------------------------------------------
    # The <=15 branching rule from the architecture plan. 0 disables the check.
    choice_option_limit: int = field(default_factory=lambda: _env_int("LAYA_CHOICE_OPTION_LIMIT", 15))
    # false => log a warning and answer anyway; true => reject with 422.
    choice_option_limit_enforce: bool = field(
        default_factory=lambda: _env_bool("LAYA_CHOICE_OPTION_LIMIT_ENFORCE", False)
    )

    # --- Protocol -------------------------------------------------------
    # passthrough => hand `state` to Laya untouched; json => always serialise
    # dict/list state to a compact JSON string first.
    state_mode: str = field(default_factory=lambda: _env_str("LAYA_STATE_MODE", "passthrough").lower())
    log_level: str = field(default_factory=lambda: _env_str("LAYA_LOG_LEVEL", "INFO").upper())
    # Log one line per decision with the winning label and confidence.
    log_decisions: bool = field(default_factory=lambda: _env_bool("LAYA_LOG_DECISIONS", True))


settings = Settings()
