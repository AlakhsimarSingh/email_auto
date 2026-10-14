import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReply } from './reply-classification.js';

test('classifies automatic replies by header and subject', () => {
  assert.equal(classifyReply('client@example.com', 'Re: hello', new Map([['auto-submitted', 'auto-replied']]), ''), 'auto_reply');
  assert.equal(classifyReply('client@example.com', 'Out of office', new Map(), ''), 'auto_reply');
});

test('classifies hard bounces and unsubscribe requests', () => {
  assert.equal(classifyReply('Mail Delivery Subsystem <mailer-daemon@example.com>', 'Delivery Status', new Map(), ''), 'bounce');
  assert.equal(classifyReply('client@example.com', 'Re: hello', new Map(), 'Please unsubscribe me.'), 'unsubscribe');
});

test('classifies complaints and normal human replies', () => {
  assert.equal(classifyReply('client@example.com', 'Spam complaint', new Map(), 'How did you get my email?'), 'complaint');
  assert.equal(classifyReply('client@example.com', 'Re: hello', new Map(), 'Yes, please send details.'), 'human');
});
