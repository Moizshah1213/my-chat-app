import assert from 'node:assert/strict';
import test from 'node:test';
import { getProviderErrorDetail, normalizeAiReply } from '../ai-reply.js';

test('AI replies are normalized to readable plain text', () => {
  assert.equal(
    normalizeAiReply('## Hello **there** ✨\n\n- We can help [you](https://example.com).\n\n`Thanks`'),
    'Hello there\n\nWe can help you.\n\nThanks',
  );
});

test('provider errors include useful details without exposing the API key', () => {
  assert.equal(
    getProviderErrorDetail(
      { error: { message: 'Model is unavailable for key secret-token' } },
      'secret-token',
    ),
    'Model is unavailable for key [redacted]',
  );
  assert.equal(getProviderErrorDetail({ error: { code: 'not_found' } }, 'secret-token'), null);
});
