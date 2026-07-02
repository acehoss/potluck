FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Build-time default so prisma.config.ts can resolve; compose overrides at runtime.
ENV DATABASE_URL="file:/data/coop.db"
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
