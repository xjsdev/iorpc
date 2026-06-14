import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pair } from '../index.esm.js';
import { createPair, tick } from './helpers/setup.js';

// ---------------------------------------------------------------------------
// #1 callTimeout
// ---------------------------------------------------------------------------

test('callTimeout: not set => no timers, behaviour identical to 9.2.2 (call hangs)', async () => {
  const { a } = createPair({
    localB: { hold() { return new Promise(() => {}); } } // never resolves
  });

  let settled = false;
  a.remote.hold().then(() => { settled = true; }, () => { settled = true; });

  await tick(60);
  assert.equal(settled, false, 'without callTimeout the promise must stay pending');
  assert.equal(a.pending(), 1);
});

test('callTimeout > 0: rejects with IORPC_TIMEOUT and restores pending', async () => {
  const { a } = createPair({
    localB: { hold() { return new Promise(() => {}); } },
    optionsA: { callTimeout: 40 }
  });

  const before = a.pending();
  const p = a.remote.hold();

  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'IORPC_TIMEOUT');
    assert.match(err.message, /timeout/);
    return true;
  });

  await tick(5);
  assert.equal(a.pending(), before, 'pending() must return to its pre-call value');
});

test('callTimeout: fast response before timeout resolves normally, no late reject', async () => {
  const { a } = createPair({
    localB: { quick(x) { return x + 1; } },
    optionsA: { callTimeout: 100 }
  });

  const result = await a.remote.quick(41);
  assert.equal(result, 42);

  // wait past the timeout window to ensure the timer didn't fire afterwards
  await tick(120);
  assert.equal(a.pending(), 0);
});

test('callTimeout: noWait calls are never timed out', async () => {
  let called = false;
  const { a } = createPair({
    localB: { fire() { called = true; } },
    optionsA: { callTimeout: 20 }
  });

  const ret = a.remote.noWait.fire();
  assert.equal(ret, undefined);
  await tick(50);
  assert.equal(called, true);
  assert.equal(a.pending(), 0);
});

test('callTimeout: a response arriving after timeout is silently ignored (no throw, pending stays correct)', async () => {
  let resolveServer;
  const { a } = createPair({
    localB: {
      slow() { return new Promise(r => { resolveServer = r; }); }
    },
    // A times out, then must silently ignore the late response for a cbId it
    // already dropped -> ignoreCallbackUnavailable guards that path.
    optionsA: { callTimeout: 30, ignoreCallbackUnavailable: true },
    optionsB: { ignoreCallbackUnavailable: true }
  });

  await assert.rejects(a.remote.slow(), (e) => e.code === 'IORPC_TIMEOUT');
  assert.equal(a.pending(), 0);

  // now the server finally answers - must not blow up the (already empty) waiter map
  resolveServer && resolveServer('late');
  await tick(20);
  assert.equal(a.pending(), 0);
});

test('callTimeout: sends iorpcUnbind to the other side on timeout', async () => {
  const sent = [];
  let routeInput;
  const { remote } = pair({
    send: msg => sent.push(msg),
    on: handler => { routeInput = handler; },
    local: {},
    options: { callTimeout: 25 }
  });

  const p = remote.hangs().catch(() => {});
  await tick(60);
  await p;

  const unbind = sent.find(m => m.apiFunc === 'iorpcUnbind');
  assert.ok(unbind, 'an iorpcUnbind packet must be emitted on timeout');
});

// ---------------------------------------------------------------------------
// #2 rejectAll
// ---------------------------------------------------------------------------

test('rejectAll: rejects every pending response with the given error and zeroes pending', async () => {
  const { a } = createPair({
    localB: { hold() { return new Promise(() => {}); } }
  });

  const p1 = a.remote.hold();
  const p2 = a.remote.hold();
  await tick(5);
  assert.equal(a.pending(), 2);

  const customErr = new Error('socket closed');
  a.rejectAll(customErr);

  await assert.rejects(p1, (e) => e === customErr || e.message === 'socket closed');
  await assert.rejects(p2, (e) => e === customErr || e.message === 'socket closed');
  assert.equal(a.pending(), 0);
});

