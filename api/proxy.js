import { readFileSync } from 'fs';
import { join } from 'path';

const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const NAVER_ID         = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET     = process.env.NAVER_CLIENT_SECRET;
const TOUR_API_KEY     = process.env.TOUR_API_KEY;
const KAKAO_REST_KEY   = process.env.KAKAO_REST_KEY;

export const config = { maxDuration: 60 };

// ── 지역 설정 ──────────────────────────────────────────────
const regionLabelMap = {
  busan_gyeongnam:     '부산광역시·경상남도',
  daegu_gyeongbuk:     '대구광역시·경상북도',
  chungcheong_daejeon: '충청도·대전광역시·세종시',
  gangwon:             '강원특별자치도',
  jeolla_gwangju:      '전라도·광주광역시',
  jeju:                '제주특별자치도',
  seoul_gyeonggi:      '서울특별시·경기도',
};

const regionGuideMap = {
  busan_gyeongnam:     '부산광역시·경상남도(창원·김해·양산·거제·통영·진주·사천 포함). 울산·대구·전라도 등 타지역 절대 금지.',
  daegu_gyeongbuk:     '대구광역시·경상북도(경주·포항·안동·구미·영주 포함). 부산·울산·경남 등 타지역 절대 금지.',
  chungcheong_daejeon: '충청도·대전광역시·세종시(천안·청주·충주·공주·보령 포함). 전라도·경상도 등 타지역 절대 금지.',
  gangwon:             '강원특별자치도(춘천·강릉·원주·속초·동해·삼척·평창 포함). 타 시도 절대 금지.',
  jeolla_gwangju:      '전라도·광주광역시(전주·여수·순천·목포·광양 포함). 경상도·충청도 등 타지역 절대 금지.',
  jeju:                '제주특별자치도(제주시·서귀포시). 육지 지역 절대 금지.',
  seoul_gyeonggi:      '서울특별시·경기도(수원·성남·고양·용인·부천·광명 등 포함). 강원·충청 등 타 시도 절대 금지.',
};

// TourAPI 지역코드
const tourAreaCodeMap = {
  busan_gyeongnam:     ['6', '38'],
  daegu_gyeongbuk:     ['4', '35'],
  chungcheong_daejeon: ['34', '33', '36'],
  gangwon:             ['32'],
  jeolla_gwangju:      ['37', '29'],
  jeju:                ['39'],
  seoul_gyeonggi:      ['1', '31'],
};

// ── 카테고리 설정 ───────────────────────────────────────────
const categoryKeyMap = {
  '자연·힐링':     'category_nature',
  '교육·체험':     'category_culture',
  '문화·예술':     'category_culture',
  '시장·쇼핑':     'category_market',
  '놀이·액티비티': 'category_play',
  '먹거리 중심':   'category_food',
  '축제·이벤트':   'category_festival',
  '트렌드':        'category_trend',
};

const categoryForceMap = {
  '자연·힐링':     '자연공원·숲·계곡·바다·힐링 장소만. 식당·박물관 제외.',
  '교육·체험':     '박물관·체험관·과학관·도서관 위주.',
  '문화·예술':     '미술관·공연장·문화센터·전시관 위주.',
  '시장·쇼핑':     '전통시장·쇼핑몰·아울렛 위주.',
  '놀이·액티비티': '키즈카페·실내놀이터·테마파크·액티비티 위주.',
  '먹거리 중심':   '식당·맛집·카페·베이커리만. 반드시 음식점만 추천.',
  '축제·이벤트':   '현재 진행 중이거나 예정된 축제·이벤트·계절행사 위주.',
  '트렌드':        '최근 6개월 내 SNS·블로그에서 주목받는 신규 핫플 위주.',
};

// TourAPI 카테고리코드
const tourContentTypeMap = {
  '자연·힐링':     '12',  // 관광지
  '교육·체험':     '14',  // 문화시설
  '문화·예술':     '14',
  '시장·쇼핑':     '38',  // 쇼핑
  '놀이·액티비티': '28',  // 레포츠
  '먹거리 중심':   '39',  // 음식점
  '축제·이벤트':   '15',  // 행사
  '트렌드':        '12',
};

// ── JSON 유틸 ───────────────────────────────────────────────
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

