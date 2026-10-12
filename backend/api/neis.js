const { applyCors } = require("../lib/cors");
const { rejectIfRateLimited } = require("../lib/guard");
const { getCached, setCached, setEdgeCache, setNoStore } = require("../lib/cache");

const ALLOWED_ENDPOINTS = new Set([
    "schoolInfo",
    "SchoolSchedule",
    "elsTimetable",
    "misTimetable",
    "hisTimetable",
]);

// 학교 정보는 거의 안 바뀌고, 학사일정·시간표도 몇 시간 늦어도 괜찮다.
const TTL_SEC = { schoolInfo: 24 * 3600, SchoolSchedule: 6 * 3600, elsTimetable: 30 * 60, misTimetable: 30 * 60, hisTimetable: 30 * 60 };

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { endpoint, ...params } = req.query || {};

    if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
        return res.status(400).json({ error: "Unknown or missing `endpoint`" });
    }

    if (!process.env.NEIS_API_KEY) {
        return res.status(500).json({ error: "NEIS_API_KEY is not configured on the server" });
    }

    const search = new URLSearchParams();
    // 파라미터 이름/길이를 제한해서 임의 값을 NEIS에 그대로 넘기지 않는다(KEY/Type은 서버가 덮어쓴다).
    for (const [key, value] of Object.entries(params).slice(0, 20)) {
        if (value === undefined || !/^[A-Za-z_]{1,32}$/.test(key)) continue;
        const v = String(Array.isArray(value) ? value[0] : value);
        if (v.length > 100) continue;
        search.set(key, v);
    }

    // 같은 조회는 캐시로 바로 응답한다(속도 제한용 DB 기록과 NEIS 호출을 건너뜀). 키는 서버가 붙이기 전의 값으로 만든다.
    search.delete("KEY"); search.delete("Type");   // 서버가 덮어쓰는 값이므로 캐시 키에서 뺀다(바꿔 보내 캐시를 우회하지 못하게)
    const ttlSec = TTL_SEC[endpoint];
    const cacheKey = `neis:${endpoint}:${search.toString()}`;
    const cached = getCached(cacheKey);
    if (cached) {
        setEdgeCache(res, ttlSec, ttlSec);
        res.setHeader("X-KST-Cache", "hit");
        return res.status(200).json(cached);
    }

    // 로그인 없이 호출되는 프록시라 IP별 한도를 둔다(학원 와이파이를 여러 명이 같이 쓰는 점을 감안해 넉넉하게).
    if (await rejectIfRateLimited(req, res, "neis", 600, 60 * 60 * 1000)) return;

    search.set("KEY", process.env.NEIS_API_KEY);
    search.set("Type", "json");

    const url = `https://open.neis.go.kr/hub/${endpoint}?${search.toString()}`;

    let neisRes;
    try {
        neisRes = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (KST backend proxy)" },
        });
    } catch (err) {
        setNoStore(res);
        return res.status(502).json({ error: "Failed to reach NEIS API", detail: err.message });
    }

    const rawBody = await neisRes.text();
    try {
        const json = JSON.parse(rawBody);
        if (neisRes.status === 200) {
            setCached(cacheKey, json, ttlSec * 1000);
            setEdgeCache(res, ttlSec, ttlSec);
        } else {
            setNoStore(res);
        }
        return res.status(neisRes.status).json(json);
    } catch (err) {
        setNoStore(res);
        return res.status(502).json({
            error: "NEIS API returned a non-JSON response",
            neisStatus: neisRes.status,
            bodyPreview: rawBody.slice(0, 300),
        });
    }
};
