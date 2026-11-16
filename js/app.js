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
  const COLS = F.rules.COLS;
  const $ = id => document.getElementById(id);

  const store = {
    get(k) { try { return localStorage.getItem('ffoe.' + k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem('ffoe.' + k, v); } catch (_) { /* private mode */ } },
  };

  const S = {
    mode: 'replay',
    playing: true,
    speed: cfg.replay.speed,
    simT: cfg.replay.startAtS,
    duration: cfg.run.durationS,
    runStartMs: Date.parse(cfg.run.start),
    sel: 0,
    range: 'all',
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
  function initLive() {
    if (S.live) return;
    const pc = cfg.pods[0];
    const series = new F.Series(cfg, cfg.sensor.livePollMs / 1000);
    S.live = {
      startMs: Date.now(),
      pod: { cfg: pc, label: 'Live DGS2', series, states: [], events: [], rateArr: [], live: true },
      prev: null, onset: {}, stale: false, autoBase: false, sysEvents: [],
      dgs: new F.live.DGS2(cfg, onLiveSample, onSerialStatus),
    };
  }
  const liveNow = () => (Date.now() - S.live.startMs) / 1000;

  function onLiveSample(s) {
    const L = S.live, P = L.pod, series = P.series;
    const t = liveNow();
    const i = series.push({ t, raw: s.raw, temp: s.temp, rh: s.rh, fan: 0 });
    $('serialState').textContent = 'DGS2 ' + (L.dgs.serial || '') + ': ' + fmt.num(s.raw, 0) + ' ppb at ' + fmt.num(s.temp, 2) + ' °C';
    if (!L.autoBase && series.loadT == null && t >= 60) {
      // Provisional baseline from the first minute until someone presses Mark load.
      series.setBaseline(0, 60, null);
      L.autoBase = true;
      rebuildLive();
      return;
    }
    const st = F.rules.evaluate(series, i, P.cfg, cfg, L.prev, null);
    F.rules.diffEvents(P.cfg, series, L.prev, st, P.events, L.onset, cfg);
    st.onset = Object.assign({}, L.onset);
    P.states.push(st);
    P.rateArr.push(st.rate30);
    L.prev = st;
    S.dirty = true;
  }

  function rebuildLive() {
    const L = S.live, P = L.pod;
    const tl = F.rules.buildTimeline(P.cfg, P.series, cfg);
    P.states = tl.states;
    P.events = tl.events;
    P.rateArr = tl.states.map(s => s.rate30);
    L.prev = tl.states[tl.states.length - 1] || null;
    L.onset = L.prev ? Object.assign({}, L.prev.onset) : {};
    S.evSig = null;
    S.dirty = true;
  }

  function onSerialStatus(state, msg) {
    $('serialState').textContent = msg;
    const btn = $('btnSerial');
    btn.querySelector('span').textContent = state === 'connected' ? 'Disconnect' : 'Connect DGS2';
    if (S.live && state === 'error') logSys('CAUT', msg);
    if (S.live && state === 'connected') logSys('INFO', 'DGS2 connected over Web Serial, read-only polling');
  }

  function logSys(sev, text) {
    if (!S.live) return;
    S.live.sysEvents.push({ t: liveNow(), pod: 'POD-1', sev, text });
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
    if (S.mode === 'live' && k !== 0) return { pc, offline: true, now: liveNow() };
    const P = S.mode === 'live' ? S.live.pod : S.pods[k];
    const t = now();
    const i = P.series.indexAt(t);
    let st = i >= 0 ? P.states[i] : null;
    if (st) {
      const ctx = {};
      if (k === 0) ctx.cam = camFlag();
      if (S.mode === 'live') ctx.stale = t - P.series.lastT > R.staleFactor * P.series.nominalDt;
      if (k === 0 || ctx.stale) st = F.rules.applyContext(Object.assign({}, st), ctx);
    }
    return { pc, P, i, st, now: t };
  }

  function xRange(t) {
    if (S.range === 'all') return S.mode === 'replay' ? [0, S.duration] : [0, Math.max(t, 600)];
    const W = Number(S.range);
    return [Math.max(0, t - W), Math.max(t, W)];
  }

  /* ================= DOM build ================= */
  function buildPods() {
    const wrap = $('pods');
    wrap.innerHTML = '';
    S.podEls = cfg.pods.map((pc, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pod';
      b.setAttribute('aria-pressed', String(k === S.sel));
      b.innerHTML =
        '<div class="pod-top"><span class="pod-id">' + pc.id + '</span><span class="pod-fruit">' + pc.fruit +
        '</span><span class="status" data-f="status"></span></div>' +
        '<div class="pod-sub"><b data-f="label"></b>, ' + pc.note + '</div>' +
        '<div class="pod-main"><span class="big" data-f="delta"></span>' +
        '<span class="kv"><span class="k">Rate</span><span data-f="rate"></span></span></div>' +
        '<canvas class="pod-spark" data-f="spark" aria-hidden="true"></canvas>' +
        '<div class="pod-foot">' +
        '<span class="kv"><span class="k">T</span><span data-f="temp"></span></span>' +
        '<span class="kv"><span class="k">RH</span><span data-f="rh"></span></span>' +
        '<span class="kv"><span class="k">Fan</span><span data-f="fan"></span></span>' +
        '<span class="kv"><span class="k">Pwr</span><span data-f="pwr"></span></span>' +
        '<span class="kv"><span class="k">Eat</span><span data-f="eat" class="eat"></span></span>' +
        '</div>';
      b.addEventListener('click', () => select(k));
      const f = {};
      b.querySelectorAll('[data-f]').forEach(e => { f[e.dataset.f] = e; });
      wrap.appendChild(b);
      return { b, f };
    });
  }

  function buildCW() {
    const g = $('cwGrid');
    g.innerHTML = '';
    S.cwEls = cfg.pods.map((pc, k) => {
      const row = document.createElement('div');
      row.className = 'cw-row';
      row.setAttribute('role', 'row');
      row.setAttribute('aria-selected', String(k === S.sel));
      row.innerHTML = '<span class="rl" role="rowheader">' + pc.id + '</span>' +
        COLS.map(c => '<span class="ann" role="cell" data-c="' + c + '" title="' + F.rules.COL_NAMES[c] + '">' + c + '</span>').join('');
      row.addEventListener('click', () => select(k));
      g.appendChild(row);
      const tiles = {};
      row.querySelectorAll('.ann').forEach(e => { tiles[e.dataset.c] = e; });
      return { row, tiles };
    });
  }

  const READOUTS = [
    ['base', 'Baseline'], ['delta', 'Rise, corrected'], ['tcorr', 'Temp correction'], ['rate30', 'Rate, 30 min'],
    ['accel', '15 min / hour before'], ['vent', 'Vent logic'], ['tag', 'Time tag'], ['data', 'Samples'],
  ];
  function buildReadouts() {
    const dl = $('readouts');
    dl.innerHTML = READOUTS.map(([k, label]) =>
      '<div class="ro"><dt>' + label + '</dt><dd id="ro_' + k + '">N/A</dd></div>').join('');
  }

  function buildCharts() {
    const onHover = t => { S.hoverT = t; S.dirty = true; };
    S.ch = {
      primary: new F.charts.StripChart($('cPrimary'), { onHover, includeZero: true, minSpan: 80, nowLabel: true, markerLabels: true, label: 'Ethylene rise above baseline, ppb' }),
      rate: new F.charts.StripChart($('cRate'), { onHover, includeZero: true, minSpan: 60, label: 'Ripening rate, ppb per hour' }),
      temp: new F.charts.StripChart($('cTemp'), { onHover, minSpan: 0.8, label: 'Sensor temperature, degrees C' }),
      rh: new F.charts.StripChart($('cRh'), { onHover, minSpan: 8, label: 'Humidity, percent' }),
      fan: new F.charts.StripChart($('cFan'), { onHover, kind: 'state', xAxis: true, label: 'Fan runs and vent advice' }),
    };
  }

  /* ================= render ================= */
  const unit = (v, u) => v + '<small>' + u + '</small>';

  function eatOrder(views) {
    const ranked = views
      .map((v, k) => ({ k, v }))
      .filter(o => o.v.st && o.v.st.loaded && Number.isFinite(o.v.st.rate30))
      .sort((a, b) => b.v.st.rate30 - a.v.st.rate30);
    const rank = {};
    ranked.forEach((o, n) => { rank[o.k] = n + 1; });
    return { rank, ranked };
  }

  function renderPods(views, rank) {
    const xrFull = S.mode === 'replay' ? [0, S.duration] : [0, Math.max(now(), 600)];
    views.forEach((v, k) => {
      const { b, f } = S.podEls[k];
      b.dataset.offline = v.offline ? '1' : '0';
      if (v.offline || !v.st) {
        f.status.textContent = v.offline ? 'No link' : 'No data';
        f.status.dataset.sev = 'offline';
        f.label.textContent = v.offline ? 'Live mode' : (v.P ? v.P.label : '');
        f.delta.innerHTML = unit('N/A', 'ppb rise');
        f.rate.textContent = 'N/A';
        f.temp.textContent = 'N/A'; f.rh.textContent = 'N/A'; f.fan.textContent = 'N/A'; f.pwr.textContent = 'N/A'; f.eat.textContent = '-';
        F.charts.spark(f.spark, null, null, -1, xrFull);
        return;
      }
      const st = v.st, pc = v.pc;
      f.status.textContent = st.status;
      f.status.dataset.sev = st.sev;
      f.label.textContent = v.P.label;
      f.delta.innerHTML = unit(st.loaded ? fmt.signed(st.delta) : fmt.signed(st.delta), 'ppb rise');
      f.rate.innerHTML = Number.isFinite(st.rate30) && st.loaded ? unit(fmt.signed(st.rate30), 'ppb/h') : 'N/A';
      f.temp.innerHTML = unit(fmt.num(st.temp, 1), '°C');
      f.rh.innerHTML = Number.isFinite(st.rh) ? unit(fmt.num(st.rh, 0), '%') : 'N/A';
      f.fan.textContent = !pc.fan ? 'None' : st.fan ? 'On' : 'Off';
      f.pwr.innerHTML = pc.power === 'usb' ? 'USB' : unit(fmt.num(st.pwrDays, 1), 'd est');
      f.eat.textContent = rank[k] ? String(rank[k]) : '-';
      F.charts.spark(f.spark, v.P.series.t, v.P.series.delta, v.i, xrFull, R.deltaCautionPpb);
    });
  }

  function renderCW(views) {
    let nC = 0, nW = 0, nA = 0;
    views.forEach((v, k) => {
      const { row, tiles } = S.cwEls[k];
      row.setAttribute('aria-selected', String(k === S.sel));
      COLS.forEach(c => {
        let s = 'na', isNew = false;
        if (!v.offline && v.st) {
          s = v.st.flags[c];
          if (c === 'CAM' && k !== 0) s = 'na';
          if (c === 'PWR' && v.pc.power === 'usb') s = 'off';
          const on = v.st.onset && v.st.onset[c];
          isNew = (s === 'caution' || s === 'warning') && on != null && on > S.ackT;
        }
        const el = tiles[c];
        if (el.dataset.s !== s) el.dataset.s = s;
        el.dataset.new = isNew ? '1' : '0';
        el.setAttribute('aria-label', F.rules.COL_NAMES[c] + ': ' + ({ off: 'off', na: 'not fitted', caution: 'caution', warning: 'warning', advisory: 'advisory' })[s]);
        if (s === 'caution') nC++; else if (s === 'warning') nW++; else if (s === 'advisory') nA++;
      });
    });
    $('cwSummary').textContent = nW + ' warn, ' + nC + ' caut, ' + nA + ' advs';
    return { nC, nW };
  }

  function renderMaster(events, lamps) {
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
      m.querySelector('span:last-child').textContent = lit === 'warning' ? 'Warning' : 'Caution';
      m.setAttribute('aria-label', lit ? 'Master ' + lit + ', press to acknowledge' : 'Master caution, no new alerts');
    }
  }

  function currentEvents() {
    if (S.mode === 'replay') {
      let lo = 0, hi = S.events.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (S.events[mid].t <= S.simT) lo = mid + 1; else hi = mid; }
      return S.events.slice(0, lo);
    }
    return S.live.pod.events.concat(S.live.sysEvents).sort((a, b) => a.t - b.t);
  }

  function renderEvents(list) {
    const sig = S.mode + ':' + list.length + ':' + S.runStartMs;
    if (sig === S.evSig) return;
    S.evSig = sig;
    const ol = $('evList');
    ol.textContent = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'ev-empty';
      li.textContent = S.mode === 'live'
        ? 'No events yet. Connect the DGS2, wait a minute for the baseline, then press Mark load when the produce goes in.'
        : 'No events before this point in the run.';
      ol.appendChild(li);
    }
    const frag = document.createDocumentFragment();
    for (let n = list.length - 1, c = 0; n >= 0 && c < 150; n--, c++) {
      const e = list[n];
      const li = document.createElement('li');
      li.className = 'ev';
      const tm = document.createElement('span'); tm.className = 'tm'; tm.textContent = fmt.met(e.t);
      const pd = document.createElement('span'); pd.className = 'pd'; pd.textContent = e.pod;
      const sv = document.createElement('span'); sv.className = 'sev sev-' + e.sev; sv.textContent = e.sev;
      const tx = document.createElement('span'); tx.className = 'tx';
      tx.append(pd, document.createTextNode(e.text));
      li.append(tm, sv, tx);
      frag.appendChild(li);
    }
    ol.appendChild(frag);
    $('evCount').textContent = list.length + (list.length === 1 ? ' entry' : ' entries');
  }

  function renderReadouts(v, hi) {
    const set = (k, h) => { const el = $('ro_' + k); if (el.innerHTML !== h) el.innerHTML = h; };
    if (v.offline || !v.P || hi < 0) {
      READOUTS.forEach(([k]) => set(k, 'N/A'));
      return;
    }
    const s = v.P.series, st = v.P.states[hi];
    const b = s.base;
    set('base', unit(fmt.num(b.raw, 1), 'ppb') + ' <small>at ' + fmt.num(b.temp, 2) + ' °C' + (b.provisional ? ', provisional' : '') + '</small>');
    set('delta', unit(fmt.signed(st.delta), 'ppb'));
    set('tcorr', unit(fmt.signed(st.tcorr), 'ppb'));
    set('rate30', st.loaded && Number.isFinite(st.rate30) ? unit(fmt.signed(st.rate30), 'ppb/h') : 'N/A');
    set('accel', (Number.isFinite(st.rate15) ? fmt.signed(st.rate15) : 'N/A') + ' / ' + (Number.isFinite(st.ratePrev) ? fmt.signed(st.ratePrev) : 'N/A') + '<small>ppb/h</small>');
    set('vent', st.fan ? 'Fan running' : st.vent.advised ? (v.pc.fan ? 'Vent next' : 'Advised, no fan') : (st.loaded ? 'Hold' : 'Waiting for load'));
    set('tag', fmt.met(st.t));
    set('data', unit(String(hi + 1), 'of ' + s.length) + ' <small>' + fmt.dur(s.nominalDt) + '</small>');
  }

  function clipIntervals(P, iEnd, t) {
    if (P.live) return F.rules.intervals(P.series, P.states, iEnd, P.cfg.fan);
    const clip = list => list.filter(([a]) => a <= t).map(([a, b]) => [a, Math.min(b, t)]);
    return { on: clip(P.iv.on), adv: clip(P.iv.adv) };
  }

  function drawCharts(v) {
    const ch = S.ch;
    if (v.offline || !v.P || v.P.series.length === 0) {
      const msg = v.offline ? 'No link to this pod in live mode' : 'Waiting for the first reading';
      const x = xRange(v.now);
      const empty = { x, now: v.now, t: [], iEnd: -1, series: [], empty: msg };
      Object.values(ch).forEach(c => { c.set(empty); c.draw(); });
      ['roPrimary', 'roRate', 'roTemp', 'roRh', 'roFan'].forEach(id => { $(id).innerHTML = ''; });
      return;
    }
    const P = v.P, s = P.series, t = v.now;
    const x = xRange(t);
    const iEnd = s.indexAt(t);
    const hi = S.hoverT != null ? s.indexAt(Math.min(S.hoverT, t)) : null;
    const iv = clipIntervals(P, iEnd, t);
    const markers = s.loadT != null ? [{ t: s.loadT, label: 'LOAD' }] : [];
    const common = { x, now: t, t: s.t, iEnd, hoverT: S.hoverT, hoverI: hi, markers };

    ch.primary.set(Object.assign({}, common, {
      series: [
        { y: s.rawDelta, color: 'data2', width: 1.25, dash: [4, 3] },
        { y: s.delta, color: 'data', width: 2, fill: true },
      ],
      shade: iv.on,
      thresholds: [
        { v: R.ventDeltaPpb, label: 'VENT ' + R.ventDeltaPpb, color: 'ink', include: true },
        { v: R.deltaCautionPpb, label: 'CAUTION ' + R.deltaCautionPpb, color: 'caution', include: true },
      ],
    }));
    ch.rate.set(Object.assign({}, common, {
      series: [{ y: P.rateArr, color: 'data', width: 2 }],
      shade: iv.on,
      thresholds: [{ v: R.rateCautionPpbH, label: 'CAUTION ' + R.rateCautionPpbH, color: 'caution', include: true }],
    }));
    ch.temp.set(Object.assign({}, common, {
      series: [{ y: s.temp, color: 'data', width: 2 }],
      thresholds: [{ v: s.base.temp, label: 'T REF ' + s.base.temp.toFixed(2), color: 'ink', include: true }],
    }));
    ch.rh.set(Object.assign({}, common, {
      series: [{ y: s.rh, color: 'data', width: 2 }],
      thresholds: [{ v: R.rhCautionPct, label: 'CAUTION ' + R.rhCautionPct, color: 'caution', include: true }],
    }));
    ch.fan.set(Object.assign({}, common, { intervals: iv }));
    Object.values(ch).forEach(c => c.draw());

    const k = hi != null && hi >= 0 ? hi : iEnd;
    if (k < 0) return;
    const st = P.states[k];
    const at = '<small> at </small>' + fmt.met(s.t[k]);
    $('roPrimary').innerHTML = unit(fmt.signed(s.delta[k]), ' corr') + '&nbsp; ' + unit(fmt.signed(s.rawDelta[k]), ' as read') + at;
    $('roRate').innerHTML = st.loaded && Number.isFinite(P.rateArr[k]) ? unit(fmt.signed(P.rateArr[k]), ' ppb/h') : 'N/A';
    $('roTemp').innerHTML = unit(fmt.num(s.temp[k], 2), ' °C');
    $('roRh').innerHTML = Number.isFinite(s.rh[k]) ? unit(fmt.num(s.rh[k], 1), ' %RH') : 'N/A';
    $('roFan').textContent = s.fan[k] ? 'Fan on' : st.vent.advised ? 'Vent advised' : (v.pc.fan ? 'Fan off' : 'No fan fitted');
  }

  function renderCam() {
    const c = S.camState;
    const img = $('camImg');
    const hasPhoto = !!c.photo;
    img.hidden = !hasPhoto;
    $('camEmpty').hidden = hasPhoto;
    if (hasPhoto && img.src !== c.photo) img.src = c.photo;
    if (!hasPhoto) {
      $('camMsg').textContent = c.msg || (S.mode === 'replay'
        ? 'No downlink. Experiment 3 ran without a camera. Connect the XIAO to see frames here.'
        : 'No downlink. Enter the IP from Serial Monitor and press Connect.');
    }
    let meta = 'No downlink';
    if (c.link === 'connecting') meta = 'Connecting';
    if (c.link === 'ok') meta = 'Frame ' + fmt.local(c.lastMs) + ', ' + c.w + 'x' + c.h + ', ' + c.ms + ' ms';
    if (c.link === 'lost') meta = 'Link lost';
    $('camMeta').textContent = meta;
    if (hasPhoto && c.msg) $('camMeta').textContent = meta + '. ' + c.msg;

    const box = $('camPreds');
    box.textContent = '';
    if (c.preds && c.link === 'ok') {
      c.preds.slice(0, 3).forEach(p => {
        const row = document.createElement('div'); row.className = 'pred';
        const n = document.createElement('span'); n.textContent = p.name;
        const v = document.createElement('span'); v.textContent = (p.p * 100).toFixed(0) + '%';
        const bar = document.createElement('div'); bar.className = 'bar';
        const fill = document.createElement('span'); fill.style.width = (p.p * 100).toFixed(1) + '%';
        bar.appendChild(fill);
        row.append(n, v, bar);
        box.appendChild(row);
      });
    }
    $('btnCam').textContent = cam.running ? 'Disconnect' : 'Connect';
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

  function renderClocks(t) {
    const ms = S.runStartMs + t * 1000;
    $('clkMet').textContent = fmt.met(t);
    $('clkGmt').textContent = fmt.gmt(ms);
    $('clkLocal').textContent = fmt.local(ms);
  }

  function renderHeader() {
    const pc = cfg.pods[S.sel];
    $('selTitle').textContent = pc.id + ' ' + pc.fruit;
    const label = S.mode === 'live' ? (S.sel === 0 ? 'Live DGS2' : 'Not connected') : S.pods[S.sel].label;
    $('selSource').textContent = label + ', ' + pc.note + (pc.fan ? ', fan fitted' : ', no fan');
    if (S.mode === 'replay') {
      $('sbSource').textContent = S.csv
        ? 'POD-1: ' + S.csv.name + ' (' + S.csv.rows + ' rows). POD-2 to POD-4 simulated'
        : 'POD-1: EXP-03 reconstructed from the published summary, not the raw log. POD-2 to POD-4 simulated';
    } else {
      $('sbSource').textContent = 'POD-1: live DGS2 over Web Serial. POD-2 to POD-4 not connected';
    }
    $('sbCorr').textContent = 'Temp correction ' + cfg.sensor.tempSlopePpbPerC + ' ppb/°C';
  }

  function updateUI() {
    const views = cfg.pods.map((_, k) => view(k));
    const v = views[S.sel];
    const { rank, ranked } = eatOrder(views);
    $('eatOrder').textContent = ranked.length
      ? 'Eat first: ' + ranked.map(o => cfg.pods[o.k].fruit).join(', ')
      : 'Eat first: waiting for rates';

    if (S.mode === 'live') {
      const L = S.live;
      const stale = L.pod.series.length > 0 && liveNow() - L.pod.series.lastT > R.staleFactor * L.pod.series.nominalDt;
      if (stale !== L.stale) {
        L.stale = stale;
        logSys(stale ? 'CAUT' : 'INFO', stale ? 'No new sensor data' : 'Sensor data resumed');
      }
    }

    renderPods(views, rank);
    const lamps = renderCW(views);
    const events = currentEvents();
    renderEvents(events);
    renderMaster(events, lamps);
    const hi = v.P ? (S.hoverT != null ? v.P.series.indexAt(Math.min(S.hoverT, v.now)) : v.i) : -1;
    renderReadouts(v, hi == null ? -1 : hi);
    renderClocks(now());
    drawCharts(v);
    if (S.mode === 'replay' && !S.scrubbing) $('scrub').value = String(Math.round(S.simT));
  }

  /* ================= interaction ================= */
  function select(k) {
    S.sel = k;
    S.podEls.forEach((e, n) => e.b.setAttribute('aria-pressed', String(n === k)));
    renderHeader();
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
    S.ackT = now();
    S.ackWall = Date.now();
    S.evSig = null;
    if (m === 'live') S.runStartMs = S.live.startMs;
    else S.runStartMs = S.csv && S.csv.startMs ? S.csv.startMs : Date.parse(cfg.run.start);
    renderHeader();
    renderCam();
    S.dirty = true;
  }

  function notice(text) {
    const el = $('sbNote');
    el.textContent = text;
    clearTimeout(notice.t);
    notice.t = setTimeout(() => { el.textContent = 'Thresholds are placeholders. Tune them in js/config.js'; }, 9000);
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
      if (S.sel !== 0) { notice('Only POD-1 has a live sensor'); return; }
      const P = S.live.pod, t = liveNow();
      if (!P.series.setBaseline(t - 120, t - 2, t)) { notice('Need a few readings before marking the load'); return; }
      rebuildLive();
      logSys('INFO', 'Load marked by operator');
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

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const b = $('btnTheme');
    b.innerHTML = theme === 'night' ? '<i class="ph ph-sun" aria-hidden="true"></i>' : '<i class="ph ph-moon" aria-hidden="true"></i>';
    b.setAttribute('aria-label', theme === 'night' ? 'Switch to day display' : 'Switch to night display');
    F.charts.refreshColors();
    S.dirty = true;
  }

  const cam = new F.live.Camera(cfg, st => {
    S.camState = Object.assign({}, st);
    camEvents(st);
    renderCam();
    S.dirty = true;
  });

  function bind() {
    $('modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
    $('speedSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      S.speed = Number(b.dataset.speed); setPressed('speedSeg', 'speed', S.speed);
    });
    $('rangeSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      S.range = b.dataset.range; setPressed('rangeSeg', 'range', S.range); S.dirty = true;
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
    $('btnTheme').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
      store.set('theme', next); applyTheme(next);
    });
    $('btnSerial').addEventListener('click', async () => {
      const d = S.live.dgs;
      try {
        if (d.connected) await d.disconnect();
        else await d.connect();
      } catch (e) {
        if (e && e.name === 'NotFoundError') return; // user closed the port picker
        onSerialStatus('error', e.message || String(e));
      }
    });

    $('camIp').value = store.get('camIp') || cfg.camera.ip;
    $('camModel').value = store.get('camModel') || cfg.camera.modelUrl;
    $('camEvery').value = String(cfg.camera.intervalS);
    $('camForm').addEventListener('submit', e => {
      e.preventDefault();
      if (cam.running) { cam.stop(); renderCam(); return; }
      const ip = $('camIp').value.trim();
      if (!ip) { $('camMsg').textContent = 'Enter the camera IP from Serial Monitor first.'; return; }
      store.set('camIp', ip);
      store.set('camModel', $('camModel').value.trim());
      cam.start({ ip, intervalS: Number($('camEvery').value), classify: $('camClassify').checked, modelUrl: $('camModel').value.trim() });
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
  applyTheme(store.get('theme') === 'day' ? 'day' : 'night');
  initReplay(null);
  buildPods();
  buildCW();
  buildReadouts();
  buildCharts();
  bind();
  setPressed('speedSeg', 'speed', S.speed);
  syncPlay();
  renderHeader();
  renderCam();
  requestAnimationFrame(frame);

  // Pixel ratio can change without a size change (moving between screens, zoom).
  window.addEventListener('resize', () => Object.values(S.ch).forEach(c => c.resize()));

  // Re-read chart colours if fonts load late, so canvas text uses the right face.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { F.charts.refreshColors(); S.dirty = true; });

  F.app = { state: S };
})();
