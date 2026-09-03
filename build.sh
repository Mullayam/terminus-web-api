#!/bin/bash
set -euo pipefail

# Define image name and container name
IMAGE_NAME="terminus-backend"
CONTAINER_NAME="terminus-backend-container"
PORT=7145
# Named volume backing the embedded RocksDB store. RocksDB needs read-write
# access and holds an exclusive LOCK file, so this must not be shared or ro.
STORE_VOLUME="terminus-store"
STORE_PATH="/data/store"
# rocksdb has no musl or linux-arm64 prebuild, so the image is amd64-only.
# On Apple Silicon this runs under emulation.
PLATFORM="linux/amd64"

# Optional flags. --no-cache forces a clean rebuild (ignores Docker layer cache).
NO_CACHE=""
for arg in "$@"; do
    case "$arg" in
        --no-cache) NO_CACHE="--no-cache" ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

# Build the Docker image
echo "Building Docker image..."
docker build $NO_CACHE --platform $PLATFORM -t $IMAGE_NAME .

# Create the store volume if it does not exist yet
if ! docker volume inspect "$STORE_VOLUME" >/dev/null 2>&1; then
    echo "Creating store volume $STORE_VOLUME..."
    docker volume create "$STORE_VOLUME"
fi

# Check if the container is already running and stop/remove it
if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
    echo "Stopping existing container..."
    docker stop $CONTAINER_NAME >/dev/null 2>&1 || true
    echo "Removing existing container..."
    docker rm $CONTAINER_NAME >/dev/null 2>&1 || true
fi

# Run the Docker container
echo "Running Docker container..."
docker run -d \
  --name $CONTAINER_NAME \
  --platform $PLATFORM \
  --restart unless-stopped \
  --memory="2g" \
  -p $PORT:$PORT \
  --env-file .env \
  -e STORE_PATH=$STORE_PATH \
  --mount type=volume,source=$STORE_VOLUME,target=/data,readonly=false \
  $IMAGE_NAME

# RocksDB fails to open if the mount is not writable by the container user,
# so verify rather than discovering it on the first cache write.
echo "Verifying store is writable..."
if docker exec $CONTAINER_NAME sh -c "touch $STORE_PATH/.rw-probe && rm -f $STORE_PATH/.rw-probe" 2>/dev/null; then
    echo "Store volume '$STORE_VOLUME' mounted read-write at $STORE_PATH ✓"
else
    echo "ERROR: $STORE_PATH is not writable inside the container." >&2
    echo "  Fix ownership with: docker run --rm -v $STORE_VOLUME:/data alpine chown -R 1000:1000 /data" >&2
    exit 1
fi

# A missing native binding only surfaces at runtime, so fail the deploy here
# instead of serving 500s from every cached endpoint.
echo "Verifying RocksDB opened..."
sleep 3
if docker logs $CONTAINER_NAME 2>&1 | grep -q "No native build was found"; then
    echo "ERROR: rocksdb native binding missing for this platform." >&2
    echo "  The image must be linux/amd64 with glibc; alpine and arm64 have no prebuild." >&2
    exit 1
fi
echo "RocksDB store ready ✓"

echo "Container started successfully!"
