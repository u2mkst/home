// AES 키 교체: DB 전체에서 "옛 키로 암호화된 값"을 찾아 새 키로 다시 암호화한다.
//
// 사전 준비(Vercel과 같은 값):
//   AES_KEY      = 새 키 (32자 이상 무작위)
//   AES_KEY_OLD  = 옛 키 (지금까지 쓰던 키)
//   FIREBASE_SERVICE_ACCOUNT_PATH = 서비스 계정 키 파일 경로
//
// 사용:
//   미리보기(아무것도 쓰지 않음):  node scripts/rotate-aes-key.js
//   적용:                          node scripts/rotate-aes-key.js --apply
//   되돌리기(백업 파일로 복원):    node scripts/rotate-aes-key.js --restore aes-rotation-backup-XXXX.json
//
// 안전장치
//  - 기본은 미리보기. --apply 때만 쓰고, 쓰기 전에 옛 값 전체를 백업 파일로 저장한다.
//  - 새 키로 만든 암호문을 다시 풀어 원래 평문과 같은지 검증한 뒤에만 쓴다.
//  - 각 값은 "읽은 뒤 그 사이 바뀌지 않았을 때만" 교체한다(학생이 방금 수정한 값을 덮어쓰지 않음).
//  - 같은 암호문이 여러 곳에 복사돼 있으면(students/name ↔ public_students/name) 같은 새 암호문으로 맞춘다.
//  - 어느 키로도 안 풀리는 값은 건드리지 않고 경로만 알려준다. 평문이나 키는 화면에 출력하지 않는다.

const fs = require("fs");
const CryptoJS = require("crypto-js");

if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH && !process.env.FIREBASE_SERVICE_ACCOUNT) {
    process.env.FIREBASE_SERVICE_ACCOUNT = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
}
const NEW_KEY = process.env.AES_KEY;
const OLD_KEY = process.env.AES_KEY_OLD;
const restoreIdx = process.argv.indexOf("--restore");
const RESTORE_FILE = restoreIdx >= 0 ? process.argv[restoreIdx + 1] : null;
const APPLY = process.argv.includes("--apply");

for (const [name, v] of [["FIREBASE_SERVICE_ACCOUNT_PATH", process.env.FIREBASE_SERVICE_ACCOUNT]]) {
    if (!v) { console.error(`${name} 환경변수가 필요합니다.`); process.exit(1); }
}
if (!RESTORE_FILE) {
    if (!NEW_KEY || !OLD_KEY) { console.error("AES_KEY(새 키)와 AES_KEY_OLD(옛 키) 환경변수가 모두 필요합니다."); process.exit(1); }
    if (NEW_KEY === OLD_KEY) { console.error("AES_KEY와 AES_KEY_OLD가 같습니다. 새 키를 따로 만들어 AES_KEY에 넣어주세요."); process.exit(1); }
    if (NEW_KEY.length < 32) { console.error("AES_KEY(새 키)가 32자 미만입니다. 더 긴 무작위 값을 쓰세요."); process.exit(1); }
}

const { admin } = require("../lib/firebaseAdmin");
const { decryptDetailed, CIPHER_PREFIX } = require("../lib/aes");

const db = admin.database();

function looksLikeCipher(value) {
    if (typeof value !== "string") return false;
    let clean = value.trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) clean = clean.slice(1, -1);
    return clean.replace(/ /g, "+").startsWith(CIPHER_PREFIX);
}

function* walk(node, path) {
    if (node === null || node === undefined) return;
    if (typeof node === "object") {
        for (const key of Object.keys(node)) yield* walk(node[key], path ? `${path}/${key}` : key);
    } else if (looksLikeCipher(node)) {
        yield { path, value: node };
    }
}

async function scan() {
    const root = (await db.ref("/").once("value")).val() || {};
    const result = { already: [], migrate: [], unresolved: [], multiLayer: 0 };
    const newCipherFor = new Map(); // 옛 암호문 → 새 암호문 (같은 값은 같은 결과로)

    for (const { path, value } of walk(root, "")) {
        const d = decryptDetailed([NEW_KEY, OLD_KEY], value);
        if (!d.ok) { result.unresolved.push(path); continue; }
        const usesOld = d.keyIndexes.some((i) => i === 1);
        if (!usesOld && d.layers === 1) { result.already.push(path); continue; }

        if (d.layers > 1) result.multiLayer++;
        let newCipher = newCipherFor.get(value);
        if (!newCipher) {
            newCipher = CryptoJS.AES.encrypt(d.plain, NEW_KEY).toString();
            const check = decryptDetailed([NEW_KEY], newCipher);
            if (!check.ok || check.plain !== d.plain || check.layers !== 1) {
                throw new Error(`검증 실패(새 키로 암호화한 값을 다시 풀 수 없음): ${path}`);
            }
            newCipherFor.set(value, newCipher);
        }
        result.migrate.push({ path, oldValue: value, newCipher });
    }
    return { root, ...result };
}

