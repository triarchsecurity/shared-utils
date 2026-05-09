import { describe, it, expect, beforeEach } from 'vitest';
import {
  signRequest,
  verifyRequest,
  createMemoryNonceStore,
  type InternalHmacBody,
} from './internal-hmac';

const TEST_SECRET = 'test-secret-for-unit-tests';
const FIXED_NOW = 1_700_000_000_000; // deterministic timestamp
const FIXED_NONCE = 'a'.repeat(32);   // 32-char hex nonce

const BASE_INPUT: Omit<InternalHmacBody, 'timestamp' | 'nonce'> = {
  branch: 'main',
  version: '1.2.3',
  projectKey: 'test-project',
  releaseId: 'rel-abc123',
  actorEmail: 'admin@example.com',
  slackChannelId: null,
  slackMessageTs: null,
};

describe('signRequest', () => {
  it('produces a body with all required fields and a hex signature', () => {
    const result = signRequest(BASE_INPUT, TEST_SECRET, { now: FIXED_NOW, nonce: FIXED_NONCE });
    expect(result.body.branch).toBe('main');
    expect(result.body.version).toBe('1.2.3');
    expect(result.body.projectKey).toBe('test-project');
    expect(result.body.releaseId).toBe('rel-abc123');
    expect(result.body.actorEmail).toBe('admin@example.com');
    expect(result.body.slackChannelId).toBeNull();
    expect(result.body.slackMessageTs).toBeNull();
    expect(result.body.timestamp).toBe(FIXED_NOW);
    expect(result.body.nonce).toBe(FIXED_NONCE);
    expect(typeof result.signature).toBe('string');
    expect(result.signature).toHaveLength(64); // hex sha256 = 32 bytes = 64 hex chars
  });
});

describe('verifyRequest', () => {
  it('Test 1 (valid): returns ok=true and body on valid signature', () => {
    const { body, signature } = signRequest(BASE_INPUT, TEST_SECRET, { now: FIXED_NOW, nonce: FIXED_NONCE });
    const rawBody = JSON.stringify(body, Object.keys(body).sort());
    const result = verifyRequest({ rawBody, signature, secret: TEST_SECRET, now: FIXED_NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.branch).toBe('main');
      expect(result.body.actorEmail).toBe('admin@example.com');
    }
  });

  it('Test 2 (tampered): returns bad_signature when rawBody is mutated', () => {
    const { body, signature } = signRequest(BASE_INPUT, TEST_SECRET, { now: FIXED_NOW, nonce: FIXED_NONCE });
    const rawBody = JSON.stringify(body, Object.keys(body).sort());
    // Flip one char to simulate tampering
    const tampered = rawBody.replace('"main"', '"tampered"');
    const result = verifyRequest({ rawBody: tampered, signature, secret: TEST_SECRET, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad_signature');
    }
  });

  it('Test 3 (expired): returns expired when timestamp is older than 5 minutes', () => {
    const oldNow = FIXED_NOW - 6 * 60 * 1000;
    const { body, signature } = signRequest(BASE_INPUT, TEST_SECRET, { now: oldNow, nonce: FIXED_NONCE });
    const rawBody = JSON.stringify(body, Object.keys(body).sort());
    // Verify with current now (FIXED_NOW) — 6 min gap exceeds 5 min window
    const result = verifyRequest({ rawBody, signature, secret: TEST_SECRET, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
    }
  });

  it('Test 4 (replay): second call with same nonce returns replay', () => {
    const store = createMemoryNonceStore();
    const { body, signature } = signRequest(BASE_INPUT, TEST_SECRET, { now: FIXED_NOW, nonce: FIXED_NONCE });
    const rawBody = JSON.stringify(body, Object.keys(body).sort());

    const first = verifyRequest({ rawBody, signature, secret: TEST_SECRET, now: FIXED_NOW, nonceStore: store });
    expect(first.ok).toBe(true);

    const second = verifyRequest({ rawBody, signature, secret: TEST_SECRET, now: FIXED_NOW, nonceStore: store });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('replay');
    }
  });

  it('Test 5 (malformed): rawBody is not JSON', () => {
    const result = verifyRequest({ rawBody: 'not json', signature: 'abc', secret: TEST_SECRET, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('Test 6 (missing fields): rawBody missing nonce field', () => {
    const { body } = signRequest(BASE_INPUT, TEST_SECRET, { now: FIXED_NOW, nonce: FIXED_NONCE });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { nonce: _, ...bodyWithoutNonce } = body;
    const rawBody = JSON.stringify(bodyWithoutNonce, Object.keys(bodyWithoutNonce).sort());
    const result = verifyRequest({ rawBody, signature: 'doesnotmatter', secret: TEST_SECRET, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });
});
