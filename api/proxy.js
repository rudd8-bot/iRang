import { readFileSync } from 'fs';
import { join } from 'path';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// Vercel 타임아웃 설정 (HIGH: 타임아웃)
export const config = { maxDuration: 30 };

function loadJSON(filename) {
  // data/ 경로 불확실 문제 - 여러 경로 시도 (MEDIUM: data/ 경로)
  const candidates = [
    join(process.cwd(), 'data', filename),
    join('/var/task', 'data', filename),
    join(process.cwd(), filename),
  ];
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch {}
  }
  return null;
}

async function searchNaver(query) {
  try {
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=5&sort=date`;
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(i => ({
      title: i.title.replace(/<[^>]+>/g, ''),
      description: i.description.replace(/<[^>]+>/g, ''),
      link: i.link,
      date: i.postdate,
    }));
  } catch {
    return [];
  }
}

function buildNaverQueries(filters, patterns) {
  const { weather, age, categories } = filters;

  const weatherKeyMap = {
    '맑음, 야외 OK': 'weather_clear',
    '비·흐림, 실내 위주': 'weather_rainy',
    '겨울·추위, 실내 위주': 'weather_winter',
    '여름·더위, 더위 피하기': 'weather_summer',
  };

  // 월령 전 구간 매핑 (MEDIUM: 36/48/60개월 미매핑)
  const ageKeyMap = {
    '100일 미만': 'age_100_days_under',
    '6개월': 'age_6_months',
    '12개월': 'age_12_months',
    '24개월': 'age_24_months',
    '36개월': 'age_24_months', // 가장 가까운 패턴 활용
    '48개월': 'age_24_months',
    '60개월 이상': 'age_24_months',
  };

  let queries = [];

  if (patterns) {
    const qp = patterns['1_actual_parent_search_query_patterns'];
    if (qp) {
      if (age && ageKeyMap[age] && qp[ageKeyMap[age]]) {
        queries = queries.concat(qp[ageKeyMap[age]].slice(0, 2));
      }
      if (weather && weatherKeyMap[weather] && qp[weatherKeyMap[weather]]) {
        queries = queries.concat(qp[weatherKeyMap[weather]].slice(0, 2));
      }
    }
  }

  // 트렌드 카테고리 선택시 최신 쿼리 추가
  const isTrend = categories && categories.includes('트렌드');
  if (isTrend) {
    const year = new Date().getFullYear();
    queries.push(`부산 아기랑 ${year} 요즘 핫한`);
    queries.push(`경남 영아 나들이 ${year} 추천`);
  }

  // 기본 보완 쿼리 (MEDIUM: categories 빈 배열 → undefined 방지)
  const validCats = (categories || []).filter(c => c && c !== '트렌드');
  const catStr = validCats[0] || '나들이';
  const ageStr = age || '아기랑';

  queries.push(`부산 ${ageStr} ${catStr}`);
  queries.push(`경남 ${ageStr} ${catStr}`);

  return [...new Set(queries)].slice(0, 5);
}

// 날씨 매핑 정확도 개선 (MEDIUM: 날씨 매핑 불일치)
function findWeatherPattern(weatherPatterns, weatherFilter) {
  if (!weatherPatterns || !weatherFilter) return null;
  return weatherPatterns.find(p => {
    const w = p.날씨;
    if (weatherFilter.includes('맑음') && w === '맑음') return true;
    if (weatherFilter.includes('비') && w === '비·흐림') return true;
    if (weatherFilter.includes('겨울') && w === '겨울추위') return true;
    if (weatherFilter.includes('여름') && w === '여름더위') return true;
    return false;
  }) || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // HIGH: filters 미검증 처리
  const { filters } = req.body || {};
  if (!filters || typeof filters !== 'object') {
    return res.status(400).json({ error: '필터 값이 없어요.' });
  }

  try {
    const patterns = loadJSON('patterns.json');

    // 네이버 병렬 검색
    const queries = buildNaverQueries(filters, patterns);
    const naverResults = (
      await Promise.all(queries.map(q => searchNaver(q)))
    ).flat().slice(0, 15);

    // MEDIUM: 네이버 0개시 로그
    const naverSuccess = naverResults.length > 0;

    const suitabilityChecklist = patterns?.['2_baby_suitability_checklist'] || null;
    const inconveniencePatterns = patterns?.['3_inconvenience_patterns'] || null;
    const agePattern = patterns?.['4_age_place_type_patterns']
      ?.find(p => p.월령구간 === filters.age) || null;
    const weatherPattern = findWeatherPattern(
      patterns?.['5_weather_place_type_patterns'],
      filters.weather
    );
    const crowdingPatterns = patterns?.['6_crowding_time_patterns'] || null;

    const isTrend = filters.categories?.includes('트렌드');
    const otherCats = (filters.categories || []).filter(c => c !== '트렌드');

    // HIGH: 지역 이탈 방지 + LOW: 토큰 초과 방지 (max_tokens 3000으로 상향)
    const prompt = `당신은 부산/경남 영아 동반 가족 나들이 전문 추천 도우미입니다.

[절대 규칙]
- 반드시 부산광역시 또는 경상남도 내 장소만 추천해. 울산, 대구, 전라도 등 타 지역은 절대 포함 금지.
- 실제 존재하는 장소만 추천해. 없는 장소 만들지 마.

[사용자 조건]
- 날씨: ${filters.weather || '상관없음'}
- 이동거리: ${filters.distance || '상관없음'}
- 예산: ${filters.budget || '상관없음'}
- 실내외: ${filters.indoor || '상관없음'}
- 아이 월령: ${filters.age || '상관없음'}
- 원하는 경험: ${otherCats.join(', ') || '상관없음'}${isTrend ? ' + 요즘 트렌드 장소 포함' : ''}

[실시간 네이버 블로그 검색 결과 (${naverSuccess ? naverResults.length + '개' : '검색 실패 - 지식 기반으로 대체'})]
${JSON.stringify(naverResults.slice(0, 12), null, 2)}

[영아 적합성 판단 기준 - 반드시 적용]
적합: ${JSON.stringify(suitabilityChecklist?.suitable_if_present?.map(c => c.criterion))}
부적합: ${JSON.stringify(suitabilityChecklist?.unsuitable_if_absent?.map(c => c.criterion))}

[날씨 조건별 장소 유형]
${weatherPattern ? `추천: ${weatherPattern.추천장소유형?.join(', ')}\n피할 곳: ${weatherPattern.피해야할유형?.join(', ')}` : '없음'}

[월령별 적합 장소 유형]
${agePattern ? `적합: ${agePattern.적합장소유형?.join(', ')}\n부적합: ${agePattern.부적합장소유형?.join(', ')}` : '없음'}

[불편 포인트 주의]
${inconveniencePatterns?.slice(0, 3).map(p => p.불편유형 + ': ' + p.발생장소유형?.join(', ')).join('\n') || '없음'}

[혼잡도 팁]
${crowdingPatterns?.slice(0, 3).map(p => p.장소유형 + ' → ' + p.추천시간대).join('\n') || '없음'}

위 정보로 부산/경남 장소 10곳 추천. 네이버 결과 우선 활용. 부족하면 지식 보완.
${isTrend ? '트렌드 항목은 최근 6개월 내 자주 언급된 신규·핫플 장소로 골라줘.' : ''}

순수 JSON 배열만 반환. 마크다운 금지.
[{"name":"장소명","category":"자연·힐링/교육·체험/문화·예술/시장·쇼핑/놀이·액티비티/먹거리 중심/축제·이벤트/트렌드 중 하나","location":"부산 OO구 또는 경남 OO시","desc":"두 줄 이내","baby_point":"영아 포인트 한 줄","tip":"방문 팁 한 줄","indoor":"실내 또는 실외 또는 혼합","cost":"무료 또는 1만원 이하 또는 5만원 이하 또는 그 이상"}]`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000, // LOW: 토큰 초과 방지
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      // LOW: 에러 메시지 누락 방지
      throw new Error('Claude API 오류: ' + (err.error?.message || err.error?.type || claudeRes.status));
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content
      .filter(i => i.type === 'text')
      .map(i => i.text)
      .join('');

    const clean = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
    const s = clean.indexOf('[');
    const e = clean.lastIndexOf(']');
    if (s === -1 || e === -1) throw new Error('JSON 파싱 실패: ' + clean.slice(0, 100));

    const places = JSON.parse(clean.slice(s, e + 1));
    res.status(200).json({ places, naver_used: naverSuccess });

  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}
