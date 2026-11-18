/*
 * feeds.js
 * Live readings for one pod. Every feed calls the same handlers:
 *   onStatus(state, message)   state: 'connecting' | 'online' | 'offline' | 'error'
 *   onMeta(meta)               { fruit, sensor, serial, loadT, startedAt }
 *   onHistory(readings)        recent readings, oldest first, once
 *   onReading(reading)         each new reading after that
 * A reading is { t: epoch ms, ppb, temp, rh }.
 *
 * firebase: reads pods/<POD-ID>/ from the Realtime Database the bridge writes to.
 * practice: a made-up banana on this computer, for trying live mode without the cloud
 *           (open the page with ?feed=practice). It is labelled as practice data on screen.
 */
(function () {
  'use strict';
  const F = window.FFOE;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load ' + src + '. Is this computer online?'));
      document.head.appendChild(s);
    });
  }

  function norm(v) {
    if (!v || typeof v !== 'object') return null;
    const r = { t: Number(v.t), ppb: Number(v.ppb), temp: Number(v.temp), rh: v.rh == null ? NaN : Number(v.rh) };
    return Number.isFinite(r.t) && Number.isFinite(r.ppb) && Number.isFinite(r.temp) ? r : null;
  }

  async function firebaseFeed(cfg, podId, h) {
    h.onStatus('connecting', 'Connecting to the database');
    await loadScript(cfg.cloud.sdkApp);
    await loadScript(cfg.cloud.sdkDatabase);
    /* global firebase */
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp({ databaseURL: cfg.cloud.databaseURL });
    const db = app.database();
    const base = db.ref('pods/' + podId);
    const readings = base.child('readings');
    const subs = [];

    // Viewer clock vs database clock, so "seconds since last reading" is right on any device
    const offRef = db.ref('.info/serverTimeOffset');
    offRef.on('value', s => { F.feeds.clockOffset = s.val() || 0; });
    subs.push(() => offRef.off());

    const conRef = db.ref('.info/connected');
    conRef.on('value', s => h.onStatus(s.val() ? 'online' : 'offline', s.val() ? 'Connected' : 'No connection to the database'));
    subs.push(() => conRef.off());

    const metaRef = base.child('meta');
    metaRef.on('value', s => h.onMeta(s.val() || {}), e => h.onStatus('error', e.message));
    subs.push(() => metaRef.off());

    const n = Math.ceil(cfg.cloud.historyHours * 3600 / cfg.cloud.pushS);
    const snap = await readings.orderByKey().limitToLast(n).once('value');
    const list = [];
    let lastKey = null;
    // Ignore readings with impossible clocks (outside the history window or in the future)
    const oldest = F.feeds.serverNow() - cfg.cloud.historyHours * 3600e3;
    const ok = r => r && r.t >= oldest && r.t <= F.feeds.serverNow() + 60e3;
    snap.forEach(c => { const r = norm(c.val()); if (ok(r)) list.push(r); lastKey = c.key; });
    h.onHistory(list);

    const q = lastKey ? readings.orderByKey().startAfter(lastKey) : readings.orderByKey();
    q.on('child_added', c => { const r = norm(c.val()); if (ok(r)) h.onReading(r); }, e => h.onStatus('error', e.message));
    subs.push(() => q.off());

    return { stop() { subs.forEach(f => f()); } };
  }

  function practiceFeed(cfg, podId, h) {
    const dt = cfg.cloud.pushS * 1000;
    const start = Date.now() - 40 * 60 * 1000;
    const loadT = start + 8 * 60 * 1000;
    const read = t => {
      const m = (t - loadT) / 60000;
      const temp = 23 + 0.3 * Math.sin(t / 900000);
      const rise = m < 0 ? 0 : 900 * (1 - Math.exp(-m / 140));
      return { t, ppb: -150 + rise + 120 * (temp - 23) + (Math.random() - 0.5) * 2, temp, rh: m < 0 ? 42 : 80 };
    };
    h.onStatus('online', 'Practice data on this computer');
    h.onMeta({ fruit: 'banana', sensor: 'PRACTICE', loadT });
    const list = [];
    for (let t = start; t <= Date.now(); t += dt) list.push(read(t));
    h.onHistory(list);
    let next = list[list.length - 1].t + dt;
    const timer = setInterval(() => { while (next <= Date.now()) { h.onReading(read(next)); next += dt; } }, 1000);
    return { stop() { clearInterval(timer); } };
  }

  F.feeds = {
    clockOffset: 0,
    serverNow() { return Date.now() + F.feeds.clockOffset; },
    /** Picks the feed for this page: practice if asked for, Firebase if configured, otherwise none. */
    kind(cfg) {
      const p = new URLSearchParams(location.search);
      if (p.get('feed') === 'practice') return 'practice';
      // ?db=<url> points the page at another database, e.g. the local emulator when testing
      if (p.get('db')) cfg.cloud.databaseURL = p.get('db');
      return cfg.cloud.databaseURL ? 'firebase' : 'none';
    },
    start(cfg, podId, h) {
      const k = F.feeds.kind(cfg);
      if (k === 'practice') return Promise.resolve(practiceFeed(cfg, podId, h));
      if (k === 'firebase') return firebaseFeed(cfg, podId, h).catch(e => { h.onStatus('error', e.message); return { stop() {} }; });
      h.onStatus('setup', 'Live data is not set up yet: add the Firebase database URL to js/config.js (see SETUP.md)');
      return Promise.resolve({ stop() {} });
    },
    loadScript,
  };
})();
