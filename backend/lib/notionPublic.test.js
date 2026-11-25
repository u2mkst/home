/* notionPublic.js / examRanking.js 단위 테스트. 네트워크 없이 가짜 fetch/client로 돈다.
   실행: node backend/lib/notionPublic.test.js
   fixture는 전부 가상의 이름·닉네임·점수다. 응답 모양은 실제 공개 페이지(2026-11 확인)의 형식을 따른다. */
"use strict";
const N = require("./notionPublic");
const { handleExamRanking, resetForTest } = require("./examRanking");
const { setCached } = require("./cache");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } }

const NOW = new Date("2026-11-25T03:00:00Z"); // KST 2026-11-25 12:00

// ---- 공개 페이지 속성 형식 만들기 ------------------------------------------
const txt = (s) => [[String(s)]];
const rel = (id) => [["‣", [["p", id]]]];
const date = (d) => [["‣", [["d", { type: "date", start_date: d }]]]];

// ---- 가짜 공개 노션 ------------------------------------------------------
// exams: [{id,name,grade,date}], scores: { examId: [{nick,total,wrong,real}] }
function makeClient({ exams = [], scores = {}, hideNames = [], dropExamColumn = null, spaceId = "space-1" } = {}) {
    const calls = [];
    const EXAMS_PAGE = "207ddfb9-2ee2-8019-bc0f-eb71b7ce73fe";
    const SCORES_PAGE = "207ddfb9-2ee2-80f4-9a8c-de3a55e905fd";
    const examSchema = { e1: { name: "이름" }, e2: { name: "날짜" }, e3: { name: "학년" }, e4: { name: "평균" } };
    if (dropExamColumn) for (const k of Object.keys(examSchema)) if (examSchema[k].name === dropExamColumn) delete examSchema[k];
    const scoreSchema = { s1: { name: "시험지" }, s2: { name: "학생이름" }, s3: { name: "닉네임" }, s4: { name: "총문항" }, s5: { name: "오답" }, s6: { name: "수강반" } };

    const examBlocks = {};
    for (const e of exams) examBlocks[e.id] = { value: { value: { alive: true, properties: { e1: txt(e.name), e2: e.date ? date(e.date) : undefined, e3: e.grade ? txt(e.grade) : undefined } } } };
    const scoreBlocks = {};
    const studentBlocks = {};
    let n = 0;
    for (const [examId, rows] of Object.entries(scores)) {
        for (const r of rows) {
            const id = "row-" + (n++);
            const sid = "stu-" + (r.real || "none");
            scoreBlocks[id] = { value: { value: { alive: r.alive !== false, properties: { s1: rel(examId), s2: rel(sid), s3: txt(r.nick || ""), s4: txt(r.total), s5: txt(r.wrong), s6: txt("실명반_" + (r.real || "x")) } } } };
            if (r.real && !hideNames.includes(r.real)) studentBlocks[sid] = { value: { value: { properties: { title: txt(r.real) } } } };
        }
    }

    // 시험DB와 성적 페이지를 병렬로 부르므로 컬렉션 id로 구분한다: 페이지마다 다른 컬렉션 id를 돌려준다.
    const post = async (endpoint, body) => {
        calls.push({ endpoint, body });
        if (endpoint === "loadCachedPageChunkV2") {
            const isExams = body.page.id === EXAMS_PAGE;
            const cid = isExams ? "c-exams" : "c-scores";
            return { spaceId, recordMap: { collection: { [cid]: { value: { value: { schema: isExams ? examSchema : scoreSchema } } } }, collection_view: { v1: {} } } };
        }
        if (endpoint === "queryCollection") {
            const isExams = body.collection.id === "c-exams";
            const blocks = isExams ? examBlocks : scoreBlocks;
            return { result: { reducerResults: { collection_group_results: { blockIds: Object.keys(blocks), hasMore: false } } }, recordMap: { block: blocks } };
        }
        if (endpoint === "syncRecordValuesMain") {
            const block = {};
            for (const rq of body.requests) if (studentBlocks[rq.pointer.id]) block[rq.pointer.id] = studentBlocks[rq.pointer.id];
            return { recordMap: { block } };
        }
        throw new Error("unexpected endpoint " + endpoint);
    };
    return { post, calls };
}

