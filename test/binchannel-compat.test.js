// Сумісність binChannel між версіями: поточна (src) ↔ опубліковані 9.2.4 і 9.3.0 (test/fixtures).
// Регресія 9.3.0: відправник за замовчуванням різав великий скелет на type 2, який приймач 9.2.x
// мовчки губив → виклик висів до callTimeout. З 9.3.1 type 2 лише за chunkSkeleton: true | 'auto'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as cur from '../index.esm.js';
import * as v924 from './fixtures/iorpc-9.2.4.esm.js';
import * as v930 from './fixtures/iorpc-9.3.0.esm.js';
import { createBinLink } from './helpers/binlink.js';

const asBuf = v => Buffer.from(v && v.__binChunks ? Buffer.concat(v.__binChunks) : v);
const typeOf = u8 => u8[0];

// Знімок стану ~size байт JSON, без бінарів (як hello() в invmon).
function snapshot(size) {
  const rows = [];
  let len = 0, i = 0;
  while (len < size) {
    const r = { id: i, name: 'reg' + i, value: i * 1.25, unit: 'W', ok: i % 3 !== 0 };
    rows.push(r); len += JSON.stringify(r).length + 1; i++;
  }
  return { ts: 1, rows };
}

/**
 * Дві сторони різних версій над спільним лінком. Лінк НЕ кидає на oversize (як node-datachannel
 * у звіті: maxMessageSize=65536, але 137 КБ type 0 доходив) — щоб відтворити саме несумісність.
 * Записує типи всіх повідомлень у кожному напрямку.
 */
function mixed({ libA, libB, optsA = {}, optsB = {}, localA = {}, localB = {}, max = 65536, callTimeout = 3000 }) {
  const link = createBinLink({ maxMessageSize: max });
  const typesA = [], typesB = [], errA = [], errB = [];
  const tap = (t, types) => ({ ...t, sendBin(u8) { types.push(typeOf(u8 instanceof ArrayBuffer ? new Uint8Array(u8) : u8)); t.sendBin(u8); } });
  const cA = libA.binChannel(tap(link.tA, typesA), { onError: e => errA.push(e), ...optsA });
  const cB = libB.binChannel(tap(link.tB, typesB), { onError: e => errB.push(e), ...optsB });
  const a = libA.pair({ send: cA.send, on: cA.on, local: localA, options: { callTimeout } });
  const b = libB.pair({ send: cB.send, on: cB.on, local: localB, options: { callTimeout } });
  return { a, b, cA, cB, link, typesA, typesB, errA, errB };
}

const big = snapshot(137 * 1024);

// ── сценарій зі звіту: сервер (новий) повертає 137 КБ браузеру (9.2.4) ──
test('compat: поточний (дефолт) → 9.2.4: великий скелет доходить (сценарій invmon hello())', async () => {
  const m = mixed({ libA: v924, libB: cur, localB: { hello() { return big; } } });
  assert.deepEqual(await m.a.remote.hello(), big);
  assert.ok(!m.typesB.includes(2) && !m.typesB.includes(3), 'новий бік не має слати type 2/3 за замовчуванням: ' + m.typesB);
  assert.deepEqual(m.errA, []);
  assert.deepEqual(m.errB, []);
});

test('compat: 9.2.4 → поточний: великий скелет і бінари в обидва боки', async () => {
  const bin = crypto.randomBytes(300 * 1024);
  const m = mixed({ libA: v924, libB: cur, localB: { echo(o, b) { return { o, b }; } } });
  const r = await m.a.remote.echo(big, bin);
  assert.deepEqual(r.o, big);
  assert.ok(asBuf(r.b).equals(bin));
  assert.deepEqual(m.errA, []);
  assert.deepEqual(m.errB, []);
});

test('compat: поточний як викликач → 9.2.4 сервер: великі аргументи і результат', async () => {
  const m = mixed({ libA: cur, libB: v924, localB: { echo(o) { return o; } } });
  assert.deepEqual(await m.a.remote.echo(big), big);
  assert.ok(m.typesA.every(t => t === 0 || t === 1));
  assert.deepEqual(m.errA, []);
  assert.deepEqual(m.errB, []);
});

