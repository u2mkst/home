"use strict";
/* 로그인 화면 대시보드용 "학년별 최근 시험 순위" 공개 API.
   로그인 없이 누구나 부를 수 있으므로: ①실명 없이 닉네임·점수만 내보내고(notionScores.js),
   ②서버 메모리 + 엣지 캐시로 노션 호출을 몇 분에 한 번으로 줄이고, ③IP별 요청 한도를 두며,
   ④노션이 잠깐 안 될 때는 직전에 성공한 결과를 계속 보여 준다.
   ※ Vercel 무료(Hobby) 플랜의 서버 함수 12개 제한 때문에 새 파일 대신 api/weather.js 의
     `?data=exam-ranking` 갈래로 연결한다. */
const { getCached, setCached, setEdgeCache, setNoStore } = require("./cache");
const Notion = require("./notionScores");

const CACHE_KEY = "examRanking";
const CACHE_MS = 10 * 60 * 1000;
const EDGE_FRESH_SEC = 300;
const EDGE_STALE_SEC = 1800;

let lastGood = null;

async function handleExamRanking(req, res, deps = {}) {
    // guard.js는 Firebase 관리자 초기화가 따라와서, 실제로 쓸 때만 불러온다(단위 테스트는 가짜를 주입).
    const rateLimited = deps.rejectIfRateLimited || require("./guard").rejectIfRateLimited;
    const createClient = deps.createClient || ((token) => Notion.createNotionClient({ token }));

    const cached = getCached(CACHE_KEY);
    if (cached) {
        setEdgeCache(res, EDGE_FRESH_SEC, EDGE_STALE_SEC);
        res.setHeader("X-KST-Cache", "hit");
        return res.status(200).json(cached);
    }

    if (await rateLimited(req, res, "examranking", 300, 60 * 60 * 1000)) return;

    const token = process.env.NOTION_TOKEN;
    if (!token) {
        setNoStore(res);
        return res.status(503).json({ error: "not_configured" });
    }

    try {
        const result = await Notion.getExamRankings(createClient(token), Notion.dbOverridesFromEnv());
        const payload = { ok: true, ...result };
        setCached(CACHE_KEY, payload, CACHE_MS);
        lastGood = payload;
        setEdgeCache(res, EDGE_FRESH_SEC, EDGE_STALE_SEC);
        return res.status(200).json(payload);
    } catch (err) {
        console.error("exam ranking error:", (err && err.notionCode) || (err && err.message)); // 이름·토큰은 로그에 남기지 않는다
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
