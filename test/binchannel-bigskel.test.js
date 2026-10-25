import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pair, binChannel } from '../index.esm.js';
import { createBinLink, tick } from './helpers/binlink.js';

const asBuf = v => Buffer.from(v && v.__binChunks ? Buffer.concat(v.__binChunks) : v);
const enc = new TextEncoder();

// Транспорт-рекордер: складає вихідні повідомлення (копії) у масив, кидає на oversize.
function recorder(maxMessageSize) {
  const out = [];
  return {
    out,
    t: {
      maxMessageSize,
      sendBin(u8) {
        if (maxMessageSize && u8.byteLength > maxMessageSize) throw new Error('Message size exceeds limit');
        out.push(Uint8Array.from(u8));
      },
      onBin() {}
    }
  };
}
// Приймач із ручною подачею повідомлень.
function receiver(opts) {
  let h = null;
  const got = [], errors = [];
  const ch = binChannel({ sendBin() {}, onBin: fn => { h = fn; } }, { onError: e => errors.push(e), ...opts });
  ch.on(p => got.push(p));
  return { ch, got, errors, feed: m => h(m) };
}
// Старий формат type 0 (golden): [0][msgId:u32][binsCount:u16] + JSON
function oldType0(id, binsCount, skeletonObj) {
  const s = enc.encode(JSON.stringify(skeletonObj));
  const m = new Uint8Array(7 + s.length), dv = new DataView(m.buffer);
  dv.setUint8(0, 0); dv.setUint32(1, id); dv.setUint16(5, binsCount); m.set(s, 7);
  return m;
}
// Великий звичайний обʼєкт (≈ size байт JSON), без бінарів.
function bigObject(size) {
  const symbols = [];
  let len = 0, i = 0;
  while (len < size) {
    const s = { symbol: 'SYM' + i + 'USDT', status: 'TRADING', filters: [{ t: 'PRICE', min: '0.0001', max: String(i * 1.5) }], i };
    symbols.push(s); len += JSON.stringify(s).length + 1; i++;
  }
  return { timezone: 'UTC', serverTime: 1, symbols };
}
// Строгий транспорт поверх createBinLink: кидає, якщо повідомлення > maxMessageSize.
function strictPair({ max = 262144, chOpts = {}, localB = {}, optionsA = {}, optionsB = {} } = {}) {
  const link = createBinLink({ maxMessageSize: max });
  const strict = t => ({ ...t, sendBin(u8) { if (u8.byteLength > max) throw new Error('Message size exceeds limit'); t.sendBin(u8); } });
  const o = { chunkSkeleton: true, ...chOpts };
  const cA = binChannel(strict(link.tA), o), cB = binChannel(strict(link.tB), o);
  const a = pair({ send: cA.send, on: cA.on, options: optionsA });
  const b = pair({ send: cB.send, on: cB.on, local: localB, options: optionsB });
  return { a, b, cA, cB, link, max };
}

// Тести формату type 2 явно вмикають chunkSkeleton: true (з 9.3.1 за замовчуванням вимкнено).
test('bigskel: скелет, що вміщується, іде type 0 побайтово як старий формат', () => {
  const { out, t } = recorder(262144);
  const ch = binChannel(t);
  const pkt = { apiFunc: 'x', cbId: 5, args: [1, 'ab', { q: [true, null] }] };
  ch.send(pkt);
  const bin = Buffer.from([1, 2, 3]);
  ch.send({ apiFunc: 'y', cbId: 6, args: [bin] });
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], oldType0(1, 0, pkt));
  assert.deepEqual(out[1], oldType0(2, 1, { apiFunc: 'y', cbId: 6, args: [{ __bin: 0 }] }));
  assert.equal(out[2][0], 1);
});

test('bigskel: межа chunk+HEAD — рівно вміщується → type 0, +1 байт → type 2', () => {
  const chunkSize = 100, HEAD = 11;
  const mk = n => ({ s: 'x'.repeat(n) }); // JSON = {"s":"..."} = n + 8 байт
  const fit = chunkSize + HEAD - 7 - 8;
  for (const [n, type] of [[fit, 0], [fit + 1, 2]]) {
    const { out, t } = recorder();
    binChannel(t, { chunkSize, chunkSkeleton: true }).send(mk(n));
    assert.equal(out[0][0], type, 'n=' + n);
    for (const m of out) assert.ok(m.byteLength <= chunkSize + HEAD);
    if (type === 0) assert.deepEqual(out[0], oldType0(1, 0, mk(n)));
    else assert.equal(out.length, 2);
  }
});

test('bigskel: формат type 2 — заголовок [2][msgId][binsCount][seq][total]', () => {
  const { out, t } = recorder();
  const obj = { s: 'y'.repeat(250), b: Buffer.from([9]) };
  binChannel(t, { chunkSize: 100, chunkSkeleton: true }).send(obj);
  const json = enc.encode(JSON.stringify({ s: 'y'.repeat(250), b: { __bin: 0 } }));
  const total = Math.ceil(json.length / 100);
  assert.equal(out.length, total + 1);
  const parts = [];
  for (let i = 0; i < total; i++) {
    const dv = new DataView(out[i].buffer);
    assert.deepEqual([dv.getUint8(0), dv.getUint32(1), dv.getUint16(5), dv.getUint16(7), dv.getUint16(9)], [2, 1, 1, i, total]);
    parts.push(...out[i].subarray(11));
  }
  assert.deepEqual(Uint8Array.from(parts), json);
  assert.equal(out[total][0], 1);
});