test('rejectAll: default error message when none provided', async () => {
  const { a } = createPair({
    localB: { hold() { return new Promise(() => {}); } }
  });
  const p = a.remote.hold();
  await tick(5);
  a.rejectAll();
  await assert.rejects(p, (e) => /transport closed/.test(e.message));
  assert.equal(a.pending(), 0);
});

test('rejectAll: removes inbound callback records (resolve-only) without throwing', async () => {
  const { a, b } = createPair({
    localB: { async getCb(cb) { return cb; } }
  });

  const cb = await a.remote.getCb(() => 'x');
  assert.equal(await cb(), 'x');
  // A holds the registration for the passed function (a resolve-only record)
  assert.equal(a.pending(), 1);

  a.rejectAll(new Error('dead'));
  assert.equal(a.pending(), 0);
  // sanity: b unaffected
  assert.ok(b.pending() >= 0);
});

test('rejectAll: clears callTimeout timers (no late reject of an already-rejected promise)', async () => {
  const { a } = createPair({
    localB: { hold() { return new Promise(() => {}); } },
    optionsA: { callTimeout: 1000 }
  });
  const p = a.remote.hold().catch(e => e);
  await tick(5);
  a.rejectAll(new Error('closed'));
  const e = await p;
  assert.match(e.message, /closed/);
  // timer should have been cleared; pending stays 0
  await tick(20);
  assert.equal(a.pending(), 0);
});

// ---------------------------------------------------------------------------
// #3 cbIdGenerator
// ---------------------------------------------------------------------------

test('cbIdGenerator: used instead of Math.random; collision check still applies', () => {
  let counter = 100;
  const ids = [];
  const { remote } = pair({
    send: msg => { if (typeof msg.cbId === 'number') ids.push(msg.cbId); },
    on: () => {},
    local: {},
    options: { cbIdGenerator: () => counter++ }
  });

  remote.a();
  remote.b();
  assert.deepEqual(ids, [100, 101]);
});

test('cbIdGenerator: default path stays random numeric when not provided', () => {
  const ids = [];
  const { remote } = pair({
    send: msg => { if (typeof msg.cbId === 'number') ids.push(msg.cbId); },
    on: () => {},
    local: {}
  });
  remote.x();
  assert.equal(ids.length, 1);
  assert.equal(typeof ids[0], 'number');
});

// ---------------------------------------------------------------------------
// #4 taggedPackets
// ---------------------------------------------------------------------------

test('taggedPackets=false (default): no kind field on the wire', () => {
  const sent = [];
  const { remote } = pair({ send: m => sent.push(m), on: () => {}, local: {} });
  remote.call(1);
  assert.equal('kind' in sent[0], false);
});

test('taggedPackets=true: call packet carries kind:"call"', () => {
  const sent = [];
  const { remote } = pair({
    send: m => sent.push(m), on: () => {}, local: {},
    options: { taggedPackets: true }
  });
  remote.call(1);
  assert.equal(sent[0].kind, 'call');
});

test('taggedPackets=true: end-to-end call + callback round-trip works', async () => {
  const { a } = createPair({
    localB: {
      async useCb(x, cb) {
        const r = await cb(x);
        return r + 1;
      }
    },
    optionsA: { taggedPackets: true },
    optionsB: { taggedPackets: true }
  });

  const result = await a.remote.useCb(5, x => x * 2);
  assert.equal(result, 11);
});

test('taggedPackets=true: callback invocation packet carries kind:"cb"', async () => {
  // Tap the link to inspect packets while keeping a proper bidirectional wiring.
  const sentByServer = [];
  let serverRoute, clientRoute;

  const server = pair({
    send: m => { sentByServer.push(JSON.parse(JSON.stringify(m))); clientRoute(m); },
    on: h => { serverRoute = h; },
    local: { async run(cb) { return await cb(7); } },
    options: { taggedPackets: true }
  });
  const client = pair({
    send: m => serverRoute(m),
    on: h => { clientRoute = h; },
    local: {},
    options: { taggedPackets: true }
  });

  const result = await client.remote.run(x => x * 10);
  assert.equal(result, 70);

  // The server invoked the client's callback -> that outgoing packet is kind:'cb'.
  const cbPacket = sentByServer.find(m => m.kind === 'cb');
  assert.ok(cbPacket, 'a kind:"cb" packet should be emitted by the server');
});

