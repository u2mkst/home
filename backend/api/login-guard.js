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
const MAX_ID_LEN = 64;
const RECAPTCHA_SCORE_THRESHOLD = 0.5;
const RECAPTCHA_EXPECTED_HOSTNAME = "u2mkst.github.io";

// 같은 계정이 "ufes0603"와 "ufes0603@kst.com" 두 가지 표기로 들어와도 같은 카운터를
// 쓰도록 정규화한다. 예전엔 '@kst.com'이 붙은 표기는 키에 '.'이 남아 Firebase가
// 경로로 인식 못 해 500 에러가 났고, 클라이언트가 그 실패를 "잠금 없음"으로 처리해서
// 아이디 뒤에 @kst.com만 붙이면 락아웃을 통째로 우회할 수 있었다.
function normalizeLoginId(raw) {
    const id = String(raw || "").trim().toLowerCase();
    if (!id || id.length > MAX_ID_LEN || !/^[a-z0-9._@+-]+$/.test(id)) return null;
    return id.endsWith("@kst.com") ? id.slice(0, -"@kst.com".length) : id;
}

// RTDB 키에는 . $ # [ ] / 를 쓸 수 없다 — encodeURIComponent는 '.'만 남기므로 따로 치환.
function lockoutKey(normalizedId) {
    return encodeURIComponent(normalizedId).replace(/\./g, "%2E");
}

function computeLockoutMs(failCount) {
    if (failCount >= 8) return 10 * 60 * 1000;   // 10분
    if (failCount >= 5) return 2 * 60 * 1000;    // 2분
    if (failCount >= 3) return 30 * 1000;        // 30초
    return 0;
}

// reCAPTCHA v3 점수 확인. 토큰이 없거나, 시크릿 키가 아직 설정 안 됐거나, 구글
// 쪽 장애 등으로 판단이 안 서면 null을 반환해 "판단 보류"로 처리한다 — 로그인
// 페이지 로딩이 늦어 토큰이 없는 정상 사용자를 봇으로 오판해 막으면 안 되기
// 때문에, 오직 "점수가 실제로 낮게 나온" 경우만 차단한다.
async function checkRecaptchaScore(token) {
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
        // 다른 사이트/다른 용도로 발급된 토큰을 가져다 쓰는 걸 막는다.
        if (json.hostname && json.hostname !== RECAPTCHA_EXPECTED_HOSTNAME) return 0;
        if (json.action && json.action !== "login") return 0;
        return json.score;
    } catch (e) {
        return null;
    }
}

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { id, action, recaptchaToken } = req.body || {};
        const normalizedId = normalizeLoginId(id);
        if (!normalizedId) {
            const err = new Error("`id` 형식이 올바르지 않습니다");
            err.statusCode = 400;
            throw err;
        }
        if (!["check", "fail", "reset"].includes(action)) {
            const err = new Error("`action`은 check/fail/reset 중 하나여야 합니다");
            err.statusCode = 400;
            throw err;
        }

        const loginEmail = normalizedId.includes("@") ? normalizedId : `${normalizedId}@kst.com`;
        const ref = admin.database().ref(`loginLockouts/${lockoutKey(normalizedId)}`);

        if (action === "check") {
            const snap = await ref.once("value");
            const state = snap.val() || { failCount: 0, lockedUntil: 0 };
            const score = await checkRecaptchaScore(recaptchaToken);
            // score === null(판단 보류)이면 botScoreOk를 true로 둬서 로그인을 막지 않는다.
            state.botScoreOk = score === null ? true : score >= RECAPTCHA_SCORE_THRESHOLD;
            return res.status(200).json(state);
        }

        if (action === "fail") {
            // 존재하지 않는 아이디로 "fail"을 마구 보내 DB에 쓰레기 노드를 쌓는 걸 막는다.
            try {
                await admin.auth().getUserByEmail(loginEmail);
            } catch (e) {
                return res.status(200).json({ failCount: 0, lockedUntil: 0 });
            }
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
        if ((decoded.email || "").toLowerCase() !== loginEmail) {
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
