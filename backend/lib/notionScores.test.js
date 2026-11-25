/* notionScores.js / examRanking.js 단위 테스트. 네트워크·노션 토큰 없이 가짜 fetch로 돈다.
   실행: node backend/lib/notionScores.test.js
   fixture는 전부 가상의 이름·닉네임·점수다. 응답 모양은 노션 공식 API(2022-06-28) 문서 형식을 따른다. */
"use strict";
const N = require("./notionScores");
const { handleExamRanking, resetForTest } = require("./examRanking");
const { setCached } = require("./cache");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } }

const t = (s) => [{ plain_text: s }];
const NOW = new Date("2026-11-25T03:00:00Z"); // KST 2026-11-25 12:00

// ---- 가짜 노션 서버 ------------------------------------------------------
function makeFake({ exams = [], scores = {}, inaccessible = [] } = {}) {
    const calls = [];
    const examProps = Object.fromEntries(["이름", "날짜", "학년", "평균", "최고점", "최저점", "분류"].map((n, i) => [n, { id: "e" + i, type: n === "이름" ? "title" : "x" }]));
    const scoreProps = Object.fromEntries(["시험명", "학생이름", "시험지", "닉네임", "점수", "성적", "수강반", "담당"].map((n, i) => [n, { id: "s" + i, type: "x" }]));
    const json = (status, body) => ({ status, ok: status < 400, headers: { get: () => null }, json: async () => body });
    const fetchImpl = async (url, opts) => {
        const u = new URL(url);
        const body = opts.body ? JSON.parse(opts.body) : null;
        calls.push({ method: opts.method, path: u.pathname, query: u.searchParams, body });
        if (u.pathname === "/v1/search") {
            const all = [
                { object: "database", id: "db-exams", title: t("시험DB") },
                { object: "database", id: "db-scores-old", title: t("학생별성적DB") },
                { object: "database", id: "db-scores", title: t("학생별성적DB") },
                { object: "database", id: "db-roster", title: t("원생명부") },
            ];
            return json(200, { results: all.filter((d) => d.title[0].plain_text.includes(body.query)) });
        }
        if (u.pathname === "/v1/databases/db-exams") return json(200, { id: "db-exams", properties: examProps });
        if (u.pathname === "/v1/databases/db-scores-old") return json(200, { id: "db-scores-old", properties: { 시험명: { id: "a", type: "title" } } });
        if (u.pathname === "/v1/databases/db-scores") return json(200, { id: "db-scores", properties: scoreProps });
        if (u.pathname === "/v1/databases/db-exams/query") {
            const lim = body.filter.date.on_or_before;
            const list = exams.filter((e) => e.date && e.date <= lim).sort((a, b) => b.date.localeCompare(a.date));
            return json(200, { results: list.map(examPage), has_more: false });
        }
        if (u.pathname === "/v1/databases/db-scores/query") {
            const rows = scores[body.filter.relation.contains] || [];
            return json(200, { results: rows.map(scorePage), has_more: false });
        }
        if (opts.method === "GET" && u.pathname.startsWith("/v1/pages/student-page-")) {
            const real = decodeURIComponent(u.pathname.split("/student-page-")[1]);
            if (inaccessible.includes(real)) return json(404, { code: "object_not_found" });
            return json(200, { id: "student-page-" + real, properties: { "학생이름(알파벳)": { type: "title", title: t(real) } } });
        }
        return json(404, { code: "object_not_found" });
    };
    return { fetchImpl, calls };
}

const examPage = (e) => ({
    id: e.id, archived: false, properties: {
        이름: { type: "title", title: t(e.name) },
        날짜: { type: "date", date: e.date ? { start: e.date } : null },
        학년: { type: "select", select: e.grade ? { name: e.grade } : null },
        평균: { type: "formula", formula: { type: "number", number: e.avg ?? null } },
        최고점: { type: "formula", formula: { type: "number", number: e.max ?? null } },
        최저점: { type: "formula", formula: { type: "number", number: e.min ?? null } },
        분류: { type: "select", select: { name: "내신" } },
    },
});

