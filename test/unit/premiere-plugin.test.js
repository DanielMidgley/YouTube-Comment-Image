// The Premiere Pro panel's own logic (premiere-plugin/lib/), in Node: its arithmetic, and its side of the link
// to the app, run against the app's real side (electron/premiere-bridge.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { BRIDGE_PORTS, HEADER, PROTOCOL, startPremiereBridge } from '../../electron/premiere-bridge.js';

const require = createRequire(import.meta.url);
const PLUGIN = path.join(import.meta.dirname, '..', '..', 'premiere-plugin');
const geometry = require(path.join(PLUGIN, 'lib', 'geometry.js'));
const bridge = require(path.join(PLUGIN, 'lib', 'bridge.js'));

test('a drag on the panel covers whole frame pixels, inside the frame', () => {
  const frame = { width: 1920, height: 1080 };
  const view = { x: 0, y: 0, ...frame };
  const fit = geometry.fitView(view, 480);
  assert.equal(fit.scale, 0.25);
  assert.equal(fit.height, 270);
  const a = geometry.toFrame(view, fit, 100.3, 50.1);
  const b = geometry.toFrame(view, fit, 20, 300); // past the bottom edge
  assert.deepEqual(geometry.boxBetween(a, b, frame), { x: 80, y: 200, width: 322, height: 880 });
  assert.deepEqual(geometry.toPanel(view, fit, { x: 80, y: 200, width: 320, height: 40 }), { left: 20, top: 50, width: 80, height: 10 });
});

test('zooming to a box shows it large, inside the frame', () => {
  const frame = { width: 1920, height: 1080 };
  const view = geometry.zoomTo({ x: 1500, y: 900, width: 400, height: 60 }, frame);
  assert.ok(view.x + view.width <= frame.width && view.y + view.height <= frame.height && view.x >= 0 && view.y >= 0);
  assert.ok(view.width >= 400 && view.height >= 60);
  assert.ok(view.height >= view.width / 4 - 1e-9, 'a thin box gets some height around it');
  const fit = geometry.fitView(view, 400);
  const drawn = geometry.toPanel(view, fit, { x: 1500, y: 900, width: 400, height: 60 });
  assert.ok(drawn.width > 250, `the comment is drawn ${drawn.width.toFixed(0)} px wide, large enough to box precisely`);
  const whole = geometry.zoomTo({ x: 0, y: 0, width: 1920, height: 1080 }, frame);
  assert.deepEqual(whole, { x: 0, y: 0, width: 1920, height: 1080 });
});

test('timecodes and frame rates', () => {
  assert.equal(geometry.framesPerSecond('8475667200'), 254016000000 / 8475667200); // 29.97
  assert.equal(geometry.framesPerSecond('10584000000'), 24);
  assert.equal(geometry.framesPerSecond(''), 30);
  assert.equal(geometry.timecode(0, 25), '00:00:00:00');
  assert.equal(geometry.timecode(3725.52, 25), '01:02:05:13');
  assert.equal(geometry.timecode(59.999, 30), '00:01:00:00');
  assert.equal(geometry.timecode(5, 25, { start: 3600 }), '01:00:05:00', 'from the sequence’s start timecode');
  // Drop-frame at 29.97: frame numbers 0 and 1 are skipped each minute, except every tenth.
  const ntsc = 30000 / 1001;
  const at = (frame, fps = ntsc) => geometry.timecode(frame / fps, fps, { dropFrame: true });
  assert.equal(at(1799), '00:00:59;29');
  assert.equal(at(1800), '00:01:00;02');
  assert.equal(at(17982), '00:10:00;00');
  assert.equal(at(3600, 60000 / 1001), '00:01:00;04', 'and four at 59.94');
  assert.equal(geometry.timecode(1800 / 25, 25, { dropFrame: true }), '00:01:12:00', 'never at a rate that has none');
});

test('file names for comments', () => {
  const date = new Date(2026, 9, 11, 15, 30, 12);
  assert.equal(geometry.fileNameFor('@Some Name!', 'png', date), 'comment-some-name-20261011-153012.png');
  assert.equal(geometry.fileNameFor('Ines Marlow', 'mp4', date), 'comment-ines-marlow-20261011-153012.mp4');
  assert.equal(geometry.fileNameFor('@😀😀', 'png', date), 'comment-comment-20261011-153012.png');
  assert.equal(geometry.fileNameFor('a/b\\c:d', 'png', date), 'comment-a-b-c-d-20261011-153012.png');
});

test('the panel and the app agree on where and how to talk', () => {
  assert.deepEqual(bridge.PORTS, BRIDGE_PORTS);
  assert.equal(bridge.HEADER.toLowerCase(), HEADER);
  assert.equal(bridge.PROTOCOL, PROTOCOL);
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'));
  const domains = manifest.requiredPermissions.network.domains;
  // (localhost, not 127.0.0.1: UXP drops a domain entry that is a bare IP address.)
  for (const port of BRIDGE_PORTS) assert.ok(domains.includes(`http://localhost:${port}`), `the manifest lets the panel reach port ${port}`);
  assert.equal(domains.length, BRIDGE_PORTS.length, 'and nothing else');
});

