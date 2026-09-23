// pages/api/comick.js - Proxy for ComicK community mirrors (comick.io khud third-party
// access block kar chuka hai, isliye ye mirrors use karte hain - Tachiyomi ke open-source
// "Comick (Unoriginal)" extension ke code se confirm kiya).
// Domains yahan ek hi jagah rakhe hain - agar future me phir change ho, sirf yahan badalna.
const MIRRORS = ["https://comick.live", "https://comick.art"];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; KuroManga/1.0)",
  "Accept": "*/*",
};

// 429 (rate limited) aane par thoda ruk ke retry karo - max 3 baar per mirror
async function getWithRetry(url, isJson, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, { headers: HEADERS });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 400));
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return isJson ? r.json() : r.text();
  }
  throw new Error("Rate limited after retries");
}

// Ek mirror fail ho toh dusra try karo
async function withMirrors(path, isJson = true) {
  let lastErr;
  for (const base of MIRRORS) {
    try {
      return await getWithRetry(`${base}${path}`, isJson);
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(lastErr || "All ComicK mirrors failed");
}

// ComicK ke pages HTML ke andar embedded <script id="..."> JSON blob me hote hain
function extractScriptJson(html, id) {
  const re = new RegExp(`<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`);
  const m = html.match(re);
  if (!m) throw new Error(`${id} not found - page format may have changed`);
  return JSON.parse(m[1]);
}

export default async function handler(req, res) {
  const { action, q, slug, lang = "en", page = "1", chapterUrl } = req.query;
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");

  try {
    if (action === "search") {
      if (!q) return res.status(400).json({ error: "Missing q" });
      const data = await withMirrors(`/api/search?q=${encodeURIComponent(q)}`);
      return res.status(200).json(data);
    }

    if (action === "chapters") {
      if (!slug) return res.status(400).json({ error: "Missing slug" });
      const data = await withMirrors(`/api/comics/${slug}/chapter-list?lang=${lang}&page=${page}`);
      return res.status(200).json(data);
    }

    if (action === "details") {
      if (!slug) return res.status(400).json({ error: "Missing slug" });
      const html = await withMirrors(`/comic/${slug}`, false);
      const data = extractScriptJson(html, "comic-data");
      return res.status(200).json(data);
    }

    if (action === "pages") {
      if (!chapterUrl) return res.status(400).json({ error: "Missing chapterUrl" });
      const html = await withMirrors(chapterUrl, false);
      const parsed = extractScriptJson(html, "sv-data");
      const images = (parsed?.chapter?.images || []).map((img) => img.url);
      return res.status(200).json({ images });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(502).json({ error: "ComicK unavailable", detail: e.message });
  }
}
