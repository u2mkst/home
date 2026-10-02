// 기존 학생 계정을 "서버 PIN 검증" 방식으로 한꺼번에 이전하는 일회성 스크립트.
//
// 각 학생마다:
//   1) students/{uid}/phone(암호화된 PIN)을 복호화
//   2) Firebase REST로 "00"+PIN 이 실제 비밀번호가 맞는지 확인(진실의 원천)
//   3) 맞으면 PIN 해시를 loginSecrets/{uid}에 저장하고 Firebase 비밀번호를 무작위 값으로 교체
//      → 이후 이 계정은 Firebase REST로 PIN을 대입해 뚫을 수 없다.
//   틀리면(저장된 phone과 실제 비밀번호가 다른 계정) 건드리지 않고 목록으로 알려준다.
//   (그런 계정도 첫 로그인 때 서버가 같은 방식으로 이전한다.)
//
// 실행 (backend 폴더에서, 서비스 계정 키 + 서버 환경변수와 같은 AES_KEY/PIN_PEPPER 필요):
//   미리보기:        node scripts/migrate-student-auth.js
//   한 명만 적용:    node scripts/migrate-student-auth.js --apply --only ufes0123
//   전체 적용:       node scripts/migrate-student-auth.js --apply
//   (복구) 한 명 해시 다시 만들기: node scripts/migrate-student-auth.js --apply --only ufes0123 --force
//
// ⚠️ PIN_PEPPER는 Vercel에 넣은 값과 반드시 같아야 한다(다르면 서버가 PIN을 검증하지 못해 이전된
//    학생이 로그인하지 못한다). 그래서 먼저 --only 로 한 명만 이전해 실제 로그인으로 확인한 뒤 전체를 적용한다.

const fs = require("fs");

if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH && !process.env.FIREBASE_SERVICE_ACCOUNT) {
    process.env.FIREBASE_SERVICE_ACCOUNT = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
}
for (const name of ["FIREBASE_SERVICE_ACCOUNT", "AES_KEY", "PIN_PEPPER"]) {
    if (!process.env[name]) {
        console.error(`${name} 환경변수가 필요합니다.`);
        process.exit(1);
    }
}

const { admin } = require("../lib/firebaseAdmin");
const { decryptOne } = require("../lib/aes");
const { hashPin, isValidPin } = require("../lib/pin");
const { randomAuthPassword } = require("../lib/authPassword");
const { ADMIN_UIDS } = require("../lib/adminUids");

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? String(process.argv[onlyIdx + 1] || "").toLowerCase() : null;
if (FORCE && !ONLY) { console.error("--force 는 --only <아이디> 와 함께만 쓸 수 있습니다."); process.exit(1); }
const FIREBASE_WEB_API_KEY = "AIzaSyD-F55blgdfzEygJ9-OUEqw22_EHKOhggg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function passwordWorks(email, pin) {
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: `00${pin}`, returnSecureToken: false }) }
    );
    if (res.ok) return "ok";
    const json = await res.json().catch(() => ({}));
    const message = (json.error && json.error.message) || "";
    return message.startsWith("TOO_MANY_ATTEMPTS") ? "throttled" : "wrong";
}

(async () => {
    const db = admin.database();
    const students = (await db.ref("students").once("value")).val() || {};
    const secrets = (await db.ref("loginSecrets").once("value")).val() || {};

    const stats = { total: 0, alreadyDone: 0, skippedAdmin: 0, migrated: 0, mismatched: [], noPin: [], throttled: [], errors: [] };

    for (const uid of Object.keys(students)) {
        stats.total++;
        if (ADMIN_UIDS.has(uid)) { stats.skippedAdmin++; continue; }
        const s = students[uid] || {};
        if (ONLY && String(s.u2mId || "").toLowerCase() !== ONLY) continue;
        if (secrets[uid] && secrets[uid].randomized && !FORCE) { stats.alreadyDone++; continue; }
        const label = `${s.u2mId || uid}`;
        try {
            const pin = decryptOne(process.env.AES_KEY, s.phone);
            if (!isValidPin(pin)) { stats.noPin.push(label); continue; }

            const user = await admin.auth().getUser(uid);
            if (!FORCE) {
                const result = await passwordWorks(user.email, pin);
                await sleep(300);
                if (result === "throttled") { stats.throttled.push(label); continue; }
                if (result !== "ok") { stats.mismatched.push(label); continue; }
            }

            if (APPLY) {
                // 해시를 먼저 저장(이후 서버가 해시로 로그인시킴) → 그 다음 Firebase 비밀번호를 무작위로 교체.
                // 교체에 실패해도 해시는 남아 로그인은 되고, randomized 표시가 없으니 다음 실행/로그인 때 다시 시도한다.
                await db.ref(`loginSecrets/${uid}`).update({ ...hashPin(pin), migratedAt: admin.database.ServerValue.TIMESTAMP });
                if (!FORCE) {
                    await admin.auth().updateUser(uid, { password: randomAuthPassword() });
                    await db.ref(`loginSecrets/${uid}/randomized`).set(true);
                }
            }
            stats.migrated++;
            console.log(`${APPLY ? "이전 완료" : "이전 가능"}: ${label}`);
        } catch (e) {
            stats.errors.push(`${label}: ${e.message}`);
        }
    }

    console.log("\n==== 결과 (" + (APPLY ? "적용" : "미리보기") + ") ====");
    console.log(`전체 ${stats.total}명 / ${APPLY ? "이전" : "이전 가능"} ${stats.migrated} / 이미 이전됨 ${stats.alreadyDone} / 관리자 제외 ${stats.skippedAdmin}`);
    if (stats.mismatched.length) console.log(`PIN 불일치(첫 로그인 때 서버가 처리) ${stats.mismatched.length}명: ${stats.mismatched.join(", ")}`);
    if (stats.noPin.length) console.log(`PIN 정보 없음/형식 오류 ${stats.noPin.length}명: ${stats.noPin.join(", ")}`);
    if (stats.throttled.length) console.log(`Firebase가 잠시 제한함(나중에 다시 실행) ${stats.throttled.length}명: ${stats.throttled.join(", ")}`);
    if (stats.errors.length) console.log(`오류 ${stats.errors.length}건:\n  ${stats.errors.join("\n  ")}`);
    if (ONLY && stats.total && !stats.migrated && !stats.alreadyDone && !stats.mismatched.length && !stats.errors.length) console.log(`'${ONLY}' 아이디의 학생을 찾지 못했습니다.`);
    if (!APPLY) console.log("\n실제로 적용하려면 --apply 를 붙여 다시 실행하세요.");
    if (APPLY && ONLY) console.log("\n👉 이제 이 학생 계정으로 실제 사이트에서 로그인해 보세요. 로그인이 되면 PIN_PEPPER가 맞는 겁니다. 그때 --only 없이 전체를 적용하세요.");
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
