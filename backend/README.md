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

## 시험 순위(노션 공개 페이지)

로그인 화면 **왼쪽 가장자리에 붙어 항상 열려 있는 "시험 순위" 패널**(900px 이상에서 로그인 카드 옆, 페이지가 열릴 때 왼쪽에서 한 번 튀어나옴)이 **학년별 가장 최근 시험의 순위**를 보여준다(행마다 닉네임(실명이면 가린 이름)·정답률만 표시하고, 문제 수는 시험 이름 아래에 `총 22문제`로 한 번만 표시. 학생마다 문제 수가 다를 때만 줄마다 표시. 맞은 문제 수는 보여주지 않음). 로그인 전에 누구나 볼 수 있는 공개 데이터라서 **닉네임과 점수만** 나간다(닉네임이 비어 있는 학생만 `홍*동`처럼 가운데 글자를 가린 이름).
(`GET /api/weather?data=exam-ranking` — Vercel 무료 플랜의 서버 함수 12개 제한 때문에 `weather.js`에 같이 두었다. 구현은 `lib/examRanking.js`, `lib/notionPublic.js`.)

**데이터 출처와 한계** — 노션의 공식 API(토큰)가 아니라, "웹에 공개"된 노션 페이지가 화면을 그릴 때 쓰는 내부 주소(`loadCachedPageChunkV2`/`queryCollection`/`syncRecordValuesMain`)를 읽는다.
- 토큰은 필요 없지만, 노션이 화면 구조를 바꾸면 깨질 수 있고 **페이지가 계속 "웹에 공개"여야** 한다. 필요한 열이 없으면 `schema_changed`로 바로 실패하고(잘못된 값을 내보내지 않음), 직전에 성공한 결과를 `stale: true`로 계속 내보낸다.
- `점수`·평균/최고/최저는 노션의 **수식 열**이라 공개 데이터에 값이 없다. 그래서 **점수 = 총문항 − 오답(맞은 문항 수)**, **정답률(%) = 맞은 수 ÷ 총문항**(소수 첫째 자리)으로 서버가 계산하고, 순위는 정답률 기준이다. 노션 수식이 다른 기준(예: 100점 환산)이라면 `lib/notionPublic.js`의 `computeResult`만 고치면 된다.

