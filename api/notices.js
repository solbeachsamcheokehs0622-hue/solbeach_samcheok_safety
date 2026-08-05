// ============================================================
// 공지사항 API — 외부 DB 없이 GitHub 저장소의 data/notices.json
// 파일에 직접 커밋하는 방식으로 저장합니다. (Upstash/KV 불필요)
// 필요한 환경변수: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO
// (선택) GITHUB_BRANCH — 기본값 main
// ============================================================

const https = require('https');

const ADMIN_PASSWORD = "4860";
const MAX_NOTICES = 100;
const FILE_PATH = "data/notices.json";

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
        'User-Agent': 'solbeach-notices-app',
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

async function getFile() {
  const { owner, repo, branch } = repoInfo();
  const res = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${FILE_PATH}?ref=${branch}`);
  if (res.status === 404) {
    return { notices: [], sha: null };
  }
  if (res.status !== 200) {
    throw new Error(`GitHub 조회 실패 (status ${res.status}): ${res.raw.slice(0, 200)}`);
  }
  const content = Buffer.from(res.body.content, 'base64').toString('utf-8');
  let notices = [];
  try { notices = JSON.parse(content); } catch (e) { notices = []; }
  return { notices, sha: res.body.sha };
}

async function putFile(notices, sha, message) {
  const { owner, repo, branch } = repoInfo();
  const content = Buffer.from(JSON.stringify(notices, null, 2)).toString('base64');
  const payload = { message, content, branch };
  if (sha) payload.sha = sha;
  const res = await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${FILE_PATH}`, payload);
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

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { notices } = await getFile();
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

      const { notices, sha } = await getFile();
      const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const dateStr = now.toISOString().slice(0, 10);

      const important = payload.important === true;
      notices.unshift({ id: Date.now(), title, content, date: dateStr, important });
      const trimmed = notices.slice(0, MAX_NOTICES);

      await putFile(trimmed, sha, `공지사항 추가: ${title}`);
      res.status(200).json({ ok: true, notices: trimmed });
      return;
    }

    if (req.method === 'DELETE') {
      const payload = await readBody(req);
      if (payload.password !== ADMIN_PASSWORD) {
        res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
        return;
      }
      const { notices, sha } = await getFile();
      const filtered = notices.filter((n) => n.id !== payload.id);
      await putFile(filtered, sha, `공지사항 삭제 (id: ${payload.id})`);
      res.status(200).json({ ok: true, notices: filtered });
      return;
    }

    res.status(405).json({ error: '지원하지 않는 요청입니다.' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
