import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pair, binChannel } from '../index.esm.js';
import { createBinLink, tick } from './helpers/binlink.js';

const asBuf = v => Buffer.from(v && v.__binChunks ? Buffer.concat(v.__binChunks) : v);
const eq = (got, want) => asBuf(got).equals(want);

// Повна пара iorpc по binChannel з обох боків.
function createBinPair({ localA = {}, localB = {}, optionsA = {}, optionsB = {}, chOpts = {}, linkOpts = {} } = {}) {
  const link = createBinLink(linkOpts);
  const cA = binChannel(link.tA, chOpts);
  const cB = binChannel(link.tB, chOpts);
  const a = pair({ send: cA.send, on: cA.on, local: localA, options: optionsA });
  const b = pair({ send: cB.send, on: cB.on, local: localB, options: optionsB });
  return { a, b, cA, cB, link };
}

test('integration: remote.echo(buf) повертає ті самі байти (через iorpc)', async () => {
  const buf = crypto.randomBytes(300 * 1024);
  const { a } = createBinPair({ localB: { echo(b) { return b; } } });
  const r = await a.remote.echo(buf);
  assert.ok(eq(r, buf));
});

test('integration: бінари + колбек + вкладене дерево', async () => {
  const fileA = crypto.randomBytes(300 * 1024), fileB = crypto.randomBytes(1024);
  const prog = [];
  const { a } = createBinPair({
    optionsA: { allowNestedFunctions: true },
    optionsB: { allowNestedFunctions: true },
    localB: {
      complex(payload, onProgress) {
        assert.ok(eq(payload.meta.thumb, fileB));
        assert.ok(eq(payload.parts[0].data, fileA));
        onProgress(50); onProgress(100);
        return 'done:' + payload.parts.length;
      }
    }
  });
  const r = await a.remote.complex(
    { meta: { thumb: fileB, name: 'x' }, parts: [{ id: 0, data: fileA }, { id: 1, data: fileB }] },
    p => prog.push(p)
  );
  assert.equal(r, 'done:2');
  assert.deepEqual(prog, [50, 100]);
});

test('concurrency: 60 паралельних викликів вперемішку (1B..2MB) не плутаються', async () => {
  const sizes = [1, 500, 200 * 1024, 300 * 1024, 2 * 1024 * 1024];
  const files = [];
  const { a } = createBinPair({
    localB: { echo(id, b) { return { id, ok: files[id].equals(asBuf(b)) }; } },
    linkOpts: { delay: 0 }
  });
  const calls = [];
  for (let i = 0; i < 60; i++) {
    files[i] = crypto.randomBytes(sizes[i % sizes.length]);
    calls.push(a.remote.echo(i, files[i]));
  }
  const res = await Promise.all(calls);
  assert.ok(res.every((r, i) => r.id === i), 'order');
  assert.ok(res.every(r => r.ok), 'bytes');
});

test('concurrency: два файли одночасно з рандомними затримками (jitter, FIFO)', async () => {
  const files = { A: crypto.randomBytes(500 * 1024), B: crypto.randomBytes(300 * 1024) };
  const { a } = createBinPair({
    localB: { upload(name, data) { return { name, ok: files[name].equals(asBuf(data)) }; } },
    linkOpts: { jitter: 5 } // рандомна затримка 0..5мс перед кожним повідомленням
  });
  const [rA, rB] = await Promise.all([
    a.remote.upload('A', files.A),
    a.remote.upload('B', files.B)
  ]);
  assert.deepEqual(rA, { name: 'A', ok: true });
  assert.deepEqual(rB, { name: 'B', ok: true });
});

test('concurrency: interleave skeleton/чанків (затримка доставки) коректний', async () => {
  const big = crypto.randomBytes(1024 * 1024), small = crypto.randomBytes(10);
  const { a } = createBinPair({
    localB: { echo(b) { return b; } },
    linkOpts: { delay: 1 }
  });
  // дрібний виклик стартує під час передачі великого
  const p1 = a.remote.echo(big);
  const p2 = a.remote.echo(small);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(eq(r1, big));
  assert.ok(eq(r2, small));
});

test('resilience: втрата bin-чанка -> packet не доставляється, інші цілі', async () => {
  const got = [];
  const link = createBinLink({
    // згубити друге b2a-повідомлення (перший bin-чанк packet#1 з боку B)
    dropFilter: (dir, i) => dir === 'a2b' && i === 1
  });
  const cA = binChannel(link.tA, { chunkSize: 100000, pendingTTL: 0 });
  const cB = binChannel(link.tB, { chunkSize: 100000, pendingTTL: 0 });
  cA.on(() => {});
  cB.on(p => got.push(p));
  // packet#1: skeleton(idx0) + bin-чанки(idx1..) -> idx1 згублено => не зібереться
  cA.send({ apiFunc: 'lost', args: [crypto.randomBytes(300 * 1024)] });
  // packet#2: повністю доходить
  cA.send({ apiFunc: 'ok', args: ['hi'] });
  await tick(20);
  assert.equal(got.length, 1);
  assert.equal(got[0].apiFunc, 'ok');
});