// ── 네이버 검색 (blog/cafe/news/local 병렬) ────────────────
async function searchNaver(query, regionLabel) {
  const headers = {
    'X-Naver-Client-Id': NAVER_ID,
    'X-Naver-Client-Secret': NAVER_SECRET,
  };
  const encQ = encodeURIComponent(query);
  const localQ = encodeURIComponent(`${regionLabel.split('·')[0]} ${query}`);

  const endpoints = [
    `https://openapi.naver.com/v1/search/blog.json?query=${encQ}&display=5&sort=date`,
    `https://openapi.naver.com/v1/search/cafe.json?query=${encQ}&display=5&sort=date`,
    `https://openapi.naver.com/v1/search/news.json?query=${encQ}&display=3&sort=date`,
    `https://openapi.naver.com/v1/search/local.json?query=${localQ}&display=5`,
  ];

  const results = await Promise.allSettled(
    endpoints.map(url =>
      fetch(url, { headers, signal: AbortSignal.timeout(4000) })
        .then(r => r.ok ? r.json() : { items: [] })
        .then(d => (d.items || []).map(i => ({
          title: i.title?.replace(/<[^>]+>/g, '') || '',
          description: (i.description || i.roadAddress || i.address || '')
            .replace(/<[^>]+>/g, '').slice(0, 120),
        })))
        .catch(() => [])
    )
  );

  return results.flatMap(r => r.value || []);
}

// ── TourAPI 검색 ────────────────────────────────────────────
async function searchTourAPI(regionKey, categories) {
  if (!TOUR_API_KEY) return [];

  const areaCodes = tourAreaCodeMap[regionKey] || ['6'];
  const contentTypeId = categories?.length > 0
    ? (tourContentTypeMap[categories[0]] || '12')
    : '12';

  try {
    const results = await Promise.allSettled(
      areaCodes.map(areaCode => {
        // serviceKey는 이중인코딩 방지를 위해 직접 문자열 조합
        const baseUrl = 'https://apis.data.go.kr/B551011/KorService1/areaBasedList1';
        const params = [
          `serviceKey=${TOUR_API_KEY}`,
          `areaCode=${areaCode}`,
          `contentTypeId=${contentTypeId}`,
          `numOfRows=10`,
          `pageNo=1`,
          `MobileOS=ETC`,
          `MobileApp=iRang`,
          `_type=json`,
          `arrange=Q`,
        ].join('&');
        const tourUrl = `${baseUrl}?${params}`;

        return fetch(tourUrl, { signal: AbortSignal.timeout(5000) })
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            const items = d?.response?.body?.items?.item || [];
            return items.map(i => ({
              title: i.title || '',
              description: `${i.addr1 || ''} ${i.addr2 || ''}`.trim(),
            }));
          })
          .catch(() => []);
      })
    );
    return results.flatMap(r => r.value || []);
  } catch {
    return [];
  }
}

