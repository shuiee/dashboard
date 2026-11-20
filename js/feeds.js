/*
 * feeds.js
 * Live readings for one pod. Every feed calls the same handlers:
 *   onStatus(state, message)   state: 'connecting' | 'online' | 'offline' | 'error'
 *   onMeta(meta)               { fruit, sensor, serial, loadT, startedAt }
 *   onHistory(readings)        recent readings, oldest first, once
 *   onReading(reading)         each new reading after that
 * A reading is { t: epoch ms, ppb, temp, rh }.
 *
 * supabase: reads the pods and readings tables the bridge writes to (supabase/schema.sql),
 *           then streams new rows as they are inserted.
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

  // Database row -> the meta object the dashboard uses
  function metaOf(row) {
    if (!row) return {};
    return { fruit: row.fruit, sensor: row.sensor, serial: row.serial,
      loadT: row.load_t == null ? null : Number(row.load_t),
      startedAt: row.started_at == null ? null : Number(row.started_at) };
  }

  async function supabaseFeed(cfg, podId, h) {
    h.onStatus('connecting', 'Connecting to the database');
    if (!(window.supabase && window.supabase.createClient)) await loadScript(cfg.cloud.sdk);
    const db = window.supabase.createClient(cfg.cloud.url, cfg.cloud.key,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

    const oldest = Date.now() - cfg.cloud.historyHours * 3600e3;
    // Ignore readings with impossible clocks (outside the history window or in the future)
    const ok = r => r && r.t >= oldest && r.t <= Date.now() + 60e3;
    let lastT = -Infinity;
    let ready = false;
    const early = [];
    const deliver = r => { if (ok(r) && r.t > lastT) { lastT = r.t; h.onReading(r); } };

    // Readings with t after `after`, oldest first, 1000 per request (the API's page limit)
    async function fetchSince(after) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from('readings').select('t,ppb,temp,rh')
          .eq('pod', podId).gt('t', after).order('t', { ascending: true }).range(from, from + 999);
        if (error) throw new Error(error.message);
        data.forEach(v => { const r = norm(v); if (ok(r)) out.push(r); });
        if (data.length < 1000) return out;
      }
    }

    // Subscribe before loading history, so nothing that arrives in between is missed
    let wasDown = false;
    const ch = db.channel('pod-' + podId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'readings', filter: 'pod=eq.' + podId },
        p => { const r = norm(p.new); if (!r) return; if (ready) deliver(r); else early.push(r); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pods', filter: 'id=eq.' + podId },
        p => { if (p.new && p.new.id) h.onMeta(metaOf(p.new)); })
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          h.onStatus('online', 'Connected');
          // Back from a dropped connection: fetch what was sent meanwhile
          if (wasDown && ready) {
            ready = false; // hold new rows until the gap is filled, so they stay in order
            fetchSince(lastT).then(list => list.forEach(deliver)).catch(() => {})
              .finally(() => { ready = true; early.splice(0).sort((x, y) => x.t - y.t).forEach(deliver); });
          }
          wasDown = false;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          wasDown = true;
          h.onStatus('offline', 'No connection to the database' + (err && err.message ? ' (' + err.message + ')' : ''));
        }
      });
    const goneOffline = () => h.onStatus('offline', 'This device is offline');
    window.addEventListener('offline', goneOffline);

    const meta = await db.from('pods').select('*').eq('id', podId).maybeSingle();
    if (meta.error) throw new Error(meta.error.message);
    h.onMeta(metaOf(meta.data));

    const list = await fetchSince(oldest - 1);
    lastT = list.length ? list[list.length - 1].t : -Infinity;
    h.onHistory(list);
    ready = true;
    early.splice(0).sort((a, b) => a.t - b.t).forEach(deliver);

    return { stop() { window.removeEventListener('offline', goneOffline); db.removeChannel(ch); } };
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
    // Viewer clocks are trusted (phones and laptops set the time automatically)
    clockOffset: 0,
    serverNow() { return Date.now() + F.feeds.clockOffset; },
    /** Picks the feed for this page: practice if asked for, Supabase if configured, otherwise none. */
    kind(cfg) {
      const p = new URLSearchParams(location.search);
      if (p.get('feed') === 'practice') return 'practice';
      return cfg.cloud.url && cfg.cloud.key ? 'supabase' : 'none';
    },
    start(cfg, podId, h) {
      const k = F.feeds.kind(cfg);
      if (k === 'practice') return Promise.resolve(practiceFeed(cfg, podId, h));
      if (k === 'supabase') return supabaseFeed(cfg, podId, h).catch(e => { h.onStatus('error', e.message); return { stop() {} }; });
      h.onStatus('setup', 'Live data is not set up yet: add the Supabase project URL and key to js/config.js (see SETUP.md)');
      return Promise.resolve({ stop() {} });
    },
    loadScript,
  };
})();