test('resilience: pendingTTL відкидає недозібраний packet і кличе onError', async () => {
  const errors = [];
  const link = createBinLink({ dropFilter: (dir, i) => dir === 'a2b' && i === 1 });
  const cA = binChannel(link.tA, { chunkSize: 100000, pendingTTL: 15 });
  const cB = binChannel(link.tB, { chunkSize: 100000, pendingTTL: 15, onError: e => errors.push(e) });
  cA.on(() => {});
  cB.on(() => {});
  cA.send({ apiFunc: 'lost', args: [crypto.randomBytes(300 * 1024)] });
  await tick(40);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /pending timeout/);
});

test('resilience: reset() чистить недозібрані pending', async () => {
  // губимо хвіст ПЕРШОГО packet (msgId=1): його чанки після seq 0
  const link = createBinLink({ dropFilter: (dir, i) => dir === 'a2b' && i >= 2 && i <= 11 });
  const cA = binChannel(link.tA, { chunkSize: 50000, pendingTTL: 0 });
  const cB = binChannel(link.tB, { chunkSize: 50000, pendingTTL: 0 });
  cA.on(() => {});
  const got = [];
  cB.on(p => got.push(p));
  cA.send({ apiFunc: 'half', args: [crypto.randomBytes(500 * 1024)] }); // ~10 чанків, частина згублена
  await tick(10);
  cB.reset(); // обрив під час передачі: pending#1 має зникнути
  cA.send({ apiFunc: 'next', args: ['ok'] }); // повний packet, доходить
  await tick(10);
  assert.deepEqual(got.map(p => p.apiFunc), ['next']);
});

test('resilience: обрив каналу + rejectAll відхиляє pending-проміси', async () => {
  const { a, link } = createBinPair({
    localB: { slow() { return new Promise(() => {}); } } // ніколи не відповість
  });
  const p = a.remote.slow();
  await tick(2);
  link.cut();              // канал помер
  a.rejectAll(new Error('dc closed'));
  await assert.rejects(p, /dc closed/);
});

test('contract: ordered-канал ОБОВ\'ЯЗКОВИЙ — без нього packet з чанками не збереться', async () => {
  // Документує контракт: binChannel вимагає reliable+ordered транспорт.
  // Якщо bin-чанк випереджає свій skeleton (reorder), його буде відкинуто.
  const got = [];
  let h;
  const buffered = [];
  const reorderLink = {
    sendBin: u8 => { const c = new Uint8Array(u8.byteLength); c.set(u8); buffered.push(c); },
    onBin: fn => { h = fn; }
  };
  const sender = binChannel(reorderLink, { pendingTTL: 0 });
  const cRx = binChannel(reorderLink, { pendingTTL: 0 });
  cRx.on(p => got.push(p));
  sender.send({ apiFunc: 'big', args: [crypto.randomBytes(2 * 1024 * 1024)] }); // skeleton + N чанків
  // детермінований reorder: доставляємо у ЗВОРОТНОМУ порядку (skeleton приходить ОСТАННІМ)
  for (const m of buffered.reverse()) h(m);
  await tick(10);
  // bin-чанки прийшли до skeleton -> відкинуті; packet не збирається
  assert.equal(got.length, 0);
});

test('contract: на ordered-каналі той самий великий packet доставляється', async () => {
  const got = [];
  const link = createBinLink({ delay: 1 }); // FIFO + затримка
  const cTx = binChannel(link.tA, { pendingTTL: 0 });
  const cRx = binChannel(link.tB, { pendingTTL: 0 });
  cTx.on(() => {});
  cRx.on(p => got.push(p));
  cTx.send({ apiFunc: 'big', args: [crypto.randomBytes(2 * 1024 * 1024)] });
  await tick(60);
  assert.equal(got.length, 1);
  assert.equal(got[0].apiFunc, 'big');
});

test('resilience: онова skeleton з тим самим msgId не ламає стан', async () => {
  // штучно: змусимо msgId-колізію неможливо без 2^32 викликів, тож перевіряємо
  // що drop старого pending при повторному skeleton не вибиває помилку.
  const got = [];
  const link = createBinLink();
  const cA = binChannel(link.tA, { chunkSize: 100000, pendingTTL: 0 });
  const cB = binChannel(link.tB, { chunkSize: 100000, pendingTTL: 0 });
  cA.on(() => {});
  cB.on(p => got.push(p));
  cA.send({ apiFunc: 'a', args: [crypto.randomBytes(250 * 1024)] });
  cA.send({ apiFunc: 'b', args: [crypto.randomBytes(250 * 1024)] });
  await tick(20);
  assert.deepEqual(got.map(p => p.apiFunc), ['a', 'b']);
});

