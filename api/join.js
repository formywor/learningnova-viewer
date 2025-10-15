// api/join.js
// Node 18+ runtime has fetch built-in
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "8000", 10);

// Allow list of candidate upstream endpoints (comma separated)
const UPSTREAM_URLS = (process.env.UPSTREAM_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
// Optional single upstream (if you prefer)
const UPSTREAM_BASE = process.env.UPSTREAM_BASE || "";

// Optional headers to send to upstream on POST (JSON)
let UPSTREAM_HEADERS = {};
try {
  UPSTREAM_HEADERS = JSON.parse(process.env.UPSTREAM_HEADERS || '{"Content-Type":"application/json"}');
} catch (_) {
  UPSTREAM_HEADERS = {"Content-Type":"application/json"};
}

// Build default guess list if none provided
function defaultCandidates(base, code, name) {
  // If base is a full URL like https://example.com, we’ll try common paths
  const roots = base ? [base] : [];
  const urls = UPSTREAM_URLS.length ? UPSTREAM_URLS : roots.flatMap(r => [
    `${r}/api/join`,
    `${r}/v1/join`,
    `${r}/join`
  ]);

  const enc = encodeURIComponent;
  const getQuery = `code=${enc(code)}&name=${enc(name)}`;

  // POST first, then GET for each URL
  const list = [];
  urls.forEach(u => {
    list.push({ info: `POST ${u}`, method: "POST", url: u, body: { code, name } });
    list.push({ info: `GET ${u}?${getQuery}`, method: "GET", url: `${u}?${getQuery}` });
  });
  return list;
}

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    run: promise(controller).finally(() => clearTimeout(id))
  };
}

export default async function handler(req, res) {
  // Basic CORS (adjust origin as needed)
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST /api/join with JSON { code, name }" });
  }

  const { code, name } = req.body || {};
  if (!code || !name) {
    return res.status(400).json({ error: "Missing code or name" });
  }

  // Build candidate attempts
  const attempts = [];
  if (UPSTREAM_URLS.length) {
    const enc = encodeURIComponent;
    const q = `code=${enc(code)}&name=${enc(name)}`;
    UPSTREAM_URLS.forEach(u => {
      attempts.push({ info: `POST ${u}`, method: "POST", url: u, body: { code, name } });
      attempts.push({ info: `GET ${u}?${q}`, method: "GET", url: `${u}?${q}` });
    });
  } else {
    attempts.push(...defaultCandidates(UPSTREAM_BASE, code, name));
  }

  let lastError = { status: 500, message: "No attempts made." };

  for (const a of attempts) {
    try {
      const run = withTimeout(async (controller) => {
        const opts = { method: a.method, signal: controller.signal };

        if (a.method === "POST") {
          opts.headers = UPSTREAM_HEADERS;
          opts.body = JSON.stringify(a.body);
        }

        const upstream = await fetch(a.url, opts);
        const rawText = await upstream.text().catch(() => "");
        let data;
        try { data = rawText ? JSON.parse(rawText) : {}; }
        catch { data = rawText; }

        if (upstream.ok) {
          // Pass through upstream success payload
          return { ok: true, status: upstream.status, data, info: a.info };
        } else {
          return { ok: false, status: upstream.status, data, info: a.info };
        }
      }, TIMEOUT_MS);

      const result = await run.run;
      if (result.ok) {
        return res.status(200).json({
          joined: true,
          upstreamStatus: result.status,
          via: result.info,
          data: result.data,
        });
      } else {
        lastError = {
          status: result.status,
          message: `Upstream error via ${result.info}`,
          data: result.data
        };
      }
    } catch (e) {
      lastError = {
        status: 502,
        message: `Fetch failed (timeout/CORS/host) via ${a.info}`,
      };
    }
  }

  return res.status(lastError.status || 502).json({
    joined: false,
    error: lastError.message,
    upstreamData: lastError.data ?? null
  });
}
