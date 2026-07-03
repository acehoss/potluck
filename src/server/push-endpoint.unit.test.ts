import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isAllowedPushEndpoint } from './push-endpoint';

const originalSeedDemo = process.env.SEED_DEMO;
afterEach(() => {
  if (originalSeedDemo === undefined) delete process.env.SEED_DEMO;
  else process.env.SEED_DEMO = originalSeedDemo;
});

test('accepts the real push services', () => {
  delete process.env.SEED_DEMO;
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc123:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QOb2...token',
    'https://db5p.notify.windows.com/w/?token=abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ]) {
    assert.equal(isAllowedPushEndpoint(endpoint), true, endpoint);
  }
});

test('rejects non-https schemes', () => {
  delete process.env.SEED_DEMO;
  assert.equal(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false);
  assert.equal(isAllowedPushEndpoint('ftp://fcm.googleapis.com/x'), false);
  assert.equal(isAllowedPushEndpoint('file:///etc/passwd'), false);
  assert.equal(isAllowedPushEndpoint('not a url'), false);
});

test('rejects IP literals — the cloud-metadata / LAN-probe SSRF shapes', () => {
  delete process.env.SEED_DEMO;
  for (const endpoint of [
    'https://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/admin',
    'https://192.168.1.1/',
    'https://127.0.0.1/api',
    'https://[::1]/api',
    'https://[fd00::1]/x',
  ]) {
    assert.equal(isAllowedPushEndpoint(endpoint), false, endpoint);
  }
});

test('rejects intranet-shaped hostnames', () => {
  delete process.env.SEED_DEMO;
  for (const endpoint of [
    'https://internal-service/path',
    'https://localhost/api',
    'https://foo.localhost/api',
    'https://printer.local/jobs',
    'https://db.internal/query',
    'https://nas.home.arpa/share',
  ]) {
    assert.equal(isAllowedPushEndpoint(endpoint), false, endpoint);
  }
});

test('rejects non-443 ports and embedded credentials', () => {
  delete process.env.SEED_DEMO;
  assert.equal(isAllowedPushEndpoint('https://push.example.com:8443/x'), false);
  assert.equal(isAllowedPushEndpoint('https://user:pass@push.example.com/x'), false);
});

test('e2e sink loopback is allowed ONLY under SEED_DEMO=1 and only at its path', () => {
  process.env.SEED_DEMO = '1';
  assert.equal(isAllowedPushEndpoint('http://127.0.0.1:3000/api/dev/push-sink/a'), true);
  assert.equal(isAllowedPushEndpoint('http://localhost:3000/api/dev/push-sink/a?status=410'), true);
  // Same demo stack, but not the sink: still rejected.
  assert.equal(isAllowedPushEndpoint('http://127.0.0.1:3000/api/health'), false);
  assert.equal(isAllowedPushEndpoint('http://169.254.169.254/api/dev/push-sink/a'), false);

  process.env.SEED_DEMO = '0';
  assert.equal(isAllowedPushEndpoint('http://127.0.0.1:3000/api/dev/push-sink/a'), false);
});
