import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME, LIMITS, encodeFrame, decodeFrame, jsonFrame, requestMetadata, boundedHeaders } from '../src/protocol.mjs';

test('raw nine byte header preserves uint64 BigInt and binary payload', () => {
  const id = 0xffffffffffffffffn;
  const encoded = encodeFrame(FRAME.REQUEST_DATA, id, Buffer.from([0, 255, 128]));
  assert.equal(encoded.length, 12);
  assert.equal(encoded.subarray(1, 9).toString('hex'), 'ffffffffffffffff');
  assert.deepEqual(decodeFrame(encoded), { kind: FRAME.REQUEST_DATA, id, data: Buffer.from([0, 255, 128]) });
  assert.throws(() => encodeFrame(FRAME.REQUEST, 1));
});

test('malformed, text, unknown and oversized frames are forbidden', () => {
  for (const data of [Buffer.alloc(8), Buffer.alloc(9), Buffer.alloc(LIMITS.chunk + 10), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0, 0])]) {
    assert.throws(() => decodeFrame(data));
  }
  assert.throws(() => decodeFrame(encodeFrame(FRAME.CANCEL, 1n), false));
  assert.throws(() => jsonFrame(FRAME.REQUEST, 1n, { text: 'x'.repeat(LIMITS.metadata) }));
});

test('metadata enforces exact endpoint and header constraints', () => {
  const valid = { method: 'POST', path: '/v1/messages', header: { 'Content-Type': ['application/json'] }, deadline: Date.now() + 1000 };
  assert.equal(requestMetadata(Buffer.from(JSON.stringify(valid))).path, '/v1/messages');
  for (const extra of [
    { path: '/v1/messages?x' }, { path: '/v1/../v1/messages' }, { path: 'http://evil/v1/messages' },
    { path: '/v1/%6dessages' }, { method: 'DELETE' }, { deadline: '100' }, { deadline: 1.5 },
    { header: { authorization: 'secret' } }, { header: { key: ['value\r\nsecret'] } },
    { header: { 'bad name': ['value'] } }, { header: [] },
  ]) assert.throws(() => requestMetadata(Buffer.from(JSON.stringify({ ...valid, ...extra }))));
  assert.throws(() => requestMetadata(Buffer.from([0xff])));
  assert.equal(boundedHeaders({ key: ['x'.repeat(LIMITS.metadata)] }), false);
});
