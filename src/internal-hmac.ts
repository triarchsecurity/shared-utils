import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The fixed payload shape for portal→admin HMAC-signed dispatch requests.
 * All fields are required. Keys are signed in alphabetical order for stability.
 */
export type InternalHmacBody = {
  actorEmail: string;              // portal's signed-in customer admin email
  branch: string;
  nonce: string;                   // 16-byte hex random (32 chars)
  projectKey: string;
  releaseId: string;
  slackChannelId: string | null;
  slackMessageTs: string | null;
  timestamp: number;               // ms since epoch
  version: string;
};

export type SignRequestResult = {
  body: InternalHmacBody;
  signature: string;               // hex HMAC-SHA256 of canonicalized body
};

export type VerifyResult =
  | { ok: true; body: InternalHmacBody }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'replay' | 'no_secret' };

/**
 * In-memory nonce cache for replay protection (per-instance, 10-min TTL).
 * Process-local — multi-instance FAH replay tolerance is bounded by 5-min skew window.
 */
export interface NonceStore {
  has(nonce: string): boolean;
  add(nonce: string, expiresAt: number): void;
}

/**
 * Constant-time comparison of two hex-encoded strings.
 * Returns false (not throws) on any length mismatch or encoding error.
 * Mirrors admin's slack-crypto.ts:safeEqHex.
 */
function safeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Canonicalizes an InternalHmacBody into a stable JSON string.
 * Keys are sorted alphabetically to produce a deterministic byte sequence
 * regardless of object property insertion order.
 */
function canonicalize(body: InternalHmacBody): string {
  return JSON.stringify(body, Object.keys(body).sort());
}

/**
 * Signs an internal dispatch request with HMAC-SHA256.
 *
 * The returned body includes timestamp and nonce generated at call time
 * (or injected via opts for testing). The signature covers the canonicalized body.
 */
export function signRequest(
  input: Omit<InternalHmacBody, 'timestamp' | 'nonce'>,
  secret: string,
  opts?: { now?: number; nonce?: string },
): SignRequestResult {
  const now = opts?.now ?? Date.now();
  const nonce = opts?.nonce ?? randomBytes(16).toString('hex');
  const body: InternalHmacBody = { ...input, timestamp: now, nonce };
  const signature = createHmac('sha256', secret).update(canonicalize(body)).digest('hex');
  return { body, signature };
}

/**
 * Verifies a HMAC-signed internal dispatch request.
 *
 * Validation order:
 * 1. Secret present
 * 2. Signature header present
 * 3. rawBody parses as JSON
 * 4. All InternalHmacBody fields present + correct types
 * 5. Timestamp within 5-min skew window
 * 6. Signature matches recomputed HMAC over canonicalized parsed body
 * 7. Nonce not replayed (if nonceStore provided)
 *
 * NOTE: Signature is verified over re-canonicalized parsed body (NOT rawBody).
 * This rejects whitespace-injection attacks where attacker mutates rawBody byte-for-byte
 * while maintaining a valid parse — the canonical form will differ.
 * Caller MUST use signRequest() to produce rawBody so canonical === serialized form.
 */
export function verifyRequest(input: {
  rawBody: string;
  signature: string | null;
  secret: string;
  now?: number;
  nonceStore?: NonceStore;
}): VerifyResult {
  const { rawBody, signature, secret, nonceStore } = input;
  const now = input.now ?? Date.now();

  if (!secret) return { ok: false, reason: 'no_secret' };
  if (!signature) return { ok: false, reason: 'malformed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Strict field validation — all fields required, correct types
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !isValidBody(parsed as Record<string, unknown>)
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const body = parsed as InternalHmacBody;

  // Skew check: 5-minute window (mirrors slack-crypto.ts)
  if (Math.abs(now - body.timestamp) > 5 * 60 * 1000) {
    return { ok: false, reason: 'expired' };
  }

  // Signature verification — recompute over canonical form of parsed body
  const expected = createHmac('sha256', secret).update(canonicalize(body)).digest('hex');
  if (!safeEqHex(expected, signature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Replay protection — check nonce after signature passes (prevents oracle attacks)
  if (nonceStore) {
    if (nonceStore.has(body.nonce)) {
      return { ok: false, reason: 'replay' };
    }
    // Store nonce with 10-min TTL (2× skew window) for replay protection.
    // Use wall clock (Date.now()) not body.timestamp so TTL is always 10 min from now.
    nonceStore.add(body.nonce, Date.now() + 10 * 60 * 1000);
  }

  return { ok: true, body };
}

/**
 * Type guard for InternalHmacBody — validates all required fields and types.
 */
function isValidBody(obj: Record<string, unknown>): obj is InternalHmacBody {
  return (
    typeof obj['branch'] === 'string' &&
    typeof obj['version'] === 'string' &&
    typeof obj['projectKey'] === 'string' &&
    typeof obj['releaseId'] === 'string' &&
    typeof obj['actorEmail'] === 'string' &&
    (typeof obj['slackChannelId'] === 'string' || obj['slackChannelId'] === null) &&
    (typeof obj['slackMessageTs'] === 'string' || obj['slackMessageTs'] === null) &&
    typeof obj['timestamp'] === 'number' &&
    typeof obj['nonce'] === 'string' &&
    (obj['nonce'] as string).length === 32
  );
}

/**
 * Creates an in-memory nonce store for replay protection.
 * Backed by a Map<nonce, expiresAt>. Lazy expiry sweep runs on every add().
 * Per-instance — multi-instance FAH replay tolerance bounded by 5-min skew window.
 */
export function createMemoryNonceStore(): NonceStore {
  const store = new Map<string, number>();

  function sweep(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of store.entries()) {
      if (now > expiresAt) {
        store.delete(nonce);
      }
    }
  }

  return {
    has(nonce: string): boolean {
      const expiresAt = store.get(nonce);
      if (expiresAt === undefined) return false;
      // Treat expired entries as absent (belt-and-suspenders with sweep)
      if (Date.now() > expiresAt) {
        store.delete(nonce);
        return false;
      }
      return true;
    },
    add(nonce: string, expiresAt: number): void {
      sweep();
      store.set(nonce, expiresAt);
    },
  };
}
