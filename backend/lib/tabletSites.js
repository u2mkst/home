"use strict";
/* 학원 태블릿 앱(브라우저)이 열 수 있는 사이트 목록.
   - 저장: Firebase RTDB `config/tabletSites` { hosts: [...], updatedAt, updatedBy }  (서버(관리자 SDK)만 쓴다)
   - 읽기: 앱이 로그인 없이 부르는 공개 조회(`GET /api/weather?data=tablet-sites`). 호스트 이름만 들어 있어 비밀이 아니다.
   - 쓰기: 마스터 전용 action(`tablet-sites-set`, api/admin.js).
   앱의 SiteAccessPolicy.java와 같은 규칙으로 항목을 검사한다(공용 도메인 `co.kr` 같은 걸 넣으면 그 아래 모든 사이트가 열리므로 거부). */
const { getCached, setCached, setEdgeCache, setNoStore } = require("./cache");

const CORE_HOST = "u2mkst.github.io";
const DEFAULT_HOSTS = [CORE_HOST, "u2math.co.kr", "mathflat.com", "mathflat.co.kr", "neis.go.kr"];
const MAX_HOSTS = 50;
const CACHE_KEY = "tabletSites";
const CACHE_MS = 60 * 1000;
const EDGE_FRESH_SEC = 60;
const EDGE_STALE_SEC = 300;

// 이 값 자체를 허용하면 그 아래 모든 사이트가 열린다.
const PUBLIC_SUFFIXES = new Set([
    "co.kr", "or.kr", "go.kr", "ne.kr", "re.kr", "pe.kr", "ac.kr", "hs.kr", "ms.kr", "es.kr", "kg.kr",
    "co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "github.io", "vercel.app", "web.app", "firebaseapp.com",
]);
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// 주소 한 줄(`https://www.Example.com/path`, `example.com`)을 호스트(`example.com`)로. 쓸 수 없으면 null.
function sanitizeHost(raw) {
    if (typeof raw !== "string") return null;
    let s = raw.trim().toLowerCase();
    if (s.startsWith("https://")) s = s.slice(8);
    else if (s.startsWith("http://")) s = s.slice(7);
    const cut = s.search(/[/?#:]/);
    if (cut >= 0) s = s.slice(0, cut);
    if (s.startsWith("www.")) s = s.slice(4);
    if (!HOST_RE.test(s)) return null;
    if (PUBLIC_SUFFIXES.has(s)) return null;
    return s;
}

// 목록을 정리한다: 우리 사이트를 맨 앞에 항상 넣고, 중복은 뺀다. 쓸 수 없는 항목은 rejected에 모은다.
function sanitizeList(list) {
    const hosts = [CORE_HOST];
    const rejected = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const h = sanitizeHost(raw);
        if (!h) { if (String(raw || "").trim()) rejected.push(String(raw).trim().slice(0, 80)); continue; }
        if (!hosts.includes(h)) hosts.push(h);
    }
    return { hosts, rejected };
}

async function readSites(db) {
    const val = (await db.ref("config/tabletSites").once("value")).val();
    if (!val || !Array.isArray(val.hosts)) return { hosts: DEFAULT_HOSTS.slice(), updatedAt: 0, isDefault: true };
    const { hosts } = sanitizeList(val.hosts);
    return { hosts, updatedAt: Number(val.updatedAt) || 0, isDefault: false };
}

// 마스터가 저장. 쓸 수 없는 항목이 하나라도 있으면 아무것도 저장하지 않고 알려 준다.
async function writeSites(db, list, who) {
    const { hosts, rejected } = sanitizeList(list);
    if (rejected.length) { const e = new Error("bad_hosts"); e.statusCode = 400; e.rejected = rejected; throw e; }
    if (hosts.length > MAX_HOSTS) { const e = new Error("too_many"); e.statusCode = 400; throw e; }
    const updatedAt = Date.now();
    await db.ref("config/tabletSites").set({ hosts, updatedAt, updatedBy: who || null });
    setCached(CACHE_KEY, null, 1); // 같은 서버 인스턴스의 캐시는 바로 비운다(엣지 캐시는 최대 1분 뒤 갱신)
    return { hosts, updatedAt, isDefault: false };
}

// 공개 조회. 읽기에 실패하면 502만 돌려주고, 앱은 마지막으로 받아 저장해 둔 목록(없으면 내장 기본 목록)을 계속 쓴다.
async function handleTabletSites(req, res, deps = {}) {
    const db = deps.db || require("./firebaseAdmin").admin.database();
    const rateLimited = deps.rejectIfRateLimited || require("./guard").rejectIfRateLimited;

    const cached = getCached(CACHE_KEY);
    if (cached) {
        setEdgeCache(res, EDGE_FRESH_SEC, EDGE_STALE_SEC);
        return res.status(200).json(cached);
    }
    // 학원 태블릿 여러 대가 같은 공유기(같은 IP)로 나가므로 한도를 넉넉히 둔다.
    if (await rateLimited(req, res, "tabletsites", 1200, 60 * 60 * 1000)) return;
    try {
        const { hosts, updatedAt } = await readSites(db);
        const payload = { ok: true, hosts, updatedAt };
        setCached(CACHE_KEY, payload, CACHE_MS);
        setEdgeCache(res, EDGE_FRESH_SEC, EDGE_STALE_SEC);
        return res.status(200).json(payload);
    } catch (err) {
        console.error("tablet sites error:", (err && err.code) || (err && err.message));
        setNoStore(res);
        return res.status(502).json({ error: "unavailable" });
    }
}

function resetForTest() { setCached(CACHE_KEY, null, 1); }

module.exports = { CORE_HOST, DEFAULT_HOSTS, MAX_HOSTS, sanitizeHost, sanitizeList, readSites, writeSites, handleTabletSites, resetForTest };
