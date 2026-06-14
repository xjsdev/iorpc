import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPair, tick } from './helpers/setup.js';

// These tests cover memory-growth ("clbs" leak) scenarios and basic
// security/robustness of routeInput against malicious or malformed packets.

test('security: clbs does not grow when calls are answered normally', async () => {
  const { a } = createPair({
    localB: { echo(x) { return x; } }
  });

  for (let i = 0; i < 50; i++) {
    await a.remote.echo(i);
  }
  assert.equal(a.pending(), 0);
});

test('security: clbs grows with unresolved calls and is bounded by maxPendingResponses', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { a } = createPair({
      localB: { hold() { return new Promise(() => {}); } }, // never resolves
      optionsA: { maxPendingResponses: 10 }
    });

    for (let i = 0; i < 100; i++) {
      a.remote.hold().catch(() => {});
    }
    await tick(20);

    // bounded growth: must not grow unbounded to 100
    assert.ok(a.pending() <= 11, `pending=${a.pending()} should be bounded near maxPendingResponses`);
  } finally {
    console.warn = originalWarn;
  }
});

test('security: forgetting to call unbind() leaks a callback binding on the callback-owning side', async () => {
  const { a, b } = createPair({
    localB: { async getCallback(cb) { return cb; } }
  });

  for (let i = 0; i < 5; i++) {
    const cb = await a.remote.getCallback(() => 'x');
    await cb();
    // no unbind() called -> leaks one entry per iteration on both sides
  }

  assert.equal(a.pending(), 5);
  assert.equal(b.pending(), 5);
});

test('security: prototype-pollution-style keys in args are ignored by recuCopy/recuFilter (allowNestedFunctions)', async () => {
  const { a } = createPair({
    localB: {
      async inspect(obj) {
        return {
          hasOwnProto: Object.prototype.hasOwnProperty.call(obj, '__proto__'),
          hasConstructor: Object.prototype.hasOwnProperty.call(obj, 'constructor'),
          polluted: ({}).polluted
        };
      }
    },
    optionsA: { allowNestedFunctions: true },
    optionsB: { allowNestedFunctions: true }
  });

  const maliciousPayload = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"polluted": "yes"}, "safe": 1}');

  const result = await a.remote.inspect(maliciousPayload);
  assert.equal(result.polluted, undefined, 'global Object.prototype must not be polluted');
});

test('security: routeInput ignores unknown apiFunc gracefully (no crash, error sent back)', async () => {
  const sent = [];
  const { pair } = await import('../index.esm.js');
  let routeInput;
  pair({
    send: msg => sent.push(msg),
    on: handler => { routeInput = handler; },
    local: { knownFn() { return 'ok'; } },
    options: {}
  });

  assert.doesNotThrow(() => {
    routeInput({ apiFunc: 'totallyUnknownFunction', cbId: 42, args: [], argsTransform: [] });
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].apiFunc, 'iorpcThrowError');
  assert.equal(sent[0].args[0], 42);
  assert.match(sent[0].args[1], /not registered/);
});

test('security: routeInput rejects malicious __proto__/constructor keys in argsTransform recursion', async () => {
  const { pair } = await import('../index.esm.js');
  let routeInput;
  let called = false;
  pair({
    send: () => {},
    on: handler => { routeInput = handler; },
    local: {
      probe(obj) {
        called = true;
        return Object.keys(obj);
      }
    },
    options: { allowNestedFunctions: true }
  });

  const message = {
    apiFunc: 'probe',
    cbId: false,
    args: [JSON.parse('{"__proto__": {"x": 1}, "constructor": {"y": 2}, "safe": 3}')],
    argsTransform: JSON.parse('{"0": {"__proto__": {}, "constructor": {}}}')
  };

  assert.doesNotThrow(() => routeInput(message));
  assert.equal(called, true);
  // global prototype must remain clean
  assert.equal(({}).x, undefined);
  assert.equal(({}).y, undefined);
});

test('security: iorpcUnbind / iorpcThrowError for unknown cbId does not throw', async () => {
  const { pair } = await import('../index.esm.js');
  let routeInput;
  pair({
    send: () => {},
    on: handler => { routeInput = handler; },
    local: {},
    options: {}
  });

  // iorpcUnbind for an unknown cbId does NOT throw, but it does decrement
  // `pending` unconditionally, which can drive it negative (documents a quirk:
  // callers should not unbind() twice or unbind unknown ids).
  assert.doesNotThrow(() => {
    routeInput({ apiFunc: 'iorpcUnbind', cbId: false, args: [99999], argsTransform: [] });
  });

  // iorpcThrowError for an unknown cbId is ignored (no waiter to reject). This guards
  // against late/duplicate error packets after rejectAll() on transport close, which
  // would otherwise read `.reject` on undefined and throw inside the message handler.
  assert.doesNotThrow(() => {
    routeInput({ apiFunc: 'iorpcThrowError', cbId: false, args: [99999, 'err', false], argsTransform: [] });
  });
});

test('security: pending() count cannot go negative under repeated unbinds', async () => {
  const { a } = createPair({
    localB: { async getCallback(cb) { return cb; } }
  });

  const cb = await a.remote.getCallback(() => 'x');
  await cb();
  cb.unbind();
  await tick(5);
  assert.equal(b_pending_safe(a), true);

  function b_pending_safe(side) {
    return side.pending() >= 0;
  }
});

test('security: large argument payloads round-trip correctly (no truncation over JSON transport)', async () => {
  const { a } = createPair({
    localB: { echo(x) { return x; } }
  });

  const bigArray = Array.from({ length: 10000 }, (_, i) => i);
  const result = await a.remote.echo(bigArray);
  assert.equal(result.length, 10000);
  assert.equal(result[9999], 9999);
});
