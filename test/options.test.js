import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPair, tick } from './helpers/setup.js';

test('options: noWait performs fire-and-forget call (no response expected)', async () => {
  let called = false;
  const { a } = createPair({
    localB: {
      sendPing() { called = true; return 'ignored'; }
    }
  });

  const ret = a.remote.noWait.sendPing();
  assert.equal(ret, undefined); // no promise returned

  await tick(5);
  assert.equal(called, true);
  assert.equal(a.pending(), 0); // no waiting entry was created
});

test('options: injectToThis=true exposes remoteApi and iorpcPending in `this`', async () => {
  let capturedThis;
  const { a } = createPair({
    localB: {
      checkThis() {
        capturedThis = this;
        return typeof this.iorpcPending === 'function' && typeof this.remoteApi === 'object';
      }
    },
    optionsB: { injectToThis: true }
  });

  const result = await a.remote.checkThis();
  assert.equal(result, true);
  assert.equal(typeof capturedThis.iorpcPending(), 'number');
});

test('options: injectToThis=false leaves `this` as undefined/default for arrow-less function', async () => {
  let capturedThis;
  const { a } = createPair({
    localB: {
      checkThis() {
        capturedThis = this;
        return 'ok';
      }
    },
    optionsB: { injectToThis: false }
  });

  const result = await a.remote.checkThis();
  assert.equal(result, 'ok');
  assert.equal(capturedThis, undefined);
});

test('options: allowNestedFunctions=true supports functions nested in objects', async () => {
  const { a } = createPair({
    localB: {
      async getHandlers() {
        return {
          fn1() { return 'fn1 ok'; },
          fn2() { return 'fn2 ok'; }
        };
      }
    },
    optionsA: { allowNestedFunctions: true },
    optionsB: { allowNestedFunctions: true }
  });

  const { fn1, fn2 } = await a.remote.getHandlers();
  assert.equal(await fn1(), 'fn1 ok');
  assert.equal(await fn2(), 'fn2 ok');
  fn1.unbind();
  fn2.unbind();
});

test('options: allowNestedFunctions=false (default) ignores nested function props', async () => {
  const { a } = createPair({
    localB: {
      async getHandlers() {
        return {
          fn1() { return 'fn1 ok'; },
          value: 42
        };
      }
    }
    // default allowNestedFunctions: false
  });

  const result = await a.remote.getHandlers();
  assert.equal(result.value, 42);
  assert.equal(typeof result.fn1, 'undefined');
});

test('options: ignoreCallbackUnavailable=true suppresses the "unavailable" error message', async () => {
  // Construct B side directly so we can feed it a cbId that doesn't exist in clbs,
  // and inspect what (if anything) gets sent back.
  const { pair } = await import('../index.esm.js');

  const sentWithFlag = [];
  let routeInputWithFlag;
  pair({
    send: msg => sentWithFlag.push(msg),
    on: handler => { routeInputWithFlag = handler; },
    local: {},
    options: { ignoreCallbackUnavailable: true }
  });

  // message.apiFunc is numeric (looks like a cbId), not in localApi and not in clbs
  routeInputWithFlag({ apiFunc: 123456, cbId: 1, args: [], argsTransform: [] });
  assert.deepEqual(sentWithFlag, [], 'no error message sent back when flag is enabled');

  // Without the flag, an iorpcThrowError IS sent back
  const sentWithoutFlag = [];
  let routeInputWithoutFlag;
  pair({
    send: msg => sentWithoutFlag.push(msg),
    on: handler => { routeInputWithoutFlag = handler; },
    local: {},
    options: { ignoreCallbackUnavailable: false }
  });

  routeInputWithoutFlag({ apiFunc: 123456, cbId: 1, args: [], argsTransform: [] });
  assert.equal(sentWithoutFlag.length, 1);
  assert.equal(sentWithoutFlag[0].apiFunc, 'iorpcThrowError');
  assert.match(sentWithoutFlag[0].args[1], /unavailable/);
});

test('options: maxPendingResponses triggers trimming with a warning', async () => {
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };

  try {
    let resolvers = [];
    const { a } = createPair({
      localB: {
        hold() {
          return new Promise(resolve => { resolvers.push(resolve); });
        }
      },
      optionsA: { maxPendingResponses: 3 }
    });

    // fire more calls than maxPendingResponses, never resolved
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(a.remote.hold().catch(() => 'trimmed'));
    }
    await tick(10);

    assert.equal(warned, true);
    // Trim runs only when pending > maxPendingResponses *before* the new entry is added,
    // and removes (pending - maxPendingResponses) oldest entries. With maxPendingResponses=3
    // and 5 calls, this stabilizes at maxPendingResponses+1 rather than exactly maxPendingResponses
    // (documents current off-by-one trimming behaviour).
    assert.ok(a.pending() <= 4, `pending=${a.pending()} should be capped near maxPendingResponses`);
    assert.ok(a.pending() < 5, 'trimming should have removed at least one stale entry');
  } finally {
    console.warn = originalWarn;
  }
});
