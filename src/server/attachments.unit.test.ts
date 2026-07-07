import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStoredAttachmentPath, sanitizeAttachmentName } from './images';

test('sanitizeAttachmentName keeps only a safe pdf basename', () => {
  assert.equal(sanitizeAttachmentName('../secrets/receipt.pdf'), 'receipt.pdf');
  assert.equal(sanitizeAttachmentName('C:\\tmp\\"loan\u202e form".PDF'), 'loan form.pdf');
  assert.equal(sanitizeAttachmentName('   '), 'document.pdf');
  assert.equal(sanitizeAttachmentName('manual'), 'manual.pdf');
});

test('sanitizeAttachmentName caps the final filename at 120 chars', () => {
  const name = sanitizeAttachmentName(`${'a'.repeat(200)}.pdf`);
  assert.equal(name.length, 120);
  assert.match(name, /^a+\.pdf$/);
});

test('isStoredAttachmentPath accepts only server-generated pdf paths', () => {
  assert.equal(isStoredAttachmentPath('attachments/0123456789abcdef0123456789abcdef.pdf'), true);
  assert.equal(isStoredAttachmentPath('../attachments/0123456789abcdef0123456789abcdef.pdf'), false);
  assert.equal(isStoredAttachmentPath('attachments/0123456789abcdef0123456789abcdef.jpg'), false);
  assert.equal(isStoredAttachmentPath('attachments/0123456789abcdef.pdf'), false);
  assert.equal(isStoredAttachmentPath('attachments/0123456789ABCDEF0123456789ABCDEF.pdf'), false);
});
