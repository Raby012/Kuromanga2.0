import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// API CONFIG — All calls go through our Next.js proxy
// This bypasses CORS issues and MangaDex hotlink protection
// ============================================================
const MDX_COVERS = "https://uploads.mangadex.org/covers";

// Call our server-side proxy instead of MangaDex directly
const mdxFetch = async (path, params = {}) => {
  // Build query: pass path as param, rest as MangaDex params
  const parts = [`path=${encodeURIComponent(path.replace(/^\//, ""))}`];
  
  Object.entries(params).forEach(([k, v]) => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v)) {
      v.forEach(vi => parts.push(`${k}=${encodeURIComponent(vi)}`));
    } else {
      parts.push(`${k}=${encodeURIComponent(String(v))}`);
    }
  });

  const url = `/api/manga?${parts.join("&")}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("API " + r.status);
  return r.json();
};

// Cover via proxy to fix "You can read this at" watermark
const proxyCover = (mangaId, fileName, size = 256) => {
  if (!fileName) return "";
  const mdxUrl = `${MDX_COVERS}/${mangaId}/${fileName}.${size}.jpg`;
  return `/api/cover?url=${encodeURIComponent(mdxUrl)}`;
};

// MangaDex at-home (chapter pages) - called directly, no proxy needed
const chapterPagesFetch = (chapterId) =>
  fetch(`https://api.mangadex.org/at-home/server/${chapterId}`).then(r => r.json());

// ComicK fetch - hamare /api/comick proxy ke through (rate-limit safe, mirrors handled server-side)
const comickFetch = async (params) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  const r = await fetch(`/api/comick?${parts.join("&")}`);
  if (!r.ok) throw new Error("ComicK API " + r.status);
  return r.json();
};

// Title ko normalize karo taaki dono sources (MangaDex + ComicK) ke titles compare ho sakein.
// NOTE: ye sirf exact-normalized-match hai (case/punctuation/accents ignore karke) -
// pura alag-script wala alt-title (jaise Korean vs English) match nahi karega.
// Isliye dedup sirf tabhi kaam karega jab dono sources same (usually English) title de rahe hon.
const normTitle = (t) => (t || "")
  .toLowerCase()
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

// ============================================================
// NORMALIZERS
// ============================================================
const getMangaTitle = (m) => {
  const t = m.attributes?.title || {};
  return t.en || t["ja-ro"] || t.ja || t.ko || t["ko-ro"] || t.zh || Object.values(t)[0] || "Unknown";
};

const getMangaCover = (m, size = 256) => {
  const cv = (m.relationships || []).find(r => r.type === "cover_art");
  if (cv?.attributes?.fileName) return proxyCover(m.id, cv.attributes.fileName, size);
  return "";
};

const getMangaType = (m) => {
  const lang = m.attributes?.originalLanguage || "";
  if (["ko", "ko-ro"].includes(lang)) return "manhwa";
  if (["zh", "zh-hk", "zh-ro"].includes(lang)) return "manhua";
  return "manga";
};

const normalizeForCard = (m) => ({
  id: m.id,
  title: getMangaTitle(m),
  cover: getMangaCover(m, 256),
  cover512: getMangaCover(m, 512),
  type: getMangaType(m),
  status: m.attributes?.status || "ongoing",
  rating: (() => { const r = m.attributes?.rating; return r ? Number(r.bayesian || r.average || 0).toFixed(1) : null; })(),
  lastChapter: m.attributes?.lastChapter || null,
  year: m.attributes?.year || null,
  description: (() => { const d = m.attributes?.description || {}; return d.en || Object.values(d)[0] || ""; })(),
  tags: (m.attributes?.tags || []).map(t => (t.attributes?.name || {}).en || "").filter(Boolean),
  altTitles: (m.attributes?.altTitles || []).flatMap(o => Object.values(o)).filter(Boolean),
  source: "mangadex",
});

// ComicK search result -> same card shape jo MangaDex use karta hai.
// Search response me "country" nahi aata (sirf details page pe), isliye type yahan
// "unknown" rakha hai - InfoPage khulne par asli type details se update ho jaata hai.
const normalizeComickForCard = (c) => ({
  id: `comick:${c.slug}`,
  slug: c.slug,
  source: "comick",
  title: c.title || "Unknown",
  cover: c.default_thumbnail || c.thumbnail || "",
  cover512: c.default_thumbnail || c.thumbnail || "",
  type: "unknown",
  status: "ongoing",
  rating: null,
  lastChapter: null,
  year: null,
  description: "",
  tags: [],
  altTitles: [],
});

// Do lists (MangaDex + ComicK) ko title ke basis par merge karo, duplicates hata ke.
// MangaDex ko priority di gayi hai (zyada reliable/complete metadata) - agar same
// normalized title dono me mile toh MangaDex wala hi rakha jaata hai.
const mergeCatalogs = (mdxList, comickList) => {
  const seen = new Map();
  mdxList.forEach(m => seen.set(normTitle(m.title), m));
  comickList.forEach(c => {
    const key = normTitle(c.title);
    if (key && !seen.has(key)) seen.set(key, c);
  });
  return Array.from(seen.values());
};

// ============================================================
// API CALLS — use our proxy at /api/manga
// The proxy handles proper [] bracket formatting server-side
// ============================================================
const DEF = {
  "includes[]": ["cover_art", "author", "artist"],
  "contentRating[]": ["safe", "suggestive"],
};

const API = {
  trending: () => mdxFetch("/manga", { ...DEF, limit: 24, "order[followedCount]": "desc" }),
  topRated: () => mdxFetch("/manga", { ...DEF, limit: 24, "order[rating]": "desc" }),
  latest:   () => mdxFetch("/manga", { ...DEF, limit: 24, "order[latestUploadedChapter]": "desc" }),
  newAdded: () => mdxFetch("/manga", { ...DEF, limit: 24, "order[createdAt]": "desc" }),

  browse: (page = 1, type = "", status = "", order = "followedCount") => {
    const p = { ...DEF, limit: 24, offset: (page - 1) * 24, ["order[" + order + "]"]: "desc" };
    if (type === "manhwa") p["originalLanguage[]"] = ["ko", "ko-ro"];
    else if (type === "manhua") p["originalLanguage[]"] = ["zh", "zh-hk", "zh-ro"];
    else if (type === "manga") p["originalLanguage[]"] = ["ja"];
    if (status) p["status[]"] = [status];
    return mdxFetch("/manga", p);
  },

  search: (q, page = 1, type = "", status = "") => {
    const p = { ...DEF, limit: 24, offset: (page - 1) * 24, title: q };
    if (type === "manhwa") p["originalLanguage[]"] = ["ko", "ko-ro"];
    else if (type === "manhua") p["originalLanguage[]"] = ["zh", "zh-hk", "zh-ro"];
    else if (type === "manga") p["originalLanguage[]"] = ["ja"];
    if (status) p["status[]"] = [status];
    return mdxFetch("/manga", p);
  },

  manga: (id) => mdxFetch(`/manga/${id}`, {
    "includes[]": ["cover_art", "author", "artist", "scanlation_group"],
  }),

  chapters: (mangaId) => mdxFetch(`/manga/${mangaId}/feed`, {
    limit: 500,
    offset: 0,
    "translatedLanguage[]": ["en"],
    "order[chapter]": "desc",
    "includes[]": ["scanlation_group"],
    "contentRating[]": ["safe", "suggestive"],
  }),

  autocomplete: (q) => mdxFetch("/manga", { ...DEF, limit: 6, title: q }),

  chapterPages: chapterPagesFetch,
  comickSearch: (title) => comickFetch({ action: "search", q: title }),
  comickChapters: (slug) => comickFetch({ action: "chapters", slug, lang: "en" }),
  comickDetails: (slug) => comickFetch({ action: "details", slug }),
  comickPages: (chapterUrl) => comickFetch({ action: "pages", chapterUrl }),
};

