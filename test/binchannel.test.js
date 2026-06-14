import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { binChannel } from '../index.esm.js';
import { createBinLink, tick } from './helpers/binlink.js';

const asBuf = v => Buffer.from(v && v.__binChunks ? Buffer.concat(v.__binChunks) : v);
const eq = (got, want) => asBuf(got).equals(want);

// одне відправлення A -> B, повертає отриманий packet
function send1(opts = {}) {
  const link = createBinLink(opts.link);
  const cA = binChannel(link.tA, opts.a);
  const cB = binChannel(link.tB, opts.b);
  cA.on(() => {});
  const got = new Promise(res => cB.on(res));
  return { link, cA, cB, got };
}

test('binChannel: пласкі бінари різних розмірів round-trip', async () => {
  for (const sz of [0, 1, 100, 100 * 1024, 211 * 1024, 1024 * 1024, 5 * 1024 * 1024]) {
    const want = crypto.randomBytes(sz);
    const { cA, got } = send1();
    cA.send({ apiFunc: 'echo', args: ['x', want] });
    const p = await got;
    assert.equal(p.apiFunc, 'echo');
    assert.ok(eq(p.args[1], want), `size ${sz} mismatch`);
  }
});

test('binChannel: бінар <= порогу йде ОДНИМ повідомленням (без чанк-overhead)', async () => {
  const { link, cA, got } = send1({ a: { chunkSize: 200000 } });
  cA.send({ apiFunc: 'f', args: [crypto.randomBytes(150 * 1024)] });
  await got;
  // 1 skeleton + 1 bin = 2 повідомлення
  assert.equal(link.sentA.length, 2);
});

test('binChannel: бінар > порогу чанкується і відновлюється точно', async () => {
  const want = crypto.randomBytes(5 * 1024 * 1024);
  const { link, cA, got } = send1({ a: { chunkSize: 200000 } });
  cA.send({ apiFunc: 'f', args: [want] });
  const p = await got;
  assert.ok(eq(p.args[0], want));
  // 5MB / 200000 = 27 чанків + 1 skeleton
  const expectedChunks = Math.ceil(want.length / 200000);
  assert.equal(link.sentA.length, expectedChunks + 1);
});

test('binChannel: assembleBins=false віддає view або __binChunks (zero-copy)', async () => {
  const small = crypto.randomBytes(1000);
  const big = crypto.randomBytes(500 * 1024);
  const { cA, got } = send1({ a: { chunkSize: 200000 }, b: { assembleBins: false } });
  cA.send({ apiFunc: 'f', args: [small, big] });
  const p = await got;
  // малий: одна view (Buffer), без __binChunks
  assert.ok(Buffer.isBuffer(p.args[0]));
  assert.ok(!p.args[0].__binChunks);
  // великий: масив чанків
  assert.ok(Array.isArray(p.args[1].__binChunks));
  assert.ok(p.args[1].__binChunks.length > 1);
  assert.equal(p.args[1].length, big.length);
  // gunzip-сценарій: конкатенація чанків = оригінал
  assert.ok(Buffer.concat(p.args[1].__binChunks).equals(big));
});

test('binChannel: assembleBins=true склеює у суцільний Buffer', async () => {
  const big = crypto.randomBytes(700 * 1024);
  const { cA, got } = send1({ a: { chunkSize: 200000 }, b: { assembleBins: true } });
  cA.send({ apiFunc: 'f', args: [big] });
  const p = await got;
  assert.ok(Buffer.isBuffer(p.args[0]));
  assert.ok(!p.args[0].__binChunks);
  assert.ok(p.args[0].equals(big));
});

test('binChannel: глибоко вкладені бінари (об\'єкти + масиви)', async () => {
  const a = crypto.randomBytes(300 * 1024), b = crypto.randomBytes(10), c = crypto.randomBytes(1024 * 1024);
  const { cA, got } = send1({ a: { chunkSize: 100000 } });
  cA.send({
    apiFunc: 'pub',
    args: [{ meta: { thumb: b, name: 'x' }, parts: [{ id: 0, data: a }, { id: 1, blobs: [c, b] }] }, 42]
  });
  const p = await got;
  assert.ok(eq(p.args[0].meta.thumb, b));
  assert.ok(eq(p.args[0].parts[0].data, a));
  assert.ok(eq(p.args[0].parts[1].blobs[0], c));
  assert.ok(eq(p.args[0].parts[1].blobs[1], b));
  assert.equal(p.args[1], 42);
});

