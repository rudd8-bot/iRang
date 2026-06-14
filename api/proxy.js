import { readFileSync } from 'fs';
import { join } from 'path';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY;
const APP_SECRET = process.env.APP_SECRET;

export const config = { maxDuration: 60 };

// 지역 레이블 맵
const regionLabelMap = {
  busan_gyeongnam: '부산광역시·경상남도',
  daegu_gyeongbuk: '대구광역시·경상북도',
  chungcheong_daejeon: '충청도·대전광역시·세종시',
  gangwon: '강원특별자치도',
  jeolla_gwangju: '전라도·광주광역시',
  jeju: '제주특별자치도',
  seoul_gyeonggi: '서울특별시·경기도',
};

// 지역별 타지역 오류 방지 가이드
const regionGuideMap = {
  busan_gyeongnam: '부산광역시·경상남도(창원·김해·양산·거제·통영·진주·사천 포함). 울산·대구·전라도 등 타지역 절대 금지.',
  daegu_gyeongbuk: '대구광역시·경상북도(경주·포항·안동·구미·영주 포함). 부산·울산·경남 등 타지역 절대 금지.',
  chungcheong_daejeon: '충청도·대전광역시·세종시(천안·청주·충주·공주·보령 포함). 전라도·경상도 등 타지역 절대 금지.',
  gangwon: '강원특별자치도(춘천·강릉·원주·속초·동해·삼척·평창 포함). 타 시도 절대 금지.',
  jeolla_gwangju: '전라도·광주광역시(전주·여수·순천·목포·광양 포함). 경상도·충청도 등 타지역 절대 금지.',
  jeju: '제주특별자치도(제주시·서귀포시). 육지 지역 절대 금지.',
  seoul_gyeonggi: '서울특별시·경기도(수원·성남·고양·용인·부천·안산·안양·남양주·화성 포함). 인천·강원 등 타지역 절대 금지.',
};

function loadJSON(filename) {
  const candidates = [
    join(process.cwd(), 'data', filename),
    join('/var/task', 'data', filename),
  ];
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch {}
  }
  return null;
}

// ===== [진단 전용 - 테스트 후 원복 예정] =====
// 두 좌표 간 직선거리(km). Haversine.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 장소명 → 좌표 1개 (카카오 keyword). 실패 시 null.
async function geocodePlace(name) {
  if (!name || !KAKAO_REST_KEY) return null;
  try {
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(name)}&size=1`;
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const doc = data.documents?.[0];
    if (!doc) return null;
    return { lat: parseFloat(doc.y), lng: parseFloat(doc.x), matched: doc.place_name, addr: doc.address_name };
  } catch {
    return null;
  }
}
// ===== [진단 전용 끝] =====

// 카카오 장소 검색 → 구(區) 이름 추출
async function getDistrictFromPlace(placeName) {
  if (!placeName || !KAKAO_REST_KEY) return null;
  try {
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(placeName)}&size=1`;
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const doc = data.documents?.[0];
    if (!doc) return null;
    // address_name 예: "부산광역시 해운대구 우동 123"
    const parts = doc.address_name?.split(' ') || [];
    // 시/도(0), 구/군(1) 추출
    const district = parts[1] || null; // 예: "해운대구"
    const city = parts[0] || null;     // 예: "부산광역시"
    return { district, city, fullAddress: doc.address_name, placeName: doc.place_name, lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
  } catch {
    return null;
  }
}