(async () => {
    console.log("[공개 페이지 속성 읽기]");
    {
        ok(N.textOf(txt("25")) === "25" && N.textOf(null) === "", "글자");
        ok(N.numberOf(txt(" 1,234 ")) === 1234 && N.numberOf(txt("")) === null && N.numberOf(txt("abc")) === null, "숫자");
        ok(N.relationIds(rel("abc")).join() === "abc" && N.relationIds(undefined).length === 0, "연결 id");
        ok(N.dateOf(date("2026-10-05")) === "2026-10-05" && N.dateOf(txt("x")) === null, "날짜");
        ok(N.textOf([["‣", [["p", "x"]]]]) === "", "연결 표시 글자는 글자로 읽지 않는다");
    }

    console.log("[점수 계산: 맞은 문항 수 · 정답률]");
    {
        const r = N.computeResult(25, 3);
        ok(r.score === 22 && r.total === 25 && r.rate === 88, "25문항 오답 3 → 22점, 88%: " + JSON.stringify(r));
        ok(N.computeResult(22, 0).rate === 100 && N.computeResult(22, 22).score === 0, "만점/0점");
        ok(N.computeResult(23, 1).rate === 95.7, "소수 첫째 자리: " + N.computeResult(23, 1).rate);
        ok(N.computeResult(0, 0) === null && N.computeResult(20, -1) === null && N.computeResult(20, 21) === null && N.computeResult(20, null) === null && N.computeResult(null, 2) === null, "말이 안 되는 값은 건너뜀");
    }

    console.log("[닉네임 정리 / 이름 가리기]");
    {
        ok(N.cleanNickname("  별빛  ") === "별빛", "공백 제거");
        ok(N.cleanNickname("") === null && N.cleanNickname(null) === null && N.cleanNickname("  ") === null, "비면 null");
        ok(N.cleanNickname("가나다라마바사아자차카타파하") === "가나다라마바사아자차카타", "12자 제한");
        ok(N.cleanNickname("a\u0000b\nc") === "abc", "제어문자 제거");
        ok(N.maskName("홍길동") === "홍*동" && N.maskName("남궁민수") === "남**수" && N.maskName("이수") === "이*" && N.maskName("김") === "*", "가리기 규칙");
        ok(N.maskName("홍길동(Gildong)") === "홍*동" && N.maskName(" 홍 길 동 ") === "홍*동", "괄호 영문·공백 처리");
        ok(N.maskName("") === "익명" && N.maskName(null) === "익명", "빈 이름 → 익명");
    }

    console.log("[순위 계산]");
    {
        const e = (nickname, score, total, rate) => ({ nickname, score, total, rate });
        const r = N.buildRanking([e("a", 20, 22, 90.9), e("b", 22, 22, 100), e("c", 20, 22, 90.9), e("d", 15, 22, 68.2)]);
        ok(r.map((x) => x.nickname).join() === "b,a,c,d" && r.map((x) => x.rank).join() === "1,2,2,4", "정답률 내림차순·동점 같은 등수: " + r.map((x) => x.rank).join());
        const many = Array.from({ length: 15 }, (_, i) => e("n" + i, 22 - (i >> 1), 22, 100 - i));
        ok(N.buildRanking(many, 10).length === 10, "상위 10명");
        const tie = [...Array.from({ length: 9 }, (_, i) => e("n" + i, 22, 22, 100 - i)), e("t1", 10, 22, 45.5), e("t2", 10, 22, 45.5), e("t3", 10, 22, 45.5), e("low", 1, 22, 4.5)];
        ok(N.buildRanking(tie, 10).length === 12, "10위에 걸린 동점자는 모두 포함: " + N.buildRanking(tie, 10).length);
    }

    console.log("[학년별 최근 시험 순위: 실제 흐름]");
    {
        const mid2Rows = [
            { nick: "하늘", total: 24, wrong: 0, real: "이실명" },
            { nick: "구름", total: 24, wrong: 3, real: "박실명" },
            { nick: "", total: 24, wrong: 3, real: "최실명" }, // 닉네임 없음 → 가린 이름
            { nick: "바다", total: 24, wrong: 8, real: "정실명" },
            { nick: "별", total: 24, wrong: 12, real: "한실명" },
            { nick: "삭제됨", total: 24, wrong: 0, real: "삭제실명", alive: false },
            { nick: "이상값", total: 24, wrong: 99, real: "이상실명" }, // 오답>총문항 → 제외
        ];
        const client = makeClient({
            exams: [
                { id: "x-mid2-new", name: "중2 기말 (입력 중)", grade: "중2", date: "2026-11-24" },
                { id: "x-mid2", name: "중2-2 중간 가상A", grade: "중2", date: "2026-10-05" },
                { id: "x-mid1", name: "중1-2 중간 가상B", grade: "중1", date: "2026-10-01" },
                { id: "x-future", name: "미래 시험", grade: "중3", date: "2026-12-30" },
                { id: "x-nodate", name: "날짜 없음", grade: "중3", date: null },
                { id: "x-nograde", name: "학년 없음", grade: "", date: "2026-10-01" },
                { id: "x-mid3", name: "중3-2 중간 가상C", grade: "중3", date: "2026-09-20" },
            ],
            scores: {
                "x-mid2-new": [{ nick: "별", total: 24, wrong: 2, real: "김실명" }, { nick: "달", total: 24, wrong: 1, real: "김실명2" }], // 2명뿐 → 건너뜀
                "x-mid2": mid2Rows,
                "x-mid1": [1, 2, 3, 4, 5].map((i) => ({ nick: "a" + i, total: 20, wrong: i, real: "x" + i })),
                "x-mid3": [{ nick: "z1", total: 25, wrong: 0 }, { nick: "z2", total: 25, wrong: 1 }], // 2명뿐 → 제외
                "x-nograde": [1, 2, 3, 4, 5].map((i) => ({ nick: "g" + i, total: 20, wrong: i })),
            },
        });
        const out = await N.getExamRankings(client, N.DEFAULTS, { now: NOW });

        ok(out.grades.map((g) => g.grade).join() === "중1,중2", "점수가 충분한 학년만(중3은 2명뿐 → 제외): " + out.grades.map((g) => g.grade).join());
        const g2 = out.grades.find((g) => g.grade === "중2");
        ok(g2.exam.name === "중2-2 중간 가상A", "입력 중(2명)인 최신 시험은 건너뛰고 그 전 시험: " + g2.exam.name);
        ok(g2.exam.participants === 5, "참여 수는 유효한 행만(삭제·이상값 제외): " + g2.exam.participants);
        ok(g2.ranking.map((r) => r.nickname).join() === "하늘,구름,최*명,바다,별", "닉네임 순위(닉네임 없으면 가린 실명): " + g2.ranking.map((r) => r.nickname).join());
        ok(g2.ranking.map((r) => r.rank).join() === "1,2,2,4,5", "동점 같은 등수: " + g2.ranking.map((r) => r.rank).join());
        const top = g2.ranking[0];
        ok(top.score === 24 && top.total === 24 && top.rate === 100, "점수=맞은 문항 수, 정답률: " + JSON.stringify(top));
        ok(g2.ranking[1].score === 21 && g2.ranking[1].rate === 87.5, "21/24 = 87.5%: " + JSON.stringify(g2.ranking[1]));
        ok(g2.exam.maxRate === 100 && g2.exam.minRate === 50 && g2.exam.avgRate === 78.3, "시험 최고/최저/평균 정답률: " + JSON.stringify(g2.exam));

        const nameCalls = client.calls.filter((c) => c.endpoint === "syncRecordValuesMain");
        ok(nameCalls.length === 1 && nameCalls[0].body.requests.length === 10, "순위에 오른 학생 10명의 이름을 한 번에 조회: " + nameCalls.map((c) => c.body.requests.length).join());
        ok(!/실명|stu-/.test(JSON.stringify(out).replace(/최\*명/g, "")), "응답 어디에도 실명 전체/학생 페이지 id가 없다");
    }

    console.log("[닉네임에 실명이 들어간 경우 가리기]");
    {
        ok(N.leaksRealName("김가상", "김가상"), "닉네임 == 실명");
        ok(N.leaksRealName("김가상짱", "김가상") && N.leaksRealName("★김가상★", "김가상"), "실명을 포함한 닉네임");
        ok(N.leaksRealName("가상이", "김가상"), "이름(성 뺀 두 글자)을 담은 닉네임");
        ok(N.leaksRealName("가상", "김가상") && N.leaksRealName("김가", "김가상"), "실명의 일부(2글자 이상)인 닉네임");
        ok(N.leaksRealName(" 김 가 상 ", "김가상") && N.leaksRealName("GILDONG", "Gildong") && N.leaksRealName("김가상", "김가상(Gasang)"), "공백·대소문자·괄호 표기 무시");
        ok(!N.leaksRealName("하늘", "김가상") && !N.leaksRealName("수학왕", "김가상"), "무관한 닉네임은 그대로");
        ok(!N.leaksRealName("김", "김가상") && !N.leaksRealName("", "김가상") && !N.leaksRealName("하늘", ""), "한 글자·빈 값은 판정하지 않는다");
    }

    console.log("[이름 확인: 실명 닉네임 가림 · 확인 실패 시 안전하게]");
    {
        const rows = [
            { nick: "김실명", total: 20, wrong: 0, real: "김실명" },     // 닉네임 == 실명 → 가림
            { nick: "실명이", total: 20, wrong: 1, real: "박실명" },     // 이름을 담은 닉네임 → 가림
            { nick: "하늘", total: 20, wrong: 2, real: "이실명" },       // 무관 → 닉네임 그대로
            { nick: "", total: 20, wrong: 3, real: "최실명" },           // 닉네임 없음 → 가림
            { nick: "바다", total: 20, wrong: 4, real: "정실명" },       // 무관 → 그대로
            { nick: "별", total: 20, wrong: 5, real: "숨김실명" },        // 이름을 읽을 수 없음 → 닉네임이 있어도 익명
            { nick: "", total: 20, wrong: 6, real: "숨김실명2" },        // 읽을 수 없음 + 닉네임 없음 → 익명
        ];
        const client = makeClient({ exams: [{ id: "x1", name: "중2 시험", grade: "중2", date: "2026-10-05" }], scores: { x1: rows }, hideNames: ["숨김실명", "숨김실명2"] });
        const out = await N.getExamRankings(client, N.DEFAULTS, { now: NOW });
        const rk = out.grades[0].ranking;
        ok(rk.map((r) => r.nickname).join() === "김*명,박*명,하늘,최*명,바다,익명,익명", "실명 닉네임은 가리고 무관한 닉네임은 유지: " + rk.map((r) => r.nickname).join());
        ok(!/김실명|박실명|최실명|이실명|정실명|숨김실명|실명이/.test(JSON.stringify(out)), "응답에 실명 전체나 실명을 담은 닉네임이 없다");
        const lookups = client.calls.filter((c) => c.endpoint === "syncRecordValuesMain");
        ok(lookups.length === 1, "이름 조회는 순위 계산당 한 번(묶음)");
        await N.getExamRankings(client, N.DEFAULTS, { now: NOW });
        ok(client.calls.filter((c) => c.endpoint === "syncRecordValuesMain").length === 2, "실명은 캐시하지 않는다(매번 새로 읽고 버린다)");

        // 이름 조회 요청 자체가 실패하면 순위를 내보내지 않는다(닉네임이 실명인지 확인할 수 없으므로)
        const failing = makeClient({ exams: [{ id: "x3", name: "중1 시험", grade: "중1", date: "2026-10-05" }], scores: { x3: [1, 2, 3, 4, 5].map((i) => ({ nick: "닉" + i, total: 20, wrong: i, real: "학생" + i })) } });
        const realPost = failing.post;
        failing.post = async (ep, body) => { if (ep === "syncRecordValuesMain") throw new Error("boom"); return realPost(ep, body); };
        let err = null;
        try { await N.getExamRankings(failing, N.DEFAULTS, { now: NOW }); } catch (e) { err = e; }
        ok(err && err.code === "name_lookup_failed", "이름 조회 실패 → 순위를 내보내지 않고 오류: " + (err && err.code));
    }

    console.log("[순위 10명: 이름 조회 · 순위 밖 학생은 조회하지 않음]");
    {
        const rows = Array.from({ length: 12 }, (_, i) => ({ nick: i < 9 ? "닉" + i : "", total: 24, wrong: i, real: i < 9 ? "다른" + i : ["가나다", "라마바", "사아자"][i - 9] }));
        const client = makeClient({ exams: [{ id: "x1", name: "중2 시험", grade: "중2", date: "2026-10-05" }], scores: { x1: rows } });
        const out = await N.getExamRankings(client, N.DEFAULTS, { now: NOW });
        const rk = out.grades[0].ranking;
        ok(rk.length === 10 && rk[9].nickname === "가*다", "상위 10명, 10위(닉네임 없음)는 가린 이름: " + rk[9].nickname);
        const req = client.calls.find((c) => c.endpoint === "syncRecordValuesMain").body.requests;
        ok(req.length === 10, "순위에 오른 10명만 이름을 조회(11·12위는 조회하지 않음): " + req.length);
    }

    console.log("[오래된 시험은 순위에서 제외(90일)]");
    {
        const six = (pre) => [1, 2, 3, 4, 5, 6].map((i) => ({ nick: pre + i, total: 20, wrong: i }));
        const client = makeClient({
            exams: [
                { id: "x-old", name: "중3-1 지난 시험(6월)", grade: "중3", date: "2026-06-25" },
                { id: "x-edge", name: "중2 90일 전", grade: "중2", date: "2026-08-27" },
                { id: "x-over", name: "중1 91일 전", grade: "중1", date: "2026-08-26" },
            ],
            scores: { "x-old": six("o"), "x-edge": six("e"), "x-over": six("v") },
        });
        const out = await N.getExamRankings(client, N.DEFAULTS, { now: NOW });
        ok(N.MAX_EXAM_AGE_DAYS === 90, "기본 기준은 90일");
        ok(out.grades.map((g) => g.grade).join() === "중2", "6월 시험(중3)과 91일 전 시험(중1)은 빠지고 정확히 90일 전(중2)은 포함: " + out.grades.map((g) => g.grade).join());
        const wide = await N.getExamRankings(client, N.DEFAULTS, { now: NOW, maxAgeDays: 365 });
        ok(wide.grades.map((g) => g.grade).join() === "중1,중2,중3", "기준을 늘리면 다시 나온다: " + wide.grades.map((g) => g.grade).join());
    }

    console.log("[노션 화면 구조가 바뀐 경우]");
    {
        const client = makeClient({ exams: [{ id: "x", name: "시험", grade: "중1", date: "2026-10-05" }], dropExamColumn: "학년" });
        let err = null;
        try { await N.getExamRankings(client, N.DEFAULTS, { now: NOW }); } catch (e) { err = e; }
        ok(err && err.code === "schema_changed" && /학년/.test(err.message), "필요한 열이 없으면 schema_changed: " + (err && err.message));

        const down = N.createPublicClient({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
        let e2 = null;
        try { await down.post("queryCollection", {}); } catch (e) { e2 = e; }
        ok(e2 && e2.code === "notion_unavailable", "HTTP 오류 → notion_unavailable");

        const net = N.createPublicClient({ fetchImpl: async () => { throw new Error("ECONNRESET"); } });
        let e3 = null;
        try { await net.post("queryCollection", {}); } catch (e) { e3 = e; }
        ok(e3 && e3.code === "notion_unavailable", "네트워크 오류 → notion_unavailable");
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
        const goodClient = () => makeClient({
            exams: [{ id: "x1", name: "중2 시험", grade: "중2", date: "2026-10-05" }],
            scores: { x1: [1, 2, 3, 4, 5].map((i) => ({ nick: "n" + i, total: 20, wrong: i })) },
        });

        resetForTest(); setCached("examRanking", null, 1);
        let res = mkRes();
        let usedClient = false;
        await handleExamRanking({}, res, { rejectIfRateLimited: async (_q, r) => { r.status(429).json({ error: "ip_limited" }); return true; }, createClient: () => { usedClient = true; return goodClient(); } });
        ok(res.statusCode === 429 && !usedClient, "한도 초과 → 노션 호출 없이 429");

        resetForTest(); setCached("examRanking", null, 1);
        res = mkRes();
        let created = 0;
        const deps = { rejectIfRateLimited: async () => false, createClient: () => { created++; return goodClient(); } };
        await handleExamRanking({}, res, deps);
        ok(res.statusCode === 200 && res.body.ok === true && res.body.grades.length === 1, "성공 200: " + res.statusCode);
        ok(/s-maxage=300/.test(res.headers["Cache-Control"] || ""), "엣지 캐시 헤더: " + res.headers["Cache-Control"]);
        const res2 = mkRes();
        await handleExamRanking({}, res2, deps);
        ok(res2.statusCode === 200 && res2.headers["X-KST-Cache"] === "hit" && created === 1, "두 번째는 메모리 캐시(노션 호출 없음)");

        setCached("examRanking", null, 1);
        const res3 = mkRes();
        await handleExamRanking({}, res3, { rejectIfRateLimited: async () => false, createClient: () => N.createPublicClient({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }) });
        ok(res3.statusCode === 200 && res3.body.stale === true && res3.body.grades.length === 1, "노션 장애 → 직전 결과(stale) 유지");

        resetForTest(); setCached("examRanking", null, 1);
        const res4 = mkRes();
        await handleExamRanking({}, res4, { rejectIfRateLimited: async () => false, createClient: () => N.createPublicClient({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }) });
        ok(res4.statusCode === 502 && res4.body.error === "notion_unavailable" && res4.headers["Cache-Control"] === "no-store", "처음부터 실패 → 502, 캐시 안 함");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
