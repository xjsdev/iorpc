import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPair, tick } from './helpers/setup.js';

test('basic: calls a remote function and gets a result', async () => {
  const { a } = createPair({
    localB: {
      add(x, y) { return x + y; }
    }
  });

  const result = await a.remote.add(2, 3);
  assert.equal(result, 5);
});

test('basic: remote function can be async / return a promise', async () => {
  const { a } = createPair({
    localB: {
      async delayedAdd(x, y) {
        await tick(5);
        return x + y;
      }
    }
  });

  const result = await a.remote.delayedAdd(10, 20);
  assert.equal(result, 30);
});

test('basic: bidirectional calls work', async () => {
  const { a, b } = createPair({
    localA: { ping() { return 'pong-from-A'; } },
    localB: { ping() { return 'pong-from-B'; } }
  });

  assert.equal(await a.remote.ping(), 'pong-from-B');
  assert.equal(await b.remote.ping(), 'pong-from-A');
});

test('basic: pending() reflects in-flight calls and resets after resolution', async () => {
  let resolveFn;
  const { a } = createPair({
    localB: {
      slow() {
        return new Promise(resolve => { resolveFn = resolve; });
      }
    }
  });

  assert.equal(a.pending(), 0);
  const p = a.remote.slow();
  // give the call a chance to register
  await tick(1);
  assert.equal(a.pending(), 1);

  resolveFn('done');
  assert.equal(await p, 'done');
  await tick(1);
  assert.equal(a.pending(), 0);
});
