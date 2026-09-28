#!/usr/bin/env python3
"""Phase 1.4.2 - latency benchmark.

Measures end-to-end HTTP latency (what the traverser actually feels) alongside
the server-reported inference time, so you can see how much is model and how
much is transport.

    python scripts/bench.py --base-url http://SERVER_IP:8081 -n 100
    python scripts/bench.py -n 300 --options 15 --concurrency 4

The gate from the plan: p50 <= 40ms on GPU for a single question.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import statistics
import sys
from typing import Dict, List

import httpx

CRITERIA_POOL = [
    ("fastapi_core", "FastAPI routing, request lifecycle, middleware, dependency injection"),
    ("asyncpg_pooling", "PostgreSQL connections, asyncpg pools, session management"),
    ("docker_deploy", "Dockerfile setups, container networking, compose files"),
    ("react_state", "React hooks, context, component state, rerender behaviour"),
    ("css_layout", "Flexbox, grid, responsive breakpoints, stacking contexts"),
    ("pytest_fixtures", "pytest fixtures, parametrisation, mocking, coverage"),
    ("github_actions", "CI workflows, matrix builds, caching, runner configuration"),
    ("terraform_modules", "Terraform providers, modules, state, plan and apply"),
    ("kafka_consumers", "Kafka topics, consumer groups, offsets, rebalancing"),
    ("redis_caching", "Redis keys, TTLs, eviction policies, pipelines"),
    ("observability", "Structured logging, tracing spans, metrics, alerting"),
    ("auth_oidc", "OAuth2 flows, OIDC, JWT validation, session cookies"),
    ("rust_ownership", "Rust borrow checker, lifetimes, traits, async runtimes"),
    ("sql_indexing", "Query plans, B-tree indexes, partial indexes, vacuum"),
    ("llm_prompting", "Prompt templates, few-shot examples, context windows"),
]

PROMPT = "How do I configure connection pooling for asyncpg in FastAPI?"


def percentile(ordered: List[float], fraction: float) -> float:
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
    return ordered[index]


def report(name: str, samples: List[float]) -> None:
    ordered = sorted(samples)
    if not ordered:
        print("  {:<22} no successful requests".format(name))
        return
    print(
        "  {:<22} n={:<5} min={:>7.1f}  p50={:>7.1f}  p90={:>7.1f}  p95={:>7.1f}  p99={:>7.1f}  max={:>7.1f}  mean={:>7.1f}".format(
            name,
            len(ordered),
            ordered[0],
            percentile(ordered, 0.50),
            percentile(ordered, 0.90),
            percentile(ordered, 0.95),
            percentile(ordered, 0.99),
            ordered[-1],
            statistics.fmean(ordered),
        )
    )


async def worker(
    client: httpx.AsyncClient,
    url: str,
    payload: Dict,
    queue: asyncio.Queue,
    wall: List[float],
    server: List[float],
    failures: List[str],
) -> None:
    loop = asyncio.get_running_loop()
    while True:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            return
        started = loop.time()
        try:
            # One failed request is a data point, not a reason to abandon the run.
            response = await client.post(url, json=payload)
            elapsed = (loop.time() - started) * 1000
            response.raise_for_status()
            wall.append(elapsed)
            server.append(response.json()["routing"]["latency_ms"])
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            failures.append("{}: {}".format(type(exc).__name__, exc))
        finally:
            queue.task_done()


async def run(args) -> int:
    base = args.base_url.rstrip("/")
    url = base + args.path
    criteria = dict(CRITERIA_POOL[: max(2, min(args.options, len(CRITERIA_POOL)))])

    payload = {
        "model": "jev-latest",
        "state": PROMPT,
        "questions": {
            "route_selection": {
                "type": "choice",
                "instructions": "Select the reference manual most relevant to the developer prompt.",
                "criteria": criteria,
            }
        },
    }

    limits = httpx.Limits(max_connections=max(args.concurrency, 1) + 2)
    headers = {"Authorization": "Bearer {}".format(args.api_key)} if args.api_key else {}
    async with httpx.AsyncClient(timeout=args.timeout, limits=limits, headers=headers) as client:
        health = (await client.get(base + "/healthz")).json()
        print("Target  : {}".format(url))
        print("Device  : {} (requested {})".format(health.get("device_active"), health.get("device_requested")))
        print("Dtype   : {}".format(health.get("dtype")))
        print("Options : {} per question".format(len(criteria)))
        print("Requests: {} at concurrency {}\n".format(args.n, args.concurrency))

        # Untimed warmup so the first sample is not an outlier.
        for _ in range(args.warmup):
            (await client.post(url, json=payload)).raise_for_status()

        queue: asyncio.Queue = asyncio.Queue()
        for _ in range(args.n):
            queue.put_nowait(None)

        wall: List[float] = []
        server: List[float] = []
        failures: List[str] = []
        loop = asyncio.get_running_loop()
        started = loop.time()
        await asyncio.gather(
            *(worker(client, url, payload, queue, wall, server, failures) for _ in range(max(args.concurrency, 1)))
        )
        total = loop.time() - started

    print("Latency (ms)")
    report("end-to-end HTTP", wall)
    report("server inference", server)
    print("\nThroughput: {:.1f} decisions/s over {:.2f}s".format(len(wall) / total, total))
    if failures:
        print("Failed requests: {} of {} (first: {})".format(len(failures), args.n, failures[0]))
    if not wall:
        print("\nNo request succeeded; nothing to judge.")
        return 1

    p50 = percentile(sorted(wall), 0.50)
    print("\nGate: p50 end-to-end <= {:.0f}ms".format(args.gate))
    if p50 <= args.gate:
        print("  PASS - p50 {:.1f}ms".format(p50))
        return 0
    print("  FAIL - p50 {:.1f}ms".format(p50))
    print(
        "  If device_active is 'cpu', the Arc card is not being used - check "
        "/healthz placement and scripts/host_preflight.sh."
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8081")
    parser.add_argument("--path", default="/v1/systemone")
    parser.add_argument("-n", type=int, default=100, help="timed requests")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--options", type=int, default=4, help="choice options per question (<=15)")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--gate", type=float, default=40.0, help="p50 budget in ms")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("LAYA_API_KEY", ""),
        help="bearer key, for a host started with LAYA_API_KEY (default: $LAYA_API_KEY)",
    )
    args = parser.parse_args()
    if args.n < 1 or args.concurrency < 1 or args.warmup < 0:
        parser.error("-n and --concurrency must be at least 1, and --warmup at least 0")
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
