"use strict";
/* 노션 시험 순위 조회 (로그인 화면 대시보드용 공개 데이터).
   - 시험DB에서 "학년별 가장 최근 시험"을 고르고, 학생별성적DB에서 그 시험의 점수를 읽어 순위를 만든다.
   - 학생 실명은 읽지도 돌려주지도 않는다. 학생별성적DB의 '닉네임'과 점수만 쓰고, 요청할 때도
     닉네임/점수/성적 속성만 가져온다(filter_properties). 학생이름·수강반·담당 같은 속성은 이 서버를 거치지 않는다.
   - fetch를 주입할 수 있어서 노션 토큰 없이 단위 테스트가 가능하다(notionScores.test.js). */

const NOTION_BASE = "https://api.notion.com/v1/";
const NOTION_VERSION = "2022-06-28";

const DB_TITLES = { scores: "학생별성적DB", exams: "시험DB" };
const REQUIRED_PROPS = {
    scores: ["시험지", "닉네임", "점수", "성적"],
    exams: ["이름", "날짜", "학년", "평균", "최고점", "최저점"],
};

const GRADE_ORDER = ["중1", "중2", "중3", "고1", "고2", "고3"];
const ANONYMOUS_NICKNAME = "익명";
const MAX_NICKNAME_LENGTH = 12;
const TOP_N = 10;
const MIN_PARTICIPANTS = 3; // 점수가 이보다 적게 입력된 시험은 아직 입력 중인 것으로 보고 건너뛴다
const MAX_EXAMS_TRIED_PER_GRADE = 4;
const SCORE_PAGE_LIMIT = 3; // 한 시험당 100명씩 최대 3쪽

class NotionError extends Error {
    constructor(message, { status = 502, code = "notion_error" } = {}) {
        super(message);
        this.name = "NotionError";
        this.notionStatus = status;
        this.notionCode = code;
    }
}

