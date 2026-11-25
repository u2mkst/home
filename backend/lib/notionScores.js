"use strict";
/* 노션 시험 성적 조회.
   - 원생명부(학생 이름) → 학생별성적DB(그 학생의 시험별 점수) → 시험DB(시험 평균/최고/최저) 순서로 읽는다.
   - 학생에게 돌려주는 값은 "본인 점수 + 그 시험의 평균/최고/최저"뿐이다. 다른 학생의 이름·점수는 이 모듈 밖으로 나가지 않는다.
   - 원생명부에는 전화번호 등이 들어 있으므로 제목(이름) 속성만 가져온다(filter_properties).
   - fetch를 주입할 수 있어서 노션 토큰 없이 단위 테스트가 가능하다(notionScores.test.js). */

const NOTION_BASE = "https://api.notion.com/v1/";
const NOTION_VERSION = "2022-06-28";

const DB_TITLES = { roster: "원생명부", scores: "학생별성적DB", exams: "시험DB" };
const REQUIRED_PROPS = {
    roster: [],
    scores: ["시험명", "학생이름", "시험지", "시험 날짜", "성적", "총문항", "오답", "점수"],
    exams: ["이름", "평균", "최고점", "최저점"],
};

const MAX_EXAMS_RETURNED = 20;
const MAX_EXAM_STATS_LOOKUPS = 12;
const EXAM_STATS_CONCURRENCY = 3;

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

// ---------- 이름 매칭 ----------
function normalizeName(s) {
    return String(s == null ? "" : s).normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

// "홍길동(Gildong)" 처럼 괄호가 붙은 제목도 "홍길동"으로 비교할 수 있게 두 가지 형태를 만든다.
function titleVariants(title) {
    const full = normalizeName(title);
    const stripped = normalizeName(String(title == null ? "" : title).replace(/[(\[（].*?[)\]）]/g, ""));
    return stripped && stripped !== full ? [full, stripped] : [full];
}

// 이름이 "정확히 하나"의 원생명부 페이지와 맞을 때만 연결한다. 동명이인/중복은 어느 쪽에도 연결하지 않는다.
function pickStudentPage(pages, name) {
    const target = normalizeName(name);
    if (!target) return { status: "none" };
    const matches = (pages || []).filter((pg) => {
        if (!pg || pg.archived) return false;
        const title = plain(Object.values(pg.properties || {}).find((p) => p && p.type === "title")?.title);
        return titleVariants(title).includes(target);
    });
    if (matches.length === 1) return { status: "ok", pageId: matches[0].id };
    return { status: matches.length === 0 ? "none" : "ambiguous" };
}

// ---------- 데이터베이스 찾기 (제목으로 검색, 한 번 찾으면 재사용) ----------
const dbCache = new Map(); // key -> { id, titlePropName, titlePropId, props, at }
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
        const names = Object.keys(props);
        if (required.every((n) => names.includes(n))) {
            const titleName = names.find((n) => props[n].type === "title");
            const info = { id: db.id, titlePropName: titleName, titlePropId: props[titleName].id, props, at: Date.now() };
            dbCache.set(kind, info);
            return info;
        }
    }
    throw new NotionError(`database not found or not shared: ${wantedTitle}`, { status: 404, code: "database_not_found" });
}

function dbOverridesFromEnv(env = process.env) {
    return { roster: env.NOTION_DB_ROSTER_ID, scores: env.NOTION_DB_SCORES_ID, exams: env.NOTION_DB_EXAMS_ID };
}

// ---------- 학생 찾기 ----------
async function findStudentPage(client, name, overrides) {
    const roster = await resolveDatabase(client, "roster", overrides);
    const res = await client.request("POST", `databases/${roster.id}/query`, {
        body: { filter: { property: roster.titlePropName, title: { contains: String(name).trim() } }, page_size: 25 },
        query: { filter_properties: [roster.titlePropId] }, // 전화번호 등 다른 속성은 가져오지 않는다
    });
    return pickStudentPage(res.results, name);
}

