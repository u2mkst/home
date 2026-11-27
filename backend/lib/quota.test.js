"use strict";
// 요청 제한 계산·계정별 제한 단위 테스트 (node backend/lib/quota.test.js — Firebase 없이 실행)
const path = require("path");
// guard.js가 불러오는 firebaseAdmin을 가짜로 대체(테스트에서는 실제 DB를 쓰지 않는다)
const fakePath = require.resolve("./firebaseAdmin.js");
require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports: { admin: {}, requireAuth: async () => ({}) } };
const { nextQuotaState, evaluateQuota } = require("./quota");
const guard = require("./guard");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log("  ✗ FAIL: " + m); } };
const res = () => { const r = { headers: {}, code: 200, body: null, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

console.log("[윈도우 계산]");
const W = 60000;
let st = nextQuotaState(null, 1000, W);
ok(st.count === 1 && st.resetAt === 61000, "처음 요청은 1회, 윈도우 시작");
st = nextQuotaState(st, 2000, W);
ok(st.count === 2 && st.resetAt === 61000, "같은 윈도우 안에서는 횟수만 늘고 끝나는 시각은 그대로");
ok(nextQuotaState(st, 61000, W).count === 1 && nextQuotaState(st, 61000, W).resetAt === 121000, "윈도우가 끝난 순간 새로 시작");
ok(nextQuotaState({ count: "x", resetAt: 99999 }, 1000, W).count === 1, "깨진 기록(숫자가 아님)은 안전하게 처리");
ok(nextQuotaState({ count: 5 }, 1000, W).count === 1, "끝나는 시각이 없는 기록은 새로 시작");
const e1 = evaluateQuota({ count: 60, resetAt: 61000 }, 60, 2000);
const e2 = evaluateQuota({ count: 61, resetAt: 61000 }, 60, 2000);
ok(e1.allowed && !e2.allowed && e2.retryAfterMs === 59000, "한도 이하는 허용, 초과는 거절 + 남은 시간");

(async () => {
    console.log("[계정별 제한]");
    const calls = [];
    const mk = (allowed) => async (bucket, key, max, win) => { calls.push({ bucket, key, max, win }); return { allowed, retryAfterMs: 4200 }; };
    let r = res();
    ok((await guard.rejectIfUserRateLimited(r, "stu1", "encrypt", 60, 60000, { consumeQuota: mk(true) })) === false && r.code === 200, "한도 안이면 통과");
    ok(calls[0].bucket === "user-encrypt" && calls[0].max === 60 && calls[0].win === 60000, "버킷/한도 전달: " + JSON.stringify(calls[0]));
    ok(/^[0-9a-f]{24}$/.test(calls[0].key) && !calls[0].key.includes("stu1"), "UID는 해시해서 키로 사용(원본 UID를 키에 노출하지 않음)");
    r = res();
    ok((await guard.rejectIfUserRateLimited(r, "stu1", "encrypt", 60, 60000, { consumeQuota: mk(false) })) === true && r.code === 429 && r.body.error === "user_limited" && r.headers["Retry-After"] === "5", "초과하면 429 + Retry-After(올림): " + JSON.stringify(r.body) + r.headers["Retry-After"]);
    const n = calls.length;
    r = res();
    ok((await guard.rejectIfUserRateLimited(r, "9temrm7WfSXRKo5v5jJiz65t8yF2", "decrypt", 1, 1, { consumeQuota: mk(false) })) === false && calls.length === n, "관리자 계정은 제한하지 않고 DB도 건드리지 않음");
    ok((await guard.rejectIfUserRateLimited(res(), "OUcTOJNMDVXaMwouAqUluSvd2nH2", "decrypt", 1, 1, { consumeQuota: mk(false) })) === false, "마스터 계정도 제한하지 않음");
    ok((await guard.rejectIfUserRateLimited(res(), "", "encrypt", 1, 1, { consumeQuota: mk(false) })) === false, "UID가 없으면 건드리지 않음(인증 단계에서 이미 걸러짐)");
    r = res();
    ok((await guard.rejectIfUserRateLimited(r, "stu1", "encrypt", 60, 60000, { consumeQuota: async () => { throw new Error("db down"); } })) === false && r.code === 200, "DB 오류면 막지 않음(fail-open)");
    const k1 = (calls.length = 0, await guard.rejectIfUserRateLimited(res(), "stuA", "x", 1, 1, { consumeQuota: mk(true) }), calls[0].key);
    const k2 = (calls.length = 0, await guard.rejectIfUserRateLimited(res(), "stuB", "x", 1, 1, { consumeQuota: mk(true) }), calls[0].key);
    ok(k1 !== k2, "계정마다 다른 키(한 학생의 연타가 다른 학생을 막지 않음)");

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
