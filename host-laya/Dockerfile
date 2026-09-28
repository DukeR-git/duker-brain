# syntax=docker/dockerfile:1.7
#
# Laya decisions host for Intel Arc (Battlemage / Alchemist) on Ubuntu 24.04.
#
# Two things have to line up for the GPU to work:
#   1. HOST: kernel driver (xe for B-series) + /dev/dri/renderD128 present.
#      Run scripts/host_preflight.sh to check. Nothing in this image can fix it.
#   2. CONTAINER: the Intel user-space compute runtime (Level Zero + OpenCL ICD)
#      and a torch built against XPU. Both are installed below.

FROM ubuntu:26.04

ARG DEBIAN_FRONTEND=noninteractive
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/xpu
# Pinned, like everything in constraints.txt: an unpinned torch means a rebuild
# months from now runs a different stack than the one you tested.
ARG TORCH_VERSION=2.14.0
ARG PYTHON=python3.12

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # Stop transformers probing for TensorFlow/Flax; the import deadlocks and
    # adds seconds to startup for no benefit.
    USE_TF=0 \
    USE_FLAX=0 \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1 \
    TOKENIZERS_PARALLELISM=false \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HOME=/opt/hf-cache

# --- Base OS + Python ------------------------------------------------------
# No python3-pip: the venv below brings its own pip.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg ${PYTHON} ${PYTHON}-venv \
    && rm -rf /var/lib/apt/lists/*

# --- Intel GPU user-space runtime -----------------------------------------
# Package names were renamed in the unified repo (intel-level-zero-gpu ->
# libze-intel-gpu1), so try the current names and fall back to the legacy ones.
RUN curl -fsSL https://repositories.intel.com/gpu/intel-graphics.key \
      | gpg --dearmor -o /usr/share/keyrings/intel-graphics.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble unified" \
      > /etc/apt/sources.list.d/intel-gpu-noble.list \
    && apt-get update \
    && (apt-get install -y --no-install-recommends \
            libze1 libze-intel-gpu1 intel-opencl-icd clinfo \
        || apt-get install -y --no-install-recommends \
            libze1 intel-level-zero-gpu intel-opencl-icd clinfo) \
    && rm -rf /var/lib/apt/lists/*

# --- Python environment ----------------------------------------------------
# A venv keeps us off Ubuntu's externally-managed system Python.
ENV VIRTUAL_ENV=/opt/venv
RUN ${PYTHON} -m venv ${VIRTUAL_ENV}
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

RUN pip install --upgrade pip setuptools wheel

# torch first, from the XPU index, so laya's dependency resolution finds it
# already satisfied instead of downloading the ~2.5GB CUDA build.
RUN pip install --index-url ${TORCH_INDEX_URL} "torch==${TORCH_VERSION}"

# Fail the build here rather than at 3am on the server: a torch without "xpu"
# in its version string cannot talk to the Arc card.
RUN python -c "import torch, sys; v = torch.__version__; print('torch', v); sys.exit(0 if 'xpu' in v else 'ERROR: torch %s is not an XPU build' % v)"

COPY requirements.txt constraints.txt /tmp/
RUN pip install -r /tmp/requirements.txt -c /tmp/constraints.txt \
    && python -c "import torch, sys; v = torch.__version__; print('torch after deps:', v); sys.exit(0 if 'xpu' in v else 'ERROR: a dependency replaced torch with %s' % v)"

# --- Application -----------------------------------------------------------
WORKDIR /srv
COPY app/ /srv/app/
COPY scripts/ /srv/scripts/

# Non-root. The render/video GIDs are supplied at runtime via `group_add` in
# docker-compose.yml, because they differ per host.
RUN useradd --create-home --uid 10001 laya \
    && mkdir -p ${HF_HOME} \
    && chown -R laya:laya ${HF_HOME} /srv
USER laya

EXPOSE 8081

# The one healthcheck (docker-compose.yml does not repeat it). The model loads in
# the background, so /healthz answers at once and `ready` turns true once the
# checkpoint is resident and warm. The start period covers a first download.
HEALTHCHECK --interval=15s --timeout=5s --start-period=900s --retries=3 \
  CMD python -c "import sys,urllib.request,json; d=json.load(urllib.request.urlopen('http://127.0.0.1:8081/healthz', timeout=4)); sys.exit(0 if d.get('ready') else 1)"

CMD ["python", "-m", "app.main"]
