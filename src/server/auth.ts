import { createHash, randomBytes } from 'node:crypto';
import { hash as argon2Hash, hashSync, verify as argon2Verify } from '@node-rs/argon2';
import { cookies } from 'next/headers';
import { db } from './db';

export const SESSION_COOKIE = 'coop_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000; // renew when < 15 days left

// OWASP-recommended argon2id parameters (the library defaults to argon2id).
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string) {
  return argon2Hash(password, ARGON2_OPTIONS);
}

// Verified when a login email doesn't exist, so response timing doesn't
// reveal which addresses have accounts. Computed once at startup.
export const DUMMY_HASH = hashSync(randomBytes(16).toString('hex'), ARGON2_OPTIONS);

export function verifyPassword(passwordHash: string, password: string) {
  return argon2Verify(passwordHash, password);
}

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string) {
  const token = generateToken();
  await db.session.create({
    data: {
      id: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return token;
}

export async function setSessionCookie(token: string, secure: boolean) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * Validates the session cookie. Returns the user (with household) or null.
 * Renews the session expiry when it is past the halfway point.
 */
export async function getSessionUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: { include: { household: true } } },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (session.expiresAt.getTime() - Date.now() < SESSION_RENEW_BELOW_MS) {
    await db.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
  }

  return session.user;
}

export async function destroySession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    await db.session.delete({ where: { id: hashToken(token) } }).catch(() => {});
  }
  await clearSessionCookie();
}
