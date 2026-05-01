#!/usr/bin/env bash
set -euo pipefail

# Build the Infisical standalone image and push it to GitHub Container Registry.
#
# Required env vars (set them in your shell or in scripts/.env, which is gitignored):
#   GHCR_USER  - your GitHub username (lowercase)
#   GHCR_TOKEN - a GitHub PAT with write:packages, read:packages
#
# Optional env vars:
#   IMAGE_NAME    - image name under your user (default: infisical)
#   ROLLING_TAG   - the rolling tag Railway pulls (default: latest-postgres)
#   DOCKERFILE    - dockerfile path (default: Dockerfile.standalone-infisical)
#   SKIP_LOGIN    - set to "true" if you've already done docker login this session

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Load scripts/.env if present (for GHCR_USER / GHCR_TOKEN)
if [[ -f "$REPO_ROOT/scripts/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; . "$REPO_ROOT/scripts/.env"; set +a
fi

: "${GHCR_USER:?Set GHCR_USER (your GitHub username, lowercase)}"
: "${GHCR_TOKEN:?Set GHCR_TOKEN (GitHub PAT with write:packages)}"

IMAGE_NAME="${IMAGE_NAME:-infisical}"
ROLLING_TAG="${ROLLING_TAG:-latest-postgres}"
DOCKERFILE="${DOCKERFILE:-Dockerfile.standalone-infisical}"

VERSION="$(date +%Y%m%d-%H%M%S)"
IMAGE="ghcr.io/$GHCR_USER/$IMAGE_NAME"

echo "==> Repo:       $REPO_ROOT"
echo "==> Dockerfile: $DOCKERFILE"
echo "==> Image:      $IMAGE"
echo "==> Tags:       $VERSION, $ROLLING_TAG"
echo

if [[ "${SKIP_LOGIN:-}" != "true" ]]; then
  echo "==> Logging in to ghcr.io"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

echo "==> Building (this is a heavy build; first run takes 15–20 min)"
docker build \
  --platform linux/amd64 \
  -f "$DOCKERFILE" \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:$ROLLING_TAG" \
  .

echo "==> Pushing $IMAGE:$VERSION"
docker push "$IMAGE:$VERSION"

echo "==> Pushing $IMAGE:$ROLLING_TAG"
docker push "$IMAGE:$ROLLING_TAG"

echo
echo "Done."
echo "  Versioned tag: $IMAGE:$VERSION"
echo "  Rolling tag:   $IMAGE:$ROLLING_TAG"
echo
echo "In Railway, set the service image to one of the above and redeploy."
