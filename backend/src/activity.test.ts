import assert from 'node:assert/strict';
import test from 'node:test';
import { activity, activitySnapshot, runStage } from './activity.js';

test('records events in order and returns only events after a cursor', () => {
  const before = activitySnapshot().latestId;
  activity('discover', 'Searching OpenStreetMap');
  activity('discover', 'Added 3 businesses', 'success');
  const snapshot = activitySnapshot(before);
  assert.deepEqual(snapshot.events.map((event) => event.message), ['Searching OpenStreetMap', 'Added 3 businesses']);
  assert.equal(snapshot.events[1]?.level, 'success');
  assert.equal(activitySnapshot(snapshot.latestId).events.length, 0);
});

test('a failing stage is marked as an error without throwing', async () => {
  await runStage('send', 'Checking the send queue', async () => { throw new Error('Gmail unavailable'); });
  const snapshot = activitySnapshot();
  assert.equal(snapshot.stages.send.status, 'error');
  assert.match(snapshot.events.at(-1)?.message ?? '', /Failed: Gmail unavailable/);
});

test('a successful stage is marked done with a duration', async () => {
  await runStage('learn', 'Updating the model', async () => {});
  const state = activitySnapshot().stages.learn;
  assert.equal(state.status, 'done');
  assert.equal(typeof state.durationMs, 'number');
});
