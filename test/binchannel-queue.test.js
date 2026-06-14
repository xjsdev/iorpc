import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { binChannel } from '../index.esm.js';

// Транспорт-шпигун, що логує тип/msgId кожного повідомлення і вміє кидати/обривати.
function spyTransport({ throwOn } = {}) {
  const log = [];
  let calls = 0;
  let cut = false;
  const t = {
    sendBin: u8 => {
      const v = u8 instanceof ArrayBuffer ? new Uint8Array(u8)
        : new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      const tag = dv.getUint8(0) === 0 ? `S${dv.getUint32(1)}` : `c${dv.getUint32(1)}.${dv.getUint16(7)}`;
      const i = calls++;
      if (cut) return;                        // "обрив": мовчки ковтаємо
      if (throwOn != null && i === throwOn) throw new Error('transport boom @' + i);
      log.push(tag);
    },
    onBin: () => {}
  };
  return { t, log, setCut: v => { cut = v; }, sentCount: () => calls };
}

test('queue: один packet виходить суцільним упорядкованим блоком', () => {
  const sp = spyTransport();
  const ch = binChannel(sp.t, { chunkSize: 200000 });
  ch.send({ apiFunc: 'f', args: [crypto.randomBytes(500 * 1024)] }); // S + 3 чанки
  assert.deepEqual(sp.log, ['S1', 'c1.0', 'c1.1', 'c1.2']);
});

test('queue: послідовні send зберігають FIFO між packet-ами', () => {
  const sp = spyTransport();
  const ch = binChannel(sp.t, { chunkSize: 200000 });
  ch.send({ apiFunc: 'a', args: ['x'] });                          // S1
  ch.send({ apiFunc: 'b', args: [crypto.randomBytes(300 * 1024)] }); // S2 + 2 чанки
  ch.send({ apiFunc: 'c', args: ['y'] });                          // S3
  assert.deepEqual(sp.log, ['S1', 'S2', 'c2.0', 'c2.1', 'S3']);
});

test('queue: reentrant send із sendBin дописується в хвіст, не вклинюється', () => {
  const log = [];
  let ch, done = false;
  ch = binChannel({
    sendBin: u8 => {
      const v = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      log.push(dv.getUint8(0) === 0 ? `S${dv.getUint32(1)}` : `c${dv.getUint32(1)}.${dv.getUint16(7)}`);
      if (!done && dv.getUint8(0) === 1 && dv.getUint16(7) === 1) { done = true; ch.send({ apiFunc: 'inner', args: ['z'] }); }
    },
    onBin: () => {}
  }, { chunkSize: 200000 });
  ch.send({ apiFunc: 'outer', args: [crypto.randomBytes(600 * 1024)] }); // S1 + 4 чанки
  assert.deepEqual(log, ['S1', 'c1.0', 'c1.1', 'c1.2', 'c1.3', 'S2']);
});

test('queue: подвійна reentrancy (два вкладені send) — обидва в хвіст по порядку', () => {
  const log = [];
  let ch, fired = 0;
  ch = binChannel({
    sendBin: u8 => {
      const v = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      log.push(dv.getUint8(0) === 0 ? `S${dv.getUint32(1)}` : `c${dv.getUint32(1)}.${dv.getUint16(7)}`);
      // на перших двох чанках зовнішнього packet породжуємо два вкладені send
      if (dv.getUint8(0) === 1 && dv.getUint32(1) === 1 && dv.getUint16(7) < 2 && fired < 2) {
        fired++;
        ch.send({ apiFunc: 'inner' + fired, args: ['z'] });
      }
    },
    onBin: () => {}
  }, { chunkSize: 200000 });
  ch.send({ apiFunc: 'outer', args: [crypto.randomBytes(500 * 1024)] }); // S1 + 3 чанки
  // обидва inner (S2, S3) — після повного S1-блоку, у порядку постановки
  assert.deepEqual(log, ['S1', 'c1.0', 'c1.1', 'c1.2', 'S2', 'S3']);
});