**규칙**
- 시험DB에서 오늘(KST)까지 치른(날짜·학년이 있는) 시험 중 **최근 90일 안의 시험**만 학년별로 최근 순으로 보고(`MAX_EXAM_AGE_DAYS` — 오래전에 치른 시험은 순위에 쓰지 않으며, 그 학년은 새 시험이 입력될 때까지 대시보드에서 빠진다), **5명 이상 입력된 가장 최근 시험**을 고른다(입력 중인 시험은 건너뜀, `MIN_PARTICIPANTS`). 학생별성적의 `시험지` 연결로 점수를 모아 상위 10명을 만든다(동점은 같은 등수, 10위에 걸린 동점자는 함께 표시).
- **닉네임이 실명을 드러내지 않게 막는다.** 순위에 오른 모든 학생의 이름(학생 페이지 제목)을 한 번에 읽어서, 닉네임이 **없거나 / 실명과 같거나 / 실명을 포함하거나 / 이름(성 뺀 두 글자)을 담았거나 / 실명의 일부(2글자 이상)이면** 서버에서 바로 `홍*동`처럼 가린 이름으로 바꾼다(3글자 `홍*동`, 4글자 `남**수`, 2글자 `이*`, 이름 뒤 괄호 영문 표기는 먼저 제거). 공백·대소문자·괄호는 무시하고, 우연히 글자가 겹치는 오탐은 안전 쪽이라 허용한다. (실제 데이터에서 닉네임이 있는 학생의 약 60%가 닉네임에 실명을 썼다.)
- **다른 학생의 실명을 담은 닉네임도 가린다.** 성적표에 나오는 모든 학생(약 140명)의 이름을 함께 읽어, 닉네임이 (본인이 아닌) 다른 학생의 3글자 이상 실명을 담으면 가린다. 흔한 낱말이 걸리지 않게 전체 이름만 비교한다. 성만 적은 한 글자 닉네임(`박`)은 그대로 보여 준다.
- **새 시험의 빈 닉네임은 이전 시험 닉네임을 이어 쓴다.** 닉네임은 시험마다 손으로 적어서 새 시험은 한동안 비어 있다. 그때는 같은 학생이 이전 시험에 적은 가장 최근 닉네임을 쓰고(이번에 직접 적은 닉네임이 우선), 위의 실명 검사를 똑같이 거친다. 어느 시험에도 닉네임이 없는 학생만 가린 이름이 나간다.
- **확인할 수 없으면 숨긴다.** 이름을 읽지 못한 학생(학생 연결이 없거나 페이지 제목이 비어 있음)은 닉네임이 있어도 `익명`으로 내보내고, 이름 조회 요청 자체가 실패하면 닉네임이 실명인지 확인할 수 없으므로 **순위를 내보내지 않는다**(`name_lookup_failed` → 직전 결과 또는 502). 닉네임은 12자까지, 제어문자는 제거한다.
- **실명은 어디에도 남기지 않는다.** 이름은 요청을 처리하는 동안 지역 변수로만 쓰고 버린다 — 응답·서버 캐시·로그에 없다(가린 값조차 따로 캐시하지 않는다). 응답에는 학생 페이지 id도 없다.
- 한계: 닉네임이 영문 표기·별명처럼 실명과 글자가 겹치지 않으면서 실명을 암시하는 경우는 걸러내지 못한다. 완전히 막으려면 닉네임을 쓰지 않고 항상 가린 이름만 내보내면 된다.
- 서버 메모리 10분 + Vercel 엣지 캐시(5분)로 노션 호출을 줄이고, IP별 시간당 300회로 제한한다. 오류는 502 `notion_unavailable`이고, 화면은 어느 경우든 대시보드를 숨길 뿐 로그인에는 영향이 없다.
- 필요한 열: 시험DB `이름·날짜·학년`, 학생별성적 `시험지·학생이름·닉네임·총문항·오답`. 이름이 바뀌면 `lib/notionPublic.js`의 `REQUIRED_*_PROPS`와 읽는 곳을 같이 고친다.

| 환경변수(모두 선택) | 설명 |
|---|---|
| `NOTION_PUBLIC_HOST` | 공개 노션 호스트(기본 `cool-sailboat-c27.notion.site`) |
| `NOTION_PUBLIC_SCORES_PAGE_ID` / `NOTION_PUBLIC_EXAMS_PAGE_ID` | 학생별성적 / 시험DB 페이지 id(32자리, 기본값 내장) |

테스트: `node backend/lib/notionPublic.test.js` (가짜 fetch, 네트워크·Firebase 불필요)

## 요청 제한 (남용 방지)

**Firebase 규칙** (`database.rules.json`, 콘솔에서 직접 게시) — 로그인한 학생이 직접 쓰는 경로의 연속 쓰기와 모양을 제한한다.
- `messages`(학생→선생님): **3초 간격**. `timestamp`는 서버 시각이어야 하고, **같은 쓰기에서 `writeThrottle/{내uid}/messages`도 서버 시각으로 갱신**해야 받아 준다(규칙은 간격을 저장된 마지막 시각으로만 판단할 수 있다). 학생이 첫 메시지에 가짜 선생님 답글(`replies`)·정의되지 않은 필드를 붙이는 것도 막는다.
- `suggestions`(원장 문의): **30초 간격**, 같은 방식(`writeThrottle/{uid}/suggestions`).
- `device_status`: **20초 간격**(앱은 60초마다 보고), 모양 고정(`battery` 0~100, `lastUpdated` 서버 시각).
- `student_messages`: 학생은 자기 알림의 `read` 표시만 바꿀 수 있다(알림 생성·내용 수정은 선생님만).
- `mathQuizProgress`: 정답 번호(0~99)·`true`·`updatedAt` 모양만 허용.
- 학생 화면(`index.html`)은 `pushWithThrottle()`로 새 글과 제한 기록을 한 번의 `update()`로 저장하고, 3초/30초 안에 다시 누르면 안내 문구를 보여 준다.
- ⚠️ 규칙을 게시하기 **전에** 이 화면 변경이 먼저 배포돼 있어야 한다. 규칙을 먼저 게시하면 예전 화면(캐시된 페이지)에서는 메시지·문의가 거절된다(새로고침하면 정상).
- 검증: `cd backend/rules-test && npm install && npm test` — 실제 Realtime Database 에뮬레이터(Java 필요)로 53개 시나리오를 돌린다. `npm run abuse`는 연타·쓰레기 데이터 시도가 막히는지 숫자로 보여 준다.

