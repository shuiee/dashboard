/*
 * app.js
 * Wires the replay clock, the live adapters, the rules and the display together.
 */
(function () {
  'use strict';
  const F = window.FFOE;
  const cfg = F.config;
  const R = cfg.rules;
  const fmt = F.fmt;
  const $ = id => document.getElementById(id);

  const store = {
    get(k) { try { return localStorage.getItem('ffoe.' + k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem('ffoe.' + k, v); } catch (_) { /* private mode */ } },
  };

  const S = {
    mode: F.feeds.kind(cfg) === 'none' ? 'replay' : 'live',
    playing: true,
    speed: cfg.replay.speed,
    simT: cfg.replay.startAtS,
    duration: cfg.run.durationS,
    runStartMs: Date.parse(cfg.run.start),
    sel: 0,
    hoverT: null,
    ackT: -Infinity,
    pods: [],
    events: [],
    csv: null,
    live: null,
    camState: { link: 'none', msg: '' },
    camPrev: { link: 'none', top: null },
    dirty: true,
    scrubbing: false,
    evSig: null,
  };

  /* ================= data setup ================= */
  function makePod(pc, series, label) {
    const tl = F.rules.buildTimeline(pc, series, cfg);
    return {
      cfg: pc, label, series, states: tl.states, events: tl.events,
      rateArr: tl.states.map(s => s.rate30),
      iv: F.rules.intervals(series, tl.states, series.length - 1, pc.fan),
    };
  }

  function initReplay(csv) {
    const dur = csv ? Math.max(cfg.run.durationS, Math.ceil(csv.durationS)) : cfg.run.durationS;
    S.pods = cfg.pods.map(pc => {
      if (pc.source === 'replay') {
        return csv ? makePod(pc, csv.series, 'CSV replay') : makePod(pc, F.data.buildExp03(cfg), pc.label);
      }
      return makePod(pc, F.data.simulatePod(cfg, pc, dur), pc.label);
    });
    S.duration = Math.max.apply(null, S.pods.map(P => P.series.lastT));
    S.runStartMs = csv && csv.startMs ? csv.startMs : Date.parse(cfg.run.start);
    mergeEvents();
    $('scrub').max = String(S.duration);
    if (csv) S.simT = Math.min(S.duration, 0);
    S.simT = Math.min(S.simT, S.duration);
    S.ackT = S.simT;
    S.evSig = null;
    S.dirty = true;
  }

  function mergeEvents() {
    S.events = [].concat.apply([], S.pods.map(P => P.events)).sort((a, b) => a.t - b.t);
  }

  /* ================= live ================= */
  /*
   * Live mode: each pod with live: true in config gets its own feed (feeds.js). Readings arrive
   * as epoch ms; the series uses seconds since S.live.originMs, the earliest reading loaded.
   * The baseline comes from meta.loadT, which the operator sets from the bridge (l + Enter).
   */
  function initLive() {
    if (S.live) return;
    S.live = { pods: {}, conn: 'connecting', msg: '', originMs: null, sysEvents: [] };
    cfg.pods.forEach((pc, k) => {
      if (!pc.live) return;
      const LP = {
        k, cfg: Object.assign({}, pc), label: 'Live',
        series: new F.Series(cfg, cfg.cloud.pushS), states: [], events: [], rateArr: [],
        live: true, prev: null, onset: {}, stale: false, meta: {}, ready: false, lastLoadT: undefined,
      };
      S.live.pods[k] = LP;
      F.feeds.start(cfg, pc.id, {
        onStatus: (state, msg) => onLiveStatus(LP, state, msg),
        onMeta: meta => onLiveMeta(LP, meta),
        onHistory: list => onLiveHistory(LP, list),
        onReading: r => onLiveReading(LP, r),
      }).then(feed => { LP.feed = feed; });
    });
    if (!Object.keys(S.live.pods).length) onLiveStatus(null, 'setup', 'No pod has live: true in js/config.js');
  }

  const liveNow = () => (F.feeds.serverNow() - (S.live && S.live.originMs != null ? S.live.originMs : F.feeds.serverNow())) / 1000;
  const liveT = ms => (ms - S.live.originMs) / 1000;

  function onLiveStatus(LP, state, msg) {
    const L = S.live;
    if (L.conn !== state && L.conn && S.mode === 'live' && (state === 'offline' || (state === 'online' && L.conn === 'offline'))) {
      logSys(state === 'offline' ? 'CAUT' : 'INFO', state === 'offline' ? 'Lost connection to the database' : 'Connection restored', LP && LP.cfg.id);
    }
    L.conn = state;
    L.msg = msg || '';
    S.dirty = true;
  }

  function onLiveMeta(LP, meta) {
    LP.meta = meta || {};
    if (LP.meta.fruit) {
      const name = String(LP.meta.fruit);
      LP.cfg.fruit = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      LP.cfg.icon = name.toLowerCase();
      buildTiles(); buildPodPick();
    }
    if (LP.ready && LP.meta.loadT !== LP.lastLoadT) { applyLiveBaseline(LP); rebuildLive(LP); }
    renderHeader();
    S.dirty = true;
  }

  function onLiveHistory(LP, list) {
    const L = S.live;
    if (L.originMs == null) L.originMs = list.length ? list[0].t : F.feeds.serverNow();
    for (const r of list) LP.series.push({ t: liveT(r.t), raw: r.ppb, temp: r.temp, rh: r.rh, fan: 0 });
    LP.ready = true;
    applyLiveBaseline(LP);
    rebuildLive(LP);
  }

  function onLiveReading(LP, r) {
    if (S.live.originMs == null) S.live.originMs = r.t;
    const series = LP.series;
    const t = liveT(r.t);
    if (t <= series.lastT) return; // duplicate or out of order
    const i = series.push({ t, raw: r.ppb, temp: r.temp, rh: r.rh, fan: 0 });
    if (series.loadT == null && !LP.autoBase && t - series.t[0] >= 60) { applyLiveBaseline(LP); rebuildLive(LP); return; }
    const st = F.rules.evaluate(series, i, LP.cfg, cfg, LP.prev, null);
    F.rules.diffEvents(LP.cfg, series, LP.prev, st, LP.events, LP.onset, cfg);
    st.onset = Object.assign({}, LP.onset);
    LP.states.push(st);
    LP.rateArr.push(st.rate30);
    LP.prev = st;
    S.dirty = true;
  }

  /** Baseline = the two minutes before the load mark; before any mark, the first minute (provisional). */
  function applyLiveBaseline(LP) {
    const s = LP.series;
    LP.lastLoadT = LP.meta.loadT;
    if (!s.length) return;
    if (LP.meta.loadT) {
      const t = liveT(LP.meta.loadT);
      if (!s.setBaseline(t - 120, t - 2, t)) s.setBaseline(t, t + 60, t); // no data before the mark: use the first minute after
    } else if (s.lastT - s.t[0] >= 60) {
      s.setBaseline(s.t[0], s.t[0] + 60, null);
      LP.autoBase = true;
    }
  }

  function rebuildLive(LP) {
    const tl = F.rules.buildTimeline(LP.cfg, LP.series, cfg);
    LP.states = tl.states;
    LP.events = tl.events;
    LP.rateArr = tl.states.map(s => s.rate30);
    LP.prev = tl.states[tl.states.length - 1] || null;
    LP.onset = LP.prev ? Object.assign({}, LP.prev.onset) : {};
    S.evSig = null;
    S.dirty = true;
  }

  function logSys(sev, text, podId) {
    if (!S.live) return;
    S.live.sysEvents.push({ t: liveNow(), pod: podId || 'POD-1', sev, text });
    S.evSig = null;
    S.dirty = true;
  }

  /* ================= views ================= */
  function camFlag() {
    const c = S.camState;
    if (!c || c.link === 'none') return 'na';
    if (c.link === 'lost') return 'caution';
    if (c.link === 'ok' && c.preds && c.preds[0] &&
        R.spoilageClasses.test(c.preds[0].name) && c.preds[0].p >= R.spoilageConfidence) return 'warning';
    return 'off';
  }

  function now() { return S.mode === 'live' ? liveNow() : S.simT; }

  function view(k) {
    const pc = cfg.pods[k];
    if (S.mode === 'live') {
      const LP = S.live && S.live.pods[k];
      if (!LP) return { pc, offline: true, noSensor: true, now: liveNow() };
      if (!LP.series.length) return { pc: LP.cfg, offline: true, noSignal: true, now: liveNow() };
    }
    const P = S.mode === 'live' ? S.live.pods[k] : S.pods[k];
    const t = now();
    const i = P.series.indexAt(t);
    let st = i >= 0 ? P.states[i] : null;
    if (st) {
      const ctx = {};
      if (k === 0) ctx.cam = camFlag();
      if (S.mode === 'live') ctx.stale = t - P.series.lastT > R.staleFactor * P.series.nominalDt;
      if (k === 0 || ctx.stale) st = F.rules.applyContext(Object.assign({}, st), ctx);
    }
    return { pc: P.cfg || pc, P, i, st, now: t };
  }

  function xRange(t) {
    return S.mode === 'replay' ? [0, S.duration] : [0, Math.max(t, 600)];
  }

  /* ================= DOM build ================= */
  function buildPodPick() {
    const wrap = $('podPick');
    wrap.innerHTML = '';
    S.pickEls = cfg.pods.map((pc, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pp';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(k === S.sel));
      b.setAttribute('aria-label', pc.fruit + ', ' + pc.id);
      b.innerHTML = F.fruitIcon(pc) + '<span>' + pc.id + '</span>';
      b.addEventListener('click', () => select(k));
      wrap.appendChild(b);
      return b;
    });
  }

  function buildCharts() {
    const onHover = t => { S.hoverT = t; S.dirty = true; };
    S.ch = {
      primary: new F.charts.StripChart($('cPrimary'), {
        onHover, includeZero: true, minSpan: 80, nowLabel: true, markerLabels: true, xAxis: true,
        label: 'Ethylene rise above baseline, temperature-corrected, ppb',
      }),
    };
  }

  /* ================= render ================= */
  /** Inline fruit icon plus pod ID, used wherever a fruit would have been named. */
  const who = pc => F.fruitIcon(pc) + ' ' + pc.id;

  /** 'wait' | 'soon' | 'ready' | 'now' | 'spoiled', or null when nothing is loaded. */
  function stageOf(v) {
    if (!v || v.offline || !v.st || !v.st.loaded || v.st.stage == null) return null;
    if (v.st.flags.CAM === 'warning') return 'spoiled';
    return cfg.eat.stages[v.st.stage].key;
  }

  /** Eat order: most ripe stage first, then fastest ripening. */
  function eatOrder(views) {
    const score = v => (v.st.flags.CAM === 'warning' ? 9 : v.st.stage);
    const rate = v => (Number.isFinite(v.st.rate30) ? v.st.rate30 : -Infinity);
    const ranked = views
      .map((v, k) => ({ k, v }))
      .filter(o => stageOf(o.v) != null)
      .sort((a, b) => score(b.v) - score(a.v) || rate(b.v) - rate(a.v));
    const rank = {};
    ranked.forEach((o, n) => { rank[o.k] = n + 1; });
    return { rank, ranked };
  }

  function ventState(v) {
    if (v.offline || !v.st) return { key: 'na', word: 'No data', sub: '' };
    const st = v.st, pc = v.pc;
    if (st.fan) {
      const s = v.P.series;
      let j = v.i;
      while (j > 0 && s.fan[j - 1]) j--;
      const left = Math.max(0, R.fanRunS - (st.t - s.t[j]));
      return { key: 'on', word: 'Fan on', sub: 'Flushing ethylene, ' + Math.ceil(left) + ' s left' };
    }
    if (st.vent.advised && !pc.fan) return { key: 'need', word: 'Vent needed', sub: 'No fan fitted. Open the vent for 2 min' };
    if (st.vent.advised) return { key: 'off', word: 'Sealed', sub: 'Ripening fast, fan runs again soon' };
    if (!st.loaded) return { key: 'off', word: 'Sealed', sub: 'Waiting for produce' };
    return { key: 'off', word: 'Sealed', sub: pc.fan ? 'Fan on standby' : 'No fan fitted' };
  }

  /** Things the crew must do that are not eating or venting. Empty most of the time, on purpose. */
  function crewActions(views) {
    const out = [];
    if (S.mode === 'live' && S.live) {
      const c = S.live.conn;
      if (c === 'setup') out.push({ sev: 'CAUT', text: 'Live data not set up', sub: S.live.msg });
      else if (c === 'offline') out.push({ sev: 'CAUT', text: 'No connection to the database', sub: 'Readings resume when the connection returns' });
      else if (c === 'error') out.push({ sev: 'CAUT', text: 'Live data error: ' + S.live.msg, sub: '' });
    }
    views.forEach(v => {
      if (v.offline || !v.st) return;
      const f = v.st.flags, id = who(v.pc);
      if (f.CAM === 'warning') out.push({ sev: 'WARN', text: 'Inspect ' + id, sub: 'Camera sees possible spoilage' });
      if (f.DATA === 'warning') out.push({ sev: 'WARN', text: 'Check sensor ' + id, sub: 'Reading out of range' });
      if (f.TEMP === 'warning' || f.TEMP === 'caution') out.push({ sev: f.TEMP === 'warning' ? 'WARN' : 'CAUT', text: 'Check temperature ' + id, sub: fmt.num(v.st.temp, 1) + ' °C, outside cabin range' });
      if (f.DATA === 'caution') out.push({ sev: 'CAUT', text: id + ' stopped reporting', sub: 'Check the sensor cable or battery' });
      if (f.RH === 'caution') out.push({ sev: 'CAUT', text: 'Wipe condensation ' + id, sub: 'Humidity ' + fmt.num(v.st.rh, 0) + ' %RH, mould risk' });
      if (f.PWR === 'caution') out.push({ sev: 'CAUT', text: 'Charge ' + id, sub: 'Battery estimate under a day' });
      if (f.CAM === 'caution') out.push({ sev: 'CAUT', text: 'Camera link lost ' + id, sub: 'Frames are not arriving' });
    });
    return out;
  }

  /*
   * Crew view: one tile per pod, nothing else unless something needs a person.
   * A tile shows the eat-order number, the fruit in its porthole and one readiness word.
   * The fan line appears only while a fan runs or a pod with no fan needs venting.
   */
  function buildTiles() {
    const wrap = $('tiles');
    wrap.innerHTML = '';
    S.tileEls = cfg.pods.map((pc, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      b.innerHTML =
        '<span class="brackets" aria-hidden="true"></span>' +
        '<div class="tile-in">' +
        '<div class="tile-top"><span class="tile-pod">' + pc.id + '</span><span class="rank" data-f="rank"></span></div>' +
        '<div class="tile-ico">' + F.fruitIcon(pc, { globe: true }) + '</div>' +
        '<div class="stage-word" data-f="word"></div>' +
        '<div class="tile-vent" data-f="ventRow"><i class="ph ph-fan" aria-hidden="true"></i><span data-f="vent"></span></div>' +
        '</div>';
      b.addEventListener('click', () => { if (b.dataset.offline !== '1') { select(k); setView('monitor'); } });
      const f = {};
      b.querySelectorAll('[data-f]').forEach(e => { f[e.dataset.f] = e; });
      wrap.appendChild(b);
      return { b, f };
    });
  }

  const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
  // Compare with what we last wrote, not innerHTML: the browser re-serialises SVG differently.
  const setHtml = (el, s) => { if (el._h !== s) { el._h = s; el.innerHTML = s; } };

  function renderCrew(views, ranked, rank) {
    views.forEach((v, k) => {
      const { b, f } = S.tileEls[k];
      const stage = stageOf(v);
      const vs = ventState(v);
      let word;
      if (v.noSensor) word = 'No sensor';
      else if (v.offline) word = 'No signal';
      else if (!v.st) word = 'No data';
      else if (!v.st.loaded) word = 'Empty';
      else if (stage === 'spoiled') word = 'Check';
      else word = cfg.eat.stages[v.st.stage].word;

      b.dataset.offline = v.offline ? '1' : '0';
      b.dataset.stage = stage || 'none';
      b.dataset.first = rank[k] === 1 ? '1' : '0';
      setText(f.word, word);
      setText(f.rank, rank[k] ? String(rank[k]) : '');

      // Fan line only when something is happening
      const show = vs.key === 'on' || vs.key === 'need';
      b.dataset.vent = show ? vs.key : 'off';
      setText(f.vent, vs.key === 'on' ? 'Venting' : vs.key === 'need' ? 'Open vent' : '');

      const label = v.pc.fruit + ', ' + v.pc.id + '. ' + word +
        (rank[k] ? '. Eat ' + ordinal(rank[k]) : '') + (show ? '. ' + vs.word : '') + '. Open details';
      if (b._label !== label) { b._label = label; b.setAttribute('aria-label', label); }
    });

    // One line per thing the crew must do; hidden when there is nothing.
    const acts = crewActions(views);
    const sig = acts.map(a => a.sev + a.text).join('|');
    if (sig !== S.actSig) {
      S.actSig = sig;
      const ul = $('actions');
      ul.textContent = '';
      ul.hidden = !acts.length;
      acts.slice(0, 3).forEach(a => {
        const li = document.createElement('li');
        li.className = 'notice';
        li.dataset.sev = a.sev;
        const sv = document.createElement('span'); sv.className = 'sev sev-' + a.sev; sv.textContent = a.sev;
        const tx = document.createElement('span'); tx.innerHTML = a.text;
        li.append(sv, tx);
        ul.appendChild(li);
      });
    }
  }

  const ordinal = n => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

  function setView(v) {
    S.view = v;
    store.set('view', v);
    $('console').dataset.view = v;
    $('crewView').hidden = v !== 'crew';
    $('monitorView').hidden = v !== 'monitor';
    $('viewTabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    S.evSig = null;
    S.dirty = true;
  }

  function renderMaster(events) {
    let lit = '';
    for (let n = events.length - 1; n >= 0; n--) {
      const e = events[n];
      if (e.t <= S.ackT) break;
      if (e.sev === 'WARN') { lit = 'warning'; break; }
      if (e.sev === 'CAUT') lit = 'caution';
    }
    if (camFlag() === 'warning' && S.camState.lastMs > S.ackWall) lit = 'warning';
    const m = $('btnMaster');
    if ((m.dataset.lit || '') !== lit) {
      m.dataset.lit = lit;
      m.dataset.flash = lit ? '1' : '0';
      m.textContent = lit === 'warning' ? 'Master warning' : 'Master caution';
      m.setAttribute('aria-label', lit ? 'Master ' + lit + ', press to acknowledge' : 'Master caution, no new alerts');
    }
  }

  function currentEvents() {
    if (S.mode === 'replay') {
      let lo = 0, hi = S.events.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (S.events[mid].t <= S.simT) lo = mid + 1; else hi = mid; }
      return S.events.slice(0, lo);
    }
    if (!S.live) return [];
    return [].concat.apply(S.live.sysEvents, Object.values(S.live.pods).map(LP => LP.events)).sort((a, b) => a.t - b.t);
  }

  function renderEvents(all) {
    const id = cfg.pods[S.sel].id;
    const list = all.filter(e => e.pod === id);
    const sig = S.mode + ':' + id + ':' + list.length + ':' + S.runStartMs;
    if (sig === S.evSig) return;
    S.evSig = sig;
    const ol = $('evList');
    ol.textContent = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'ev-empty';
      li.textContent = S.mode === 'live' && S.sel === 0
        ? 'No events yet. Connect the DGS2, wait a minute, then press the flag when the produce goes in.'
        : 'No events yet.';
      ol.appendChild(li);
      return;
    }
    const frag = document.createDocumentFragment();
    for (let n = list.length - 1, c = 0; n >= 0 && c < 60; n--, c++) {
      const e = list[n];
      const li = document.createElement('li');
      li.className = 'ev';
      li.dataset.sev = e.sev;
      const tm = document.createElement('span'); tm.className = 'tm'; tm.textContent = fmt.metShort(e.t);
      const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = e.text;
      li.append(tm, tx);
      frag.appendChild(li);
    }
    ol.appendChild(frag);
  }

  /** The three numbers that matter, at the crosshair or now. */
  function renderNums(v, k) {
    if (v.offline || !v.P || k < 0) {
      setText($('numRise'), 'N/A'); setText($('numRate'), 'N/A'); setText($('numFan'), v.noSensor ? 'NO SENSOR' : v.offline ? 'NO SIGNAL' : 'N/A'); setText($('numAt'), '');
      return;
    }
    const st = v.P.states[k];
    setText($('numRise'), fmt.signed(st.delta));
    setText($('numRate'), st.loaded && Number.isFinite(st.rate30) ? fmt.signed(st.rate30) : 'N/A');
    setText($('numFan'), st.fan ? 'ON' : !v.pc.fan ? 'NONE' : 'OFF');
    setText($('numAt'), S.hoverT != null ? fmt.met(st.t) : '');
  }

  function clipIntervals(P, iEnd, t) {
    if (P.live) return F.rules.intervals(P.series, P.states, iEnd, P.cfg.fan);
    const clip = list => list.filter(([a]) => a <= t).map(([a, b]) => [a, Math.min(b, t)]);
    return { on: clip(P.iv.on), adv: clip(P.iv.adv) };
  }

  function liveEmptyMsg() {
    if (S.mode !== 'live' || !S.live) return 'WAITING FOR DATA';
    if (S.live.conn === 'setup') return 'LIVE DATA NOT SET UP, SEE SETUP.MD';
    if (S.live.conn === 'connecting') return 'CONNECTING';
    if (S.live.conn === 'offline' || S.live.conn === 'error') return 'NO CONNECTION';
    return 'WAITING FOR THE FIRST READING';
  }

  function drawCharts(v) {
    const c = S.ch.primary;
    if (v.offline || !v.P || v.P.series.length === 0) {
      c.set({ x: xRange(v.now), now: v.now, t: [], iEnd: -1, series: [], empty: v.noSensor ? 'NO SENSOR ON THIS POD' : liveEmptyMsg() });
      c.draw();
      return -1;
    }
    const P = v.P, s = P.series, t = v.now;
    const iEnd = s.indexAt(t);
    const hi = S.hoverT != null ? s.indexAt(Math.min(S.hoverT, t)) : null;
    const iv = clipIntervals(P, iEnd, t);
    c.set({
      x: xRange(t), now: t, t: s.t, iEnd, hoverT: S.hoverT, hoverI: hi,
      markers: s.loadT != null ? [{ t: s.loadT, label: 'LOAD' }] : [],
      series: [{ y: s.delta, color: 'data', width: 2 }],
      shade: iv.on,
      thresholds: [
        { v: R.ventDeltaPpb, label: 'VENT ' + R.ventDeltaPpb, color: 'advisory', include: true },
        { v: R.deltaCautionPpb, label: 'CAUTION ' + R.deltaCautionPpb, color: 'caution', include: true },
      ],
    });
    c.draw();
    return hi != null && hi >= 0 ? hi : iEnd;
  }

  function renderCam() {
    const c = S.camState;
    $('camPanel').hidden = !(S.mode === 'live' && S.sel === 0);
    const img = $('camImg');
    const hasPhoto = !!c.photo;
    img.hidden = !hasPhoto;
    $('camMsg').hidden = hasPhoto;
    if (hasPhoto && img.src !== c.photo) img.src = c.photo;
    if (!hasPhoto) $('camMsg').textContent = c.link === 'connecting' ? 'Connecting' : 'No camera';
    let meta = c.msg || '';
    if (c.link === 'ok') {
      const top = c.preds && c.preds[0];
      meta = (top ? top.name + ' ' + Math.round(top.p * 100) + '%, ' : '') + fmt.local(c.lastMs) + (c.msg ? '. ' + c.msg : '');
    }
    $('camMeta').textContent = meta;
    $('btnCam').textContent = cam.running ? 'Stop' : 'Connect';
  }

  function camEvents(c) {
    if (!S.live || S.mode !== 'live') { S.camPrev = { link: c.link, top: null }; return; }
    const top = c.preds && c.preds[0] ? c.preds[0].name : null;
    if (c.link !== S.camPrev.link) {
      if (c.link === 'ok') logSys('INFO', 'Camera downlink up');
      if (c.link === 'lost') logSys('CAUT', 'Camera link lost');
    }
    if (top && top !== S.camPrev.top) {
      const p = c.preds[0];
      const spoil = R.spoilageClasses.test(p.name) && p.p >= R.spoilageConfidence;
      logSys(spoil ? 'WARN' : 'INFO', 'Camera classifier: ' + p.name + ' ' + (p.p * 100).toFixed(0) + '%');
    }
    S.camPrev = { link: c.link, top };
  }

  /** Top-bar word: is what you see live? */
  function renderLink() {
    const el = $('link');
    let s = 'demo', txt = 'Demo';
    if (S.mode === 'live' && S.live) {
      const pods = Object.values(S.live.pods);
      const last = pods.reduce((m, LP) => Math.max(m, LP.series.length ? LP.series.lastT : -Infinity), -Infinity);
      const age = liveNow() - last;
      if (S.live.conn === 'setup') { s = 'off'; txt = 'Not set up'; }
      else if (S.live.conn === 'offline' || S.live.conn === 'error') { s = 'off'; txt = 'Offline'; }
      else if (!Number.isFinite(last)) { s = 'off'; txt = S.live.conn === 'connecting' ? 'Connecting' : 'No signal'; }
      else if (age > R.staleFactor * cfg.cloud.pushS) { s = 'stale'; txt = 'Stale'; }
      else { s = 'live'; txt = F.feeds.kind(cfg) === 'practice' ? 'Practice' : 'Live'; }
      const ls = $('liveState');
      setText(ls, Number.isFinite(last) ? 'Last reading ' + fmt.dur(Math.max(0, age)) + ' ago' : S.live.msg);
    }
    el.dataset.s = s;
    setText(el, txt);
  }

  function renderClocks(t) {
    setText($('clkMet'), fmt.met(t));
  }

  function renderHeader() {
    if (S.mode === 'replay') {
      $('sbSource').textContent = S.csv
        ? 'POD-1 ' + S.csv.name + ', others simulated'
        : 'POD-1 Experiment 3 (rebuilt), others simulated';
    } else {
      $('sbSource').textContent = 'POD-1 live DGS2, others not connected';
    }
  }

  function updateUI() {
    const views = cfg.pods.map((_, k) => view(k));
    const v = views[S.sel];
    const { rank, ranked } = eatOrder(views);

    if (S.mode === 'live' && S.live) {
      Object.values(S.live.pods).forEach(LP => {
        const stale = LP.series.length > 0 && liveNow() - LP.series.lastT > R.staleFactor * LP.series.nominalDt;
        if (stale !== LP.stale) {
          LP.stale = stale;
          logSys(stale ? 'CAUT' : 'INFO', stale ? 'No new sensor data' : 'Sensor data resumed', LP.cfg.id);
        }
      });
    }
    renderLink();

    const events = currentEvents();
    if (S.view === 'crew') {
      renderCrew(views, ranked, rank);
    } else {
      renderEvents(events);
      renderNums(v, drawCharts(v));
    }
    renderMaster(events);
    renderClocks(now());
    if (S.mode === 'replay' && !S.scrubbing) $('scrub').value = String(Math.round(S.simT));
  }

  /* ================= interaction ================= */
  function select(k) {
    S.sel = k;
    S.pickEls.forEach((b, n) => b.setAttribute('aria-selected', String(n === k)));
    S.evSig = null;
    renderCam();
    S.dirty = true;
  }

  function syncPlay() {
    const b = $('btnPlay');
    b.innerHTML = S.playing ? '<i class="ph ph-pause" aria-hidden="true"></i>' : '<i class="ph ph-play" aria-hidden="true"></i>';
    b.setAttribute('aria-label', S.playing ? 'Pause replay' : 'Play replay');
  }

  function setPressed(groupId, attr, value) {
    $(groupId).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value))));
  }

  function setMode(m) {
    if (m === S.mode) return;
    S.mode = m;
    if (m === 'live') initLive();
    setPressed('modeSeg', 'mode', m);
    $('replayBar').hidden = m !== 'replay';
    $('liveBar').hidden = m !== 'live';
    $('btnMark').hidden = m !== 'replay';
    S.ackT = now();
    S.ackWall = Date.now();
    S.evSig = null;
    S.runStartMs = m === 'live' ? (S.live.originMs || Date.now()) : (S.csv && S.csv.startMs ? S.csv.startMs : Date.parse(cfg.run.start));
    buildTiles(); buildPodPick(); select(S.sel);
    renderHeader();
    renderCam();
    S.dirty = true;
  }

  function notice(text) {
    const el = $('sbNote');
    el.textContent = text;
    clearTimeout(notice.t);
    notice.t = setTimeout(() => { el.textContent = ''; }, 9000);
  }

  function markLoad() {
    if (S.mode === 'replay') {
      const P = S.pods[S.sel];
      const t = S.simT;
      if (!P.series.setBaseline(t - 120, t - 2, t)) { notice('Need readings before this point to set a baseline'); return; }
      Object.assign(P, makePod(P.cfg, P.series, P.label));
      mergeEvents();
      S.evSig = null;
      notice(P.cfg.id + ': load marked at ' + fmt.met(t) + ', baseline from the two minutes before');
    } else {
      notice('In live mode, mark the load on the sensor laptop: type l and press Enter in the bridge window');
    }
    S.dirty = true;
  }

  async function loadCsvFile(file) {
    try {
      const text = await file.text();
      const parsed = F.data.parseCsv(text, cfg);
      S.csv = { name: file.name, rows: parsed.rows, startMs: parsed.startMs };
      if (S.mode !== 'replay') setMode('replay');
      initReplay(parsed);
      S.playing = false; syncPlay();
      renderHeader();
      notice('Loaded ' + file.name + ': ' + parsed.rows + ' rows, ' + fmt.dur(parsed.durationS) + '. Scrub to the load and press Mark load');
    } catch (e) {
      notice('CSV not loaded: ' + e.message);
    }
  }

  const cam = new F.live.Camera(cfg, st => {
    S.camState = Object.assign({}, st);
    camEvents(st);
    renderCam();
    S.dirty = true;
  });

  function bind() {
    $('modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
    $('viewTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });
    $('speedSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      S.speed = Number(b.dataset.speed); setPressed('speedSeg', 'speed', S.speed);
    });
    $('btnPlay').addEventListener('click', () => {
      if (!S.playing && S.simT >= S.duration) S.simT = 0;
      S.playing = !S.playing; syncPlay();
    });
    const scrub = $('scrub');
    scrub.addEventListener('pointerdown', () => { S.scrubbing = true; });
    scrub.addEventListener('pointerup', () => { S.scrubbing = false; });
    scrub.addEventListener('input', () => { S.simT = Number(scrub.value); S.ackT = S.simT; S.dirty = true; });
    $('csvInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadCsvFile(f); e.target.value = ''; });
    $('btnMark').addEventListener('click', markLoad);
    $('btnMaster').addEventListener('click', () => { S.ackT = now(); S.ackWall = Date.now(); S.dirty = true; });
    $('camIp').value = store.get('camIp') || cfg.camera.ip;
    $('camForm').addEventListener('submit', e => {
      e.preventDefault();
      if (cam.running) { cam.stop(); renderCam(); return; }
      const ip = $('camIp').value.trim();
      if (!ip) { $('camMeta').textContent = 'Enter the camera IP from Serial Monitor.'; return; }
      store.set('camIp', ip);
      cam.start({ ip, intervalS: cfg.camera.intervalS, classify: !!cfg.camera.modelUrl, modelUrl: cfg.camera.modelUrl });
      renderCam();
    });

    // Drag a CSV anywhere
    let dragDepth = 0;
    window.addEventListener('dragenter', e => { if (e.dataTransfer && [].includes.call(e.dataTransfer.types, 'Files')) { dragDepth++; $('drop').hidden = false; } });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true; });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
      const f = e.dataTransfer.files[0]; if (f) loadCsvFile(f);
    });

    window.addEventListener('keydown', e => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.key === ' ' && S.mode === 'replay') { e.preventDefault(); $('btnPlay').click(); }
      if (/^[1-4]$/.test(e.key)) select(Number(e.key) - 1);
      if (S.mode === 'replay' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        S.simT = Math.max(0, Math.min(S.duration, S.simT + (e.key === 'ArrowRight' ? 300 : -300)));
        S.ackT = S.simT; S.dirty = true;
      }
    });
  }

  /* ================= loop ================= */
  let last = performance.now(), lastUi = 0;
  function frame(ts) {
    const dt = Math.min(0.5, (ts - last) / 1000);
    last = ts;
    if (S.mode === 'replay' && S.playing) {
      S.simT = Math.min(S.duration, S.simT + dt * S.speed);
      if (S.simT >= S.duration) { S.playing = false; syncPlay(); }
      S.dirty = true;
    }
    if (S.mode === 'live' && ts - lastUi > 500) S.dirty = true;
    if (S.dirty && ts - lastUi > 60) {
      lastUi = ts;
      S.dirty = false;
      updateUI();
    }
    requestAnimationFrame(frame);
  }

  /* ================= start ================= */
  S.ackWall = Date.now();
  F.charts.refreshColors();
  initReplay(null);
  buildTiles();
  buildPodPick();
  buildCharts();
  bind();
  setPressed('speedSeg', 'speed', S.speed);
  syncPlay();
  renderHeader();
  renderCam();
  setView(store.get('view') === 'monitor' ? 'monitor' : 'crew');
  // Open live when a feed is configured (or ?feed=practice); otherwise the labelled demo.
  const startMode = S.mode;
  S.mode = 'replay';
  if (startMode === 'live') setMode('live');
  requestAnimationFrame(frame);

  // Pixel ratio can change without a size change (moving between screens, zoom).
  window.addEventListener('resize', () => Object.values(S.ch).forEach(c => c.resize()));

  // Re-read chart colours if fonts load late, so canvas text uses the right face.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { F.charts.refreshColors(); S.dirty = true; });

  F.app = { state: S };
})();
