// The Premiere Pro panel's link to the app (electron/premiere-bridge.js), in plain Node: who it answers, how a
// job goes from a frame to a file, and what it refuses.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { HEADER, PROTOCOL, pngSize, startPremiereBridge } from '../../electron/premiere-bridge.js';

/** The first bytes of a PNG of width × height (all the bridge looks at), padded to `length`. */
function pngHeader(width, height, length = 64) {
  const bytes = Buffer.alloc(length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A request with full control of its headers (fetch() won't set Host). */
function request(port, { method = 'GET', path = '/v1/hello', headers = {}, body } = {}) {
  const all = Object.fromEntries(Object.entries({ host: `127.0.0.1:${port}`, [HEADER]: String(PROTOCOL), ...headers }).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: all }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(raw.toString('utf8'));
        } catch {
          // a file
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const events = [];
let bridge;
before(async () => {
  bridge = await startPremiereBridge({
    ports: [0],
    version: '1.2.3',
    maxFrameBytes: 64 * 1024,
    onJob: (job) => events.push(['job', job]),
    onCancel: (id) => events.push(['cancel', id]),
    onPlaced: (id, message, ok) => events.push(ok === false ? ['placed', id, message, 'failed'] : ['placed', id, message]),
  });
});
after(() => bridge?.close());

const post = (query, body, headers = {}) => request(bridge.port, {
  method: 'POST', path: `/v1/jobs?${new URLSearchParams(query)}`, headers: { 'content-type': 'image/png', ...headers }, body,
});
const nextJobEvent = async () => {
  for (let i = 0; i < 100 && !events.some(([kind]) => kind === 'job'); i++) await new Promise((r) => setTimeout(r, 10));
  const index = events.findIndex(([kind]) => kind === 'job');
  return index < 0 ? null : events.splice(index, 1)[0][1];
};

test('answers the panel, and says which app and protocol it is', async () => {
  const reply = await request(bridge.port);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { app: 'YouTube Chat Comment', version: '1.2.3', protocol: PROTOCOL });
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['access-control-allow-origin'], undefined);
});

test('refuses requests without its header, for another Host, and CORS preflights', async () => {
  const noHeader = await request(bridge.port, { headers: { [HEADER]: undefined } });
  assert.equal(noHeader.status, 403);
  const oldProtocol = await request(bridge.port, { headers: { [HEADER]: '0' } });
  assert.equal(oldProtocol.status, 403);
  const rebound = await request(bridge.port, { headers: { host: `evil.example:${bridge.port}` } });
  assert.equal(rebound.status, 403);
  const otherPort = await request(bridge.port, { headers: { host: '127.0.0.1:1' } });
  assert.equal(otherPort.status, 403);
  assert.equal((await request(bridge.port, { headers: { host: `localhost:${bridge.port}` } })).status, 200, 'localhost is the same host');
});

test("refuses web pages outright, preflights included, but answers a plugin's preflight", async () => {
  const preflight = (origin) => request(bridge.port, {
    method: 'OPTIONS', path: '/v1/jobs',
    headers: { [HEADER]: undefined, origin, 'access-control-request-method': 'POST', 'access-control-request-headers': HEADER },
  });
  for (const origin of ['https://example.com', 'http://localhost:3000', 'file://', 'null']) {
    const answer = await preflight(origin);
    assert.equal(answer.status, 403, `a preflight from ${origin} is refused`);
    assert.equal(answer.headers['access-control-allow-origin'], undefined);
    const direct = await request(bridge.port, { headers: { origin } });
    assert.equal(direct.status, 403, `a request from ${origin} is refused, header or not`);
  }
  // (UXP's fetch sends no preflight as far as anyone knows; if a version does, its origin is no web page's.)
  const plugin = await preflight('plugin:');
  assert.equal(plugin.status, 204);
  assert.equal(plugin.headers['access-control-allow-origin'], 'plugin:');
  assert.match(plugin.headers['access-control-allow-headers'], new RegExp(HEADER));
  const asked = await request(bridge.port, { headers: { origin: 'plugin:' } });
  assert.equal(asked.status, 200);
  assert.equal(asked.headers['access-control-allow-origin'], 'plugin:');
  assert.equal((await request(bridge.port, { headers: { origin: 'plugin:', [HEADER]: undefined } })).status, 403, 'and still needs the header');
});

test('refuses frames it cannot use', async () => {
  const frame = pngHeader(1920, 1080);
  const rect = { x: 100, y: 200, width: 400, height: 60 };
  assert.equal((await post(rect, frame, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ ...rect, width: 'wide' }, frame)).status, 400);
  assert.equal((await post({ x: 1, y: 2, width: 3 }, frame)).status, 400, 'all four sides are needed');
  assert.equal((await post({ ...rect, x: -1 }, frame)).status, 400);
  assert.equal((await post({ ...rect, x: 1.5 }, frame)).status, 400);
  assert.equal((await post({ ...rect, x: 1600 }, frame)).status, 400, 'the box must lie inside the frame');
  assert.equal((await post({ ...rect, width: 4 }, frame)).status, 400, 'a box of a few pixels is a slip');
  assert.equal((await post(rect, Buffer.from('not a png at all, not at all'))).status, 400);
  assert.equal((await post(rect, pngHeader(20000, 20000))).status, 413);
  const huge = await post(rect, Buffer.concat([frame, Buffer.alloc(80 * 1024)]));
  assert.equal(huge.status, 413, 'a frame over the limit is refused');
  assert.equal(events.length, 0, 'none of them reached the app');
});

test('takes a job from a frame to a file', async () => {
  const frame = pngHeader(1920, 1080, 500);
  const created = await post({ x: 100, y: 200, width: 400, height: 60, label: 'Sequence 01 at 00:00:05:00\n' }, frame);
  assert.equal(created.status, 201);
  assert.equal(created.json.state, 'reading');
  assert.equal(created.json.label, 'Sequence 01 at 00:00:05:00', 'control characters are dropped');
  const job = await nextJobEvent();
  assert.equal(job.id, created.json.id);
  assert.deepEqual(job.rect, { x: 100, y: 200, width: 400, height: 60 });
  assert.ok(job.frame.equals(frame), 'the app gets the frame as sent');

  assert.equal(bridge.update(job.id, 'review', 'Check the comment in the app.'), true);
  assert.equal((await request(bridge.port, { path: `/v1/jobs/${job.id}` })).json.state, 'review');
  assert.equal((await request(bridge.port, { path: `/v1/jobs/${job.id}/file` })).status, 409, 'no file before it is done');
  assert.equal(bridge.update(job.id, 'done'), false, 'only deliver() finishes a job');

  const png = pngHeader(400, 32, 300);
  assert.throws(() => bridge.deliver(job.id, { kind: 'png', bytes: Buffer.from('nope, not a png file'), width: 400, height: 32 }), /not a PNG/);
  assert.throws(() => bridge.deliver(job.id, { kind: 'gif', bytes: png, width: 400, height: 32 }), /kind/);
  assert.equal(bridge.deliver(job.id, { kind: 'png', bytes: png, width: 400, height: 32, name: '@quietharbor' }), true);
  const done = (await request(bridge.port, { path: `/v1/jobs/${job.id}` })).json;
  assert.equal(done.state, 'done');
  assert.deepEqual(done.file, { kind: 'png', width: 400, height: 32, bytes: 300, name: '@quietharbor' });
  const file = await request(bridge.port, { path: `/v1/jobs/${job.id}/file` });
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/png');
  assert.ok(file.raw.equals(png));

  const placed = await request(bridge.port, { method: 'POST', path: `/v1/jobs/${job.id}/placed`, body: JSON.stringify({ message: 'Placed on V2 at 00:00:05:00.' }) });
  assert.equal(placed.status, 200);
  assert.deepEqual(events.splice(0), [['placed', job.id, 'Placed on V2 at 00:00:05:00.']]);
  assert.equal((await request(bridge.port, { method: 'POST', path: `/v1/jobs/${job.id}/placed`, body: '{oops' })).status, 400);
  assert.equal((await request(bridge.port, { method: 'DELETE', path: `/v1/jobs/${job.id}` })).status, 405);
  assert.equal((await request(bridge.port, { path: '/v1/jobs/no-such-job' })).status, 404);
});

test('a new frame replaces the job still open, and either side can cancel', async () => {
  const rect = { x: 0, y: 0, width: 300, height: 40 };
  const first = (await post(rect, pngHeader(640, 360))).json;
  await nextJobEvent();
  const second = (await post(rect, pngHeader(640, 360))).json;
  await nextJobEvent();
  assert.deepEqual(events.splice(0), [['cancel', first.id]]);
  assert.equal((await request(bridge.port, { path: `/v1/jobs/${first.id}` })).json.state, 'cancelled');
  assert.equal(bridge.deliver(first.id, { kind: 'png', bytes: pngHeader(10, 10), width: 10, height: 10 }), false, 'a replaced job takes no file');

  const cancelled = await request(bridge.port, { method: 'POST', path: `/v1/jobs/${second.id}/cancel` });
  assert.equal(cancelled.json.state, 'cancelled');
  assert.deepEqual(events.splice(0), [['cancel', second.id]]);
  assert.equal(bridge.update(second.id, 'rendering'), false);

  const third = (await post(rect, pngHeader(640, 360))).json;
  await nextJobEvent();
  assert.equal(bridge.cancel(third.id, 'Cancelled in the app.'), true);
  assert.deepEqual((await request(bridge.port, { path: `/v1/jobs/${third.id}` })).json.message, 'Cancelled in the app.');
  assert.equal(events.length, 0, 'the app is not told about its own cancel');
});

test('a job the app fails says why', async () => {
  const failing = await startPremiereBridge({ ports: [0], onJob: async () => { throw new Error("Couldn't find a chat comment in the image."); } });
  try {
    const created = await request(failing.port, {
      method: 'POST', path: '/v1/jobs?x=0&y=0&width=100&height=40', headers: { 'content-type': 'image/png' }, body: pngHeader(320, 180),
    });
    let state;
    for (let i = 0; i < 100 && state?.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      state = (await request(failing.port, { path: `/v1/jobs/${created.json.id}` })).json;
    }
    assert.equal(state.state, 'failed');
    assert.equal(state.message, "Couldn't find a chat comment in the image.");
  } finally {
    await failing.close();
  }
});

test('moves on to the next port when one is taken, and gives up when all are', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const taken = blocker.address().port;
  try {
    const next = await startPremiereBridge({ ports: [taken, 0] });
    assert.ok(next && next.port !== taken);
    await next.close();
    assert.equal(await startPremiereBridge({ ports: [taken] }), null);
  } finally {
    blocker.close();
  }
});

