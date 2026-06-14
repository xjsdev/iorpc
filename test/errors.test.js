import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPair, tick } from './helpers/setup.js';

test('errors: synchronous throw in local function is forwarded as RemoteError', async () => {
  const { a } = createPair({
    localB: {
      boom() {
        throw new Error('boom message');
      }
    }
  });

  await assert.rejects(a.remote.boom(), (err) => {
    assert.equal(err.name, 'RemoteError');
    assert.equal(err.message, 'boom message');
    assert.match(err.stack, /boom message/);
    return true;
  });
});

test('errors: rejected promise returned from local function is forwarded (fix for hanging clients)', async () => {
  const { a } = createPair({
    localB: {
      async asyncBoom() {
        throw new Error('async boom');
      }
    }
  });

  await assert.rejects(a.remote.asyncBoom(), (err) => {
    assert.equal(err.name, 'RemoteError');
    assert.equal(err.message, 'async boom');
    return true;
  });
});

test('errors: rejected promise with non-Error reason is forwarded as-is', async () => {
  const { a } = createPair({
    localB: {
      async asyncBoomString() {
        return Promise.reject('someStringError');
      }
    }
  });

  await assert.rejects(a.remote.asyncBoomString(), (err) => {
    assert.equal(err, 'someStringError');
    return true;
  });
});

test('errors: thrown non-Error value is forwarded as-is', async () => {
  const { a } = createPair({
    localB: {
      throwString() {
        throw 'plainString';
      }
    }
  });

  await assert.rejects(a.remote.throwString(), (err) => {
    assert.equal(err, 'plainString');
    return true;
  });
});

test('errors: error inside a passed callback propagates back to caller', async () => {
  const { a } = createPair({
    localB: {
      async functionWithErrorInCb(cb) {
        await cb();
      }
    }
  });

  await assert.rejects(
    a.remote.functionWithErrorInCb(() => {
      throw new Error('callback error');
    }),
    (err) => {
      assert.equal(err.name, 'RemoteError');
      assert.equal(err.message, 'callback error');
      return true;
    }
  );
});

test('errors: error inside a passed callback that returns rejected promise propagates back', async () => {
  const { a } = createPair({
    localB: {
      async functionWithAsyncErrorInCb(cb) {
        await cb();
      }
    }
  });

  await assert.rejects(
    a.remote.functionWithAsyncErrorInCb(async () => {
      throw new Error('async callback error');
    }),
    (err) => {
      assert.equal(err.name, 'RemoteError');
      assert.equal(err.message, 'async callback error');
      return true;
    }
  );
});

test('errors: exposeErrors=false re-throws locally instead of forwarding to caller', async () => {
  const { pair } = await import('../index.esm.js');

  const sentToA = [];
  let routeInput;
  pair({
    send: msg => sentToA.push(msg),
    on: handler => { routeInput = handler; },
    local: {
      boom() {
        throw new Error('sensitive details');
      }
    },
    options: { exposeErrors: false }
  });

  // simulate side A sending a 'boom' call to side B
  const incomingMessage = { apiFunc: 'boom', cbId: 1, args: [], argsTransform: [] };

  assert.throws(() => routeInput(incomingMessage), /sensitive details/);

  // nothing was sent back to A: error was not forwarded
  assert.deepEqual(sentToA, []);
});

test('errors: calling an unregistered remote function rejects with descriptive error', async () => {
  const { a } = createPair({
    localB: {}
  });

  await assert.rejects(a.remote.doesNotExist(), (err) => {
    assert.equal(err.name, 'RemoteError');
    assert.match(err.message, /not registered/);
    return true;
  });
});
