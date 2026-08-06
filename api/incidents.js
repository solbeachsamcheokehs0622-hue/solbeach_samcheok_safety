// ============================================================
// 중대재해 발생 알림 API
// - 이미지는 GitHub 저장소(data/incidents/{id}.jpg)에 개별 파일로 저장
// - 목록(제목/날짜/업종/경로)은 가벼운 인덱스 파일(data/incidents.json)로 관리
// - 목록 조회는 항상 빠르고, 이미지는 요청 시(클릭했을 때)에만 불러옵니다
// 필요한 환경변수: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO
// (선택) GITHUB_BRANCH — 기본값 main
// ============================================================

const https = require('https');

const ADMIN_PASSWORD = "4860";
const MAX_INCIDENTS = 200;
const INDEX_PATH = "data/incidents.json";
const IMAGE_DIR = "data/incidents";

function cleanEnv(v) {
  if (!v) return v;
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function githubRequest(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const token = cleanEnv(process.env.GITHUB_TOKEN);
    if (!token) {
      reject(new Error('GITHUB_TOKEN 환경변수가 설정되지 않았습니다.'));
      return;
    }
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
    const options = {
      method,
      hostname: 'api.github.com',
      path,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'solbeach-incidents-app',
        'Accept': 'application/vnd.github+json',
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { /* not JSON */ }
        resolve({ status: resp.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function repoInfo() {
  const owner = cleanEnv(process.env.GITHUB_OWNER);
  const repo = cleanEnv(process.env.GITHUB_REPO);
  const branch = cleanEnv(process.env.GITHUB_BRANCH) || 'main';
  if (!owner || !repo) {
    throw new Error('GITHUB_OWNER / GITHUB_REPO 환경변수가 설정되지 않았습니다.');
  }
  return { owner, repo, branch };
}

async function getFileRaw(path) {
  const { owner, repo, branch } = repoInfo();
  const res = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`GitHub 조회 실패 (status ${res.status}): ${res.raw.slice(0, 200)}`);
  }
  return res.body;
}

async function getIndex() {
  const file = await getFileRaw(INDEX_PATH);
  if (!file) return { incidents: [], sha: null };
  const content = Buffer.from(file.content, 'base64').toString('utf-8');
  let incidents = [];
  try { incidents = JSON.parse(content); } catch (e) { incidents = []; }
  return { incidents, sha: file.sha };
}

async function putIndex(incidents, sha, message) {
  const { owner, repo, branch } = repoInfo();
  const content = Buffer.from(JSON.stringify(incidents, null, 2)).toString('base64');
  const payload = { message, content, branch };
  if (sha) payload.sha = sha;
  const res = await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${INDEX_PATH}`, payload);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub 저장 실패 (status ${res.status}): ${res.raw.slice(0, 300)}`);
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

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

function extFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      let imagePath = null;
      try {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'x'}`);
        imagePath = urlObj.searchParams.get('image');
      } catch (e) { imagePath = null; }

      if (imagePath) {
        const file = await getFileRaw(imagePath);
        if (!file) {
          res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });
          return;
        }
        const ext = imagePath.split('.').pop().toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json({ dataUrl: `data:${mime};base64,${file.content.replace(/\n/g, '')}` });
        return;
      }

      const { incidents } = await getIndex();
      res.status(200).json({ incidents });
      return;
    }

    if (req.method === 'POST') {
      const payload = await readBody(req);
      if (payload.password !== ADMIN_PASSWORD) {
        res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
        return;
      }
      const industry = ['제조업', '건설업', '기타업'].includes(payload.industry) ? payload.industry : '기타업';
      const parsed = parseDataUrl(payload.imageDataUrl);
      if (!parsed) {
        res.status(400).json({ error: '이미지 데이터가 올바르지 않습니다.' });
        return;
      }

      const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const dateStr = `${yyyy}년 ${mm}월 ${dd}일`;
      const title = `${dateStr} 중대재해 발생 알림🚨 [${industry}]`;

      const id = `${Date.now()}`;
      const ext = extFromMime(parsed.mime);
      const imagePath = `${IMAGE_DIR}/${id}.${ext}`;

      const { owner, repo, branch } = repoInfo();
      const putRes = await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${imagePath}`, {
        message: `중대재해 알림 이미지 추가: ${id}`,
        content: parsed.base64,
        branch,
      });
      if (putRes.status !== 200 && putRes.status !== 201) {
        throw new Error(`이미지 저장 실패 (status ${putRes.status}): ${putRes.raw.slice(0, 300)}`);
      }

      const { incidents, sha } = await getIndex();
      incidents.unshift({ id, title, industry, date: `${yyyy}-${mm}-${dd}`, path: imagePath });
      const trimmed = incidents.slice(0, MAX_INCIDENTS);
      await putIndex(trimmed, sha, `중대재해 알림 추가: ${title}`);

      res.status(200).json({ ok: true, incidents: trimmed });
      return;
    }

    if (req.method === 'DELETE') {
      const payload = await readBody(req);
      if (payload.password !== ADMIN_PASSWORD) {
        res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
        return;
      }
      const { incidents, sha } = await getIndex();
      const target = incidents.find((n) => n.id === payload.id);
      const filtered = incidents.filter((n) => n.id !== payload.id);
      await putIndex(filtered, sha, `중대재해 알림 삭제 (id: ${payload.id})`);

      if (target && target.path) {
        try {
          const file = await getFileRaw(target.path);
          if (file) {
            const { owner, repo, branch } = repoInfo();
            await githubRequest('DELETE', `/repos/${owner}/${repo}/contents/${target.path}`, {
              message: `중대재해 알림 이미지 삭제: ${target.id}`,
              sha: file.sha,
              branch,
            });
          }
        } catch (e) { /* 이미지 삭제 실패는 무시하고 목록은 정상 반영 */ }
      }

      res.status(200).json({ ok: true, incidents: filtered });
      return;
    }

    res.status(405).json({ error: '지원하지 않는 요청입니다.' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
