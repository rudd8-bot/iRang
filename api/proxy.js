import { readFileSync } from 'fs';
import { join } from 'path';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

function loadJSON(filename) {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'data', filename), 'utf-8'));
  } catch {
    return null;
  }
}

async function searchNaver(query) {
  try {
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=5&sort=date`;
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
      },
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
  const ageKeyMap = {
    '100일 미만': 'age_100_days_under',
    '6개월': 'age_6_months',
    '12개월': 'age_12_months',
    '24개월': 'age_24_months',
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

  const base = ['부산', age ? age + ' 아기랑' : '아기랑'];
  if (categories && categories.length) base.push(categories[0]);
  queries.push(base.join(' '));
  queries.push('경남 ' + (age || '아기랑') + ' ' + (categories?.[0] || '나들이'));

  return [...new Set(queries)].slice(0, 4);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { filters } = req.body;

    // Manus 패턴 데이터: 장소 목록이 아닌 판단 기준·쿼리 패턴으로만 사용
    const patterns = loadJSON('patterns.json');

    // 1. 네이버 API 실시간 검색 (Manus 쿼리 패턴 활용)
    const queries = buildNaverQueries(filters, patterns);
    const naverResults = (
      await Promise.all(queries.map(q => searchNaver(q)))
    ).flat().slice(0, 15);

    // 2. Manus 패턴에서 Claude 판단 기준 추출
    const suitabilityChecklist = patterns?.['2_baby_suitability_checklist'] || null;
    const inconveniencePatterns = patterns?.['3_inconvenience_patterns'] || null;
    const agePattern = patterns?.['4_age_place_type_patterns']
      ?.find(p => p.월령구간 === filters.age) || null;
    const weatherPattern = patterns?.['5_weather_place_type_patterns']
      ?.find(p => filters.weather?.includes(p.날씨)) || null;
    const crowdingPatterns = patterns?.['6_crowding_time_patterns'] || null;

    // 3. Claude 프롬프트 (Manus = 판단 기준, 네이버 = 실시간 장소 탐색)
    const prompt = `당신은 부산/경남 영아 동반 가족 나들이 전문 추천 도우미입니다.

[사용자 조건]
- 지역: 부산/경남
- 날씨: ${filters.weather || '상관없음'}
- 이동거리: ${filters.distance || '상관없음'}
- 예산: ${filters.budget || '상관없음'}
- 실내외: ${filters.indoor || '상관없음'}
- 아이 월령: ${filters.age || '상관없음'}
- 원하는 경험: ${filters.categories?.join(', ') || '상관없음'}

[실시간 네이버 블로그 검색 결과]
${JSON.stringify(naverResults, null, 2)}

[영아 적합성 판단 기준 - 반드시 적용]
적합 조건: ${JSON.stringify(suitabilityChecklist?.suitable_if_present?.map(c => c.criterion))}
부적합 조건: ${JSON.stringify(suitabilityChecklist?.unsuitable_if_absent?.map(c => c.criterion))}

[날씨 조건별 장소 유형]
${weatherPattern ? `추천: ${weatherPattern.추천장소유형?.join(', ')}\n피할 곳: ${weatherPattern.피해야할유형?.join(', ')}` : '없음'}

[월령별 적합 장소 유형]
${agePattern ? `적합: ${agePattern.적합장소유형?.join(', ')}\n부적합: ${agePattern.부적합장소유형?.join(', ')}\n이유: ${agePattern.이유}` : '없음'}

[주의할 불편 포인트]
${inconveniencePatterns?.slice(0, 4).map(p => p.불편유형 + ': ' + p.발생장소유형?.join(', ')).join('\n') || '없음'}

[혼잡도 팁]
${crowdingPatterns?.slice(0, 3).map(p => p.장소유형 + ' → ' + p.추천시간대).join('\n') || '없음'}

위 정보를 종합해서 조건에 맞는 부산/경남 장소 10곳을 추천해줘.
- 네이버 검색 결과에서 실제 언급된 장소를 우선 활용해
- 영아 적합성 기준을 반드시 적용해서 부적합한 곳은 제외해
- 월령·날씨 조건에 맞는 장소 유형을 우선해
- 실제 존재하는 장소만 추천해
- 조건에 맞는 곳이 10개 미만이면 있는 만큼만 반환

반드시 아래 JSON 배열 형식으로만 응답해. 마크다운 없이 순수 JSON만.
[{"name":"장소명","category":"자연·힐링/교육·체험/문화·예술/시장·쇼핑/놀이·액티비티/먹거리 중심/축제·이벤트 중 하나","location":"구군 단위 위치","desc":"두 줄 이내 설명","baby_point":"영아 동반 시 좋은 점 한 줄","tip":"방문 팁 한 줄","indoor":"실내 또는 실외 또는 혼합","cost":"무료 또는 1만원 이하 또는 5만원 이하 또는 그 이상"}]`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      throw new Error('Claude API 오류: ' + (err.error?.message || claudeRes.status));
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content
      .filter(i => i.type === 'text')
      .map(i => i.text)
      .join('');

    const clean = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
    const s = clean.indexOf('[');
    const e = clean.lastIndexOf(']');
    if (s === -1 || e === -1) throw new Error('JSON 파싱 실패');

    const places = JSON.parse(clean.slice(s, e + 1));
    res.status(200).json({ places });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
