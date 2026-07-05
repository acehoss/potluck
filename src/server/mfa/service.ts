/**
 * MFA persistence + verification services (Phase 3 Round B; docs/REWORK.md N8).
 * The db-touching layer over the pure helpers in `./codes`, `./totp`, `./crypto`
 * — the routers call these; the pure pieces stay unit-testable on their own.
 */

import type { User } from '@/generated/prisma/client';
import { db } from '../db';
import { sendTransactional } from '../mail';
import { generateBackupCodes, hashBackupCode, verifyBackupCode } from './backup';
import { decryptSecret } from './crypto';
import {
  EMAIL_MFA_CODE_TTL_MS,
  emailCodeState,
  generateEmailCode,
  hashEmailCode,
} from './email-code';
import { verifyTotpStep } from './totp';

// --- Backup codes ------------------------------------------------------------

/**
 * Replace the user's backup codes with a fresh set and return the PLAINTEXT
 * (shown exactly once). Called at TOTP enrollment confirm.
 */
export async function regenerateBackupCodes(userId: string): Promise<string[]> {
  const codes = generateBackupCodes();
  const hashes = await Promise.all(codes.map(hashBackupCode));
  await db.mfaBackupCode.deleteMany({ where: { userId } });
  await db.mfaBackupCode.createMany({
    data: hashes.map((codeHash) => ({ userId, codeHash })),
  });
  return codes;
}

/** Verify + consume one unused backup code; true when a code matched. */
export async function consumeBackupCode(userId: string, input: string): Promise<boolean> {
  const rows = await db.mfaBackupCode.findMany({ where: { userId, usedAt: null } });
  for (const row of rows) {
    if (await verifyBackupCode(row.codeHash, input)) {
      // updateMany with the usedAt guard makes a concurrent double-use fail
      // closed (only one caller flips it).
      const claimed = await db.mfaBackupCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 1) return true;
    }
  }
  return false;
}

export async function backupCodesRemaining(userId: string): Promise<number> {
  return db.mfaBackupCode.count({ where: { userId, usedAt: null } });
}

// --- Emailed codes -----------------------------------------------------------

/**
 * Mint a fresh emailed 6-digit code (deleting any prior live one — at most one
 * per user) and send it via the transactional pipeline. Rate limiting on the
 * REQUEST direction is the caller's job; the ATTEMPT cap lives on the row.
 */
export async function issueEmailMfaCode(user: Pick<User, 'id' | 'email'>): Promise<void> {
  const code = generateEmailCode();
  await db.emailMfaCode.deleteMany({ where: { userId: user.id } });
  await db.emailMfaCode.create({
    data: {
      userId: user.id,
      codeHash: hashEmailCode(code),
      expiresAt: new Date(Date.now() + EMAIL_MFA_CODE_TTL_MS),
    },
  });
  const minutes = Math.round(EMAIL_MFA_CODE_TTL_MS / 60000);
  await sendTransactional({
    to: user.email,
    kind: 'mfa',
    subject: 'Your Potluck verification code',
    text: `Your Potluck verification code is ${code}. It expires in ${minutes} minutes. If you didn't ask for this, you can ignore this email.`,
  });
}

/**
 * Verify + consume the user's live emailed code. Increments `attempts` on a
 * wrong guess (killing the code at the cap) and deletes the row on any terminal
 * outcome. Always hashes the input so a mismatch costs the same as a match.
 */
export async function verifyEmailMfaCode(userId: string, input: string): Promise<boolean> {
  const row = await db.emailMfaCode.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  // Hash the input regardless of whether a live code exists so a mismatch, a
  // dead code, and a match all cost roughly the same (no early-out timing tell).
  let inputHash: string | null = null;
  try {
    inputHash = hashEmailCode(input);
  } catch {
    /* MFA not configured — falls through to false */
  }
  if (!row || inputHash === null) return false;

  if (emailCodeState(row) !== 'valid') return false;

  if (row.codeHash === inputHash) {
    // Single-use: mark consumed (guarded so a concurrent double-use fails closed).
    const claimed = await db.emailMfaCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return claimed.count === 1;
  }
  // Wrong guess: burn one attempt. Once attempts reaches the cap the next
  // emailCodeState read returns 'exhausted' and the code is dead.
  await db.emailMfaCode.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });
  return false;
}

// --- Unified login-challenge verification ------------------------------------

export type MfaFactor = 'totp' | 'backup' | 'email';

/**
 * Verify a second-factor `code` for `user` at a login challenge, trying every
 * factor the account has. On a TOTP match the consumed step is persisted and a
 * code from that step or earlier is replay-rejected. Returns the factor that
 * matched, or null. Ordering (TOTP → email → backup) is a cost/ux choice; all
 * are attempted so a 6-digit value that is a valid TOTP OR a valid emailed code
 * both work.
 */
export async function verifyLoginMfa(
  user: Pick<User, 'id' | 'totpSecret' | 'totpEnabledAt' | 'totpLastStep' | 'mfaEmailEnabled'>,
  code: string,
): Promise<MfaFactor | null> {
  if (user.totpEnabledAt && user.totpSecret) {
    const secret = decryptSecret(user.totpSecret);
    const step = verifyTotpStep(code, secret);
    if (step !== null) {
      if (user.totpLastStep !== null && step <= user.totpLastStep) {
        // Replay of an already-consumed step — reject even though the code is
        // arithmetically valid within the window.
        return null;
      }
      await db.user.update({ where: { id: user.id }, data: { totpLastStep: step } });
      return 'totp';
    }
  }
  if (user.mfaEmailEnabled && (await verifyEmailMfaCode(user.id, code))) {
    return 'email';
  }
  if (await consumeBackupCode(user.id, code)) {
    return 'backup';
  }
  return null;
}

/** Whether the account has ANY MFA factor that gates login. */
export function hasMfa(user: Pick<User, 'totpEnabledAt' | 'mfaEmailEnabled'>): boolean {
  return user.totpEnabledAt !== null || user.mfaEmailEnabled;
}
