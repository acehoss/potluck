#!/bin/sh
set -e

npx prisma migrate deploy

# Image volume layout (blueprint 04 §1); sh has no brace expansion.
mkdir -p /data/images/receipts /data/images/units /data/images/items

if [ "$SEED_DEMO" = "1" ]; then
  npx tsx prisma/seed.ts
fi

exec npm run start
