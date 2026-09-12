# K&P 수학입시학원 with KST

K&P 수학입시학원에서 사용하는 학생/강사/관리자용 웹 시스템(KST, K&P System for Teaching)입니다. 순수 정적 HTML/JS/CSS로 만들어져 있고, GitHub Pages로 배포됩니다. 로그인, 출석, 시간표, 성적/랭킹, 게임형 학습 요소, 관리자 도구, 그리고 이 웹앱을 감싸는 안드로이드 키오스크 앱까지 하나의 생태계로 구성되어 있습니다.

## 목차

- [페이지 구성](#페이지-구성)
- [주요 기능](#주요-기능)
- [기술 스택](#기술-스택)
- [저장소 구조](#저장소-구조)
- [백엔드 (backend/)](#백엔드-backend)
- [안드로이드 앱](#안드로이드-앱)
- [배포 방식](#배포-방식)
- [버전 관리 & 릴리스](#버전-관리--릴리스)
- [보안 관련 메모](#보안-관련-메모)

## 페이지 구성

| 파일 | 용도 |
|---|---|
| `login.html` | 로그인/회원가입 진입점. 유투엠(U2M) 계정 인증 후 Firebase Auth로 로그인 |
| `index.html` | 학생용 메인 앱 — 홈/마이페이지/랭킹 3개 뷰로 구성된 SPA에 가까운 단일 페이지 |
| `lite.html` | 로그인 없이 볼 수 있는 라이트 버전 — 학원 로비 키오스크/디스플레이용 (날씨, 시계, 수능 D-Day, 공지 등) |
| `admin.html` | 학원 강사/직원용 관리자 페이지 (학생 관리, 공지, 메시지 등) |
| `master.html` | 최상위 관리자 전용 페이지 — 이메일 화이트리스트로 접근 제한. 컴시간 학교명 오버라이드 등 시스템 설정 담당 |
| `kst.html` | KST 시스템 관리 진입점 — 관리자 비밀번호 인증 후 안드로이드 키오스크 앱(`kst.apk`) 다운로드 및 admin.html 바로가기 제공 |
| `kst.apk` | 학원 키오스크 태블릿에 설치하는 안드로이드 웹뷰 앱 (아래 [안드로이드 앱](#안드로이드-앱) 참고, `u2mkst/app` 레포에서 빌드되어 여기로 자동 배포됨) |

## 주요 기능

**학생(index.html)**
- Firebase Auth 기반 로그인, 유투엠 계정 연동
- 출석 체크 및 월별 누적 출석 기록
- 학교 시간표 조회 — NEIS 공공 API로 우선 표시 후, 컴시간 API 데이터가 도착하면 덮어쓰는 점진적 렌더링(체감 속도 개선)
- 수능 D-Day 배지 (NEIS 학사일정 기반 자동 계산)
- "오늘의 문제" — 학년별 매일 1문제 자동 출제 + Pointer Events 기반 캔버스 스크래치패드(마우스/터치/스타일러스 공용)
- 로또 번호 예측 게임 및 적중 개수 기록
- **업적 배지 도감** — 누적 출석/문제풀이일수/로또 적중 기준으로 배지 잠금 해제, Firebase에 영구 저장 (매일 등원하는 학원이 아니라서 "연속" 개념 대신 "누적" 개념 사용)
- 랭킹 뷰 (누적 통계 기반)
- 선생님 실시간 메시지/공지 수신
- **다크 모드** — 로그인 사용자 전용, 계정(`students/{uid}.darkMode`)에 저장되어 기기 상관없이 유지
- 지정 계정으로 로그인 시 일반 학생 메뉴 대신 마스터 페이지 바로가기 제공

**라이트 버전(lite.html)**: 로그인 불필요, 학원 로비 등 공용 디스플레이 용도로 날씨/시계/D-Day/메뉴만 심플하게 표시

**관리자(admin.html)**: 학생 정보 관리, 공지/메시지 발송 등

**마스터(master.html)**: 이메일 화이트리스트 기반 접근 제어. 컴시간 API와 NEIS 학교명이 불일치하는 경우(예: "광교호수중학교" ↔ 컴시간 "호수중") 학교별 오버라이드를 직접 등록/삭제 가능

## 기술 스택

- **프론트엔드**: 순수 HTML/CSS/JavaScript (빌드 도구 없음), Firebase SDK(compat, v8/v10) 직접 로드
- **인증/DB**: Firebase Authentication + Realtime Database
- **백엔드**: Vercel 서버리스 함수 (Node.js) — `backend/` 폴더, NEIS/컴시간 API 프록시 및 AES 암복호화 담당
- **디자인**: 화이트+블루 플랫 디자인 시스템, CSS 커스텀 프로퍼티(`:root` 토큰) 기반 테마링으로 라이트/다크 모드 지원
- **네이티브 앱**: 안드로이드 웹뷰 앱 (별도 레포 `u2mkst/app`, Kotlin/Gradle)
- **CI/CD**: GitHub Actions (안드로이드 빌드/서명/릴리스 자동화, 웹 릴리스 자동 생성)

## 저장소 구조

```
.
├── login.html          # 로그인
├── index.html          # 학생용 메인 앱
├── lite.html           # 로그인 불필요 라이트 버전
├── admin.html          # 강사/직원 관리자 페이지
├── master.html         # 최상위 관리자 페이지
├── kst.html            # KST 시스템 관리 진입점 (apk 다운로드)
├── kst.apk             # 안드로이드 키오스크 앱 설치 파일 (CI가 자동 갱신)
├── VERSION             # 웹 릴리스 버전 태그 (수동으로 올림)
├── backend/            # Vercel 서버리스 백엔드
│   ├── api/
│   │   ├── neis.js         # NEIS 공공 API 프록시 (학교정보/학사일정/시간표)
│   │   ├── comcigan.js      # 컴시간 시간표 API 프록시 (학교명 자동 보정 포함)
│   │   ├── encrypt.js       # 이름 등 개인정보 AES 암호화 (Firebase Auth 필요)
│   │   └── decrypt.js       # AES 복호화 (Firebase Auth 필요)
│   ├── lib/
│   │   ├── aes.js
│   │   ├── cors.js
│   │   └── firebaseAdmin.js
│   ├── .env.example
│   └── vercel.json
└── .github/workflows/
    └── release.yml      # main에 push될 때마다 GitHub Release 자동 생성
```

## 백엔드 (backend/)

과거 프론트엔드에 하드코딩되어 있던 AES 암호화 키와 NEIS API 키를 숨기기 위한 Vercel 서버리스 백엔드입니다.

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/neis` | NEIS Open API 프록시 (`schoolInfo`, `SchoolSchedule`, `elsTimetable`, `misTimetable`, `hisTimetable`만 허용) |
| `GET /api/comcigan` | 컴시간 시간표 API 프록시. NEIS 학교명으로 조회 실패 시 "학교" 접미사를 뗀 이름으로 자동 재시도 |
| `POST /api/encrypt` | 텍스트 배치 AES 암호화 (Firebase Auth 토큰 필요) |
| `POST /api/decrypt` | 텍스트 배치 AES 복호화 (Firebase Auth 토큰 필요) |

**환경 변수** (Vercel 프로젝트 설정에서 관리, 로컬 테스트 시 `.env` 사용 — `.env.example` 참고):
- `AES_KEY` — 기존 프론트엔드 하드코딩 값과 동일하게 유지해야 함 (다르면 기존 암호화 데이터 복호화 불가)
- `NEIS_API_KEY` — NEIS Open API 키
- `FIREBASE_SERVICE_ACCOUNT` — Firebase 서비스 계정 JSON (한 줄로 압축)
- `ALLOWED_ORIGIN` — CORS 허용 출처 (예: `https://u2mkst.github.io`)

## 안드로이드 앱

키오스크 태블릿에 설치되는 안드로이드 앱(패키지 `com.u2m.kp`)은 별도 레포 **[`u2mkst/app`](https://github.com/u2mkst/app)** 에서 관리됩니다. 이 웹앱(`index.html`/`lite.html`)을 WebView로 감싼 형태입니다.

- `u2mkst/app`의 `main`에 push할 때마다 GitHub Actions가:
  1. 릴리스용 서명된 apk 빌드 (keystore는 GitHub Secrets로만 전달, 저장소에는 절대 커밋되지 않음)
  2. `versionName` 기준 태그로 `u2mkst/app`에 GitHub Release 생성 + apk 첨부
  3. 빌드된 apk를 이 저장소(`u2mkst/home`)의 **`kst.apk`**로 자동 교체 후 커밋/푸시
- 따라서 `kst.html`의 다운로드 버튼은 항상 최신 빌드를 가리킵니다. 수동으로 apk를 올릴 필요가 없습니다.

## 배포 방식

- **웹**: GitHub Pages가 이 저장소의 `main` 브랜치를 그대로 정적 호스팅합니다. `main`에 push되는 즉시 자동 반영됩니다.
- **개발 브랜치**: 작업은 별도 브랜치에서 진행할 수 있지만, GitHub Pages는 오직 `main`만 빌드하므로 배포하려면 결국 `main`에 반영되어야 합니다.
- **백엔드**: `backend/` 디렉터리는 Vercel에 별도로 연결되어 자동 배포됩니다.

## 버전 관리 & 릴리스

이 저장소는 안드로이드 앱처럼 `versionCode`/`versionName` 개념이 없는 정적 웹사이트이기 때문에, 루트의 **`VERSION`** 파일로 릴리스 버전을 수동 관리합니다.

- `main`에 push될 때마다 `.github/workflows/release.yml`이 `VERSION` 파일 내용을 읽어 `v{VERSION}` 태그로 GitHub Release를 생성/갱신합니다. 릴리스 제목에는 배포 날짜가 함께 표기됩니다 (예: `v1.1 (2026.09.12)`).
- **버전 번호 규칙**: 작은 수정은 `1.1`, `1.16`처럼 마이너 버전을 올리고, 큰 개편은 `2`처럼 메이저 버전으로 올립니다.
- `VERSION`을 바꾸지 않고 push하면 같은 태그의 릴리스가 최신 날짜로 갱신됩니다.
- 과거 릴리스 내역은 [Releases 탭](https://github.com/u2mkst/home/releases)에서 확인할 수 있습니다.

## 보안 관련 메모

- AES 키, NEIS API 키, Firebase 서비스 계정 등 민감 정보는 모두 `backend/`의 서버 환경 변수로만 존재하며 저장소에 커밋되지 않습니다.
- 안드로이드 앱 서명용 keystore(`.jks`)는 `u2mkst/app` 저장소에도 절대 커밋되지 않으며, GitHub Actions Secrets를 통해서만 CI에 전달됩니다.
