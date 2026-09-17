#!/usr/bin/env bash
# Build the image and bring the stack up, detached — the same thing as
# `docker compose up -d --build` in the README, as one gesture you can repeat.
set -e

docker compose build
docker compose up -d
