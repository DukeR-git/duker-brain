"""A deliberately tiny latency recorder.

Phase 1.4 of the plan asks for a p50 check, and the traverser will want to know
whether a hop is drifting. That does not justify a Prometheus dependency, so we
keep a bounded ring buffer and compute percentiles on read.
"""

from __future__ import annotations

import threading
from collections import deque
from typing import Deque, Dict


class LatencyStats:
    def __init__(self, capacity: int = 1024) -> None:
        self._samples: Deque[float] = deque(maxlen=capacity)
        self._lock = threading.Lock()
        self.succeeded = 0
        self.errors = 0

    def observe(self, milliseconds: float) -> None:
        with self._lock:
            self._samples.append(milliseconds)
            self.succeeded += 1

    def observe_error(self) -> None:
        with self._lock:
            self.errors += 1

    def _percentile(self, ordered, fraction: float) -> float:
        if not ordered:
            return 0.0
        index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
        return ordered[index]

    def snapshot(self) -> Dict[str, float]:
        with self._lock:
            ordered = sorted(self._samples)
            succeeded, errors = self.succeeded, self.errors

        return {
            # Every request that reached a handler, answered or not.
            "requests": succeeded + errors,
            "succeeded": succeeded,
            "errors": errors,
            "samples": len(ordered),
            "p50_ms": round(self._percentile(ordered, 0.50), 2),
            "p90_ms": round(self._percentile(ordered, 0.90), 2),
            "p95_ms": round(self._percentile(ordered, 0.95), 2),
            "p99_ms": round(self._percentile(ordered, 0.99), 2),
            "min_ms": round(ordered[0], 2) if ordered else 0.0,
            "max_ms": round(ordered[-1], 2) if ordered else 0.0,
            "mean_ms": round(sum(ordered) / len(ordered), 2) if ordered else 0.0,
        }
