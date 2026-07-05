#!/bin/sh
set -e

npx prisma migrate deploy

# Image volume layout (blueprint 04 §1); sh has no brace expansion.
mkdir -p /data/images/receipts /data/images/units /data/images/items /data/images/shares /data/images/recipes /data/images/avatars

if [ "$SEED_DEMO" = "1" ]; then
  npx tsx prisma/seed.ts
fi

# Web push VAPID keys. The pair below is a PUBLICLY KNOWN dev/e2e keypair —
# its private key is committed to the repo, so it must NEVER identify a real
# deployment. Demo/e2e stacks (SEED_DEMO=1) get it injected automatically so
# the standard test invocation exercises push with zero setup; outside demo
# mode the entrypoint refuses to start rather than run push with a published
# private key (push simply stays disabled when no keys are set).
DEV_VAPID_PUBLIC_KEY="BBmF2n05G3ejUazc-E4XP8vy-ZsMjXXeaqF6EFRE3yklyZBbma2GfE0upJnion1w5lFRSXpI1c40s-hPmUwIba4"
DEV_VAPID_PRIVATE_KEY="ZznlR9ylEQD0AEr6EAn5YkLukPYdRQARYFoqP4KRpVw"
if [ "$SEED_DEMO" = "1" ] && [ -z "${VAPID_PUBLIC_KEY:-}" ] && [ -z "${VAPID_PRIVATE_KEY:-}" ]; then
  export VAPID_PUBLIC_KEY="$DEV_VAPID_PUBLIC_KEY"
  export VAPID_PRIVATE_KEY="$DEV_VAPID_PRIVATE_KEY"
fi
if [ "$SEED_DEMO" != "1" ]; then
  if [ "${VAPID_PUBLIC_KEY:-}" = "$DEV_VAPID_PUBLIC_KEY" ] || [ "${VAPID_PRIVATE_KEY:-}" = "$DEV_VAPID_PRIVATE_KEY" ]; then
    echo "FATAL: the committed DEV VAPID keypair is configured on a non-demo stack." >&2
    echo "       Its private key is public — anyone could forge push notifications." >&2
    echo "       Generate your own (npx web-push generate-vapid-keys) or unset the" >&2
    echo "       VAPID_* variables to disable push. Refusing to start." >&2
    exit 1
  fi
fi

# Mail substrate boot guards (Phase 3 Round A; docs/REWORK.md N1–N11).
# MAIL_MODE defaults to capture (record-only, never touches SMTP). Two guards:
#   1. FATAL: a seeded/demo stack must NEVER send unfiltered to real recipients.
#      SEED_DEMO=1 + MAIL_MODE=live + MAIL_PRODUCTION=1 (dev-filter disabled) is
#      exactly that combination — refuse to start.
#   2. WARN: a production stack (SEED_DEMO!=1) in capture mode silently drops all
#      mail — loud, non-fatal, so the operator knows it is intentional.
MAIL_MODE="${MAIL_MODE:-capture}"
if [ "$SEED_DEMO" = "1" ] && [ "$MAIL_MODE" = "live" ] && [ "$MAIL_PRODUCTION" = "1" ]; then
  echo "FATAL: SEED_DEMO=1 with MAIL_MODE=live and MAIL_PRODUCTION=1 would send" >&2
  echo "       unfiltered mail from a seeded/demo stack to real recipients." >&2
  echo "       Drop MAIL_PRODUCTION (keep the dev-filter) or MAIL_MODE=capture." >&2
  echo "       Refusing to start." >&2
  exit 1
fi
if [ "$SEED_DEMO" != "1" ] && [ "$MAIL_MODE" = "capture" ]; then
  echo "WARNING: MAIL_MODE=capture on a non-demo stack — outgoing mail is recorded" >&2
  echo "         to the CapturedEmail table but NEVER sent. Set MAIL_MODE=live to" >&2
  echo "         actually deliver." >&2
fi

exec npm run start
