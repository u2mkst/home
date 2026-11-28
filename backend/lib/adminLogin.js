"use strict";
/* 관리자(선생님 공용 계정)·마스터 로그인 — 서버가 비밀번호를 검증한다.
   예전에는 admin.html / master.html 이 Firebase 로그인(signInWithEmailAndPassword)을 직접 불렀다. 그 주소는 공개 웹 키만 있으면
   누구나 서버를 거치지 않고 두드릴 수 있어서, 우리가 잠금·IP 제한을 걸 방법이 없었다(Firebase 자체 제한만 있음).
   이제는 학생 로그인과 같은 구조다:
     - 비밀번호는 `loginSecrets/{uid}`에 scrypt(salt + PIN_PEPPER) 해시로만 저장하고(클라이언트 접근 불가), 이 서버만 검증한다.
     - Firebase 쪽 비밀번호는 아무도 모르는 무작위 값으로 바꿔 둔다 → Firebase 주소를 직접 두드려도 대입할 수 없다.
     - 검증 전에 계정별 잠금 / IP별 한도 / IP별 실패 상한을 서버가 강제하고, 통과하면 Firebase 커스텀 토큰을 발급한다.
   아직 이전되지 않은 계정은 첫 로그인 때 Firebase 비밀번호로 한 번 확인(진실의 원천)한 뒤 해시를 저장하고 무작위 값으로 바꾼다. */
const { admin } = require("./firebaseAdmin");
const { ADMIN_UIDS } = require("./adminUids");
const { hashSecret, verifySecret } = require("./pin");
const { randomAuthPassword } = require("./authPassword");
const { verifyFirebasePassword } = require("./firebaseRest");
const { beginAttempt, getLockout, clearLockout, consumeIpQuota, isIpQuotaExceeded, computeAdminLockoutMs } = require("./guard");

const IP_ADMIN_LIMIT = 30;       // IP당 시간당 관리자 로그인 시도
const IP_ADMIN_FAIL_LIMIT = 10;  // IP당 시간당 "실패"한 관리자 로그인
const IP_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,100}$/;
const DUMMY_SECRET = { salt: "00".repeat(16), hash: "00".repeat(32) };

async function invalid(req, res, lockedUntil) {
    try { await consumeIpQuota(req, "admin-login-fail", IP_ADMIN_FAIL_LIMIT, IP_WINDOW_MS); } catch (e) { /* 세지 못해도 응답은 한다 */ }
    return res.status(401).json({ error: "invalid", lockedUntil: lockedUntil > Date.now() ? lockedUntil : 0 });
}

async function handleAdminLogin(req, res) {
    const body = req.body || {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!EMAIL_RE.test(email) || password.length < 1 || password.length > 128) {
        return res.status(400).json({ error: "bad_request" });
    }

    const quota = await consumeIpQuota(req, "admin-login", IP_ADMIN_LIMIT, IP_WINDOW_MS);
    if (!quota.allowed) {
        res.setHeader("Retry-After", String(Math.ceil(quota.retryAfterMs / 1000)));
        return res.status(429).json({ error: "ip_limited", retryAfterMs: quota.retryAfterMs });
    }
    const failed = await isIpQuotaExceeded(req, "admin-login-fail", IP_ADMIN_FAIL_LIMIT);
    if (failed.exceeded) {
        res.setHeader("Retry-After", String(Math.ceil(failed.retryAfterMs / 1000)));
        return res.status(429).json({ error: "ip_limited", retryAfterMs: failed.retryAfterMs });
    }

    // 잠금 기록은 이메일 기준으로, 학생 아이디와 겹치지 않게 접두어를 붙인다(마스터 화면의 "로그인 잠금"에 그대로 보인다).
    const lockId = `admin:${email}`;
    const lock = await getLockout(lockId);
    if ((lock.lockedUntil || 0) > Date.now()) return res.status(429).json({ error: "locked", lockedUntil: lock.lockedUntil });

    let userRecord = null;
    try { userRecord = await admin.auth().getUserByEmail(email); } catch (e) { userRecord = null; }

    // 관리자·마스터 계정이 아니면 이 경로로 들어올 수 없다(학생은 학생 로그인으로). 응답 시간으로 구분되지 않게 더미 검증을 한다.
    if (!userRecord || !ADMIN_UIDS.has(userRecord.uid)) {
        verifySecret(password, DUMMY_SECRET);
        return invalid(req, res, 0);
    }

    // 비밀번호를 맞춰 보기 전에 시도를 원자적으로 센다(동시에 보낸 요청으로 횟수 제한을 피하지 못하게).
    const attempt = await beginAttempt(lockId, computeAdminLockoutMs);
    if (!attempt.allowed) return res.status(429).json({ error: "locked", lockedUntil: attempt.state.lockedUntil || 0 });

    const uid = userRecord.uid;
    const secretRef = admin.database().ref(`loginSecrets/${uid}`);
    const secret = (await secretRef.once("value")).val();

    let ok = false;
    if (secret && secret.salt && secret.hash) {
        ok = verifySecret(password, secret);
    } else {
        // 아직 이전 안 된 계정: Firebase 비밀번호로 한 번 확인한다. 이 확인은 위의 잠금·IP 제한을 통과한 요청만 도달한다.
        const legacy = await verifyFirebasePassword(email, password);
        if (legacy.throttled) return res.status(429).json({ error: "locked", lockedUntil: Date.now() + 60 * 1000 });
        ok = legacy.ok;
        if (ok) await secretRef.set({ ...hashSecret(password), migratedAt: admin.database.ServerValue.TIMESTAMP });
    }
    if (!ok) return invalid(req, res, attempt.state.lockedUntil || 0);

    // 성공한 뒤에 Firebase 비밀번호를 무작위 값으로 교체한다(실패해도 로그인은 되고, 표시가 없으니 다음 로그인 때 다시 시도).
    if (!(secret && secret.randomized)) {
        try {
            await admin.auth().updateUser(uid, { password: randomAuthPassword() });
            await secretRef.child("randomized").set(true);
        } catch (e) {
            console.error("관리자 Firebase 비밀번호 무작위화 실패:", e.message);
        }
    }

    if (userRecord.disabled) return res.status(403).json({ error: "disabled" });
    await clearLockout(lockId);
    const token = await admin.auth().createCustomToken(uid);
    return res.status(200).json({ token });
}

module.exports = { handleAdminLogin };
