#!/usr/bin/env bash
#
# Build and publish the five Scani images from this machine, following the
# same steps and the same tags as `.github/workflows/docker-publish.yml` in
# MGrin/scani-oss.
#
# Why this exists: the same reason scripts/deploy-local.sh does. The publish
# workflow lives in the public mirror and does still run there, but it is
# reachable only through a release-please tag, and this repo — where the work
# actually happens — is billing-blocked for Actions repo-wide (SC-128,
# SC-433). The observable cost is that `scani/*:latest` sat at 0.12.0 from
# 2026-08-12 while main moved on, and the 0.13.0 release PR has been parked
# at `action_required` since 2026-08-15. A self-hoster running `:latest` gets
# whatever main looked like a fortnight ago, and nothing says so.
#
# Which images, and the Dockerfile each is built from, are declared once in
# `scripts/lib/docker-images.ts` and read from there — see below. This comment
# deliberately does not restate the list.
#
# Tagging matches the workflow's `docker/metadata-action` output for a
# `v1.2.3` tag push: `1.2.3`, `1.2`, `1`, and `latest`. Pass the version
# without the leading `v`.
#
# Usage:
#   scripts/publish-images-local.sh 0.13.0             # all five, multi-arch, push
#   scripts/publish-images-local.sh 0.13.0 api worker  # only these
#   DRY_RUN=1 scripts/publish-images-local.sh 0.13.0   # print the plan, touch nothing
#   PUSH=0 scripts/publish-images-local.sh 0.13.0      # build both arches, push nothing
#
# This script refuses to run outside a MGrin/scani-oss checkout. The build
# context is its own parent directory and the file exists in the private repo
# too, so the copy you invoke is the source that gets published — see the
# build-context guard below. `DRY_RUN=1` still prints the plan from anywhere.
#
# Credentials: `docker login` must already hold a Docker Hub token with
# write on the `scani/*` repos (the same DOCKERHUB_TOKEN the workflow uses).
# This script never reads a secret file and never logs one.
#
# Multi-arch on one machine needs buildx with a container driver — the
# default `docker` driver cannot emit a multi-platform manifest. The script
# creates a dedicated builder the first time and reuses it after.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NAMESPACE="scani"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER="scani-publish"
DRY_RUN="${DRY_RUN:-0}"
PUSH="${PUSH:-1}"

# The repository these images come from, named once. The build-context guard
# below and the `org.opencontainers.image.source` label stamped on every image
# make the same claim, so they read the same constant rather than agreeing by
# hand.
SOURCE_REPO="MGrin/scani-oss"
SOURCE_REPO_URL="https://github.com/${SOURCE_REPO}"

# A file the private repo carries and the public one never will. See the
# build-context guard below.
PRIVATE_MARKER=".private-repo"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }

# The image set and its Dockerfiles are declared once, in
# `scripts/lib/docker-images.ts`, and read from there (SC-534). They used to be
# a `case` and an array here, a second copy of what the README sync and the
# publish workflow each also stated — and a set stated four times is a set
# nothing can disagree with, which is how five images came to have one README.
#
# Read once, at startup, and fail closed: no `bun`, no manifest, or a manifest
# naming nothing all stop the script here. A publish derived from an empty list
# would build nothing, push nothing and exit 0.
IMAGE_MANIFEST="$REPO_ROOT/scripts/lib/docker-images.ts"
IMAGE_TSV="$(bun "$IMAGE_MANIFEST")" \
  || die "could not read the image manifest at $IMAGE_MANIFEST (bun must be on PATH)"
[ -n "$IMAGE_TSV" ] || die "the image manifest at $IMAGE_MANIFEST names no images"

dockerfile_for() {
  local wanted="$1" manifest_image manifest_dockerfile
  while IFS=$'\t' read -r manifest_image manifest_dockerfile; do
    if [ "$manifest_image" = "$wanted" ]; then
      echo "$manifest_dockerfile"
      return 0
    fi
  done <<< "$IMAGE_TSV"
  return 1
}

ALL_IMAGES=()
while IFS=$'\t' read -r manifest_image _; do
  ALL_IMAGES+=("$manifest_image")
done <<< "$IMAGE_TSV"

