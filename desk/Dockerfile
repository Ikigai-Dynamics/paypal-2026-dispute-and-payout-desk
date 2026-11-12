# Build context: the repository root (compose and Render both use it).
# Shared packages come from the platform checkout: compose passes it as the named context `platform`
# (additional_contexts); Render builds the stage below from a vendored ./platform/ directory.
FROM scratch AS platform
COPY platform/ /

FROM node:24-slim AS shared
WORKDIR /shared
COPY --from=platform /shared/ ./
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev && find node_modules -xtype l -delete

FROM node:24-slim AS build
WORKDIR /app
COPY --from=shared /shared /opt/shared
COPY desk/package.json desk/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY desk/ ./
RUN mkdir -p node_modules/@jeirslab \
 && for p in paypal-client llm-client valkey-client otel; do ln -sfn /opt/shared/$p node_modules/@jeirslab/$p; done \
 && npm run build \
 && npm prune --omit=dev \
 && for p in paypal-client llm-client valkey-client otel; do ln -sfn /opt/shared/$p node_modules/@jeirslab/$p; done

FROM node:24-slim
WORKDIR /app
COPY --from=shared /shared /opt/shared
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
