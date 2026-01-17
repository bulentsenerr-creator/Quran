/* Kur'ân Okuma • Elmalılı (Açık Kuran API) • Saf JS • Offline + Sesli Okuma + Takip */
(() => {
  "use strict";

  // ---------- Helpers ----------
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

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Chunked render to avoid UI freeze
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
    const KEY = "quran_settings_v3";
    const defaults = {
      fontSize: 20,
      lineHeight: 1.9,
      showPageNums: true,
      showArabic: true,
      showTranslation: true,
      inlineMode: false,
      tajweed: false,
      autoResume: true,
      audioMode: "ayah", // ayah|surah
      reciter: "AbdulSamad_64kbps_QuranExplorer.Com",
      follow: true,
      volume: 0.9,
      speed: 1,
      repeat: 1,
      favReciters: [],
      fallbackReciter: "Alafasy_128kbps"
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
    const DB_NAME = "quran_app_v3";
    const DB_VER = 3;
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
        try { out = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
      });
    }

    const get = (store, key) => tx(store, "readonly", (s) => new Promise((res, rej) => {
      const r = s.get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    }));

    const put = (store, val) => tx(store, "readwrite", (s) => new Promise((res, rej) => {
      const r = s.put(val);
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    }));

    const del = (store, key) => tx(store, "readwrite", (s) => new Promise((res, rej) => {
      const r = s.delete(key);
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    }));

    const list = (store) => tx(store, "readonly", (s) => new Promise((res, rej) => {
      const r = s.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    }));

    const clear = (store) => tx(store, "readwrite", (s) => new Promise((res, rej) => {
      const r = s.clear();
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    }));

    return { get, put, del, list, clear };
  })();

  // ---------- API (Açık Kuran) ----------
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
    // 001001.mp3 format
    ayahUrl(reciter, surahId, ayahNum){
      const s = String(surahId).padStart(3, "0");
      const a = String(ayahNum).padStart(3, "0");
      return `${this.base}/${reciter}/${s}${a}.mp3`;
    }
  };

  // ---------- Reciters (EveryAyah directory names) ----------
  // Source list based on EveryAyah recitation pages.
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

  function reciterLabel(r){
    return `${r.name} • ${r.quality}`;
  }

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

    // render cache
    currentItems: [],

    // playing
    playingId: null, // "sid:ayah"
    playingIndex: -1,
    isPlaying: false,
    follow: true,

    // tajweed index
    tajweedReady: false,
    tajweedMap: new Map(), // key "sid:ayah" -> annotations [{rule,start,end}]
    tajweedWarned: false
  };

  const STORAGE = {
    AUTHOR_KEY: "quran_author_id",
    VIEW_KEY: "quran_view",
    SURAH_KEY: "quran_surah_id",
    PAGE_KEY: "quran_page",
    LAST_KEY: "quran_last_read_v1"
  };

  // ---------- Last read ----------
  function saveLastRead(partial){
    if (!state.settings.autoResume) return;
    try{
      const prev = JSON.parse(localStorage.getItem(STORAGE.LAST_KEY) || "{}") || {};
      const next = { ...prev, ...partial, t: Date.now() };
      localStorage.setItem(STORAGE.LAST_KEY, JSON.stringify(next));
    }catch{}
  }
  function loadLastRead(){
    try{ return JSON.parse(localStorage.getItem(STORAGE.LAST_KEY) || "null"); }catch{ return null; }
  }

  // ---------- Boot data ----------
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

    // restore view/surah/page
    state.view = localStorage.getItem(STORAGE.VIEW_KEY) || state.view;
    state.surahId = Number(localStorage.getItem(STORAGE.SURAH_KEY) || state.surahId);
    state.page = Number(localStorage.getItem(STORAGE.PAGE_KEY) || state.page);

    // apply settings stored
    state.follow = !!state.settings.follow;
  }

  // ---------- Cache keys ----------
  const keySurah = (sid, aid) => `surah:${sid}:author:${aid}`;
  const keyPage = (p, aid) => `page:${p}:author:${aid}`;

  // ---------- Data fetch w/ cache ----------
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
  async function tryLoadTajweed(){
    if (!state.settings.tajweed) return;
    if (state.tajweedReady) return;

    const cached = await DB.get("tajweed", "map_v1");
    if (cached?.data && Array.isArray(cached.data)){
      state.tajweedMap = new Map(cached.data);
      state.tajweedReady = true;
      setStatus("Tecvid: önbellekten hazır ✅");
      return;
    }

    try{
      setStatus("Tecvid verisi yükleniyor…");
      const [txtRes, annRes] = await Promise.all([
        fetch("./data/quran-uthmani.txt", {cache:"no-cache"}),
        fetch("./data/tajweed.hafs.uthmani-pause-sajdah.json", {cache:"no-cache"})
      ]);
      if (!txtRes.ok || !annRes.ok) throw new Error("Tecvid dosyaları bulunamadı.");

      const annotations = await annRes.json();
      state.tajweedMap = new Map();
      for (const item of (annotations || [])){
        const sid = item.surah;
        const ay = item.ayah;
        if (!sid || !ay) continue;
        state.tajweedMap.set(`${sid}:${ay}`, item.annotations || []);
      }

      await DB.put("tajweed", { key:"map_v1", data: Array.from(state.tajweedMap.entries()), builtAt: Date.now() });
      state.tajweedReady = true;
      setStatus("Tecvid: hazır ✅");
    }catch(e){
      if (!state.tajweedWarned){
        setStatus("Tecvid: veri yok (isteğe bağlı). Ayarlardan kapatabilirsiniz.");
        state.tajweedWarned = true;
      }
    }
  }

  function ruleToClass(rule){
    const r = String(rule||"");
    if (r.startsWith("madd")) return "tj-madd";
    if (r.startsWith("ghunnah")) return "tj-ghunnah";
    if (r.startsWith("ikhfa")) return "tj-ikhfa";
    if (r.startsWith("iqlab")) return "tj-iqlab";
    if (r.startsWith("qalqalah")) return "tj-qalqalah";
    if (r.startsWith("idghaam")) return "tj-idghaam";
    if (r.startsWith("hamzat_wasl") || r.startsWith("lam_shamsiyyah")) return "tj-wasl";
    return "tj-wasl";
  }

  function applyTajweedHtml(arText, sid, ay){
    if (!state.settings.tajweed || !state.tajweedReady) return escapeHtml(arText);
    const key = `${sid}:${ay}`;
    const anns = state.tajweedMap.get(key);
    if (!anns || !anns.length) return escapeHtml(arText);

    const chars = Array.from(arText);
    const L = chars.length;
    const sorted = anns
      .map(a => ({ rule: a.rule, start: Math.max(0, Math.min(L, a.start)), end: Math.max(0, Math.min(L, a.end)) }))
      .filter(a => a.end > a.start)
      .sort((x,y)=> x.start - y.start);

    if (!sorted.length) return escapeHtml(arText);

    const out = [];
    let i = 0;
    for (const a of sorted){
      if (a.start > i) out.push({text: chars.slice(i, a.start).join(""), cls: null});
      out.push({text: chars.slice(a.start, a.end).join(""), cls: ruleToClass(a.rule)});
      i = Math.max(i, a.end);
    }
    if (i < L) out.push({text: chars.slice(i).join(""), cls: null});

    return out.map(seg => seg.cls ? `<span class="${seg.cls}">${escapeHtml(seg.text)}</span>` : escapeHtml(seg.text)).join("");
  }

  // ---------- UI init ----------
  function initUI() {
    Settings.apply(state.settings);

    $("#fontSize").value = String(state.settings.fontSize);
    $("#lineHeight").value = String(state.settings.lineHeight);
    $("#showPageNums").checked = !!state.settings.showPageNums;
    $("#showArabic").checked = !!state.settings.showArabic;
    $("#showTranslation").checked = !!state.settings.showTranslation;
    $("#inlineMode").checked = !!state.settings.inlineMode;
    $("#tajweed").checked = !!state.settings.tajweed;
    $("#autoResume").checked = !!state.settings.autoResume;

    $("#audioMode").value = state.settings.audioMode;
    
    // Build reciter dropdowns (favorites first)
    const reciterSelect = $("#reciterSelect");
    const fallbackSelect = $("#fallbackReciter");
    const reciterSearch = $("#reciterSearch");

    function buildReciterOptions(filterText = ""){
      const q = filterText.trim().toLowerCase();
      const fav = new Set((state.settings.favReciters || []).map(String));
      const all = RECITERS.slice().sort((a,b)=> reciterLabel(a).localeCompare(reciterLabel(b), 'tr'));
      const visible = q ? all.filter(r => reciterLabel(r).toLowerCase().includes(q) || r.id.toLowerCase().includes(q)) : all;

      const makeOpt = (r) => `<option value="${r.id}">${escapeHtml(reciterLabel(r))}</option>`;
      const favList = visible.filter(r => fav.has(String(r.id)));
      const restList = visible.filter(r => !fav.has(String(r.id)));

      const parts = [];
      if (favList.length) parts.push(`<optgroup label="Favoriler">${favList.map(makeOpt).join('')}</optgroup>`);
      parts.push(`<optgroup label="Tümü">${restList.map(makeOpt).join('')}</optgroup>`);
      reciterSelect.innerHTML = parts.join('');

      // fallback list should include all reciters (not filtered)
      const allOpts = all.map(makeOpt).join('');
      fallbackSelect.innerHTML = `<option value="">(Kapalı)</option>` + allOpts;
    }

    buildReciterOptions("");

    // Apply saved values if exist
    if (RECITERS.some(r => r.id === state.settings.reciter)) reciterSelect.value = state.settings.reciter;
    else reciterSelect.value = RECITERS[0]?.id || "";

    if (state.settings.fallbackReciter && RECITERS.some(r => r.id === state.settings.fallbackReciter)) fallbackSelect.value = state.settings.fallbackReciter;
    else fallbackSelect.value = state.settings.fallbackReciter || "";

    // Reciter search (type-to-search)
    reciterSearch.addEventListener('input', debounce(() => {
      buildReciterOptions(reciterSearch.value);
      // keep selection if possible
      if (state.settings.reciter) reciterSelect.value = state.settings.reciter;
    }, 120));

    reciterSearch.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter'){
        const first = reciterSelect.querySelector('option');
        if (first){
          reciterSelect.value = first.value;
          state.settings.reciter = first.value;
          Settings.save(state.settings);
          stopAudio();
        }
      }
    });

    // Favorites toggle
    $("#btnFavReciter").addEventListener('click', () => {
      const cur = reciterSelect.value;
      const fav = new Set((state.settings.favReciters || []).map(String));
      if (fav.has(String(cur))) fav.delete(String(cur)); else fav.add(String(cur));
      state.settings.favReciters = Array.from(fav);
      Settings.save(state.settings);
      buildReciterOptions(reciterSearch.value);
      reciterSelect.value = cur;
      setStatus(fav.has(String(cur)) ? 'Favorilere eklendi ★' : 'Favorilerden çıkarıldı');
    });

    // Reciter change
    reciterSelect.addEventListener("change", (e) => {
      state.settings.reciter = e.target.value;
      Settings.save(state.settings);
      stopAudio();
    });

    // Fallback change
    fallbackSelect.addEventListener('change', (e)=>{
      state.settings.fallbackReciter = e.target.value;
      Settings.save(state.settings);
    });

    // Speed + Repeat
    const speedSel = $("#speedSelect");
    const repeatSel = $("#repeatSelect");
    speedSel.value = String(state.settings.speed || 1);
    repeatSel.value = String(state.settings.repeat || 1);

    speedSel.addEventListener('change', (e)=>{
      state.settings.speed = Number(e.target.value) || 1;
      Settings.save(state.settings);
      $("#audio").playbackRate = state.settings.speed;
    });

    repeatSel.addEventListener('change', (e)=>{
      state.settings.repeat = Number(e.target.value) || 1;
      Settings.save(state.settings);
    });


    $("#volume").value = String(state.settings.volume ?? 0.9);
    state.follow = !!state.settings.follow;
    updateFollowBtn();

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

    const authorSelect = $("#authorSelect");
    authorSelect.innerHTML = state.authors
      .filter((a) => (a.language || "").toLowerCase() === "tr")
      .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}${a.description ? " • " + escapeHtml(a.description) : ""}</option>`)
      .join("");

    authorSelect.value = String(state.authorId);
    authorSelect.addEventListener("change", () => {
      state.authorId = Number(authorSelect.value);
      localStorage.setItem(STORAGE.AUTHOR_KEY, String(state.authorId));
      setStatus("Meal değişti. (İsterseniz offline indirmeyi tekrar yapın.)");
      render();
    });

    const surahSelect = $("#surahSelect");
    surahSelect.innerHTML = state.surahs
      .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${s.id})</option>`)
      .join("");

    if (state.surahs.some((s) => s.id === state.surahId)) surahSelect.value = String(state.surahId);
    else { state.surahId = state.surahs[0]?.id || 1; surahSelect.value = String(state.surahId); }

    surahSelect.addEventListener("change", () => {
      state.surahId = Number(surahSelect.value);
      localStorage.setItem(STORAGE.SURAH_KEY, String(state.surahId));
      state.query = "";
      $("#searchInput").value = "";
      saveLastRead({ view: state.view, surahId: state.surahId, page: state.page, ayah: 1 });
      render();
    });

    const viewSelect = $("#viewSelect");
    viewSelect.value = state.view;
    viewSelect.addEventListener("change", () => {
      state.view = viewSelect.value === "page" ? "page" : "ayah";
      localStorage.setItem(STORAGE.VIEW_KEY, state.view);
      render();
    });

    $("#searchInput").addEventListener(
      "input",
      debounce(() => {
        state.query = $("#searchInput").value.trim();
        render();
      }, 140)
    );

    $("#btnPrev").addEventListener("click", () => {
      if (state.view === "ayah") {
        const idx = state.surahs.findIndex((s) => s.id === state.surahId);
        if (idx > 0) state.surahId = state.surahs[idx - 1].id;
        $("#surahSelect").value = String(state.surahId);
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
        $("#surahSelect").value = String(state.surahId);
        localStorage.setItem(STORAGE.SURAH_KEY, String(state.surahId));
      } else {
        state.page = Math.min(604, state.page + 1);
        localStorage.setItem(STORAGE.PAGE_KEY, String(state.page));
      }
      render();
    });

    $("#btnDownload").addEventListener("click", async () => { await downloadAllSurahs(); });

    $("#btnBookmarks").addEventListener("click", openBookmarks);
    $("#btnSettings").addEventListener("click", () => $("#dlgSettings").showModal());

    $("#btnSaveNote").addEventListener("click", async (e) => { e.preventDefault(); await saveNoteFromDialog(); $("#dlgNote").close(); });

    $("#btnDeleteNote").addEventListener("click", async () => {
      const id = $("#dlgNote").dataset.noteId;
      if (!id) return;
      await DB.del("notes", id);
      $("#dlgNote").close();
      setStatus("Not silindi.");
    });

    $("#btnClearBookmarks").addEventListener("click", async () => { await DB.clear("bookmarks"); await openBookmarks(true); });

    // Player
    $("#audioMode").addEventListener("change", (e) => { state.settings.audioMode = e.target.value; Settings.save(state.settings); stopAudio(); });
        $("#volume").addEventListener("input", (e) => { const v = Number(e.target.value); state.settings.volume = v; Settings.save(state.settings); $("#audio").volume = v; });

    $("#btnPlayPause").addEventListener("click", () => {
      if (state.isPlaying) pauseAudio();
      else {
        if (state.playingIndex < 0) {
          const last = loadLastRead();
          if (last?.surahId && last?.ayah) {
            const idx = state.currentItems.findIndex(x => x.sid === last.surahId && x.a === last.ayah);
            playByIndex(idx >= 0 ? idx : 0);
          } else playByIndex(0);
        } else resumeAudio();
      }
    });

    $("#btnStop").addEventListener("click", stopAudio);
    $("#btnPrevAyah").addEventListener("click", () => playByIndex(Math.max(0, state.playingIndex - 1)));
    $("#btnNextAyah").addEventListener("click", () => playByIndex(Math.min(state.currentItems.length - 1, state.playingIndex + 1)));
    $("#btnFollow").addEventListener("click", () => { state.follow = !state.follow; state.settings.follow = state.follow; Settings.save(state.settings); updateFollowBtn(); if (state.follow && state.playingId) focusPlaying(); });

    const audio = $("#audio");
    audio.volume = Number(state.settings.volume ?? 0.9);
    audio.playbackRate = Number(state.settings.speed || 1);
    audio.addEventListener("error", () => {
      if (state.settings.audioMode !== "ayah") return;
      if (state._fallbacking) return;
      state._fallbacking = true;
      const curItem = state.currentItems[state.playingIndex];
      if (!curItem){ state._fallbacking = false; return; }
      setStatus("Ses hatası. Yedek kâri deneniyor…");
      playAyahWithFallback(curItem).finally(()=>{ state._fallbacking = false; });
    });

    audio.addEventListener("timeupdate", () => {
      if (!audio.duration || !isFinite(audio.duration)) return;
      const pct = Math.floor((audio.currentTime / audio.duration) * 100);
      $("#seek").value = String(pct);
    });
    audio.addEventListener("ended", () => {
      if (state.settings.audioMode === "ayah") {
        // Repeat the same ayah N times
        const repeatN = Number(state.settings.repeat || 1);
        state._repeatLeft = (state._repeatLeft ?? repeatN) - 1;
        if (state._repeatLeft > 0) {
          // replay same
          playByIndex(state.playingIndex);
          return;
        }
        // reset for next ayah
        state._repeatLeft = repeatN;
        if (state.playingIndex >= 0 && state.playingIndex < state.currentItems.length - 1) {
          playByIndex(state.playingIndex + 1);
        } else {
          stopAudio();
        }
      } else {
        stopAudio();
      }
    });
    $("#seek").addEventListener("input", (e) => {
      const pct = Number(e.target.value);
      if (!audio.duration || !isFinite(audio.duration)) return;
      audio.currentTime = (pct / 100) * audio.duration;
    });

    window.addEventListener("scroll", debounce(() => {
      if (!state.settings.autoResume) return;
      const top = window.scrollY || document.documentElement.scrollTop || 0;
      saveLastRead({ scrollY: top });
    }, 400), { passive: true });
  }

  function updateFollowBtn(){ $("#btnFollow").style.color = state.follow ? "var(--ok)" : "var(--text)"; }

  // ---------- Render ----------
  function makeAyahId(sid, a) { return `${sid}:${a}`; }

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
      const idx = state.currentItems.findIndex(x => x.sid === it.sid && x.a === it.a);
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
    btnNote.addEventListener("click", async () => openNoteDialog(it));

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
        if (!data) throw new Error("Sure verisi alınamadı.");

        const verses = Array.isArray(data.verses) ? data.verses : [];
        let items = verses.map((v) => {
          const p = typeof v.page === "number" ? (v.page >= 1 ? v.page : v.page + 1) : null;
          return {
            sid: data.id,
            sname: data.name || surahMeta?.name || "",
            a: v.verse_number,
            p,
            ar: v.verse || "",
            tr: v.translation?.text || "",
            surahAudio: data.audio?.mp3 || surahMeta?.audio?.mp3 || null,
            surahAudioDuration: data.audio?.duration || surahMeta?.audio?.duration || null
          };
        });

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
        const verses = Array.isArray(data?.verses) ? data.verses : Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];

        let items = verses.map((v) => {
          const sid = v.surah_id || v.surah?.id || v.surahId || v.surah_id;
          const surahMeta = state.surahs.find((s) => s.id === sid);
          const p = typeof (v.page ?? v.page_number) === "number" ? (v.page ?? v.page_number) : state.page;
          return {
            sid: sid || 0,
            sname: surahMeta?.name || v.surah?.name || "",
            a: v.verse_number || v.aya || v.verseNumber || 0,
            p: p >= 1 ? p : p + 1,
            ar: v.verse || v.arabic || "",
            tr: v.translation?.text || v.translation || v.text || "",
            surahAudio: surahMeta?.audio?.mp3 || null,
            surahAudioDuration: surahMeta?.audio?.duration || null
          };
        }).filter((x) => x.sid && x.a);

        if (state.query) {
          const q = state.query.toLowerCase();
          items = items.filter((x) => (x.ar || "").toLowerCase().includes(q) || (x.tr || "").toLowerCase().includes(q));
        }

        state.currentItems = items;
        setStatus(fromCache ? "(Önbellekten)" : "(İnternetten)");
        await renderChunked(items, (it) => renderAyahRow(it, true), content, 34);
      }

      if (state.settings.autoResume) restoreLastReadScroll();
      if (state.playingId) markPlaying(state.playingId);

    } catch (e) {
      console.error(e);
      setStatus(e.message || "Beklenmeyen hata", true);
      content.innerHTML = `<div style="padding:12px;color:var(--danger)">Hata: ${escapeHtml(e.message || "Bilinmiyor")}</div>`;
    }
  }

  function restoreLastReadScroll(){
    const last = loadLastRead();
    if (!last) return;
    if (last.surahId && last.ayah && state.view === "ayah" && state.surahId === last.surahId){
      const id = `${last.surahId}:${last.ayah}`;
      const row = document.querySelector(`.ayah[data-id="${CSS.escape(id)}"]`);
      if (row) row.scrollIntoView({behavior:"smooth", block:"center"});
      return;
    }
    if (typeof last.scrollY === "number") window.scrollTo({ top: last.scrollY, behavior: "instant" });
  }

  // ---------- Offline download ----------
  async function downloadAllSurahs() {
    const total = state.surahs.length;
    if (!total) return;
    setStatus("Offline indirme başladı… Bu işlem ilk seferde birkaç dakika sürebilir.");
    let ok = 0;
    for (let i = 0; i < total; i++) {
      const s = state.surahs[i];
      try {
        setStatus(`İndiriliyor: ${s.id}. ${s.name}  (${i + 1}/${total})`);
        await getSurahCached(s.id, state.authorId);
        ok++;
        await sleep(120);
      } catch (e) { console.warn("İndirilemedi:", s.id, e); }
    }
    setStatus(`Offline indirme tamamlandı ✅  Başarılı: ${ok}/${total}`);
  }

  // ---------- Bookmarks ----------
  async function toggleBookmark(it) {
    const id = makeAyahId(it.sid, it.a);
    const existing = await DB.get("bookmarks", id);
    if (existing) { await DB.del("bookmarks", id); setStatus("Yer imi kaldırıldı."); }
    else {
      await DB.put("bookmarks", { id, sid: it.sid, a: it.a, p: it.p || null, title: `${it.sname} ${it.sid}:${it.a}`, createdAt: Date.now() });
      setStatus("Yer imi eklendi ✅");
    }
  }

  async function openBookmarks(refreshOnly = false) {
    const dlg = $("#dlgBookmarks");
    const listEl = $("#bookmarkList");
    const items = await DB.list("bookmarks");
    items.sort((x, y) => y.createdAt - x.createdAt);

    if (!items.length) listEl.innerHTML = `<div class="hint">Henüz yer imi yok.</div>`;
    else {
      listEl.innerHTML = items.map((b) => `
        <div class="bmItem">
          <div>
            <div class="bmTitle">${escapeHtml(b.title)}</div>
            <div class="bmMeta">Sayfa: ${b.p ?? "?"} • Kayıt: ${new Date(b.createdAt).toLocaleString("tr-TR")}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn ghost" data-go="${escapeHtml(b.id)}" type="button">Git</button>
            <button class="btn ghost" data-del="${escapeHtml(b.id)}" type="button">Sil</button>
          </div>
        </div>`).join("");

      $$("button[data-go]", listEl).forEach((btn) => btn.addEventListener("click", () => { jumpToAyahId(btn.getAttribute("data-go")); dlg.close(); }));
      $$("button[data-del]", listEl).forEach((btn) => btn.addEventListener("click", async () => { await DB.del("bookmarks", btn.getAttribute("data-del")); await openBookmarks(true); }));
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
  async function openNoteDialog(it) {
    const dlg = $("#dlgNote");
    const id = makeAyahId(it.sid, it.a);
    dlg.dataset.noteId = id;
    $("#noteTitle").textContent = `${it.sname} • ${it.sid}:${it.a}`;
    const existing = await DB.get("notes", id);
    $("#noteText").value = existing?.text || "";
    dlg.showModal();
  }

  async function saveNoteFromDialog() {
    const dlg = $("#dlgNote");
    const id = dlg.dataset.noteId;
    if (!id) return;
    const text = $("#noteText").value.trim();
    if (!text) { await DB.del("notes", id); setStatus("Not temizlendi."); return; }
    await DB.put("notes", { id, text, updatedAt: Date.now() });
    setStatus("Not kaydedildi ✅");
  }

  // ---------- Audio Playback + Follow ----------
  function setNowPlaying(text){ $("#nowPlaying").textContent = text; }

  function markPlaying(id){
    $$(".ayah.playing").forEach(el => { el.classList.remove("playing"); const arrow = el.querySelector(".badge .arrow"); if (arrow) arrow.style.display = "none"; });
    const row = document.querySelector(`.ayah[data-id="${CSS.escape(id)}"]`);
    if (row){ row.classList.add("playing"); const arrow = row.querySelector(".badge .arrow"); if (arrow) arrow.style.display = "block"; }
  }

  function focusPlaying(){
    if (!state.follow || !state.playingId) return;
    const row = document.querySelector(`.ayah[data-id="${CSS.escape(state.playingId)}"]`);
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function playAyahWithFallback(it){
    const audio = $("#audio");
    const primary = state.settings.reciter;
    const fallback = state.settings.fallbackReciter;
    const fav = (state.settings.favReciters || []).slice(0, 5);

    // Try order: primary -> fallback -> first favorites -> Alafasy -> Sudais
    const tried = [];
    const queue = [primary, fallback, ...fav, "Alafasy_128kbps", "Abdurrahmaan_As-Sudais_64kbps"].filter(Boolean);
    const uniq = [];
    for (const r of queue){
      const k = String(r);
      if (!uniq.includes(k)) uniq.push(k);
    }

    let lastErr = null;
    for (const reciter of uniq){
      tried.push(reciter);
      try{
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.playbackRate = Number(state.settings.speed || 1);
        audio.src = EveryAyah.ayahUrl(reciter, it.sid, it.a);
        setNowPlaying(`Ayet: ${it.sname} ${it.sid}:${it.a} • ${reciter}`);
        await audio.play();
        // success: remember last working reciter (optional)
        state._lastWorkingReciter = reciter;
        return true;
      }catch(e){
        lastErr = e;
        // continue
      }
    }

    console.warn('Fallback failed. Tried:', tried, lastErr);
    setStatus('Ses oynatılamadı. (Tüm kâriler denendi)', true);
    return false;
  }

  async function playByIndex(idx){
    if (idx < 0 || idx >= state.currentItems.length) return;
    const it = state.currentItems[idx];
    state.playingIndex = idx;
    state.playingId = `${it.sid}:${it.a}`;
    saveLastRead({ view: state.view, surahId: it.sid, page: it.p ?? state.page, ayah: it.a });

    const audio = $("#audio");
    audio.volume = Number(state.settings.volume ?? 0.9);
    audio.playbackRate = Number(state.settings.speed || 1);

    if (state.settings.audioMode === "surah"){
      const url = it.surahAudio || (state.surahs.find(s => s.id === it.sid)?.audio?.mp3) || null;
      if (!url) { setStatus("Sure sesi bulunamadı.", true); return; }
      audio.playbackRate = Number(state.settings.speed || 1);
      audio.src = url;
      setNowPlaying(`Sure sesi: ${it.sname} (${it.sid})`);
    } else {
      // Ayet modunda fallback zinciri ile çal
      state._repeatLeft = Number(state.settings.repeat || 1);
      const ok = await playAyahWithFallback(it);
      if (!ok) { state.isPlaying = false; $("#btnPlayPause").textContent = "▶"; return; }
    }

    try{
      await audio.play();
      state.isPlaying = true;
      $("#btnPlayPause").textContent = "⏸";
      markPlaying(state.playingId);
      focusPlaying();
    }catch(e){
      setStatus("Ses oynatılamadı (tarayıcı izinleri / bağlantı).", true);
      console.warn(e);
      state.isPlaying = false;
      $("#btnPlayPause").textContent = "▶";
    }
  }

  function pauseAudio(){ const audio = $("#audio"); audio.pause(); state.isPlaying = false; $("#btnPlayPause").textContent = "▶"; }
  async function resumeAudio(){ const audio = $("#audio"); try{ await audio.play(); state.isPlaying = true; $("#btnPlayPause").textContent = "⏸"; focusPlaying(); } catch { state.isPlaying = false; $("#btnPlayPause").textContent = "▶"; } }

  function stopAudio(){
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

  // ---------- PWA / Service worker ----------
  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      $("#subtitle").textContent = reg.active ? "Elmalılı • Offline" : "PWA kuruluyor…";
    } catch (e) {
      console.warn("SW kayıt edilemedi:", e);
    }
  }

  // ---------- Boot ----------
  (async function boot() {
    try {
      setStatus("Başlatılıyor…");
      await loadMeta();
      initUI();

      const last = loadLastRead();
      if (state.settings.autoResume && last?.surahId){
        state.surahId = Number(last.surahId);
        localStorage.setItem(STORAGE.SURAH_KEY, String(state.surahId));
      }
      $("#surahSelect").value = String(state.surahId);

      await render();
      registerSW();
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Başlatma hatası", true);
    }
  })();
})();
