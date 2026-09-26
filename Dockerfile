FROM node:22-alpine

# git + openssh : publication de reports/ sur GitHub. util-linux : flock (évite
# une double initialisation du dépôt quand web et sync démarrent ensemble).
RUN apk add --no-cache git openssh-client util-linux

WORKDIR /app
ENV HOME=/home/node \
    NODE_ENV=production \
    DATA_DIR=/data \
    GIT_REPO_DIR=/repo

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/sync-loop.sh ./docker/sync-loop.sh
RUN chmod +x /entrypoint.sh docker/sync-loop.sh \
    && mkdir -p /data /repo \
    && chown -R node:node /app /data /repo /home/node

USER node
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
