"""Translation between the Jev wire format and Laya's in-process schema.

The two schemas are close but not identical, and Laya's exact answer key names
vary between checkpoints and releases. Everything here is written defensively:
read whatever Laya returned, normalise it into the documented Jev answer shape,
and never let a missing optional field turn into a 500.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any, Dict, List, Mapping, Optional

log = logging.getLogger("laya.translate")

# Candidate key names, most specific first, for each field we need out of Laya.
_CHOICE_KEYS = ("choice", "label", "answer", "value", "selected")
_SCORE_KEYS = ("score", "level", "expected_level", "value")
_NOUL_KEYS = ("noul", "probability", "p_true", "value", "prob")
_PROB_KEYS = ("probabilities", "probs", "distribution", "scores")
_CONFIDENCE_KEYS = ("confidence", "certainty", "max_prob")


def as_dict(obj: Any) -> Dict[str, Any]:
    """Coerce a Laya answer (dict, dataclass, pydantic model, ...) into a dict."""
    if obj is None:
        return {}
    if isinstance(obj, Mapping):
        return dict(obj)
    for attr in ("model_dump", "dict", "_asdict", "to_dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                result = fn()
                if isinstance(result, Mapping):
                    return dict(result)
            except Exception:
                continue
    if hasattr(obj, "__dict__"):
        return {k: v for k, v in vars(obj).items() if not k.startswith("_")}
    return {"value": obj}


def _first(source: Mapping[str, Any], keys, default=None):
    for key in keys:
        if key in source and source[key] is not None:
            return source[key]
    return default


def as_text(value: Any) -> str:
    """Flatten Jev's string|object|array content into text Laya can embed."""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _clean_probabilities(raw: Any) -> Optional[Dict[str, float]]:
    if not isinstance(raw, Mapping):
        return None
    out: Dict[str, float] = {}
    for key, value in raw.items():
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            out[str(key)] = number
    return out or None


# --------------------------------------------------------------------------
# Request: Jev questions -> Laya questions
# --------------------------------------------------------------------------


def questions_to_laya(questions: Mapping[str, Any]) -> Dict[str, Any]:
    """Normalise the validated request questions into Laya's ``predict`` schema."""
    out: Dict[str, Any] = {}

    for key, question in questions.items():
        payload = question if isinstance(question, Mapping) else as_dict(question)
        qtype = payload.get("type")
        instructions = as_text(payload.get("instructions", ""))

        if qtype == "choice":
            criteria = {}
            for label, description in (payload.get("criteria") or {}).items():
                # Jev allows a null description; Laya needs text per option, and
                # the label itself is the best available discriminator.
                criteria[str(label)] = as_text(description) if description is not None else str(label)
            out[key] = {"type": "choice", "instructions": instructions, "criteria": criteria}

        elif qtype == "score":
            out[key] = {
                "type": "score",
                "instructions": instructions,
                "criteria": [as_text(level) for level in (payload.get("criteria") or [])],
            }

        elif qtype == "noul":
            entry: Dict[str, Any] = {"type": "noul", "instructions": instructions}
            criteria = payload.get("criteria")
            if criteria:
                entry["criteria"] = {str(k): as_text(v) for k, v in criteria.items()}
            out[key] = entry

        else:  # pragma: no cover - the pydantic discriminator rejects these first
            raise ValueError("unsupported question type: {!r}".format(qtype))

    return out


def state_to_laya(state: Any, mode: str) -> Any:
    """``passthrough`` hands structured state to Laya as-is; ``json`` flattens it."""
    if mode == "json":
        return as_text(state)
    return state


# --------------------------------------------------------------------------
# Response: Laya answers -> Jev answers
# --------------------------------------------------------------------------


def _carry_extras(answer: Mapping[str, Any], result: Dict[str, Any]) -> None:
    """Pass through Laya-only diagnostics that a Jev client will simply ignore.

    ``action`` carries ``act_probability``, the model's own act/abstain signal -
    useful when tuning the traverser's confidence gate.
    """
    action = answer.get("action")
    if isinstance(action, Mapping):
        result["action"] = dict(action)


def _normalise_choice(answer: Mapping[str, Any], labels: List[str]) -> Dict[str, Any]:
    probabilities = _clean_probabilities(_first(answer, _PROB_KEYS))
    choice = _first(answer, _CHOICE_KEYS)

    if choice is None and probabilities:
        choice = max(probabilities, key=probabilities.get)
    if choice is None and labels:
        # Nothing usable came back; refuse rather than invent a route.
        raise ValueError("laya returned no choice and no probability distribution")

    confidence = _first(answer, _CONFIDENCE_KEYS)
    if confidence is None and probabilities:
        confidence = probabilities.get(str(choice), max(probabilities.values()))
    if probabilities is None and confidence is not None:
        probabilities = {str(choice): float(confidence)}

    result: Dict[str, Any] = {"type": "choice", "choice": str(choice)}
    if probabilities is not None:
        result["probabilities"] = probabilities
    if confidence is not None:
        result["confidence"] = float(confidence)
    _carry_extras(answer, result)
    return result


