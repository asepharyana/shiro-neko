---
name: docker
description: Write or fix Dockerfiles and container setups. Use when an image is too large, a build is slow, a container will not start, or layering and caching need design.
---

# Docker

An image is a build artifact. Small, reproducible, and boring is the goal.

## Layer cache is the whole speed game

Order instructions from least to most frequently changed: base image, then dependency
manifests, then `install`, then source copy, then build. Copying `.` before installing
dependencies means every code change re-runs the install — the single most common Dockerfile
mistake.

## Small images, on purpose

- Use multi-stage builds: build in a full toolchain stage, copy only the artifact into a slim
  runtime stage. The compiler does not ship to production.
- Pick a slim or distroless base unless you need the tooling. Alpine is small but musl breaks
  some binaries; know why you chose it.
- One `RUN` with `&&` for related steps, cleaning up in the same layer — a separate `RUN rm`
  does not shrink the image, the data is still in the earlier layer.

## The container is not a VM

- One process per container, as PID 1, so signals work. Use an init if the app spawns children.
- Do not run as root. Add a user and `USER` it.
- Read-only filesystem where possible; write to a mounted volume for anything that must persist.
  Nothing in the image is writable state.

## .dockerignore is as important as the Dockerfile

Exclude `.git`, `node_modules`, build output, and any secret file. A context that sends the
whole repo is slow, and a secret copied into an image layer is a secret to rotate.

## Healthcheck and logs

The process logs to stdout/stderr, never to a file inside the container — the runtime collects
it. Add a `HEALTHCHECK` that proves the service answers, not just that the process exists.
