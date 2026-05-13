import { readFileSync } from 'fs';
import { join } from 'path';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

export const config = { maxDuration: 60 };

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

function buildNaverQuery(filters, patterns) {
  const { weather, age, categories, indoor } = filters;
  const ageKeyMap = {
    '100일 미만': 'age_100_days_under',
    '6개월': 'age_6_months',
    '12개월': 'age_12_months',
    '24개월': 'age_24_months',
    '36개월': 'age_24_months',
    '48개월': 'age_24_months',
    '60개월 이상': 'age_24_months',
  };
  const weatherKeyMap = {
    '맑음, 야외 OK': 'weather_clear',
    '비·흐림, 실내 위주': 'weather_rainy',
    '겨울·추위, 실내 위주': 'weather_winter',
    '여름·더위, 더위 피하기': 'weather_summer',
  };

  // Manus 패턴에서 쿼리 1개만 추출
  if (patterns) {
    const qp = patterns['1_actual_parent_search_query_patterns'];
    if (age && ageKeyMap[age] && qp?.[ageKeyMap[age]]?.[0]) {
      return qp[ageKeyMap[age]][0];
    }
    if (weather && weatherKeyMap[weather] && qp?.[weatherKeyMap[weather]]?.[0]) {
      return qp[weatherKeyMap[weather]][0];
    }
  }

  const indoorStr = indoor === '실내 위주' ? ' 실내' : indoor === '실외 위주' ? ' 야외' : '';
  const validCats = (categories || []).filter(c => c && c !== '트렌드');
  const isTrend = categories?.includes('트렌드');
  if (isTrend) return `부산 아기랑 ${new Date().getFullYear()} 핫플${indoorStr}`;
  return `부산 ${age || '아기랑'} ${validCats[0] || '나들이'}${indoorStr}`;
}

function resolveIndoor(indoor, weather) {
  if (indoor && indoor !== '상관없음') return indoor;
  if (weather?.includes('실내')) return '실내 위주';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { filters } = req.body || {};
  if (!filters || typeof filters !== 'object') {
    return res.status(400).json({ error: '필터 값이 없어요.' });
  }

  try {
    const patterns = loadJSON('patterns.json');

    // 네이버 쿼리 1개, 결과 3개씩 (경량화)
    const query = buildNaverQuery(filters, patterns);
    const naverResults = await searchNaver(query);

    const resolvedIndoor = resolveIndoor(filters.indoor, filters.weather);
    const isTrend = filters.categories?.includes('트렌드');
    const otherCats = (filters.categories || []).filter(c => c !== '트렌드');

    // 판단 기준 핵심만 (경량화)
    const suitable = ['유모차 이동 가능', '수유실 또는 유아휴게실', '기저귀교환대', '낮은 자극·낮은 난이도'];
    const unsuitable = ['유모차 반입·이동 불가', '수유실·기저귀교환대 모두 없음', '소음·대기줄·혼잡이 심함'];

    // 월령별 적합 유형 (핵심만)
    const agePattern = patterns?.['4_age_place_type_patterns']
      ?.find(p => p.월령구간 === filters.age);

    const prompt = `부산/경남 영아 동반 나들이 추천 도우미.

[규칙] 부산광역시·경상남도 장소만. 울산광역시는 경남이 아님. 울산·대구·전라도 등 타지역 절대 금지. 경남은 창원·김해·양산·거제·통영·진주·사천 등 포함. 실내외 조건 우선.${resolvedIndoor ? ` "${resolvedIndoor}" 필수 적용.` : ''}

[조건] 날씨:${filters.weather||'무관'} / 실내외:${resolvedIndoor||'무관'} / 거리:${filters.distance||'무관'} / 예산:${filters.budget||'무관'} / 월령:${filters.age||'무관'} / 경험:${otherCats.join(',')||'무관'}${isTrend?' / 트렌드 포함':''}

[네이버 최신 후기]
${naverResults.map(r => `- ${r.title}: ${r.description}`).join('\n') || '없음'}

[영아 적합 기준] 있으면 좋음:${suitable.join(',')} / 없으면 제외:${unsuitable.join(',')}
${agePattern ? `[${filters.age} 적합] ${agePattern.적합장소유형?.join(',')}` : ''}

부산/경남 장소 7곳 추천. 카테고리 선택 시 해당 카테고리 장소만 추천. 네이버 결과 우선, 부족하면 지식 보완.${isTrend?' 트렌드는 최근 6개월 핫플.':''}

순수 JSON만:
[{"name":"장소명","category":"자연·힐링/교육·체험/문화·예술/시장·쇼핑/놀이·액티비티/먹거리 중심/축제·이벤트/트렌드 중 하나","location":"부산 OO구 또는 경남 OO시","desc":"한 줄","baby_point":"영아 포인트","tip":"방문 팁","indoor":"실내/실외/혼합","cost":"무료/1만원 이하/5만원 이하/그 이상"}]`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
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
    const clean = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
    const s = clean.indexOf('['), e = clean.lastIndexOf(']');
    if (s === -1 || e === -1) throw new Error('JSON 파싱 실패');

    const places = JSON.parse(clean.slice(s, e + 1));
    res.status(200).json({ places });

  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}
