// ============================================================
// 공지사항 API — Vercel KV(Upstash Redis) REST API를 직접 호출합니다.
// 별도 npm 패키지 설치 없이 Node 기본 https 모듈만 사용합니다.
// ============================================================

const https = require('https');

const NOTICES_KEY = "solbeach_notices_v1";
const ADMIN_PASSWORD = "4860";
const MAX_NOTICES = 100;

function upstash(method, path, body) {
  return new Promise((resolve, reject) => {
    const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!base || !token) {
      reject(new Error('Redis 연결 환경변수가 없습니다. Vercel Storage에서 Upstash(Redis)를 만들고 이 프로젝트에 연결해주세요.'));
      return;
    }
    const url = new URL(base + path);
    const bodyStr = body !== undefined ? body : undefined;

    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('KV 응답 파싱 실패: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function readNotices() {
  const result = await upstash('GET', `/get/${NOTICES_KEY}`);
  if (result && result.error) {
    throw new Error('KV 조회 실패: ' + result.error);
  }
  if (!result || !result.result) return [];
  try { return JSON.parse(result.result); }
  catch (e) { return []; }
}

async function writeNotices(notices) {
  const result = await upstash('POST', `/set/${NOTICES_KEY}`, JSON.stringify(notices));
  if (!result || result.result !== 'OK') {
    throw new Error('KV 저장 실패: ' + JSON.stringify(result));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('잘못된 요청 형식입니다.')); }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const notices = await readNotices();
      res.status(200).json({ notices });
      return;
    }

    if (req.method === 'POST') {
      const payload = await readBody(req);
      if (payload.password !== ADMIN_PASSWORD) {
        res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
        return;
      }
      const title = (payload.title || '').toString().trim().slice(0, 200);
      const content = (payload.content || '').toString().trim().slice(0, 4000);
      if (!title || !content) {
        res.status(400).json({ error: '제목과 내용을 모두 입력해주세요.' });
        return;
      }

      const notices = await readNotices();
      const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const dateStr = now.toISOString().slice(0, 10);

      notices.unshift({ id: Date.now(), title, content, date: dateStr });
      const trimmed = notices.slice(0, MAX_NOTICES);

      await writeNotices(trimmed);
      res.status(200).json({ ok: true, notices: trimmed });
      return;
    }

    if (req.method === 'DELETE') {
      const payload = await readBody(req);
      if (payload.password !== ADMIN_PASSWORD) {
        res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
        return;
      }
      const notices = await readNotices();
      const filtered = notices.filter((n) => n.id !== payload.id);
      await writeNotices(filtered);
      res.status(200).json({ ok: true, notices: filtered });
      return;
    }

    res.status(405).json({ error: '지원하지 않는 요청입니다.' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