test('binChannel: TypedArray та ArrayBuffer нормалізуються', async () => {
  const u16 = new Uint16Array([1, 2, 3, 65535]);
  const ab = crypto.randomBytes(50).buffer;
  const { cA, got } = send1();
  cA.send({ apiFunc: 'f', args: [u16, ab] });
  const p = await got;
  assert.ok(asBuf(p.args[0]).equals(Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength)));
  assert.ok(asBuf(p.args[1]).equals(Buffer.from(ab)));
});

test('binChannel: TypedArray з byteOffset (subarray) надсилається тільки своїм вікном', async () => {
  const full = crypto.randomBytes(1000);
  const slice = full.subarray(100, 300); // offset != 0
  const { cA, got } = send1();
  cA.send({ apiFunc: 'f', args: [slice] });
  const p = await got;
  assert.equal(asBuf(p.args[0]).length, 200);
  assert.ok(asBuf(p.args[0]).equals(full.subarray(100, 300)));
});

test('binChannel: packet без бінарів проходить чистим JSON-skeleton', async () => {
  const { link, cA, got } = send1();
  cA.send({ apiFunc: 'add', cbId: 7, args: [1, 2, 'три'], argsTransform: [] });
  const p = await got;
  assert.deepEqual(p, { apiFunc: 'add', cbId: 7, args: [1, 2, 'три'], argsTransform: [] });
  assert.equal(link.sentA.length, 1); // лише skeleton
});

test('binChannel: reentrant send() з sendBin не вклинюється посеред чанків', async () => {
  // Якщо transport.sendBin синхронно викличе send() ще раз (reentrancy),
  // повідомлення нового packet НЕ повинні переплестись із чанками поточного.
  const order = [];
  let ch;
  let reentered = false;
  ch = binChannel({
    sendBin: u8 => {
      const v = u8 instanceof ArrayBuffer ? new Uint8Array(u8)
        : new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      const type = dv.getUint8(0), id = dv.getUint32(1);
      order.push(type === 0 ? `S${id}` : `c${id}.${dv.getUint16(7)}`);
      // на другому чанку зовнішнього packet — реентрантний виклик
      if (!reentered && type === 1 && dv.getUint16(7) === 1) {
        reentered = true;
        ch.send({ apiFunc: 'INNER', args: ['x'] });
      }
    },
    onBin: () => {}
  }, { chunkSize: 200000 });
  ch.send({ apiFunc: 'OUTER', args: [crypto.randomBytes(600 * 1024)] }); // 600KB/200000 = 4 чанки

  // OUTER (S1 + усі його чанки) має вийти суцільно ДО INNER (S2)
  const s2 = order.indexOf('S2');
  const outerChunks = order.filter(x => x.startsWith('c1.'));
  const lastOuterChunk = order.lastIndexOf(outerChunks[outerChunks.length - 1]);
  assert.ok(s2 > lastOuterChunk, `INNER (S2@${s2}) вклинився до завершення OUTER: ${order.join(' ')}`);
  assert.deepEqual(order, ['S1', 'c1.0', 'c1.1', 'c1.2', 'c1.3', 'S2']);
});

test('binChannel: maxMessageSize авто-обмежує chunkSize', async () => {
  const want = crypto.randomBytes(50000);
  const { link, cA, got } = send1({ link: { maxMessageSize: 8192 }, a: { chunkSize: 200000 } });
  cA.send({ apiFunc: 'f', args: [want] });
  const p = await got;
  assert.ok(eq(p.args[0], want));
  // chunk = 8192 - 11 = 8181 -> кожне bin-повідомлення <= 8192
  for (const sz of link.sentA) assert.ok(sz <= 8192, `msg ${sz} > 8192`);
});