async function searchNaver(query) {
  try {
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=3&sort=date`;
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(i => ({
      title: i.title.replace(/<[^>]+>/g, ''),
      description: i.description.replace(/<[^>]+>/g, '').slice(0, 100),
    }));
  } catch {
    return [];
  }
}

function buildNaverQuery(filters, patterns, districtInfo) {
  const { weather, age, categories, region } = filters;

  const ageKeyMap = {
    '12개월': 'age_12_months',
    '24개월': 'age_24_months',
    '36개월': 'age_36_months',
    '48개월': 'age_48_months',
    '60개월 이상': 'age_60_months',
  };
  const weatherKeyMap = {
    '맑음, 야외 OK': 'weather_clear',
    '비·흐림, 실내 위주': 'weather_rainy',
    '겨울·추위, 실내 위주': 'weather_winter',
    '여름·더위, 더위 피하기': 'weather_summer',
  };
  const categoryKeyMap = {
    '자연·힐링': 'category_nature',
    '문화·예술': 'category_culture',
    '먹거리 중심': 'category_food',
    '축제·이벤트': 'category_festival',
    '트렌드': 'category_trend',
  };

  // 구 정보 있으면 구 단위 쿼리 우선
  const areaPrefix = districtInfo?.district || null;

  const regionKey = region || 'busan_gyeongnam';
  const qp = patterns?.[regionKey];

  if (qp) {
    if (categories?.length) {
      for (const cat of categories) {
        const catKey = categoryKeyMap[cat];
        if (catKey && qp[catKey]?.[0]) {
          // 구 정보 있으면 쿼리 앞에 구 이름 붙이기
          return areaPrefix ? `${areaPrefix} ${qp[catKey][0]}` : qp[catKey][0];
        }
      }
    }
    if (age && ageKeyMap[age] && qp[ageKeyMap[age]]?.[0]) {
      return areaPrefix ? `${areaPrefix} ${qp[ageKeyMap[age]][0]}` : qp[ageKeyMap[age]][0];
    }
    if (weather && weatherKeyMap[weather] && qp[weatherKeyMap[weather]]?.[0]) {
      return areaPrefix ? `${areaPrefix} ${qp[weatherKeyMap[weather]][0]}` : qp[weatherKeyMap[weather]][0];
    }
  }

  const regionLabel = regionLabelMap[regionKey]?.split('·')[0] || '부산';
  const area = areaPrefix || regionLabel;
  const isTrend = categories?.includes('트렌드');
  if (isTrend) return `${area} 아기랑 ${new Date().getFullYear()} 핫플`;
  return `${area} 아기랑 나들이`;
}

function resolveIndoor(indoor, weather) {
  if (indoor && indoor !== '상관없음') return indoor;
  if (weather?.includes('실내')) return '실내 위주';
  return null;
}

// Claude 응답 텍스트에서 JSON 배열을 안전하게 추출.
function extractPlaces(rawText) {
  if (!rawText) return null;

  let clean = rawText
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/```/g, '')
    .trim();

  const start = clean.indexOf('[');
  if (start === -1) return null;

  const end = clean.lastIndexOf(']');

  if (end !== -1 && end > start) {
    const slice = clean.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      // 아래 복구 로직으로 진행
    }
  }

  const body = clean.slice(start);
  const lastObjEnd = body.lastIndexOf('}');
  if (lastObjEnd === -1) return null;

  let repaired = body.slice(0, lastObjEnd + 1).trim();
  repaired = repaired.replace(/,\s*$/, '');
  repaired = repaired + ']';

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // APP_SECRET 검증
  const reqSecret = req.headers['x-app-secret'];
  if (APP_SECRET && reqSecret !== APP_SECRET) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }

  const { filters } = req.body || {};
  if (!filters || typeof filters !== 'object') {
    return res.status(400).json({ error: '필터 값이 없어요.' });
  }

  try {
    const patterns = loadJSON('patterns.json');

    // 카카오로 장소 → 구 추출 (입력 있을 때만)
    const districtInfo = filters.nearPlace
      ? await getDistrictFromPlace(filters.nearPlace)
      : null;

    const query = buildNaverQuery(filters, patterns, districtInfo);
    const naverResults = await searchNaver(query);

    const resolvedIndoor = resolveIndoor(filters.indoor, filters.weather);
    const isTrend = filters.categories?.includes('트렌드');
    const otherCats = (filters.categories || []).filter(c => c !== '트렌드');

    const suitable = ['유모차 이동 가능', '수유실 또는 유아휴게실', '기저귀교환대', '낮은 자극·낮은 난이도'];
    const unsuitable = ['유모차 반입·이동 불가', '수유실·기저귀교환대 모두 없음', '소음·대기줄·혼잡이 심함'];

    const regionKey = filters.region || 'busan_gyeongnam';
    const regionLabel = regionLabelMap[regionKey] || '부산광역시·경상남도';
    const regionGuide = regionGuideMap[regionKey] || regionLabel + ' 장소만.';

    // 구 정보 있으면 프롬프트에 구 단위 제한 추가
    const districtClause = districtInfo?.district
      ? `\n[주변 탐색] "${filters.nearPlace}" 기준 — ${districtInfo.district} 및 인접 구/동 장소 우선 추천.`
      : '';

    const prompt = `${regionLabel} 영아 동반 나들이 추천 도우미.

[규칙] ${regionGuide} 실내외 조건 우선.${resolvedIndoor ? ` "${resolvedIndoor}" 필수 적용.` : ''}${districtClause}

[조건] 날씨:${filters.weather||'무관'} / 실내외:${resolvedIndoor||'무관'} / 거리:${filters.distance||'무관'} / 예산:${filters.budget||'무관'} / 월령:${filters.age||'무관'} / 경험:${otherCats.join(',')||'무관'}${isTrend?' / 트렌드 포함':''}

[네이버 최신 후기]
${naverResults.map(r => `- ${r.title}: ${r.description}`).join('\n') || '없음'}

[영아 적합 기준] 있으면 좋음:${suitable.join(',')} / 없으면 제외:${unsuitable.join(',')}

${regionLabel} 장소 7곳 추천.${districtInfo?.district ? ` ${districtInfo.district} 인근 우선.` : ''} 카테고리 선택 시 해당 카테고리 장소만. 네이버 결과 우선, 부족하면 지식 보완.${isTrend?' 트렌드는 최근 6개월 핫플.':''}

반드시 JSON 배열만 출력. 설명 문장 절대 금지. 첫 글자 [, 마지막 글자 ]:
[{"name":"장소명","category":"자연·힐링/교육·체험/문화·예술/시장·쇼핑/놀이·액티비티/먹거리 중심/축제·이벤트/트렌드 중 하나","location":"OO구 또는 OO시","desc":"한 줄","baby_point":"영아 포인트","tip":"방문 팁","indoor":"실내/실외/혼합","cost":"무료/1만원 이하/5만원 이하/그 이상"}]`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      throw new Error('Claude 오류: ' + (err.error?.message || claudeRes.status));
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content.filter(i => i.type === 'text').map(i => i.text).join('');
    const stopReason = claudeData.stop_reason;
    console.log('Claude raw:', text);
    console.log('stop_reason:', stopReason);
    console.log('District info:', districtInfo);

    const places = extractPlaces(text);
    if (!places || !Array.isArray(places)) {
      console.error('파싱 실패 - stop_reason:', stopReason, '| raw 앞부분:', text.slice(0, 300));
      throw new Error('JSON 파싱 실패: Claude가 올바른 형식을 반환하지 않았어요. 다시 시도해주세요.');
    }

    // ===== [진단 전용 - 테스트 후 원복 예정] =====
    // nearPlace 있고 입력장소 좌표 잡혔을 때만, 결과 7곳 지오코딩 + 거리 측정해 로그로만 출력.
    // 결과(places)는 변경하지 않음. 화면 동작 동일.
    try {
      if (filters.nearPlace && districtInfo && districtInfo.lat && districtInfo.lng) {
        const originLat = districtInfo.lat, originLng = districtInfo.lng;
        const geos = await Promise.all(
          places.map(p => geocodePlace(p.name + (p.location ? ' ' + p.location : '')))
        );
        const diag = places.map((p, i) => {
          const g = geos[i];
          if (!g) return { name: p.name, location: p.location, matched: false, distKm: null };
          return {
            name: p.name,
            location: p.location,
            matched: true,
            matchedName: g.matched,
            matchedAddr: g.addr,
            distKm: Math.round(haversineKm(originLat, originLng, g.lat, g.lng) * 10) / 10,
          };
        });
        const hit = diag.filter(d => d.matched).length;
        console.log('GEO_DIAG_ORIGIN:', JSON.stringify({ nearPlace: filters.nearPlace, lat: originLat, lng: originLng }));
        console.log('GEO_DIAG_MATCH_RATE:', hit + '/' + places.length);
        console.log('GEO_DIAG_RESULTS:', JSON.stringify(diag));
      } else {
        console.log('GEO_DIAG_SKIP: nearPlace 또는 입력장소 좌표 없음', JSON.stringify({ nearPlace: filters.nearPlace || null, hasCoord: !!(districtInfo && districtInfo.lat) }));
      }
    } catch (diagErr) {
      console.error('GEO_DIAG_ERROR:', diagErr.message);
    }
    // ===== [진단 전용 끝] =====

    // 구 정보 같이 반환 (프론트에서 표시용)
    res.status(200).json({ places, districtInfo });

  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}
