"use strict";
/* 요청 제한(고정 윈도우)의 순수 계산부. Firebase 없이 단위 테스트할 수 있게 guard.js에서 분리했다. */

// 지금 요청을 센 뒤의 상태. 윈도우가 끝났거나 기록이 없으면 새로 시작한다.
function nextQuotaState(current, now, windowMs) {
    if (!current || !(Number(current.resetAt) > now)) return { count: 1, resetAt: now + windowMs };
    return { count: (Number(current.count) || 0) + 1, resetAt: current.resetAt };
}

function evaluateQuota(state, maxPerWindow, now) {
    return { allowed: state.count <= maxPerWindow, retryAfterMs: Math.max(0, state.resetAt - now) };
}

module.exports = { nextQuotaState, evaluateQuota };
