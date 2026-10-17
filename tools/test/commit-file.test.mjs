/** ファイルの確定とロック（commit-file.ts。Codex 再レビュー BLOCKER 2、MAJOR 3、4） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileExistsError, LockBusyError, acquireLock, cleanupAll, lockPathFor, placeNew, withRetry, writeNewFile } from "../src/commit-file.ts";
import { realResolve } from "../src/safe-path.ts";

const work = () => realResolve(".", mkdtempSync(path.join(os.tmpdir(), "formula-commit-")));
const leftovers = (dir) => readdirSync(dir).filter((n) => n.startsWith("."));
/** フォルダーの書き込みを止めて失敗を作る試験（Windows と root では chmod が効かないので飛ばす） */
const NO_CHMOD = process.platform === "win32" || process.getuid?.() === 0;
const age = (file, ms) => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};

test("writeNewFile: 新しい名前で確定する。確かめた後に同じ名前ができたら上書きせず FileExistsError。確かめ直しが投げたら書かない。一時ファイルを残さない", () => {
  const dir = work();
  try {
    const target = path.join(dir, "a.json");
    assert.deepEqual(writeNewFile(target, "1"), { cleanup: [] });
    assert.equal(readFileSync(target, "utf8"), "1");
    assert.throws(() => writeNewFile(target, "2"), FileExistsError, "既にあれば上書きしない");
    const raced = path.join(dir, "b.json");
    assert.throws(() => writeNewFile(raced, "mine", () => writeFileSync(raced, "theirs")), FileExistsError);
    assert.equal(readFileSync(raced, "utf8"), "theirs", "確かめた後に作られたファイルを上書きしない");
    assert.throws(() => writeNewFile(path.join(dir, "c.json"), "x", () => {
      throw new Error("許可されない");
    }), /許可されない/);
    assert.ok(!existsSync(path.join(dir, "c.json")));
    assert.deepEqual(leftovers(dir), [], "一時ファイルを残さない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock: 取っている間は他が取れない。外すと取れる。外すのは自分の印のロックだけ（他の保存が取り直したロックは消さない）", () => {
  const dir = work();
  try {
    const target = path.join(dir, "a.json");
    const a = acquireLock(target);
    assert.equal(a.owned(), true);
    assert.throws(() => acquireLock(target), (e) => e instanceof LockBusyError && /進行中/.test(e.message));
    assert.equal(a.release(), true);
    assert.ok(!existsSync(lockPathFor(target)));
    const b = acquireLock(target);
    // 長く止まった b のロックを、他の保存が古いとみなして取り直した
    writeFileSync(lockPathFor(target), "someone-else");
    assert.equal(b.owned(), false, "確定の直前に気づける");
    assert.equal(b.release(), false);
    assert.equal(readFileSync(lockPathFor(target), "utf8"), "someone-else", "他の保存のロックを消さない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock: 60 秒より古いロックは回収して取る。新しいロックは取らない。普通のファイルでないロック（symlink、フォルダー）は取らず、触らない", () => {
  const dir = work();
  try {
    const target = path.join(dir, "a.json");
    const lock = lockPathFor(target);
    writeFileSync(lock, "old");
    age(lock, 120_000);
    const l = acquireLock(target);
    assert.notEqual(readFileSync(lock, "utf8"), "old", "自分の印に替わる");
    assert.deepEqual(leftovers(dir).filter((n) => n.endsWith(".stale")), [], "回収した古いロックを残さない");
    l.release();
    writeFileSync(lock, "fresh");
    assert.throws(() => acquireLock(target, 60_000), LockBusyError);
    assert.equal(readFileSync(lock, "utf8"), "fresh");
    rmSync(lock);

    const victim = path.join(dir, "victim.txt");
    writeFileSync(victim, "keep");
    symlinkSync(victim, lock);
    age(victim, 120_000);
    assert.throws(() => acquireLock(target), (e) => e instanceof LockBusyError && /普通のファイルでない/.test(e.message));
    assert.equal(readFileSync(victim, "utf8"), "keep", "symlink の先を書き換えない");
    rmSync(lock);
    mkdirSync(lock);
    assert.throws(() => acquireLock(target), /普通のファイルでない/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupAll: 1 つずつ別に試す（1 つの失敗で残りを飛ばさない）。EPERM / EBUSY はやり直す", () => {
  let tries = 0;
  const busyTwice = () => {
    tries++;
    if (tries < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  assert.deepEqual(cleanupAll([busyTwice]), []);
  assert.equal(tries, 3);
  let second = false;
  const errors = cleanupAll([
    () => {
      throw Object.assign(new Error("消せない"), { code: "EACCES" });
    },
    () => {
      second = true;
    }
  ]);
  assert.deepEqual(errors, ["消せない"]);
  assert.equal(second, true, "前の片付けが失敗しても次を試す");
  let n = 0;
  assert.equal(cleanupAll([() => {
    n++;
    throw Object.assign(new Error("ずっと EPERM"), { code: "EPERM" });
  }]).length, 1);
  assert.equal(n, 3, "やり直しは 3 回まで");
});

test("acquireLock: 古いと判断した後、付け替えの前に新しいロックに替わったら戻して取らない。戻す先に別のロックがあれば戻さない", () => {
  const dir = work();
  try {
    const target = path.join(dir, "a.json");
    const lock = lockPathFor(target);
    writeFileSync(lock, "old");
    age(lock, 120_000);
    assert.throws(() => acquireLock(target, 60_000, { beforeClaim: () => writeFileSync(lock, "fresh") }), LockBusyError);
    assert.equal(readFileSync(lock, "utf8"), "fresh", "替わった新しいロックを戻す（持ち主の印を失わない）");
    assert.deepEqual(leftovers(dir).filter((n) => n.endsWith(".stale")), []);

    writeFileSync(lock, "old");
    age(lock, 120_000);
    assert.throws(() => acquireLock(target, 60_000, { beforeClaim: () => writeFileSync(lock, "fresh"), beforeRestore: () => writeFileSync(lock, "third") }), LockBusyError);
    assert.equal(readFileSync(lock, "utf8"), "third", "戻す先に別のロックがあれば上書きしない");
    assert.deepEqual(leftovers(dir).filter((n) => n.endsWith(".stale")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock: 新しいロックを戻せない（EEXIST 以外）ときは、付け替えたファイルを消さずに止める", { skip: NO_CHMOD }, () => {
  const dir = work();
  try {
    const target = path.join(dir, "a.json");
    const lock = lockPathFor(target);
    writeFileSync(lock, "old");
    age(lock, 120_000);
    assert.throws(
      () => acquireLock(target, 60_000, { beforeClaim: () => writeFileSync(lock, "fresh"), beforeRestore: () => chmodSync(dir, 0o555) }),
      (e) => e instanceof LockBusyError && /新しいロックを戻せなかった/.test(e.message)
    );
    chmodSync(dir, 0o755);
    const stale = leftovers(dir).filter((n) => n.endsWith(".stale"));
    assert.equal(stale.length, 1, "付け替えたファイルを残す");
    assert.equal(readFileSync(path.join(dir, stale[0]), "utf8"), "fresh", "持ち主の印は残っている");
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("placeNew: ハードリンクが使えないファイルシステムでは排他のコピーで確定する（同じ名前があれば FileExistsError）", () => {
  const dir = work();
  try {
    const tmp = path.join(dir, "t.tmp");
    writeFileSync(tmp, "x");
    const noLink = () => {
      throw Object.assign(new Error("not supported"), { code: "EPERM" });
    };
    placeNew(tmp, path.join(dir, "a.json"), noLink);
    assert.equal(readFileSync(path.join(dir, "a.json"), "utf8"), "x");
    writeFileSync(path.join(dir, "b.json"), "theirs");
    assert.throws(() => placeNew(tmp, path.join(dir, "b.json"), noLink), FileExistsError);
    assert.equal(readFileSync(path.join(dir, "b.json"), "utf8"), "theirs");
    const otherError = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    assert.throws(() => placeNew(tmp, path.join(dir, "c.json"), otherError), /denied/, "コピーに切り替えるのはハードリンクが使えないときだけ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withRetry: EPERM / EBUSY は短く待ってやり直し、値を返す。それ以外はすぐ投げる", () => {
  let n = 0;
  assert.equal(withRetry(() => (++n < 3 ? (() => { throw Object.assign(new Error("perm"), { code: "EPERM" }); })() : "ok")), "ok");
  assert.equal(n, 3);
  let m = 0;
  assert.throws(() => withRetry(() => {
    m++;
    throw Object.assign(new Error("acces"), { code: "EACCES" });
  }), /acces/);
  assert.equal(m, 1);
});
