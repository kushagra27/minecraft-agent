# Use ARM64 image to match your M3 Mac
FROM --platform=linux/arm64 node:22

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# See: https://github.com/elizaOS/eliza/issues/1543#issuecomment-2570781857
RUN npm install -g sqlite-vec

# Install system dependencies including canvas dependencies
RUN apt-get update && \
  apt-get install -y python3 make g++ jq sqlite3 libsqlite3-dev \
  # Canvas dependencies
  build-essential libcairo2-dev libpango1.0-dev libjpeg-dev \
  libgif-dev librsvg2-dev pkg-config \
  # GL dependencies
  libxi-dev libglu1-mesa-dev libglew-dev \
  # Create python symlink for packages that use python instead of python3
  && ln -s /usr/bin/python3 /usr/bin/python

# Set environment variables for native module builds
ENV npm_config_better_sqlite3_binary_host_mirror=https://github.com/WiseLibs/better-sqlite3/releases/download
ENV npm_config_better_sqlite3_binary_host_tag=v8.7.0
ENV npm_config_build_from_source=true
ENV NODE_OPTIONS=--max_old_space_size=4096

# Copy source code (excluding files in .dockerignore)
COPY . .

# Install dependencies for server only, skipping client-side packages
RUN cd server && pnpm install --no-frozen-lockfile --shamefully-hoist

# Build the server
RUN cd server && pnpm run build

# Create a proper start script file that ensures unique credentials per container
RUN printf '#!/bin/sh\n\
  # Start the server which will generate new credentials if needed\n\
  cd /app/server && node dist/index.js\n' > /app/start.sh

# Make the script executable
RUN chmod +x /app/start.sh

# Run the server
CMD ["/app/start.sh"]