# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-slim
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/providers/package.json packages/providers/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --workspace @onixus/api --include-workspace-root=false
COPY packages/providers packages/providers
COPY apps/api apps/api
USER node
EXPOSE 4000
CMD ["npm", "start", "--workspace", "@onixus/api"]
