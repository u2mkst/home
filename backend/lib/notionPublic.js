"use strict";
/* 노션 "웹에 공개" 페이지에서 시험 순위를 만든다 (로그인 화면 대시보드용 공개 데이터).
   ※ 노션의 공식 API가 아니라 공개 페이지가 화면을 그릴 때 쓰는 내부 주소(loadCachedPageChunkV2 / queryCollection /
     syncRecordValuesMain)를 읽는다. 토큰은 필요 없지만 노션이 바꾸면 깨질 수 있고, 페이지가 계속 "웹에 공개"여야 한다.
     그래서 ①필요한 열이 없으면 바로 schema_changed 로 실패하고(잘못된 값을 내보내지 않는다), ②상위 코드(examRanking.js)가
     직전 성공 결과를 계속 보여 주며, ③결과를 서버·엣지에 오래 캐시한다.
   - 점수는 노션의 수식 열이라 공개 데이터에 값이 없다. 그래서 점수 = 총문항 − 오답(맞은 문항 수),
     정답률 = 맞은 수 ÷ 총문항 으로 우리가 계산한다. 순위는 정답률 기준.
   - 화면에는 닉네임과 점수만 나간다. 닉네임이 비어 있는 학생이 순위(상위 10명)에 든 경우에만 학생 페이지 제목(이름)을 읽어
     서버에서 "홍*동"처럼 가린 값으로 바꾼다 — 실명 전체는 응답·캐시·로그에 남지 않는다.
   - fetch를 주입할 수 있어서 네트워크 없이 단위 테스트가 가능하다(notionPublic.test.js). */

const DEFAULTS = {
    host: "cool-sailboat-c27.notion.site",
    scoresPageId: "207ddfb92ee280f49a8cde3a55e905fd", // 학생별성적
    examsPageId: "207ddfb92ee28019bc0feb71b7ce73fe", // 시험DB
};

const REQUIRED_SCORE_PROPS = ["시험지", "학생이름", "닉네임", "총문항", "오답"];
const REQUIRED_EXAM_PROPS = ["이름", "날짜", "학년"];

const GRADE_ORDER = ["중1", "중2", "중3", "고1", "고2", "고3"];
const ANONYMOUS_NICKNAME = "익명";
const MAX_NICKNAME_LENGTH = 12;
const TOP_N = 10;
const MIN_PARTICIPANTS = 5; // 이보다 적게 입력된 시험은 아직 입력 중이거나 일부만 본 시험으로 보고 건너뛴다
const MAX_ROWS = 20000;
const REQUEST_TIMEOUT_MS = 25000;
const NAME_LOOKUP_MAX = 50;

class PublicNotionError extends Error {
    constructor(message, code = "notion_unavailable") {
        super(message);
        this.name = "PublicNotionError";
        this.code = code;
    }
}

function configFromEnv(env = process.env) {
    return {
        host: env.NOTION_PUBLIC_HOST || DEFAULTS.host,
        scoresPageId: env.NOTION_PUBLIC_SCORES_PAGE_ID || DEFAULTS.scoresPageId,
        examsPageId: env.NOTION_PUBLIC_EXAMS_PAGE_ID || DEFAULTS.examsPageId,
    };
}

