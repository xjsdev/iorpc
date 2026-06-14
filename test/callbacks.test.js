import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPair, tick } from './helpers/setup.js';

test('callbacks: passing a function as argument calls back on the original side', async () => {
  const { a } = createPair({
    localB: {
      async useCallback(x, cb) {
        const doubled = await cb(x);
        return doubled + 1;
      }
    }
  });

  const result = await a.remote.useCallback(5, x => x * 2);
  assert.equal(result, 11);
});

test('callbacks: function returned from remote call can be invoked', async () => {
  const { a } = createPair({
    localB: {
      async makeAdder(base, cb) {
        const extra = await cb(base);
        return c => base + extra + c;
      }
    }
  });

  const fn = await a.remote.makeAdder(2, x => x * 2); // extra = 4
  assert.equal(typeof fn, 'function');
  const result = await fn(10); // 2 + 4 + 10
  assert.equal(result, 16);
  fn.unbind();
});

test('callbacks: unbind() releases the binding and notifies the other side', async () => {
  const { a, b } = createPair({
    localB: {
      async getCallback(cb) {
        // store cb usage isn't necessary, just return it indirectly via b
        return cb;
      }
    }
  });

  const cb = await a.remote.getCallback(() => 'hello');
  assert.equal(await cb(), 'hello');

  // A side: holds the registration for the function passed as argument
  // B side: holds the mirrored callback binding (returned cb)
  assert.equal(a.pending(), 1);
  assert.equal(b.pending(), 1);

  cb.unbind();
  await tick(5);
  // unbind() notifies B to release its mirrored binding
  assert.equal(b.pending(), 0);
});

test('callbacks: repeated calls to same callback work until unbound', async () => {
  const { a } = createPair({
    localB: {
      async getCallback(cb) {
        return cb;
      }
    }
  });

  let counter = 0;
  const cb = await a.remote.getCallback(() => ++counter);

  assert.equal(await cb(), 1);
  assert.equal(await cb(), 2);
  assert.equal(await cb(), 3);
  cb.unbind();
});

test('callbacks: interval-based callback pattern with cleanup', async () => {
  const calls = [];
  const { a } = createPair({
    localB: {
      func(cb) {
        const h = setInterval(async () => {
          calls.push(await cb());
        }, 5);
        return () => {
          cb.unbind();
          clearInterval(h);
          return 'stopped';
        };
      }
    }
  });

  const stop = await a.remote.func(() => 'tick');
  await tick(30);
  assert.ok(calls.length >= 1, 'callback should have been invoked at least once');

  const result = await stop();
  assert.equal(result, 'stopped');

  const callsAfterStop = calls.length;
  await tick(20);
  assert.equal(calls.length, callsAfterStop, 'no more calls after stop');
});
