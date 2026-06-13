// pages/api/manga.js - Server-side proxy for MangaDex API
// This runs on Vercel servers, bypassing any browser CORS issues

export default async function handler(req, res) {
  const { path, ...params } = req.query;
  
  if (!path) {
    return res.status(400).json({ error: "Missing path" });
  }

  // Build the MangaDex URL with proper [] brackets
  const parts = [];
  Object.entries(params).forEach(([k, v]) => {
    const vals = Array.isArray(v) ? v : [v];
    vals.forEach(vi => parts.push(`${k}=${encodeURIComponent(vi)}`));
  });
  
  const mdxUrl = `https://api.mangadex.org/${path}${parts.length ? "?" + parts.join("&") : ""}`;
  
  try {
    const r = await fetch(mdxUrl, {
      headers: {
        "User-Agent": "KuroManga/2.0 (manga reader app)",
        "Accept": "application/json",
      },
    });
    
    if (!r.ok) {
      return res.status(r.status).json({ error: "MangaDex error", status: r.status });
    }
    
    const data = await r.json();
    
    // Cache for 5 minutes
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
