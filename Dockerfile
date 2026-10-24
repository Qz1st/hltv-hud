# Для своего VPS (Hetzner и т.п.): здесь уже есть Chromium как запасной путь против Cloudflare.
#   docker compose up -d
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
ENV CLOUD=1 PORT=8080 DATA_DIR=/data BROWSER_PATH=/usr/bin/chromium
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