test('answers on both loopback addresses, as localhost resolves to either', async () => {
  const ipv4 = await request(bridge.port);
  assert.equal(ipv4.status, 200);
  const ipv6 = await new Promise((resolve, reject) => {
    const req = http.request({ host: '::1', port: bridge.port, path: '/v1/hello', headers: { host: `[::1]:${bridge.port}`, [HEADER]: String(PROTOCOL) } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (error) => (error.code === 'EADDRNOTAVAIL' || error.code === 'ENETUNREACH' ? resolve('no IPv6') : reject(error)));
    req.end();
  });
  assert.ok(ipv6 === 200 || ipv6 === 'no IPv6', `::1 answered ${ipv6}`);
  const named = await fetch(`http://localhost:${bridge.port}/v1/hello`, { headers: { [HEADER]: String(PROTOCOL) } });
  assert.equal(named.status, 200, 'and so does localhost');
});

test('pngSize reads a PNG header and nothing else', () => {
  assert.deepEqual(pngSize(pngHeader(1920, 1080)), { width: 1920, height: 1080 });
  assert.equal(pngSize(Buffer.from('GIF89a, not a png, not a png')), null);
  assert.equal(pngSize(pngHeader(0, 10)), null);
  assert.equal(pngSize(Buffer.alloc(8)), null);
});

test('an origin that is neither a web page nor UXP gets no preflight and no reply it could read', async () => {
  const preflight = await request(bridge.port, {
    method: 'OPTIONS', path: '/v1/jobs',
    headers: { [HEADER]: undefined, origin: 'chrome-extension://abcdef', 'access-control-request-method': 'POST', 'access-control-request-headers': HEADER },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  const asked = await request(bridge.port, { headers: { origin: 'chrome-extension://abcdef' } });
  assert.equal(asked.headers['access-control-allow-origin'], undefined, 'no CORS header for it');
});

test('a frame is judged by its first bytes: a wrong one is refused before the rest is taken', async () => {
  const notPng = Buffer.alloc(40 * 1024, 7);
  const refused = await post({ x: 0, y: 0, width: 100, height: 40 }, notPng);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /not a PNG/);
  const huge = await post({ x: 0, y: 0, width: 100, height: 40 }, pngHeader(7000, 7000));
  assert.equal(huge.status, 413, 'a frame larger than the reader takes (40 million pixels)');
  const outside = await post({ x: 600, y: 0, width: 100, height: 40 }, pngHeader(640, 360));
  assert.equal(outside.status, 400);
  assert.equal(events.length, 0, 'none of them reached the app');
});

test('one frame at a time: another upload while one is coming in is told to wait', async () => {
  const query = new URLSearchParams({ x: '0', y: '0', width: '100', height: '40' });
  const headers = { host: `127.0.0.1:${bridge.port}`, [HEADER]: String(PROTOCOL), 'content-type': 'image/png', 'content-length': '64' };
  const first = http.request({ host: '127.0.0.1', port: bridge.port, method: 'POST', path: `/v1/jobs?${query}`, headers });
  const answered = new Promise((resolve) => first.on('response', (res) => { res.resume(); resolve(res.statusCode); }));
  first.write(pngHeader(640, 360).subarray(0, 30)); // the header only, for now
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await post({ x: 0, y: 0, width: 100, height: 40 }, pngHeader(640, 360));
  assert.equal(second.status, 503);
  first.end(pngHeader(640, 360).subarray(30));
  assert.equal(await answered, 201);
  await nextJobEvent();
});

test('text from the panel loses characters that would turn it round, and a failed placement says so', async () => {
  const created = await post({ x: 0, y: 0, width: 100, height: 40, label: 'Sequence‮10 at 00:00:01:00' }, pngHeader(640, 360));
  assert.equal(created.json.label, 'Sequence10 at 00:00:01:00');
  const job = await nextJobEvent();
  events.length = 0; // (the frame before it was replaced: that cancel is the previous test's)
  bridge.deliver(job.id, { kind: 'png', bytes: pngHeader(400, 32), width: 400, height: 32 });
  await request(bridge.port, { method: 'POST', path: `/v1/jobs/${job.id}/placed`, body: JSON.stringify({ message: 'Premiere Pro couldn⁦t place it.', ok: false }) });
  assert.deepEqual(events.splice(0), [['placed', job.id, 'Premiere Pro couldnt place it.', 'failed']]);
});
