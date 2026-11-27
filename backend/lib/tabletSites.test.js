"use strict";
// 태블릿 허용 사이트 검사·저장·공개 조회 단위 테스트 (노드만 있으면 실행: node backend/lib/tabletSites.test.js)
const T = require("./tabletSites");
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; } else { failed++; console.log("  ✗ FAIL: " + m); } };

console.log("[항목 정리]");
ok(T.sanitizeHost("https://WWW.Example.com/path?x=1") === "example.com", "주소 → 호스트(www·대소문자·경로 제거)");
ok(T.sanitizeHost("student.mathflat.com:8080") === "student.mathflat.com", "포트 제거");
ok(T.sanitizeHost("co.kr") === null && T.sanitizeHost("github.io") === null && T.sanitizeHost("vercel.app") === null, "공용 도메인은 거부");
ok(T.sanitizeHost("javascript:alert(1)") === null && T.sanitizeHost("localhost") === null && T.sanitizeHost("a b.com") === null && T.sanitizeHost("") === null && T.sanitizeHost(null) === null, "이상한 값 거부");
ok(T.sanitizeHost("공격자.com") === null, "한글 도메인은 거부(퓨니코드로 입력)");

console.log("[목록 정리]");
const r = T.sanitizeList(["u2math.co.kr", "https://U2MATH.co.kr/x", "co.kr", "  ", "naver.com"]);
ok(r.hosts[0] === T.CORE_HOST, "우리 사이트가 항상 맨 앞");
ok(r.hosts.join() === `${T.CORE_HOST},u2math.co.kr,naver.com`, "중복 제거: " + r.hosts.join());
ok(r.rejected.join() === "co.kr", "거부된 항목 목록(빈 줄은 무시): " + r.rejected.join());
ok(T.sanitizeList(null).hosts.join() === T.CORE_HOST && T.sanitizeList("x").hosts.length === 1, "배열이 아니면 우리 사이트만");

// ---- 가짜 DB ----
function fakeDb(initial) {
    let data = initial;
    return { ref: (p) => ({ once: async () => ({ val: () => (p === "config/tabletSites" ? data : null) }), set: async (v) => { data = v; } }), get data() { return data; } };
}
function fakeRes() {
    const r = { headers: {}, code: 200, body: null, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
    return r;
}

(async () => {
    console.log("[저장·읽기]");
    const empty = fakeDb(null);
    const d = await T.readSites(empty);
    ok(d.isDefault && d.hosts.join() === T.DEFAULT_HOSTS.join(), "저장된 게 없으면 기본 목록");
    const w = await T.writeSites(empty, ["u2math.co.kr", "mathflat.com", "naver.com"], "uid1");
    ok(w.hosts.join() === `${T.CORE_HOST},u2math.co.kr,mathflat.com,naver.com` && empty.data.updatedBy === "uid1", "저장하면 정리된 목록과 수정한 사람이 기록됨");
    ok((await T.readSites(empty)).hosts.includes("naver.com"), "다시 읽으면 저장한 목록");
    let err = null;
    try { await T.writeSites(empty, ["naver.com", "co.kr", "나쁜 주소"], "u"); } catch (e) { err = e; }
    ok(err && err.statusCode === 400 && err.rejected.join() === "co.kr,나쁜 주소", "쓸 수 없는 항목이 있으면 저장 안 하고 목록을 알려 줌: " + (err && err.rejected));
    ok((await T.readSites(empty)).hosts.includes("naver.com") && !(await T.readSites(empty)).hosts.includes("co.kr"), "실패한 저장은 기존 목록을 건드리지 않음");
    err = null;
    try { await T.writeSites(empty, Array.from({ length: 60 }, (_, i) => `site${i}.com`), "u"); } catch (e) { err = e; }
    ok(err && err.message === "too_many", "50개 초과 거부");

    console.log("[공개 조회 처리]");
    T.resetForTest();
    const db = fakeDb({ hosts: ["u2math.co.kr", "bad host", "co.kr"], updatedAt: 123 });
    let rl = 0;
    const deps = { db, rejectIfRateLimited: async () => { rl++; return false; } };
    let res = fakeRes();
    await T.handleTabletSites({}, res, deps);
    ok(res.code === 200 && res.body.ok && res.body.hosts.join() === `${T.CORE_HOST},u2math.co.kr` && res.body.updatedAt === 123, "저장된 값 중 쓸 수 있는 것만 응답: " + JSON.stringify(res.body));
    ok(/s-maxage=60/.test(res.headers["Cache-Control"]), "엣지 캐시 헤더");
    ok(!JSON.stringify(res.body).includes("updatedBy"), "수정한 사람(UID)은 공개 응답에 넣지 않음");
    res = fakeRes();
    await T.handleTabletSites({}, res, deps);
    ok(res.code === 200 && rl === 1, "두 번째는 서버 캐시 + 속도 제한 소모 없음: " + rl);
    T.resetForTest();
    const bad = { ref: () => ({ once: async () => { throw new Error("boom"); } }) };
    res = fakeRes();
    const origErr = console.error; console.error = () => {};
    await T.handleTabletSites({}, res, { db: bad, rejectIfRateLimited: async () => false });
    console.error = origErr;
    ok(res.code === 502 && res.body.error === "unavailable" && res.headers["Cache-Control"] === "no-store", "읽기 실패 → 502, 캐시하지 않음");
    T.resetForTest();
    res = fakeRes();
    await T.handleTabletSites({}, res, { db, rejectIfRateLimited: async (q, r) => { r.status(429).json({ error: "rate_limited" }); return true; } });
    ok(res.code === 429, "속도 제한에 걸리면 그대로 429");

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
