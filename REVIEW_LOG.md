# iRang 코드 검토 기록

## 발견된 문제

| 파일 | 문제 내용 | 심각도 |
|------|----------|--------|
| `public/index.html` | `renderCards`에서 API 응답 데이터를 `innerHTML`에 직접 삽입 — XSS 취약점 | 높음 |
| `api/proxy.js` | `ANTHROPIC_API_KEY` 미설정 시 Anthropic에 `x-api-key: undefined`로 요청 후 오류 — 조기 차단 없음 | 높음 |
| `api/proxy.js` | `catch` 블록에서 내부 오류 메시지(`Claude 오류: ...`, `JSON 파싱 실패 \| ...`)를 클라이언트에 그대로 노출 | 중간 |
| `api/proxy.js` | Claude가 빈 배열을 반환할 때 `throw new Error('빈 배열 반환')` → 500 오류 발생, 클라이언트 `emptyBox` 미작동 | 중간 |
| `api/proxy.js` | `export const config = { maxDuration: 60 }` — `vercel.json`의 `functions.api/proxy.js.maxDuration: 60`과 중복 설정 | 낮음 |
| `public/index.html` | `p.verified` 조건부 배지 렌더링 — Claude 도구 스키마에 `verified` 필드 없어 항상 미출력되는 데드 코드 | 낮음 |
| `public/index.html` | `saveSecret()` 후 `secretInput` 값 초기화 안 됨 — 패널을 다시 열면 이전 값 노출 | 낮음 |
| `data/seed.json` | `proxy.js`에서 `loadJSON('seed.json')` 호출 없음 — 파일 존재하나 코드에서 전혀 사용 안 됨 | 낮음 |

---

## 수정 내용

| 파일 | 수정 전 | 수정 후 | 이유 |
|------|--------|--------|------|
| `api/proxy.js` | `export const config = { maxDuration: 60 };` | 삭제 | `vercel.json`에 동일 설정이 이미 존재하는 중복 코드 |
| `api/proxy.js` | `ANTHROPIC_KEY` 미설정 검사 없음 — 핸들러 진입 후 API 호출 실패로 뒤늦게 감지 | 핸들러 상단에 `if (!ANTHROPIC_KEY)` 조기 차단 + `console.error` 추가 | 환경변수 미설정 시 명확한 오류 로그 및 사용자 안내 메시지 반환 |
| `api/proxy.js` | `throw new Error('빈 배열 반환')` → 500 응답 | `return res.status(200).json({ places: [], debug: {...} })` | 빈 결과는 정상 케이스이므로 200으로 처리, 프론트의 `emptyBox`가 올바르게 표시됨 |
| `api/proxy.js` | `catch (err) { res.status(500).json({ error: err.message \|\| '알 수 없는 오류' }) }` | `console.error('proxy error:', err.message)` 후 클라이언트엔 `'장소 검색 중 오류가 발생했습니다...'` 반환 | 내부 API 오류 메시지(Claude API 키, JSON 파싱 스택 등) 클라이언트 노출 차단 |
| `public/index.html` | `renderCards`에서 `p.name`, `p.location`, `p.desc`, `p.baby_point`, `p.cost`, `p.tip`, `p.indoor`를 `innerHTML`에 직접 삽입 | `escHtml()` 함수 추가 후 모든 동적 값에 적용 | XSS 방어 — LLM이 `<script>` 등 HTML을 반환할 경우 실행 차단 |
| `public/index.html` | `(p.verified ? '<span class="verified-badge">검증됨</span>' : '')` | 해당 줄 전체 제거 | Claude 도구 스키마에 `verified` 필드가 없어 항상 `undefined`(falsy)이므로 데드 코드 |
| `public/index.html` | `saveSecret()` — 저장 후 input 값 유지 | `document.getElementById('secretInput').value = '';` 추가 | 패널 재오픈 시 이전 비밀번호 값 노출 방지 |

---

## 수정 못한 것 (외부 확인 필요)

- **`data/seed.json` 미사용**: 파일에 부산·경남 지역 장소 데이터가 잘 정리되어 있으나 `proxy.js`에서 전혀 로드하지 않음. 원래 검색 폴백 또는 검증 소스로 사용 예정이었던 것으로 보임. 사용 여부 결정 필요 (사용할 경우 `loadJSON('seed.json')`으로 로드 후 `uniqueResults`에 병합하는 로직 추가 필요)
- **`APP_SECRET` 미설정 시 동작**: `process.env.APP_SECRET`이 설정되지 않으면 `secret !== undefined`가 항상 true가 되어 모든 요청이 403 거부됨. 의도된 동작이지만 Vercel 환경변수 설정 여부를 배포 전 반드시 확인 필요
- **Naver API 인증 실패 시 조용히 빈 배열 반환**: `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET` 미설정 시 401로 실패하지만 `.then(r => r.ok ? r.json() : { items: [] })`로 빈 배열 처리 — 로그가 없어 디버깅 어려움. Vercel 로그 확인 권장
- **TourAPI `arrange=Q` (평점순) 파라미터**: 공공데이터포털 TourAPI는 평점 데이터 수집을 별도 신청해야 지원됨. 인증 없으면 기본 정렬로 동작할 수 있으므로 API 결과 확인 권장
- **`vercel.json` rewrite 경로 누수**: `{ "source": "/(.*)", "destination": "/public/$1" }` 규칙으로 인해 `/public/index.html` 직접 접근 시 `/public/public/index.html`로 내부 rewrite되어 404 발생 가능. 실제 사용자에게 노출될 경로는 아니나 필요 시 `source: "/public/(.*)"` 제외 규칙 추가 검토 필요
