// ============================================================
// 삼척(쏠비치 인근) 실시간 날씨 + 체감온도 계산 API
// 기상청 초단기실황조회(getUltraSrtNcst)를 서버에서 대신 호출합니다.
// 프론트엔드는 이 함수의 결과(JSON)만 받아서 화면에 표시합니다.
// ============================================================

const NX = 98;
const NY = 125;

function getKstBaseDateTime() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  let hour = now.getUTCHours();
  let minute = now.getUTCMinutes();
  let date = new Date(now);

  if (minute < 40) {
    date.setUTCHours(date.getUTCHours() - 1);
    hour = date.getUTCHours();
  }

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');

  return { baseDate: `${yyyy}${mm}${dd}`, baseTime: `${hh}00` };
}

function summerFeelsLike(ta, rh) {
  const tw =
    ta * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(ta + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;

  return (
    -0.2442 +
    0.55399 * tw +
    0.45535 * ta -
    0.0022 * tw * tw +
    0.00278 * tw * ta +
    3.0
  );
}

function winterFeelsLike(ta, windMs) {
  const v = Math.max(windMs * 3.6, 4.8);
  const v16 = Math.pow(v, 0.16);
  return 13.12 + 0.6215 * ta - 11.37 * v16 + 0.3965 * ta * v16;
}

function computeFeelsLike(ta, rh, windMs) {
  if (ta >= 27) return summerFeelsLike(ta, rh);
  if (ta <= 10) return winterFeelsLike(ta, windMs);
  return ta;
}

function classifyLevel(ta, feelsLike) {
  if (ta >= 27) {
    if (feelsLike >= 38) return { cls: 'lv-danger', label: '위험' };
    if (feelsLike >= 35) return { cls: 'lv-warning', label: '경고' };
    if (feelsLike >= 33) return { cls: 'lv-caution', label: '주의' };
    return { cls: 'lv-normal', label: '정상' };
  }
  if (ta <= 10) {
    if (feelsLike <= -18) return { cls: 'lv-danger', label: '위험' };
    if (feelsLike <= -15) return { cls: 'lv-warning', label: '경고' };
    if (feelsLike <= -12) return { cls: 'lv-caution', label: '주의' };
    return { cls: 'lv-normal', label: '정상' };
  }
  return { cls: 'lv-normal', label: '정상' };
}

const https = require('https');

function fetchJson(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };
    const safeReject = (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } };

    const req = https.get(url, { rejectUnauthorized: false }, (resp) => {
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('error', (err) => safeReject(err));
      resp.on('end', () => {
        try {
          safeResolve(JSON.parse(body));
        } catch (e) {
          safeReject(new Error(`JSON parse failed: ${e.message} | body head: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (err) => safeReject(err));

    const timer = setTimeout(() => {
      safeReject(new Error('요청 시간 초과 (전체 소요시간 기준)'));
      req.destroy();
    }, timeoutMs);
  });
}

function weatherIconAndCondition(pty, sky) {
  const ptyMap = {
    '1': { icon: '🌧️', text: '비' },
    '2': { icon: '🌨️', text: '비/눈' },
    '3': { icon: '❄️', text: '눈' },
    '4': { icon: '🌦️', text: '소나기' },
    '5': { icon: '🌧️', text: '빗방울' },
    '6': { icon: '🌨️', text: '빗방울눈날림' },
    '7': { icon: '🌨️', text: '눈날림' },
  };
  if (pty && pty !== '0' && ptyMap[pty]) {
    return ptyMap[pty];
  }
  const skyMap = {
    '1': { icon: '☀️', text: '맑음' },
    '3': { icon: '⛅', text: '구름많음' },
    '4': { icon: '☁️', text: '흐림' },
  };
  return skyMap[sky] || { icon: '🌤️', text: '' };
}

// 강원(관서코드 105)의 최신 특보 통보문 1건을 조회합니다.
// (실측 결과, 이 API는 tmFc로 과거 시점을 지정해도 항상 "현재 시점 기준
// 최신 통보문 1건"만 돌려줍니다 — 그래서 한 번의 조회만으로 "지금" 상황을
// 정확히 파악할 수 있습니다)
async function fetchSamcheokAdvisory(serviceKey) {
  const url =
    `https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnMsg` +
    `?serviceKey=${serviceKey}&pageNo=1&numOfRows=10&dataType=JSON&stnId=105`;
  const data = await fetchJson(url);
  const header = data?.response?.header;

  if (header && header.resultCode && header.resultCode !== '00') {
    return {
      active: false,
      debug_resultCode: header.resultCode,
      debug_resultMsg: header.resultMsg,
    };
  }

  const rawItem = data?.response?.body?.items?.item;
  const rec = Array.isArray(rawItem) ? rawItem[0] : rawItem;
  if (!rec) {
    return { active: false, debug_note: '통보문이 비어있음' };
  }

  const lines = ['t1', 't2', 't3', 't4', 't6', 't7']
    .map((k) => rec[k])
    .filter((v) => typeof v === 'string' && v.trim() && !v.includes('없음'));

  // 한 줄에 "강원도(횡성, 원주, 삼척평지, 동해평지...)"처럼 여러 지역이
  // 같이 나열되는 경우가 많아, "삼척평지"만 뽑아서 보여줍니다.
  // (삼척산지는 제외 — 쏠비치 삼척은 평지 지역입니다)
  function extractSamcheokFlatLabel(line) {
    const typeMatch = line.match(/^o?\s*([^:：]+)[:：]/);
    const warnType = (typeMatch ? typeMatch[1] : line).trim();
    const regionMatch = line.match(/\(([^)]*)\)/);
    if (!regionMatch) return null;
    const tokens = regionMatch[1].split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    const hasSamcheokFlat = tokens.some((t) => t.includes('삼척') && !t.includes('산지'));
    if (!hasSamcheokFlat) return null;
    return `${warnType} (삼척평지)`;
  }

  const samcheokFlatLabels = lines
    .map((l) => extractSamcheokFlatLabel(l))
    .filter(Boolean);
  const uniqueLabels = [...new Set(samcheokFlatLabels)];

  return {
    active: uniqueLabels.length > 0,
    items: uniqueLabels.map((label) => ({ title: label })),
    debug_tmFc: rec.tmFc,
    debug_allLines: lines,
  };
}

module.exports = async (req, res) => {
  try {
    const serviceKey = process.env.KMA_SERVICE_KEY;
    if (!serviceKey) {
      const candidateKeys = Object.keys(process.env).filter((k) => /KMA|SERVICE/i.test(k));
      res.status(500).json({
        error: 'KMA_SERVICE_KEY 환경변수가 설정되지 않았습니다.',
        debug_similarEnvKeys: candidateKeys,
        debug_totalEnvCount: Object.keys(process.env).length,
      });
      return;
    }

    const { baseDate, baseTime } = getKstBaseDateTime();

    const ncstUrl =
      `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst` +
      `?serviceKey=${serviceKey}&numOfRows=10&pageNo=1&dataType=JSON` +
      `&base_date=${baseDate}&base_time=${baseTime}&nx=${NX}&ny=${NY}`;

    let data;
    try {
      data = await fetchJson(ncstUrl);
    } catch (fetchErr) {
      res.status(500).json({
        error: String(fetchErr),
        debug_cause: fetchErr && fetchErr.cause ? String(fetchErr.cause) : null,
      });
      return;
    }

    const items = data?.response?.body?.items?.item;
    if (!items) {
      res.status(502).json({ error: '기상청 응답 형식 오류', raw: data });
      return;
    }

    const get = (cat) => {
      const found = items.find((i) => i.category === cat);
      return found ? parseFloat(found.obsrValue) : null;
    };
    const getRaw = (cat) => {
      const found = items.find((i) => i.category === cat);
      return found ? found.obsrValue : null;
    };

    const ta = get('T1H');
    const rh = get('REH');
    const wsd = get('WSD');
    const pty = getRaw('PTY');

    if (ta === null) {
      res.status(502).json({ error: '기온 데이터를 찾을 수 없습니다.' });
      return;
    }

    let sky = null;
    try {
      const fcstUrl =
        `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtFcst` +
        `?serviceKey=${serviceKey}&numOfRows=60&pageNo=1&dataType=JSON` +
        `&base_date=${baseDate}&base_time=${baseTime}&nx=${NX}&ny=${NY}`;
      const fcstData = await fetchJson(fcstUrl);
      const fcstItems = fcstData?.response?.body?.items?.item;
      if (fcstItems) {
        const skyItem = fcstItems.find((i) => i.category === 'SKY');
        sky = skyItem ? skyItem.fcstValue : null;
      }
    } catch (e) {
      sky = null;
    }

    const feelsLike = computeFeelsLike(ta, rh ?? 50, wsd ?? 0);
    const level = classifyLevel(ta, feelsLike);
    const cond = weatherIconAndCondition(pty, sky);

    let advisory = { active: false };
    try {
      advisory = await fetchSamcheokAdvisory(serviceKey);
    } catch (advErr) {
      advisory = { active: false, error: String(advErr) };
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      temp: Math.round(ta * 10) / 10,
      humidity: rh,
      windSpeed: wsd,
      feelsLike: Math.round(feelsLike * 10) / 10,
      level,
      icon: cond.icon,
      condition: cond.text,
      advisory,
      baseDate,
      baseTime,
    });
  } catch (err) {
    res.status(500).json({ error: String(err), debug_cause: err && err.cause ? String(err.cause) : null });
  }
};