// 실제 응답에는 filter_properties 때문에 없겠지만, 혹시 포함돼도 새지 않는지 보려고 실명 속성을 일부러 넣어 둔다.
const scorePage = (r) => ({
    id: "row-" + Math.random(), archived: !!r.archived, properties: {
        닉네임: { type: "rich_text", rich_text: t(r.nick ?? "") },
        점수: { type: "formula", formula: typeof r.formula === "string" ? { type: "string", string: r.formula } : { type: "number", number: r.formula ?? null } },
        성적: { type: "number", number: r.raw ?? null },
        학생이름: { type: "relation", relation: [{ id: "student-page-" + (r.real || "x") }] },
        수강반: { type: "rollup", rollup: { type: "array", array: [{ type: "title", title: t("실명반_" + (r.real || "x")) }] } },
    },
});

(async () => {
    console.log("[닉네임 정리 / 이름 가리기]");
    {
        ok(N.cleanNickname("  별빛  ") === "별빛", "공백 제거");
        ok(N.cleanNickname("") === null && N.cleanNickname(null) === null && N.cleanNickname("   ") === null, "비어 있으면 null(→ 가린 이름 사용)");
        ok(N.cleanNickname("가나다라마바사아자차카타파하") === "가나다라마바사아자차카타", "12자 제한");
        ok(N.cleanNickname("a\u0000b\nc") === "abc", "제어문자 제거");
        ok(N.cleanNickname("<b>x</b>") === "<b>x</b>", "태그는 그대로 두고(화면에서 이스케이프)");
        ok(N.maskName("홍길동") === "홍*동", "3글자: 홍*동");
        ok(N.maskName("남궁민수") === "남**수", "4글자: 남**수");
        ok(N.maskName("이수") === "이*", "2글자: 이*");
        ok(N.maskName("홍길동(Gildong)") === "홍*동", "괄호 영문 표기 제거 후 가림");
        ok(N.maskName(" 홍 길 동 ") === "홍*동", "공백 제거");
        ok(N.maskName("") === "익명" && N.maskName(null) === "익명" && N.maskName("(Only)") === "익명", "빈 이름 → 익명");
        ok(N.maskName("김") === "*", "1글자는 전부 가림");
    }

    console.log("[순위 계산]");
    {
        const e = (nick, score) => ({ nickname: nick, score });
        const r = N.buildRanking([e("a", 90), e("b", 100), e("c", 90), e("d", 70)]);
        ok(r.map((x) => x.nickname).join() === "b,a,c,d", "점수 내림차순: " + r.map((x) => x.nickname).join());
        ok(r.map((x) => x.rank).join() === "1,2,2,4", "동점은 같은 등수(1,2,2,4): " + r.map((x) => x.rank).join());
        const many = Array.from({ length: 15 }, (_, i) => e("n" + i, 100 - i));
        ok(N.buildRanking(many, 10).length === 10, "상위 10명만");
        const tie = [...Array.from({ length: 9 }, (_, i) => e("n" + i, 100 - i)), e("t1", 50), e("t2", 50), e("t3", 50), e("low", 10)];
        ok(N.buildRanking(tie, 10).length === 12, "10위에 걸린 동점자는 모두 포함: " + N.buildRanking(tie, 10).length);
    }

    console.log("[학년별 최근 시험 순위]");
    {
        N.clearDbCache(); N.clearMaskedNameCache();
        const fake = makeFake({
            exams: [
                { id: "x-mid2-new", name: "중2-2 기말 (점수 입력 중)", date: "2026-11-24", grade: "중2", avg: 10, max: 20, min: 1 },
                { id: "x-mid2", name: "중2-2 중간 가상A", date: "2026-10-05", grade: "중2", avg: 70.5, max: 100, min: 40 },
                { id: "x-mid1", name: "중1-2 중간 가상B", date: "2026-10-01", grade: "중1", avg: 60, max: 95, min: 30 },
                { id: "x-future", name: "미래 시험", date: "2026-12-30", grade: "중3" },
                { id: "x-nodate", name: "날짜 없음", date: null, grade: "중3" },
                { id: "x-mid3", name: "중3-2 중간 가상C", date: "2026-09-20", grade: "중3", avg: 80, max: 99, min: 55 },
            ],
            scores: {
                "x-mid2-new": [{ nick: "별", formula: 15, real: "김실명" }], // 1명뿐 → 입력 중으로 보고 건너뜀
                "x-mid2": [
                    { nick: "하늘", formula: 100, real: "이실명" }, { nick: "구름", formula: 90, real: "박실명" },
                    { nick: "", formula: "90점", real: "최실명" }, { nick: "바다", formula: null, raw: 70, real: "정실명" },
                    { nick: "삭제됨", formula: 99, archived: true }, { nick: "점수없음", formula: null, raw: null },
                ],
                "x-mid1": [{ nick: "a", formula: 95 }, { nick: "b", formula: 80 }, { nick: "c", formula: 60 }],
                "x-mid3": [{ nick: "z1", formula: 99 }, { nick: "z2", formula: 88 }],
            },
        });
        const client = N.createNotionClient({ token: "secret_test", fetchImpl: fake.fetchImpl });
        const out = await N.getExamRankings(client, {}, { now: NOW });

        ok(out.grades.map((g) => g.grade).join() === "중1,중2", "점수가 충분한 학년만(중1, 중2; 중3은 2명뿐이라 제외): " + out.grades.map((g) => g.grade).join());
        const g2 = out.grades.find((g) => g.grade === "중2");
        ok(g2.exam.name === "중2-2 중간 가상A", "입력 중인 최신 시험은 건너뛰고 그 전 시험 사용: " + g2.exam.name);
        ok(g2.ranking.map((r) => r.nickname).join() === "하늘,구름,최*명,바다", "닉네임 순위(빈 닉네임은 가린 실명, 삭제된 행·점수 없는 행 제외): " + g2.ranking.map((r) => r.nickname).join());
        ok(g2.ranking.map((r) => r.rank).join() === "1,2,2,4", "동점 등수: " + g2.ranking.map((r) => r.rank).join());
        ok(g2.ranking.find((r) => r.nickname === "바다").score === 70, "점수 수식이 비면 성적 값 사용");
        ok(g2.ranking.find((r) => r.nickname === "최*명").score === 90, "'90점' 문자열 → 90");
        ok(g2.exam.avg === 70.5 && g2.exam.max === 100 && g2.exam.min === 40 && g2.exam.participants === 4, "시험 평균/최고/최저/참여 수");

        const examQuery = fake.calls.find((c) => c.path === "/v1/databases/db-exams/query");
        ok(examQuery.body.filter.date.on_or_before === "2026-11-25", "미래 날짜 시험 제외 조건(KST 오늘)");

        const scoreQueries = fake.calls.filter((c) => c.path === "/v1/databases/db-scores/query");
        ok(scoreQueries.length >= 2, "점수 조회 호출");
        ok(scoreQueries.every((c) => c.query.getAll("filter_properties").join() === "s3,s4,s5,s1"), "닉네임·점수·성적·학생이름(연결 id)만 요청(반/담당 제외): " + scoreQueries[0].query.getAll("filter_properties").join());
        const pageCalls = fake.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/pages/"));
        ok(pageCalls.length === 1, "닉네임이 없는 1명만 이름 조회: " + pageCalls.length);
        ok(pageCalls.every((c) => c.query.getAll("filter_properties").join() === "title"), "원생명부 페이지는 제목 속성만 요청");
        ok(!fake.calls.some((c) => c.path === "/v1/databases/db-scores-old/query" || c.path === "/v1/databases/db-roster/query"), "옛 복사본·원생명부는 조회하지 않는다");

        const text = JSON.stringify(out);
        ok(!/student-page|최실명|이실명|박실명|정실명|김실명/.test(text), "응답 어디에도 실명 전체/학생 페이지 id가 없다");
    }

    console.log("[이름 가리기 세부: 순위 밖 제외 · 캐시 · 읽기 실패]");
    {
        N.clearDbCache(); N.clearMaskedNameCache();
        const many = Array.from({ length: 12 }, (_, i) => ({ nick: i < 9 ? "닉" + i : "", formula: 100 - i, real: i < 9 ? "x" : ["가나다", "라마바", "사아자"][i - 9] }));
        const fake = makeFake({
            exams: [{ id: "x1", name: "중2 시험", date: "2026-10-05", grade: "중2" }],
            scores: { x1: many },
            inaccessible: ["사아자"],
        });
        const client = N.createNotionClient({ token: "t", fetchImpl: fake.fetchImpl });
        const out = await N.getExamRankings(client, {}, { now: NOW });
        const rk = out.grades[0].ranking;
        ok(rk.length === 10, "상위 10명: " + rk.length);
        ok(rk[9].nickname === "가*다", "10위(닉네임 없음)는 가린 이름: " + rk[9].nickname);
        const lookups = fake.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/pages/"));
        ok(lookups.length === 1, "순위 밖(11·12위) 학생의 이름은 읽지 않는다: " + lookups.length);

        const again = await N.getExamRankings(client, {}, { now: NOW });
        ok(again.grades[0].ranking[9].nickname === "가*다", "두 번째 호출 결과 동일");
        ok(fake.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/pages/")).length === 1, "가린 이름은 캐시되어 다시 읽지 않는다");

        // 읽을 수 없는 학생(연동에 공유 안 됨) → 익명, 순위는 정상
        N.clearMaskedNameCache();
        const blocked = Array.from({ length: 3 }, (_, i) => ({ nick: "", formula: 90 - i, real: ["사아자", "가나다", "라마바"][i] }));
        const fake2 = makeFake({ exams: [{ id: "x2", name: "중1 시험", date: "2026-10-05", grade: "중1" }], scores: { x2: blocked }, inaccessible: ["사아자"] });
        N.clearDbCache();
        const out2 = await N.getExamRankings(N.createNotionClient({ token: "t", fetchImpl: fake2.fetchImpl }), {}, { now: NOW });
        ok(out2.grades[0].ranking.map((r) => r.nickname).join() === "익명,가*다,라*바", "읽을 수 없으면 익명, 나머지는 가림: " + out2.grades[0].ranking.map((r) => r.nickname).join());
        ok(!/사아자|가나다|라마바/.test(JSON.stringify(out2)), "응답에 실명 전체 없음");
    }

    console.log("[오류·설정]");
    {
        let threw = null;
        try { N.createNotionClient({ token: "" }); } catch (e) { threw = e; }
        ok(threw && threw.notionCode === "not_configured", "토큰 없으면 not_configured");

        N.clearDbCache();
        const none = N.createNotionClient({ token: "t", fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ results: [] }) }) });
        let e3 = null;
        try { await N.getExamRankings(none, {}, { now: NOW }); } catch (e) { e3 = e; }
        ok(e3 && e3.notionCode === "database_not_found", "DB 미공유 → database_not_found");

        N.clearDbCache();
        let n = 0;
        const flaky = N.createNotionClient({
            token: "t", sleep: async () => {},
            fetchImpl: async () => {
                n++;
                if (n === 1) return { status: 429, ok: false, headers: { get: () => "1" }, json: async () => ({}) };
                return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ results: [] }) };
            },
        });
        const r = await flaky.request("POST", "search", { body: {} });
        ok(Array.isArray(r.results) && n === 2, "429 → 재시도 후 성공");
    }

    console.log("[공개 API 처리: 캐시·한도·오류]");
    {
        const mkRes = () => {
            const res = { headers: {}, statusCode: null, body: null };
            res.setHeader = (k, v) => { res.headers[k] = v; };
            res.status = (c) => { res.statusCode = c; return res; };
            res.json = (b) => { res.body = b; return res; };
            return res;
        };
        const savedToken = process.env.NOTION_TOKEN;

        // 토큰 없음 → 503
        delete process.env.NOTION_TOKEN; resetForTest(); setCached("examRanking", null, 1);
        let res = mkRes();
        await handleExamRanking({}, res, { rejectIfRateLimited: async () => false });
        ok(res.statusCode === 503 && res.body.error === "not_configured" && res.headers["Cache-Control"] === "no-store", "토큰 없음 → 503, 캐시 안 함");

        // IP 한도 초과 → 거기서 멈춘다
        process.env.NOTION_TOKEN = "secret_test"; resetForTest();
        res = mkRes();
        let usedClient = false;
        await handleExamRanking({}, res, { rejectIfRateLimited: async (_q, r) => { r.status(429).json({ error: "ip_limited" }); return true; }, createClient: () => { usedClient = true; } });
        ok(res.statusCode === 429 && !usedClient, "한도 초과 → 노션 호출 없이 429");

        // 성공 → 200 + 엣지 캐시 헤더, 이어서 메모리 캐시 hit
        const fake = makeFake({
            exams: [{ id: "x1", name: "중2 시험", date: "2026-10-05", grade: "중2", avg: 70, max: 100, min: 40 }],
            scores: { x1: [{ nick: "a", formula: 90 }, { nick: "b", formula: 80 }, { nick: "c", formula: 70 }] },
        });
        N.clearDbCache(); resetForTest(); setCached("examRanking", null, 1);
        res = mkRes();
        let calls = 0;
        const deps = { rejectIfRateLimited: async () => false, createClient: (tok) => { calls++; return N.createNotionClient({ token: tok, fetchImpl: fake.fetchImpl }); } };
        await handleExamRanking({}, res, deps);
        ok(res.statusCode === 200 && res.body.ok === true && res.body.grades.length === 1, "성공 200");
        ok(/s-maxage=300/.test(res.headers["Cache-Control"] || ""), "엣지 캐시 헤더: " + res.headers["Cache-Control"]);
        const res2 = mkRes();
        await handleExamRanking({}, res2, deps);
        ok(res2.statusCode === 200 && res2.headers["X-KST-Cache"] === "hit" && calls === 1, "두 번째는 메모리 캐시(노션 호출 없음)");

        // 노션 오류 + 직전 성공 있음 → stale 로 계속 보여 준다
        setCached("examRanking", null, 1); // 캐시 만료 시뮬레이션
        const res3 = mkRes();
        await handleExamRanking({}, res3, { rejectIfRateLimited: async () => false, createClient: () => N.createNotionClient({ token: "t", fetchImpl: async () => ({ status: 500, ok: false, headers: { get: () => null }, json: async () => ({ code: "internal" }) }) }) });
        ok(res3.statusCode === 200 && res3.body.stale === true && res3.body.grades.length === 1, "노션 장애 → 직전 결과(stale) 유지");

        // 직전 성공도 없음 → 502
        resetForTest(); setCached("examRanking", null, 1);
        const res4 = mkRes();
        await handleExamRanking({}, res4, { rejectIfRateLimited: async () => false, createClient: () => N.createNotionClient({ token: "t", fetchImpl: async () => ({ status: 401, ok: false, headers: { get: () => null }, json: async () => ({ code: "unauthorized" }) }) }) });
        ok(res4.statusCode === 502 && res4.body.error === "notion_unavailable", "처음부터 실패 → 502 notion_unavailable");

        if (savedToken === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = savedToken;
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