VERSION="${1:-}"
[ -n "$VERSION" ] || die "usage: scripts/publish-images-local.sh <version> [image ...]   e.g. 0.13.0"
shift || true

# `docker/metadata-action`'s semver patterns only ever produce these tags from
# a `vX.Y.Z` ref, so anything else here would publish a set of tags the CI
# path could never produce — and the point of this script is to be the same
# artefact, not a similar one.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "version must be bare semver like 0.13.0 (no leading v, no pre-release suffix); got '$VERSION'"

MAJOR="${VERSION%%.*}"
MINOR="${VERSION%.*}"

IMAGES=("$@")
[ "${#IMAGES[@]}" -gt 0 ] || IMAGES=("${ALL_IMAGES[@]}")
for image in "${IMAGES[@]}"; do
  dockerfile_for "$image" >/dev/null || die "unknown image '$image'. Known: ${ALL_IMAGES[*]}"
done


# ── the build-context guard ───────────────────────────────────────────────
#
# The build context is this file's own parent directory (`REPO_ROOT` above),
# and this file exists in BOTH MGrin/scani (private) and MGrin/scani-oss
# (public). Run the private copy and it builds `scani/*` from private source
# and pushes it to a public registry under the org account: the images build,
# the manifests push, `:latest` moves, every self-hoster pulls private code,
# and nothing in the output looks wrong. Once an image is on someone else's
# disk it cannot be unpublished. This is the one failure the repo split exists
# to prevent, and the only one with no undo (SC-478).
#
# It came within one judgement call of happening on 2026-08-20. A worker
# recommended publishing from the private branch and its reasoning was careful
# and evidence-backed: it had verified that tree byte-identical to post-merge
# OSS main, and at the moment it checked, it was. The claim went stale within
# hours when another PR merged privately. What stopped it was one reader
# overriding one report — which is a judgement, not a control. This is the
# control.
#
# Two independent checks, because there is no undo:
#
#   1. `origin` must be $SOURCE_REPO. A remote is the soundest cheap identity
#      for a checkout: paths get copied and branches get renamed, but `origin`
#      is what the tree actually pushes to. It must be `origin` SPECIFICALLY —
#      the private repo carries $SOURCE_REPO as `upstream`, so "some remote is
#      scani-oss" is true in both trees and would wave the private one through.
#   2. No $PRIVATE_MARKER in the build context. This catches what the remote
#      check cannot: a tree whose `origin` is right but which has had private
#      files copied into it, or a private clone whose remotes were renamed.
#
# Both fail CLOSED — an unidentifiable context is refused, not assumed public.
#
# DRY_RUN=1 downgrades a refusal to a warning, so the plan can still be printed
# from anywhere: printing a plan builds nothing, tags nothing and pushes
# nothing.

# `https://github.com/MGrin/scani-oss.git`, `git@github.com:MGrin/scani-oss.git`
# and `ssh://git@github.com/MGrin/scani-oss` are the same repository. Reduce any
# of them to `mgrin/scani-oss` rather than comparing whole URLs, so a checkout
# cloned over ssh is not refused for a reason that has nothing to do with which
# repository it is.
remote_slug() {
  local url="${1%/}"
  url="${url%.git}"
  url="$(printf '%s' "$url" | tr ':' '/' | tr '[:upper:]' '[:lower:]')"
  local repo="${url##*/}"
  local rest="${url%/*}"
  printf '%s/%s' "${rest##*/}" "$repo"
}

# Prints one block per reason to refuse, and nothing at all when the context is
# the public repo. Each block states what was required and what was found: this
# fires at the moment somebody is trying to ship, and the message is the whole
# value.
build_context_refusals() {
  local origin=''

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf '%s\n' \
      "the build context is not a git checkout, so it cannot be identified" \
      "  required  a checkout of ${SOURCE_REPO}" \
      "  found     ${REPO_ROOT} — no git repository"
  elif ! origin="$(git remote get-url origin 2>/dev/null)" || [ -z "$origin" ]; then
    printf '%s\n' \
      "the build context has no 'origin' remote, so it cannot be identified" \
      "  required  origin = ${SOURCE_REPO_URL}" \
      "  found     ${REPO_ROOT} — no 'origin' remote"
  elif [ "$(remote_slug "$origin")" != "$(remote_slug "$SOURCE_REPO_URL")" ]; then
    printf '%s\n' \
      "the build context is not ${SOURCE_REPO}" \
      "  required  origin = ${SOURCE_REPO_URL}" \
      "  found     origin = ${origin}" \
      "  note      'origin' and not any remote: the private repo carries ${SOURCE_REPO} as 'upstream'"
  fi

  if [ -e "${REPO_ROOT}/${PRIVATE_MARKER}" ]; then
    printf '%s\n' \
      "the build context carries the private-repo marker '${PRIVATE_MARKER}'" \
      "  required  no '${PRIVATE_MARKER}' in the build context" \
      "  found     ${REPO_ROOT}/${PRIVATE_MARKER}"
  fi
}

