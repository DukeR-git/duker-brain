"""The Jev <-> Laya translation layer: pure functions, no model needed."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app import translate


def test_questions_are_normalised_for_laya():
    out = translate.questions_to_laya(
        {
            "route": {"type": "choice", "instructions": {"task": "pick"}, "criteria": {"a": "first", "b": None}},
            "level": {"type": "score", "instructions": "how bad", "criteria": ["low", {"x": 1}]},
            "gate": {"type": "noul", "instructions": "needed?"},
        }
    )
    assert out["route"]["instructions"] == '{"task":"pick"}'
    assert out["route"]["criteria"] == {"a": "first", "b": "b"}, "a null description falls back to the label"
    assert out["level"]["criteria"] == ["low", '{"x":1}']
    assert "criteria" not in out["gate"]


def test_state_passthrough_and_json_modes():
    state = {"prompt": "hi"}
    assert translate.state_to_laya(state, "passthrough") is state
    assert translate.state_to_laya(state, "json") == '{"prompt":"hi"}'


def test_choice_answer_is_filled_in_from_whatever_laya_returned():
    requested = {"route": {"type": "choice", "criteria": {"a": "x", "b": "y"}}}
    answers = translate.answers_to_jev({"answers": {"route": {"label": "b", "probs": {"a": 0.2, "b": 0.8}}}}, requested)
    assert answers["route"] == {"type": "choice", "choice": "b", "probabilities": {"a": 0.2, "b": 0.8}, "confidence": 0.8}


def test_choice_from_probabilities_alone_and_action_passthrough():
    requested = {"route": {"type": "choice", "criteria": {"a": "x", "b": "y"}}}
    answers = translate.answers_to_jev(
        {"route": {"probabilities": {"a": 0.9, "b": 0.1}, "action": {"act_probability": 0.7}}}, requested
    )
    assert answers["route"]["choice"] == "a"
    assert answers["route"]["action"] == {"act_probability": 0.7}


def test_off_menu_choice_is_flagged_not_hidden():
    requested = {"route": {"type": "choice", "criteria": {"a": "x", "b": "y"}}}
    answers = translate.answers_to_jev({"route": {"choice": "zzz", "confidence": 0.9}}, requested)
    assert answers["route"]["off_menu"] is True


def test_missing_answers_raise_value_error():
    requested = {"route": {"type": "choice", "criteria": {"a": "x", "b": "y"}}}
    with pytest.raises(ValueError, match="did not answer"):
        translate.answers_to_jev({"answers": {}}, requested)
    with pytest.raises(ValueError, match="no choice"):
        translate.answers_to_jev({"route": {}}, requested)


def test_score_and_noul_normalisation():
    requested = {
        "sev": {"type": "score", "criteria": ["low", "high"]},
        "gate": {"type": "noul"},
    }
    answers = translate.answers_to_jev({"sev": {"level": "2"}, "gate": {"p_true": "0.25"}}, requested)
    assert answers["sev"]["score"] == 2.0
    assert answers["sev"]["legend"] == {"1": "low", "2": "high"}
    assert answers["gate"]["noul"] == 0.25


def test_as_dict_handles_dataclasses_and_objects():
    @dataclass
    class Answer:
        choice: str
        confidence: float

    assert translate.as_dict(Answer("a", 0.5)) == {"choice": "a", "confidence": 0.5}
    assert translate.as_dict(None) == {}
    assert translate.as_dict(7) == {"value": 7}


def test_usage_prefers_laya_count_and_estimates_otherwise():
    assert translate.usage_from_result({"usage": {"input_tokens": "12"}}) == {"input_tokens": 12, "output_tokens": 0}
    assert translate.usage_from_result({}) is None
    assert translate.count_tokens("x" * 40) == 10
    assert translate.count_tokens("abc", tokenizer=lambda text, add_special_tokens: {"input_ids": [[1, 2]]}) == 2


def test_billable_text_includes_labels_and_descriptions():
    text = translate.billable_text("state", {"q": {"instructions": "i", "criteria": {"lab": "desc"}}})
    assert text.split("\n") == ["state", "i", "lab", "desc"]