function createNotionClient({ token, fetchImpl, sleep } = {}) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (!token) throw new NotionError("NOTION_TOKEN is not set", { status: 503, code: "not_configured" });

    async function request(method, path, { body, query } = {}) {
        const url = new URL(NOTION_BASE + path.replace(/^\//, ""));
        for (const [k, values] of Object.entries(query || {})) {
            for (const v of [].concat(values)) url.searchParams.append(k, v);
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await doFetch(url.toString(), {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Notion-Version": NOTION_VERSION,
                    "Content-Type": "application/json",
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            if (res.status === 429 && attempt < 2) {
                const retryAfter = Number(res.headers && res.headers.get && res.headers.get("retry-after")) || 1;
                await wait(Math.min(retryAfter, 2) * 1000);
                continue;
            }
            let json = {};
            try { json = await res.json(); } catch (e) { /* 본문 없음 */ }
            if (!res.ok) {
                throw new NotionError(`Notion ${res.status} ${json.code || ""}`.trim(), { status: res.status, code: json.code || "notion_error" });
            }
            return json;
        }
        throw new NotionError("Notion rate limited", { status: 429, code: "rate_limited" });
    }
    return { request };
}

// ---------- 속성 값 꺼내기 ----------
function plain(arr) {
    return (arr || []).map((x) => (x && x.plain_text) || "").join("");
}

function propValue(p) {
    if (!p) return null;
    switch (p.type) {
        case "title": return plain(p.title);
        case "rich_text": return plain(p.rich_text);
        case "number": return p.number;
        case "select": return p.select ? p.select.name : null;
        case "date": return p.date ? p.date.start : null;
        case "checkbox": return p.checkbox;
        case "relation": return (p.relation || []).map((r) => r.id);
        case "formula": {
            const f = p.formula || {};
            if (f.type === "number") return f.number;
            if (f.type === "string") return f.string;
            if (f.type === "boolean") return f.boolean;
            if (f.type === "date") return f.date ? f.date.start : null;
            return null;
        }
        case "rollup": {
            const r = p.rollup || {};
            if (r.type === "number") return r.number;
            if (r.type === "date") return r.date ? r.date.start : null;
            return null;
        }
        default: return null;
    }
}

// 점수 수식이 숫자 대신 "85점" 같은 문자열을 줄 수도 있어서 앞쪽 숫자만 읽는다.
function toNumber(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const m = v.trim().match(/^-?\d+(\.\d+)?/);
        if (m) return Number(m[0]);
    }
    return null;
}

function normalizeName(s) {
    return String(s == null ? "" : s).normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

// 닉네임은 공개 화면에 그대로 나가므로 제어문자를 지우고 길이를 제한한다. 비어 있으면 '익명'.
function cleanNickname(raw) {
    const s = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NICKNAME_LENGTH).trim();
    return s || ANONYMOUS_NICKNAME;
}

// ---------- 데이터베이스 찾기 (제목으로 검색, 한 번 찾으면 재사용) ----------
const dbCache = new Map();
const DB_CACHE_MS = 60 * 60 * 1000;

function clearDbCache() { dbCache.clear(); }

async function resolveDatabase(client, kind, overrides = {}) {
    const cached = dbCache.get(kind);
    if (cached && Date.now() - cached.at < DB_CACHE_MS) return cached;

    const wantedTitle = DB_TITLES[kind];
    const required = REQUIRED_PROPS[kind];
    const candidateIds = [];
    if (overrides[kind]) {
        candidateIds.push(overrides[kind]);
    } else {
        const search = await client.request("POST", "search", {
            body: { query: wantedTitle, filter: { property: "object", value: "database" }, page_size: 20 },
        });
        for (const r of search.results || []) {
            if (r.object === "database" && normalizeName(plain(r.title)) === normalizeName(wantedTitle)) candidateIds.push(r.id);
        }
    }
    for (const id of candidateIds) {
        const db = await client.request("GET", `databases/${id}`);
        const props = db.properties || {};
        if (required.every((n) => Object.prototype.hasOwnProperty.call(props, n))) {
            const info = { id: db.id, props, at: Date.now() };
            dbCache.set(kind, info);
            return info;
        }
    }
    throw new NotionError(`database not found or not shared: ${wantedTitle}`, { status: 404, code: "database_not_found" });
}

function dbOverridesFromEnv(env = process.env) {
    return { scores: env.NOTION_DB_SCORES_ID, exams: env.NOTION_DB_EXAMS_ID };
}

// ---------- 시험 / 순위 ----------
function mapExam(page) {
    const p = page.properties || {};
    return {
        id: page.id,
        name: propValue(p["이름"]) || "",
        date: propValue(p["날짜"]) || null,
        grade: propValue(p["학년"]) || null,
        avg: toNumber(propValue(p["평균"])),
        max: toNumber(propValue(p["최고점"])),
        min: toNumber(propValue(p["최저점"])),
        category: propValue(p["분류"]) || null,
    };
}

// 지금(KST) 기준 오늘 날짜 yyyy-mm-dd. 아직 치르지 않은(미래 날짜) 시험은 순위에서 뺀다.
function kstToday(now = new Date()) {
    return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 점수 내림차순, 동점은 같은 등수(1,2,2,4). 컷오프 등수에 걸린 동점자는 모두 포함한다.
function buildRanking(entries, topN = TOP_N) {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    const ranked = sorted.map((e) => ({ ...e, rank: 1 + sorted.filter((o) => o.score > e.score).length }));
    if (ranked.length <= topN) return ranked;
    const cutoffRank = ranked[topN - 1].rank;
    return ranked.filter((e) => e.rank <= cutoffRank);
}

async function fetchExamScoreEntries(client, scoresDb, examId) {
    const filterProps = ["닉네임", "점수", "성적"].map((n) => scoresDb.props[n].id);
    const entries = [];
    let cursor;
    for (let i = 0; i < SCORE_PAGE_LIMIT; i++) {
        const res = await client.request("POST", `databases/${scoresDb.id}/query`, {
            body: {
                filter: { property: "시험지", relation: { contains: examId } },
                page_size: 100,
                ...(cursor ? { start_cursor: cursor } : {}),
            },
            query: { filter_properties: filterProps }, // 학생이름·수강반·담당 등은 가져오지 않는다
        });
        for (const pg of res.results || []) {
            if (pg.archived) continue;
            const p = pg.properties || {};
            const formula = toNumber(propValue(p["점수"]));
            const score = formula != null ? formula : toNumber(propValue(p["성적"]));
            if (score == null) continue;
            entries.push({ nickname: cleanNickname(propValue(p["닉네임"])), score });
        }
        if (!res.has_more) break;
        cursor = res.next_cursor;
    }
    return entries;
}

function gradeSortKey(g) {
    const i = GRADE_ORDER.indexOf(g);
    return i === -1 ? GRADE_ORDER.length : i;
}

// 학년별로 "가장 최근에 치른 시험 중 점수가 충분히 입력된 것"의 순위를 만든다.
async function getExamRankings(client, overrides, { now = new Date(), topN = TOP_N } = {}) {
    const [examsDb, scoresDb] = await Promise.all([
        resolveDatabase(client, "exams", overrides),
        resolveDatabase(client, "scores", overrides),
    ]);

    const res = await client.request("POST", `databases/${examsDb.id}/query`, {
        body: {
            filter: { property: "날짜", date: { on_or_before: kstToday(now) } },
            sorts: [{ property: "날짜", direction: "descending" }],
            page_size: 50,
        },
    });
    const byGrade = new Map();
    for (const pg of res.results || []) {
        if (pg.archived) continue;
        const exam = mapExam(pg);
        if (!exam.grade || !exam.name) continue;
        if (!byGrade.has(exam.grade)) byGrade.set(exam.grade, []);
        byGrade.get(exam.grade).push(exam);
    }

    const grades = [];
    for (const grade of [...byGrade.keys()].sort((a, b) => gradeSortKey(a) - gradeSortKey(b) || a.localeCompare(b, "ko"))) {
        for (const exam of byGrade.get(grade).slice(0, MAX_EXAMS_TRIED_PER_GRADE)) {
            const entries = await fetchExamScoreEntries(client, scoresDb, exam.id);
            if (entries.length < MIN_PARTICIPANTS) continue;
            grades.push({
                grade,
                exam: { name: exam.name, date: exam.date, avg: exam.avg, max: exam.max, min: exam.min, participants: entries.length },
                ranking: buildRanking(entries, topN).map((e) => ({ rank: e.rank, nickname: e.nickname, score: e.score })),
            });
            break;
        }
    }
    return { updatedAt: now.getTime(), grades };
}

module.exports = {
    NotionError,
    createNotionClient,
    propValue,
    toNumber,
    normalizeName,
    cleanNickname,
    resolveDatabase,
    dbOverridesFromEnv,
    mapExam,
    kstToday,
    buildRanking,
    getExamRankings,
    clearDbCache,
};