**서버 API** — IP별(공개 API) 한도는 `lib/guard.js`의 `rejectIfRateLimited`, **로그인한 계정별** 한도는 `rejectIfUserRateLimited`(UID를 해시해 `rateLimits/user-{버킷}/` 아래에 센다. 관리자·마스터는 제외, DB 오류면 막지 않음).
| API | 한도 |
|---|---|
| `/api/encrypt` | 계정당 분당 60회 |
| `/api/decrypt` | 계정당 분당 300회 |
| `/api/attendance` | 계정당 분당 20회 |
- 초과하면 `429 user_limited` + `Retry-After`. 계산부는 `lib/quota.js`(테스트: `node backend/lib/quota.test.js`).

## 태블릿 허용 사이트

학원 태블릿 앱(브라우저)이 열 수 있는 사이트 목록을 서버에서 관리한다(`lib/tabletSites.js`).

- **저장:** RTDB `config/tabletSites` `{ hosts, updatedAt, updatedBy }` (서버 관리자 SDK만 쓴다). 저장된 게 없으면 내장 기본 목록(우리 사이트·유투엠·매쓰플랫·나이스).
- **앱이 읽기(공개):** `GET /api/weather?data=tablet-sites` → `{ ok, hosts, updatedAt }`. 호스트 이름뿐이라 비밀이 아니며, 서버 캐시 1분 + 엣지 캐시, IP당 한도 1200/시간(학원 태블릿이 같은 공유기를 쓰므로 넉넉히). 읽기에 실패하면 502이고, 앱은 마지막으로 받아 저장해 둔 목록을 계속 쓴다. (Vercel 함수 12개 제한 때문에 `weather.js`의 `data` 갈래로 붙였다.)
- **마스터가 편집:** `POST /api/admin` `action: "tablet-sites-get" | "tablet-sites-set"` (마스터 UID만). 저장 시 `https://`·`www.`·경로를 떼어 호스트로 정리하고, 우리 사이트(`u2mkst.github.io`)는 항상 맨 앞에 넣는다. `co.kr`·`github.io` 같은 공용 도메인(그 아래 모든 사이트가 열림)이나 형식이 틀린 항목이 하나라도 있으면 **아무것도 저장하지 않고** `400 bad_hosts` + `rejected` 목록을 돌려준다. 최대 50개. 화면은 `master.html` "태블릿 허용 사이트".
- **적용 시점:** 앱이 켤 때·10분마다·화면이 다시 켜질 때 받아 온다. 서버 캐시가 있어 저장 후 반영까지 최대 약 1~2분 + 태블릿 갱신 주기(최대 10분).
- 검사 규칙은 앱의 `SiteAccessPolicy.java`와 같아야 한다(바꿀 때 양쪽을 같이). 테스트: `node backend/lib/tabletSites.test.js`.

## 로또

- 1회차 추첨일(2002-12-07 토 20:35 KST)로부터 매주 한 회차. 서버가 "지금 끝났어야 할 회차"를 계산한다.
- 추첨 15분 뒤부터 첫 요청(또는 토요일 21:00 KST 크론)이 외부 API에서 당첨번호를 받아 `lottoDraws/{회차}`에 저장하고 판정한다.
- 접수는 추첨 10분 전에 마감(서버 시각 기준). 학생은 `lotto_predictions`/`lottoDraws`에 직접 쓸 수 없다.

## 스크립트(`scripts/`)

- `backfill-public-students.js`: 랭킹용 공개 노드 채우기(일회성)
- `migrate-student-auth.js`: 기존 학생 계정을 서버 PIN 검증 방식으로 이전(미리보기 → `--apply`)

환경변수 목록은 `.env.example` 참고.

> ⚠️ Vercel 무료(Hobby) 플랜은 `api/` 안의 서버 함수를 **12개까지만** 배포할 수 있다. 새 API는 기존 파일에 `action`으로 묶는 걸 우선 고려할 것.
