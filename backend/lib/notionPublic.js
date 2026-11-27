"use strict";
/* 노션 "웹에 공개" 페이지에서 시험 순위를 만든다 (로그인 화면 대시보드용 공개 데이터).
   ※ 노션의 공식 API가 아니라 공개 페이지가 화면을 그릴 때 쓰는 내부 주소(loadCachedPageChunkV2 / queryCollection /
     syncRecordValuesMain)를 읽는다. 토큰은 필요 없지만 노션이 바꾸면 깨질 수 있고, 페이지가 계속 "웹에 공개"여야 한다.
     그래서 ①필요한 열이 없으면 바로 schema_changed 로 실패하고(잘못된 값을 내보내지 않는다), ②상위 코드(examRanking.js)가
     직전 성공 결과를 계속 보여 주며, ③결과를 서버·엣지에 오래 캐시한다.
   - 점수는 노션의 수식 열이라 공개 데이터에 값이 없다. 그래서 점수 = 총문항 − 오답(맞은 문항 수),
     정답률 = 맞은 수 ÷ 총문항 으로 우리가 계산한다. 순위는 정답률 기준.
   - 화면에는 닉네임과 정답률만 나간다. **닉네임이 비어 있거나 실명과 같은/실명을 담은 닉네임이면** 학생 페이지 제목(이름)을
     읽어 서버에서 "홍*동"처럼 가운데 글자를 가린 값으로 바꾼다. 이름을 확인하지 못하면 닉네임이 있어도 "익명"으로 내보내고,
     이름 조회가 통째로 실패하면 순위를 내보내지 않는다(안전 쪽으로 실패). 실명은 요청 처리 중 지역 변수로만 존재하고
     응답·캐시·로그 어디에도 남지 않는다.
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
const MAX_EXAM_AGE_DAYS = 90; // 이보다 오래전에 치른 시험은 순위에 쓰지 않는다(지난 시험이 계속 떠 있지 않게). 그 학년은 새 시험이 입력될 때까지 빠진다
const MAX_ROWS = 20000;
const REQUEST_TIMEOUT_MS = 25000;
const NAME_LOOKUP_BATCH = 100;

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

// ---------- 닉네임이 실명을 담고 있는지 / 학생 이름 조회 ----------
function normalizeForCompare(s) {
    return String(s == null ? "" : s).normalize("NFC").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
}

// 닉네임이 실명을 드러내는가: 실명과 같거나, 실명을 포함하거나, 이름(성을 뺀 두 글자)을 포함하거나, 실명의 일부(2글자 이상)이면 true.
// 오탐(우연히 겹치는 글자)은 안전 쪽이라 허용한다 — 걸리면 닉네임 대신 가린 이름이 나간다.
function leaksRealName(nickname, realName) {
    const n = normalizeForCompare(nickname);
    const r = normalizeForCompare(String(realName == null ? "" : realName).replace(/[(\[（].*?[)\]）]/g, ""));
    if (r.length < 2 || !n) return false;
    if (n.length === 1 && r.startsWith(n)) return true; // 성만 적은 한 글자 닉네임
    if (n.includes(r)) return true;
    if (r.length >= 3 && n.includes(r.slice(-2))) return true;
    if (n.length >= 2 && r.includes(n)) return true;
    return false;
}

// 닉네임이 (본인이 아닌) 다른 학생의 실명을 그대로 담았는가: 3글자 이상 실명과 같거나 포함하면 true.
// 흔한 낱말과 우연히 겹치는 일을 줄이려고 다른 학생과는 전체 이름 비교만 한다.
function leaksOtherRealName(nickname, otherNames) {
    const n = normalizeForCompare(nickname);
    if (!n) return false;
    for (const name of otherNames) if (name.length >= 3 && n.includes(name)) return true;
    return false;
}

// 학생 페이지들의 제목(이름)을 한 번에 읽는다(100개씩). 이 Map은 요청 처리 중에만 쓰고 버린다(캐시·저장 금지).
// 요청 자체가 실패하면 닉네임이 실명인지 확인할 수 없으므로 순위를 내보내지 않고 오류로 처리한다.
async function studentTitles(client, spaceId, pageIds) {
    const ids = [...new Set(pageIds.filter(Boolean))];
    const titles = new Map();
    for (let i = 0; i < ids.length; i += NAME_LOOKUP_BATCH) {
        const batch = ids.slice(i, i + NAME_LOOKUP_BATCH);
        let res;
        try {
            res = await client.post("syncRecordValuesMain", {
                requests: batch.map((id) => ({ pointer: { table: "block", id, spaceId }, version: -1 })),
            });
        } catch (e) {
            throw new PublicNotionError("student name lookup failed", "name_lookup_failed");
        }
        const blocks = (res && res.recordMap && res.recordMap.block) || {};
        for (const id of batch) {
            const v = blockValue(blocks[id]);
            const title = v && v.properties ? textOf(v.properties.title) : "";
            if (title.trim()) titles.set(id, title);
        }
    }
    return titles;
}

// 화면에 내보낼 이름: 이름을 확인 못 하면 익명 / 닉네임이 없거나 실명을 담았으면 가린 이름 / 아니면 닉네임.
function displayName(entry, titles, otherNames = []) {
    const real = titles.get(entry.studentPageId);
    if (!real) return ANONYMOUS_NICKNAME;
    if (!entry.nickname || leaksRealName(entry.nickname, real) || leaksOtherRealName(entry.nickname, otherNames)) return maskName(real);
    return entry.nickname;
}

// ---------- 학년별 최근 시험 순위 ----------
async function getExamRankings(client, config = DEFAULTS, { now = new Date(), topN = TOP_N, minParticipants = MIN_PARTICIPANTS, maxAgeDays = MAX_EXAM_AGE_DAYS } = {}) {
    const [examsDb, scoresDb] = await Promise.all([
        loadDatabase(client, config.examsPageId, REQUIRED_EXAM_PROPS, "시험DB"),
        loadDatabase(client, config.scoresPageId, REQUIRED_SCORE_PROPS, "학생별성적"),
    ]);
    if (scoresDb.truncated) console.error("exam ranking: score rows truncated at", MAX_ROWS);

    const today = kstToday(now);
    const oldestDate = new Date(Date.parse(`${today}T00:00:00Z`) - maxAgeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const exams = new Map();
    for (const r of examsDb.rows) {
        const grade = textOf(r.props[examsDb.keys["학년"]]).trim();
        const name = textOf(r.props[examsDb.keys["이름"]]).trim();
        const date = dateOf(r.props[examsDb.keys["날짜"]]);
        if (!grade || !name || !date || date > today || date < oldestDate) continue; // 학년/날짜가 없거나, 아직 치르지 않았거나, 너무 오래된 시험은 제외
        exams.set(r.id, { id: r.id, grade, name, date });
    }

    // 닉네임은 학생의 고유 속성인데 시험마다 손으로 적혀서, 새 시험은 아직 비어 있는 경우가 많다.
    // 그런 때는 같은 학생이 이전 시험에 적은 가장 최근 닉네임을 이어서 쓴다(실명 겹침 검사는 그대로 적용된다).
    const examDateById = new Map();
    for (const r of examsDb.rows) examDateById.set(r.id, dateOf(r.props[examsDb.keys["날짜"]]) || "");
    const latestNick = new Map(); // 학생 페이지 id -> { date, nick }
    for (const r of scoresDb.rows) {
        const sid = relationIds(r.props[scoresDb.keys["학생이름"]])[0];
        const nick = cleanNickname(textOf(r.props[scoresDb.keys["닉네임"]]));
        if (!sid || !nick) continue;
        const d = examDateById.get(relationIds(r.props[scoresDb.keys["시험지"]])[0]) || "";
        const prev = latestNick.get(sid);
        if (!prev || d > prev.date) latestNick.set(sid, { date: d, nick });
    }

    const byExam = new Map();
    for (const r of scoresDb.rows) {
        const examId = relationIds(r.props[scoresDb.keys["시험지"]])[0];
        if (!examId || !exams.has(examId)) continue;
        const result = computeResult(numberOf(r.props[scoresDb.keys["총문항"]]), numberOf(r.props[scoresDb.keys["오답"]]));
        if (!result) continue;
        if (!byExam.has(examId)) byExam.set(examId, []);
        const studentPageId = relationIds(r.props[scoresDb.keys["학생이름"]])[0] || null;
        const own = cleanNickname(textOf(r.props[scoresDb.keys["닉네임"]]));
        byExam.get(examId).push({
            nickname: own || (studentPageId && latestNick.has(studentPageId) ? latestNick.get(studentPageId).nick : ""),
            studentPageId,
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

    // 닉네임이 없거나 실명(본인·다른 학생)을 담은 경우 가린 이름으로 바꾼다.
    const rankings = picked.map((p) => ({ ...p, ranked: buildRanking(p.entries, topN) }));
    // 닉네임이 다른 학생의 실명일 수도 있어서, 성적표에 나오는 모든 학생의 이름을 읽어 대조한다(요청 처리 중에만 쓰고 버린다).
    const rosterIds = scoresDb.rows.map((r) => relationIds(r.props[scoresDb.keys["학생이름"]])[0]);
    const titles = await studentTitles(client, scoresDb.spaceId, [...rosterIds, ...rankings.flatMap((p) => p.ranked.map((e) => e.studentPageId))]);
    const otherNames = [...titles.values()].map((t) => normalizeForCompare(String(t).replace(/[(\[（].*?[)\]）]/g, ""))).filter((n) => n.length >= 3);

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
                nickname: displayName(e, titles, otherNames),
                score: e.score,
                total: e.total,
                rate: e.rate,
            })),
        };
    });
    return { updatedAt: now.getTime(), grades };
}

module.exports = {
    MAX_EXAM_AGE_DAYS,
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
    leaksRealName,
    leaksOtherRealName,
    displayName,
};
