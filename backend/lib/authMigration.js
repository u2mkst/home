"use strict";
/* 옛 학생 계정(Firebase 비밀번호가 "00"+PIN 그대로인 계정)을 서버 PIN 검증 방식으로 이전한다.
   이전하지 않은 계정은 Firebase 로그인 주소를 직접 두드리는 무차별 대입에 노출된다(우리 서버의 잠금·IP 제한을 거치지 않음).
   마스터 화면의 "옛 계정 보호" 버튼(api/admin.js)과 scripts/migrate-student-auth.js 가 같이 쓴다. */
const { admin } = require("./firebaseAdmin");
const { ADMIN_UIDS } = require("./adminUids");
const { decryptOne, getDecryptKeys } = require("./aes");
const { hashPin, isValidPin } = require("./pin");
const { randomAuthPassword } = require("./authPassword");
const { verifyFirebasePassword } = require("./firebaseRest");

// 아직 이전되지 않은 학생 uid 목록 (loginSecrets/{uid}/randomized 가 true가 아닌 학생).
async function listPending(db = admin.database()) {
    const students = (await db.ref("students").once("value")).val() || {};
    const secrets = (await db.ref("loginSecrets").once("value")).val() || {};
    const pending = [];
    let total = 0, done = 0;
    for (const uid of Object.keys(students)) {
        if (ADMIN_UIDS.has(uid)) continue;
        total++;
        if (secrets[uid] && secrets[uid].randomized) { done++; continue; }
        pending.push({ uid, label: String((students[uid] || {}).u2mId || uid), student: students[uid] || {} });
    }
    return { total, done, pending };
}

/* 한 명을 이전한다. 결과 status:
   migrated(이전 완료) / mismatch(저장된 PIN으로는 로그인이 안 됨 — 첫 로그인 때 서버가 처리) / no_pin / throttled(Firebase가 잠시 제한) / error
   apply=false 면 확인만 하고 아무것도 바꾸지 않는다. */
async function migrateOne({ uid, student, apply = true, force = false, verify = verifyFirebasePassword, db = admin.database(), authApi = admin.auth() }) {
    try {
        const pin = decryptOne(getDecryptKeys(), student.phone);
        if (!isValidPin(pin)) return { status: "no_pin" };
        const user = await authApi.getUser(uid);
        if (!force) {
            const r = await verify(user.email, `00${pin}`);
            if (r.throttled) return { status: "throttled" };
            if (!r.ok) return { status: "mismatch" };
        }
        if (apply) {
            // 해시를 먼저 저장(이후 서버가 해시로 로그인시킴) → 그 다음 Firebase 비밀번호를 무작위로 교체.
            // 교체에 실패해도 해시는 남아 로그인은 되고, randomized 표시가 없으니 다음에 다시 시도한다.
            await db.ref(`loginSecrets/${uid}`).update({ ...hashPin(pin), migratedAt: admin.database.ServerValue.TIMESTAMP });
            if (!force) {
                await authApi.updateUser(uid, { password: randomAuthPassword() });
                await db.ref(`loginSecrets/${uid}/randomized`).set(true);
            }
        }
        return { status: "migrated" };
    } catch (e) {
        return { status: "error", message: e.message };
    }
}

module.exports = { listPending, migrateOne };
