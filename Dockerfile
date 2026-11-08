# Sandboxed runtime for the harness: scrapers, browsers and agent code run here, not on your machine.
FROM mcr.microsoft.com/playwright:v1.49.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg bubblewrap socat ripgrep tmux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN useradd -m agent && chown -R agent /app
USER agent
WORKDIR /workspace
ENV HARNESS_ROOT=/app
ENTRYPOINT ["npx", "--prefix", "/app", "tsx", "/app/src/cli.ts"]
