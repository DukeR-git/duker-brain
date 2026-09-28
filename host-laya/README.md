# host-laya — self-hosted decisions service (optional)

A Jev-compatible decisions API backed by a local [Laya](https://pypi.org/project/laya/)
checkpoint, containerised for an **Intel Arc** GPU on Ubuntu, listening on
**:8081** next to your llama.cpp/Qwen server on :8080.

This is Part 1 of [the architecture plan](../docs/architecture-plan.md), and it
is **optional**: by default the router uses the hosted TypeSafe Jev API and needs
no server at all. This folder is a reference deployment for one specific box —
adapt it rather than expecting it to run unchanged elsewhere. It is not installed
by `pi install`.

```
Pi harness ──POST /v1/systemone──> :8081  host-laya (Laya, ~1.7 GB VRAM)
           └─────────────────────> :8080  llama.cpp (Qwen)
                                      └── same Arc card
```

---

## 1. Host prerequisites

The container ships the Intel user-space runtime, but the **kernel driver lives
on the host** and nothing in the image can substitute for it.

| Requirement | Why | Check |
|---|---|---|
| Kernel ≥ 6.12 | The `xe` driver for Arc B-series (Battlemage). Alchemist A-series works on `i915` with older kernels. | `uname -r` |
| `/dev/dri/renderD128` | The device node the container is given. | `ls -l /dev/dri` |
| `render` group GID | The container user must join it to open the node. | `getent group render` |
| Docker + compose v2 | | `docker compose version` |

On Ubuntu 24.04 with an older kernel:

```bash
sudo apt install linux-generic-hwe-24.04 && sudo reboot
```

Run the preflight script, which checks all of the above and writes the
host-specific GIDs into `.env`:

```bash
cd duker-brain/host-laya
chmod +x scripts/host_preflight.sh
./scripts/host_preflight.sh --write-env
```

## 2. Start it

```bash
docker compose up -d --build
```

The first start downloads the checkpoint (~1.7 GB) into a named volume, so the
container stays unhealthy for a few minutes. Watch it:

```bash
docker compose logs -f laya
```

Optionally pre-download first, so the healthcheck is not red while you wait:

```bash
docker compose run --rm laya python -m app.prefetch
```

Then confirm the GPU is actually being used:

```bash
curl -s http://localhost:8081/healthz | python3 -m json.tool
```

```json
{
  "ready": true,
  "device_requested": "xpu",
  "device_active": "xpu:0",
  "dtype": "checkpoint-default",
  "placement": { "parameter_devices": { "xpu:0": 395755008 }, "share_on_target": 1.0 },
  "torch": { "xpu_available": true, "xpu_devices": ["Intel(R) Arc(TM) Pro B-Series"] }
}
```

**`device_active` is the field that matters.** If it says `cpu`, you are getting
~200 ms decisions instead of ~35 ms — see [Troubleshooting](#7-troubleshooting).

## 3. Validate

```bash
# Phase 1.4.1 — functional: checks every field of the Jev contract
python3 scripts/smoke_test.py --base-url http://localhost:8081

# Phase 1.4.2 — latency: fails if p50 > 40 ms
python3 scripts/bench.py --base-url http://localhost:8081 -n 100

# ...and at the branching factor the tree actually uses
python3 scripts/bench.py -n 100 --options 15

# Phase 1.4.3 — parity with the remote Jev API (key optional)
python3 scripts/parity_check.py --base-url http://localhost:8081
```

The scripts only need `httpx`, so you can run them from your workstation
against the server's IP.

## 4. The API

Both paths take and return exactly the same thing:

| Path | Notes |
|---|---|
| `POST /v1/systemone` | Canonical — the path the real Jev API uses. |
| `POST /v1/decisions` | Alias, for the `/v1/decisions` name used in the plan. |
| `GET /healthz` | Readiness, live device, parameter placement, load time. |
| `GET /metrics` | Request count, errors, p50/p90/p95/p99. |
| `GET /v1/models` | Served model id. |
| `GET /docs` | Generated OpenAPI UI. |

### Request

```bash
curl -s http://localhost:8081/v1/systemone -H 'Content-Type: application/json' -d '{
  "model": "jev-latest",
  "state": "How do I configure connection pooling for asyncpg in FastAPI?",
  "questions": {
    "route_selection": {
      "type": "choice",
      "instructions": "Select the reference manual most relevant to the developer prompt.",
      "criteria": {
        "fastapi_core": "FastAPI routing, request lifecycle, middleware, and dependency injection",
        "asyncpg_pooling": "PostgreSQL database connections, asyncpg pools, and session management",
        "docker_deploy": "Dockerfile setups, container networking, and compose files"
      }
    }
  }
}' | python3 -m json.tool
```

`state` may be a string, an object, or an array. `model` is accepted and ignored —
send `"jev-latest"` and the same payload works against both backends.

Three question types, mixable in one call:

```jsonc
{ "type": "choice", "instructions": "...", "criteria": { "label": "description", "other": null } }
{ "type": "score",  "instructions": "...", "criteria": ["level 0", "level 1", "level 2"] }
{ "type": "noul",   "instructions": "..." }
```

### Response

```json
{
  "id": "dec_8f7b2c019a3e",
  "model": "laya-english",
  "created": 1790093235,
  "created_at": 1790093235.12,
  "answers": {
    "route_selection": {
      "type": "choice",
      "choice": "asyncpg_pooling",
      "confidence": 0.942,
      "probabilities": { "fastapi_core": 0.041, "asyncpg_pooling": 0.942, "docker_deploy": 0.017 },
      "action": { "act_probability": 0.88 }
    }
  },
  "usage": { "input_tokens": 118, "output_tokens": 0 },
  "routing": { "model": "english", "device": "xpu:0", "latency_ms": 34.2, "reason": "English Latin text" },
  "warnings": []
}
```

`model`, `answers` and `usage` are the Jev contract. `id`, `created_at`,
`routing`, `warnings` and `action` are additive — a Jev client ignores them, and
the traverser can use `routing.latency_ms` for its hop trace and
`action.act_probability` alongside `confidence` for its gate.

Errors use Jev's shape and status codes:

```json
{ "error": { "type": "invalid_request_error", "message": "...", "param": "questions" } }
```

`422` validation, `503` model not resident yet, `500` anything else. There is no
`401`: this deployment has no auth (see [Security](#6-security)).

## 5. Configuration

Everything is environment variables, set in `.env` (see `.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `LAYA_BIND_HOST` / `LAYA_PORT` | `0.0.0.0` / `8081` | Published address. |
| `RENDER_GID` / `VIDEO_GID` | `993` / `44` | Host group IDs — **must match your host**. |
| `LAYA_DEVICE` | `xpu` | `xpu` \| `cuda` \| `cpu` \| `auto`. |
| `LAYA_DTYPE` | `auto` | `auto` keeps fp32. See below. |
| `LAYA_ALLOW_CPU_FALLBACK` | `true` | `false` hard-fails startup if the Arc card is unusable. |
| `LAYA_CHECKPOINT` | `english` | `english` \| `multilingual` \| `typed-decisions`. |
| `LAYA_INFERENCE_WORKERS` | `1` | Concurrent forward passes. 1 keeps the shared GPU predictable. |
| `LAYA_WARMUP_ITERATIONS` | `3` | Dummy predictions at startup. |
| `LAYA_CHOICE_OPTION_LIMIT` | `15` | The plan's branching invariant. `0` disables the check. |
| `LAYA_CHOICE_OPTION_LIMIT_ENFORCE` | `false` | `false` warns and answers; `true` rejects with 422. |
| `ZE_AFFINITY_MASK` | *(unset)* | Pin Laya to one device when llama.cpp owns another. |

### About `LAYA_DTYPE`

Laya enables autocast **only on CUDA**, so on an Arc card the model runs in the
weights' own dtype — fp32. Setting `LAYA_DTYPE=bfloat16` converts the weights and
is a real speed/VRAM win here, not a no-op. It is not the default because it
changes numerics. If you switch, re-run `scripts/smoke_test.py` and compare the
probabilities against the fp32 baseline before trusting the tree.

### Running beside llama.cpp

Laya needs ~1.7 GB in fp32 (~0.9 GB in bf16) and holds it permanently. Start
llama.cpp with a layer count that leaves that headroom, or give each process its
own device with `ZE_AFFINITY_MASK`. Because `LAYA_INFERENCE_WORKERS=1`, Laya
submits at most one graph at a time and will not fight Qwen for the queue.

## 6. Security

This service binds `0.0.0.0:8081` with **no authentication**, as configured.
Anyone who can reach the port can spend your GPU. Restrict it at the firewall:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8081 proto tcp
```

To make it local-only instead, set `LAYA_BIND_HOST=127.0.0.1` in `.env` and
`docker compose up -d`.

## 7. Troubleshooting

**`device_active` is `cpu` but `LAYA_DEVICE=xpu`.**
Check `/healthz` → `torch.xpu_available`.
- `false` → the container cannot see the GPU. Run `./scripts/host_preflight.sh`,
  and verify `RENDER_GID` in `.env` matches `getent group render` on the host.
  Confirm from inside: `docker compose exec laya python -c "import torch; print(torch.xpu.is_available())"`.
- `true` but placement shows `cpu` → Laya hit an OOM mid-inference and moved
  itself to CPU permanently. Free VRAM on the llama.cpp side, or set
  `LAYA_DTYPE=bfloat16`, then restart the container.

**`Permission denied: '/dev/dri/renderD128'`.** `RENDER_GID` is wrong. Re-run the
preflight with `--write-env` and `docker compose up -d --force-recreate`.

**Build fails at `ERROR: torch ... is not an XPU build`.** A dependency pulled in
the stock PyPI torch. This check is deliberate — the build stops rather than
shipping an image that silently runs on CPU. Rebuild with `--no-cache`.

**`422 question 'x' options exceed head_max_len=192`.** More options than Laya's
option-token budget can encode. This is the hard form of the ≤15 branching rule:
split that node in the vault.

**Decisions look badly calibrated.** Laya's English checkpoint *collapses* on
non-English input while still reporting high confidence — it does not degrade
gently. If prompts may be non-English, set `LAYA_CHECKPOINT=multilingual`.

**Long prompts.** The English checkpoint's context is 512 tokens; anything past
that is truncated. For the traverser, send a leading slice of the user prompt
rather than an entire conversation.

## 8. Layout

```
host-laya/
├── docker-compose.yml        GPU passthrough, ports, env
├── Dockerfile                Intel runtime + torch-xpu + app
├── .env.example              copy to .env (preflight fills in the GIDs)
├── requirements.txt          torch installed separately, on purpose
├── app/
│   ├── main.py               FastAPI routes, error mapping, lifespan
│   ├── engine.py             load once, keep resident, serialise forwards
│   ├── device.py             XPU resolution, relocation fallback, verification
│   ├── schemas.py            Jev request/response contract
│   ├── translate.py          Jev <-> Laya, defensive answer normalisation
│   ├── metrics.py            latency ring buffer
│   └── prefetch.py           optional up-front checkpoint download
└── scripts/
    ├── host_preflight.sh     host checks + .env generation
    ├── smoke_test.py         Phase 1.4.1
    ├── bench.py              Phase 1.4.2
    └── parity_check.py       Phase 1.4.3
```

## 9. Where this deviates from the plan

| Plan says | Reality | What was done |
|---|---|---|
| `POST /v1/decisions` | Jev's real endpoint is `POST /v1/systemone`. | Both are served; `/v1/decisions` is an alias. |
| `Router(device="cuda")` | The Arc card is not CUDA; Laya's ladder is CUDA → MPS → CPU. | `device="xpu"` works natively (Laya passes through unknown device types); `app/device.py` keeps a relocation fallback and verifies placement either way. |
| Response has `created_at` + `routing` | Jev returns `model` / `answers` / `usage`. | Both — Jev fields plus the plan's tracing fields. |
| "≤ 15 options keeps calibration" | Laya raises hard above a 192-token option budget. | Checked at the API edge with a clear message; warn by default, `422` optionally. |
| Count tokens for `usage` | Laya already returns `usage.input_tokens`. | Laya's count is used; the estimator is a fallback. |

## 10. Pointing the router here

Set the decisions URL in `~/.config/brain-traverse/config.json` (or with
`BRAIN_DECISIONS_URL`); no API key is needed:

```json
{ "decisionsUrl": "http://<server>:8081" }
```

The client's default path, `/v1/systemone`, is served here as well as by Jev.
A local URL also gets a tighter default timeout (500 ms instead of 2 s), and
`brain-traverse health` reports `backend laya` plus the device it is running on.
