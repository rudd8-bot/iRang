# iRang DEVLOG

## 2026-06-14

### 안정화 (버그 2건 수정 완료)

**버그 A — 접근코드 입력칸 안 뜸**
- 원인: public/index.html의 saveSecret/toggleSecret가 IIFE 내부 정의됨. HTML onclick은 전역(window) 조회 → 함수 안 보여 클릭 무반응.
- 수정: 두 함수를 window.* 로 노출 (getSecret은 내부 전용 유지).
- 커밋 f38b5ce, Vercel READY.

**버그 B — JSON 파싱 실패**
- 원인: Haiku가 ```json 코드펜스 부착 반환. max_tokens 1200 잘림 가능성도 있었음.
- 수정: api/proxy.js — max_tokens 1200→4000, extractPlaces() 신설(코드펜스 제거 + 잘림 시 마지막 완전객체까지 복구 fallback), stop_reason 로깅 추가.
- 커밋 cf3d274, Vercel READY, 7곳 렌더 정상 확인.

### 주변검색 거리필터 — 조사 (미구현, 테스트만 후 원복)

**확인된 사실**
- "주변 탐색"은 프롬프트에 "OO구 인근 우선" 문장만 추가. 거리 hard filter 없음 → LLM 부탁일 뿐 강제 아님.
- 이동거리 "30분 이내" 설정에도 창원/양산/거제 노출됨(입증). 이동거리값도 프롬프트 조건일 뿐 강제 안 됨.

**구현 옵션**
- ① 지역(구/시) 텍스트 필터: location 필드 검사. 카카오 추가호출 X. 최소 변경.
- ② 실거리 km 필터: 결과 7곳 카카오 재지오코딩 + Haversine + 이동거리→km 매핑.
  - 타임아웃: 병렬 시 +1~3초, 60초 내 OK.
  - 핵심 리스크: 결과 장소명 매칭 실패율(미측정). 좌표없음 처리정책 필요.

**테스트 루프 (순수 테스트, cf3d274 원복 완료)**
- 진단 로그 push(0a4d7f7) → 검색 실행 → 로그 도구 멀티라인 잘림으로 매칭률 미확보 → 원복 push(46b6414) → read 대조로 cf3d274 일치 검증 완료.

**다음 작업**
- 거리필터 본구현 전 결과 매칭률 실측 선행 필요. Vercel 로그 도구 잘림 회피책 설계 필요(응답 JSON에 진단 임시 노출 등).

### 도구 제약 메모
- worker-mcp: push/read만, 삭제 불가 → 단일 파일 수정/원복 방식이 정석.
- Vercel:web_fetch_vercel_url: GET만, POST/헤더 주입 불가 → secret 게이트 POST 직접 호출 불가.
- Vercel 런타임 로그 도구: 한 요청의 첫 console.log만 표시, 멀티라인 잘림.
