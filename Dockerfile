FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY lib ./lib
COPY scripts ./scripts
COPY galbi_steakhouse.json ./
COPY assets ./assets

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "scripts/twilio-galbi.ts"]
