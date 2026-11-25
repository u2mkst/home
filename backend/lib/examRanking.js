"use strict";
/* 로그인 화면 대시보드용 "학년별 최근 시험 순위" 공개 API.
   로그인 없이 누구나 부를 수 있으므로: ①닉네임·점수만 내보내고(닉네임 없는 학생은 가린 이름, notionPublic.js),
   ②서버 메모리 + 엣지 캐시로 노션 호출을 몇 분에 한 번으로 줄이고, ③IP별 요청 한도를 두며,
   ④노션이 안 되거나 노션 화면 구조가 바뀌어도 직전에 성공한 결과를 계속 보여 준다.
   ※ Vercel 무료(Hobby) 플랜의 서버 함수 12개 제한 때문에 새 파일 대신 api/weather.js 의
     `?data=exam-ranking` 갈래로 연결한다. */
const { getCached, setCached, setEdgeCache, setNoStore } = require("./cache");
const NotionPublic = require("./notionPublic");

const CACHE_KEY = "examRanking";
const CACHE_MS = 10 * 60 * 1000;
const EDGE_FRESH_SEC = 300;
const EDGE_STALE_SEC = 1800;

let lastGood = null;

async function handleExamRanking(req, res, deps = {}) {
    // guard.js는 Firebase 관리자 초기화가 따라와서, 실제로 쓸 때만 불러온다(단위 테스트는 가짜를 주입).
    const rateLimited = deps.rejectIfRateLimited || require("./guard").rejectIfRateLimited;
    const config = NotionPublic.configFromEnv();
    const createClient = deps.createClient || (() => NotionPublic.createPublicClient({ host: config.host }));

    const cached = getCached(CACHE_KEY);
    if (cached) {
        setEdgeCache(res, EDGE_FRESH_SEC, EDGE_STALE_SEC);
        res.setHeader("X-KST-Cache", "hit");
        return res.status(200).json(cached);
    }

    if (await rateLimited(req, res, "examranking", 300, 60 * 60 * 1000)) return;

    try {
        const result = await NotionPublic.getExamRankings(createClient(), config);
        const payload = { ok: true, ...result };
        setCached(CACHE_KEY, payload, CACHE_MS);
        lastGood = payload;
        setEdgeCache(res, EDGE_FRESH_SEC, EDGE_STALE_SEC);
        return res.status(200).json(payload);
    } catch (err) {
        console.error("exam ranking error:", (err && err.code) || (err && err.message)); // 학생 이름은 로그에 남기지 않는다
        if (lastGood) {
            setEdgeCache(res, 60, 300);
            return res.status(200).json({ ...lastGood, stale: true });
        }
        setNoStore(res);
        return res.status(502).json({ error: "notion_unavailable" });
    }
}

function resetForTest() { lastGood = null; }

module.exports = { handleExamRanking, resetForTest, CACHE_KEY };
