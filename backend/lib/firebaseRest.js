"use strict";
// Firebase Auth REST(signInWithPassword)로 "이 이메일/비밀번호가 진짜 맞는가"를 한 번 확인한다.
// 아직 서버 방식으로 이전되지 않은 옛 계정을 첫 로그인 때 안전하게 이전할 때만 쓴다.
// ※ 이 API는 공개 웹 키로 누구나 직접 부를 수 있다 — 그래서 이전이 끝난 계정의 Firebase 비밀번호는 무작위 값으로 바꾼다.
const FIREBASE_WEB_API_KEY = "AIzaSyD-F55blgdfzEygJ9-OUEqw22_EHKOhggg"; // 공개 웹 키(클라이언트에도 노출됨)

async function verifyFirebasePassword(email, password) {
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: false }),
        }
    );
    if (res.ok) return { ok: true, throttled: false };
    const json = await res.json().catch(() => ({}));
    const message = (json.error && json.error.message) || "";
    return { ok: false, throttled: message.startsWith("TOO_MANY_ATTEMPTS_TRY_LATER") };
}

module.exports = { FIREBASE_WEB_API_KEY, verifyFirebasePassword };
