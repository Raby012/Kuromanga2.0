// pages/api/cover.js - Proxy MangaDex covers to bypass hotlink protection
export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");
  
  // Only allow MangaDex CDN URLs
  if (!url.startsWith("https://uploads.mangadex.org/")) {
    return res.status(403).send("Forbidden");
  }
  
  try {
    const r = await fetch(url, {
      headers: {
        "Referer": "https://mangadex.org/",
        "User-Agent": "Mozilla/5.0 (compatible)",
      },
    });
    
    if (!r.ok) return res.status(r.status).send("Failed");
    
    const buf = await r.arrayBuffer();
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).send("Error");
  }
}
