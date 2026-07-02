#!/bin/sh
set -e

npx prisma migrate deploy

if [ "$SEED_DEMO" = "1" ]; then
  npx tsx prisma/seed.ts
fi

exec npm run start
