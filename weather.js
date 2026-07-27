// ============================================================
// 삼척(쏠비치 인근) 실시간 날씨 + 체감온도 계산 API
// 기상청 초단기실황조회(getUltraSrtNcst)를 서버에서 대신 호출합니다.
// 프론트엔드는 이 함수의 결과(JSON)만 받아서 화면에 표시합니다.
// ============================================================

// 쏠비치 삼척 인근 기상청 격자좌표 (위경도 37.4460, 129.1830 기준 변환값)
const NX = 98;
const NY = 125;

function getKstBaseDateTime() {
  // 서버는 UTC로 동작하므로 KST(UTC+9)로 보정
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  let hour = now.getUTCHours();
  let minute = now.getUTCMinutes();
  let date = new Date(now);

  // 초단기실황은 매시 40분에 발표되어 그 이후부터 조회 가능
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

// 여름철 체감온도 (기상청 공식, Ta>=27도에서 유효) — 습구온도는 Stull 근사식 사용
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

// 겨울철 체감온도(윈드칠, 기상청 공식, Ta<=10도, 풍속 1.3m/s 이상에서 유효)
function winterFeelsLike(ta, windMs) {
  const v = Math.max(windMs * 3.6, 4.8); // m/s -> km/h, 최소 적용범위 보정
  const v16 = Math.pow(v, 0.16);
  return 13.12 + 0.6215 * ta - 11.37 * v16 + 0.3965 * ta * v16;
}

function computeFeelsLike(ta, rh, windMs) {
  if (ta >= 27) return summerFeelsLike(ta, rh);
  if (ta <= 10) return winterFeelsLike(ta, windMs);
  return ta; // 애매한 중간 구간은 기온을 그대로 사용
}

function classifyLevel(ta, feelsLike) {
  if (ta >= 27) {
    if (feelsLike >= 38) return { cls: 'lv-danger', label: '온열질환 위험' };
    if (feelsLike >= 35) return { cls: 'lv-warning', label: '온열질환 경고' };
    if (feelsLike >= 33) return { cls: 'lv-caution', label: '온열질환 주의' };
    return { cls: 'lv-normal', label: '정상' };
  }
  if (ta <= 10) {
    if (feelsLike <= -15) return { cls: 'lv-danger', label: '한랭질환 위험' };
    if (feelsLike <= -12) return { cls: 'lv-warning', label: '한랭질환 경고' };
    if (feelsLike <= -10) return { cls: 'lv-caution', label: '한랭질환 주의' };
    return { cls: 'lv-normal', label: '정상' };
  }
  return { cls: 'lv-normal', label: '정상' };
}

module.exports = async (req, res) => {
  try {
    const serviceKey = process.env.KMA_SERVICE_KEY;
    if (!serviceKey) {
      res.status(500).json({ error: 'KMA_SERVICE_KEY 환경변수가 설정되지 않았습니다.' });
      return;
    }

    const { baseDate, baseTime } = getKstBaseDateTime();
    const url =
      `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst` +
      `?serviceKey=${serviceKey}&numOfRows=10&pageNo=1&dataType=JSON` +
      `&base_date=${baseDate}&base_time=${baseTime}&nx=${NX}&ny=${NY}`;

    const r = await fetch(url);
    const data = await r.json();

    const items = data?.response?.body?.items?.item;
    if (!items) {
      res.status(502).json({ error: '기상청 응답 형식 오류', raw: data });
      return;
    }

    const get = (cat) => {
      const found = items.find((i) => i.category === cat);
      return found ? parseFloat(found.obsrValue) : null;
    };

    const ta = get('T1H');  // 기온(℃)
    const rh = get('REH');  // 습도(%)
    const wsd = get('WSD'); // 풍속(m/s)

    if (ta === null) {
      res.status(502).json({ error: '기온 데이터를 찾을 수 없습니다.' });
      return;
    }

    const feelsLike = computeFeelsLike(ta, rh ?? 50, wsd ?? 0);
    const level = classifyLevel(ta, feelsLike);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      temp: Math.round(ta * 10) / 10,
      humidity: rh,
      windSpeed: wsd,
      feelsLike: Math.round(feelsLike * 10) / 10,
      level,
      baseDate,
      baseTime,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
