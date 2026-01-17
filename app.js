/* Kur'ân Okuma • Elmalılı (Açık Kuran API) • PWA + Offline + Ses */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const escapeHtml = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const debounce = (fn, ms = 180) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  function setStatus(msg = "", isError = false) {
    const el = $("#status");
    el.textContent = msg;
    el.style.color = isError ? "var(--danger)" : "var(--muted)";
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function renderChunked(items, renderItem, container, chunkSize = 40) {
    container.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < items.length; i++) {
      frag.appendChild(renderItem(items[i], i));
      if ((i + 1) % chunkSize === 0) {
        container.appendChild(frag);
        await new Promise(requestAnimationFrame);
      }
    }
    container.appendChild(frag);
  }

  function highlight(text, query) {
    if (!query) return escapeHtml(text);
    const safe = escapeHtml(text);
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(q, "gi");
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  }

  // ---------- Settings ----------
  const Settings = (() => {
    const KEY = "quran_settings_v7";
    const defaults = {
      fontSize: 20,
      lineHeight: 1.9,
      showPageNums: true,
      showArabic: true,
      showTranslation: true,
      inlineMode: false,
      tajweed: false,
      autoResume: true,

      audioMode: "ayah",
      reciter: "Alafasy_128kbps",
      volume: 0.9,
      speed: 1,
      repeat: 1,
      follow: true,

      favReciters: [],

      fallbackReciter: "Alafasy_128kbps",
      fallback1: "Alafasy_128kbps",
      fallback2: "",
      fallback3: "",
      includeFavFallback: true,
      includeDefaultFallback: true,

      audioCacheReciter: "__current__" // "__current__" or reciter id
    };

    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
      } catch {
        return { ...defaults };
      }
    }

    function save(s) {
      localStorage.setItem(KEY, JSON.stringify(s));
    }

    function apply(s) {
      document.documentElement.style.setProperty("--fs", `${s.fontSize}px`);
      document.documentElement.style.setProperty("--lh", `${s.lineHeight}`);
    }

    return { load, save, apply, defaults };
  })();

  // ---------- IndexedDB ----------
  const DB = (() => {
    const DB_NAME = "quran_app_v7";
    const DB_VER = 7;
    let dbPromise;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("bookmarks")) db.createObjectStore("bookmarks", { keyPath: "id" });
          if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
          if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache", { keyPath: "key" });
          if (!db.objectStoreNames.contains("tajweed")) db.createObjectStore("tajweed", { keyPath: "key" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }

    async function tx(storeName, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        let out;
        try {
          out = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
      });
    }

    const get = (store, key) =>
      tx(store, "readonly", (s) =>
        new Promise((res, rej) => {
          const r = s.get(key);
          r.onsuccess = () => res(r.result || null);
          r.onerror = () => rej(r.error);
        })
      );

    const put = (store, val) =>
      tx(store, "readwrite", (s) =>
        new Promise((res, rej) => {
          const r = s.put(val);
          r.onsuccess = () => res(true);
          r.onerror = () => rej(r.error);
        })
      );

    const del = (store, key) =>
      tx(store, "readwrite", (s) =>
        new Promise((res, rej) => {
          const r = s.delete(key);
          r.onsuccess = () => res(true);
          r.onerror = () => rej(r.error);
        })
      );

    const list = (store) =>
      tx(store, "readonly", (s) =>
        new Promise((res, rej) => {
          const r = s.getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => rej(r.error);
        })
      );

    const clear = (store) =>
      tx(store, "readwrite", (s) =>
        new Promise((res, rej) => {
          const r = s.clear();
          r.onsuccess = () => res(true);
          r.onerror = () => rej(r.error);
        })
      );

    return { get, put, del, list, clear };
  })();

  // ---------- API ----------
  const API = (() => {
    const BASE = "https://api.acikkuran.com";
    async function getJson(path) {
      const url = `${BASE}${path}`;
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`API hata: ${res.status} (${path})`);
      return res.json();
    }
    return {
      authors: () => getJson("/authors"),
      surahs: () => getJson("/surahs"),
      surah: (id, authorId) => getJson(`/surah/${id}?author=${encodeURIComponent(authorId)}`),
      page: (pageNum, authorId) => getJson(`/page/${pageNum}?author_id=${encodeURIComponent(authorId)}`)
    };
  })();

  // ---------- Audio sources ----------
  const EveryAyah = {
    base: "https://everyayah.com/data",
    ayahUrl(reciter, surahId, ayahNum) {
      const s = String(surahId).padStart(3, "0");
      const a = String(ayahNum).padStart(3, "0");
      return `${this.base}/${reciter}/${s}${a}.mp3`;
    }
  };

  const AUDIO_CACHE = "quran-audio-v1";

  // ---------- Reciters ----------
  const RECITERS = [
    { id: "Alafasy_128kbps", name: "Mishary Alafasy", quality: "128kbps" },
    { id: "Alafasy_64kbps", name: "Mishary Alafasy", quality: "64kbps" },
    { id: "Husary_Muallim_128kbps", name: "Mahmoud Khalil Al-Husary", quality: "Muallim 128kbps" },
    { id: "Husary_128kbps", name: "Mahmoud Khalil Al-Husary", quality: "128kbps" },
    { id: "Husary_64kbps", name: "Mahmoud Khalil Al-Husary", quality: "64kbps" },
    { id: "Husary_Mujawwad_128kbps", name: "Husary", quality: "Mujawwad 128kbps" },
    { id: "Husary_Mujawwad_64kbps", name: "Husary", quality: "Mujawwad 64kbps" },
    { id: "Abdul_Basit_Murattal_192kbps", name: "Abdul Basit", quality: "Murattal 192kbps" },
    { id: "Abdul_Basit_Murattal_64kbps", name: "Abdul Basit", quality: "Murattal 64kbps" },
    { id: "Abdul_Basit_Mujawwad_128kbps", name: "Abdul Basit", quality: "Mujawwad 128kbps" },
    { id: "AbdulSamad_64kbps_QuranExplorer.Com", name: "AbdulSamad", quality: "QuranExplorer 64kbps" },
    { id: "Minshawy_Murattal_128kbps", name: "Al-Minshawi", quality: "Murattal 128kbps" },
    { id: "Minshawy_Mujawwad_192kbps", name: "Al-Minshawi", quality: "Mujawwad 192kbps" },
    { id: "Abdurrahmaan_As-Sudais_192kbps", name: "As-Sudais", quality: "192kbps" },
    { id: "Abdurrahmaan_As-Sudais_64kbps", name: "As-Sudais", quality: "64kbps" },
    { id: "Saood_ash-Shuraym_128kbps", name: "Ash-Shuraym", quality: "128kbps" },
    { id: "Saood_ash-Shuraym_64kbps", name: "Ash-Shuraym", quality: "64kbps" },
    { id: "Hudhaify_128kbps", name: "Al-Hudhaify", quality: "128kbps" },
    { id: "Hudhaify_64kbps", name: "Al-Hudhaify", quality: "64kbps" },
    { id: "MaherAlMuaiqly128kbps", name: "Maher Al-Muaiqly", quality: "128kbps" },
    { id: "Maher_AlMuaiqly_64kbps", name: "Maher Al-Muaiqly", quality: "64kbps" },
    { id: "Abu_Bakr_Ash-Shaatree_128kbps", name: "Abu Bakr Ash-Shaatree", quality: "128kbps" },
    { id: "Abu_Bakr_Ash-Shaatree_64kbps", name: "Abu Bakr Ash-Shaatree", quality: "64kbps" },
    { id: "Muhammad_Ayyoub_128kbps", name: "Muhammad Ayyoub", quality: "128kbps" },
    { id: "Muhammad_Ayyoub_64kbps", name: "Muhammad Ayyoub", quality: "64kbps" },
    { id: "Hani_Rifai_192kbps", name: "Hani Rifai", quality: "192kbps" },
    { id: "Hani_Rifai_64kbps", name: "Hani Rifai", quality: "64kbps" },
    { id: "Ghamadi_40kbps", name: "Saad Al-Ghamdi", quality: "40kbps" },
    { id: "Salaah_AbdulRahman_Bukhatir_128kbps", name: "Salah Bukhatir", quality: "128kbps" },
    { id: "Khaalid_Abdullaah_al-Qahtaanee_192kbps", name: "Khalid Al-Qahtani", quality: "192kbps" },
    { id: "Salah_Al_Budair_128kbps", name: "Salah Al-Budair", quality: "128kbps" },
    { id: "Abdullaah_3awwaad_Al-Juhaynee_128kbps", name: "A. A. Al-Juhaynee", quality: "128kbps" }
  ];

  const reciterLabel = (r) => `${r.name} • ${r.quality}`;

  // ---------- State ----------
  const state = {
    view: "ayah",
    surahId: 1,
    page: 1,
    query: "",
    settings: Settings.load(),
    authors: [],
    surahs: [],
    authorId: null,

    currentItems: [],

    playingId: null,
    playingIndex: -1,
    isPlaying: false,

    tajweedReady: false,
    tajweedMap: new Map(),
    tajweedWarned: false,

    _repeatLeft: null,
    _skipByAyah: new Map(),

    deferredInstallPrompt: null,
    audioAbort: null
  };

  const STORAGE = {
    AUTHOR_KEY: "quran_author_id",
    VIEW_KEY: "quran_view",
    SURAH_KEY: "quran_surah_id",
    PAGE_KEY: "quran_page",
    LAST_KEY: "quran_last_read_v3"
  };

  function saveLastRead(partial) {
    if (!state.settings.autoResume) return;
    try {
      const prev = JSON.parse(localStorage.getItem(STORAGE.LAST_KEY) || "{}") || {};
      const next = { ...prev, ...partial, t: Date.now() };
      localStorage.setItem(STORAGE.LAST_KEY, JSON.stringify(next));
    } catch {}
  }
  function loadLastRead() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE.LAST_KEY) || "null");
    } catch {
      return null;
    }
  }

  // ---------- boot meta ----------
  async function loadMeta() {
    const cachedAuthors = await DB.get("meta", "authors");
    const cachedSurahs = await DB.get("meta", "surahs");

    try {
      const [a, s] = await Promise.all([API.authors(), API.surahs()]);
      state.authors = a.data || [];
      state.surahs = s.data || [];
      await DB.put("meta", { key: "authors", data: state.authors, fetchedAt: Date.now() });
      await DB.put("meta", { key: "surahs", data: state.surahs, fetchedAt: Date.now() });
      setStatus("Hazır ✅ (meta güncellendi)");
    } catch {
      if (cachedAuthors?.data && cachedSurahs?.data) {
        state.authors = cachedAuthors.data;
        state.surahs = cachedSurahs.data;
        setStatus("Offline mod: meta önbellekten yüklendi.");
      } else {
        throw new Error("Meta verileri alınamadı. İnternete bağlanıp bir kez açın.");
      }
    }

    const savedAuthor = Number(localStorage.getItem(STORAGE.AUTHOR_KEY) || 0) || null;
    const elmalili = state.authors.find((x) => (x.name || "").toLowerCase().includes("elmal") && (x.language || "").toLowerCase() === "tr");
    state.authorId = savedAuthor || elmalili?.id || state.authors.find((x) => (x.language || "").toLowerCase() === "tr")?.id || state.authors[0]?.id || 0;

    state.view = localStorage.getItem(STORAGE.VIEW_KEY) || state.view;
    state.surahId = Number(localStorage.getItem(STORAGE.SURAH_KEY) || state.surahId);
    state.page = Number(localStorage.getItem(STORAGE.PAGE_KEY) || state.page);
  }

  // ---------- cache keys ----------
  const keySurah = (sid, aid) => `surah:${sid}:author:${aid}`;
  const keyPage = (p, aid) => `page:${p}:author:${aid}`;

  async function getSurahCached(sid, authorId) {
    const key = keySurah(sid, authorId);
    const cached = await DB.get("cache", key);
    if (cached?.data) return { data: cached.data, fromCache: true };
    const fresh = await API.surah(sid, authorId);
    await DB.put("cache", { key, data: fresh.data, fetchedAt: Date.now() });
    return { data: fresh.data, fromCache: false };
  }

  async function getPageCached(pageNum, authorId) {
    const key = keyPage(pageNum, authorId);
    const cached = await DB.get("cache", key);
    if (cached?.data) return { data: cached.data, fromCache: true };
    const fresh = await API.page(pageNum, authorId);
    await DB.put("cache", { key, data: fresh.data, fetchedAt: Date.now() });
    return { data: fresh.data, fromCache: false };
  }

  // ---------- Tajweed (optional) ----------
  async function tryLoadTajweed() {
    if (!state.settings.tajweed) return;
    if (state.tajweedReady) return;

    const cached = await DB.get("tajweed", "map_v1");
    if (cached?.data && Array.isArray(cached.data)) {
      state.tajweedMap = new Map(cached.data);
      state.tajweedReady = true;
      return;
    }

    try {
      const annRes = await fetch("./data/tajweed.hafs.uthmani-pause-sajdah.json", { cache: "no-cache" });
      if (!annRes.ok) throw new Error("Tecvid dosyası bulunamadı.");
      const annotations = await annRes.json();

      state.tajweedMap = new Map();
      for (const item of annotations || []) {
        if (!item?.surah || !item?.ayah) continue;
        state.tajweedMap.set(`${item.surah}:${item.ayah}`, item.annotations || []);
      }
      await DB.put("tajweed", { key: "map_v1", data: Array.from(state.tajweedMap.entries()), builtAt: Date.now() });
      state.tajweedReady = true;
      setStatus("Tecvid: hazır ✅");
    } catch {
      if (!state.tajweedWarned) {
        setStatus("Tecvid: veri yok (isteğe bağlı).", false);
        state.tajweedWarned = true;
      }
    }
  }

  function ruleToClass(rule) {
    const r = String(rule || "");
    if (r.startsWith("madd")) return "tj-madd";
    if (r.startsWith("ghunnah")) return "tj-ghunnah";
    if (r.startsWith("ikhfa")) return "tj-ikhfa";
    if (r.startsWith("iqlab")) return "tj-iqlab";
    if (r.startsWith("qalqalah")) return "tj-qalqalah";
    if (r.startsWith("idghaam")) return "tj-idghaam";
    return "tj-wasl";
  }

  function applyTajweedHtml(arText, sid, ay) {
    if (!state.settings.tajweed || !state.tajweedReady) return escapeHtml(arText);
    const anns = state.tajweedMap.get(`${sid}:${ay}`);
    if (!anns?.length) return escapeHtml(arText);

    const chars = Array.from(arText);
    const L = chars.length;
    const sorted = anns
      .map((a) => ({ rule: a.rule, start: Math.max(0, Math.min(L, a.start)), end: Math.max(0, Math.min(L, a.end)) }))
      .filter((a) => a.end > a.start)
      .sort((x, y) => x.start - y.start);

    const out = [];
    let i = 0;
    for (const a of sorted) {
      if (a.start > i) out.push({ text: chars.slice(i, a.start).join(""), cls: null });
      out.push({ text: chars.slice(a.start, a.end).join(""), cls: ruleToClass(a.rule) });
      i = Math.max(i, a.end);
    }
    if (i < L) out.push({ text: chars.slice(i).join(""), cls: null });

    return out.map((seg) => (seg.cls ? `<span class="${seg.cls}">${escapeHtml(seg.text)}</span>` : escapeHtml(seg.text))).join("");
  }

  // ---------- Install UI ----------
  function setupInstallUI() {
    const btn = $("#btnInstall");
    if (!btn) return;

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      btn.style.display = "";
      setStatus("Kurulum hazır: 📲 ile yükleyebilirsiniz.");
    });

    btn.addEventListener("click", async () => {
      const promptEvent = state.deferredInstallPrompt;
      if (!promptEvent) {
        setStatus("Kurulum şu an uygun değil (HTTPS/uyumluluk).", false);
        return;
      }
      promptEvent.prompt();
      try {
        await promptEvent.userChoice;
      } catch {}
      state.deferredInstallPrompt = null;
      btn.style.display = "none";
    });

    window.addEventListener("appinstalled", () => {
      btn.style.display = "none";
      setStatus("Uygulama yüklendi ✅");
    });
  }

  // ---------- Audio offline ----------
  function setAudioProgress(pct, text) {
    const bar = $("#audioProgressBar");
    const t = $("#audioProgressText");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (t) t.textContent = text || "";
  }

  function kbpsFromReciterId(id) {
    const m = String(id).match(/(\d+)\s*kbps/i);
    return m ? Number(m[1]) : 64;
  }

  function estimateMB(count, reciterId) {
    // Best-effort estimate: average 5s per ayah
    const avgSecondsPerAyah = 5;
    const kbps = kbpsFromReciterId(reciterId);
    const bytes = (kbps * 1000 / 8) * avgSecondsPerAyah * count;
    return bytes / (1024 * 1024);
  }

  async function updateAudioCacheStats() {
    const el = $("#audioCacheStats");
    if (!el) return;

    try {
      const cache = await caches.open(AUDIO_CACHE);
      const keys = await cache.keys();
      const total = keys.length;

      // group by reciter based on URL path
      const groups = new Map();
      for (const req of keys) {
        const u = new URL(req.url);
        const m = u.pathname.match(/\/data\/([^/]+)\//);
        const rec = m ? m[1] : "?";
        groups.set(rec, (groups.get(rec) || 0) + 1);
      }

      const parts = [];
      parts.push(`Önbellekte ${total} ses dosyası var.`);
      // show up to 4 groups
      const entries = Array.from(groups.entries()).sort((a,b)=>b[1]-a[1]);
      const shown = entries.slice(0,4).map(([rec,cnt])=>{
        const est = estimateMB(cnt, rec);
        return `${rec}: ${cnt} dosya (~${est.toFixed(1)} MB tahmini)`;
      });
      if (shown.length) parts.push(shown.join(' | '));
      if (entries.length > 4) parts.push(`(+${entries.length-4} kâri daha…)`);
      el.textContent = parts.join('\n');
    } catch {
      el.textContent = "Ses önbelleği bilgisi okunamadı.";
    }
  }

  async function clearAudioCache() {
    await caches.delete(AUDIO_CACHE);
    setAudioProgress(0, "Ses önbelleği temizlendi.");
    await updateAudioCacheStats();
  }

  async function cacheCurrentSurahAudio() {
    const btnCancel = $("#btnCancelAudioDownload");
    btnCancel.style.display = "";

    // determine selected reciter
    const sel = $("#audioCacheReciter");
    const reciterChoice = sel?.value || "__current__";
    const reciter = reciterChoice === "__current__" ? state.settings.reciter : reciterChoice;

    state.settings.audioCacheReciter = reciterChoice;
    Settings.save(state.settings);

    const sid = state.surahId;
    const { data } = await getSurahCached(sid, state.authorId);
    const verses = Array.isArray(data?.verses) ? data.verses : [];
    if (!verses.length) {
      setAudioProgress(0, "Sure ayetleri bulunamadı.");
      btnCancel.style.display = "none";
      return;
    }

    const cache = await caches.open(AUDIO_CACHE);
    const controller = new AbortController();
    state.audioAbort = controller;

    let done = 0;
    const total = verses.length;

    setAudioProgress(0, `İndirme başladı: ${sid}. sure • ${reciter}`);

    for (const v of verses) {
      if (controller.signal.aborted) break;
      const url = EveryAyah.ayahUrl(reciter, sid, v.verse_number);
      try {
        // no-cors allows caching opaque cross-origin
        const resp = await fetch(url, { mode: "no-cors", signal: controller.signal });
        await cache.put(url, resp);
      } catch {
        // ignore
      }
      done++;
      const pct = Math.floor((done / total) * 100);
      setAudioProgress(pct, `İndiriliyor… ${done}/${total}  (≈ ${estimateMB(done, reciter).toFixed(1)} MB tahmini)`);
      await sleep(25);
    }

    if (controller.signal.aborted) {
      setAudioProgress(Math.floor((done / total) * 100), `İptal edildi. (${done}/${total})`);
    } else {
      setAudioProgress(100, `Tamamlandı ✅ (${total} ayet)  (≈ ${estimateMB(total, reciter).toFixed(1)} MB tahmini)`);
    }

    state.audioAbort = null;
    btnCancel.style.display = "none";
    await updateAudioCacheStats();
  }

  function cancelAudioDownload() {
    if (state.audioAbort) {
      state.audioAbort.abort();
    }
  }

  // ---------- UI init ----------
  function initUI() {
    Settings.apply(state.settings);

    // settings
    $("#fontSize").value = String(state.settings.fontSize);
    $("#lineHeight").value = String(state.settings.lineHeight);
    $("#showPageNums").checked = !!state.settings.showPageNums;
    $("#showArabic").checked = !!state.settings.showArabic;
    $("#showTranslation").checked = !!state.settings.showTranslation;
    $("#inlineMode").checked = !!state.settings.inlineMode;
    $("#tajweed").checked = !!state.settings.tajweed;
    $("#autoResume").checked = !!state.settings.autoResume;

    $("#includeFavFallback").checked = state.settings.includeFavFallback !== false;
    $("#includeDefaultFallback").checked = state.settings.includeDefaultFallback !== false;

    // player
    $("#audioMode").value = state.settings.audioMode;
    $("#volume").value = String(state.settings.volume ?? 0.9);
    $("#speedSelect").value = String(state.settings.speed || 1);
    $("#repeatSelect").value = String(state.settings.repeat || 1);

    // event bindings
    $("#fontSize").addEventListener("input", (e) => {
      state.settings.fontSize = Number(e.target.value);
      Settings.apply(state.settings);
      Settings.save(state.settings);
    });
    $("#lineHeight").addEventListener("input", (e) => {
      state.settings.lineHeight = Number(e.target.value);
      Settings.apply(state.settings);
      Settings.save(state.settings);
    });

    $("#showPageNums").addEventListener("change", (e) => {
      state.settings.showPageNums = !!e.target.checked;
      Settings.save(state.settings);
      render();
    });
    $("#showArabic").addEventListener("change", (e) => {
      state.settings.showArabic = !!e.target.checked;
      Settings.save(state.settings);
      render();
    });
    $("#showTranslation").addEventListener("change", (e) => {
      state.settings.showTranslation = !!e.target.checked;
      Settings.save(state.settings);
      render();
    });
    $("#inlineMode").addEventListener("change", (e) => {
      state.settings.inlineMode = !!e.target.checked;
      Settings.save(state.settings);
      render();
    });
    $("#tajweed").addEventListener("change", async (e) => {
      state.settings.tajweed = !!e.target.checked;
      Settings.save(state.settings);
      if (state.settings.tajweed) await tryLoadTajweed();
      render();
    });
    $("#autoResume").addEventListener("change", (e) => {
      state.settings.autoResume = !!e.target.checked;
      Settings.save(state.settings);
    });

    // authors
    const authorSelect = $("#authorSelect");
    authorSelect.innerHTML = state.authors
      .filter((a) => (a.language || "").toLowerCase() === "tr")
      .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}${a.description ? ` • ${escapeHtml(a.description)}` : ""}</option>`)
      .join("");
    authorSelect.value = String(state.authorId);
    authorSelect.addEventListener("change", () => {
      state.authorId = Number(authorSelect.value);
      localStorage.setItem(STORAGE.AUTHOR_KEY, String(state.authorId));
      render();
    });

    // surahs
    const surahSelect = $("#surahSelect");
    surahSelect.innerHTML = state.surahs
      .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${s.id})</option>`)
      .join("");
    surahSelect.value = String(state.surahId);
    surahSelect.addEventListener("change", () => {
      state.surahId = Number(surahSelect.value);
      localStorage.setItem(STORAGE.SURAH_KEY, String(state.surahId));
      state.query = "";
      $("#searchInput").value = "";
      saveLastRead({ view: state.view, surahId: state.surahId, ayah: 1 });
      render();
    });

    // view
    const viewSelect = $("#viewSelect");
    viewSelect.value = state.view;
    viewSelect.addEventListener("change", () => {
      state.view = viewSelect.value === "page" ? "page" : "ayah";
      localStorage.setItem(STORAGE.VIEW_KEY, state.view);
      render();
    });

    // search
    $("#searchInput").addEventListener(
      "input",
      debounce(() => {
        state.query = $("#searchInput").value.trim();
        render();
      }, 140)
    );

    // prev/next
    $("#btnPrev").addEventListener("click", () => {
      if (state.view === "ayah") {
        const idx = state.surahs.findIndex((s) => s.id === state.surahId);
        if (idx > 0) state.surahId = state.surahs[idx - 1].id;
        surahSelect.value = String(state.surahId);
        localStorage.setItem(STORAGE.SURAH_KEY, String(state.surahId));
      } else {
        state.page = Math.max(1, state.page - 1);
        localStorage.setItem(STORAGE.PAGE_KEY, String(state.page));
      }
      render();
    });

    $("#btnNext").addEventListener("click", () => {
      if (state.view === "ayah") {
        const idx = state.surahs.findIndex((s) => s.id === state.surahId);
        if (idx >= 0 && idx < state.surahs.length - 1) state.surahId = state.surahs[idx + 1].id;
        surahSelect.value = String(state.surahId);
        localStorage.setItem(STORAGE.SURAH_KEY, String(state.surahId));
      } else {
        state.page = Math.min(604, state.page + 1);
        localStorage.setItem(STORAGE.PAGE_KEY, String(state.page));
      }
      render();
    });

    // offline download (text)
    $("#btnDownload").addEventListener("click", downloadAllSurahs);

    // bookmarks/settings
    $("#btnBookmarks").addEventListener("click", openBookmarks);
    $("#btnSettings").addEventListener("click", () => $("#dlgSettings").showModal());
    $("#btnClearBookmarks").addEventListener("click", async () => {
      await DB.clear("bookmarks");
      await openBookmarks(true);
    });

    // audio offline modal
    $("#btnAudioOffline").addEventListener("click", async () => {
      $("#dlgAudio").showModal();
      setAudioProgress(0, "");
      await updateAudioCacheStats();
    });
    $("#btnCacheThisSurah").addEventListener("click", cacheCurrentSurahAudio);
    $("#btnClearAudioCache").addEventListener("click", clearAudioCache);
    $("#btnCancelAudioDownload").addEventListener("click", cancelAudioDownload);

    // install UI
    setupInstallUI();

    // audio settings
    $("#audioMode").addEventListener("change", (e) => {
      state.settings.audioMode = e.target.value;
      Settings.save(state.settings);
      stopAudio();
    });

    const audio = $("#audio");
    audio.volume = Number(state.settings.volume ?? 0.9);
    audio.playbackRate = Number(state.settings.speed || 1);

    $("#volume").addEventListener("input", (e) => {
      const v = Number(e.target.value);
      state.settings.volume = v;
      Settings.save(state.settings);
      audio.volume = v;
    });
    $("#speedSelect").addEventListener("change", (e) => {
      const sp = Number(e.target.value) || 1;
      state.settings.speed = sp;
      Settings.save(state.settings);
      audio.playbackRate = sp;
    });
    $("#repeatSelect").addEventListener("change", (e) => {
      const rp = Number(e.target.value) || 1;
      state.settings.repeat = rp;
      Settings.save(state.settings);
      state._repeatLeft = rp;
    });

    // follow toggle
    const followBtn = $("#btnFollow");
    const updateFollowBtn = () => (followBtn.style.color = state.settings.follow !== false ? "var(--ok)" : "var(--text)");
    updateFollowBtn();
    followBtn.addEventListener("click", () => {
      state.settings.follow = !(state.settings.follow !== false);
      Settings.save(state.settings);
      updateFollowBtn();
      if (state.settings.follow !== false) focusPlaying();
    });

    // Reciter dropdowns + favorites + search
    const reciterSelect = $("#reciterSelect");
    const fallbackTop = $("#fallbackReciter");
    const reciterSearch = $("#reciterSearch");
    const audioCacheReciter = $("#audioCacheReciter");

    function buildReciterOptions(filterText = "") {
      const q = filterText.trim().toLowerCase();
      const favSet = new Set((state.settings.favReciters || []).map(String));
      const all = RECITERS.slice().sort((a, b) => reciterLabel(a).localeCompare(reciterLabel(b), "tr"));
      const visible = q ? all.filter((r) => reciterLabel(r).toLowerCase().includes(q) || r.id.toLowerCase().includes(q)) : all;
      const makeOpt = (r) => `<option value="${r.id}">${escapeHtml(reciterLabel(r))}</option>`;

      const fav = visible.filter((r) => favSet.has(String(r.id)));
      const rest = visible.filter((r) => !favSet.has(String(r.id)));

      const parts = [];
      if (fav.length) parts.push(`<optgroup label="Favoriler">${fav.map(makeOpt).join("")}</optgroup>`);
      parts.push(`<optgroup label="Tümü">${rest.map(makeOpt).join("")}</optgroup>`);
      reciterSelect.innerHTML = parts.join("");

      const allOpts = `<option value="">(Kapalı)</option>` + all.map(makeOpt).join("");
      fallbackTop.innerHTML = allOpts;

      // audio cache reciter list
      const cacheOpts = `<option value="__current__">(Seçili kâriyi kullan)</option>` + all.map(makeOpt).join("");
      audioCacheReciter.innerHTML = cacheOpts;
    }

    buildReciterOptions("");

    if (RECITERS.some((r) => r.id === state.settings.reciter)) reciterSelect.value = state.settings.reciter;
    else {
      state.settings.reciter = RECITERS[0].id;
      Settings.save(state.settings);
      reciterSelect.value = state.settings.reciter;
    }

    fallbackTop.value = state.settings.fallbackReciter || state.settings.fallback1 || "";

    // cache reciter selection
    audioCacheReciter.value = state.settings.audioCacheReciter || "__current__";
    audioCacheReciter.addEventListener('change', ()=>{
      state.settings.audioCacheReciter = audioCacheReciter.value;
      Settings.save(state.settings);
    });

    // Advanced fallback
    const fb1 = $("#fallback1"), fb2 = $("#fallback2"), fb3 = $("#fallback3");
    const cbFav = $("#includeFavFallback"), cbDef = $("#includeDefaultFallback");
    const allSorted = RECITERS.slice().sort((a, b) => reciterLabel(a).localeCompare(reciterLabel(b), "tr"));
    const makeOpt = (r) => `<option value="${r.id}">${escapeHtml(reciterLabel(r))}</option>`;
    const allOpts = `<option value="">(Kapalı)</option>` + allSorted.map(makeOpt).join("");
    fb1.innerHTML = allOpts;
    fb2.innerHTML = allOpts;
    fb3.innerHTML = allOpts;
    fb1.value = state.settings.fallback1 || state.settings.fallbackReciter || "";
    fb2.value = state.settings.fallback2 || "";
    fb3.value = state.settings.fallback3 || "";
    cbFav.checked = state.settings.includeFavFallback !== false;
    cbDef.checked = state.settings.includeDefaultFallback !== false;

    function syncLegacyFallback() {
      state.settings.fallbackReciter = fb1.value || "";
      state.settings.fallback1 = fb1.value || "";
      fallbackTop.value = state.settings.fallbackReciter || "";
    }
    syncLegacyFallback();

    reciterSelect.addEventListener("change", () => {
      state.settings.reciter = reciterSelect.value;
      Settings.save(state.settings);
      stopAudio();
    });

    fallbackTop.addEventListener("change", () => {
      state.settings.fallbackReciter = fallbackTop.value;
      state.settings.fallback1 = fallbackTop.value;
      fb1.value = fallbackTop.value;
      Settings.save(state.settings);
    });

    reciterSearch.addEventListener(
      "input",
      debounce(() => {
        buildReciterOptions(reciterSearch.value);
        reciterSelect.value = state.settings.reciter;
        fallbackTop.value = state.settings.fallbackReciter || "";
        audioCacheReciter.value = state.settings.audioCacheReciter || "__current__";
      }, 120)
    );

    $("#btnFavReciter").addEventListener("click", () => {
      const cur = reciterSelect.value;
      const fav = new Set((state.settings.favReciters || []).map(String));
      if (fav.has(String(cur))) fav.delete(String(cur));
      else fav.add(String(cur));
      state.settings.favReciters = Array.from(fav);
      Settings.save(state.settings);
      buildReciterOptions(reciterSearch.value);
      reciterSelect.value = cur;
      setStatus(fav.has(String(cur)) ? "Favorilere eklendi ★" : "Favorilerden çıkarıldı");
    });

    fb1.addEventListener("change", () => {
      state.settings.fallback1 = fb1.value;
      syncLegacyFallback();
      Settings.save(state.settings);
    });
    fb2.addEventListener("change", () => {
      state.settings.fallback2 = fb2.value;
      Settings.save(state.settings);
    });
    fb3.addEventListener("change", () => {
      state.settings.fallback3 = fb3.value;
      Settings.save(state.settings);
    });
    cbFav.addEventListener("change", () => {
      state.settings.includeFavFallback = cbFav.checked;
      Settings.save(state.settings);
    });
    cbDef.addEventListener("change", () => {
      state.settings.includeDefaultFallback = cbDef.checked;
      Settings.save(state.settings);
    });

    // playback controls
    $("#btnPlayPause").addEventListener("click", () => {
      if (state.isPlaying) pauseAudio();
      else {
        if (state.playingIndex < 0) playByIndex(0);
        else resumeAudio();
      }
    });
    $("#btnStop").addEventListener("click", stopAudio);
    $("#btnPrevAyah").addEventListener("click", () => playByIndex(Math.max(0, state.playingIndex - 1)));
    $("#btnNextAyah").addEventListener("click", () => playByIndex(Math.min(state.currentItems.length - 1, state.playingIndex + 1)));

    audio.addEventListener("timeupdate", () => {
      if (!audio.duration || !isFinite(audio.duration)) return;
      $("#seek").value = String(Math.floor((audio.currentTime / audio.duration) * 100));
    });
    $("#seek").addEventListener("input", (e) => {
      const pct = Number(e.target.value);
      if (!audio.duration || !isFinite(audio.duration)) return;
      audio.currentTime = (pct / 100) * audio.duration;
    });

    audio.addEventListener("ended", () => {
      if (state.settings.audioMode === "ayah") {
        const repeatN = Number(state.settings.repeat || 1);
        state._repeatLeft = (state._repeatLeft ?? repeatN) - 1;
        if (state._repeatLeft > 0) {
          playByIndex(state.playingIndex);
          return;
        }
        state._repeatLeft = repeatN;
        if (state.playingIndex >= 0 && state.playingIndex < state.currentItems.length - 1) playByIndex(state.playingIndex + 1);
        else stopAudio();
      } else {
        stopAudio();
      }
    });

    audio.addEventListener("error", () => {
      if (state.settings.audioMode !== "ayah") return;
      const it = state.currentItems[state.playingIndex];
      if (!it) return;
      setStatus("Ses hatası. Fallback deneniyor…");
      const key = `${it.sid}:${it.a}`;
      const skip = state._skipByAyah.get(key) || new Set();
      playAyahWithFallback(it, skip);
    });

    // scroll save
    window.addEventListener(
      "scroll",
      debounce(() => {
        if (!state.settings.autoResume) return;
        saveLastRead({ scrollY: window.scrollY || 0 });
      }, 400),
      { passive: true }
    );
  }

  // ---------- Render ----------
  function makeAyahId(sid, a) {
    return `${sid}:${a}`;
  }

  function renderAyahRow(it, showSurah = false) {
    const row = document.createElement("div");
    row.className = "ayah";
    row.dataset.id = makeAyahId(it.sid, it.a);

    const left = document.createElement("div");
    left.className = "badge";
    left.innerHTML = `<span class="arrow" style="display:none">➤</span>${it.a}`;

    const mid = document.createElement("div");
    mid.className = "ayahText";

    const meta = [];
    if (showSurah) meta.push(`${it.sname} (${it.sid})`);
    if (state.settings.showPageNums && typeof it.p === "number") meta.push(`s.${it.p}`);
    const metaLine = meta.length ? `<div class="metaLine">${escapeHtml(meta.join(" • "))}</div>` : "";

    const arRaw = it.ar || "";
    const arHtml = state.settings.tajweed ? applyTajweedHtml(arRaw, it.sid, it.a) : highlight(arRaw, state.query);
    const trHtml = highlight(it.tr || "", state.query);

    const wantsGrid = state.settings.inlineMode && state.settings.showArabic && state.settings.showTranslation;
    if (wantsGrid) {
      mid.innerHTML = `${metaLine}<div class="rowGrid"><div class="ar">${arHtml}</div><div class="tr">${trHtml}</div></div>`;
    } else {
      const arPart = state.settings.showArabic && arRaw ? `<div class="ar">${arHtml}</div>` : "";
      const trPart = state.settings.showTranslation && it.tr ? `<div class="tr">${trHtml}</div>` : "";
      mid.innerHTML = `${metaLine}<div class="stack">${arPart}${trPart}</div>`;
    }

    const right = document.createElement("div");
    right.className = "ayahActions";

    const btnPlay = document.createElement("button");
    btnPlay.className = "iconBtn";
    btnPlay.title = "Dinle";
    btnPlay.textContent = "▶";
    btnPlay.addEventListener("click", () => {
      const idx = state.currentItems.findIndex((x) => x.sid === it.sid && x.a === it.a);
      playByIndex(idx);
    });

    const btnStar = document.createElement("button");
    btnStar.className = "iconBtn";
    btnStar.title = "Yer imi";
    btnStar.textContent = "★";
    btnStar.addEventListener("click", async () => toggleBookmark(it));

    const btnNote = document.createElement("button");
    btnNote.className = "iconBtn";
    btnNote.title = "Not";
    btnNote.textContent = "✎";
    btnNote.addEventListener("click", () => openNoteDialog(it));

    right.append(btnPlay, btnStar, btnNote);
    row.append(left, mid, right);

    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      saveLastRead({ view: state.view, surahId: it.sid, page: it.p ?? state.page, ayah: it.a });
    });

    return row;
  }

  async function render() {
    const panelTitle = $("#panelTitle");
    const content = $("#content");

    try {
      if (!state.authorId) return;
      if (state.settings.tajweed) await tryLoadTajweed();

      if (state.view === "ayah") {
        const surahMeta = state.surahs.find((s) => s.id === state.surahId);
        panelTitle.textContent = `${surahMeta?.name || "Sure"} • Ayet Görünümü`;

        const { data, fromCache } = await getSurahCached(state.surahId, state.authorId);
        const verses = Array.isArray(data?.verses) ? data.verses : [];

        let items = verses.map((v) => ({
          sid: data.id,
          sname: data.name || surahMeta?.name || "",
          a: v.verse_number,
          p: typeof v.page === "number" ? (v.page >= 1 ? v.page : v.page + 1) : null,
          ar: v.verse || "",
          tr: v.translation?.text || "",
          surahAudio: data.audio?.mp3 || surahMeta?.audio?.mp3 || null
        }));

        if (state.query) {
          const q = state.query.toLowerCase();
          items = items.filter((x) => (x.ar || "").toLowerCase().includes(q) || (x.tr || "").toLowerCase().includes(q));
        }

        state.currentItems = items;
        setStatus(fromCache ? "(Önbellekten)" : "(İnternetten)");
        await renderChunked(items, (it) => renderAyahRow(it, false), content, 28);
      } else {
        panelTitle.textContent = `Sayfa ${state.page} • Sayfa Görünümü`;

        const { data, fromCache } = await getPageCached(state.page, state.authorId);
        const verses = Array.isArray(data?.verses) ? data.verses : Array.isArray(data) ? data : [];

        let items = verses
          .map((v) => {
            const sid = v.surah_id || v.surah?.id;
            const surahMeta = state.surahs.find((s) => s.id === sid);
            const p = typeof (v.page ?? v.page_number) === "number" ? (v.page ?? v.page_number) : state.page;
            return {
              sid,
              sname: surahMeta?.name || v.surah?.name || "",
              a: v.verse_number,
              p: p >= 1 ? p : p + 1,
              ar: v.verse || v.arabic || "",
              tr: v.translation?.text || v.translation || "",
              surahAudio: surahMeta?.audio?.mp3 || null
            };
          })
          .filter((x) => x.sid && x.a);

        if (state.query) {
          const q = state.query.toLowerCase();
          items = items.filter((x) => (x.ar || "").toLowerCase().includes(q) || (x.tr || "").toLowerCase().includes(q));
        }

        state.currentItems = items;
        setStatus(fromCache ? "(Önbellekten)" : "(İnternetten)");
        await renderChunked(items, (it) => renderAyahRow(it, true), content, 34);
      }

      if (state.settings.autoResume) restoreLastRead();
      if (state.playingId) markPlaying(state.playingId);
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Beklenmeyen hata", true);
      content.innerHTML = `<div style="padding:12px;color:var(--danger)">Hata: ${escapeHtml(e.message || "")}</div>`;
    }
  }

  function restoreLastRead() {
    const last = loadLastRead();
    if (!last) return;
    if (last.surahId && last.ayah && state.view === "ayah" && state.surahId === Number(last.surahId)) {
      const id = `${last.surahId}:${last.ayah}`;
      const row = document.querySelector(`.ayah[data-id="${CSS.escape(id)}"]`);
      if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (typeof last.scrollY === "number") window.scrollTo({ top: last.scrollY, behavior: "instant" });
  }

  // ---------- Offline text download ----------
  async function downloadAllSurahs() {
    const total = state.surahs.length;
    if (!total) return;
    setStatus("Offline indirme başladı…");
    let ok = 0;
    for (let i = 0; i < total; i++) {
      const s = state.surahs[i];
      try {
        setStatus(`İndiriliyor: ${s.id}. ${s.name} (${i + 1}/${total})`);
        await getSurahCached(s.id, state.authorId);
        ok++;
        await sleep(120);
      } catch {}
    }
    setStatus(`Offline indirme tamamlandı ✅  Başarılı: ${ok}/${total}`);
  }

  // ---------- Bookmarks ----------
  async function toggleBookmark(it) {
    const id = makeAyahId(it.sid, it.a);
    const existing = await DB.get("bookmarks", id);
    if (existing) {
      await DB.del("bookmarks", id);
      setStatus("Yer imi kaldırıldı.");
    } else {
      await DB.put("bookmarks", {
        id,
        sid: it.sid,
        a: it.a,
        p: it.p || null,
        title: `${it.sname} ${it.sid}:${it.a}`,
        createdAt: Date.now()
      });
      setStatus("Yer imi eklendi ✅");
    }
  }

  async function openBookmarks(refreshOnly = false) {
    const dlg = $("#dlgBookmarks");
    const listEl = $("#bookmarkList");
    const items = await DB.list("bookmarks");
    items.sort((x, y) => y.createdAt - x.createdAt);

    if (!items.length) {
      listEl.innerHTML = `<div class="hint">Henüz yer imi yok.</div>`;
    } else {
      listEl.innerHTML = items
        .map(
          (b) => `
        <div class="bmItem">
          <div>
            <div class="bmTitle">${escapeHtml(b.title)}</div>
            <div class="bmMeta">Sayfa: ${b.p ?? "?"} • Kayıt: ${new Date(b.createdAt).toLocaleString("tr-TR")}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn ghost" data-go="${escapeHtml(b.id)}" type="button">Git</button>
            <button class="btn ghost" data-del="${escapeHtml(b.id)}" type="button">Sil</button>
          </div>
        </div>
      `
        )
        .join("");

      $$("button[data-go]", listEl).forEach((btn) => {
        btn.addEventListener("click", () => {
          jumpToAyahId(btn.getAttribute("data-go"));
          dlg.close();
        });
      });
      $$("button[data-del]", listEl).forEach((btn) => {
        btn.addEventListener("click", async () => {
          await DB.del("bookmarks", btn.getAttribute("data-del"));
          await openBookmarks(true);
        });
      });
    }

    if (!refreshOnly) dlg.showModal();
  }

  function jumpToAyahId(id) {
    const [sidStr, aStr] = (id || "").split(":");
    const sid = Number(sidStr);
    const a = Number(aStr);
    if (!sid || !a) return;

    state.surahId = sid;
    $("#surahSelect").value = String(sid);
    localStorage.setItem(STORAGE.SURAH_KEY, String(sid));

    state.view = "ayah";
    $("#viewSelect").value = "ayah";
    localStorage.setItem(STORAGE.VIEW_KEY, "ayah");

    saveLastRead({ view: "ayah", surahId: sid, ayah: a });

    render().then(() => {
      const row = document.querySelector(`.ayah[data-id="${CSS.escape(id)}"]`);
      if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  // ---------- Notes ----------
  function openNoteDialog(it) {
    const dlg = $("#dlgNote");
    const id = makeAyahId(it.sid, it.a);
    dlg.dataset.noteId = id;
    $("#noteTitle").textContent = `${it.sname} • ${it.sid}:${it.a}`;
    DB.get("notes", id).then((existing) => {
      $("#noteText").value = existing?.text || "";
      dlg.showModal();
    });
  }

  async function saveNoteFromDialog() {
    const dlg = $("#dlgNote");
    const id = dlg.dataset.noteId;
    if (!id) return;
    const text = $("#noteText").value.trim();
    if (!text) {
      await DB.del("notes", id);
      setStatus("Not temizlendi.");
      return;
    }
    await DB.put("notes", { id, text, updatedAt: Date.now() });
    setStatus("Not kaydedildi ✅");
  }

  // ---------- Audio playback + follow ----------
  function setNowPlaying(t) {
    $("#nowPlaying").textContent = t;
  }

  function markPlaying(id) {
    $$(".ayah.playing").forEach((el) => {
      el.classList.remove("playing");
      const arrow = el.querySelector(".badge .arrow");
      if (arrow) arrow.style.display = "none";
    });
    const row = document.querySelector(`.ayah[data-id="${CSS.escape(id)}"]`);
    if (row) {
      row.classList.add("playing");
      const arrow = row.querySelector(".badge .arrow");
      if (arrow) arrow.style.display = "block";
    }
  }

  function focusPlaying() {
    if (state.settings.follow === false || !state.playingId) return;
    const row = document.querySelector(`.ayah[data-id="${CSS.escape(state.playingId)}"]`);
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function playAyahWithFallback(it, skipSet) {
    const audio = $("#audio");

    const primary = state.settings.reciter;
    const fallback1 = state.settings.fallback1 || state.settings.fallbackReciter;
    const fallback2 = state.settings.fallback2;
    const fallback3 = state.settings.fallback3;
    const fav = (state.settings.favReciters || []).slice(0, 5);
    const includeFav = state.settings.includeFavFallback !== false;
    const includeDef = state.settings.includeDefaultFallback !== false;
    const defaults = ["Alafasy_128kbps", "Abdurrahmaan_As-Sudais_64kbps"];

    const queue = [primary, fallback1, fallback2, fallback3, ...(includeFav ? fav : []), ...(includeDef ? defaults : [])].filter(Boolean);
    const uniq = [];
    for (const r of queue) {
      const k = String(r);
      if (!uniq.includes(k) && !skipSet.has(k)) uniq.push(k);
    }

    for (const reciter of uniq) {
      try {
        skipSet.add(reciter);
        state._skipByAyah.set(`${it.sid}:${it.a}`, skipSet);

        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        audio.playbackRate = Number(state.settings.speed || 1);
        audio.src = EveryAyah.ayahUrl(reciter, it.sid, it.a);
        setNowPlaying(`Ayet: ${it.sname} ${it.sid}:${it.a} • ${reciter}`);
        await audio.play();
        state.isPlaying = true;
        $("#btnPlayPause").textContent = "⏸";
        markPlaying(state.playingId);
        focusPlaying();
        return true;
      } catch {
        // try next
      }
    }

    setStatus("Ses oynatılamadı. (Fallback zinciri bitti)", true);
    state.isPlaying = false;
    $("#btnPlayPause").textContent = "▶";
    return false;
  }

  async function playByIndex(idx) {
    if (idx < 0 || idx >= state.currentItems.length) return;
    const it = state.currentItems[idx];

    state.playingIndex = idx;
    state.playingId = `${it.sid}:${it.a}`;
    markPlaying(state.playingId);
    focusPlaying();

    saveLastRead({ view: state.view, surahId: it.sid, page: it.p ?? state.page, ayah: it.a });

    const audio = $("#audio");
    audio.volume = Number(state.settings.volume ?? 0.9);
    audio.playbackRate = Number(state.settings.speed || 1);
    state._repeatLeft = Number(state.settings.repeat || 1);

    try {
      if (state.settings.audioMode === "surah") {
        const url = it.surahAudio || state.surahs.find((s) => s.id === it.sid)?.audio?.mp3 || null;
        if (!url) {
          setStatus("Sure sesi bulunamadı.", true);
          return;
        }
        audio.src = url;
        setNowPlaying(`Sure sesi: ${it.sname} (${it.sid})`);
        await audio.play();
        state.isPlaying = true;
        $("#btnPlayPause").textContent = "⏸";
      } else {
        const key = `${it.sid}:${it.a}`;
        const skip = state._skipByAyah.get(key) || new Set();
        state._skipByAyah.set(key, skip);
        await playAyahWithFallback(it, skip);
      }
    } catch {
      setStatus("Ses oynatılamadı (izin / bağlantı).", true);
      state.isPlaying = false;
      $("#btnPlayPause").textContent = "▶";
    }
  }

  function pauseAudio() {
    const audio = $("#audio");
    audio.pause();
    state.isPlaying = false;
    $("#btnPlayPause").textContent = "▶";
  }

  async function resumeAudio() {
    const audio = $("#audio");
    try {
      await audio.play();
      state.isPlaying = true;
      $("#btnPlayPause").textContent = "⏸";
      focusPlaying();
    } catch {
      state.isPlaying = false;
      $("#btnPlayPause").textContent = "▶";
    }
  }

  function stopAudio() {
    const audio = $("#audio");
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    state.isPlaying = false;
    $("#btnPlayPause").textContent = "▶";
    $("#seek").value = "0";
    setNowPlaying("Hazır");
    if (state.playingId) markPlaying("__none__");
    state.playingId = null;
    state.playingIndex = -1;
  }

  // ---------- SW ----------
  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (e) {
      console.warn("SW error", e);
    }
  }

  // ---------- Boot ----------
  (async function boot() {
    try {
      setStatus("Başlatılıyor…");
      await loadMeta();

      const last = loadLastRead();
      if (state.settings.autoResume && last?.surahId) {
        state.surahId = Number(last.surahId);
        localStorage.setItem(STORAGE.SURAH_KEY, String(state.surahId));
      }

      // Wire note buttons
      $("#btnSaveNote").addEventListener("click", async (e) => {
        e.preventDefault();
        await saveNoteFromDialog();
        $("#dlgNote").close();
      });
      $("#btnDeleteNote").addEventListener("click", async () => {
        const id = $("#dlgNote").dataset.noteId;
        if (!id) return;
        await DB.del("notes", id);
        $("#dlgNote").close();
        setStatus("Not silindi.");
      });

      initUI();
      await render();
      registerSW();
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Başlatma hatası", true);
    }
  })();
})();
