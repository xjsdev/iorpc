import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pair } from '../index.esm.js';

// Golden tests: with default options the wire-format MUST stay byte-identical
// to 9.2.2. These freeze the exact packet shape so any future change that
// touches the default path will fail loudly.

function captureSender() {
  const sent = [];
  return { sent, send: msg => sent.push(JSON.parse(JSON.stringify(msg))) };
}

test('wire: default plain call packet shape is unchanged (no kind field)', () => {
  const { sent, send } = captureSender();
  const { remote } = pair({ send, on: () => {}, local: {} });

  remote.add(2, 3);

  assert.equal(sent.length, 1);
  const p = sent[0];
  assert.equal(p.apiFunc, 'add');
  assert.equal(typeof p.cbId, 'number');
  assert.deepEqual(p.args, [2, 3]);
  assert.deepEqual(p.argsTransform, []);
  // forward-compat guarantee: no `kind` on the wire by default
  assert.equal('kind' in p, false);
  // exact key set frozen
  assert.deepEqual(Object.keys(p).sort(), ['apiFunc', 'args', 'argsTransform', 'cbId']);
});

test('wire: noWait call has cbId === false and no kind', () => {
  const { sent, send } = captureSender();
  const { remote } = pair({ send, on: () => {}, local: {} });

  remote.noWait.ping('hi');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].cbId, false);
  assert.equal('kind' in sent[0], false);
  assert.deepEqual(sent[0].args, ['hi']);
});

test('wire: function argument is replaced by a numeric cbId and indexed in argsTransform', () => {
  const { sent, send } = captureSender();
  const { remote } = pair({ send, on: () => {}, local: {} });

  remote.withCb('x', () => {});

  const p = sent[0];
  assert.equal(p.args[0], 'x');
  assert.equal(typeof p.args[1], 'number'); // function -> cbId
  assert.deepEqual(p.argsTransform, [1]);
  assert.equal('kind' in p, false);
});

test('wire: allowNestedFunctions default-off keeps argsTransform as []', () => {
  const { sent, send } = captureSender();
  const { remote } = pair({ send, on: () => {}, local: {} });

  remote.plain({ a: 1 });
  assert.deepEqual(sent[0].argsTransform, []);
});
