# KST Backend

Vercel 서버리스 함수. AES 키·NEIS 키·Firebase 관리자 권한처럼 브라우저에 두면 안 되는 것들을 맡는다.

## API

| 경로 | 인증 | 설명 |
|---|---|---|
| `POST /api/student-login` | 없음(reCAPTCHA·락아웃·IP 한도) | 아이디+PIN을 서버가 검증하고 Firebase 커스텀 토큰 발급 |
| `POST /api/register` | 없음(reCAPTCHA·IP 한도) | 학생 가입(계정 생성·암호화·DB 기록을 서버가 수행) |
| `POST /api/set-pin` | ID 토큰 | 로그인 PIN(부모님 전화번호 뒷 4자리) 변경 |
| `POST /api/delete-account` | ID 토큰 + PIN | 회원 탈퇴(관련 기록 전부 삭제) |
| `POST /api/attendance` | ID 토큰 | 서버 시각 기준 오늘 출석 기록 + 랭킹용 횟수 + 출석 업적 |
| `POST /api/lotto` | ID 토큰 | `status`(당첨번호·회차·접수 가능 여부) / `submit`(예측 제출) |
| `GET /api/lotto` | `CRON_SECRET` | Vercel 크론: 추첨 직후 당첨번호 저장 + 예측 판정 + 로또 업적 지급 |
| `POST /api/encrypt`, `/api/decrypt` | ID 토큰 | AES 암복호화(복호화는 본인/검증된 이름/관리자만) |
| `GET /api/neis`, `/api/comcigan`, `/api/weather` | 없음 | 외부 API 프록시 |
| `GET /api/health` | 없음 | 필수 환경변수가 들어갔는지만 true/false로 확인(값은 노출 안 함) |

## 학생 인증 구조

학생의 Firebase 비밀번호는 **무작위 값**이다. PIN(4자리)은 `loginSecrets/{uid}`에 `scrypt(salt + PIN_PEPPER)` 해시로만 저장하고
(클라이언트 접근 불가), 검증은 `/api/student-login`만 한다. 그래서 Firebase REST API를 직접 두드려도 PIN을 대입할 수 없다.
기존 계정은 첫 로그인 때 자동 이전되고, `scripts/migrate-student-auth.js`로 한꺼번에 이전할 수도 있다.

## 로또

- 1회차 추첨일(2002-12-07 토 20:35 KST)로부터 매주 한 회차. 서버가 "지금 끝났어야 할 회차"를 계산한다.
- 추첨 15분 뒤부터 첫 요청(또는 토요일 21:00 KST 크론)이 외부 API에서 당첨번호를 받아 `lottoDraws/{회차}`에 저장하고 판정한다.
- 접수는 추첨 10분 전에 마감(서버 시각 기준). 학생은 `lotto_predictions`/`lottoDraws`에 직접 쓸 수 없다.

## 스크립트(`scripts/`)

- `backfill-public-students.js`: 랭킹용 공개 노드 채우기(일회성)
- `migrate-student-auth.js`: 기존 학생 계정을 서버 PIN 검증 방식으로 이전(미리보기 → `--apply`)

환경변수 목록은 `.env.example` 참고.
