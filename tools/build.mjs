#!/usr/bin/env node
// x-ambient ビルド: node tools/build.mjs [--key key.pem] [--old-crx 旧版.crx]
//  dist/x-ambient-<ver>.crx  (Chrome, CRX3, --key の鍵で署名。無ければ新規生成して dist/key.pem に保存)
//  dist/x-ambient-<ver>.xpi  (Firefox, 未署名。通常のFirefoxに入れるには addons.mozilla.org での署名が必要)
// --old-crx を渡すと旧CRXから公開鍵を取り出し、manifest.json に "key" を入れる（解凍して読み込む場合に旧版と同じ拡張機能IDになる）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  }).sort();
}

function zip(dir, overrides = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const name of listFiles(dir)) {
    const data = overrides[name] ?? fs.readFileSync(path.join(dir, name));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); // 1980-01-01 固定（再現可能なビルド）
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// --- 最小限の protobuf ---
const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const field = (num, buf) => Buffer.concat([varint(num * 8 + 2), varint(buf.length), buf]);
function readFields(buf) {
  const out = []; let i = 0;
  const rv = () => { let r = 0, s = 1; for (;;) { const b = buf[i++]; r += (b & 127) * s; if (b < 128) return r; s *= 128; } };
  while (i < buf.length) {
    const tag = rv(), num = Math.floor(tag / 8), type = tag & 7;
    if (type === 2) { const len = rv(); out.push([num, buf.subarray(i, i + len)]); i += len; }
    else if (type === 0) rv(); else if (type === 1) i += 8; else if (type === 5) i += 4; else throw new Error("unsupported wire type");
  }
  return out;
}

function publicKeyFromCrx(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("latin1", 0, 4) !== "Cr24" || buf.readUInt32LE(4) !== 3) throw new Error("CRX3 ではありません");
  const header = buf.subarray(12, 12 + buf.readUInt32LE(8));
  const fields = readFields(header);
  const signed = fields.find(([n]) => n === 10000)?.[1];
  const crxId = signed && readFields(signed).find(([n]) => n === 1)?.[1];
  const keys = fields.filter(([n]) => n === 2).map(([, b]) => readFields(b).find(([m]) => m === 1)[1]);
  return keys.find((k) => crxId && crypto.createHash("sha256").update(k).digest().subarray(0, 16).equals(crxId)) ?? keys[0];
}

function crx3(zipBuf, privateKeyPem) {
  const priv = crypto.createPrivateKey(privateKeyPem);
  const pub = crypto.createPublicKey(priv).export({ type: "spki", format: "der" });
  const crxId = crypto.createHash("sha256").update(pub).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const len = Buffer.alloc(4); len.writeUInt32LE(signedData.length);
  const signature = crypto.sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\0"), len, signedData, zipBuf]), priv);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, pub), field(2, signature)])), field(10000, signedData)]);
  const pre = Buffer.alloc(12); pre.write("Cr24", 0, "latin1"); pre.writeUInt32LE(3, 4); pre.writeUInt32LE(header.length, 8);
  const id = [...crxId].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
  return { file: Buffer.concat([pre, header, zipBuf]), id, pub };
}

const version = JSON.parse(fs.readFileSync(path.join(root, "chrome/manifest.json"), "utf8")).version;

// Chrome
const keyPath = opt("--key") ?? path.join(dist, "key.pem");
let pem;
if (fs.existsSync(keyPath)) pem = fs.readFileSync(keyPath, "utf8");
else {
  pem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  console.log(`新しい署名鍵を作成: ${keyPath}（絶対に失くさないこと。公開リポジトリにも入れない）`);
}
const overrides = {};
const oldCrx = opt("--old-crx");
if (oldCrx) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "chrome/manifest.json"), "utf8"));
  manifest.key = publicKeyFromCrx(oldCrx).toString("base64");
  overrides["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  console.log("旧CRXの公開鍵を manifest の key に入れました（解凍読み込みでは旧版と同じIDになります）");
}
const built = crx3(zip(path.join(root, "chrome"), overrides), pem);
fs.writeFileSync(path.join(dist, `x-ambient-${version}.crx`), built.file);
console.log(`Chrome: dist/x-ambient-${version}.crx  拡張機能ID: ${built.id}`);

// Firefox
fs.writeFileSync(path.join(dist, `x-ambient-${version}.xpi`), zip(path.join(root, "firefox")));
console.log(`Firefox: dist/x-ambient-${version}.xpi（未署名）`);
