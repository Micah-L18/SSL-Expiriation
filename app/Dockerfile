# The Node version is pinned on purpose: the app uses Node's built-in SQLite,
# which is still a young API. Change it deliberately, and run the tests first.
FROM node:24.11.1-alpine3.22

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

# Inside the container the app has to listen on every interface for the
# published port to reach it. compose.yml publishes that port on 127.0.0.1 only.
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000

# Unhealthy means the scheduler has stopped; see /api/health in the README.
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