test("compat: 'auto' ↔ 9.2.4: peer без hello → type 2 не шлеться; hello 9.2.4 ігнорує мовчки", async () => {
  for (const side of ['A', 'B']) {
    const auto = { chunkSkeleton: 'auto' };
    const m = side === 'A'
      ? mixed({ libA: cur, libB: v924, optsA: auto, localB: { echo(o) { return o; } }, localA: { echo(o) { return o; } } })
      : mixed({ libA: v924, libB: cur, optsB: auto, localB: { echo(o) { return o; } }, localA: { echo(o) { return o; } } });
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await m.a.remote.echo(big), big);
      assert.deepEqual(await m.b.remote.echo(big), big);
    }
    const curTypes = side === 'A' ? m.typesA : m.typesB;
    assert.ok(!curTypes.includes(2), side + ': ' + curTypes);
    assert.equal(curTypes.filter(t => t === 3).length, 1, 'hello рівно один раз');
    assert.deepEqual(m.errA, []);
    assert.deepEqual(m.errB, []);
  }
});

test("compat: 'auto' ↔ 'auto': після обміну hello великі скелети чанкуються, жодне повідомлення > max", async () => {
  const max = 65536;
  const m = mixed({
    libA: cur, libB: cur, max,
    optsA: { chunkSkeleton: 'auto' }, optsB: { chunkSkeleton: 'auto' },
    localA: { echo(o) { return o; } }, localB: { echo(o) { return o; }, ping() { return 1; } }
  });
  // Перший виклик A ще не знає можливостей B → малий запит; відповідь B уже чанкується,
  // бо hello A прийшов перед запитом.
  assert.equal(await m.a.remote.ping(), 1);
  const sizesBefore = [...m.link.sentA, ...m.link.sentB].length;
  assert.deepEqual(await m.a.remote.echo(big), big);
  assert.deepEqual(await m.b.remote.echo(big), big);
  const sizes = [...m.link.sentA, ...m.link.sentB].slice(sizesBefore);
  for (const n of sizes) assert.ok(n <= max, 'msg ' + n + ' > ' + max);
  assert.ok(m.typesA.includes(2) && m.typesB.includes(2));
  assert.equal(m.typesA.filter(t => t === 3).length, 1);
  assert.equal(m.typesB.filter(t => t === 3).length, 1);
  assert.equal(m.typesA[0], 3, 'hello йде першим');
  assert.deepEqual(m.errA, []);
  assert.deepEqual(m.errB, []);
});

