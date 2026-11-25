/* notionScores.js 단위 테스트. 네트워크·노션 토큰 없이 가짜 fetch로 돈다.
   실행: node backend/lib/notionScores.test.js
   fixture는 전부 가상의 이름·점수다. 응답 모양은 노션 공식 API(2022-06-28) 문서 형식을 따른다. */
"use strict";
const assert = require("assert");
const N = require("./notionScores");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } }

const t = (s) => [{ plain_text: s }];
const titlePage = (id, name, extra = {}) => ({ id, archived: false, properties: { "학생이름(알파벳)": { id: "title", type: "title", title: t(name) }, ...extra } });

// ---- 가짜 노션 서버 ------------------------------------------------------
function makeFake({ roster = [], scoreRows = [], exams = {}, failExam = null } = {}) {
    const calls = [];
    const rosterProps = { "학생이름(알파벳)": { id: "title", type: "title" }, "학생 전화번호": { id: "pH", type: "phone_number" } };
    const scoreProps = Object.fromEntries(["시험명", "학생이름", "시험지", "시험 날짜", "성적", "총문항", "오답", "점수"].map((n, i) => [n, { id: "s" + i, type: n === "시험명" ? "title" : "x" }]));
    const examProps = Object.fromEntries(["이름", "평균", "최고점", "최저점"].map((n, i) => [n, { id: "e" + i, type: n === "이름" ? "title" : "x" }]));
    const json = (status, body) => ({ status, ok: status < 400, headers: { get: () => null }, json: async () => body });
    const fetchImpl = async (url, opts) => {
        const u = new URL(url);
        const body = opts.body ? JSON.parse(opts.body) : null;
        calls.push({ method: opts.method, path: u.pathname, query: u.searchParams, body, auth: opts.headers.Authorization, version: opts.headers["Notion-Version"] });
        if (u.pathname === "/v1/search") {
            const q = body.query;
            const all = [
                { object: "database", id: "db-roster", title: t("원생명부") },
                { object: "database", id: "db-scores-old", title: t("학생별성적DB") }, // 속성이 다른 옛 복사본
                { object: "database", id: "db-scores", title: t("학생별성적DB") },
                { object: "database", id: "db-exams", title: t("시험DB") },
                { object: "database", id: "db-plan", title: t("계획표") },
            ];
            return json(200, { results: all.filter((d) => d.title[0].plain_text.includes(q)) });
        }
        if (opts.method === "GET" && u.pathname === "/v1/databases/db-roster") return json(200, { id: "db-roster", properties: rosterProps });
        if (opts.method === "GET" && u.pathname === "/v1/databases/db-scores-old") return json(200, { id: "db-scores-old", properties: { 시험명: { id: "a", type: "title" } } });
        if (opts.method === "GET" && u.pathname === "/v1/databases/db-scores") return json(200, { id: "db-scores", properties: scoreProps });
        if (opts.method === "GET" && u.pathname === "/v1/databases/db-exams") return json(200, { id: "db-exams", properties: examProps });
        if (u.pathname === "/v1/databases/db-roster/query") {
            const needle = body.filter && body.filter.title ? body.filter.title.contains.toLowerCase() : "";
            const found = roster.filter((pg) => pg.properties["학생이름(알파벳)"].title[0].plain_text.toLowerCase().includes(needle));
            return json(200, { results: found, has_more: false });
        }
        if (u.pathname === "/v1/databases/db-scores/query") {
            const wanted = body.filter.relation.contains;
            return json(200, { results: scoreRows.filter((r) => r._student === wanted), has_more: false });
        }
        if (opts.method === "GET" && u.pathname.startsWith("/v1/pages/")) {
            const id = u.pathname.split("/").pop();
            if (failExam === id) return json(404, { code: "object_not_found" });
            return exams[id] ? json(200, exams[id]) : json(404, { code: "object_not_found" });
        }
        return json(404, { code: "object_not_found" });
    };
    return { fetchImpl, calls };
}

const scoreRow = (student, { name, date, raw, formula, total, wrong, exam }) => ({
    _student: student, id: "row-" + name, archived: false,
    properties: {
        시험명: { type: "title", title: t(name) },
        학생이름: { type: "relation", relation: [{ id: student }] },
        시험지: { type: "relation", relation: exam ? [{ id: exam }] : [] },
        "시험 날짜": { type: "date", date: date ? { start: date } : null },
        성적: { type: "number", number: raw },
        총문항: { type: "number", number: total },
        오답: { type: "number", number: wrong },
        점수: { type: "formula", formula: typeof formula === "string" ? { type: "string", string: formula } : { type: "number", number: formula } },
    },
});
const examPage = (avg, max, min, extra = {}) => ({
    id: "x", properties: {
        평균: { type: "formula", formula: { type: "number", number: avg } },
        최고점: { type: "formula", formula: { type: "number", number: max } },
        최저점: { type: "formula", formula: { type: "number", number: min } },
        분류: { type: "select", select: { name: extra.category || "내신" } },
        학기: { type: "select", select: { name: "2학기" } },
        "중간 or 기말": { type: "select", select: { name: "기말" } },
        학년: { type: "select", select: { name: "중2" } },
    },
});

