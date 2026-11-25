"use strict";
/* 학생 본인 시험 성적(노션) 조회와 관리자용 연결 점검.
   Firebase(학생 이름) ↔ 노션(원생명부/성적DB)을 잇는 서버 쪽 접착 코드다. 노션 호출 자체는 notionScores.js. */
const { admin } = require("./firebaseAdmin");
const { decryptOne, getDecryptKeys } = require("./aes");
const { getCached, setCached } = require("./cache");
const Notion = require("./notionScores");

const CACHE_MS = 5 * 60 * 1000;
const CIPHER_PREFIX = "U2FsdGVkX1";

function plainName(cipher) {
    if (!cipher || typeof cipher !== "string") return "";
    const plain = decryptOne(getDecryptKeys(), cipher);
    return plain.startsWith(CIPHER_PREFIX) ? "" : plain.trim(); // 못 푼 암호문은 이름으로 쓰지 않는다
}

function makeClient() {
    return Notion.createNotionClient({ token: process.env.NOTION_TOKEN }); // 토큰이 없으면 not_configured
}

// 호출자 본인의 성적만 돌려준다. 이름은 서버가 DB에서 직접 읽고(클라이언트가 보낸 이름은 믿지 않는다),
// 원생명부에서 "정확히 한 명"과 맞을 때만 연결한다.
async function getStudentScores(uid) {
    const cacheKey = `scores:${uid}`;
    const hit = getCached(cacheKey);
    if (hit) return hit;

    const client = makeClient();
    const snap = await admin.database().ref(`students/${uid}/name`).once("value");
    const name = plainName(snap.val());

    let payload;
    if (!name) {
        payload = { ok: true, linked: false, reason: "no_name" };
    } else {
        const overrides = Notion.dbOverridesFromEnv();
        const found = await Notion.findStudentPage(client, name, overrides);
        if (found.status !== "ok") {
            payload = { ok: true, linked: false, reason: found.status }; // none | ambiguous (이름은 돌려주지 않는다)
        } else {
            const items = await Notion.fetchStudentScores(client, found.pageId, overrides);
            payload = { ok: true, linked: true, items, updatedAt: Date.now() };
        }
    }
    setCached(cacheKey, payload, CACHE_MS);
    return payload;
}

// 관리자용: 가입한 학생 이름이 원생명부와 잘 연결되는지 점검한다(연결 안 되는 이름 목록은 관리자만 본다).
async function linkCheck() {
    const client = makeClient();
    const overrides = Notion.dbOverridesFromEnv();
    const [studentsSnap, rosterTitles] = await Promise.all([
        admin.database().ref("students").once("value"),
        Notion.listRosterTitles(client, overrides),
    ]);

    const counts = new Map(); // 정규화한 이름 → 원생명부에 몇 번 나오는지
    for (const title of rosterTitles) {
        for (const v of new Set(Notion.titleVariants(title))) counts.set(v, (counts.get(v) || 0) + 1);
    }

    const students = studentsSnap.val() || {};
    const linked = [];
    const ambiguous = [];
    const missing = [];
    for (const rec of Object.values(students)) {
        const name = plainName(rec && rec.name);
        if (!name) continue;
        const n = counts.get(Notion.normalizeName(name)) || 0;
        (n === 1 ? linked : n > 1 ? ambiguous : missing).push(name);
    }
    const sortKo = (a, b) => a.localeCompare(b, "ko");
    return {
        rosterCount: rosterTitles.length,
        studentCount: linked.length + ambiguous.length + missing.length,
        linked: linked.length,
        ambiguous: ambiguous.sort(sortKo),
        missing: missing.sort(sortKo),
    };
}

module.exports = { getStudentScores, linkCheck, plainName };
