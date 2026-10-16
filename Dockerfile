# ---- Build the React client ----
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build   # outputs to ../server/client-dist

# ---- Compile the TypeScript server ----
FROM node:22-alpine AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build   # tsc → dist/
COPY --from=client-build /app/server/client-dist ./client-dist

# ---- Slim production runtime ----
FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=server-build /app/server/dist ./dist
COPY --from=server-build /app/server/client-dist ./client-dist

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3001

# Long-running downloads need generous time; no artificial execution cap here.
# Size the container disk for MAX_BATCH_BYTES × MAX_CONCURRENT_JOBS plus headroom,
# and memory comfortably above your largest single file (streaming keeps it low).
CMD ["node", "dist/index.js"]