// ============================================================
// STYLES
// ============================================================
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Dela+Gothic+One&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#06060f;--bg2:#0c0c1a;--bg3:#111120;
  --s1:#181828;--s2:#1e1e32;--s3:#24243a;
  --b1:#2a2a48;--b2:#363660;
  --a1:#7c3aed;--a2:#9333ea;--a3:#a855f7;--a4:#c084fc;
  --pk:#ec4899;--cy:#06b6d4;--gn:#10b981;--yw:#f59e0b;--rd:#ef4444;
  --t1:#f4f4ff;--t2:#b0b0d0;--t3:#707090;--t4:#404060;
  --glow:0 0 28px rgba(124,58,237,.5);
  --r:12px;--r2:16px;--r3:20px;
}
html{scroll-behavior:smooth;}
body{background:var(--bg);color:var(--t1);font-family:'Space Grotesk',sans-serif;min-height:100vh;overflow-x:hidden;}
::-webkit-scrollbar{width:5px;}::-webkit-scrollbar-track{background:var(--bg2);}::-webkit-scrollbar-thumb{background:var(--a1);border-radius:3px;}

/* NAV */
.nav{position:fixed;top:0;left:0;right:0;z-index:200;height:60px;
  background:rgba(6,6,15,.92);backdrop-filter:blur(24px);
  border-bottom:1px solid var(--b1);
  display:flex;align-items:center;padding:0 20px;gap:14px;}
.logo{font-family:'Dela Gothic One',cursive;font-size:20px;cursor:pointer;letter-spacing:.5px;
  background:linear-gradient(130deg,var(--a3),var(--pk));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;flex-shrink:0;}
.nav-links{display:flex;gap:2px;}
.nl{padding:6px 13px;border-radius:8px;font-size:13px;font-weight:500;color:var(--t2);
  cursor:pointer;border:none;background:transparent;transition:all .2s;font-family:'Space Grotesk',sans-serif;}
.nl:hover,.nl.on{color:var(--t1);background:var(--s2);}
.nl.on{color:var(--a4);}
.nav-search-wrap{flex:1;max-width:380px;margin-left:auto;position:relative;}
.nav-search-input{width:100%;background:var(--s1);border:1px solid var(--b1);border-radius:10px;
  padding:8px 38px 8px 14px;color:var(--t1);font-size:13px;
  font-family:'Space Grotesk',sans-serif;outline:none;transition:all .2s;}
.nav-search-input:focus{border-color:var(--a1);box-shadow:0 0 0 2px rgba(124,58,237,.15);}
.nav-search-input::placeholder{color:var(--t4);}
.nav-search-btn{position:absolute;right:10px;top:50%;transform:translateY(-50%);
  background:none;border:none;cursor:pointer;color:var(--t3);font-size:16px;}
.nav-search-btn:hover{color:var(--a4);}
.autocomplete{position:absolute;top:calc(100% + 6px);left:0;right:0;
  background:var(--s1);border:1px solid var(--b1);border-radius:12px;
  max-height:360px;overflow-y:auto;z-index:400;
  box-shadow:0 16px 48px rgba(0,0,0,.7);}
.ac-item{display:flex;align-items:center;gap:12px;padding:10px 14px;
  cursor:pointer;transition:background .15s;border-bottom:1px solid var(--b1);}
.ac-item:last-child{border-bottom:none;}
.ac-item:hover{background:var(--s2);}
.ac-img{width:36px;height:50px;object-fit:cover;border-radius:6px;background:var(--s2);flex-shrink:0;}
.ac-info .ac-title{font-size:13px;font-weight:600;color:var(--t1);}
.ac-info .ac-meta{font-size:11px;color:var(--t3);margin-top:2px;}

/* MAIN */
.main{padding-top:60px;}
.hero{padding:52px 24px 40px;text-align:center;position:relative;overflow:hidden;
  background:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(124,58,237,.18) 0%,transparent 70%);}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--a1),var(--pk),transparent);}
.hero-badge{display:inline-flex;align-items:center;gap:7px;
  background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.28);
  border-radius:100px;padding:5px 14px;margin-bottom:20px;
  font-size:12px;color:var(--a4);font-weight:500;}
.hdot{width:7px;height:7px;border-radius:50%;background:var(--a3);animation:hpulse 2s infinite;}
@keyframes hpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.htitle{font-family:'Dela Gothic One',cursive;
  font-size:clamp(28px,6vw,58px);line-height:1.08;margin-bottom:12px;}
.htitle em{font-style:normal;
  background:linear-gradient(135deg,var(--a3) 0%,var(--pk) 50%,var(--cy) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.hsub{font-size:15px;color:var(--t2);max-width:460px;margin:0 auto 28px;line-height:1.65;}
.hero-search{display:flex;align-items:center;max-width:540px;margin:0 auto;
  background:var(--s1);border:1px solid var(--b1);border-radius:14px;
  padding:5px 5px 5px 18px;transition:all .25s;}
.hero-search:focus-within{border-color:var(--a1);box-shadow:0 0 0 3px rgba(124,58,237,.15);}
.hs-input{flex:1;background:none;border:none;outline:none;color:var(--t1);
  font-size:14px;font-family:'Space Grotesk',sans-serif;padding:9px 0;}
.hs-input::placeholder{color:var(--t3);}
.hs-btn{background:linear-gradient(135deg,var(--a1),var(--a2));
  border:none;border-radius:10px;padding:10px 22px;
  color:#fff;font-size:14px;font-weight:600;cursor:pointer;
  font-family:'Space Grotesk',sans-serif;transition:all .2s;white-space:nowrap;}
.hs-btn:hover{opacity:.85;transform:translateY(-1px);}
.stats-bar{display:flex;justify-content:center;gap:36px;margin-top:32px;flex-wrap:wrap;}
.stat-item{text-align:center;}
.stat-num{font-family:'Dela Gothic One',cursive;font-size:24px;
  background:linear-gradient(135deg,var(--a3),var(--pk));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.stat-lbl{font-size:11px;color:var(--t3);margin-top:2px;letter-spacing:.04em;text-transform:uppercase;}
.sec{padding:32px 24px;max-width:1440px;margin:0 auto;}
.sec-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:8px;}
.sec-title{font-size:17px;font-weight:700;color:var(--t1);display:flex;align-items:center;gap:10px;}
.sec-title::before{content:'';display:block;width:3px;height:22px;
  background:linear-gradient(to bottom,var(--a3),var(--pk));border-radius:2px;}
.sec-more{font-size:12px;color:var(--a4);cursor:pointer;background:none;border:none;
  font-family:'Space Grotesk',sans-serif;transition:opacity .2s;}
.sec-more:hover{opacity:.7;}
.type-tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;}
.ttab{padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;
  cursor:pointer;border:1px solid var(--b1);background:var(--s2);color:var(--t2);
  transition:all .2s;font-family:'Space Grotesk',sans-serif;}
.ttab:hover{border-color:var(--a1);color:var(--t1);}
.ttab.on{background:rgba(124,58,237,.2);border-color:var(--a1);color:var(--a4);}

/* MANGA GRID */
.mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:16px;}
.mgrid.large{grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:18px;}
.mcard{cursor:pointer;border-radius:var(--r2);overflow:hidden;
  background:var(--s1);border:1px solid var(--b1);transition:all .28s;position:relative;}
