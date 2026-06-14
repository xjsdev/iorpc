import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pair } from '../index.esm.js';
import { createPair, tick } from './helpers/setup.js';

// These tests run the README code examples VERBATIM (only the transport is
// swapped for the simulated link). Acceptance: "all README examples keep
// working without code changes".

// ---------------------------------------------------------------------------
// README: "Why ioRPC is Great" / top examples
// ---------------------------------------------------------------------------

test('readme: transparent remote call  await remote.add(1, 2)', async () => {
  const { a } = createPair({ localB: { add(x, y) { return x + y; } } });
  assert.equal(await a.remote.add(1, 2), 3);
});

test('readme: function serialization  let fn = await remote.getCallback(); await fn("hello")', async () => {
  const { a } = createPair({
    localB: { async getCallback() { return msg => 'got:' + msg; } }
  });
  const fn = await a.remote.getCallback();
  assert.equal(await fn('hello'), 'got:hello');
  fn.unbind();
});

// ---------------------------------------------------------------------------
// README: "Real-World Example: UI + Web Worker"
// processData([1,2,3], progress => ...)
// ---------------------------------------------------------------------------

test('readme: UI + Worker processData with onProgress callback', async () => {
  // worker.js localApi (verbatim)
  const workerApi = {
    async processData(data, onProgress) {
      for (let i = 0; i < data.length; i++) {
        await new Promise(r => setTimeout(r, 5)); // README uses 500ms; shortened
        await onProgress((i + 1) / data.length);
      }
    }
  };

  const progress = [];
  const { a } = createPair({ localB: workerApi });

  await a.remote.processData([1, 2, 3], p => { progress.push(p); });

  assert.deepEqual(progress, [1 / 3, 2 / 3, 3 / 3]);
});

// ---------------------------------------------------------------------------
// README: "Example" script1.js localApi  (func1 / func2 / func)
// ---------------------------------------------------------------------------

test('readme: script1 func1 / func2 / func examples (verbatim localApi)', async () => {
  const localApi = {
    func1(a, b) {
      return a + b;
    },
    async func2(a, cb) {
      const b = await cb(a);
      return c => a + b + c;
    },
    func(cb) {
      const h = setInterval(async () => {
        await cb();
      }, 1000);
      return () => {
        cb.unbind();
        clearInterval(h);
      };
    }
  };

  const { a } = createPair({ localB: localApi });

  // const x1 = await remoteApi.func1("Hello"," world")
  const x1 = await a.remote.func1('Hello', ' world');
  assert.equal(x1, 'Hello world');

  // const x2 = await remoteApi.func2(2, a => a*2)
  const x2 = await a.remote.func2(2, a2 => a2 * 2); // b = 4
  assert.equal(typeof x2, 'function');

  // const x3 = await x2(2)  -> a(2) + b(4) + c(2)
  const x3 = await x2(2);
  assert.equal(x3, 8);
  x2.unbind();

  // const remoteFunctionWithUnbind = await remoteApi.func(()=>{})
  const remoteFunctionWithUnbind = await a.remote.func(() => {});
  assert.equal(typeof remoteFunctionWithUnbind, 'function');
  await remoteFunctionWithUnbind(); // triggers cb.unbind() + clearInterval
  remoteFunctionWithUnbind.unbind();
});

// ---------------------------------------------------------------------------
// README: WebSocket host localApi (verbatim) exercised end-to-end via the
// client scenario from wsClient.js.
// ---------------------------------------------------------------------------

function buildHostApi(log) {
  return {
    greetings(data) {
      log.push('Received:' + data);
      return data + ' world';
    },
    greetings2(data) {
      return new Promise(resolve => {
        setTimeout(() => {
          resolve(data + ' world');
        }, 20); // README: 1000ms, shortened for the test
      });
    },
    subscribeToUpdates(cbOnClient) {
      // not an arrow function -> this.remoteApi / this.iorpcPending available
      const self = this;
      const hSubscribeInterval = setInterval(async () => {
        const iorpcPending = await cbOnClient(Date.now());
        log.push(`ClbsSize: remote ${iorpcPending} local ${self.iorpcPending()}`);
      }, 10);
      return function () {
        cbOnClient.unbind();
        clearInterval(hSubscribeInterval);
        return 'unbinded';
      };
    },
    clbsSize() {
      return this.iorpcPending();
    },
    functionWithError() {
      const a = b + 1; // b is not defined
      return a;
    },
    functionWithThrow() {
      throw 'someError';
    },
    async functionWithErrorInCb(cb) {
      try {
        await cb();
      } catch (e) {
        log.push('caught-in-cb');
      }
      return () => {
        const a = d + 1; // d is not defined
        return a;
      };
    },
    async functionWithReturnOfTwoFn() {
      return {
        fn1() { return 'fn1 ok'; },
        fn2() { return 'fn2 ok'; }
      };
    }
  };
}

test('readme: wsHost greetings / greetings2 / noWait greetings', async () => {
  const log = [];
  const { a } = createPair({
    localB: buildHostApi(log),
    optionsB: { injectToThis: true }
  });

  const ret = await a.remote.greetings2('Hello');
  assert.equal(ret, 'Hello world'); // README: "Hello world"

  a.remote.noWait.greetings('Hi'); // fire-and-forget
  await tick(10);
  assert.ok(log.includes('Received:Hi'));
});