test('queue: виняток у sendBin летить НАВЕРХ до викликача send', () => {
  const sp = spyTransport({ throwOn: 2 }); // впаде на 3-му повідомленні (c1.1)
  const ch = binChannel(sp.t, { chunkSize: 200000 });
  assert.throws(
    () => ch.send({ apiFunc: 'f', args: [crypto.randomBytes(500 * 1024)] }),
    /transport boom @2/
  );
});

test('queue: після винятку повідомлення НЕ губиться (без дірки) і дослідне доходить', () => {
  let boom = true;
  const log = [];
  const t = {
    sendBin: u8 => {
      const v = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      const tag = dv.getUint8(0) === 0 ? `S${dv.getUint32(1)}` : `c${dv.getUint32(1)}.${dv.getUint16(7)}`;
      if (boom && tag === 'c1.1') throw new Error('boom');
      log.push(tag);
    },
    onBin: () => {}
  };
  const ch = binChannel(t, { chunkSize: 200000 });
  assert.throws(() => ch.send({ apiFunc: 'f', args: [crypto.randomBytes(500 * 1024)] }), /boom/);
  // встигло вийти S1, c1.0 — далі впало на c1.1
  assert.deepEqual(log, ['S1', 'c1.0']);
  // транспорт "відновився": повторний flush через новий send дошле з ГОЛОВИ (c1.1) без дірки
  boom = false;
  ch.send({ apiFunc: 'g', args: ['x'] });
  assert.deepEqual(log, ['S1', 'c1.0', 'c1.1', 'c1.2', 'S2']);
});

test('queue: sending скидається після винятку (черга не залипає)', () => {
  let boom = true;
  const log = [];
  const t = {
    sendBin: u8 => {
      const v = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      if (boom) throw new Error('boom');
      log.push(dv.getUint8(0) === 0 ? `S${dv.getUint32(1)}` : `c${dv.getUint32(1)}.${dv.getUint16(7)}`);
    },
    onBin: () => {}
  };
  const ch = binChannel(t, { chunkSize: 200000 });
  assert.throws(() => ch.send({ apiFunc: 'f', args: ['x'] }), /boom/); // S1 впав, лишився в черзі
  boom = false;
  ch.send({ apiFunc: 'g', args: ['y'] }); // flushOut має знову запуститись (sending=false)
  assert.deepEqual(log, ['S1', 'S2']);    // S1 дошило з черги, потім S2
});

test('queue: reset() чистить недовідправлену вихідну чергу (обрив)', () => {
  let boom = true;
  const log = [];
  const t = {
    sendBin: u8 => {
      const v = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      if (boom) throw new Error('dc closed');
      log.push(dv.getUint8(0) === 0 ? `S${dv.getUint32(1)}` : `c${dv.getUint32(1)}.${dv.getUint16(7)}`);
    },
    onBin: () => {}
  };
  const ch = binChannel(t, { chunkSize: 200000 });
  assert.throws(() => ch.send({ apiFunc: 'lost', args: [crypto.randomBytes(500 * 1024)] }), /dc closed/);
  ch.reset();        // обрив: викинути завислу чергу
  boom = false;
  ch.send({ apiFunc: 'fresh', args: ['x'] }); // має піти ЧИСТО, без хвоста старого packet
  assert.deepEqual(log, ['S2']); // лише новий packet; msgId інкрементувався (старий був #1)
});

test('queue: великий потік (50 packet) виходить рівно й у порядку', () => {
  const sp = spyTransport();
  const ch = binChannel(sp.t, { chunkSize: 200000 });
  for (let i = 0; i < 50; i++) ch.send({ apiFunc: 'f', args: ['x'] }); // без бінара -> лише skeleton
  // 50 skeleton-ів, msgId 1..50 по порядку
  assert.equal(sp.log.length, 50);
  assert.deepEqual(sp.log, Array.from({ length: 50 }, (_, i) => `S${i + 1}`));
});
