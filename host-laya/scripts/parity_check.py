#!/usr/bin/env python3
"""Phase 1.4.3 - parity check against the remote Jev API.

Sends one identical payload to both backends and diffs the response structure,
so you know a client written against Jev can parse this service unchanged.

    TYPESAFE_API_KEY=sk-... python scripts/parity_check.py --base-url http://SERVER_IP:8081

Without a key it runs in structure-only mode: it validates the local response
against the documented Jev shape and skips the live comparison.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Set

import httpx

PAYLOAD: Dict[str, Any] = {
    "model": "jev-latest",
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
}

# What a Jev client is entitled to find. Anything this service adds on top
# (id, created_at, routing, warnings) is additive and safe to ignore.
REQUIRED_TOP_LEVEL: Set[str] = {"model", "answers", "usage"}
REQUIRED_CHOICE_FIELDS: Set[str] = {"type", "choice", "probabilities", "confidence"}


def check_structure(body: Dict[str, Any], source: str) -> bool:
    ok = True
    missing = REQUIRED_TOP_LEVEL - set(body)
    if missing:
        print("  [{}] missing top-level fields: {}".format(source, sorted(missing)))
        ok = False

    answer = (body.get("answers") or {}).get("route_selection")
    if not isinstance(answer, dict):
        print("  [{}] no route_selection answer".format(source))
        return False

    missing = REQUIRED_CHOICE_FIELDS - set(answer)
    if missing:
        print("  [{}] choice answer missing: {}".format(source, sorted(missing)))
        ok = False

    usage = body.get("usage")
    if not isinstance(usage, dict) or "input_tokens" not in usage:
        print("  [{}] usage.input_tokens missing".format(source))
        ok = False

    if ok:
        print("  [{}] structure ok - choice={!r} confidence={:.3f}".format(
            source, answer.get("choice"), float(answer.get("confidence", 0))
        ))
    return ok


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8081")
    parser.add_argument("--remote-url", default="https://api.typesafe.ai")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("LAYA_API_KEY", ""),
        help="bearer key for the local host, if it was started with LAYA_API_KEY (default: $LAYA_API_KEY)",
    )
    args = parser.parse_args()

    print("Local: {}/v1/systemone".format(args.base_url.rstrip("/")))
    local_headers = {"Authorization": "Bearer {}".format(args.api_key)} if args.api_key else {}
    with httpx.Client(timeout=args.timeout, headers=local_headers) as client:
        response = client.post(args.base_url.rstrip("/") + "/v1/systemone", json=PAYLOAD)
        response.raise_for_status()
        local = response.json()
    local_ok = check_structure(local, "local")
    if args.verbose:
        print(json.dumps(local, indent=2))

    api_key = os.environ.get("TYPESAFE_API_KEY")
    if not api_key:
        print("\nTYPESAFE_API_KEY not set - skipping the live Jev comparison.")
        print("Structure-only verdict: {}".format("PASS" if local_ok else "FAIL"))
        return 0 if local_ok else 1

    print("\nRemote: {}/v1/systemone".format(args.remote_url.rstrip("/")))
    with httpx.Client(timeout=args.timeout) as client:
        response = client.post(
            args.remote_url.rstrip("/") + "/v1/systemone",
            json=PAYLOAD,
            headers={"Authorization": "Bearer {}".format(api_key)},
        )
        response.raise_for_status()
        remote = response.json()
    remote_ok = check_structure(remote, "remote")
    if args.verbose:
        print(json.dumps(remote, indent=2))

    print("\nDiff")
    local_answer = local["answers"]["route_selection"]
    remote_answer = remote["answers"]["route_selection"]

    only_remote = set(remote_answer) - set(local_answer)
    only_local = set(local_answer) - set(remote_answer)
    if only_remote:
        print("  fields Jev returns that we do not: {}".format(sorted(only_remote)))
    if only_local:
        print("  extra fields we return (additive, safe): {}".format(sorted(only_local)))
    if not only_remote:
        print("  no missing fields - a Jev client parses this service unchanged")

    agree = local_answer.get("choice") == remote_answer.get("choice")
    print("  chosen label: local={!r} remote={!r} -> {}".format(
        local_answer.get("choice"), remote_answer.get("choice"),
        "agree" if agree else "DIFFER (different models; not a contract failure)",
    ))

    passed = local_ok and remote_ok and not only_remote
    print("\nVerdict: {}".format("PASS" if passed else "FAIL"))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
