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
#   IMAGE                Dockerfile
#   scani/api            apps/backend/api/Dockerfile
#   scani/worker         apps/backend/worker/Dockerfile
#   scani/data-provider  apps/backend/data-provider/Dockerfile
#   scani/frontend-app   apps/frontend/app/Dockerfile
#   scani/migrate        packages/infra/db/Dockerfile.migrate
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

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

dockerfile_for() {
  case "$1" in
    api)           echo 'apps/backend/api/Dockerfile' ;;
    worker)        echo 'apps/backend/worker/Dockerfile' ;;
    data-provider) echo 'apps/backend/data-provider/Dockerfile' ;;
    frontend-app)  echo 'apps/frontend/app/Dockerfile' ;;
    migrate)       echo 'packages/infra/db/Dockerfile.migrate' ;;
    *)             return 1 ;;
  esac
}

ALL_IMAGES=(api worker data-provider frontend-app migrate)

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

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  log "creating buildx builder '$BUILDER' (container driver — the default one cannot do multi-arch)"
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
fi
ok "builder $BUILDER"

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
    --label "org.opencontainers.image.source=https://github.com/MGrin/scani-oss" \
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
