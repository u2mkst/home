# KST Backend

Vercel 서버리스 함수. AES 키·NEIS 키·Firebase 관리자 권한처럼 브라우저에 두면 안 되는 것들을 맡는다.

## API

| 경로 | 인증 | 설명 |
|---|---|---|
| `POST /api/student-login` | 없음(reCAPTCHA·락아웃·IP 한도) | 아이디+PIN을 서버가 검증하고 Firebase 커스텀 토큰 발급 |
| `POST /api/register` | 없음(reCAPTCHA·IP 한도) | 학생 가입(계정 생성·암호화·DB 기록을 서버가 수행) |
| `POST /api/account` | ID 토큰 | `set-pin`(로그인 PIN 변경) / `delete`(PIN 확인 후 회원 탈퇴, 관련 기록 전부 삭제) |
| `POST /api/admin` | ID 토큰(마스터 UID만) | 마스터 운영 도구: `locks`/`unlock`, `reset-pin`, `students`, `set-disabled`, `delete-student`, `attendance-get`/`attendance-set`, `status`, `lotto-resync`/`lotto-set-draw`/`lotto-clear-predictions` |
| `POST /api/attendance` | ID 토큰 | 서버 시각 기준 오늘 출석 기록 + 랭킹용 횟수 + 출석 업적 |
| `POST /api/lotto` | ID 토큰 | `status`(당첨번호·회차·접수 가능 여부) / `submit`(예측 제출) |
| `GET /api/lotto` | `CRON_SECRET` | Vercel 크론: 추첨 직후 당첨번호 저장 + 예측 판정 + 로또 업적 지급 |
| `POST /api/encrypt`, `/api/decrypt` | ID 토큰 | AES 암복호화(복호화는 본인/검증된 이름/관리자만) |
| `GET /api/neis`, `/api/comcigan`, `/api/weather` | 없음 | 외부 API 프록시. `GET /api/weather?data=exam-ranking`은 로그인 화면 대시보드용 시험 순위(아래 참고) |
| `GET /api/health` | 없음(상세는 마스터 토큰) | 익명이면 `{ok:true}`만. 마스터 ID 토큰을 보내면 필수 환경변수 설정 여부를 true/false로 보여줌(값은 노출 안 함) |

## 학생 인증 구조

학생의 Firebase 비밀번호는 **무작위 값**이다. PIN(4자리)은 `loginSecrets/{uid}`에 `scrypt(salt + PIN_PEPPER)` 해시로만 저장하고
(클라이언트 접근 불가), 검증은 `/api/student-login`만 한다. 그래서 Firebase REST API를 직접 두드려도 PIN을 대입할 수 없다.
기존 계정은 첫 로그인 때 자동 이전되고, `scripts/migrate-student-auth.js`로 한꺼번에 이전할 수도 있다.

## 시험 순위(노션 연동)

로그인 화면 왼쪽 대시보드가 **학년별 가장 최근 시험의 순위**를 보여준다. 로그인 전에 누구나 볼 수 있는 공개 데이터라서 **실명 없이 닉네임과 점수만** 나간다.
(`GET /api/weather?data=exam-ranking` — Vercel 무료 플랜의 서버 함수 12개 제한 때문에 `weather.js`에 같이 두었다. 구현은 `lib/examRanking.js`, `lib/notionScores.js`.)

- 시험DB에서 오늘(KST)까지 치른 시험을 학년별로 최근 순으로 보고, **점수가 3명 이상 입력된 가장 최근 시험**을 고른다(입력 중인 시험은 건너뜀). 학생별성적DB에서 그 시험의 행을 읽어 상위 10명을 만든다(동점은 같은 등수, 10위에 걸린 동점자는 함께 표시).
- 학생별성적DB의 `닉네임`·`점수`(없으면 `성적`)만 요청한다(`filter_properties`). 학생이름·수강반·담당은 서버로 가져오지도 않는다. 닉네임이 비어 있으면 `익명`, 12자까지만, 제어문자는 제거한다.
- 서버 메모리 10분 + Vercel 엣지 캐시(5분)로 노션 호출을 줄이고, IP별 시간당 300회로 제한한다. 노션이 잠깐 안 되면 직전에 성공한 결과를 `stale: true`로 계속 내보낸다.
- 토큰이 없으면 503 `not_configured`, 노션 오류는 502 `notion_unavailable`. 화면은 어느 경우든 대시보드를 숨길 뿐 로그인에는 영향이 없다.
- 노션 DB는 제목으로 찾는다(`시험DB`, `학생별성적DB`). 필요한 속성: 시험DB `이름·날짜·학년·평균·최고점·최저점`, 학생별성적DB `시험지·닉네임·점수·성적`. 이름이 바뀌면 `lib/notionScores.js`의 `REQUIRED_PROPS`와 읽는 곳을 같이 고친다.

| 환경변수 | 설명 |
|---|---|
| `NOTION_TOKEN` | 노션 **내부 연동** 시크릿(읽기 전용 권한). 이 연동을 시험DB·학생별성적DB가 들어 있는 페이지에 "연결 추가"해야 읽힌다. |
| `NOTION_DB_EXAMS_ID` / `NOTION_DB_SCORES_ID` | (선택) 제목 검색 대신 DB id를 직접 지정 |

테스트: `node backend/lib/notionScores.test.js` (가짜 fetch, 노션 토큰·Firebase 불필요)

## 로또

- 1회차 추첨일(2002-12-07 토 20:35 KST)로부터 매주 한 회차. 서버가 "지금 끝났어야 할 회차"를 계산한다.
- 추첨 15분 뒤부터 첫 요청(또는 토요일 21:00 KST 크론)이 외부 API에서 당첨번호를 받아 `lottoDraws/{회차}`에 저장하고 판정한다.
- 접수는 추첨 10분 전에 마감(서버 시각 기준). 학생은 `lotto_predictions`/`lottoDraws`에 직접 쓸 수 없다.

## 스크립트(`scripts/`)

- `backfill-public-students.js`: 랭킹용 공개 노드 채우기(일회성)
- `migrate-student-auth.js`: 기존 학생 계정을 서버 PIN 검증 방식으로 이전(미리보기 → `--apply`)

환경변수 목록은 `.env.example` 참고.

> ⚠️ Vercel 무료(Hobby) 플랜은 `api/` 안의 서버 함수를 **12개까지만** 배포할 수 있다. 새 API는 기존 파일에 `action`으로 묶는 걸 우선 고려할 것.
