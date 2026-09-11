FROM node:24.16-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src

RUN npm run build

EXPOSE 5173

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
