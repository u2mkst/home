const { applyCors } = require("../lib/cors");
const { rejectIfRateLimited } = require("../lib/guard");
const { getCached, setCached, setEdgeCache, setNoStore } = require("../lib/cache");

async function fetchTimetable(school, search) {
    const url = `https://sch-5bnq.onrender.com/timetable/${encodeURIComponent(school)}?${search.toString()}`;
    const upstreamRes = await fetch(url);
    const rawBody = await upstreamRes.text();
    let json;
    try {
        json = JSON.parse(rawBody);
    } catch (err) {
        return { ok: false, status: 502, body: { error: "comcigan API returned a non-JSON response", upstreamStatus: upstreamRes.status, bodyPreview: rawBody.slice(0, 300) } };
    }
    const ok = upstreamRes.ok && !json.detail && json.timetable;
    return { ok, status: upstreamRes.status, body: json };
}

// 시간표는 하루에 몇 번 안 바뀐다 — 30분 동안은 같은 조회를 캐시로 응답한다.
const TIMETABLE_TTL_SEC = 30 * 60;

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { school, grade, class_num, region } = req.query || {};

    const tooLong = [school, grade, class_num, region].some((v) => typeof v === "string" && v.length > 60);
    if (!school || !grade || !class_num || [school, grade, class_num].some((v) => typeof v !== "string") || tooLong) {
        return res.status(400).json({ error: "`school`, `grade` and `class_num` are required" });
    }

    const search = new URLSearchParams({ grade, class_num });
    if (region) search.set("region", region);

    const cacheKey = `comcigan:${school}:${search.toString()}`;
    const cached = getCached(cacheKey);
    if (cached) {
        setEdgeCache(res, TIMETABLE_TTL_SEC, TIMETABLE_TTL_SEC);
        res.setHeader("X-KST-Cache", "hit");
        return res.status(200).json(cached);
    }

    if (await rejectIfRateLimited(req, res, "comcigan", 300, 60 * 60 * 1000)) return;

    // 컴시간 학교 DB는 정식 명칭 대신 "학교"를 뗀 축약형으로 등록된 경우가 있다
    // (예: NEIS "광교호수중학교" ↔ 컴시간 "광교호수중"). 원래 이름으로 먼저 시도하고
    // 실패하면 "학교" 접미사를 뗀 이름으로 한 번 더 시도한다.
    const nameVariants = [school];
    if (/학교$/.test(school)) nameVariants.push(school.replace(/학교$/, ""));

    let result;
    try {
        for (const name of nameVariants) {
            result = await fetchTimetable(name, search);
            if (result.ok) break;
        }
    } catch (err) {
        setNoStore(res);
        return res.status(502).json({ error: "Failed to reach comcigan API", detail: err.message });
    }

    if (result.ok && result.status === 200) {
        setCached(cacheKey, result.body, TIMETABLE_TTL_SEC * 1000);
        setEdgeCache(res, TIMETABLE_TTL_SEC, TIMETABLE_TTL_SEC);
    } else {
        setNoStore(res);
    }
    return res.status(result.status).json(result.body);
};
