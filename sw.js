"use strict";
/* K&P 수학입시학원 — 오프라인 안내용 서비스 워커.
   하는 일은 딱 하나: 페이지를 열 때(이동 요청) 인터넷이 안 되면 브라우저의 기본 오류 화면(공룡)이나 흰 화면 대신
   offline.html(다시 시도 버튼이 있는 안내 화면)을 보여 준다.
   이미지·API·스크립트 등 다른 요청은 건드리지 않고, 인터넷이 되면 평소와 똑같이 서버에서 바로 받아 온다(캐시로 대신 답하지 않음).
   offline.html을 고치면 VERSION을 올려야 기기에 새 화면이 저장된다. */
const VERSION = "kp-offline-v1";
const OFFLINE_URL = "offline.html";
const NAV_TIMEOUT_MS = 8000; // 와이파이만 붙고 인터넷은 안 되는 경우 무한정 기다리지 않고 안내 화면으로 넘어간다.

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(VERSION)
            .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith("kp-offline-") && k !== VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.mode !== "navigate" || req.method !== "GET") return; // 페이지 이동만 처리
    event.respondWith((async () => {
        try {
            let timer;
            const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), NAV_TIMEOUT_MS); });
            try {
                return await Promise.race([fetch(req), timeout]);
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            const cached = await caches.match(OFFLINE_URL);
            return cached || new Response("인터넷에 연결되어 있지 않아요. 연결을 확인한 뒤 다시 시도해 주세요.", {
                status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
        }
    })());
});