test('readme: wsHost subscribeToUpdates + unsubscribe + clbsSize cleanup', async () => {
  const log = [];
  const serverTimes = [];
  const { a, b } = createPair({
    localB: buildHostApi(log),
    optionsB: { injectToThis: true }
  });

  // const unsubscribe = await remote.subscribeToUpdates(function (time) {
  //   console.log("server time:" + time); return this.iorpcPending() })
  const unsubscribe = await a.remote.subscribeToUpdates(function (time) {
    serverTimes.push(time);
    return this.iorpcPending();
  });

  await tick(35); // let a few interval ticks happen
  assert.ok(serverTimes.length >= 1, 'callback should have fired at least once');

  const res = await unsubscribe(); // res = 'unbinded'
  assert.equal(res, 'unbinded');
  unsubscribe.unbind();
  await tick(15);

  // overflow check: README expects both sides back to 0
  const remoteClbsSize = await a.remote.clbsSize();
  const localClbsSize = a.pending();
  assert.equal(remoteClbsSize, 0, 'remote ClbsSize final should be 0');
  assert.equal(localClbsSize, 0, 'local ClbsSize final should be 0');
});

test('readme: wsHost broadcast remote errors (functionWithError / functionWithThrow)', async () => {
  const log = [];
  const { a } = createPair({
    localB: buildHostApi(log),
    optionsB: { injectToThis: true }
  });

  // try { await remote.functionWithError() } catch (e) -> ReferenceError forwarded
  await assert.rejects(a.remote.functionWithError(), (e) => {
    assert.equal(e.name, 'RemoteError');
    assert.match(e.message, /b is not defined/);
    return true;
  });

  // try { await remote.functionWithThrow() } catch (e) -> 'someError'
  await assert.rejects(a.remote.functionWithThrow(), (e) => {
    assert.equal(e, 'someError');
    return true;
  });
});

test('readme: wsHost functionWithErrorInCb (error inside passed cb + error in returned fn)', async () => {
  const log = [];
  const { a } = createPair({
    localB: buildHostApi(log),
    optionsB: { injectToThis: true }
  });

  // const cbWithErr = await remote.functionWithErrorInCb(()=>{ const a = c + 1 })
  const cbWithErr = await a.remote.functionWithErrorInCb(() => {
    const x = c + 1; // c is not defined -> error inside the callback
    return x;
  });
  // server caught the cb error
  assert.ok(log.includes('caught-in-cb'));

  // await cbWithErr() -> the returned fn throws (d is not defined) -> forwarded
  await assert.rejects(cbWithErr(), (e) => {
    assert.equal(e.name, 'RemoteError');
    assert.match(e.message, /d is not defined/);
    return true;
  });
  cbWithErr.unbind();
});

test('readme: wsHost functionWithReturnOfTwoFn (allowNestedFunctions)', async () => {
  const log = [];
  const { a } = createPair({
    localB: buildHostApi(log),
    optionsA: { allowNestedFunctions: true },
    optionsB: { allowNestedFunctions: true, injectToThis: true }
  });

  // const {fn1, fn2} = await remote.functionWithReturnOfTwoFn()
  const { fn1, fn2 } = await a.remote.functionWithReturnOfTwoFn();
  assert.equal(await fn1(), 'fn1 ok');
  assert.equal(await fn2(), 'fn2 ok');
  fn1.unbind();
  fn2.unbind();
});

// ---------------------------------------------------------------------------
// README: "Functions in `this` object" — nested injectToThis on cb-returned fns
// ---------------------------------------------------------------------------

test('readme: injectToThis exposes remoteApi & iorpcPending in nested functions', async () => {
  const seen = {};
  const localApi = {
    func(cb) {
      seen.hostThisRemote = typeof this.remoteApi;
      seen.hostThisPending = typeof this.iorpcPending;
      cb();
    }
  };

  const { a } = createPair({
    localB: localApi,
    optionsB: { injectToThis: true }
  });

  await a.remote.func(function () {
    // README: in non-arrow callbacks, this.remoteApi / this.iorpcPending exist
    seen.cbThisRemote = typeof this.remoteApi;
    seen.cbThisPending = typeof this.iorpcPending;
  });

  await tick(5);
  assert.equal(seen.hostThisRemote, 'object');
  assert.equal(seen.hostThisPending, 'function');
  assert.equal(seen.cbThisRemote, 'object');
  assert.equal(seen.cbThisPending, 'function');
});

// ---------------------------------------------------------------------------
// README: rejectAll usage shown in the new "Transport constraints" / Return docs
//   ws.on('close', () => api.rejectAll(new Error('socket closed')))
// ---------------------------------------------------------------------------

test('readme: rejectAll on transport close rejects pending calls', async () => {
  const { a } = createPair({
    localB: { hold() { return new Promise(() => {}); } }
  });

  const p = a.remote.hold();
  await tick(5);
  a.rejectAll(new Error('socket closed'));
  await assert.rejects(p, (e) => /socket closed/.test(e.message));
  assert.equal(a.pending(), 0);
});