for (const mb of [1, 3]) {
  test(`bigskel: обʼєкт ${mb} МБ через pair, maxMessageSize 256 KB`, async () => {
    const big = bigObject(mb * 1024 * 1024);
    const { a, link, max } = strictPair({ localB: { exchangeInfo() { return big; }, echo(x) { return x; } } });
    assert.deepEqual(await a.remote.exchangeInfo(), big);
    assert.deepEqual(await a.remote.echo(big), big); // великий скелет в обидва боки
    assert.ok(link.sentA.length > 1 && link.sentB.length > 1);
    for (const n of [...link.sentA, ...link.sentB]) assert.ok(n <= max, 'msg ' + n + ' > ' + max);
  });
}

test('bigskel: багатобайтовий UTF-8 на межах шматків', async () => {
  const s = 'é€😀ї'.repeat(5000) + 'x';
  for (const chunkSize of [7, 13, 100, 1001]) {
    const { a } = strictPair({ max: chunkSize + 11, chOpts: { chunkSize }, localB: { echo(x) { return x; } } });
    assert.equal(await a.remote.echo({ s }).then(r => r.s), s, 'chunkSize=' + chunkSize);
  }
});

test('bigskel: великий скелет + великі бінари разом (zero-copy і assembleBins)', async () => {
  for (const assembleBins of [false, true]) {
    const big = bigObject(800 * 1024);
    const f1 = crypto.randomBytes(700 * 1024), f2 = crypto.randomBytes(10);
    const { a } = strictPair({
      chOpts: { assembleBins },
      localB: {
        check(o) {
          if (assembleBins) assert.ok(Buffer.isBuffer(o.files[0]));
          else assert.ok(Array.isArray(o.files[0].__binChunks));
          return { ok: asBuf(o.files[0]).equals(f1) && asBuf(o.files[1]).equals(f2), n: o.meta.symbols.length, back: o.files[0] };
        }
      }
    });
    const r = await a.remote.check({ meta: big, files: [f1, f2] });
    assert.equal(r.ok, true);
    assert.equal(r.n, big.symbols.length);
    assert.ok(asBuf(r.back).equals(f1));
  }
});

test('bigskel: кілька великих пакетів підряд і вперемішку з малими — порядок і цілісність', async () => {
  const objs = [300, 5, 1200, 1, 600, 2, 2000].map(kb => bigObject(kb * 1024));
  const order = [];
  const { a } = strictPair({ localB: { take(i, o) { order.push(i); return o.symbols.length; } } });
  const res = await Promise.all(objs.map((o, i) => a.remote.take(i, o)));
  assert.deepEqual(res, objs.map(o => o.symbols.length));
  assert.deepEqual(order, objs.map((_, i) => i)); // ordered канал → виклики в порядку відправки
});

test('bigskel: реентрантний send із sendBin не вклинюється між шматками скелета', () => {
  const out = [];
  let ch, fired = false;
  ch = binChannel({
    sendBin(u8) {
      out.push(Uint8Array.from(u8));
      if (!fired) { fired = true; ch.send({ small: 1 }); }
    },
    onBin() {}
  }, { chunkSize: 50, chunkSkeleton: true });
  ch.send({ s: 'z'.repeat(500), b: Buffer.alloc(120, 7) });
  const ids = out.map(m => new DataView(m.buffer).getUint32(1));
  const firstOf2 = ids.indexOf(2);
  assert.ok(firstOf2 > 0);
  assert.ok(ids.slice(0, firstOf2).every(i => i === 1));
  assert.ok(ids.slice(firstOf2).every(i => i === 2));
  // приймач збирає обидва
  const r = receiver({ chunkSize: 50 });
  for (const m of out) r.feed(m);
  assert.equal(r.got.length, 2);
  assert.equal(r.got[0].s.length, 500);
  assert.ok(asBuf(r.got[0].b).equals(Buffer.alloc(120, 7)));
  assert.deepEqual(r.got[1], { small: 1 });
  assert.deepEqual(r.errors, []);
});

test('bigskel: втрачений шматок скелета → pendingTTL → onError, канал живий далі', async () => {
  const { out, t } = recorder();
  const tx = binChannel(t, { chunkSize: 100, chunkSkeleton: true });
  tx.send({ s: 'q'.repeat(1000) });
  tx.send({ s: 'ok'.repeat(300) });
  const r = receiver({ chunkSize: 100, pendingTTL: 30 });
  const firstId = m => new DataView(m.buffer).getUint32(1);
  out.forEach((m, i) => { if (!(firstId(m) === 1 && i === 3)) r.feed(m); }); // губимо 4-й шматок packet 1
  assert.equal(r.got.length, 1);
  assert.equal(r.got[0].s, 'ok'.repeat(300));
  await tick(60);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /pending timeout msgId=1/);
});

