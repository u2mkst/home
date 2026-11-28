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

// ---- 로그인 실패 잠금 단계 ------------------------------------------------
// 연속 실패 횟수(중간에 성공하면 0으로 돌아감) → 잠그는 시간(ms).
// 학생 PIN은 4자리(1만 가지)라서 공격자가 한 계정에 걸 수 있는 시도를 최대한 줄이는 게 핵심이다:
// 30번째부터는 24시간에 1번꼴이라 PIN 전체를 대입하는 데 수십 년이 걸린다.
function computeLockoutMs(failCount) {
    if (failCount >= 30) return 24 * 60 * 60 * 1000;
    if (failCount >= 12) return 60 * 60 * 1000;
    if (failCount >= 8) return 10 * 60 * 1000;
    if (failCount >= 5) return 2 * 60 * 1000;
    if (failCount >= 3) return 30 * 1000;
    return 0;
}

// 관리자·마스터 계정: 선생님이 여럿 같이 쓰는 계정이라, 공격자가 일부러 틀려서 오래 잠가 두는 일(서비스 거부)을
// 줄이려고 최대 1시간으로 제한한다. 대신 시작을 빠르게 한다(비밀번호는 PIN과 달리 긴 값을 쓸 수 있다).
function computeAdminLockoutMs(failCount) {
    if (failCount >= 8) return 60 * 60 * 1000;
    if (failCount >= 5) return 10 * 60 * 1000;
    if (failCount >= 3) return 60 * 1000;
    return 0;
}

// 마지막 실패 뒤 이만큼 지나야 실패 횟수를 잊는다. (예전엔 24시간이라, 24시간 잠금이 풀리는 순간 횟수가
// 0으로 돌아가 공격자가 하루에 약 21번씩 계속 시도할 수 있었다.) 로그인에 성공하면 바로 0으로 돌아간다.
const FAIL_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

module.exports = { nextQuotaState, evaluateQuota, computeLockoutMs, computeAdminLockoutMs, FAIL_MEMORY_MS };