test("compat: 'auto' — reset() скидає знання про peer і повторює hello", async () => {
  const out = [];
  let h = null;
  const ch = cur.binChannel({ sendBin: u8 => out.push(Uint8Array.from(u8)), onBin: fn => { h = fn; } }, { chunkSkeleton: 'auto', chunkSize: 100 });
  ch.on(() => {});
  const hello = Uint8Array.of(3, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0);
  h(hello);
  ch.send({ s: 'x'.repeat(500) });
  assert.deepEqual(out.map(typeOf), [3, 2, 2, 2, 2, 2, 2]);
  ch.reset();
  out.length = 0;
  ch.send({ s: 'x'.repeat(500) });
  assert.deepEqual(out.map(typeOf), [3, 0], 'після reset peer невідомий → type 0');
  h(hello);
  out.length = 0;
  ch.send({ s: 'x'.repeat(500) });
  assert.ok(out.every(m => m[0] === 2));
  // hello з caps=0 (peer без підтримки) знову вимикає чанкування
  h(Uint8Array.of(3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  out.length = 0;
  ch.send({ s: 'x'.repeat(500) });
  assert.deepEqual(out.map(typeOf), [0]);
});

test('compat: 9.3.0 ↔ поточний (дефолт): 9.3.0 шле type 2 — приймається; відповідь type 0 9.3.0 приймає', async () => {
  const bin = crypto.randomBytes(200 * 1024);
  const m = mixed({ libA: v930, libB: cur, localB: { echo(o, b) { return { o, b }; } }, localA: { echo(o) { return o; } } });
  const r = await m.a.remote.echo(big, bin);
  assert.deepEqual(r.o, big);
  assert.ok(asBuf(r.b).equals(bin));
  assert.deepEqual(await m.b.remote.echo(big), big);
  assert.ok(m.typesA.includes(2), '9.3.0 чанкує скелет');
  assert.ok(!m.typesB.includes(2) && !m.typesB.includes(3));
  assert.deepEqual(m.errA, []);
  assert.deepEqual(m.errB, []);
});

test('compat: chunkSkeleton: true ↔ 9.3.0 — працює, wire як у 9.3.0 (без hello)', async () => {
  const m = mixed({ libA: v930, libB: cur, optsB: { chunkSkeleton: true }, localB: { echo(o) { return o; } }, localA: { echo(o) { return o; } } });
  assert.deepEqual(await m.a.remote.echo(big), big);
  assert.deepEqual(await m.b.remote.echo(big), big);
  assert.ok(m.typesB.includes(2) && !m.typesB.includes(3));
  assert.deepEqual(m.errA, []);
  assert.deepEqual(m.errB, []);
});

test("compat: 'auto' ↔ 9.3.0 — працює; 9.3.0 повідомляє про невідомий type 3 в onError (один раз)", async () => {
  const m = mixed({ libA: v930, libB: cur, optsB: { chunkSkeleton: 'auto' }, localB: { echo(o) { return o; } }, localA: { echo(o) { return o; } } });
  assert.deepEqual(await m.a.remote.echo(big), big);
  assert.deepEqual(await m.b.remote.echo(big), big);
  assert.ok(!m.typesB.includes(2));
  assert.equal(m.errA.length, 1);
  assert.match(m.errA[0].message, /unknown message type 3/);
  assert.deepEqual(m.errB, []);
});

test('compat: chunkSkeleton: true → 9.2.4 відтворює регресію (тому за замовчуванням вимкнено)', async () => {
  const m = mixed({ libA: v924, libB: cur, optsB: { chunkSkeleton: true }, localB: { hello() { return big; } }, callTimeout: 150 });
  await assert.rejects(m.a.remote.hello(), e => e.code === 'IORPC_TIMEOUT');
});

test('compat: дефолтний відправник побайтово збігається з 9.2.4 (великий скелет, бінари, maxMessageSize)', () => {
  const record = lib => {
    const out = [];
    const ch = lib.binChannel({ maxMessageSize: 65536, sendBin: u8 => out.push(Uint8Array.from(u8)), onBin() {} });
    ch.send({ apiFunc: 'hello', cbId: 1, args: [] });
    ch.send({ apiFunc: 'x', cbId: false, args: [big] });
    ch.send({ apiFunc: 'y', cbId: 2, args: [{ a: Buffer.alloc(150000, 3), b: [new Uint8Array(10)] }, big] });
    return out;
  };
  const a = record(cur), b = record(v924);
  assert.equal(a.length, b.length);
  a.forEach((m, i) => assert.deepEqual(m, b[i], 'message #' + i));
});

test('compat: обрізані повідомлення → onError з кодом, без винятків назовні', () => {
  const errors = [];
  let h = null;
  cur.binChannel({ sendBin() {}, onBin: fn => { h = fn; } }, { onError: e => errors.push(e) }).on(() => {});
  h(new Uint8Array(0));
  h(Uint8Array.of(0, 0, 0));
  h(Uint8Array.of(2, 0, 0, 0, 9, 0, 0));
  h(Uint8Array.of(3, 0));
  assert.equal(errors.length, 4);
  assert.ok(errors.every(e => e.code === 'IORPC_BIN_MALFORMED'), errors.map(e => e.message).join('\n'));
  assert.match(errors[2].message, /msgId=9/);
  assert.equal(errors[2].msgId, 9);
});

test('compat: невалідне значення chunkSkeleton → TypeError', () => {
  for (const v of ['yes', 1, null]) {
    assert.throws(() => cur.binChannel({ sendBin() {}, onBin() {} }, { chunkSkeleton: v }), TypeError);
  }
});