// ─── Закриття каналу ──────────────────────────────────────────────────────────
// Транспорт, що вміє "закритись": після close sendBin кидає, доставка спиняється.
function createClosableLink() {
  let closed = false;
  let hA = null, hB = null;
  const mkSend = getH => u8 => {
    if (closed) throw new Error('dc closed');
    const c = new Uint8Array(u8.byteLength); c.set(u8);
    queueMicrotask(() => { if (!closed && getH()) getH()(c); });
  };
  return {
    tA: { sendBin: mkSend(() => hB), onBin: h => { hA = h; } },
    tB: { sendBin: mkSend(() => hA), onBin: h => { hB = h; } },
    close() { closed = true; },
    reopen() { closed = false; }
  };
}

test('close: send на закритому каналі кидає виняток наверх із remote-виклику', () => {
  const link = createClosableLink();
  const cA = binChannel(link.tA, { pendingTTL: 0 });
  const cB = binChannel(link.tB, { pendingTTL: 0 });
  const A = pair({ send: cA.send, on: cA.on, local: {}, options: {} });
  pair({ send: cB.send, on: cB.on, local: { echo: b => b }, options: {} });
  link.close();
  // iorpc send синхронний -> виняток транспорту піднімається до виклику remote.*
  assert.throws(() => A.remote.echo(crypto.randomBytes(10)), /dc closed/);
});

test('close: rejectAll відхиляє in-flight проміси при обриві', async () => {
  const link = createClosableLink();
  const cA = binChannel(link.tA, { pendingTTL: 0 });
  const cB = binChannel(link.tB, { pendingTTL: 0 });
  const A = pair({ send: cA.send, on: cA.on, local: {}, options: {} });
  pair({ send: cB.send, on: cB.on, local: { slow: () => new Promise(() => {}) }, options: {} });
  const p = A.remote.slow();
  await tick(2);
  link.close();
  A.rejectAll(new Error('dc closed'));
  cA.reset();
  await assert.rejects(p, /dc closed/);
});

test('close: reset() чистить недозібрані вхідні pending при обриві', async () => {
  const errs = [];
  // 400KB/50000 = 8 чанків -> повідомлення 0(skel)..8; губимо хвіст 2..8, 'next' (9+) проходить
  const link = createBinLink({ dropFilter: (dir, i) => dir === 'a2b' && i >= 2 && i <= 8 });
  const cA = binChannel(link.tA, { chunkSize: 50000, pendingTTL: 0 });
  const cB = binChannel(link.tB, { chunkSize: 50000, pendingTTL: 0, onError: e => errs.push(e) });
  cA.on(() => {});
  const got = [];
  cB.on(p => got.push(p));
  cA.send({ apiFunc: 'half', args: [crypto.randomBytes(400 * 1024)] }); // не дозбереться
  await tick(10);
  cB.reset(); // обрив: вхідні pending мають зникнути без onError
  cA.send({ apiFunc: 'next', args: ['ok'] });
  await tick(10);
  assert.deepEqual(got.map(p => p.apiFunc), ['next']);
  assert.equal(errs.length, 0); // reset не репортить як помилку
});

test('close: запізнілий iorpcThrowError після rejectAll не валить onError', async () => {
  // Після rejectAll мапа clbs порожня; пізній throwError для невідомого cbId ігнорується.
  const errs = [];
  const link = createBinLink();
  const cA = binChannel(link.tA, { pendingTTL: 0, onError: e => errs.push('A:' + e.message) });
  const cB = binChannel(link.tB, { pendingTTL: 0, onError: e => errs.push('B:' + e.message) });
  const A = pair({ send: cA.send, on: cA.on, local: {}, options: {} });
  const B = pair({ send: cB.send, on: cB.on, local: { boom: () => { throw new Error('x'); } }, options: {} });
  const p = A.remote.boom().catch(() => {}); // викличе iorpcThrowError у відповідь
  A.rejectAll(new Error('closed'));           // але ми вже все відхилили
  await tick(10);
  await p;
  assert.deepEqual(errs, []); // жодного "Cannot read properties of undefined"
});

test('close: повне відновлення — після reset+reopen канал працює чисто', async () => {
  const link = createClosableLink();
  const cA = binChannel(link.tA, { pendingTTL: 0 });
  const cB = binChannel(link.tB, { pendingTTL: 0 });
  const A = pair({ send: cA.send, on: cA.on, local: {}, options: {} });
  const B = pair({ send: cB.send, on: cB.on, local: { echo: b => b }, options: {} });
  // обрив під час польоту
  const hanging = A.remote.echo(crypto.randomBytes(10)).catch(e => e.message);
  link.close();
  A.rejectAll(new Error('dc closed')); cA.reset();
  B.rejectAll(new Error('dc closed')); cB.reset();
  assert.equal(await hanging, 'dc closed');
  // відновлення
  link.reopen();
  const want = crypto.randomBytes(300 * 1024);
  const r = await A.remote.echo(want);
  assert.ok(eq(r, want));
});