REFUSALS="$(build_context_refusals)"
if [ -n "$REFUSALS" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    warn "the build-context guard would REFUSE this run (DRY_RUN=1 — printing the plan anyway):"
    while IFS= read -r line; do warn "  $line"; done <<< "$REFUSALS"
    warn ""
  else
    printf '\033[31m✗\033[0m %s\n' "refusing to publish: the build context is not ${SOURCE_REPO}." >&2
    while IFS= read -r line; do printf '  %s\n' "$line" >&2; done <<< "$REFUSALS"
    printf '\n  %s\n' "Run the script from the ${SOURCE_REPO} checkout. The build context is this" >&2
    printf '  %s\n' "file's own parent directory, so the copy you invoke IS the source published." >&2
    printf '  %s\n\n' "DRY_RUN=1 prints the plan from anywhere." >&2
    exit 1
  fi
fi

# The build takes the working tree as its context, so publishing from a dirty
# or behind-main tree ships something no commit describes. Refuse rather than
# bake an unidentifiable artefact — a tag is a claim, a commit is evidence.
GIT_SHA="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty. Publishing would ship changes that are in no commit — commit or stash first."
fi

log "version   $VERSION  ->  tags: $VERSION, $MINOR, $MAJOR, latest"
log "revision  $GIT_SHA"
log "images    ${IMAGES[*]}"
log "platforms $PLATFORMS"
[ "$PUSH" = "1" ] && log "push      yes (docker.io/${NAMESPACE}/*)" || log "push      NO (PUSH=0)"

if [ "$DRY_RUN" = "1" ]; then
  ok "DRY_RUN=1 — plan printed, nothing built or pushed."
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker not found."
docker buildx version >/dev/null 2>&1 || die "docker buildx not available; it is required for multi-arch builds."

if [ "$PUSH" = "1" ]; then
  # `docker buildx build --push` fails deep into the build if the credential
  # is missing, after twenty minutes of compiling. Fail in the first second
  # instead.
  docker manifest inspect "${NAMESPACE}/api:latest" >/dev/null 2>&1 \
    || die "cannot read ${NAMESPACE}/api from Docker Hub. Run \`docker login\` with a token that has write on ${NAMESPACE}/*."
fi

# ── the frontend boots at all ─────────────────────────────────────────────
#
# `scani/frontend-app:0.13.0` — the tag `scripts/self-host.sh` pulls by
# default — rendered NOTHING. `#root` stayed empty for every self-hoster from
# the day the images were first published. The cause was a module-scope throw:
# the image is built with `VITE_API_URL=/api` (below) so that one artefact
# serves any hostname, and two things in the boot chain required an absolute
# URL. `main.tsx` never ran (SC-509).
#
# EVERY gate this project has passed over it. `bun run test` does not build the
# bundle, `docs:check` does not build the bundle, and the visual gate renders a
# DEV build with an absolute `VITE_API_URL` — which is precisely the
# configuration that hid it. The only thing that could ever have seen it is
# loading the real artefact in a real browser, so that is what this does, here,
# before anything is pushed.
#
# It costs one extra single-arch build. Nearly every layer is shared with the
# multi-arch build below, so on a warm cache it is seconds — and it is the
# difference between shipping a blank page to strangers and not.
smoke_frontend_boots() {
  local tag="${NAMESPACE}/frontend-app:boot-check"
  local name="scani-frontend-boot-check"
  local port="${BOOT_CHECK_PORT:-8099}"

  command -v bun >/dev/null 2>&1 || die "bun is needed for the frontend boot check."

  log "building ${NAMESPACE}/frontend-app for the boot check (single-arch, not pushed)"
  docker buildx build \
    --builder "$BUILDER" \
    --file "$(dockerfile_for frontend-app)" \
    --build-arg VITE_API_URL=/api \
    --tag "$tag" \
    --provenance=false \
    --load \
    . </dev/null

  docker rm -f "$name" >/dev/null 2>&1 || true
  # A dead-end upstream on purpose. nginx refuses to start if `proxy_pass`
  # names a host it cannot resolve, and there is no api here — this check is
  # about whether the BUNDLE boots, not about whether the stack works.
  docker run -d --rm --name "$name" -p "${port}:80" \
    -e API_UPSTREAM=http://127.0.0.1:9 "$tag" >/dev/null \
    || die "could not start the frontend image for the boot check."

  local code=0
  for _ in $(seq 1 20); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/" || true)" = "200" ] && break
    sleep 1
  done

  bun apps/e2e/scripts/check-spa-boots.ts "http://localhost:${port}/" || code=$?
  docker rm -f "$name" >/dev/null 2>&1 || true

  [ "$code" -eq 0 ] || die "the frontend-app image renders nothing. NOT publishing. See SC-509."
  ok "the frontend-app bundle mounts"
}

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  log "creating buildx builder '$BUILDER' (container driver — the default one cannot do multi-arch)"
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
fi
ok "builder $BUILDER"

