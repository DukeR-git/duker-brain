"""Download the checkpoint into the HF cache volume without starting the server.

Optional: the service downloads on first start anyway. Run this when you would
rather pay the download cost once, up front, than watch the first
``docker compose up`` sit in a red healthcheck.

    docker compose run --rm laya python -m app.prefetch

The allow-list mirrors what ``laya.Agent`` itself requests. The repo bundles all
three checkpoints (~1.16B parameters together); without the filter you would pull
the multilingual and typed-decisions weights you are not serving.
"""

from __future__ import annotations

import logging
import sys

from .config import settings

logging.basicConfig(level=logging.INFO, format="%(levelname)-8s %(message)s")
log = logging.getLogger("laya.prefetch")

# Subfolder inside convaiinnovations/laya for each checkpoint name.
SUBFOLDERS = {
    "english": None,
    "multilingual": "multilingual",
    "typed-decisions": "typed-decisions",
}

FILES = ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")


def main() -> int:
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        log.error("huggingface_hub is not installed in this image")
        return 1

    if not settings.repo_subfolder and settings.checkpoint not in SUBFOLDERS:
        log.error(
            "unknown LAYA_CHECKPOINT=%r; expected one of %s, or set LAYA_REPO_SUBFOLDER",
            settings.checkpoint,
            ", ".join(SUBFOLDERS),
        )
        return 2

    subfolder = settings.repo_subfolder or SUBFOLDERS[settings.checkpoint]
    prefix = "{}/".format(subfolder) if subfolder else ""
    patterns = [prefix + name for name in FILES]

    log.info("downloading %s (%s) into the shared HF cache", settings.repo_id, subfolder or "root")
    path = snapshot_download(repo_id=settings.repo_id, allow_patterns=patterns)
    log.info("checkpoint cached at %s", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
