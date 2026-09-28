#!/usr/bin/env bash
# Checks the Ubuntu host can actually give a container the Arc GPU, and
# optionally writes the host-specific GIDs into .env.
#
#   ./scripts/host_preflight.sh
#   ./scripts/host_preflight.sh --write-env
#
# Everything here is read-only except --write-env.

set -uo pipefail

WRITE_ENV=0
[[ "${1:-}" == "--write-env" ]] && WRITE_ENV=1

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
WARNINGS=0

ok()   { printf '  \033[32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m[warn]\033[0m %s\n' "$*"; WARNINGS=$((WARNINGS+1)); }
bad()  { printf '  \033[31m[FAIL]\033[0m %s\n' "$*"; FAILURES=$((FAILURES+1)); }
head2(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

head2 "Kernel and driver"
printf '  kernel: %s\n' "$(uname -r)"
KVER=$(uname -r | cut -d. -f1-2)
if [[ "$(printf '%s\n6.12\n' "$KVER" | sort -V | head -1)" == "6.12" ]]; then
  ok "kernel >= 6.12 (Battlemage B-series needs this for the xe driver)"
else
  warn "kernel $KVER is older than 6.12; Arc B-series support may be missing. On Ubuntu 24.04: sudo apt install linux-generic-hwe-24.04"
fi

if lsmod | grep -qE '^(xe|i915)\b'; then
  ok "GPU kernel module loaded: $(lsmod | grep -oE '^(xe|i915)' | head -1)"
else
  bad "neither xe nor i915 is loaded; the container cannot see a GPU"
fi

head2 "Render nodes"
shopt -s nullglob
NODES=(/dev/dri/renderD*)
if (( ${#NODES[@]} )); then
  for node in "${NODES[@]}"; do
    ok "$node  ($(stat -c '%U:%G %a' "$node"))"
  done
else
  bad "no /dev/dri/renderD* nodes found"
fi

if command -v lspci >/dev/null 2>&1; then
  GPUS=$(lspci -nn | grep -iE 'vga|display|3d' || true)
  [[ -n "$GPUS" ]] && printf '  %s\n' "$GPUS"
fi

head2 "Group IDs (needed by docker-compose group_add)"
RENDER_GID=$(getent group render | cut -d: -f3)
VIDEO_GID=$(getent group video  | cut -d: -f3)
if [[ -n "$RENDER_GID" ]]; then ok "render gid = $RENDER_GID"; else bad "no 'render' group on this host"; fi
if [[ -n "$VIDEO_GID"  ]]; then ok "video  gid = $VIDEO_GID";  else warn "no 'video' group on this host"; fi

# The group that owns the render node is the one the container must join. It is
# normally `render`, but a distro or udev rule can differ - check, not assume.
for node in "${NODES[@]}"; do
  NODE_GID=$(stat -c '%g' "$node")
  if [[ -n "$RENDER_GID" && "$NODE_GID" == "$RENDER_GID" ]]; then
    ok "$node is owned by the render group ($NODE_GID)"
  elif [[ -n "$VIDEO_GID" && "$NODE_GID" == "$VIDEO_GID" ]]; then
    ok "$node is owned by the video group ($NODE_GID)"
  else
    bad "$node is owned by gid $NODE_GID, which is neither RENDER_GID nor VIDEO_GID; set RENDER_GID=$NODE_GID in .env"
    RENDER_GID=$NODE_GID
  fi
done

ENV_FILE="$REPO_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  ENV_RENDER=$(grep -E '^RENDER_GID=' "$ENV_FILE" | cut -d= -f2)
  if [[ -n "$ENV_RENDER" && -n "$RENDER_GID" && "$ENV_RENDER" != "$RENDER_GID" ]]; then
    bad ".env has RENDER_GID=$ENV_RENDER but the host needs $RENDER_GID (re-run with --write-env)"
  fi
  if grep -qE '^LAYA_BIND_HOST=0\.0\.0\.0' "$ENV_FILE" && ! grep -qE '^LAYA_API_KEY=.+' "$ENV_FILE"; then
    warn ".env publishes the port on every interface with no LAYA_API_KEY; anyone on the network can use the GPU"
  fi
fi

head2 "Docker"
if command -v docker >/dev/null 2>&1; then
  ok "docker: $(docker --version)"
  if docker compose version >/dev/null 2>&1; then
    ok "compose: $(docker compose version --short)"
  else
    bad "'docker compose' (v2 plugin) not available"
  fi
else
  bad "docker is not installed"
fi

head2 "Free VRAM (llama.cpp is probably already holding some)"
if command -v xpu-smi >/dev/null 2>&1; then
  xpu-smi stats -d 0 2>/dev/null | sed 's/^/  /' || warn "xpu-smi present but returned nothing"
elif command -v intel_gpu_top >/dev/null 2>&1; then
  ok "intel_gpu_top available (run it separately to watch utilisation)"
else
  warn "no xpu-smi / intel_gpu_top; install intel-gpu-tools to monitor VRAM. Laya needs ~1.7GB in fp32."
fi

if (( WRITE_ENV )); then
  head2 "Writing .env"
  if [[ -f "$ENV_FILE" ]]; then
    # Timestamped, so running this twice never overwrites the only good copy.
    BACKUP="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$BACKUP"
    echo "  existing .env backed up to $(basename "$BACKUP")"
  else
    cp "$REPO_DIR/.env.example" "$ENV_FILE"
  fi
  sed -i "s/^RENDER_GID=.*/RENDER_GID=${RENDER_GID:-993}/" "$ENV_FILE"
  sed -i "s/^VIDEO_GID=.*/VIDEO_GID=${VIDEO_GID:-44}/"   "$ENV_FILE"
  ok "wrote RENDER_GID=${RENDER_GID:-993} VIDEO_GID=${VIDEO_GID:-44} to $ENV_FILE"
fi

head2 "Summary"
printf '  %d failure(s), %d warning(s)\n' "$FAILURES" "$WARNINGS"
if (( FAILURES )); then
  printf '  Fix the failures above before running: docker compose up -d --build\n'
  exit 1
fi
printf '  Host looks ready. Next: docker compose up -d --build\n'
