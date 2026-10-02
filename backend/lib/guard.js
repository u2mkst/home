const crypto = require("crypto");
const { admin } = require("./firebaseAdmin");

const MAX_ID_LEN = 64;
const RECAPTCHA_SCORE_THRESHOLD = 0.5;
const RECAPTCHA_EXPECTED_HOSTNAME = "u2mkst.github.io";

// 같은 계정이 "ufes0603"와 "ufes0603@kst.com" 두 표기로 들어와도 같은 카운터를 쓰도록 정규화.
function normalizeLoginId(raw) {
    const id = String(raw || "").trim().toLowerCase();
    if (!id || id.length > MAX_ID_LEN || !/^[a-z0-9._@+-]+$/.test(id)) return null;
    return id.endsWith("@kst.com") ? id.slice(0, -"@kst.com".length) : id;
}

function toLoginEmail(normalizedId) {
    return normalizedId.includes("@") ? normalizedId : `${normalizedId}@kst.com`;
}

// RTDB 키에는 . $ # [ ] / 를 쓸 수 없다 — encodeURIComponent는 '.'만 남기므로 따로 치환.
function dbKey(value) {
    return encodeURIComponent(value).replace(/\./g, "%2E");
}

function getClientIp(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return forwarded || String(req.headers["x-real-ip"] || "") || "unknown";
}

function hashIp(ip) {
    return crypto.createHash("sha256").update(`ip:${ip}`).digest("hex").slice(0, 24);
}

// ---- reCAPTCHA v3 -------------------------------------------------------
// 판단 보류(토큰 없음/구글 장애)는 null. 오직 "점수가 실제로 낮게 나온 경우"만 차단 대상.
async function checkRecaptchaScore(token, expectedAction) {
    if (!token || !process.env.RECAPTCHA_V3_SECRET_KEY) return null;
    try {
        const params = new URLSearchParams({
            secret: process.env.RECAPTCHA_V3_SECRET_KEY,
            response: token,
        });
        const verifyRes = await fetch("https://www.google.com/recaptcha/api/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
        });
        const json = await verifyRes.json();
        if (!json.success || typeof json.score !== "number") return null;
        if (json.hostname && json.hostname !== RECAPTCHA_EXPECTED_HOSTNAME) return 0;
        if (json.action && json.action !== expectedAction) return 0;
        return json.score;
    } catch (e) {
        return null;
    }
}

async function isBotSuspected(token, expectedAction) {
    const score = await checkRecaptchaScore(token, expectedAction);
    return score !== null && score < RECAPTCHA_SCORE_THRESHOLD;
}

// ---- 계정별 로그인 실패 락아웃 (서버 저장) --------------------------------
function computeLockoutMs(failCount) {
    if (failCount >= 50) return 24 * 60 * 60 * 1000;
    if (failCount >= 20) return 60 * 60 * 1000;
    if (failCount >= 8) return 10 * 60 * 1000;
    if (failCount >= 5) return 2 * 60 * 1000;
    if (failCount >= 3) return 30 * 1000;
    return 0;
}

const FAIL_MEMORY_MS = 24 * 60 * 60 * 1000; // 마지막 실패 후 하루가 지나면 카운터 초기화

function lockoutRef(normalizedId) {
    return admin.database().ref(`loginLockouts/${dbKey(normalizedId)}`);
}

async function getLockout(normalizedId) {
    const snap = await lockoutRef(normalizedId).once("value");
    const state = snap.val() || { failCount: 0, lockedUntil: 0 };
    if (state.lastFailAt && Date.now() - state.lastFailAt > FAIL_MEMORY_MS) {
        return { failCount: 0, lockedUntil: 0 };
    }
    return state;
}

async function registerFailure(normalizedId) {
    const state = await getLockout(normalizedId);
    state.failCount = (state.failCount || 0) + 1;
    state.lastFailAt = Date.now();
    const lockoutMs = computeLockoutMs(state.failCount);
    if (lockoutMs > 0) state.lockedUntil = Date.now() + lockoutMs;
    await lockoutRef(normalizedId).set(state);
    return state;
}

async function clearLockout(normalizedId) {
    await lockoutRef(normalizedId).remove();
}

// ---- IP별 요청 제한 (고정 윈도우) -----------------------------------------
// 여러 계정에 돌아가며 흔한 PIN을 찔러보는 공격과 가입 남발을 막는다. 학원 와이파이처럼
// 한 IP를 여러 학생이 같이 쓰는 환경이라 한도는 넉넉하게 잡는다.
async function consumeIpQuota(req, bucket, maxPerWindow, windowMs) {
    const ref = admin.database().ref(`rateLimits/${dbKey(bucket)}/${hashIp(getClientIp(req))}`);
    const now = Date.now();
    const result = await ref.transaction((current) => {
        if (!current || current.resetAt <= now) return { count: 1, resetAt: now + windowMs };
        return { count: current.count + 1, resetAt: current.resetAt };
    });
    const value = result.snapshot.val() || { count: 1, resetAt: now + windowMs };
    return {
        allowed: value.count <= maxPerWindow,
        retryAfterMs: Math.max(0, value.resetAt - now),
    };
}

module.exports = {
    normalizeLoginId,
    toLoginEmail,
    dbKey,
    getClientIp,
    checkRecaptchaScore,
    isBotSuspected,
    getLockout,
    registerFailure,
    clearLockout,
    consumeIpQuota,
};
