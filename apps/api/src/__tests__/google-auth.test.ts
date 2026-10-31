import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.GOOGLE_OAUTH_CLIENT_IDS = 'test-client-id.apps.googleusercontent.com';
const { verifyGoogleIdToken } = await import('../google-auth.js');

describe('Google ID-token verification', () => {
  it('rejects malformed credentials without accepting client-supplied identity data', async () => {
    await assert.rejects(
      verifyGoogleIdToken('not-a-jwt'),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        error.status === 401,
    );
  });
});
