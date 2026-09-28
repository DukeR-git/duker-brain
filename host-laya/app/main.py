"""FastAPI service exposing Laya behind TypeSafe Jev's System One contract.

Routes
------
POST /v1/systemone   canonical Jev endpoint
POST /v1/decisions   alias used by the brain-tree architecture plan
GET  /healthz        readiness + real device placement
GET  /metrics        latency percentiles for the Phase 1.4 benchmark
GET  /v1/models      model list, for clients that probe capabilities
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, Dict

from fastapi import Depends, FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import __version__, translate
from .config import Settings, settings
from .errors import BadQuestion, EngineNotReady
from .metrics import LatencyStats
from .schemas import (
    ErrorBody,
    ErrorResponse,
    ModelCard,
    ModelList,
    RoutingInfo,
    SystemOneRequest,
    SystemOneResponse,
    Usage,
)

if TYPE_CHECKING:
    from .engine import LayaEngine

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
)
log = logging.getLogger("laya.api")


class Unauthorized(Exception):
    """A /v1/* request without the configured API key."""


class UpstreamError(Exception):
    """Laya answered, but not with something the Jev contract can carry."""


class DecisionTimeout(Exception):
    """A decision took longer than LAYA_REQUEST_TIMEOUT_S."""


def create_app(config: Settings = settings, engine: "LayaEngine | Any" = None) -> FastAPI:
    """Build the app. Tests pass their own settings and a stub engine, so they need no torch."""
    if engine is None:
        from .engine import LayaEngine  # torch is imported here, not at module load

        engine = LayaEngine(config)
    stats = LatencyStats()
    started_at = time.time()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Load in the background: the server answers /healthz with "loading"
        # (and decisions with 503) while the checkpoint downloads and warms up,
        # instead of refusing connections. The container healthcheck keys on
        # `ready`, so nothing routes traffic at a cold model either way.
        engine.start_loading()
        try:
            yield
        finally:
            engine.unload()

    app = FastAPI(
        title="Laya Decisions Host",
        description="Jev-compatible System One decisions API backed by a local Laya checkpoint.",
        version=__version__,
        lifespan=lifespan,
    )
    app.state.engine = engine
    app.state.stats = stats

    def require_key(request: Request) -> None:
        if not config.api_key:
            return
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(token.strip(), config.api_key):
            raise Unauthorized()

    def error(code: int, kind: str, message: str, param: str | None = None) -> JSONResponse:
        body = ErrorResponse(error=ErrorBody(type=kind, message=message, param=param))
        return JSONResponse(status_code=code, content=body.model_dump(exclude_none=True))

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError):
        stats.observe_error()
        # Jev answers 422 on validation failure; mirror that so client retry logic
        # written against the remote API behaves identically here.
        problems = []
        for item in exc.errors():
            where = ".".join(str(part) for part in item.get("loc", ()) if part != "body")
            problems.append("{}: {}".format(where or "request", item.get("msg", "invalid")))
        first = exc.errors()[0].get("loc", ()) if exc.errors() else ()
        param = str(first[1]) if len(first) > 1 else None
        return error(422, "invalid_request_error", "; ".join(problems), param=param)

    @app.exception_handler(Unauthorized)
    async def _unauthorized_handler(request: Request, exc: Unauthorized):
        return error(401, "authentication_error", "missing or wrong API key (send Authorization: Bearer <LAYA_API_KEY>)")

    @app.exception_handler(EngineNotReady)
    async def _not_ready_handler(request: Request, exc: EngineNotReady):
        stats.observe_error()
        message = (
            "the checkpoint failed to load: {}".format(engine.load_error)
            if engine.status == "failed"
            else "the checkpoint is still loading"
        )
        # Retry-After tells a client how long a loading host is worth waiting for.
        response = error(503, "service_unavailable", message)
        if engine.status == "loading":
            response.headers["retry-after"] = "5"
        return response

    @app.exception_handler(BadQuestion)
    async def _bad_question_handler(request: Request, exc: BadQuestion):
        stats.observe_error()
        # Laya could not encode the question - almost always too many options for the
        # 192-token head budget, which is the same constraint as the <=15 branch rule.
        return error(422, "invalid_request_error", str(exc), param="questions")

    @app.exception_handler(DecisionTimeout)
    async def _timeout_handler(request: Request, exc: DecisionTimeout):
        stats.observe_error()
        return error(504, "timeout", "the decision took longer than {:.0f}s".format(config.request_timeout_s))

    @app.exception_handler(UpstreamError)
    async def _upstream_handler(request: Request, exc: UpstreamError):
        stats.observe_error()
        log.error("laya returned an unusable answer: %s", exc)
        return error(502, "upstream_error", str(exc))

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception):
        stats.observe_error()
        # The details go to the log, not to whoever sent the request.
        log.exception("unhandled error on %s", request.url.path)
        return error(500, "internal_error", "internal error; see the service log")

    @app.get("/healthz")
    async def healthz() -> Dict[str, Any]:
        info = engine.info()
        info["uptime_s"] = round(time.time() - started_at, 1)
        return info

    @app.get("/metrics")
    async def metrics() -> Dict[str, Any]:
        return {
            "inference": stats.snapshot(),
            "device": engine.active_device(),
            "checkpoint": config.checkpoint,
        }

    @app.get("/v1/models", response_model=ModelList, dependencies=[Depends(require_key)])
    async def models() -> ModelList:
        return ModelList(data=[ModelCard(id=config.served_model_name)])

    async def decide(payload: SystemOneRequest) -> SystemOneResponse:
        if not engine.ready:
            raise EngineNotReady("laya checkpoint is not loaded yet")

        questions = {key: value.model_dump() for key, value in payload.questions.items()}
        warnings: list[str] = []

        limit = config.choice_option_limit
        if limit > 0:
            for key, question in questions.items():
                if question.get("type") != "choice":
                    continue
                count = len(question.get("criteria") or {})
                if count <= limit:
                    continue
                message = (
                    "question {!r} offers {} options; Laya reserves a fixed option-token "
                    "budget, so calibration degrades above {}. Split this node in the "
                    "brain tree.".format(key, count, limit)
                )
                if config.choice_option_limit_enforce:
                    raise RequestValidationError(
                        [{"loc": ("body", "questions", key, "criteria"), "msg": message, "type": "value_error"}]
                    )
                log.warning(message)
                warnings.append(message)

        laya_questions = translate.questions_to_laya(questions)
        laya_state = translate.state_to_laya(payload.state, config.state_mode)

        started = time.perf_counter()
        try:
            raw = await asyncio.wait_for(engine.predict(laya_state, laya_questions), timeout=config.request_timeout_s)
        except asyncio.TimeoutError as exc:
            raise DecisionTimeout() from exc
        latency_ms = (time.perf_counter() - started) * 1000
        stats.observe(latency_ms)

        try:
            answers = translate.answers_to_jev(raw, questions)
        except ValueError as exc:
            raise UpstreamError(str(exc)) from exc
        reported = translate.routing_from_result(raw)

        # Laya reports the tokens it actually encoded; fall back to counting the
        # payload ourselves only if a future version stops doing that.
        usage = translate.usage_from_result(raw)
        if usage is None:
            usage = {
                "input_tokens": translate.count_tokens(
                    translate.billable_text(payload.state, questions), engine.tokenizer
                ),
                "output_tokens": 0,
            }

        if config.log_decisions:
            for key, answer in answers.items():
                if answer.get("type") == "choice":
                    log.info(
                        "decision %s -> %s (confidence=%.3f, %.1fms)",
                        key,
                        answer.get("choice"),
                        float(answer.get("confidence") or 0.0),
                        latency_ms,
                    )

        return SystemOneResponse(
            id="dec_" + secrets.token_hex(6),
            model=config.served_model_name,
            created=int(time.time()),
            created_at=time.time(),
            answers=answers,
            usage=Usage(**usage),
            routing=RoutingInfo(
                model=reported.get("model") or config.checkpoint,
                device=engine.active_device(),
                latency_ms=round(latency_ms, 2),
                reason=reported.get("reason"),
                repo=reported.get("repo"),
            ),
            warnings=warnings,
        )

    @app.post(
        "/v1/systemone",
        response_model=SystemOneResponse,
        status_code=status.HTTP_200_OK,
        dependencies=[Depends(require_key)],
    )
    async def systemone(payload: SystemOneRequest) -> SystemOneResponse:
        return await decide(payload)

    @app.post(
        "/v1/decisions",
        response_model=SystemOneResponse,
        status_code=status.HTTP_200_OK,
        dependencies=[Depends(require_key)],
    )
    async def decisions(payload: SystemOneRequest) -> SystemOneResponse:
        """Alias for /v1/systemone, matching the brain-tree plan's client contract."""
        return await decide(payload)

    return app


def __getattr__(name: str) -> Any:
    # `uvicorn app.main:app` asks for this attribute; building it lazily keeps
    # `import app.main` free of torch for tests and tooling.
    if name == "app":
        instance = create_app()
        globals()["app"] = instance
        return instance
    raise AttributeError(name)


def run() -> None:  # `python -m app.main`
    import uvicorn

    if not settings.api_key and settings.host not in {"127.0.0.1", "localhost", "::1"}:
        log.warning(
            "LAYA_API_KEY is not set: any client that can reach port %s can use this GPU. "
            "Publish the port on 127.0.0.1 (LAYA_BIND_HOST) or set a key.",
            settings.port,
        )

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        workers=1,  # one process: the checkpoint stays resident in this one
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    run()