# Before the loop, so a bundle that renders nothing is never pushed.
for image in "${IMAGES[@]}"; do
  if [ "$image" = "frontend-app" ] && [ "$DRY_RUN" != "1" ]; then
    smoke_frontend_boots
  fi
done

for image in "${IMAGES[@]}"; do
  dockerfile="$(dockerfile_for "$image")"
  log "building ${NAMESPACE}/${image} from ${dockerfile}"

  tag_args=()
  for t in "$VERSION" "$MINOR" "$MAJOR" latest; do
    tag_args+=(--tag "${NAMESPACE}/${image}:${t}")
  done

  build_args=()
  # The SPA's API base is a relative path: nginx inside the frontend-app
  # container proxies /api at runtime, so one image serves any backend host.
  # Same value the workflow passes.
  if [ "$image" = "frontend-app" ]; then
    build_args+=(--build-arg VITE_API_URL=/api)
  fi

  output_arg="--load"
  # --load cannot hold a multi-platform result; a non-pushing run therefore
  # builds one arch (this machine's) as a smoke test, exactly as the
  # workflow's PR builds do.
  platforms="$PLATFORMS"
  if [ "$PUSH" = "1" ]; then
    output_arg="--push"
  else
    platforms=""
  fi

  # `--provenance=false` drops the attestation manifest, matching the
  # workflow. Without it the Docker Hub tag page lists an "unknown/unknown"
  # platform beside the real ones.
  docker buildx build \
    --builder "$BUILDER" \
    --file "$dockerfile" \
    ${platforms:+--platform "$platforms"} \
    "${tag_args[@]}" \
    "${build_args[@]}" \
    --label "org.opencontainers.image.revision=${GIT_SHA}" \
    --label "org.opencontainers.image.version=${VERSION}" \
    --label "org.opencontainers.image.source=${SOURCE_REPO_URL}" \
    --provenance=false \
    "$output_arg" \
    . </dev/null

  ok "${NAMESPACE}/${image}:${VERSION}"
done

if [ "$PUSH" = "1" ]; then
  # Read the manifest back from the registry rather than trusting the build's
  # exit code. A push that half-succeeded still exits 0 on the client, and the
  # thing consumers actually resolve is the manifest list.
  echo
  log "verifying published manifests"
  for image in "${IMAGES[@]}"; do
    arches="$(docker manifest inspect "${NAMESPACE}/${image}:${VERSION}" \
      | grep -o '"architecture": "[a-z0-9]*"' | cut -d'"' -f4 | sort -u | tr '\n' ' ')"
    [ -n "$arches" ] || die "${NAMESPACE}/${image}:${VERSION} has no manifest on Docker Hub after a push that reported success."
    ok "${NAMESPACE}/${image}:${VERSION} -> ${arches}"
  done
fi

echo
ok "done — ${#IMAGES[@]} image(s) at ${VERSION} from ${GIT_SHA}"
