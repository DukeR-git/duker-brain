---
id: docker_deploy
title: Docker Deployment
criteria: Dockerfiles and image layer caching, docker compose services, container networking and ports, GPU device passthrough
---

# Docker Deployment

## Layer ordering
Copy dependency manifests and install before copying source. Source changes then
do not invalidate the dependency layer.

## Compose
Services reach each other by service name on the default network. Publishing a
port is only needed for access from outside the compose network.

## Device passthrough
GPU access needs the device node plus matching group membership inside the
container; the host driver is not something the image can provide.
