#!/bin/bash

# Define image name and container name
IMAGE_NAME="terminus-backend"
CONTAINER_NAME="terminus-backend-container"
PORT=7145

# Build the Docker image
echo "Building Docker image..."
docker build -t $IMAGE_NAME .

# Check if the container is already running and stop/remove it
if [ "$(docker ps -q -f name=$CONTAINER_NAME)" ]; then
    echo "Stopping existing container..."
    docker stop $CONTAINER_NAME
    echo "Removing existing container..."
    docker rm $CONTAINER_NAME
fi

# Run the Docker container
echo "Running Docker container..."
docker run -d \
  --name $CONTAINER_NAME \
  --restart unless-stopped \
  --memory="512m" \
  -p $PORT:$PORT \
  --env-file .env \
  $IMAGE_NAME

echo "Container started successfully!"