// ── 카카오맵 검색 ───────────────────────────────────────────
async function searchKakao(query, regionLabel) {
  if (!KAKAO_REST_KEY) return [];

  try {
    const regionCity = regionLabel.split('·')[0];
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(regionCity + ' ' + query + ' 아이랑')}&size=10`;
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('카카오 오류:', res.status, errText.slice(0, 100));
      return [];
    }
    const data = await res.json();
    return (data.documents || []).map(d => ({
      title: d.place_name || '',
      description: `${d.address_name || ''} ${d.category_name || ''}`.trim(),
    }));
  } catch (e) {
    console.error('카카오 예외:', e.message);
    return [];
  }
}

// ── 네이버 쿼리 빌드 ────────────────────────────────────────
function buildNaverQuery(filters, patterns) {
  const { weather, age, categories, region } = filters;
  const regionKey = region || 'busan_gyeongnam';

  const ageKeyMap = {
    '12개월': 'age_12_months',
    '24개월': 'age_24_months',
    '36개월': 'age_36_months',
    '48개월': 'age_48_months',
    '60개월 이상': 'age_60_months',
  };
  const weatherKeyMap = {
    '맑음, 야외 OK':          'weather_clear',
    '비·흐림, 실내 위주':     'weather_rainy',
    '겨울·추위, 실내 위주':   'weather_winter',
    '여름·더위, 더위 피하기': 'weather_summer',
  };

  if (patterns) {
    const qp = patterns[regionKey] || {};
    const ageKey = ageKeyMap[age];
    if (ageKey && qp[ageKey]?.[0]) return qp[ageKey][0];
    const weatherKey = weatherKeyMap[weather];
    if (weatherKey && qp[weatherKey]?.[0]) return qp[weatherKey][0];
    const cat = (categories || []).find(c => categoryKeyMap[c]);
    if (cat) {
      const catKey = categoryKeyMap[cat];
      if (qp[catKey]?.[0]) return qp[catKey][0];
    }
  }

  // 폴백
  const regionLabel = regionLabelMap[regionKey] || '부산광역시·경상남도';
  const city = regionLabel.split('·')[0];
  const indoorStr = filters.indoor === '실내 위주' ? ' 실내' : '';
  const isTrend = categories?.includes('트렌드');
  if (isTrend) return `${city} 아기랑 ${new Date().getFullYear()} 핫플${indoorStr}`;
  const validCats = (categories || []).filter(c => c && c !== '트렌드');
  return `${city} ${age || '아기랑'} ${validCats[0] || '나들이'}${indoorStr}`;
}

function resolveIndoor(indoor, weather) {
  if (indoor && indoor !== '상관없음') return indoor;
  if (weather?.includes('실내')) return '실내 위주';
  return null;
}

// ── 메인 핸들러 ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-app-secret'];
  if (!secret || secret !== process.env.APP_SECRET) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }

  const { filters } = req.body || {};
  if (!filters || typeof filters !== 'object') {
    return res.status(400).json({ error: '필터 값이 없어요.' });
  }

  try {
    const patterns   = loadJSON('patterns.json');
    const regionKey  = filters.region || 'busan_gyeongnam';
    const regionLabel = regionLabelMap[regionKey] || '부산광역시·경상남도';
    const regionGuide = regionGuideMap[regionKey] || regionGuideMap['busan_gyeongnam'];
    const regionCity  = regionLabel.split('·')[0];
    const regionSub   = regionLabel.split('·')[1] || '';

    const query          = buildNaverQuery(filters, patterns);
    const resolvedIndoor = resolveIndoor(filters.indoor, filters.weather);
    const isTrend        = filters.categories?.includes('트렌드');
    const otherCats      = (filters.categories || []).filter(c => c !== '트렌드');

    // ── 병렬 데이터 수집 ──────────────────────────────────
    const [naverResults, tourResults, kakaoResults] = await Promise.all([
      searchNaver(query, regionLabel),
      searchTourAPI(regionKey, otherCats),
      searchKakao(query, regionLabel),
    ]);

    // 전체 데이터 합치기 (중복 제거)
    const allResults = [...naverResults, ...tourResults, ...kakaoResults];
    const seen = new Set();
    const uniqueResults = allResults.filter(r => {
      if (!r.title || seen.has(r.title)) return false;
      seen.add(r.title);
      return true;
    });

    const catForce = otherCats.length > 0
      ? otherCats.map(c => categoryForceMap[c]).filter(Boolean).join(' ')
      : '';

    const suitable   = ['유모차 이동 가능', '수유실 또는 유아휴게실', '기저귀교환대'];
    const unsuitable = ['유모차 반입 불가', '수유실·기저귀교환대 모두 없음', '소음·혼잡 심함'];

    const dataText = uniqueResults.slice(0, 20)
      .map(r => `- ${r.title}: ${r.description}`)
      .join('\n') || '없음';

    const prompt = `영아 동반 나들이 추천 도우미.

[지역 규칙] ${regionGuide}
위 지역 외 장소 단 1곳도 금지. location은 반드시 ${regionCity} 또는 ${regionSub} 행정구역으로 시작.

[실내외] ${resolvedIndoor ? `"${resolvedIndoor}" 필수. 위반 장소 제외.` : '무관'}

[카테고리 강제] ${catForce || '무관, 다양하게 추천'}
카테고리 지정 시 해당 유형만. 다른 유형 혼입 금지.${isTrend ? ' 트렌드: 최근 6개월 핫플만.' : ''}

[조건] 날씨:${filters.weather || '무관'} / 거리:${filters.distance || '무관'} / 예산:${filters.budget || '무관'} / 월령:${filters.age || '무관'}

[수집된 실제 데이터 - 이 중에서 우선 선택]
${dataText}

[영아 적합] 좋음:${suitable.join(',')} / 제외:${unsuitable.join(',')}

위 데이터에서 조건에 맞는 장소 우선. 부족하면 지식으로 보완.
${regionLabel} 장소 정확히 7곳.

순수 JSON 배열만:
[{"name":"장소명","category":"자연·힐링/교육·체험/문화·예술/시장·쇼핑/놀이·액티비티/먹거리 중심/축제·이벤트/트렌드 중 하나","location":"${regionCity} OO구 또는 ${regionSub} OO시","desc":"한 줄","baby_point":"영아 포인트","tip":"방문 팁","indoor":"실내/실외/혼합","cost":"무료/1만원 이하/5만원 이하/그 이상"}]`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        system: '당신은 JSON만 출력하는 API입니다. 반드시 JSON 배열만 출력하세요. 설명·사과·마크다운 코드블록 절대 금지. [ 로 시작해서 ] 로 끝나야 합니다.',
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          name: 'recommend_places',
          description: '장소 추천 결과 반환',
          input_schema: {
            type: 'object',
            properties: {
              places: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name:       { type: 'string' },
                    category:   { type: 'string', enum: ['자연·힐링','교육·체험','문화·예술','시장·쇼핑','놀이·액티비티','먹거리 중심','축제·이벤트','트렌드'] },
                    location:   { type: 'string' },
                    desc:       { type: 'string' },
                    baby_point: { type: 'string' },
                    tip:        { type: 'string' },
                    indoor:     { type: 'string', enum: ['실내','실외','혼합'] },
                    cost:       { type: 'string' },
                  },
                  required: ['name','category','location','indoor','desc']
                }
              }
            },
            required: ['places']
          }
        }],
        tool_choice: { type: 'tool', name: 'recommend_places' },
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      throw new Error('Claude 오류: ' + (err.error?.message || claudeRes.status));
    }

    const claudeData = await claudeRes.json();

    // tool_use 응답 파싱 (enum 강제 사용 시)
    let places;
    const toolUseBlock = claudeData.content?.find(i => i.type === 'tool_use');
    if (toolUseBlock) {
      places = toolUseBlock.input?.places;
    } else {
      // 폴백: 텍스트 파싱 (tool_use 없음 - enum 미적용 상태)
      console.error('tool_use 블록 없음 - 텍스트 폴백 사용. content types:', 
        claudeData.content?.map(i => i.type).join(','));
      const text  = claudeData.content?.filter(i => i.type === 'text').map(i => i.text).join('') || '';
      const clean = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
      const s = clean.indexOf('['), e = clean.lastIndexOf(']');
      if (s === -1 || e === -1) {
        throw new Error('JSON 파싱 실패 | Claude 응답: ' + clean.slice(0, 200));
      }
      try {
        places = JSON.parse(clean.slice(s, e + 1));
      } catch (parseErr) {
        throw new Error('JSON 구문 오류 | ' + parseErr.message);
      }
    }

    if (!Array.isArray(places) || places.length === 0) {
      throw new Error('빈 배열 반환');
    }

    // ── 후처리: 타지역 필터 ──────────────────────────────
    const forbiddenByRegion = {
      busan_gyeongnam:     ['울산', '대구', '경상북도', '전라', '충청', '강원', '경기', '서울', '인천', '제주'],
      daegu_gyeongbuk:     ['부산', '울산', '경상남도', '전라', '충청', '강원', '경기', '서울', '제주'],
      chungcheong_daejeon: ['경상', '전라', '강원', '경기', '서울', '인천', '제주'],
      gangwon:             ['경상', '전라', '충청', '경기', '서울', '인천', '제주'],
      jeolla_gwangju:      ['경상', '충청', '강원', '경기', '서울', '인천', '제주'],
      jeju:                ['부산', '서울', '경기', '경상', '전라', '충청', '강원'],
      seoul_gyeonggi:      ['경상', '전라', '충청', '강원', '제주'],
    };

    const forbidden = forbiddenByRegion[regionKey] || [];
    const filtered  = places.filter(p =>
      !forbidden.some(f => (p.location || '').includes(f))
    );

    // 필터 후 7개 미만이면 원본 유지
    const finalPlaces = filtered.length >= 4 ? filtered : places;

    res.status(200).json({
      places: finalPlaces,
      debug: {
        naverCount: naverResults.length,
        tourCount:  tourResults.length,
        kakaoCount: kakaoResults.length,
        totalData:  uniqueResults.length,
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}
