"""Request/response contracts.

Mirrors TypeSafe Jev's ``POST /v1/systemone`` schema so a client can point at
either this service or ``https://api.typesafe.ai`` without code changes. The
response is a superset: it carries Jev's ``model``/``answers``/``usage`` plus the
``id``/``created_at``/``routing`` fields the brain-tree plan logs for tracing.
"""

from __future__ import annotations

from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Jev accepts a string, a JSON object, or an array anywhere free text is expected.
Content = Union[str, Dict[str, Any], List[Any]]


class ChoiceQuestion(BaseModel):
    """Pick exactly one label. ``criteria`` maps label -> description."""

    model_config = ConfigDict(extra="allow")

    type: Literal["choice"]
    instructions: Content
    criteria: Dict[str, Optional[Content]]

    @field_validator("criteria")
    @classmethod
    def _at_least_two_options(cls, value: Dict[str, Optional[Content]]):
        if len(value) < 2:
            raise ValueError("a choice question needs at least 2 criteria entries")
        return value


class ScoreQuestion(BaseModel):
    """Ordinal rubric. ``criteria`` is an ordered list of level descriptions."""

    model_config = ConfigDict(extra="allow")

    type: Literal["score"]
    instructions: Content
    criteria: List[Content]

    @field_validator("criteria")
    @classmethod
    def _at_least_two_levels(cls, value: List[Content]):
        if len(value) < 2:
            raise ValueError("a score question needs at least 2 rubric levels")
        return value


class NoulQuestion(BaseModel):
    """Calibrated yes/no. ``criteria`` optionally describes the true/false sides."""

    model_config = ConfigDict(extra="allow")

    type: Literal["noul"]
    instructions: Content
    criteria: Optional[Dict[str, Content]] = None


Question = Annotated[
    Union[ChoiceQuestion, ScoreQuestion, NoulQuestion],
    Field(discriminator="type"),
]


class SystemOneRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    state: Content
    questions: Dict[str, Question]
    # Jev requires "jev-latest"; we accept anything and answer with the loaded
    # Laya checkpoint, so the same payload works against both backends.
    model: Optional[str] = None

    @field_validator("questions")
    @classmethod
    def _non_empty(cls, value: Dict[str, Question]):
        if not value:
            raise ValueError("at least one question is required")
        return value


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0


class RoutingInfo(BaseModel):
    """Non-Jev diagnostics: which checkpoint ran, where, and how fast."""

    model_config = ConfigDict(extra="allow")

    model: str
    device: str
    latency_ms: float
    reason: Optional[str] = None
    repo: Optional[str] = None


class SystemOneResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    model: str
    created: int
    created_at: float
    answers: Dict[str, Dict[str, Any]]
    usage: Usage
    routing: RoutingInfo
    # Populated when a question trips the <=15 branching invariant in warn mode.
    warnings: List[str] = Field(default_factory=list)


class ErrorBody(BaseModel):
    type: str
    message: str
    param: Optional[str] = None


class ErrorResponse(BaseModel):
    error: ErrorBody


class ModelCard(BaseModel):
    id: str
    object: str = "model"
    owned_by: str = "local-laya"


class ModelList(BaseModel):
    object: str = "list"
    data: List[ModelCard]