test('bigskel: reset() посеред збирання скелета чистить стан', () => {
  const { out, t } = recorder();
  binChannel(t, { chunkSize: 100, chunkSkeleton: true }).send({ s: 'w'.repeat(1000), b: Buffer.from([1]) });
  const r = receiver({ chunkSize: 100, pendingTTL: 0 });
  const half = Math.floor(out.length / 2);
  out.slice(0, half).forEach(r.feed);
  r.ch.reset();
  out.slice(half).forEach(r.feed); // хвіст без початку → новий запис, але неповний
  assert.equal(r.got.length, 0);
  r.ch.reset();
  out.forEach(r.feed); // повна повторна подача після reset збирається
  assert.equal(r.got.length, 1);
  assert.equal(r.got[0].s.length, 1000);
  assert.deepEqual(r.errors, []);
});

test('bigskel: reset() на відправнику чистить недовідправлені шматки скелета', () => {
  let n = 0, ch;
  ch = binChannel({ sendBin() { if (++n === 3) throw new Error('closed'); }, onBin() {} }, { chunkSize: 100, chunkSkeleton: true });
  assert.throws(() => ch.send({ s: 'e'.repeat(1000) }), /closed/);
  ch.reset();
  const { out, t } = recorder();
  const ch2 = binChannel(t, { chunkSize: 100 });
  ch2.send({ a: 1 });
  assert.equal(out.length, 1);
});

test('bigskel: мок-транспорт, що кидає на oversize, — жодне повідомлення не перевищує ліміт', () => {
  for (const max of [64, 1000, 262144]) {
    const { out, t } = recorder(max);
    const ch = binChannel(t, { chunkSize: 200000, chunkSkeleton: true });
    ch.send({ big: bigObject(max * 5), bin: crypto.randomBytes(max * 3) });
    for (const m of out) assert.ok(m.byteLength <= max);
    const r = receiver({ pendingTTL: 0 });
    out.forEach(r.feed);
    assert.equal(r.got.length, 1);
    assert.deepEqual(r.errors, []);
  }
});

test('bigskel: ліміти u16 — зрозуміла помилка і нічого не відправлено', () => {
  const cases = [
    [{ chunkSize: 1, chunkSkeleton: true }, { s: 'x'.repeat(70000) }, /skeleton too large/],
    [{ chunkSize: 1 }, { b: new Uint8Array(70000) }, /binary #0 too large/],
    [{}, { list: Array.from({ length: 65536 }, () => new Uint8Array(1)) }, /too many binary values/]
  ];
  for (const [opts, pkt, re] of cases) {
    const { out, t } = recorder();
    const ch = binChannel(t, opts);
    assert.throws(() => ch.send(pkt), re);
    assert.equal(out.length, 0);
    ch.send({ ok: 1 }); // канал придатний далі
    const r = receiver({ pendingTTL: 0 });
    out.forEach(r.feed);
    assert.deepEqual(r.got, [{ ok: 1 }]);
  }
  // рівно 65535 бінарів — допустимо
  const { out, t } = recorder();
  binChannel(t).send({ list: Array.from({ length: 65535 }, () => new Uint8Array(1)) });
  assert.equal(new DataView(out[0].buffer).getUint16(5), 65535);
});

test('bigskel: биті шматки скелета → onError, без підвисань', () => {
  const r = receiver({ pendingTTL: 0 });
  const mk = (seq, total, count, body = '{') => {
    const b = enc.encode(body), m = new Uint8Array(11 + b.length), dv = new DataView(m.buffer);
    dv.setUint8(0, 2); dv.setUint32(1, 7); dv.setUint16(5, count); dv.setUint16(7, seq); dv.setUint16(9, total); m.set(b, 11);
    return m;
  };
  r.feed(mk(5, 2, 0));                       // seq >= total
  r.feed(mk(0, 2, 0)); r.feed(mk(1, 3, 0));  // total не збігся
  r.feed(mk(0, 2, 0)); r.feed(mk(1, 2, 0, '{')); // невалідний JSON ("{{")
  r.feed(Uint8Array.of(9, 0, 0, 0, 1));      // невідомий тип
  assert.equal(r.got.length, 0);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors[0].message, /bad skeleton chunk/);
  assert.match(r.errors[1].message, /header mismatch/);
  assert.ok(r.errors[2] instanceof SyntaxError);
  assert.equal(r.errors[2].code, 'IORPC_BIN_DECODE');
  assert.equal(r.errors[2].msgId, 7);
  assert.ok(r.errors[2].cause instanceof SyntaxError);
  assert.match(r.errors[3].message, /unknown message type 9 msgId=1/);
  assert.equal(r.errors[3].code, 'IORPC_BIN_UNKNOWN_TYPE');
  r.feed(mk(0, 2, 0, '{"a"')); r.feed(mk(1, 2, 0, ':1}')); // після помилок той самий msgId збирається
  assert.deepEqual(r.got, [{ a: 1 }]);
});