def _normalise_score(answer: Mapping[str, Any], levels: List[str]) -> Dict[str, Any]:
    score = _first(answer, _SCORE_KEYS)
    probabilities = _clean_probabilities(_first(answer, _PROB_KEYS))
    confidence = _first(answer, _CONFIDENCE_KEYS)

    legend = answer.get("legend")
    if not isinstance(legend, Mapping):
        legend = {str(index + 1): text for index, text in enumerate(levels)}

    result: Dict[str, Any] = {"type": "score", "legend": dict(legend)}
    if score is not None:
        try:
            result["score"] = float(score)
        except (TypeError, ValueError):
            result["score"] = score
    if probabilities is not None:
        result["probabilities"] = probabilities
    if confidence is not None:
        result["confidence"] = float(confidence)
    _carry_extras(answer, result)
    return result


def _normalise_noul(answer: Mapping[str, Any]) -> Dict[str, Any]:
    value = _first(answer, _NOUL_KEYS)
    result: Dict[str, Any] = {"type": "noul"}
    if value is not None:
        try:
            result["noul"] = float(value)
        except (TypeError, ValueError):
            result["noul"] = value
    confidence = _first(answer, _CONFIDENCE_KEYS)
    if confidence is not None:
        result["confidence"] = float(confidence)
    probabilities = _clean_probabilities(_first(answer, _PROB_KEYS))
    if probabilities is not None:
        result["probabilities"] = probabilities
    _carry_extras(answer, result)
    return result


def answers_to_jev(
    laya_result: Any,
    requested: Mapping[str, Any],
) -> Dict[str, Dict[str, Any]]:
    """Normalise Laya's ``predict`` output into Jev-shaped answers."""
    result = as_dict(laya_result)
    raw_answers = result.get("answers", result)
    if not isinstance(raw_answers, Mapping):
        raise ValueError("laya returned no answers map (got {})".format(type(raw_answers).__name__))

    out: Dict[str, Dict[str, Any]] = {}

    for key, question in requested.items():
        payload = question if isinstance(question, Mapping) else as_dict(question)
        qtype = payload.get("type")

        if key not in raw_answers:
            raise ValueError("laya did not answer question {!r}".format(key))
        answer = as_dict(raw_answers[key])

        if qtype == "choice":
            labels = [str(label) for label in (payload.get("criteria") or {})]
            normalised = _normalise_choice(answer, labels)
            # Guard against a label that is not one of the offered options; a
            # traverser would happily try to cd into a directory that is not there.
            if labels and normalised["choice"] not in labels:
                log.warning(
                    "laya answered %r for question %r, which is not one of %s",
                    normalised["choice"],
                    key,
                    labels,
                )
                normalised["off_menu"] = True
        elif qtype == "score":
            normalised = _normalise_score(answer, [as_text(x) for x in (payload.get("criteria") or [])])
        else:
            normalised = _normalise_noul(answer)

        out[key] = normalised

    return out


def routing_from_result(laya_result: Any) -> Dict[str, Any]:
    """Lift Laya's own routing metadata, when the checkpoint reports any."""
    result = as_dict(laya_result)
    routing = as_dict(result.get("routing"))
    return {
        "model": routing.get("model"),
        "repo": routing.get("repo"),
        "reason": routing.get("reason"),
    }


# --------------------------------------------------------------------------
# Usage accounting
# --------------------------------------------------------------------------


def billable_text(state: Any, questions: Mapping[str, Any]) -> str:
    """Everything the model actually reads, for token accounting."""
    parts: List[str] = [as_text(state)]
    for question in questions.values():
        payload = question if isinstance(question, Mapping) else as_dict(question)
        parts.append(as_text(payload.get("instructions", "")))
        criteria = payload.get("criteria")
        if isinstance(criteria, Mapping):
            for label, description in criteria.items():
                parts.append(str(label))
                if description is not None:
                    parts.append(as_text(description))
        elif isinstance(criteria, list):
            parts.extend(as_text(item) for item in criteria)
    return "\n".join(parts)


def usage_from_result(laya_result: Any) -> Optional[Dict[str, int]]:
    """Laya counts the tokens it actually encoded; prefer that over an estimate."""
    usage = as_dict(as_dict(laya_result).get("usage"))
    if "input_tokens" not in usage:
        return None
    try:
        return {
            "input_tokens": int(usage["input_tokens"]),
            "output_tokens": int(usage.get("output_tokens", 0)),
        }
    except (TypeError, ValueError):
        return None


def count_tokens(text: str, tokenizer: Any = None) -> int:
    """Exact count when the checkpoint's tokenizer is reachable, else ~4 chars."""
    if tokenizer is not None:
        try:
            encoded = tokenizer(text, add_special_tokens=False)
            ids = encoded["input_ids"] if isinstance(encoded, Mapping) else encoded
            if ids and isinstance(ids[0], list):
                ids = ids[0]
            return len(ids)
        except Exception:
            pass
    return max(1, len(text) // 4)