// 관리자 점검용: 원생명부 전체 이름(제목만) 목록
async function listRosterTitles(client, overrides, maxPages = 30) {
    const roster = await resolveDatabase(client, "roster", overrides);
    const titles = [];
    let cursor;
    for (let i = 0; i < maxPages; i++) {
        const res = await client.request("POST", `databases/${roster.id}/query`, {
            body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
            query: { filter_properties: [roster.titlePropId] },
        });
        for (const pg of res.results || []) {
            if (pg.archived) continue;
            const t = plain(Object.values(pg.properties || {}).find((p) => p && p.type === "title")?.title);
            titles.push(t);
        }
        if (!res.has_more) break;
        cursor = res.next_cursor;
    }
    return titles;
}

// ---------- 점수 ----------
function mapScoreRow(page) {
    const p = page.properties || {};
    const examIds = propValue(p["시험지"]) || [];
    const formulaScore = toNumber(propValue(p["점수"]));
    const rawScore = toNumber(propValue(p["성적"]));
    return {
        examId: examIds[0] || null,
        name: propValue(p["시험명"]) || "",
        date: propValue(p["시험 날짜"]) || null,
        score: formulaScore != null ? formulaScore : rawScore,
        rawScore,
        total: toNumber(propValue(p["총문항"])),
        wrong: toNumber(propValue(p["오답"])),
    };
}

function mapExamStats(page) {
    const p = page.properties || {};
    return {
        avg: toNumber(propValue(p["평균"])),
        max: toNumber(propValue(p["최고점"])),
        min: toNumber(propValue(p["최저점"])),
        category: propValue(p["분류"]) || null,
        term: propValue(p["학기"]) || null,
        kind: propValue(p["중간 or 기말"]) || null,
        grade: propValue(p["학년"]) || null,
    };
}

const examStatsCache = new Map();
const EXAM_STATS_CACHE_MS = 10 * 60 * 1000;

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

async function getExamStats(client, examId) {
    const hit = examStatsCache.get(examId);
    if (hit && hit.expires > Date.now()) return hit.value;
    let value = null;
    try {
        value = mapExamStats(await client.request("GET", `pages/${examId}`));
    } catch (e) {
        // 시험 정보가 없거나 공유되지 않았어도 본인 점수는 보여준다
        if (!(e instanceof NotionError) || ![403, 404].includes(e.notionStatus)) throw e;
    }
    examStatsCache.set(examId, { value, expires: Date.now() + EXAM_STATS_CACHE_MS });
    return value;
}

async function fetchStudentScores(client, studentPageId, overrides) {
    const scores = await resolveDatabase(client, "scores", overrides);
    const res = await client.request("POST", `databases/${scores.id}/query`, {
        body: {
            filter: { property: "학생이름", relation: { contains: studentPageId } },
            sorts: [{ property: "시험 날짜", direction: "descending" }],
            page_size: MAX_EXAMS_RETURNED,
        },
    });
    const rows = (res.results || []).filter((pg) => !pg.archived).map(mapScoreRow);

    const uniqueExamIds = [...new Set(rows.map((r) => r.examId).filter(Boolean))].slice(0, MAX_EXAM_STATS_LOOKUPS);
    const statsList = await mapWithConcurrency(uniqueExamIds, EXAM_STATS_CONCURRENCY, (id) => getExamStats(client, id));
    const statsById = new Map(uniqueExamIds.map((id, i) => [id, statsList[i]]));

    return rows.map((r) => {
        const s = (r.examId && statsById.get(r.examId)) || {};
        return {
            name: r.name,
            date: r.date,
            score: r.score,
            total: r.total,
            wrong: r.wrong,
            avg: s.avg ?? null,
            max: s.max ?? null,
            min: s.min ?? null,
            category: s.category ?? null,
            term: s.term ?? null,
            kind: s.kind ?? null,
            grade: s.grade ?? null,
        };
    });
}

module.exports = {
    NotionError,
    createNotionClient,
    propValue,
    toNumber,
    normalizeName,
    titleVariants,
    pickStudentPage,
    resolveDatabase,
    dbOverridesFromEnv,
    findStudentPage,
    listRosterTitles,
    fetchStudentScores,
    mapScoreRow,
    mapExamStats,
    clearDbCache,
};
