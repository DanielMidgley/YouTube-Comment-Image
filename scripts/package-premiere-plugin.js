// Packages the Premiere Pro panel (premiere-plugin/) as a .ccx, the file Creative Cloud installs when it is
// double-clicked: a ZIP with manifest.json at its root and forward slashes in its names. Run:
//   node scripts/package-premiere-plugin.js [--out=file]
// (default dist/YouTube-Chat-Comment-Premiere-<version>.ccx). The archive is the same, byte for byte, for the
// same files: entries are sorted and dated alike.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.join(import.meta.dirname, '..');
export const PLUGIN_DIR = path.join(ROOT, 'premiere-plugin');
// For Node only (it makes the plugin's files CommonJS for the unit tests); UXP reads manifest.json.
const LEFT_OUT = new Set(['package.json']);
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01, 00:00
const DOS_TIME = 0;

/** The plugin's files, as paths relative to its folder with forward slashes, sorted. */
export function pluginFiles(dir = PLUGIN_DIR) {
  const files = [];
  const walk = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), `${name}/`);
      else if (entry.isFile() && !LEFT_OUT.has(name)) files.push(name);
    }
  };
  walk(dir, '');
  return files.sort();
}

/** A ZIP of `entries` ([{ name, data }]), each deflated (or stored, if that is smaller). */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data);
    const header = (signature, extra) => {
      const fields = Buffer.alloc(extra);
      fields.writeUInt32LE(signature, 0);
      return fields;
    };
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const central = header(0x02014b50, 46);
    central.writeUInt16LE(20, 4); // made by: 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Writes the .ccx to `out` (or the default) and returns its path and what went in. */
export function packagePlugin({ dir = PLUGIN_DIR, out } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (Array.isArray(manifest.host) || manifest.host?.app !== 'premierepro') {
    throw new Error('manifest.json: host must be one object for "premierepro" (an installed plugin may not list several).');
  }
  const target = out ?? path.join(ROOT, 'dist', `YouTube-Chat-Comment-Premiere-${manifest.version}.ccx`);
  const files = pluginFiles(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, zip(files.map((name) => ({ name, data: fs.readFileSync(path.join(dir, ...name.split('/'))) }))));
  return { file: target, files, version: manifest.version };
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const wrong = args.find((arg) => !/^--out=./s.test(arg));
  if (wrong !== undefined || args.length > 1) {
    console.error(`${wrong === undefined ? 'Give --out once' : `Unknown argument ${wrong}`}. Run: node scripts/package-premiere-plugin.js [--out=file]`);
    process.exit(2);
  }
  const { file, files, version } = packagePlugin({ out: args[0] ? path.resolve(args[0].slice('--out='.length)) : undefined });
  console.log(`Packaged the Premiere Pro panel ${version} (${files.length} files) → ${path.relative(process.cwd(), file)}`);
}
