const { applyCors } = require("../lib/cors");
const { admin, requireAuth } = require("../lib/firebaseAdmin");

// 🔒 로그인 실패 락아웃을 localStorage가 아니라 서버(Firebase)에 저장한다 —
// localStorage는 브라우저 저장소를 지우거나 다른 브라우저/기기로 바꾸면 그냥
// 풀려버려서, 실제로는 브루트포스를 막지 못하는 장식에 가까웠다. 이 카운터는
// 로그인 시도 전(=아직 인증 토큰이 없는 시점)에도 확인/증가해야 하므로 이
// 엔드포인트 자체는 인증 없이 호출된다("fail"/"check"는 원래 그런 성격의
// 요청). 대신 "reset"(락아웃 해제)만큼은 실제로 로그인에 성공한 사람만 할 수
// 있도록 Firebase ID 토큰으로 검증한다.
//
// ⚠️ 한계: 이 엔드포인트 자체가 공개돼 있어서, 로그인 폼을 거치지 않고 누군가
// 특정 아이디에 대해 "fail"만 계속 호출하면 그 학생을 의도적으로 잠가버리는
// 것도(가벼운 서비스 거부) 가능은 하다. 하지만 이건 "로그인이 잠깐 안 되는"
// 수준의 문제라, "다른 학생의 비밀번호를 무차별 대입으로 알아내는" 문제보다는
// 훨씬 가볍다고 보고 감수한다.
const MAX_BATCH_ID_LEN = 100;

function computeLockoutMs(failCount) {
    if (failCount >= 8) return 10 * 60 * 1000;   // 10분
    if (failCount >= 5) return 2 * 60 * 1000;    // 2분
    if (failCount >= 3) return 30 * 1000;        // 30초
    return 0;
}

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { id, action } = req.body || {};
        if (!id || typeof id !== "string" || id.length > MAX_BATCH_ID_LEN) {
            const err = new Error("`id`가 필요합니다");
            err.statusCode = 400;
            throw err;
        }
        if (!["check", "fail", "reset"].includes(action)) {
            const err = new Error("`action`은 check/fail/reset 중 하나여야 합니다");
            err.statusCode = 400;
            throw err;
        }

        const key = id.trim().toLowerCase();
        const ref = admin.database().ref(`loginLockouts/${encodeURIComponent(key)}`);

        if (action === "check") {
            const snap = await ref.once("value");
            const state = snap.val() || { failCount: 0, lockedUntil: 0 };
            return res.status(200).json(state);
        }

        if (action === "fail") {
            const snap = await ref.once("value");
            const state = snap.val() || { failCount: 0, lockedUntil: 0 };
            state.failCount = (state.failCount || 0) + 1;
            const lockoutMs = computeLockoutMs(state.failCount);
            if (lockoutMs > 0) state.lockedUntil = Date.now() + lockoutMs;
            await ref.set(state);
            return res.status(200).json(state);
        }

        // action === "reset" — 실제로 로그인에 성공한 본인만 자기 계정의 락아웃을 풀 수 있다.
        const decoded = await requireAuth(req);
        const expectedEmail = key.includes("@") ? key : `${key}@kst.com`;
        if ((decoded.email || "").toLowerCase() !== expectedEmail) {
            const err = new Error("본인 계정만 해제할 수 있습니다");
            err.statusCode = 403;
            throw err;
        }
        await ref.remove();
        return res.status(200).json({ ok: true });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: err.message || "Internal error" });
    }
};
