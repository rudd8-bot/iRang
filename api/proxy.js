import { readFileSync } from 'fs';
import { join } from 'path';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

export const config = { maxDuration: 60 };

const regionLabelMap = {
  busan_gyeongnam:      '부산광역시·경상남도',
  daegu_gyeongbuk:      '대구광역시·경상북도',
  chungcheong_daejeon:  '충청도·대전광역시·세종시',
  gangwon:              '강원특별자치도',
  jeolla_gwangju:       '전라도·광주광역시',
  jeju:                 '제주특별자치도',
  seoul_gyeonggi:       '서울특별시·경기도',
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

const categoryKeyMap = {
  '자연·힐링':    'category_nature',
  '교육·체험':    'category_culture',
  '문화·예술':    'category_culture',
  '시장·쇼핑':    'category_nature',
  '놀이·액티비티': 'category_nature',
  '먹거리 중심':  'category_food',
  '축제·이벤트':  'category_festival',
  '트렌드':       'category_trend',
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
  const { weather, age, categories, region } = filters;
  const regionKey = region || 'busan_gyeongnam';

  const ageKeyMap = {
    '100일 미만':  'age_100_days_under',
    '6개월':       'age_6_months',
    '12개월':      'age_12_months',
    '24개월':      'age_24_months',
    '36개월':      'age_36_months',
    '48개월':      'age_48_months',
    '60개월 이상': 'age_60_months',
  };
  const weatherKeyMap = {
    '맑음, 야외 OK':          'weather_clear',
    '비·흐림, 실내 위주':     'weather_rainy',
    '겨울·추위, 실내 위주':   'weather_winter',
    '여름·더위, 더위 피하기': 'weather_summer',
  };

  if (patterns) {
    // ✅ 핵심 수정: patterns[regionKey] 로 읽기
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
  const regionLabel = regionLabelMap[regionKey];
  const indoorStr = filters.indoor === '실내 위주' ? ' 실내' : filters.indoor === '실외 위주' ? ' 야외' : '';
  const isTrend = categories?.includes('트렌드');
  if (isTrend) return `${regionLabel.split('·')[0]} 아기랑 ${new Date().getFullYear()} 핫플${indoorStr}`;
  const validCats = (categories || []).filter(c => c && c !== '트렌드');
  return `${regionLabel.split('·')[0]} ${age || '아기랑'} ${validCats[0] || '나들이'}${indoorStr}`;
}

function resolveIndoor(indoor, weather) {
  if (indoor && indoor !== '상관없음') return indoor;
  if (weather?.includes('실내')) return '실내 위주';
  return null;
}

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
    const patterns = loadJSON('patterns.json');
    const query = buildNaverQuery(filters, patterns);
    const naverResults = await searchNaver(query);

    const resolvedIndoor = resolveIndoor(filters.indoor, filters.weather);
    const isTrend = filters.categories?.includes('트렌드');
    const otherCats = (filters.categories || []).filter(c => c !== '트렌드');

    const regionKey = filters.region || 'busan_gyeongnam';
    const regionLabel = regionLabelMap[regionKey] || '부산광역시·경상남도';
    const regionGuide = regionGuideMap[regionKey] || regionGuideMap['busan_gyeongnam'];
    const regionCity = regionLabel.split('·')[0];
    const regionSub  = regionLabel.split('·')[1] || '';

    const suitable = ['유모차 이동 가능', '수유실 또는 유아휴게실', '기저귀교환대', '낮은 자극·낮은 난이도'];
    const unsuitable = ['유모차 반입·이동 불가', '수유실·기저귀교환대 모두 없음', '소음·대기줄·혼잡이 심함'];

    const agePattern = patterns?.['4_age_place_type_patterns']
      ?.find(p => p.월령구간 === filters.age);

    const prompt = `영아 동반 나들이 추천 도우미.\n\n[규칙] ${regionGuide} 실내외 조건 우선.${resolvedIndoor ? ` "${resolvedIndoor}" 필수 적용.` : ''}\n\n[조건] 날씨:${filters.weather||'무관'} / 실내외:${resolvedIndoor||'무관'} / 거리:${filters.distance||'무관'} / 예산:${filters.budget||'무관'} / 월령:${filters.age||'무관'} / 경험:${otherCats.join(',')||'무관'}${isTrend?' / 트렌드 포함':''}\n\n[네이버 최신 후기]\n${naverResults.map(r => `- ${r.title}: ${r.description}`).join('\n') || '없음'}\n\n[영아 적합 기준] 있으면 좋음:${suitable.join(',')} / 없으면 제외:${unsuitable.join(',')}\n${agePattern ? `[${filters.age} 적합] ${agePattern.적합장소유형?.join(',')}` : ''}\n\n${regionLabel} 장소 7곳 추천. 카테고리 선택 시 해당 카테고리 장소만 추천. 네이버 결과 우선, 부족하면 지식 보완.${isTrend?' 트렌드는 최근 6개월 핫플.':''}\n\n순수 JSON만:\n[{"name":"장소명","category":"자연·힐링/교육·체험/문화·예술/시장·쇼핑/놀이·액티비티/먹거리 중심/축제·이벤트/트렌드 중 하나","location":"${regionCity} OO구 또는 ${regionSub} OO시","desc":"한 줄","baby_point":"영아 포인트","tip":"방문 팁","indoor":"실내/실외/혼합","cost":"무료/1만원 이하/5만원 이하/그 이상"}]`;

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
        system: '당신은 JSON만 출력하는 API입니다. 반드시 JSON 배열만 출력하세요. 설명·사과·마크다운 코드블록 절대 금지. [ 로 시작해서 ] 로 끝나야 합니다.',
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
    if (s === -1 || e === -1) {
      // Claude 원본 응답을 오류 메시지에 포함 (디버그용)
      throw new Error('JSON 파싱 실패 | Claude 응답: ' + clean.slice(0, 200));
    }

    let places;
    try {
      places = JSON.parse(clean.slice(s, e + 1));
    } catch (parseErr) {
      throw new Error('JSON 구문 오류 | ' + parseErr.message + ' | 원문: ' + clean.slice(s, s+200));
    }
    if (!Array.isArray(places) || places.length === 0) {
      throw new Error('빈 배열 반환 | Claude 응답: ' + clean.slice(0, 200));
    }
    res.status(200).json({ places });

  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}
