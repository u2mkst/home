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

로그인 화면 왼쪽 대시보드가 **학년별 가장 최근 시험의 순위**를 보여준다. 로그인 전에 누구나 볼 수 있는 공개 데이터라서 **닉네임과 점수만** 나간다(닉네임이 비어 있는 학생만 `홍*동`처럼 가운데 글자를 가린 이름).
(`GET /api/weather?data=exam-ranking` — Vercel 무료 플랜의 서버 함수 12개 제한 때문에 `weather.js`에 같이 두었다. 구현은 `lib/examRanking.js`, `lib/notionPublic.js`.)

**데이터 출처와 한계** — 노션의 공식 API(토큰)가 아니라, "웹에 공개"된 노션 페이지가 화면을 그릴 때 쓰는 내부 주소(`loadCachedPageChunkV2`/`queryCollection`/`syncRecordValuesMain`)를 읽는다.
- 토큰은 필요 없지만, 노션이 화면 구조를 바꾸면 깨질 수 있고 **페이지가 계속 "웹에 공개"여야** 한다. 필요한 열이 없으면 `schema_changed`로 바로 실패하고(잘못된 값을 내보내지 않음), 직전에 성공한 결과를 `stale: true`로 계속 내보낸다.
- `점수`·평균/최고/최저는 노션의 **수식 열**이라 공개 데이터에 값이 없다. 그래서 **점수 = 총문항 − 오답(맞은 문항 수)**, **정답률(%) = 맞은 수 ÷ 총문항**(소수 첫째 자리)으로 서버가 계산하고, 순위는 정답률 기준이다. 노션 수식이 다른 기준(예: 100점 환산)이라면 `lib/notionPublic.js`의 `computeResult`만 고치면 된다.

**규칙**
- 시험DB에서 오늘(KST)까지 치른(날짜·학년이 있는) 시험 중 **최근 90일 안의 시험**만 학년별로 최근 순으로 보고(`MAX_EXAM_AGE_DAYS` — 오래전에 치른 시험은 순위에 쓰지 않으며, 그 학년은 새 시험이 입력될 때까지 대시보드에서 빠진다), **5명 이상 입력된 가장 최근 시험**을 고른다(입력 중인 시험은 건너뜀, `MIN_PARTICIPANTS`). 학생별성적의 `시험지` 연결로 점수를 모아 상위 10명을 만든다(동점은 같은 등수, 10위에 걸린 동점자는 함께 표시).
- 닉네임은 12자까지, 제어문자는 제거한다. **닉네임이 비어 있으면** 순위에 오른 학생에 한해 학생 페이지의 **제목(이름)만** 읽어 서버에서 바로 가린다: 3글자 `홍*동`, 4글자 `남**수`, 2글자 `이*`(이름 뒤 괄호 영문 표기는 먼저 제거). 실명 전체는 응답·캐시·로그 어디에도 남지 않는다. 읽지 못하면 `익명`. 순위 밖 학생의 이름은 읽지 않는다.
- 서버 메모리 10분 + Vercel 엣지 캐시(5분)로 노션 호출을 줄이고, IP별 시간당 300회로 제한한다. 오류는 502 `notion_unavailable`이고, 화면은 어느 경우든 대시보드를 숨길 뿐 로그인에는 영향이 없다.
- 필요한 열: 시험DB `이름·날짜·학년`, 학생별성적 `시험지·학생이름·닉네임·총문항·오답`. 이름이 바뀌면 `lib/notionPublic.js`의 `REQUIRED_*_PROPS`와 읽는 곳을 같이 고친다.

| 환경변수(모두 선택) | 설명 |
|---|---|
| `NOTION_PUBLIC_HOST` | 공개 노션 호스트(기본 `cool-sailboat-c27.notion.site`) |
| `NOTION_PUBLIC_SCORES_PAGE_ID` / `NOTION_PUBLIC_EXAMS_PAGE_ID` | 학생별성적 / 시험DB 페이지 id(32자리, 기본값 내장) |

테스트: `node backend/lib/notionPublic.test.js` (가짜 fetch, 네트워크·Firebase 불필요)

## 로또

- 1회차 추첨일(2002-12-07 토 20:35 KST)로부터 매주 한 회차. 서버가 "지금 끝났어야 할 회차"를 계산한다.
- 추첨 15분 뒤부터 첫 요청(또는 토요일 21:00 KST 크론)이 외부 API에서 당첨번호를 받아 `lottoDraws/{회차}`에 저장하고 판정한다.
- 접수는 추첨 10분 전에 마감(서버 시각 기준). 학생은 `lotto_predictions`/`lottoDraws`에 직접 쓸 수 없다.

## 스크립트(`scripts/`)

- `backfill-public-students.js`: 랭킹용 공개 노드 채우기(일회성)
- `migrate-student-auth.js`: 기존 학생 계정을 서버 PIN 검증 방식으로 이전(미리보기 → `--apply`)

환경변수 목록은 `.env.example` 참고.

> ⚠️ Vercel 무료(Hobby) 플랜은 `api/` 안의 서버 함수를 **12개까지만** 배포할 수 있다. 새 API는 기존 파일에 `action`으로 묶는 걸 우선 고려할 것.