// ---------- 공개 페이지 내부 주소 호출 ----------
function createPublicClient({ host = DEFAULTS.host, fetchImpl } = {}) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    async function post(endpoint, body) {
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
        try {
            const res = await doFetch(`https://${host}/api/v3/${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: ctrl ? ctrl.signal : undefined,
            });
            if (!res.ok) throw new PublicNotionError(`Notion public ${endpoint} ${res.status}`);
            return await res.json();
        } catch (e) {
            if (e instanceof PublicNotionError) throw e;
            throw new PublicNotionError(`Notion public ${endpoint} failed: ${e && e.name === "AbortError" ? "timeout" : "network"}`);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    return { post };
}

function uuid(hex) {
    const h = String(hex).replace(/-/g, "");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function blockValue(b) {
    if (!b) return null;
    const v = b.value && b.value.value ? b.value.value : b.value;
    return v || null;
}

// ---------- 속성 값 꺼내기 (공개 페이지 형식: [["글자"], ["‣", [["p", id]]], ["‣", [["d", {start_date}]]] ...]) ----------
function textOf(prop) {
    if (!Array.isArray(prop)) return "";
    return prop.map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" && seg[0] !== "‣" ? seg[0] : "")).join("");
}

function numberOf(prop) {
    const s = textOf(prop).trim().replace(/,/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function relationIds(prop) {
    const out = [];
    if (!Array.isArray(prop)) return out;
    for (const seg of prop) {
        if (!Array.isArray(seg) || !Array.isArray(seg[1])) continue;
        for (const ann of seg[1]) {
            if (Array.isArray(ann) && ann[0] === "p" && typeof ann[1] === "string") out.push(ann[1]);
        }
    }
    return out;
}

function dateOf(prop) {
    if (!Array.isArray(prop)) return null;
    for (const seg of prop) {
        if (!Array.isArray(seg) || !Array.isArray(seg[1])) continue;
        for (const ann of seg[1]) {
            if (Array.isArray(ann) && ann[0] === "d" && ann[1] && ann[1].start_date) return String(ann[1].start_date);
        }
    }
    return null;
}

// ---------- 닉네임 / 이름 가리기 ----------
// 닉네임은 공개 화면에 그대로 나가므로 제어문자를 지우고 길이를 제한한다. 비어 있으면 null(→ 가린 이름 사용).
function cleanNickname(raw) {
    const s = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NICKNAME_LENGTH).trim();
    return s || null;
}

// 실명을 "홍*동"처럼 가린다: 앞뒤 한 글자만 남기고 가운데를 *로(2글자는 "이*"). 이름 뒤 괄호(영문 표기 등)는 먼저 지운다.
function maskName(raw) {
    const s = String(raw == null ? "" : raw).normalize("NFC").replace(/[(\[（].*?[)\]）]/g, "").replace(/\s+/g, "");
    const chars = Array.from(s);
    if (chars.length === 0) return ANONYMOUS_NICKNAME;
    if (chars.length === 1) return "*";
    if (chars.length === 2) return chars[0] + "*";
    return chars[0] + "*".repeat(chars.length - 2) + chars[chars.length - 1];
}

// ---------- 데이터베이스(페이지) 읽기 ----------
async function loadDatabase(client, pageHexId, requiredProps, label) {
    const page = await client.post("loadCachedPageChunkV2", {
        page: { id: uuid(pageHexId) }, limit: 100, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false,
    });
    const rm = page && page.recordMap;
    const collections = rm && rm.collection ? Object.entries(rm.collection) : [];
    const views = rm && rm.collection_view ? Object.keys(rm.collection_view) : [];
    if (!collections.length || !views.length) throw new PublicNotionError(`${label}: no database on page`, "schema_changed");
    const [collectionId, rec] = collections[0];
    const schema = (blockValue(rec) || {}).schema || {};
    const keys = {};
    for (const [k, def] of Object.entries(schema)) keys[def.name] = k;
    for (const name of requiredProps) {
        if (!keys[name]) throw new PublicNotionError(`${label}: missing column "${name}"`, "schema_changed");
    }
    const q = await client.post("queryCollection", {
        collection: { id: collectionId, spaceId: page.spaceId },
        collectionView: { id: views[0], spaceId: page.spaceId },
        loader: { type: "reducer", reducers: { collection_group_results: { type: "results", limit: MAX_ROWS } }, searchQuery: "", userTimeZone: "Asia/Seoul" },
    });
    const result = q && q.result && q.result.reducerResults && q.result.reducerResults.collection_group_results;
    if (!result || !Array.isArray(result.blockIds)) throw new PublicNotionError(`${label}: unexpected query response`, "schema_changed");
    const blocks = (q.recordMap && q.recordMap.block) || {};
    const rows = [];
    for (const id of result.blockIds) {
        const v = blockValue(blocks[id]);
        if (!v || v.alive === false || !v.properties) continue;
        rows.push({ id, props: v.properties });
    }
    return { keys, rows, spaceId: page.spaceId, truncated: result.hasMore === true };
}

function kstToday(now = new Date()) {
    return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 점수 = 맞은 문항 수(총문항 − 오답), 정답률(%) = 맞은 수 ÷ 총문항 (소수 첫째 자리). 말이 안 되는 값은 건너뛴다.
function computeResult(total, wrong) {
    if (!(total > 0) || wrong == null || wrong < 0 || wrong > total) return null;
    const correct = total - wrong;
    return { score: correct, total, rate: Math.round((correct / total) * 1000) / 10 };
}

// 정답률 내림차순, 동점은 같은 등수(1,2,2,4). 컷오프 등수에 걸린 동점자는 모두 포함한다.
function buildRanking(entries, topN = TOP_N) {
    const sorted = [...entries].sort((a, b) => b.rate - a.rate || b.score - a.score);
    const ranked = sorted.map((e) => ({ ...e, rank: 1 + sorted.filter((o) => o.rate > e.rate).length }));
    if (ranked.length <= topN) return ranked;
    const cutoffRank = ranked[topN - 1].rank;
    return ranked.filter((e) => e.rank <= cutoffRank);
}

function gradeSortKey(g) {
    const i = GRADE_ORDER.indexOf(g);
    return i === -1 ? GRADE_ORDER.length : i;
}

// ---------- 가린 이름 (학생 페이지 제목) ----------
const maskedNameCache = new Map(); // 학생 페이지 id → { value(가린 이름), expires }
const MASKED_NAME_CACHE_MS = 60 * 60 * 1000;

function clearMaskedNameCache() { maskedNameCache.clear(); }

// 닉네임이 없는 학생들의 가린 이름. 학생 페이지의 "제목"만 읽고 바로 가린다. 가린 값만 캐시하고 실명은 어디에도 남기지 않는다.
// 읽지 못하면 '익명'(일시 오류일 수 있어 캐시하지 않는다).
async function maskedNamesFor(client, spaceId, pageIds) {
    const out = new Map();
    const need = [];
    for (const id of new Set(pageIds.filter(Boolean))) {
        const hit = maskedNameCache.get(id);
        if (hit && hit.expires > Date.now()) out.set(id, hit.value); else need.push(id);
    }
    if (need.length) {
        try {
            const res = await client.post("syncRecordValuesMain", {
                requests: need.slice(0, NAME_LOOKUP_MAX).map((id) => ({ pointer: { table: "block", id, spaceId }, version: -1 })),
            });
            const blocks = (res && res.recordMap && res.recordMap.block) || {};
            for (const id of need) {
                const v = blockValue(blocks[id]);
                const title = v && v.properties ? textOf(v.properties.title) : "";
                if (title.trim()) {
                    const value = maskName(title);
                    maskedNameCache.set(id, { value, expires: Date.now() + MASKED_NAME_CACHE_MS });
                    out.set(id, value);
                }
            }
        } catch (e) {
            // 이름을 못 읽어도 순위는 보여 준다(해당 학생만 익명)
        }
    }
    return out;
}

// ---------- 학년별 최근 시험 순위 ----------
async function getExamRankings(client, config = DEFAULTS, { now = new Date(), topN = TOP_N, minParticipants = MIN_PARTICIPANTS } = {}) {
    const [examsDb, scoresDb] = await Promise.all([
        loadDatabase(client, config.examsPageId, REQUIRED_EXAM_PROPS, "시험DB"),
        loadDatabase(client, config.scoresPageId, REQUIRED_SCORE_PROPS, "학생별성적"),
    ]);
    if (scoresDb.truncated) console.error("exam ranking: score rows truncated at", MAX_ROWS);

    const today = kstToday(now);
    const exams = new Map();
    for (const r of examsDb.rows) {
        const grade = textOf(r.props[examsDb.keys["학년"]]).trim();
        const name = textOf(r.props[examsDb.keys["이름"]]).trim();
        const date = dateOf(r.props[examsDb.keys["날짜"]]);
        if (!grade || !name || !date || date > today) continue; // 학년/날짜가 없거나 아직 치르지 않은 시험은 제외
        exams.set(r.id, { id: r.id, grade, name, date });
    }

    const byExam = new Map();
    for (const r of scoresDb.rows) {
        const examId = relationIds(r.props[scoresDb.keys["시험지"]])[0];
        if (!examId || !exams.has(examId)) continue;
        const result = computeResult(numberOf(r.props[scoresDb.keys["총문항"]]), numberOf(r.props[scoresDb.keys["오답"]]));
        if (!result) continue;
        if (!byExam.has(examId)) byExam.set(examId, []);
        byExam.get(examId).push({
            nickname: cleanNickname(textOf(r.props[scoresDb.keys["닉네임"]])),
            studentPageId: relationIds(r.props[scoresDb.keys["학생이름"]])[0] || null,
            ...result,
        });
    }

    const byGrade = new Map();
    for (const exam of exams.values()) {
        if (!byGrade.has(exam.grade)) byGrade.set(exam.grade, []);
        byGrade.get(exam.grade).push(exam);
    }

    const picked = [];
    for (const grade of [...byGrade.keys()].sort((a, b) => gradeSortKey(a) - gradeSortKey(b) || a.localeCompare(b, "ko"))) {
        const candidates = byGrade.get(grade).sort((a, b) => b.date.localeCompare(a.date));
        const exam = candidates.find((e) => (byExam.get(e.id) || []).length >= minParticipants);
        if (exam) picked.push({ grade, exam, entries: byExam.get(exam.id) });
    }

    // 순위에 오른 학생 중 닉네임이 없는 사람만 가린 이름을 채운다(순위 밖 학생의 이름은 읽지 않는다).
    const rankings = picked.map((p) => ({ ...p, ranked: buildRanking(p.entries, topN) }));
    const needNames = rankings.flatMap((p) => p.ranked.filter((e) => !e.nickname).map((e) => e.studentPageId));
    const masked = await maskedNamesFor(client, scoresDb.spaceId, needNames);

    const grades = rankings.map(({ grade, exam, entries, ranked }) => {
        const rates = entries.map((e) => e.rate);
        return {
            grade,
            exam: {
                name: exam.name,
                date: exam.date,
                participants: entries.length,
                avgRate: Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10,
                maxRate: Math.max(...rates),
                minRate: Math.min(...rates),
            },
            ranking: ranked.map((e) => ({
                rank: e.rank,
                nickname: e.nickname || masked.get(e.studentPageId) || ANONYMOUS_NICKNAME,
                score: e.score,
                total: e.total,
                rate: e.rate,
            })),
        };
    });
    return { updatedAt: now.getTime(), grades };
}

module.exports = {
    PublicNotionError,
    DEFAULTS,
    configFromEnv,
    createPublicClient,
    textOf,
    numberOf,
    relationIds,
    dateOf,
    cleanNickname,
    maskName,
    computeResult,
    buildRanking,
    kstToday,
    getExamRankings,
    clearMaskedNameCache,
};