.mcard:hover{transform:translateY(-5px);border-color:var(--a1);box-shadow:var(--glow);}
.mcard:hover .mcard-ov{opacity:1;}
.mcard:hover .mcard-img{transform:scale(1.05);}
.mcard-img-wrap{position:relative;overflow:hidden;}
.mcard-img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;
  background:var(--s2);transition:transform .3s;}
.mcard-ov{position:absolute;inset:0;
  background:linear-gradient(to top,rgba(6,6,15,.95) 0%,rgba(6,6,15,.2) 55%,transparent 100%);
  opacity:0;transition:opacity .28s;display:flex;align-items:flex-end;padding:10px;}
.mcard-ov-btn{background:linear-gradient(135deg,var(--a1),var(--a2));
  border:none;border-radius:8px;padding:7px 0;color:#fff;font-size:12px;font-weight:600;
  cursor:pointer;font-family:'Space Grotesk',sans-serif;width:100%;}
.type-chip{position:absolute;top:8px;left:8px;z-index:2;font-size:9px;font-weight:700;
  padding:3px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:.06em;backdrop-filter:blur(10px);}
.tc-manhwa{background:rgba(124,58,237,.8);color:#e8d5ff;}
.tc-manga{background:rgba(236,72,153,.8);color:#fce7f3;}
.tc-manhua{background:rgba(6,182,212,.8);color:#cffafe;}
.status-dot{position:absolute;top:8px;right:8px;z-index:2;
  width:8px;height:8px;border-radius:50%;border:2px solid rgba(0,0,0,.6);}
.sd-ongoing{background:var(--gn);}.sd-completed{background:var(--t3);}.sd-hiatus{background:var(--yw);}
.mcard-body{padding:10px 11px 12px;}
.mcard-title{font-size:12px;font-weight:600;color:var(--t1);overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.42;margin-bottom:5px;}
.mcard-meta{display:flex;align-items:center;justify-content:space-between;}
.mcard-rating{font-size:11px;color:#f59e0b;font-weight:600;}
.mcard-ch{font-size:11px;color:var(--t3);}

/* BROWSE */
.browse-page{padding:76px 24px 48px;max-width:1440px;margin:0 auto;}
.browse-title{font-size:26px;font-weight:700;margin-bottom:20px;}
.filters-bar{background:var(--s1);border:1px solid var(--b1);border-radius:var(--r2);
  padding:16px 18px;margin-bottom:22px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;}
.filter-label{font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;font-weight:600;white-space:nowrap;}
.filter-chips{display:flex;gap:6px;flex-wrap:wrap;}
.fchip{padding:5px 13px;border-radius:8px;font-size:12px;font-weight:500;
  cursor:pointer;border:1px solid var(--b1);background:var(--s2);color:var(--t2);
  transition:all .2s;font-family:'Space Grotesk',sans-serif;}
.fchip:hover{border-color:var(--a1);color:var(--t1);}
.fchip.on{background:rgba(124,58,237,.2);border-color:var(--a1);color:var(--a4);}
.filter-divider{width:1px;height:22px;background:var(--b1);flex-shrink:0;}
.filter-select{background:var(--s2);border:1px solid var(--b1);border-radius:9px;
  padding:7px 12px;color:var(--t1);font-size:13px;
  font-family:'Space Grotesk',sans-serif;outline:none;cursor:pointer;transition:all .2s;}
.filter-select:focus{border-color:var(--a1);}
.filter-select option{background:var(--s2);}
.results-info{font-size:13px;color:var(--t3);margin-bottom:14px;}
.results-info strong{color:var(--t1);}
.pagination{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:32px;flex-wrap:wrap;}
.pg-btn{background:var(--s1);border:1px solid var(--b1);border-radius:8px;
  padding:7px 14px;color:var(--t2);font-size:13px;cursor:pointer;
  transition:all .2s;font-family:'Space Grotesk',sans-serif;font-weight:500;}
.pg-btn:hover{border-color:var(--a1);color:var(--t1);}
.pg-btn.on{background:rgba(124,58,237,.2);border-color:var(--a1);color:var(--a4);}
.pg-btn:disabled{opacity:.3;cursor:not-allowed;}

/* INFO PAGE */
.info-pg{padding:76px 24px 48px;max-width:1140px;margin:0 auto;}
.info-hero{display:flex;gap:26px;margin-bottom:32px;background:var(--s1);
  border:1px solid var(--b1);border-radius:var(--r3);padding:26px;position:relative;overflow:hidden;}
.info-hero::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(90deg,var(--a1),var(--pk),var(--cy));}
.info-cover{width:185px;flex-shrink:0;border-radius:var(--r);object-fit:cover;
  background:var(--s2);aspect-ratio:2/3;align-self:flex-start;}
.info-body{flex:1;min-width:0;}
.info-title{font-family:'Dela Gothic One',cursive;font-size:clamp(18px,3.5vw,32px);line-height:1.15;margin-bottom:10px;}
.info-chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px;}
.ichip{font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;text-transform:uppercase;letter-spacing:.05em;}
.ic-manhwa{background:rgba(124,58,237,.2);color:var(--a4);}
.ic-manga{background:rgba(236,72,153,.2);color:var(--pk);}
.ic-manhua{background:rgba(6,182,212,.2);color:var(--cy);}
.ic-ongoing{background:rgba(16,185,129,.15);color:var(--gn);}
.ic-completed{background:rgba(160,160,192,.15);color:var(--t2);}
.ic-hiatus{background:rgba(245,158,11,.15);color:var(--yw);}
.info-desc{font-size:14px;color:var(--t2);line-height:1.75;margin-bottom:14px;max-height:120px;overflow:hidden;}
.info-desc.expanded{max-height:none;}
.desc-toggle{font-size:12px;color:var(--a4);cursor:pointer;background:none;border:none;
  font-family:'Space Grotesk',sans-serif;margin-bottom:16px;display:block;}
.info-stats{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px;}
.istat-lbl{font-size:11px;color:var(--t3);margin-bottom:2px;}
.istat-val{font-size:14px;font-weight:600;color:var(--t1);}
.genres-wrap{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;}
.gtag{background:var(--s2);border:1px solid var(--b1);border-radius:7px;padding:3px 10px;font-size:11px;color:var(--t2);}
.info-btns{display:flex;gap:10px;flex-wrap:wrap;}
.read-btn{background:linear-gradient(135deg,var(--a1),var(--a2));border:none;border-radius:11px;
  padding:11px 24px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;
  font-family:'Space Grotesk',sans-serif;transition:all .2s;display:inline-flex;align-items:center;gap:8px;}
.read-btn:hover{transform:translateY(-2px);box-shadow:var(--glow);}
.read-btn-alt{background:var(--s2);border:1px solid var(--b1);border-radius:11px;
  padding:11px 20px;color:var(--t1);font-size:14px;font-weight:600;cursor:pointer;
  font-family:'Space Grotesk',sans-serif;transition:all .2s;}
.read-btn-alt:hover{border-color:var(--a1);color:var(--a4);}
.chaps-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:10px;}
.chaps-title{font-size:16px;font-weight:700;}
.chaps-cnt{font-size:12px;color:var(--t3);background:var(--s1);padding:3px 10px;border-radius:20px;margin-left:8px;}
.chap-search{background:var(--s2);border:1px solid var(--b1);border-radius:9px;
  padding:7px 14px;color:var(--t1);font-size:13px;
  font-family:'Space Grotesk',sans-serif;outline:none;width:180px;transition:all .2s;}
.chap-search:focus{border-color:var(--a1);}
.chap-search::placeholder{color:var(--t4);}
.chaps-list{display:flex;flex-direction:column;gap:6px;max-height:480px;overflow-y:auto;padding-right:4px;}
.chaps-list::-webkit-scrollbar{width:4px;}
.chaps-list::-webkit-scrollbar-thumb{background:var(--a1);border-radius:4px;}
.chap-item{background:var(--s1);border:1px solid var(--b1);border-radius:11px;
  padding:12px 16px;cursor:pointer;transition:all .2s;
  display:flex;align-items:center;justify-content:space-between;gap:8px;}
.chap-item:hover{border-color:var(--a1);background:var(--s2);transform:translateX(4px);}
.chap-num{font-size:13px;font-weight:700;color:var(--t1);flex-shrink:0;}
.chap-title-txt{font-size:12px;color:var(--t3);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.chap-pg{font-size:11px;color:var(--t4);flex-shrink:0;}
.no-chaps{text-align:center;padding:36px 20px;color:var(--t3);font-size:14px;}

/* READER */
.reader{background:#000;min-height:100vh;padding-top:60px;}
.reader-nav{position:fixed;top:0;left:0;right:0;z-index:300;height:60px;
  background:rgba(0,0,0,.94);backdrop-filter:blur(20px);
  border-bottom:1px solid var(--b1);
  display:flex;align-items:center;padding:0 16px;gap:10px;}
.reader-info{font-size:13px;color:var(--t2);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0;}
.reader-info strong{color:var(--t1);}
.rcontrols{display:flex;gap:6px;align-items:center;flex-shrink:0;}
.rbtn{background:var(--s1);border:1px solid var(--b1);border-radius:8px;
  padding:6px 12px;color:var(--t1);font-size:12px;font-weight:500;cursor:pointer;
  transition:all .2s;font-family:'Space Grotesk',sans-serif;white-space:nowrap;}
.rbtn:hover{border-color:var(--a1);color:var(--a4);}
.rbtn:disabled{opacity:.3;cursor:not-allowed;}
.rbtn.on{background:rgba(124,58,237,.25);border-color:var(--a1);color:var(--a4);}
.chap-select{background:var(--s1);border:1px solid var(--b1);border-radius:8px;
  padding:5px 8px;color:var(--t1);font-size:12px;
  font-family:'Space Grotesk',sans-serif;outline:none;cursor:pointer;max-width:150px;}
.scroll-imgs{display:flex;flex-direction:column;align-items:center;gap:1px;padding:16px 0 80px;}
.scroll-img{max-width:850px;width:100%;display:block;background:var(--s1);}
.single-wrap{display:flex;flex-direction:column;align-items:center;
  padding:16px 0 100px;min-height:calc(100vh - 60px);}
.single-img{max-width:850px;width:100%;display:block;background:var(--s1);}
.page-bar{position:fixed;bottom:0;left:0;right:0;z-index:300;
  background:rgba(0,0,0,.9);backdrop-filter:blur(16px);border-top:1px solid var(--b1);
  display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 20px;}
.pg-nav-btn{background:var(--s1);border:1px solid var(--b1);border-radius:9px;
  padding:8px 18px;color:var(--t1);font-size:13px;font-weight:600;cursor:pointer;
  transition:all .2s;font-family:'Space Grotesk',sans-serif;}
.pg-nav-btn:hover{border-color:var(--a1);color:var(--a4);}
.pg-nav-btn:disabled{opacity:.3;cursor:not-allowed;}
.pg-label{font-size:13px;color:var(--t2);min-width:70px;text-align:center;font-weight:500;}
.reader-loading{display:flex;flex-direction:column;align-items:center;
  justify-content:center;min-height:calc(100vh - 60px);gap:18px;}
.reader-err{display:flex;flex-direction:column;align-items:center;
  justify-content:center;min-height:calc(100vh - 60px);gap:14px;
  color:var(--t2);text-align:center;padding:0 24px;}
.reader-err h3{font-size:20px;color:var(--t1);}
.page-err{max-width:850px;width:100%;background:var(--s2);aspect-ratio:3/4;
  display:flex;align-items:center;justify-content:center;color:var(--t3);font-size:13px;}

/* LOADER / SKELETON */
.loader{display:flex;align-items:center;justify-content:center;padding:70px;flex-direction:column;gap:16px;}
.lring{width:40px;height:40px;border:3px solid var(--b1);
  border-top-color:var(--a3);border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.ltxt{font-size:13px;color:var(--t3);}
.skel{background:linear-gradient(90deg,var(--s1) 25%,var(--s2) 50%,var(--s1) 75%);
  background-size:200% 100%;animation:shim 1.4s infinite;border-radius:8px;}
@keyframes shim{0%{background-position:200% 0}100%{background-position:-200% 0}}
.empty{text-align:center;padding:70px 24px;color:var(--t3);}
.empty-icon{font-size:50px;margin-bottom:16px;}
.empty-txt{font-size:17px;color:var(--t2);margin-bottom:8px;font-weight:600;}
.empty-sub{font-size:14px;}
.back{display:inline-flex;align-items:center;gap:8px;background:var(--s1);
  border:1px solid var(--b1);border-radius:10px;padding:7px 15px;color:var(--t2);font-size:13px;
  cursor:pointer;margin-bottom:22px;transition:all .2s;font-family:'Space Grotesk',sans-serif;}
.back:hover{border-color:var(--a1);color:var(--t1);}
.load-more{width:100%;background:var(--s1);border:1px solid var(--b1);border-radius:12px;
  padding:12px;color:var(--t2);cursor:pointer;font-size:14px;
  font-family:'Space Grotesk',sans-serif;margin-top:12px;transition:all .2s;}
.load-more:hover{border-color:var(--a1);color:var(--t1);}
.err-banner{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);
  border-radius:10px;padding:12px 18px;color:#fca5a5;font-size:13px;
  margin-bottom:16px;display:flex;align-items:center;gap:10px;}

/* MOBILE */
@media(max-width:640px){
  .nav-links{display:none;}
  .info-hero{flex-direction:column;}
  .info-cover{width:100%;max-height:260px;object-fit:cover;}
  .mgrid{grid-template-columns:repeat(3,1fr);gap:8px;}
  .mgrid.large{grid-template-columns:repeat(2,1fr);}
  .hero{padding:36px 14px 28px;}
  .sec{padding:22px 14px;}
  .browse-page,.info-pg{padding:70px 14px 40px;}
  .filters-bar{padding:12px;}
}
@media(max-width:380px){.mgrid{grid-template-columns:repeat(2,1fr);}}
`;

// ============================================================
// SMALL COMPONENTS
// ============================================================
const Loader = ({ text = "Loading..." }) => (
  <div className="loader"><div className="lring" /><div className="ltxt">{text}</div></div>
);

const SkeletonGrid = ({ count = 12 }) => (
  <div className="mgrid">
    {Array(count).fill(0).map((_, i) => (
      <div key={i} className="mcard">
        <div className="skel" style={{ aspectRatio: "2/3", width: "100%" }} />
        <div style={{ padding: "10px" }}>
          <div className="skel" style={{ height: 12, marginBottom: 6 }} />
          <div className="skel" style={{ height: 10, width: "55%" }} />
        </div>
      </div>
    ))}
  </div>
);

const MangaCard = ({ m, onClick }) => {
  const tcMap = { manhwa: "tc-manhwa", manga: "tc-manga", manhua: "tc-manhua" };
  const sdMap = { ongoing: "sd-ongoing", completed: "sd-completed", hiatus: "sd-hiatus" };
  return (
    <div className="mcard" onClick={() => onClick(m)}>
      <span className={`type-chip ${tcMap[m.type] || "tc-manhwa"}`}>{m.type}</span>
      <span className={`status-dot ${sdMap[m.status] || "sd-ongoing"}`} />
      <div className="mcard-img-wrap">
        <img className="mcard-img" src={m.cover} alt={m.title} loading="lazy"
          onError={e => {
            e.target.onerror = null;
            e.target.src = `https://placehold.co/300x450/111120/a855f7?text=${encodeURIComponent((m.title || "").slice(0, 12))}`;
          }} />
        <div className="mcard-ov">
          <button className="mcard-ov-btn">▶ Read Now</button>
        </div>
      </div>
      <div className="mcard-body">
        <div className="mcard-title">{m.title}</div>
        <div className="mcard-meta">
          {m.rating && <span className="mcard-rating">★ {m.rating}</span>}
          {m.lastChapter && <span className="mcard-ch">Ch.{m.lastChapter}</span>}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// HOME PAGE
// ============================================================
const HOME_TABS = [
  { id: "trending", label: "🔥 Trending",  order: "followedCount" },
  { id: "toprated", label: "⭐ Top Rated", order: "rating" },
  { id: "latest",   label: "⚡ Latest",    order: "latestUploadedChapter" },
  { id: "new",      label: "🆕 New",       order: "createdAt" },
];
const TYPE_FILTERS = ["All", "Manhwa", "Manga", "Manhua"];

const HomePage = ({ onMangaClick, onSearch, onBrowse }) => {
  const [activeTab, setActiveTab] = useState(0);
  const [typeFilter, setTypeFilter] = useState("All");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const searchRef = useRef();
  const cacheRef = useRef({});

  const loadTab = async (idx) => {
    setActiveTab(idx);
    setTypeFilter("All");
    if (cacheRef.current[idx]) {
      setItems(cacheRef.current[idx]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setItems([]);
    try {
      const res = await mdxFetch("/manga", {
        ...DEF, limit: 24,
        ["order[" + HOME_TABS[idx].order + "]"]: "desc",
      });
      const data = (res.data || []).map(normalizeForCard);
      cacheRef.current[idx] = data;
      setItems(data);
    } catch (e) {
      console.error("loadTab:", e);
      setError("Failed to load. Please refresh.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTab(0); }, []);

  const displayed = typeFilter === "All"
    ? items
    : items.filter(m => m.type === typeFilter.toLowerCase());

  return (
    <div className="main">
      <div className="hero">
        <div className="hero-badge"><div className="hdot" />50,000+ Series · All Chapters · Always Free</div>
        <h1 className="htitle">Read the Best<br /><em>Manga, Manhwa & Manhua</em></h1>
        <p className="hsub">Every title. Every chapter. Every page — completely free. Powered by MangaDex.</p>
        <div className="hero-search">
          <input ref={searchRef} className="hs-input"
            placeholder="Search Solo Leveling, One Piece, Tower of God..."
            onKeyDown={e => e.key === "Enter" && onSearch(searchRef.current?.value)} />
          <button className="hs-btn" onClick={() => onSearch(searchRef.current?.value)}>Search →</button>
        </div>
        <div className="stats-bar">
          <div className="stat-item"><div className="stat-num">50K+</div><div className="stat-lbl">Titles</div></div>
          <div className="stat-item"><div className="stat-num">1M+</div><div className="stat-lbl">Chapters</div></div>
          <div className="stat-item"><div className="stat-num">All</div><div className="stat-lbl">Languages</div></div>
          <div className="stat-item"><div className="stat-num">Free</div><div className="stat-lbl">Always</div></div>
        </div>
      </div>

      <div className="sec">
        <div className="sec-hd">
          <div className="type-tabs">
            {HOME_TABS.map((t, i) => (
              <button key={t.id} className={`ttab ${activeTab === i ? "on" : ""}`} onClick={() => loadTab(i)}>{t.label}</button>
            ))}
          </div>
          <button className="sec-more" onClick={onBrowse}>See all →</button>
        </div>

        <div className="type-tabs">
          {TYPE_FILTERS.map(t => (
            <button key={t} className={`ttab ${typeFilter === t ? "on" : ""}`} onClick={() => setTypeFilter(t)}>{t}</button>
          ))}
        </div>

        {error && (
          <div className="err-banner">⚠️ {error} <button onClick={() => loadTab(activeTab)} style={{ marginLeft: "auto", background: "none", border: "1px solid #fca5a5", borderRadius: 6, padding: "4px 12px", color: "#fca5a5", cursor: "pointer" }}>Retry</button></div>
        )}

        {loading ? <SkeletonGrid count={12} /> : displayed.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">🔍</div>
            <div className="empty-txt">No {typeFilter} found</div>
            <div className="empty-sub">Try a different tab or filter</div>
          </div>
        ) : (
          <div className="mgrid">{displayed.map(m => <MangaCard key={m.id} m={m} onClick={onMangaClick} />)}</div>
        )}
      </div>
    </div>
  );
};

// ============================================================
// BROWSE PAGE
// ============================================================
const TYPE_CHIPS = [
  { v: "", l: "All Types" }, { v: "manhwa", l: "Manhwa 🇰🇷" },
  { v: "manga", l: "Manga 🇯🇵" }, { v: "manhua", l: "Manhua 🇨🇳" },
];
const ORDERS = [
  { v: "followedCount", l: "Most Popular" },
  { v: "rating", l: "Top Rated" },
  { v: "latestUploadedChapter", l: "Latest Chapter" },
  { v: "createdAt", l: "Newest Added" },
  { v: "title", l: "A-Z" },
];

const BrowsePage = ({ initialQ = "", onMangaClick }) => {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [order, setOrder] = useState("followedCount");
  const [searchQ, setSearchQ] = useState(initialQ);
  const searchRef = useRef();
  const PER = 24;

  const load = async (pg, t, s, o, q) => {
    setLoading(true);
    setError(null);
    window.scrollTo(0, 0);
    try {
      if (q?.trim()) {
        // Search: MangaDex + ComicK dono se, title ke basis par dedup karke
        const res = await API.search(q, pg, t, s);
        const mdxResults = (res.data || []).map(normalizeForCard);

        let comickResults = [];
        try {
          const cRes = await API.comickSearch(q);
          comickResults = (cRes?.data || []).map(normalizeComickForCard);
        } catch (e) {
          console.error("ComicK search failed (MangaDex results still shown):", e);
        }

        setResults(mergeCatalogs(mdxResults, comickResults));
        setTotal(res.total || mdxResults.length);
      } else {
        // Plain browse (no search query): sirf MangaDex, kyunki ComicK ka
        // koi general "browse by filter" endpoint hamare paas nahi hai abhi.
        const res = await API.browse(pg, t, s, o);
        setResults((res.data || []).map(normalizeForCard));
        setTotal(res.total || 0);
      }
    } catch (e) {
      console.error("browse:", e);
      setError("Failed to load. Please try again.");
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(page, type, status, order, searchQ); }, [page, type, status, order, searchQ]);

  const doSearch = () => {
    const q = searchRef.current?.value || "";
    setSearchQ(q);
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(total / PER));
  const getPgs = () => {
    const pgs = [];
    for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) pgs.push(i);
    return pgs;
  };

  return (
    <div className="browse-page">
      <h2 className="browse-title">Browse</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <div className="hero-search" style={{ flex: 1, maxWidth: 520, margin: 0 }}>
          <input ref={searchRef} className="hs-input" placeholder="Search titles..."
            defaultValue={initialQ}
            onKeyDown={e => e.key === "Enter" && doSearch()} />
          <button className="hs-btn" onClick={doSearch}>Search</button>
        </div>
        {searchQ && (
          <button className="rbtn" onClick={() => { setSearchQ(""); if (searchRef.current) searchRef.current.value = ""; setPage(1); }}>Clear ×</button>
        )}
      </div>

      <div className="filters-bar">
        <span className="filter-label">Type:</span>
        <div className="filter-chips">
          {TYPE_CHIPS.map(c => (
            <button key={c.v} className={`fchip ${type === c.v ? "on" : ""}`}
              onClick={() => { setType(c.v); setPage(1); }}>{c.l}</button>
          ))}
        </div>
        <div className="filter-divider" />
        <span className="filter-label">Status:</span>
        <select className="filter-select" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All Status</option>
          <option value="ongoing">Ongoing</option>
          <option value="completed">Completed</option>
          <option value="hiatus">Hiatus</option>
        </select>
        <div className="filter-divider" />
        <span className="filter-label">Sort:</span>
        <select className="filter-select" value={order} onChange={e => { setOrder(e.target.value); setPage(1); }}>
          {ORDERS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      </div>

      {error && <div className="err-banner">⚠️ {error}</div>}
      {loading ? <SkeletonGrid count={24} /> : results.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📭</div>
          <div className="empty-txt">No results found</div>
          <div className="empty-sub">Try different filters or search terms</div>
        </div>
      ) : (
        <>
          <div className="results-info">
            Showing <strong>{((page-1)*PER)+1}–{Math.min(page*PER, total)}</strong> of <strong>{total.toLocaleString()}</strong>
            {searchQ && <> for "<strong>{searchQ}</strong>"</>}
          </div>
          <div className="mgrid large">{results.map(m => <MangaCard key={m.id} m={m} onClick={onMangaClick} />)}</div>
          {totalPages > 1 && (
            <div className="pagination">
              <button className="pg-btn" disabled={page<=1} onClick={()=>setPage(1)}>«</button>
              <button className="pg-btn" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>‹</button>
              {getPgs().map(pg => <button key={pg} className={`pg-btn ${page===pg?"on":""}`} onClick={()=>setPage(pg)}>{pg}</button>)}
              <button className="pg-btn" disabled={page>=totalPages} onClick={()=>setPage(p=>p+1)}>›</button>
              <button className="pg-btn" disabled={page>=totalPages} onClick={()=>setPage(totalPages)}>»</button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ============================================================
// INFO PAGE
// ============================================================
const InfoPage = ({ mangaId, onBack, onRead }) => {
  const [info, setInfo] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [chapLoading, setChapLoading] = useState(true);
  const [descExp, setDescExp] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [chapSearch, setChapSearch] = useState("");
  const [chapOrder, setChapOrder] = useState("desc");

  const isComickNative = typeof mangaId === "string" && mangaId.startsWith("comick:");
  const comickSlug = isComickNative ? mangaId.slice("comick:".length) : null;

  useEffect(() => {
    setLoading(true); setChapLoading(true); setChapters([]); setInfo(null);

    if (isComickNative) {
      // --- Manga khud ComicK se click hua tha (MangaDex par nahi mila) ---
      API.comickDetails(comickSlug)
        .then(data => {
          const country = data?.country;
          const type = country === "jp" ? "manga" : country === "cn" ? "manhua" : "manhwa";
          setInfo({
            id: mangaId, source: "comick", slug: comickSlug,
            title: data?.title || "Unknown", cover: data?.thumbnail || "", cover512: data?.thumbnail || "",
            type, status: data?.status === 2 ? "completed" : data?.status === 4 ? "hiatus" : "ongoing",
            rating: null, lastChapter: null, year: null,
            description: data?.desc || "",
            tags: (data?.genres || []).map(g => g.genres?.name).filter(Boolean),
            altTitles: (data?.titles || []).map(t => t.title).filter(Boolean),
          });
        })
        .catch(console.error)
        .finally(() => setLoading(false));

      API.comickChapters(comickSlug)
        .then(res => {
          const seen = new Map();
          (res?.data || []).forEach(cc => {
            const n = cc.chap;
            if (!n) return;
            if (!seen.has(n)) {
              seen.set(n, {
                id: cc.hid, source: "comick", slug: comickSlug,
                attributes: { chapter: n, title: cc.title || "", pages: null },
              });
            }
          });
          const deduped = Array.from(seen.values());
          deduped.sort((a, b) => parseFloat(b.attributes?.chapter||0) - parseFloat(a.attributes?.chapter||0));
          setChapters(deduped);
        })
        .catch(console.error)
        .finally(() => setChapLoading(false));
      return;
    }

    // --- Manga MangaDex se click hua tha ---
    API.manga(mangaId)
      .then(res => { if (res?.data) setInfo(normalizeForCard(res.data)); })
      .catch(console.error)
      .finally(() => setLoading(false));

    API.chapters(mangaId)
      .then(async res => {
        const seen = new Map();
        (res?.data || []).forEach(c => {
          const n = c.attributes?.chapter;
          if (!n) return;
          const isExternal = !!c.attributes?.externalUrl;
          const existing = seen.get(n);
          if (!existing || (!isExternal && existing.attributes?.externalUrl)) {
            seen.set(n, { ...c, source: "mangadex" });
          }
        });

        // Jo chapters MangaDex par sirf external hain (licensed series), unke liye
        // ComicK try karo - title match karke, taaki wahi chapter dusre manga ka na aa jaye.
        const stillExternal = Array.from(seen.values()).filter(c => c.attributes?.externalUrl);
        if (stillExternal.length > 0) {
          try {
            const mangaRes = await API.manga(mangaId);
            const titleMap = mangaRes?.data?.attributes?.title || {};
            const title = titleMap.en || Object.values(titleMap)[0];
            if (title) {
              const searchRes = await API.comickSearch(title);
              // Exact normalized-title match dhoondo - taaki similar-naam wale
              // kisi doosre manga/manhwa ka chapter galti se mix na ho.
              const match = (searchRes?.data || []).find(r => normTitle(r.title) === normTitle(title));
              if (match?.slug) {
                const comickRes = await API.comickChapters(match.slug);
                (comickRes?.data || []).forEach(cc => {
                  const n = cc.chap;
                  if (!n) return;
                  const existing = seen.get(n);
                  if (existing?.attributes?.externalUrl) {
                    seen.set(n, {
                      id: cc.hid, source: "comick", slug: match.slug,
                      attributes: { chapter: n, title: cc.title || "", pages: null },
                    });
                  }
                });
              }
            }
          } catch (e) {
            console.error("ComicK fallback failed (external-link chapters will show as-is):", e);
          }
        }

        const deduped = Array.from(seen.values());
        deduped.sort((a, b) => parseFloat(b.attributes?.chapter||0) - parseFloat(a.attributes?.chapter||0));
        setChapters(deduped);
      })
      .catch(console.error)
      .finally(() => setChapLoading(false));
  }, [mangaId]);

  const filtered = chapters.filter(c => {
    if (!chapSearch) return true;
    return (c.attributes?.chapter||"").includes(chapSearch) || (c.attributes?.title||"").toLowerCase().includes(chapSearch.toLowerCase());
  });
  const ordered = chapOrder === "asc" ? [...filtered].reverse() : filtered;
  const displayed = showAll ? ordered : ordered.slice(0, 80);

  if (loading) return <div style={{paddingTop:80}}><Loader text="Loading series..." /></div>;
  if (!info) return <div className="info-pg"><button className="back" onClick={onBack}>← Back</button><div className="empty"><div className="empty-icon">😔</div><div className="empty-txt">Series not found</div></div></div>;

  const icType = { manhwa:"ic-manhwa", manga:"ic-manga", manhua:"ic-manhua" };
  const icStatus = { ongoing:"ic-ongoing", completed:"ic-completed", hiatus:"ic-hiatus" };

  return (
    <div className="info-pg">
      <button className="back" onClick={onBack}>← Back</button>
      <div className="info-hero">
        <img className="info-cover" src={info.cover512||info.cover} alt={info.title}
          onError={e=>{e.target.onerror=null;e.target.src=`https://placehold.co/200x300/111120/a855f7?text=${encodeURIComponent(info.title?.slice(0,10)||"?")}`}} />
        <div className="info-body">
          <h1 className="info-title">{info.title}</h1>
          {info.altTitles?.length>0 && <div style={{fontSize:12,color:"var(--t3)",marginBottom:10}}>{info.altTitles.slice(0,2).join(" / ")}</div>}
          <div className="info-chips">
            <span className={`ichip ${icType[info.type]||"ic-manhwa"}`}>{info.type}</span>
            <span className={`ichip ${icStatus[info.status]||"ic-ongoing"}`}>{info.status}</span>
            {info.rating && <span style={{fontSize:13,color:"#f59e0b",fontWeight:600}}>★ {info.rating}</span>}
          </div>
          {info.tags?.length>0 && <div className="genres-wrap">{info.tags.slice(0,10).map(g=><span key={g} className="gtag">{g}</span>)}</div>}
          {info.description && <>
            <div className={`info-desc ${descExp?"expanded":""}`}>{info.description}</div>
            <button className="desc-toggle" onClick={()=>setDescExp(p=>!p)}>{descExp?"Show less ↑":"Read more ↓"}</button>
          </>}
          <div className="info-stats">
            <div><div className="istat-lbl">Chapters</div><div className="istat-val">{chapLoading?"...":chapters.length}</div></div>
            {info.year && <div><div className="istat-lbl">Year</div><div className="istat-val">{info.year}</div></div>}
            <div><div className="istat-lbl">Type</div><div className="istat-val" style={{textTransform:"capitalize"}}>{info.type}</div></div>
            <div><div className="istat-lbl">Status</div><div className="istat-val" style={{textTransform:"capitalize",color:info.status==="ongoing"?"var(--gn)":info.status==="completed"?"var(--t3)":"var(--yw)"}}>{info.status}</div></div>
          </div>
          <div className="info-btns">
            {chapLoading ? <button className="read-btn" disabled style={{opacity:.6}}>Loading chapters...</button>
            : ordered.length>0 ? <>
                <button className="read-btn" onClick={()=>onRead(info,ordered[ordered.length-1],ordered)}>▶ First Chapter</button>
                <button className="read-btn-alt" onClick={()=>onRead(info,ordered[0],ordered)}>⚡ Latest</button>
              </>
            : <button className="read-btn" disabled style={{opacity:.5,cursor:"not-allowed"}}>No English Chapters</button>}
          </div>
        </div>
      </div>

      <div className="chaps-hd">
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span className="chaps-title">Chapters</span>
          <span className="chaps-cnt">{chapLoading?"Loading...":`${chapters.length} total`}</span>
          {!chapLoading && chapters.length>0 && (
            <button className="rbtn" onClick={()=>setChapOrder(o=>o==="desc"?"asc":"desc")}>
              {chapOrder==="desc"?"↓ Newest":"↑ Oldest"}
            </button>
          )}
        </div>
        <input className="chap-search" placeholder="Search chapter..." value={chapSearch} onChange={e=>setChapSearch(e.target.value)} />
      </div>
      {chapLoading ? <div className="loader" style={{padding:"30px"}}><div className="lring"/><div className="ltxt">Loading chapters...</div></div>
      : ordered.length===0 ? <div className="no-chaps">{chapSearch?`No chapters matching "${chapSearch}"`:"No English chapters available."}</div>
      : <>
          <div className="chaps-list">
            {displayed.map(ch=>{
              const num=ch.attributes?.chapter||"?";
              const title=ch.attributes?.title||"";
              const pages=ch.attributes?.pages||0;
              return <div key={ch.id} className="chap-item" onClick={()=>onRead(info,ch,ordered)}>
                <span className="chap-num">Ch. {num}</span>
                {title&&<span className="chap-title-txt">{title}</span>}
                {pages>0&&<span className="chap-pg">{pages}p</span>}
              </div>;
            })}
          </div>
          {!showAll&&ordered.length>80&&<button className="load-more" onClick={()=>setShowAll(true)}>Show all {ordered.length} chapters ↓</button>}
        </>}
    </div>
  );
};

// ============================================================
// READER
// ============================================================
const ReaderPage = ({ manga, chapter, chapters, onBack, onChapterChange }) => {
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState("scroll");
  const [curPage, setCurPage] = useState(0);
  const [failedPages, setFailedPages] = useState({});
  const topRef = useRef();

  useEffect(() => {
    if (!chapter?.id) return;
    setLoading(true); setError(null); setPages([]); setCurPage(0); setFailedPages({});

    if (chapter.source === "comick") {
      const chapterUrl = `/comic/${chapter.slug}/${chapter.id}-chapter-${chapter.attributes.chapter}-en`;
      API.comickPages(chapterUrl)
        .then(data => {
          if (!data?.images?.length) throw new Error("No pages");
          setPages(data.images.map(url => ({ hq: url, lq: null })));
          topRef.current?.scrollIntoView?.();
        })
        .catch(e => setError(e.message))
        .finally(() => setLoading(false));
      return;
    }

    if (chapter.attributes?.externalUrl) {
      // MangaDex par bhi nahi hai aur ComicK me match/chapter nahi mila
      setLoading(false); setError("external");
      return;
    }

    API.chapterPages(chapter.id)
      .then(data => {
        if (!data?.chapter) throw new Error("No data");
        const { baseUrl, chapter: { hash, data: hi, dataSaver: lo } } = data;
        setPages(hi.map((p, i) => ({ hq: `${baseUrl}/data/${hash}/${p}`, lq: lo?.[i] ? `${baseUrl}/data-saver/${hash}/${lo[i]}` : null })));
        topRef.current?.scrollIntoView?.();
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [chapter?.id]);

  const idx = chapters.findIndex(c => c.id === chapter.id);
  const hasPrev = idx < chapters.length - 1;
  const hasNext = idx > 0;

  const handleErr = (i, e) => {
    const pg = pages[i];
    if (pg?.lq && !failedPages[`${i}_lq`]) { e.target.src = pg.lq; setFailedPages(f=>({...f,[`${i}_lq`]:true})); }
    else setFailedPages(f=>({...f,[i]:true}));
  };

  const prevChap = () => { if (hasPrev) onChapterChange(chapters[idx+1]); };
  const nextChap = () => { if (hasNext) onChapterChange(chapters[idx-1]); };

  return (
    <div className="reader" ref={topRef}>
      <div className="reader-nav">
        <button className="rbtn" onClick={onBack}>← Back</button>
        <div className="reader-info"><strong>{manga?.title}</strong> · Ch.{chapter?.attributes?.chapter||"?"}{chapter?.attributes?.title?` — ${chapter.attributes.title}`:""}</div>
        <div className="rcontrols">
          <select className="chap-select" value={chapter.id} onChange={e=>{const c=chapters.find(x=>x.id===e.target.value);if(c)onChapterChange(c);}}>
            {chapters.map(c=><option key={c.id} value={c.id}>Ch. {c.attributes?.chapter||"?"}</option>)}
          </select>
          <button className={`rbtn ${mode==="scroll"?"on":""}`} onClick={()=>setMode("scroll")}>≡ Scroll</button>
          <button className={`rbtn ${mode==="single"?"on":""}`} onClick={()=>setMode("single")}>□ Single</button>
          <button className="rbtn" disabled={!hasPrev} onClick={prevChap}>‹ Prev</button>
          <button className="rbtn" disabled={!hasNext} onClick={nextChap}>Next ›</button>
        </div>
      </div>

      {loading ? <div className="reader-loading"><div className="lring" style={{width:48,height:48}}/><div className="ltxt">Loading Chapter {chapter?.attributes?.chapter||""}...</div></div>
      : error === "external" ? <div className="reader-err"><div style={{fontSize:52}}>🔗</div><h3>Ye chapter sirf official site pe hai</h3><p>Na MangaDex, na ComicK par hosted mila.</p><a className="rbtn" href={chapter.attributes.externalUrl} target="_blank" rel="noreferrer" style={{display:"inline-block",marginTop:8}}>Wahan padho ↗</a></div>
      : error ? <div className="reader-err"><div style={{fontSize:52}}>😔</div><h3>Could not load pages</h3><p>This chapter may be unavailable. Try another chapter.</p><div style={{display:"flex",gap:10,marginTop:8}}><button className="rbtn" disabled={!hasPrev} onClick={prevChap}>‹ Previous</button><button className="rbtn" disabled={!hasNext} onClick={nextChap}>Next ›</button></div></div>
      : mode==="scroll" ? (
        <div className="scroll-imgs">
          {pages.map((pg,i)=>failedPages[i]?<div key={i} className="page-err">Page {i+1} unavailable</div>:<img key={i} className="scroll-img" src={pg.hq} alt={`Page ${i+1}`} loading={i<3?"eager":"lazy"} onError={e=>handleErr(i,e)}/>)}
          <div style={{display:"flex",gap:12,marginTop:32,padding:"0 16px"}}>
            <button className="rbtn" disabled={!hasPrev} onClick={prevChap} style={{padding:"12px 24px",fontSize:14}}>‹ Previous Chapter</button>
            <button className="rbtn" disabled={!hasNext} onClick={nextChap} style={{padding:"12px 24px",fontSize:14}}>Next Chapter ›</button>
          </div>
        </div>
      ) : (
        <>
          <div className="single-wrap">
            {pages[curPage]&&!failedPages[curPage]?<img className="single-img" src={pages[curPage].hq} alt={`Page ${curPage+1}`} onError={e=>handleErr(curPage,e)}/>:<div className="page-err">Page {curPage+1} unavailable</div>}
          </div>
          <div className="page-bar">
            <button className="pg-nav-btn" disabled={curPage===0} onClick={()=>setCurPage(p=>p-1)}>← Prev</button>
            <span className="pg-label">{curPage+1} / {pages.length}</span>
            <button className="pg-nav-btn" disabled={curPage>=pages.length-1} onClick={()=>setCurPage(p=>p+1)}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================
// NAV WITH AUTOCOMPLETE
// ============================================================
const NavBar = ({ pg, goHome, goBrowse, onSearch }) => {
  const [acItems, setAcItems] = useState([]);
  const [acOpen, setAcOpen] = useState(false);
  const inputRef = useRef();
  const timer = useRef();

  const handleInput = e => {
    const q = e.target.value.trim();
    clearTimeout(timer.current);
    if (q.length < 2) { setAcOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await API.autocomplete(q);
        setAcItems((res.data||[]).map(normalizeForCard));
        setAcOpen(true);
      } catch {}
    }, 400);
  };

  const pick = m => {
    setAcOpen(false);
    if (inputRef.current) inputRef.current.value = "";
    onSearch(m, true);
  };

  return (
    <nav className="nav">
      <div className="logo" onClick={goHome}>KURO<span style={{background:"linear-gradient(135deg,#ec4899,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>MANGA</span></div>
      <div className="nav-links">
        <button className={`nl ${pg==="home"?"on":""}`} onClick={goHome}>Home</button>
        <button className={`nl ${pg==="browse"?"on":""}`} onClick={goBrowse}>Browse</button>
      </div>
      <div className="nav-search-wrap">
        <input ref={inputRef} className="nav-search-input" placeholder="Search manga, manhwa, manhua..."
          onChange={handleInput}
          onKeyDown={e=>{if(e.key==="Enter"){setAcOpen(false);onSearch(e.target.value,false);}if(e.key==="Escape")setAcOpen(false);}}
          onBlur={()=>setTimeout(()=>setAcOpen(false),200)}/>
        <button className="nav-search-btn" onClick={()=>onSearch(inputRef.current?.value,false)}>⌕</button>
        {acOpen&&acItems.length>0&&(
          <div className="autocomplete">
            {acItems.map(m=>(
              <div key={m.id} className="ac-item" onClick={()=>pick(m)}>
                <img className="ac-img" src={m.cover} alt={m.title} onError={e=>{e.target.onerror=null;e.target.src="https://placehold.co/36x50/111120/a855f7?text=?";}}/>
                <div className="ac-info">
                  <div className="ac-title">{m.title}</div>
                  <div className="ac-meta">{m.type} · {m.status}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
};

// ============================================================
// ROOT APP
// ============================================================
export default function KuroManga() {
  const [pg, setPg] = useState("home");
  const [openId, setOpenId] = useState(null);
  const [selManga, setSelManga] = useState(null);
  const [selChap, setSelChap] = useState(null);
  const [allChaps, setAllChaps] = useState([]);
  const [browseQ, setBrowseQ] = useState("");

  const goManga = m => { setOpenId(m.id); setSelManga(m); setPg("info"); };
  const goRead = (manga, ch, chaps) => { setSelManga(manga); setSelChap(ch); if(chaps) setAllChaps(chaps); setPg("reader"); };
  const goHome = () => setPg("home");
  const goBrowse = () => { setBrowseQ(""); setPg("browse"); };

  const handleSearch = (qOrManga, isDirect = false) => {
    if (isDirect && typeof qOrManga === "object") { goManga(qOrManga); return; }
    const q = typeof qOrManga === "string" ? qOrManga.trim() : "";
    if (!q) return;
    setBrowseQ(q); setPg("browse");
  };

  return (
    <>
      <style>{CSS}</style>
      {pg !== "reader" && <NavBar pg={pg} goHome={goHome} goBrowse={goBrowse} onSearch={handleSearch} />}
      {pg === "home" && <HomePage onMangaClick={goManga} onSearch={handleSearch} onBrowse={goBrowse} />}
      {pg === "browse" && <BrowsePage key={browseQ} initialQ={browseQ} onMangaClick={goManga} />}
      {pg === "info" && openId && <InfoPage key={openId} mangaId={openId} onBack={goHome} onRead={goRead} />}
      {pg === "reader" && selManga && selChap && (
        <ReaderPage manga={selManga} chapter={selChap} chapters={allChaps}
          onBack={()=>setPg("info")} onChapterChange={ch=>setSelChap(ch)} />
      )}
    </>
  );
}