(async () => {
    console.log("[이름 매칭 규칙]");
    {
        const pages = [titlePage("p1", "김가상"), titlePage("p2", "이가상(Lee)"), titlePage("p3", "박가상"), titlePage("p4", "박가상")];
        ok(N.pickStudentPage(pages, "김가상").pageId === "p1", "정확히 일치");
        ok(N.pickStudentPage(pages, " 김 가상 ").pageId === "p1", "공백 무시");
        ok(N.pickStudentPage(pages, "이가상").pageId === "p2", "괄호 꼬리표 제거 후 일치");
        ok(N.pickStudentPage(pages, "박가상").status === "ambiguous", "동명이인은 ambiguous");
        ok(N.pickStudentPage(pages, "최가상").status === "none", "없으면 none");
        ok(N.pickStudentPage(pages, "").status === "none", "빈 이름은 none");
        ok(N.pickStudentPage([{ ...titlePage("p9", "정가상"), archived: true }], "정가상").status === "none", "보관된 페이지는 제외");
        ok(N.pickStudentPage(pages, "김가").status === "none", "부분 일치로는 연결하지 않는다");
        ok(N.pickStudentPage([titlePage("a", "김가상(정)")], "김가상").pageId === "a", "괄호 안 글자는 무시");
    }

    console.log("[점수 값 변환]");
    {
        ok(N.toNumber("85점") === 85, "'85점' → 85");
        ok(N.toNumber(" 72.5") === 72.5, "소수");
        ok(N.toNumber("없음") === null, "숫자 아님 → null");
        ok(N.toNumber(NaN) === null, "NaN → null");
        ok(N.propValue({ type: "formula", formula: { type: "boolean", boolean: true } }) === true, "formula boolean");
        ok(N.propValue(null) === null, "null 속성");
    }

    console.log("[전체 흐름: 학생 → 점수 → 시험 통계]");
    {
        N.clearDbCache();
        const fake = makeFake({
            roster: [titlePage("stu-1", "김가상", { "학생 전화번호": { id: "pH", type: "phone_number", phone_number: "010-0000-0000" } }), titlePage("stu-2", "이가상")],
            scoreRows: [
                scoreRow("stu-1", { name: "2학기 기말 가상A", date: "2026-11-20", raw: 18, formula: 90, total: 20, wrong: 2, exam: "ex-1" }),
                scoreRow("stu-1", { name: "2학기 중간 가상B", date: "2026-10-05", raw: 15, formula: "75점", total: 20, wrong: 5, exam: "ex-2" }),
                scoreRow("stu-2", { name: "남의 시험", date: "2026-11-21", raw: 20, formula: 100, total: 20, wrong: 0, exam: "ex-1" }),
            ],
            exams: { "ex-1": examPage(80.5, 100, 50), "ex-2": examPage(70, 95, 40, { category: "모의" }) },
        });
        const client = N.createNotionClient({ token: "secret_test", fetchImpl: fake.fetchImpl });

        const found = await N.findStudentPage(client, "김가상");
        ok(found.status === "ok" && found.pageId === "stu-1", "김가상 → stu-1");

        const rosterQuery = fake.calls.find((c) => c.path === "/v1/databases/db-roster/query");
        ok(rosterQuery.query.getAll("filter_properties").join() === "title", "원생명부는 제목 속성만 요청한다(전화번호 제외)");
        ok(rosterQuery.auth === "Bearer secret_test" && rosterQuery.version === "2022-06-28", "인증/버전 헤더");
        ok(fake.calls.filter((c) => c.path === "/v1/search").length >= 1, "제목으로 DB 검색");

        const items = await N.fetchStudentScores(client, "stu-1");
        ok(items.length === 2, "본인 행 2개만: " + items.length);
        ok(!JSON.stringify(items).includes("남의 시험"), "다른 학생 행은 포함되지 않는다");
        ok(items[0].name === "2학기 기말 가상A" && items[0].score === 90 && items[0].wrong === 2 && items[0].total === 20, "첫 행 값");
        ok(items[0].avg === 80.5 && items[0].max === 100 && items[0].min === 50, "시험 평균/최고/최저");
        ok(items[1].score === 75, "문자열 점수 '75점' → 75");
        ok(items[1].category === "모의", "분류");

        const scoreDbPicked = fake.calls.some((c) => c.path === "/v1/databases/db-scores/query");
        ok(scoreDbPicked, "필수 속성이 있는 DB(옛 복사본 제외)에서 조회");
        ok(!fake.calls.some((c) => c.path === "/v1/databases/db-scores-old/query"), "속성이 다른 옛 DB는 쓰지 않는다");
    }

    console.log("[시험 정보를 못 읽어도 본인 점수는 나온다]");
    {
        N.clearDbCache();
        const fake = makeFake({ scoreRows: [scoreRow("stu-9", { name: "시험X", date: "2026-09-01", raw: 10, formula: 50, total: 20, wrong: 10, exam: "ex-missing" })], exams: {} });
        const client = N.createNotionClient({ token: "t", fetchImpl: fake.fetchImpl });
        const items = await N.fetchStudentScores(client, "stu-9");
        ok(items.length === 1 && items[0].score === 50 && items[0].avg === null, "통계는 null, 점수는 유지");
    }

    console.log("[오류 처리]");
    {
        let threw = null;
        try { N.createNotionClient({ token: "" }); } catch (e) { threw = e; }
        ok(threw && threw.notionCode === "not_configured", "토큰 없으면 not_configured");

        N.clearDbCache();
        const client = N.createNotionClient({ token: "t", fetchImpl: async () => ({ status: 401, ok: false, headers: { get: () => null }, json: async () => ({ code: "unauthorized" }) }) });
        let e2 = null;
        try { await N.findStudentPage(client, "김가상"); } catch (e) { e2 = e; }
        ok(e2 && e2.notionStatus === 401 && e2.notionCode === "unauthorized", "401 전달");

        // 429 후 재시도
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

        // 필요한 DB가 공유되지 않은 경우
        N.clearDbCache();
        const none = N.createNotionClient({ token: "t", fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ results: [] }) }) });
        let e3 = null;
        try { await N.resolveDatabase(none, "scores"); } catch (e) { e3 = e; }
        ok(e3 && e3.notionCode === "database_not_found", "DB 미공유 → database_not_found");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
