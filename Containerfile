# Starhub RMF: web app + API server for Kubernetes (Amazon EKS).
#   podman build -t starhub-rmf:dev .
#   podman run --rm --env-file .env.local -p 8080:8080 starhub-rmf:dev

# ---- Build: install dev dependencies, type-check, build the web app and bundle the server.
FROM registry.access.redhat.com/ubi9/nodejs-24 AS build
WORKDIR /opt/app-root/src
COPY --chown=1001:0 package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=1001:0 . .
RUN npm run build

# ---- Runtime: the server bundle includes its dependencies, so no node_modules are needed.
FROM registry.access.redhat.com/ubi9/nodejs-24-minimal
LABEL org.opencontainers.image.title="starhub-rmf" \
      org.opencontainers.image.description="Starhub RMF web app and API"
WORKDIR /opt/app-root/src
COPY --from=build --chown=1001:0 /opt/app-root/src/dist ./dist
COPY --from=build --chown=1001:0 /opt/app-root/src/dist-server ./dist-server
ENV NODE_ENV=production \
    PORT=8080
# Runs as non-root UID 1001. Files are group-0 owned and world-readable, so any UID
# also works, and nothing is written at runtime (read-only root filesystem is fine).
USER 1001
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist-server/main.mjs"]
