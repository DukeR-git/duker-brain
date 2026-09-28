"""Laya lifecycle: load once, keep resident, answer fast.

Cold-loading a checkpoint costs 7-10 s (plus the download on a first start), so
the model is built once, in a background thread started from the FastAPI
lifespan, and never re-initialised per request. Loading in the background lets
the server answer ``/healthz`` with ``loading`` (and decisions with 503) instead
of refusing connections until the checkpoint is resident.

Forward passes run one at a time on a single worker thread: the asyncio event
loop is never blocked by a transformer forward pass, and a GPU shared with
llama.cpp is never asked to run overlapping graphs.

Device notes, from reading laya 0.3.x:

* ``Agent.__init__`` only special-cases ``cuda`` and ``mps``; any other
  ``torch.device`` is used as given. ``device="xpu"`` therefore works natively on
  an Intel Arc card, which is the path we take. :mod:`app.device` provides a
  relocation fallback for the case where a future version stops doing that.
* Laya enables autocast only on CUDA, so on XPU the model runs in the weights'
  own dtype. That makes ``LAYA_DTYPE=bfloat16`` a real lever rather than a no-op.
* On an inference-time OOM, Laya permanently moves itself to CPU and keeps
  serving. :meth:`LayaEngine.active_device` reads the agent's live device so
  ``/healthz`` reports that instead of what we asked for at startup.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import torch

from . import device as device_utils
from .config import Settings
from .errors import BadQuestion, EngineNotReady

__all__ = ["BadQuestion", "EngineNotReady", "LayaEngine"]

log = logging.getLogger("laya.engine")


class LayaEngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.agent: Any = None
        self.device: str = "cpu"
        self.dtype: Optional[torch.dtype] = None
        self.loader: str = "unloaded"
        self.tokenizer: Any = None
        self.placement: Dict[str, Any] = {}
        self.load_seconds: float = 0.0
        self.warmup_ms: List[float] = []
        self.load_error: Optional[str] = None

        # Set only once the weights are placed and warm, so no request can reach
        # a model that is still moving between devices.
        self._ready = threading.Event()
        self._lock = threading.Lock()
        # One worker: forward passes are serialised by design (see the module
        # docstring), so more threads would only queue on the lock.
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="laya-infer")
        self._loader: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    @property
    def status(self) -> str:
        """``loading``, ``ok`` or ``failed`` - what ``/healthz`` reports."""
        if self._ready.is_set():
            return "ok"
        return "failed" if self.load_error else "loading"

    def start_loading(self) -> threading.Thread:
        """Load in a background thread, recording a failure instead of raising it."""

        def run() -> None:
            try:
                self.load()
            except Exception as exc:  # reported through /healthz
                self.load_error = "{}: {}".format(type(exc).__name__, exc)
                log.exception("checkpoint failed to load")

        self._loader = threading.Thread(target=run, name="laya-load", daemon=True)
        self._loader.start()
        return self._loader

    def load(self) -> None:
        started = time.perf_counter()

        try:
            self.device = device_utils.resolve_device(self.settings.device)
        except RuntimeError as exc:
            if not self.settings.allow_cpu_fallback:
                raise
            log.error("%s -- falling back to CPU", exc)
            self.device = "cpu"

        self.dtype = device_utils.resolve_dtype(self.settings.dtype, self.device)
        log.info("loading laya checkpoint %r on %s", self.settings.checkpoint, self.device)

        self.agent, self.loader = self._build(self.device)
        self.tokenizer = getattr(self.agent, "tok", None) or self._find_tokenizer()

        if self.dtype is not None:
            # Laya only autocasts on CUDA, so on XPU/CPU the weight dtype is what
            # actually runs. Convert in place rather than hoping for autocast.
            device_utils.relocate(self.agent, self.device, self.dtype)

        self._settle_placement()

        self.load_seconds = time.perf_counter() - started
        log.info("checkpoint resident after %.1fs via %s", self.load_seconds, self.loader)

        self._warmup()
        self._ready.set()

    def _build(self, device: str):
        """Prefer Laya's Router; fall back to a direct checkpoint load."""
        import laya  # imported late so a missing wheel fails at load, not at import

        try:
            router_cls = laya.Router
            kwargs = self._supported_kwargs(
                router_cls.__init__,
                {"device": device, "preload": False, "max_loaded": 1},
            )
            router = router_cls(**kwargs)
            # Pin exactly one checkpoint. Without this, Laya's language detection
            # can pull a second 400M-parameter model into VRAM next to llama.cpp
            # the first time a non-English prompt arrives.
            router.preload([self.settings.checkpoint])
            return router, "Router(checkpoint={})".format(self.settings.checkpoint)
        except Exception as exc:
            log.warning("Router path failed (%s); trying laya.load()", exc)

        kwargs = self._supported_kwargs(
            laya.load, {"device": device, "subfolder": self.settings.repo_subfolder or None}
        )
        agent = laya.load(self.settings.repo_id, **{k: v for k, v in kwargs.items() if v is not None})
        return agent, "laya.load({})".format(self.settings.repo_id)

    @staticmethod
    def _supported_kwargs(fn: Any, candidates: Dict[str, Any]) -> Dict[str, Any]:
        """Pass only the kwargs this Laya version actually declares."""
        try:
            parameters = inspect.signature(fn).parameters
        except (TypeError, ValueError):
            return {}
        if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
            return dict(candidates)
        return {k: v for k, v in candidates.items() if k in parameters}

    def _find_tokenizer(self) -> Any:
        """Locate the checkpoint tokenizer, for the token-count fallback."""
        for obj in device_utils._walk(self.agent, max_depth=8, max_nodes=20000):
            if "Tokenizer" in type(obj).__name__ and callable(obj):
                return obj
        return None

    def _placement_share(self) -> tuple:
        counts = device_utils.parameter_devices(self.agent)
        total = sum(counts.values())
        family = self.device.split(":")[0]
        on_target = sum(n for dev, n in counts.items() if dev.startswith(family))
        return counts, (on_target / total if total else 0.0)

    def _settle_placement(self) -> None:
        """Confirm the weights really are where we asked, and fix it if not."""
        counts, share = self._placement_share()
        self.placement = {"parameter_devices": counts, "share_on_target": round(share, 4)}

        if not counts:
            log.warning("no torch parameters reachable on the agent; cannot verify placement")
            return

        if share >= 0.99 or self.device == "cpu":
            log.info("parameter placement: %s (%.1f%% on %s)", counts, share * 100, self.device)
            return

        log.warning(
            "only %.1f%% of parameters landed on %s; retrying with an explicit relocation",
            share * 100,
            self.device,
        )
        self.placement["relocation"] = device_utils.relocate(self.agent, self.device, self.dtype)
        counts, share = self._placement_share()
        self.placement["parameter_devices"] = counts
        self.placement["share_on_target"] = round(share, 4)

        if share >= 0.99:
            log.info("relocation succeeded: %s", counts)
            return

        message = "only {:.1f}% of parameters reached {}".format(share * 100, self.device)
        if not self.settings.allow_cpu_fallback:
            raise RuntimeError(message + "; set LAYA_ALLOW_CPU_FALLBACK=true to serve anyway")

        log.error("%s -- serving from CPU instead; expect ~200ms per decision", message)
        device_utils.relocate(self.agent, "cpu", None)
        self.device = "cpu"
        self.dtype = None
        self.placement["parameter_devices"], self.placement["share_on_target"] = self._placement_share()

    def _warmup(self) -> None:
        """Absorb lazy allocator setup and kernel JIT before serving traffic."""
        questions = {
            "warmup": {
                "type": "choice",
                "instructions": "Select the reference manual most relevant to the prompt.",
                "criteria": {
                    "backend": "server code, APIs, databases, background jobs",
                    "frontend": "UI components, styling, client-side state",
                },
            }
        }
        for index in range(max(0, self.settings.warmup_iterations)):
            started = time.perf_counter()
            try:
                self.predict_sync("How do I add an index to a Postgres table?", questions)
            except Exception as exc:
                log.warning("warmup iteration %d failed: %s", index + 1, exc)
                break
            self.warmup_ms.append((time.perf_counter() - started) * 1000)
        if self.warmup_ms:
            log.info(
                "warmup latencies: %s",
                ", ".join("{:.1f}ms".format(ms) for ms in self.warmup_ms),
            )

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    def active_device(self) -> str:
        """Where the agent is running *now*.

        Laya silently relocates itself to CPU if a forward pass hits an OOM, and
        a stale startup value would hide that behind mysterious 200ms decisions.
        """
        agent = self.agent
        if agent is None:
            return self.device

        device = getattr(agent, "device", None)
        if isinstance(device, torch.device):
            return str(device)

        loaded = getattr(agent, "_agents", None)  # Router keeps its agents here
        if isinstance(loaded, dict) and loaded:
            devices = sorted({str(getattr(a, "device", "?")) for a in loaded.values()})
            return devices[0] if len(devices) == 1 else ",".join(devices)

        return self.device

    def predict_sync(self, state: Any, questions: Dict[str, Any]) -> Any:
        if self.agent is None:
            raise EngineNotReady("laya checkpoint is not loaded yet")

        with self._lock, torch.inference_mode():
            try:
                result = self.agent.predict(state, questions)
            except ValueError as exc:
                # Laya raises ValueError when a question's options do not fit the
                # head budget. That is a bad request, not a server fault.
                if "exceed" in str(exc) or "head_max_len" in str(exc):
                    raise BadQuestion(str(exc)) from exc
                raise
            except TypeError as exc:
                if isinstance(state, str):
                    raise
                # Retry once with structured state flattened, rather than 500ing.
                log.info("predict rejected structured state (%s); retrying as JSON text", exc)
                from .translate import as_text

                result = self.agent.predict(as_text(state), questions)

            device_utils.synchronize(self.device)
            return result

    async def predict(self, state: Any, questions: Dict[str, Any]) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, self.predict_sync, state, questions)

    # ------------------------------------------------------------------
    # Teardown
    # ------------------------------------------------------------------

    def unload(self) -> None:
        log.info("unloading laya checkpoint")
        if self._loader is not None and self._loader.is_alive():
            # Stopping mid-load: let the load finish so its weights can be freed.
            self._loader.join(timeout=60)
        self._ready.clear()
        self._pool.shutdown(wait=True, cancel_futures=True)

        agent, self.agent = self.agent, None
        unload = getattr(agent, "unload", None)
        if callable(unload):
            try:
                unload()
            except Exception as exc:
                log.warning("agent.unload() failed: %s", exc)

        del agent
        device_utils.empty_cache(self.device)

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def info(self) -> Dict[str, Any]:
        return {
            "ready": self.ready,
            "status": self.status,
            "error": self.load_error,
            "checkpoint": self.settings.checkpoint,
            "served_model_name": self.settings.served_model_name,
            "loader": self.loader,
            "device_requested": self.settings.device,
            "device_active": self.active_device(),
            "device_at_load": self.device,
            "dtype": str(self.dtype) if self.dtype is not None else "checkpoint-default",
            "load_seconds": round(self.load_seconds, 2),
            "warmup_ms": [round(ms, 1) for ms in self.warmup_ms],
            "placement": self.placement,
            "torch": device_utils.describe(),
        }