/** The first bytes of a PNG of width × height: all the app's side looks at before it hands the frame on. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("the panel's client works the app's side of the link", async () => {
  const jobs = [];
  const app = await startPremiereBridge({ ports: [0], version: '9.9.9', onJob: (job) => jobs.push(job) });
  try {
    const client = bridge.createBridge({ fetch, ports: [1, app.port] }); // (nothing answers on port 1)
    assert.deepEqual(await client.find(), { app: 'YouTube Chat Comment', version: '9.9.9', protocol: PROTOCOL });
    const frame = pngHeader(1920, 1080);
    const job = await client.startJob(frame, { x: 100, y: 200, width: 400, height: 60 }, 'Sequence 01 at 00:00:05:00');
    assert.equal(job.state, 'reading');
    for (let i = 0; i < 100 && !jobs.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(Buffer.from(jobs[0].frame).equals(frame), 'the frame arrives as sent');
    assert.equal(jobs[0].label, 'Sequence 01 at 00:00:05:00');
    app.update(job.id, 'review', 'Check the comment in the app.');
    assert.equal((await client.job(job.id)).state, 'review');
    await assert.rejects(client.file(job.id), /not ready/);
    const png = pngHeader(400, 32);
    app.deliver(job.id, { kind: 'png', bytes: png, width: 400, height: 32 });
    const done = await client.job(job.id);
    assert.deepEqual(done.file, { kind: 'png', width: 400, height: 32, bytes: png.length });
    assert.ok(Buffer.from(await client.file(job.id)).equals(png));
    await client.placed(job.id, 'Placed on V2.');
    const second = await client.startJob(frame, { x: 0, y: 0, width: 50, height: 50 });
    assert.equal((await client.cancel(second.id)).state, 'cancelled');
    await assert.rejects(client.startJob(frame, { x: 1900, y: 0, width: 50, height: 50 }), /inside the 1920 × 1080 px frame/);
  } finally {
    await app.close();
  }
  const lost = bridge.createBridge({ fetch, ports: [1] });
  assert.equal(await lost.find(), null);
  await assert.rejects(lost.job('x'), /Can't find the YouTube Chat Comment app/);
});

test('base64 for the frame matches Node’s, at every padding', () => {
  const { base64 } = require(path.join(PLUGIN, 'lib', 'bytes.js'));
  for (const length of [0, 1, 2, 3, 4, 5, 12287, 12288, 12289, 40000]) {
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 7919 + length) % 256;
    assert.equal(base64(new Uint8Array(bytes)), bytes.toString('base64'), `${length} bytes`);
    assert.equal(base64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length)), bytes.toString('base64'), `${length} bytes as an ArrayBuffer`);
  }
});

test('the .ccx holds the plugin with manifest.json at its root, as Creative Cloud installs it', async () => {
  const { packagePlugin } = await import('../../scripts/package-premiere-plugin.js');
  const out = path.join(os.tmpdir(), `youtube-comment-ccx-${process.pid}.ccx`);
  const again = `${out}.again`;
  try {
    const { files } = packagePlugin({ out });
    const archive = fs.readFileSync(out);
    const end = archive.length - 22;
    assert.equal(archive.readUInt32LE(end), 0x06054b50, 'it ends with a ZIP directory');
    const names = [];
    let at = archive.readUInt32LE(end + 16);
    for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
      assert.equal(archive.readUInt32LE(at), 0x02014b50);
      const nameLength = archive.readUInt16LE(at + 28);
      const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
      const local = archive.readUInt32LE(at + 42);
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const body = archive.subarray(start, start + archive.readUInt32LE(at + 20));
      const data = archive.readUInt16LE(at + 10) === 8 ? zlib.inflateRawSync(body) : body;
      assert.equal(zlib.crc32(data), archive.readUInt32LE(at + 16), `${name}'s checksum`);
      assert.ok(data.equals(fs.readFileSync(path.join(PLUGIN, ...name.split('/')))), `${name} is the plugin's file`);
      names.push(name);
      at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    }
    assert.deepEqual(names, files);
    assert.ok(names.every((name) => !name.includes(path.win32.sep)), 'forward slashes only');
    assert.ok(!names.includes('package.json'), 'the Node-only package.json stays out');
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'));
    assert.ok(names.includes('manifest.json') && names.includes(manifest.main));
    // (UXP looks for name@1x and name@2x for an icon of scale [1, 2].)
    for (const icon of [...manifest.icons, ...manifest.entrypoints.flatMap((e) => e.icons ?? [])]) {
      assert.equal(icon.width, icon.height, `${icon.path} is square`);
      for (const scale of icon.scale ?? [1]) assert.ok(names.includes(icon.path.replace(/(\.\w+)$/, `@${scale}x$1`)), `${icon.path} at ${scale}x is packaged`);
      assert.ok(names.includes(icon.path));
    }
    // Every require() of the plugin's own files finds one in the package.
    for (const name of names.filter((n) => n.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(PLUGIN, ...name.split('/')), 'utf8');
      for (const [, wanted] of source.matchAll(/require\('(\.[^']+)'\)/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), wanted));
        assert.ok(names.includes(target), `${name} requires ${wanted}, packaged as ${target}`);
      }
    }
    assert.equal(manifest.manifestVersion, 5);
    assert.ok(!Array.isArray(manifest.host) && manifest.host.app === 'premierepro' && /^\d+\.\d+\.\d+$/.test(manifest.host.minVersion));
    packagePlugin({ out: again });
    assert.ok(fs.readFileSync(again).equals(archive), 'the same files give the same archive');
  } finally {
    fs.rmSync(out, { force: true });
    fs.rmSync(again, { force: true });
  }
});
