# The bundled PayPal mock (platform shared/paypal-mock). Build context: the repository root.
FROM scratch AS platform
COPY platform/ /

FROM node:24-slim AS shared
WORKDIR /shared
COPY --from=platform /shared/ ./
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev && find node_modules -xtype l -delete

FROM node:24-slim
COPY --from=shared /shared /opt/shared
ENV PORT=8080 MOCK_SEED_FILE=/opt/shared/datasets/demo-merchant.json
EXPOSE 8080
CMD ["node", "/opt/shared/paypal-mock/dist/server.js"]