function topLevelCounts(paths) {
    const counts = {};
    for (const p of paths) { const top = p.split("/")[0]; counts[top] = (counts[top] || 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(", ") || "없음";
}

async function replaceIfUnchanged(item) {
    const ref = db.ref(item.path);
    const tx = await ref.transaction((cur) => (cur === item.oldValue ? item.newCipher : undefined));
    return tx.committed;
}

async function runInBatches(items, size, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        const chunk = items.slice(i, i + size);
        out.push(...(await Promise.all(chunk.map(fn))));
        process.stdout.write(`\r진행: ${Math.min(i + size, items.length)}/${items.length}`);
    }
    process.stdout.write("\n");
    return out;
}

(async () => {
    // ---------------- 복원 ----------------
    if (RESTORE_FILE) {
        const backup = JSON.parse(fs.readFileSync(RESTORE_FILE, "utf8"));
        const entries = Object.entries(backup.values || {});
        console.log(`백업 파일(${backup.createdAt}): ${entries.length}개 값을 옛 암호문으로 되돌립니다.`);
        const results = await runInBatches(entries, 20, async ([path, oldValue]) => {
            await db.ref(path).set(oldValue);
            return true;
        });
        console.log(`복원 완료: ${results.length}개. (이 상태에서는 Vercel에 옛 키가 AES_KEY_OLD로 남아 있어야 읽힙니다.)`);
        process.exit(0);
    }

    // ---------------- 점검 ----------------
    const s = await scan();
    console.log("==== AES 키 교체 점검 ====");
    console.log(`이미 새 키로 암호화됨: ${s.already.length}개`);
    console.log(`새 키로 다시 암호화할 값: ${s.migrate.length}개 (이 중 이중 암호화 정리 ${s.multiLayer}개)`);
    console.log(`  위치별: ${topLevelCounts(s.migrate.map((m) => m.path))}`);
    console.log(`어느 키로도 안 풀리는 값: ${s.unresolved.length}개${s.unresolved.length ? " → " + s.unresolved.slice(0, 20).join(", ") + (s.unresolved.length > 20 ? " ..." : "") : ""}`);

    if (!APPLY) {
        console.log("\n(미리보기입니다. 아무것도 바꾸지 않았습니다. 적용하려면 --apply)");
        process.exit(0);
    }
    if (!s.migrate.length) { console.log("\n다시 암호화할 값이 없습니다. 이미 교체가 끝난 상태입니다."); process.exit(0); }

    // ---------------- 백업 → 적용 ----------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = `aes-rotation-backup-${stamp}.json`;
    const values = {};
    s.migrate.forEach((m) => { values[m.path] = m.oldValue; });
    fs.writeFileSync(backupFile, JSON.stringify({ createdAt: new Date().toISOString(), values }), { mode: 0o600 });
    console.log(`\n백업 저장: ${backupFile} (옛 암호문 ${s.migrate.length}개 — 되돌릴 때 필요하니 보관하세요)`);

    const committed = await runInBatches(s.migrate, 10, replaceIfUnchanged);
    const skipped = committed.filter((c) => !c).length;
    console.log(`교체 완료: ${committed.length - skipped}개${skipped ? `, 그 사이 값이 바뀌어 건너뜀: ${skipped}개(다시 실행하면 처리됨)` : ""}`);

    // ---------------- 사후 정리/검증 ----------------
    // decrypt API는 students/{uid}/name 과 public_students/{uid}/name 의 암호문이 "같은 문자열"인지로
    // 랭킹 이름을 검증한다. 같은 암호문에서 파생했으니 같아야 하지만, 혹시 다르면 공개용을 원본에 맞춘다.
    const students = (await db.ref("students").once("value")).val() || {};
    const pub = (await db.ref("public_students").once("value")).val() || {};
    const fixes = {};
    for (const uid of Object.keys(pub)) {
        const priv = students[uid] && students[uid].name;
        if (priv && pub[uid] && pub[uid].name !== priv) fixes[`public_students/${uid}/name`] = priv;
    }
    if (Object.keys(fixes).length) { await db.ref().update(fixes); console.log(`공개용 이름 암호문 ${Object.keys(fixes).length}개를 원본과 맞췄습니다.`); }

    const after = await scan();
    console.log("\n==== 적용 후 재점검 ====");
    console.log(`새 키로 암호화됨: ${after.already.length}개 / 아직 옛 키: ${after.migrate.length}개 / 안 풀림: ${after.unresolved.length}개`);
    console.log(after.migrate.length === 0
        ? "✅ 옛 키로 암호화된 값이 하나도 남지 않았습니다. 앱 동작을 확인한 뒤 Vercel에서 AES_KEY_OLD를 삭제하세요."
        : "⚠️ 아직 옛 키로 암호화된 값이 남아 있습니다. 같은 명령을 한 번 더 실행해 주세요(옛 키는 아직 지우지 마세요).");
    process.exit(0);
})().catch((e) => { console.error("오류:", e.message); process.exit(1); });
