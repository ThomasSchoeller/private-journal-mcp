// ABOUTME: WebCrypto helpers shared by token checks, cookies and OAuth tokens
// ABOUTME: base64url, SHA-256, HMAC signing and constant-time comparison

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeJson(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

export function decodeJson<T>(value: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as T;
  } catch {
    return null;
  }
}

export async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await sha256(value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time equality. Both sides are hashed first, so the comparison length
 * never leaks the secret's length even where `timingSafeEqual` is unavailable.
 */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  // Workers' non-standard extension, when present. It has to stay a method call:
  // detaching it loses the `this` binding workerd requires.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(left, right);

  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

export async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  return base64UrlEncode(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

export async function hmacVerify(
  secret: string,
  message: string,
  signature: string
): Promise<boolean> {
  return secretEquals(await hmacSign(secret, message), signature);
}

/** `<payload>.<signature>`, the shape used by cookies, CSRF tokens and JWTs. */
export async function signPayload(secret: string, payload: unknown): Promise<string> {
  const encoded = encodeJson(payload);
  return `${encoded}.${await hmacSign(secret, encoded)}`;
}

export async function verifyPayload<T>(secret: string, value: string): Promise<T | null> {
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!(await hmacVerify(secret, encoded, signature))) return null;
  return decodeJson<T>(encoded);
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(verifier));
}

/**
 * Purpose-bound subkey derived from the one configured secret. Session cookies,
 * CSRF tokens and OAuth access tokens each sign under their own key, so a
 * signature minted for one of them can never be replayed as another.
 */
export async function deriveSecret(secret: string, purpose: string): Promise<string> {
  return hmacSign(secret, `private-journal/v1/${purpose}`);
}