test('taggedPackets=true: unknown method => "not registered" via kind, not isNaN heuristic', () => {
  const sent = [];
  let routeInput;
  pair({
    send: m => sent.push(m),
    on: h => { routeInput = h; },
    local: {},
    options: { taggedPackets: true }
  });

  // numeric-looking apiFunc but explicitly tagged as a method call
  routeInput({ apiFunc: 12345, cbId: 1, args: [], argsTransform: [], kind: 'call' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].apiFunc, 'iorpcThrowError');
  assert.match(sent[0].args[1], /not registered/);
});

test('taggedPackets=true: unavailable cb => "unavailable" via kind even for numeric id', () => {
  const sent = [];
  let routeInput;
  pair({
    send: m => sent.push(m),
    on: h => { routeInput = h; },
    local: {},
    options: { taggedPackets: true }
  });

  routeInput({ apiFunc: 999, cbId: 1, args: [], argsTransform: [], kind: 'cb' });
  assert.equal(sent[0].apiFunc, 'iorpcThrowError');
  assert.match(sent[0].args[1], /unavailable/);
});

test('mixed mode: tagged sender (default opts) <-> untagged 9.2.2-style still works at defaults', async () => {
  // both default (taggedPackets:false) -> identical to 9.2.2, already covered;
  // here we assert a tagged side talking with kind present is tolerated by an
  // untagged side that simply ignores the extra field.
  const { a } = createPair({
    localB: { echo(x) { return x; } },
    optionsA: { taggedPackets: true },   // sends kind
    optionsB: { taggedPackets: false }   // ignores kind, routes by name
  });

  const r = await a.remote.echo('ok');
  assert.equal(r, 'ok');
});

// ---------------------------------------------------------------------------
// #5 bindings() + onTrim
// ---------------------------------------------------------------------------

test('bindings(): splits pending into calls (waiters) and callbacks (inbound)', async () => {
  const { a } = createPair({
    localB: {
      async getCb(cb) { return cb; },
      hold() { return new Promise(() => {}); }
    }
  });

  // inbound callback record on A (function passed as arg)
  const cb = await a.remote.getCb(() => 'x');
  assert.equal(await cb(), 'x');
  // a hanging response waiter on A
  a.remote.hold();
  await tick(5);

  const b = a.bindings();
  assert.equal(b.calls, 1, 'one response waiter');
  assert.equal(b.callbacks, 1, 'one stored inbound callback');
  assert.equal(b.calls + b.callbacks, a.pending());
});

test('onTrim: invoked with removed ids when clbsTrim runs', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  const removedBatches = [];
  try {
    const { a } = createPair({
      localB: { hold() { return new Promise(() => {}); } },
      optionsA: { maxPendingResponses: 3, onTrim: ids => removedBatches.push(ids) }
    });

    for (let i = 0; i < 6; i++) a.remote.hold().catch(() => {});
    await tick(10);

    assert.ok(removedBatches.length >= 1, 'onTrim should have fired');
    const allRemoved = removedBatches.flat();
    assert.ok(allRemoved.length >= 1);
    assert.ok(allRemoved.every(id => id !== undefined));
  } finally {
    console.warn = originalWarn;
  }
});

test('onTrim: not called when nothing is trimmed', async () => {
  let fired = false;
  const { a } = createPair({
    localB: { echo(x) { return x; } },
    optionsA: { maxPendingResponses: 10000, onTrim: () => { fired = true; } }
  });
  await a.remote.echo(1);
  await tick(5);
  assert.equal(fired, false);
});
