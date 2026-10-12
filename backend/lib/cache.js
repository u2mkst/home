// 외부 API 프록시(neis/weather/comcigan) 응답 캐시.
// (1) 같은 서버 인스턴스 안에서는 메모리에 잠깐 들고 있다가 바로 돌려주고(속도 제한용 DB 기록·외부 호출 생략),
// (2) 성공 응답에는 Cache-Control(s-maxage)을 붙여 Vercel 엣지가 함수를 아예 깨우지 않고 응답하게 한다.
// 오류 응답은 캐시하지 않는다. 학교 일정·날씨·시간표는 몇 분~몇 시간 늦어도 문제가 없는 데이터다.
const MAX_ENTRIES = 500;
const store = new Map();

function getCached(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) { store.delete(key); return null; }
    return hit.value;
}

function setCached(key, value, ttlMs) {
    if (store.size >= MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
    }
    store.set(key, { value, expires: Date.now() + ttlMs });
}

// 엣지 캐시 헤더. sMaxAgeSec 동안은 신선, 그 뒤 swrSec 동안은 오래된 응답을 주면서 뒤에서 갱신한다.
function setEdgeCache(res, sMaxAgeSec, swrSec) {
    res.setHeader("Cache-Control", `public, s-maxage=${sMaxAgeSec}, stale-while-revalidate=${swrSec}`);
}

function setNoStore(res) {
    res.setHeader("Cache-Control", "no-store");
}

module.exports = { getCached, setCached, setEdgeCache, setNoStore };
