import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const sessionCookieName = 'chatify_session';
const sessionTtlMs = 1000 * 60 * 60 * 24 * 14;

export interface SessionCookieOptions {
  sameSite?: 'Lax' | 'None';
  secure?: boolean;
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function normalizeDisplayName(displayName: string) {
  const trimmed = displayName.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 40) : 'Anonymous';
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string) {
  const hash = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');

  return expected.length === hash.length && timingSafeEqual(expected, hash);
}

export function createSessionToken() {
  return randomUUID();
}

export function createSessionExpiry() {
  return Date.now() + sessionTtlMs;
}

function buildSessionCookieAttributes(options: SessionCookieOptions = {}) {
  const attributes = ['HttpOnly', 'Path=/', `SameSite=${options.sameSite ?? 'Lax'}`];

  if (options.secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

export function serializeSessionCookie(token: string, options: SessionCookieOptions = {}) {
  return `${sessionCookieName}=${token}; ${buildSessionCookieAttributes(options)}; Max-Age=${Math.floor(sessionTtlMs / 1000)}`;
}

export function clearSessionCookie(options: SessionCookieOptions = {}) {
  return `${sessionCookieName}=; ${buildSessionCookieAttributes(options)}; Max-Age=0`;
}

export function parseCookieHeader(cookieHeader: string | undefined) {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  const cookies = new Map<string, string>();

  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) {
      continue;
    }

    cookies.set(rawKey, rest.join('='));
  }

  return cookies;
}

export function getSessionTokenFromCookie(cookieHeader: string | undefined) {
  return parseCookieHeader(cookieHeader).get(sessionCookieName) ?? null;
}

export function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}