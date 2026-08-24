FROM node:24.16-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

EXPOSE 3000

CMD ["node", "scripts/local-api.ts"]
