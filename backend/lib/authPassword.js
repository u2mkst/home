const crypto = require("crypto");

// 학생 계정의 Firebase 비밀번호는 아무도 모르는 무작위 값이어야 한다(PIN은 서버가 해시로 검증).
// 이 Firebase 프로젝트에는 "비밀번호 최대 6자" 정책이 걸려 있어서 긴 값을 쓸 수 없다 — 6자 안에서
// 대/소문자·숫자·특수문자를 모두 포함하도록 만들어(정책에 어떤 문자 조건이 있어도 통과) 경우의 수를
// 최대한 키운다(약 70^6 ≈ 1.2e11, 4자리 PIN의 1천만 배 이상, 게다가 Firebase 자체 시도 제한도 있음).
// 정책의 최대 길이를 콘솔에서 늘리면 여기 길이만 늘리면 된다.
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGIT = "0123456789";
const SYMBOL = "!@#$%&*?";
const ALL = UPPER + LOWER + DIGIT + SYMBOL;
const LENGTH = 6;

const pick = (set) => set[crypto.randomInt(set.length)];

function randomAuthPassword() {
    const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
    while (chars.length < LENGTH) chars.push(pick(ALL));
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
}

module.exports = { randomAuthPassword };
