#!/usr/bin/env python3
"""Phase 1.4.1 - functional test.

Sends realistic brain-tree routing questions plus one score and one noul, then
checks the response against the Jev contract field by field. Exits non-zero on
the first contract violation so it can gate a deploy.

    python scripts/smoke_test.py --base-url http://SERVER_IP:8081
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List

import httpx

CASES: List[Dict[str, Any]] = [
    {
        "name": "root hop - database question",
        "expect": "backend",
        "state": "How do I configure connection pooling for asyncpg in FastAPI?",
        "questions": {
            "route_selection": {
                "type": "choice",
                "instructions": "Select the reference manual most relevant to the developer prompt.",
                "criteria": {
                    "backend": "Server-side APIs, databases, connection pooling, background jobs, auth",
                    "frontend": "React components, CSS, browser state, bundlers, accessibility",
                    "infrastructure": "Dockerfiles, Kubernetes manifests, CI pipelines, cloud provisioning",
                    "testing": "Unit tests, fixtures, mocking, coverage tooling, test runners",
                },
            }
        },
    },
    {
        "name": "leaf hop - within backend",
        "expect": "asyncpg_pooling",
        "state": "How do I configure connection pooling for asyncpg in FastAPI?",
        "questions": {
            "route_selection": {
                "type": "choice",
                "instructions": "Select the reference manual most relevant to the developer prompt.",
                "criteria": {
                    "fastapi_core": "FastAPI routing, request lifecycle, middleware, and dependency injection",
                    "asyncpg_pooling": "PostgreSQL database connections, asyncpg pools, and session management",
                    "docker_deploy": "Dockerfile setups, container networking, and compose files",
                },
            }
        },
    },
    {
        "name": "frontend prompt routes away from backend",
        "expect": "frontend",
        "state": "My flexbox layout collapses when the sidebar is hidden on mobile.",
        "questions": {
            "route_selection": {
                "type": "choice",
                "instructions": "Select the reference manual most relevant to the developer prompt.",
                "criteria": {
                    "backend": "Server-side APIs, databases, connection pooling, background jobs, auth",
                    "frontend": "React components, CSS layout, browser state, bundlers, accessibility",
                    "infrastructure": "Dockerfiles, Kubernetes manifests, CI pipelines, cloud provisioning",
                    "testing": "Unit tests, fixtures, mocking, coverage tooling, test runners",
                },
            }
        },
    },
    {
        "name": "mixed primitives in one call",
        "expect": None,
        "state": "Production is down, the payment webhook returns 500 for every request.",
        "questions": {
            "domain": {
                "type": "choice",
                "instructions": "Which reference manual applies?",
                "criteria": {
                    "payments": "Billing integrations, webhooks, Stripe, invoices",
                    "observability": "Logging, tracing, metrics, alerting",
                },
            },
            "severity": {
                "type": "score",
                "instructions": "How severe is this for end users?",
                "criteria": ["cosmetic", "degraded", "blocking", "outage"],
            },
            "needs_human": {
                "type": "noul",
                "instructions": "Does this require a human on-call engineer right now?",
            },
        },
    },
]


def fail(message: str) -> None:
    print("  FAIL: {}".format(message))
    raise SystemExit(1)


def check_choice(answer: Dict[str, Any], labels: List[str]) -> None:
    if answer.get("type") != "choice":
        fail("expected type 'choice', got {!r}".format(answer.get("type")))
    if "choice" not in answer:
        fail("choice answer has no 'choice' field: {}".format(answer))
    if answer["choice"] not in labels:
        fail("choice {!r} is not one of the offered labels {}".format(answer["choice"], labels))

    confidence = answer.get("confidence")
    if confidence is None:
        fail("choice answer has no 'confidence'")
    if not 0.0 <= float(confidence) <= 1.0:
        fail("confidence {} is outside [0, 1]".format(confidence))

    probabilities = answer.get("probabilities")
    if not isinstance(probabilities, dict):
        fail("choice answer has no probability distribution")
    total = sum(float(v) for v in probabilities.values())
    if not 0.9 <= total <= 1.1:
        fail("probabilities sum to {:.3f}, expected ~1.0".format(total))
    if answer["choice"] not in probabilities:
        fail("winning label missing from the probability map")


def check_score(answer: Dict[str, Any], levels: List[str]) -> None:
    if answer.get("type") != "score":
        fail("expected type 'score', got {!r}".format(answer.get("type")))
    if "score" not in answer:
        fail("score answer has no 'score' field: {}".format(answer))
    if not isinstance(answer.get("legend"), dict):
        fail("score answer has no legend")


def check_noul(answer: Dict[str, Any]) -> None:
    if answer.get("type") != "noul":
        fail("expected type 'noul', got {!r}".format(answer.get("type")))
    value = answer.get("noul")
    if value is None:
        fail("noul answer has no 'noul' field: {}".format(answer))
    if not 0.0 <= float(value) <= 1.0:
        fail("noul {} is outside [0, 1]".format(value))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8081")
    parser.add_argument("--path", default="/v1/systemone",
                        help="use /v1/decisions to exercise the plan's alias")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("LAYA_API_KEY", ""),
        help="bearer key, for a host started with LAYA_API_KEY (default: $LAYA_API_KEY)",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    headers = {"Authorization": "Bearer {}".format(args.api_key)} if args.api_key else {}

    print("Health")
    with httpx.Client(timeout=args.timeout, headers=headers) as client:
        response = client.get(base + "/healthz")
        if response.status_code != 200:
            fail("/healthz returned {}".format(response.status_code))
        health = response.json()
        print("  status          : {}".format(health.get("status")))
        if health.get("error"):
            print("  error           : {}".format(health.get("error")))
        print("  device requested: {}".format(health.get("device_requested")))
        print("  device active   : {}".format(health.get("device_active")))
        print("  dtype           : {}".format(health.get("dtype")))
        print("  loader          : {}".format(health.get("loader")))
        print("  load time       : {}s".format(health.get("load_seconds")))
        placement = (health.get("placement") or {}).get("parameter_devices")
        if placement:
            print("  parameters      : {}".format(placement))
            if health.get("device_active", "").startswith("xpu") and not any(
                k.startswith("xpu") for k in placement
            ):
                fail("device_active is xpu but no parameters live on xpu")
        if not health.get("ready"):
            fail("service is not ready")

        print("\nDecisions ({})".format(args.path))
        for case in CASES:
            payload = {"model": "jev-latest", "state": case["state"], "questions": case["questions"]}
            response = client.post(base + args.path, json=payload)
            if response.status_code == 401:
                fail("the host requires an API key: pass --api-key or set LAYA_API_KEY")
            if response.status_code != 200:
                fail("{} -> HTTP {}: {}".format(case["name"], response.status_code, response.text[:400]))

            body = response.json()
            for field in ("id", "model", "created", "answers", "usage", "routing"):
                if field not in body:
                    fail("response is missing required field {!r}".format(field))

            for key, question in case["questions"].items():
                if key not in body["answers"]:
                    fail("no answer for question {!r}".format(key))
                answer = body["answers"][key]
                if question["type"] == "choice":
                    check_choice(answer, list(question["criteria"]))
                elif question["type"] == "score":
                    check_score(answer, question["criteria"])
                else:
                    check_noul(answer)

            summary = []
            for key, answer in body["answers"].items():
                if answer["type"] == "choice":
                    summary.append("{}={} ({:.3f})".format(key, answer["choice"], answer["confidence"]))
                elif answer["type"] == "score":
                    summary.append("{}={}".format(key, answer["score"]))
                else:
                    summary.append("{}={:.3f}".format(key, answer["noul"]))

            latency = body["routing"]["latency_ms"]
            print("  [ok] {:<42} {:.1f}ms  {}".format(case["name"], latency, "  ".join(summary)))

            expected = case.get("expect")
            if expected:
                actual = body["answers"]["route_selection"]["choice"]
                if actual != expected:
                    # Not a contract violation - the model is allowed to disagree -
                    # but it is what you would investigate before trusting the tree.
                    print("       note: expected {!r}, model chose {!r}".format(expected, actual))

            if args.verbose:
                print(json.dumps(body, indent=2))

    print("\nAll contract checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
