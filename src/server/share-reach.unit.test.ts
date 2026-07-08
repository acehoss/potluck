import assert from 'node:assert/strict';
import { before, test } from 'node:test';

// share-reach.ts imports db.ts, which constructs a Prisma client at import and
// needs DATABASE_URL. These tests only exercise pure helpers.
process.env.DATABASE_URL ||= 'file:/tmp/share-reach-test.db';
let postVisibleToConnection: typeof import('./share-reach').postVisibleToConnection;

before(async () => {
  ({ postVisibleToConnection } = await import('./share-reach'));
});

test('postVisibleToConnection: ALL ignores circle scope', () => {
  assert.equal(postVisibleToConnection({ visibility: 'ALL', scopeCircleIds: [] }, null), true);
  assert.equal(postVisibleToConnection({ visibility: 'ALL', scopeCircleIds: ['circle-a'] }, 'circle-b'), true);
});

test('postVisibleToConnection: SELECT requires the poster-side circle in scope', () => {
  const post = { visibility: 'SELECT', scopeCircleIds: ['circle-a', 'circle-b'] };
  assert.equal(postVisibleToConnection(post, 'circle-a'), true);
  assert.equal(postVisibleToConnection(post, 'circle-c'), false);
  assert.equal(postVisibleToConnection(post, null), false);
});

test('postVisibleToConnection: unknown visibility fails closed', () => {
  assert.equal(postVisibleToConnection({ visibility: 'NOPE', scopeCircleIds: ['circle-a'] }, 'circle-a'), false);
});
