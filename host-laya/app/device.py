"""Device placement helpers.

Upstream Laya picks its device with a fixed CUDA -> MPS -> CPU ladder and has no
Intel XPU branch. On an Intel Arc card we therefore build the agent on CPU and
relocate its torch modules onto ``xpu`` ourselves. Every step is best-effort and
verifiable: :func:`parameter_devices` reports where the weights actually ended
up, so the service can tell the truth in ``/healthz`` instead of assuming.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

import torch

log = logging.getLogger("laya.device")

_SCALARS = (str, bytes, bytearray, int, float, bool, complex, type(None))

_DTYPES = {
    "float32": torch.float32,
    "fp32": torch.float32,
    "float16": torch.float16,
    "fp16": torch.float16,
    "half": torch.float16,
    "bfloat16": torch.bfloat16,
    "bf16": torch.bfloat16,
}


def _xpu_available() -> bool:
    if not hasattr(torch, "xpu"):
        return False
    try:
        return bool(torch.xpu.is_available())
    except Exception:  # driver / runtime problems
        return False


def ensure_xpu_runtime() -> None:
    """Import IPEX only when torch has no usable native XPU support.

    torch >= 2.5 exposes ``torch.xpu`` natively and importing
    intel_extension_for_pytorch on top of it is unnecessary; older builds need it
    to register the backend.
    """
    if _xpu_available():
        return
    try:
        import intel_extension_for_pytorch  # noqa: F401

        log.info("loaded intel_extension_for_pytorch to provide the XPU backend")
    except ImportError:
        pass


def resolve_device(requested: str) -> str:
    """Turn ``auto``/``xpu``/``cuda``/``cpu`` into a concrete device string."""
    requested = (requested or "auto").lower()
    ensure_xpu_runtime()

    if requested == "auto":
        if _xpu_available():
            return "xpu"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"

    if requested.startswith("xpu"):
        if _xpu_available():
            return requested
        raise RuntimeError(
            "LAYA_DEVICE=xpu but torch reports no XPU device. Check that the container "
            "sees /dev/dri, that the host kernel driver (xe/i915) is loaded, and that "
            "torch was installed from the XPU wheel index."
        )

    if requested.startswith("cuda"):
        if torch.cuda.is_available():
            return requested
        raise RuntimeError("LAYA_DEVICE=cuda but torch reports no CUDA device.")

    return "cpu"


def resolve_dtype(requested: str, device: str) -> "torch.dtype | None":
    """``auto`` keeps the checkpoint dtype (fp32) everywhere.

    That is the only setting guaranteed not to trip dtype mismatches inside
    Laya's own tensor construction. Opt into bf16/fp16 explicitly once you have
    compared probabilities against the fp32 baseline.
    """
    requested = (requested or "auto").lower()
    if requested == "auto":
        return None
    if requested in _DTYPES:
        dtype = _DTYPES[requested]
        if device == "cpu" and dtype is torch.float16:
            log.warning("float16 on CPU is slow and poorly supported; keeping float32")
            return None
        return dtype
    log.warning("unknown LAYA_DTYPE=%r, keeping the checkpoint dtype", requested)
    return None


def _walk(root: Any, max_depth: int, max_nodes: int) -> Iterable[Any]:
    """Breadth-limited walk over an object graph, yielding every visited node."""
    seen: set[int] = set()
    stack: list[tuple[Any, int]] = [(root, 0)]
    visited = 0

    while stack and visited < max_nodes:
        obj, depth = stack.pop()
        oid = id(obj)
        if oid in seen or isinstance(obj, _SCALARS):
            continue
        seen.add(oid)
        visited += 1
        yield obj

        if depth >= max_depth or isinstance(obj, (torch.nn.Module, torch.Tensor)):
            # nn.Module.to() already covers the whole subtree; tensors are leaves.
            continue

        if isinstance(obj, (list, tuple, set, frozenset)):
            stack.extend((item, depth + 1) for item in obj)
        elif isinstance(obj, dict):
            stack.extend((item, depth + 1) for item in obj.values())
        elif hasattr(obj, "__dict__"):
            try:
                stack.extend((item, depth + 1) for item in vars(obj).values())
            except TypeError:
                pass


def collect_modules(root: Any, max_depth: int = 8, max_nodes: int = 20000) -> list:
    """Find the top-most ``nn.Module`` instances reachable from ``root``."""
    modules: list[torch.nn.Module] = []
    for obj in _walk(root, max_depth, max_nodes):
        if isinstance(obj, torch.nn.Module):
            modules.append(obj)
    return modules


def patch_device_attributes(root: Any, device: str, max_depth: int = 8) -> int:
    """Rewrite cached ``.device`` bookkeeping.

    Laya builds its input tensors from a remembered device attribute; after we
    move the weights, that attribute has to follow or the forward pass fails with
    a cpu/xpu mismatch.
    """
    target = torch.device(device)
    patched = 0
    for obj in _walk(root, max_depth, 20000):
        if isinstance(obj, (torch.nn.Module, torch.Tensor)):
            continue
        for attr in ("device", "_device", "torch_device"):
            current = getattr(obj, attr, None)
            if current is None or not isinstance(current, (str, torch.device)):
                continue
            if str(current) == str(target):
                continue
            try:
                setattr(obj, attr, target if isinstance(current, torch.device) else str(target))
                patched += 1
            except Exception:  # read-only property, __slots__, etc.
                continue
    return patched


def relocate(root: Any, device: str, dtype: "torch.dtype | None" = None) -> dict:
    """Move every reachable module onto ``device`` and report what happened."""
    modules = collect_modules(root)
    moved: list[str] = []
    failed: list[str] = []

    for module in modules:
        name = type(module).__name__
        try:
            if dtype is not None:
                module.to(device=device, dtype=dtype)
            else:
                module.to(device)
            module.eval()
            moved.append(name)
        except Exception as exc:
            failed.append("{}: {}".format(name, exc))
            log.warning("could not move %s to %s: %s", name, device, exc)

    patched = patch_device_attributes(root, device)
    return {
        "modules_found": len(modules),
        "modules_moved": moved,
        "modules_failed": failed,
        "device_attributes_patched": patched,
    }


def parameter_devices(root: Any) -> dict:
    """Ground truth: how many parameters currently live on each device."""
    counts: dict[str, int] = {}
    for module in collect_modules(root):
        for param in module.parameters(recurse=True):
            key = str(param.device)
            counts[key] = counts.get(key, 0) + param.numel()
    return counts


def empty_cache(device: str) -> None:
    try:
        if device.startswith("xpu") and hasattr(torch, "xpu"):
            torch.xpu.empty_cache()
        elif device.startswith("cuda"):
            torch.cuda.empty_cache()
    except Exception as exc:
        log.debug("empty_cache on %s failed: %s", device, exc)


def synchronize(device: str) -> None:
    """Make timings honest - accelerator queues are asynchronous."""
    try:
        if device.startswith("xpu") and hasattr(torch, "xpu"):
            torch.xpu.synchronize()
        elif device.startswith("cuda"):
            torch.cuda.synchronize()
    except Exception:
        pass


def describe() -> dict:
    """Device inventory for /healthz."""
    info: dict = {
        "torch_version": torch.__version__,
        "xpu_available": _xpu_available(),
        "cuda_available": bool(torch.cuda.is_available()),
    }
    if info["xpu_available"]:
        try:
            info["xpu_device_count"] = torch.xpu.device_count()
            info["xpu_devices"] = [
                torch.xpu.get_device_name(i) for i in range(torch.xpu.device_count())
            ]
        except Exception as exc:
            info["xpu_devices_error"] = str(exc)
    return info
