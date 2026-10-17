/**
 * moment（印刷屋の manifest と同じ CDN の 2.24.0）を vendor/ に取り、vendor/moment.json の SHA-256 と照合する。
 * moment.json が無ければ（初回）取ったファイルのハッシュで作る。以後はハッシュが違えば止まる。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, "..", "vendor");
const URL_ = "https://js.cybozu.com/momentjs/2.24.0/moment-with-locales.min.js";
const file = path.join(vendor, "moment-with-locales.min.js");
const lock = path.join(vendor, "moment.json");
mkdirSync(vendor, { recursive: true });

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
let text;
if (existsSync(file)) {
  text = readFileSync(file, "utf8");
} else {
  const r = await fetch(URL_);
  if (!r.ok) throw new Error(`moment: HTTP ${r.status} ${URL_}`);
  text = await r.text();
  writeFileSync(file, text, "utf8");
  console.log(`fetched ${URL_}`);
}
const hash = sha(text);
if (existsSync(lock)) {
  const expected = JSON.parse(readFileSync(lock, "utf8"));
  if (expected.sha256 !== hash) {
    console.error(`moment の SHA-256 が vendor/moment.json と違う: ${hash} (expected ${expected.sha256})`);
    process.exit(1);
  }
} else {
  writeFileSync(lock, JSON.stringify({ url: URL_, version: "2.24.0", license: "MIT", sha256: hash }, null, 2) + "\n", "utf8");
  console.log(`wrote ${lock}`);
}
console.log(`moment ok: ${file} sha256 ${hash}`);
