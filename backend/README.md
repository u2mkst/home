# KST Backend

Tiny Vercel serverless backend whose only job is to keep two secrets out of
the static frontend (`../index.html`, `../admin.html`, `../master.html`,
`../login.html`):

- the AES passphrase used to "encrypt" student data stored in Firebase
  Realtime Database
- the NEIS Open API key used for school/timetable lookups

## Endpoints

- `POST /api/encrypt` — body `{ "texts": string[] }`, requires
  `Authorization: Bearer <Firebase ID token>`. Returns `{ "results": string[] }`.
- `POST /api/decrypt` — same shape as `/api/encrypt`.
- `GET /api/neis?endpoint=schoolInfo&...` — proxies
  `https://open.neis.go.kr/hub/<endpoint>` with the server-side API key
  attached. `endpoint` must be one of `schoolInfo`, `SchoolSchedule`,
  `elsTimetable`, `misTimetable`, `hisTimetable`. No auth required (also used
  during signup, before the user has a Firebase account).

## Local development

```bash
cd backend
npm install
cp .env.example .env   # fill in AES_KEY, NEIS_API_KEY, FIREBASE_SERVICE_ACCOUNT, ALLOWED_ORIGIN
vercel dev
```

## Deploying

1. Firebase Console → Project settings → Service accounts → **Generate new
   private key**. Keep the downloaded JSON somewhere safe — never commit it.
2. In Vercel, create a new project from this GitHub repo and set **Root
   Directory** to `backend`.
3. Add these Environment Variables in the Vercel project settings:
   - `AES_KEY` — must be the exact same value the frontend used to hardcode
     (`u2mkst!`). Changing it makes existing encrypted data in Firebase
     undecryptable.
   - `NEIS_API_KEY` — the existing NEIS Open API key.
   - `FIREBASE_SERVICE_ACCOUNT` — the full JSON from step 1, collapsed to one
     line.
   - `ALLOWED_ORIGIN` — the frontend's origin, e.g. `https://u2mkst.github.io`.
4. Deploy. Copy the resulting `https://<project>.vercel.app` URL into the
   `BACKEND_URL` constant near the top of each frontend HTML file, then
   commit and push.
