/*
 * data.js
 * 1. A reconstruction of Experiment 3, phase D (one banana, closed bowl, four hours).
 *    Built from the values published in the team's experiment write-up, NOT from the raw
 *    CSV. Drop the real CSV onto the console to replace it.
 * 2. Simulated pods (apple, tomato, avocado) that run the same fan rules as the console.
 * 3. A CSV importer for the logging script output.
 */
(function () {
  'use strict';
  const F = window.FFOE;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0;
    while (!u) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  /** Monotone cubic interpolation (Fritsch-Carlson) through [x, y] knots. */
  function pchip(knots) {
    const xs = knots.map(k => k[0]), ys = knots.map(k => k[1]), n = xs.length;
    const h = [], d = [];
    for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
    const m = new Array(n);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    return function (x) {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let i = 0;
      while (x > xs[i + 1]) i++;
      const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] +
        (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
    };
  }

  /*
   * Experiment 3, phase D. Knots are minutes since the run started (7:42 PM).
   * Rise above baseline after temperature correction: about 297 ppb after 1 h, 545 after 2,
   * 711 after 3 and 814 at the end. Temperature swung 1.7 C. Humidity jumped about 8 %RH at
   * the lid lift and climbed to about 85 %RH. Banana in at 7:46:34 PM (274 s).
   */
  const EXP03 = {
    loadT: 274,
    baseRaw: -146.7,
    baseTemp: 23.05,
    sensorSlope: 120, // how the simulated sensor responds; the console's correction slope is in config
    rise: [[4.57, 0], [20, 78], [60, 297], [120, 545], [180, 711], [240, 814]],
    temp: [[0, 23.0], [4, 23.05], [8, 23.25], [14, 23.2], [18, 23.05], [27, 23.35], [33, 23.25],
      [43, 22.75], [52, 23.1], [58, 23.1], [66, 22.8], [75, 22.6], [90, 23.5], [95, 23.5],
      [110, 22.9], [124, 22.45], [133, 22.8], [140, 22.75], [147, 22.6], [160, 23.6], [170, 24.05],
      [178, 23.9], [195, 23.5], [205, 23.25], [215, 23.75], [228, 23.85], [236, 23.75], [240, 23.6]],
    rh: [[0, 41], [4.5, 41.5], [4.62, 49], [10, 56], [20, 65], [30, 71], [50, 79], [60, 78.5],
      [80, 82], [95, 80.5], [125, 84.5], [150, 85], [170, 81.5], [210, 83.5], [240, 83]],
  };

  function buildExp03(cfg) {
    const S = new F.Series(cfg);
    const rng = mulberry32(803);
    const rise = pchip(EXP03.rise), T = pchip(EXP03.temp), RH = pchip(EXP03.rh);
    const dt = cfg.run.sampleS, n = Math.floor(cfg.run.durationS / dt);
    for (let k = 0; k <= n; k++) {
      const t = k * dt, m = t / 60;
      const temp = T(m) + gauss(rng) * 0.01;
      const r = t < EXP03.loadT ? 0 : rise(m);
      const raw = EXP03.baseRaw + r + EXP03.sensorSlope * (temp - EXP03.baseTemp) + gauss(rng) * 1.0;
      S.push({ t, raw, temp, rh: RH(m) + gauss(rng) * 0.15, fan: 0 });
    }
    // 4.3 minutes of recorded baseline before the banana
    S.setBaseline(EXP03.loadT - 258, EXP03.loadT - 4, EXP03.loadT);
    return S;
  }

  /*
   * Simulated pods. Emission is ppb per hour inside a sealed pod as a function of hours
   * since loading. The fan halves the pod's ethylene in about 90 s (the lid-lift test
   * halved it in about two minutes).
   */
  const PROFILES = {
    apple: { emit: h => 110 + 12 * h, rhMax: 74, baseRaw: -96, tOff: 0.15, seed: 11 },
    tomato: { emit: h => 25 + 22 * h, rhMax: 80, baseRaw: -182, tOff: -0.1, seed: 23 },
    avocado: { emit: h => 25 + 560 / (1 + Math.exp(-(h - 2.4) * 2.0)), rhMax: 71, baseRaw: -214, tOff: 0.05, seed: 37 },
  };

  function cabinTemp(t, off, ph) {
    return 22.85 + off + 0.32 * Math.sin(2 * Math.PI * t / 5400 + ph) + 0.12 * Math.sin(2 * Math.PI * t / 1250 + ph * 1.7);
  }

  function simulatePod(cfg, pod, durationS) {
    const P = PROFILES[pod.profile];
    const R = cfg.rules;
    const rng = mulberry32(P.seed);
    const S = new F.Series(cfg);
    const dt = cfg.run.sampleS, n = Math.floor(durationS / dt);
    const kLeak = 1 / (8 * 3600), kFan = Math.LN2 / 90;
    let C = 0, rh = 42, fanUntil = -1, cooldownUntil = -1, based = false;

    for (let k = 0; k <= n; k++) {
      const t = k * dt;
      const fan = t < fanUntil;
      if (t >= pod.loadT) {
        const E = P.emit((t - pod.loadT) / 3600) / 3600;
        C += (E - (kLeak + (fan ? kFan : 0)) * C) * dt;
      }
      const temp = cabinTemp(t, P.tOff, P.seed) + gauss(rng) * 0.01;
      const rhTarget = fan ? 46 : (t >= pod.loadT ? P.rhMax : 42);
      rh += (rhTarget - rh) * (dt / (fan ? 240 : 1500));
      const raw = P.baseRaw + C + 120 * (temp - 22.85) + gauss(rng) * 1.0;
      const i = S.push({ t, raw, temp, rh: rh + gauss(rng) * 0.15, fan: fan ? 1 : 0 });

      if (!based && t >= pod.loadT) {
        S.setBaseline(pod.loadT - 250, pod.loadT - 5, pod.loadT);
        based = true;
      }
      // Same rule the console shows: the pod decides, then the fan runs on the next samples.
      if (based && pod.fan && !fan && t >= cooldownUntil) {
        const v = F.rules.ventDecision(S, i, pod, cfg);
        if (v.advised) {
          fanUntil = t + R.fanRunS + 0.001;
          cooldownUntil = fanUntil + R.fanCooldownS;
        }
      }
    }
    return S;
  }

  /* ---------- CSV import ---------- */
  function findCol(headers, re, exclude) {
    return headers.findIndex((h, i) => re.test(h) && (!exclude || !exclude.includes(i)));
  }

  function parseTime(v) {
    const num = Number(v);
    if (v !== '' && Number.isFinite(num)) {
      if (num > 1e12) return { ms: num };
      if (num > 1e9) return { ms: num * 1000 };
      return { s: num };
    }
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? { ms } : null;
  }

  /**
   * Accepts a CSV with a header row. Recognised columns (case-insensitive):
   * time / timestamp / iso / epoch / elapsed, ppb / ethylene / c2h4, temp, rh / humidity, fan.
   */
  function parseCsv(text, cfg) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    if (lines.length < 3) throw new Error('The file has fewer than three rows.');
    const sep = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
    const headers = lines[0].split(sep).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    const cT = findCol(headers, /time|date|iso|epoch|elapsed|^t_?s$|^sec/);
    const cP = findCol(headers, /ppb|ethylene|c2h4|gas/);
    const cTemp = findCol(headers, /temp|deg_?c|^t$|celsius/, [cT]);
    const cRh = findCol(headers, /^rh|humid|%rh/);
    const cFan = findCol(headers, /fan/);
    if (cP < 0 || cTemp < 0) {
      throw new Error('Could not find an ethylene (ppb) column and a temperature column. Headers found: ' + headers.join(', '));
    }
    const rows = [];
    let t0ms = null, t0s = null;
    for (let r = 1; r < lines.length; r++) {
      const p = lines[r].split(sep).map(s => s.trim().replace(/^"|"$/g, ''));
      const ppb = parseFloat(p[cP]);
      let temp = parseFloat(p[cTemp]);
      let rh = cRh >= 0 ? parseFloat(p[cRh]) : NaN;
      if (!Number.isFinite(ppb) || !Number.isFinite(temp)) continue;
      if (Math.abs(temp) > 100) temp /= 100;
      if (rh > 100) rh /= 100;
      let t;
      if (cT >= 0) {
        const pt = parseTime(p[cT]);
        if (!pt) continue;
        if (pt.ms != null) { if (t0ms == null) t0ms = pt.ms; t = (pt.ms - t0ms) / 1000; }
        else { if (t0s == null) t0s = pt.s; t = pt.s - t0s; }
      } else {
        t = rows.length; // assume one reading a second
      }
      rows.push({ t, raw: ppb, temp, rh, fan: cFan >= 0 ? (Number(p[cFan]) ? 1 : 0) : 0 });
    }
    if (rows.length < 3) throw new Error('No usable rows: check the ppb and temperature columns.');
    rows.sort((a, b) => a.t - b.t);

    // Average into replay bins so long logs stay fast.
    const bin = cfg.run.sampleS;
    const S = new F.Series(cfg);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      S.push({ t: cur.t, raw: cur.raw / cur.n, temp: cur.temp / cur.n, rh: cur.nrh ? cur.rh / cur.nrh : NaN, fan: cur.fan });
    };
    for (const r of rows) {
      const bt = Math.floor(r.t / bin) * bin;
      if (!cur || cur.t !== bt) { flush(); cur = { t: bt, raw: 0, temp: 0, rh: 0, n: 0, nrh: 0, fan: 0 }; }
      cur.raw += r.raw; cur.temp += r.temp; cur.n++;
      if (Number.isFinite(r.rh)) { cur.rh += r.rh; cur.nrh++; }
      cur.fan = cur.fan || r.fan;
    }
    flush();
    // Until someone marks the load, treat the first two minutes as the baseline.
    const bEnd = Math.min(120, S.lastT / 4);
    S.setBaseline(0, bEnd, bEnd);
    return {
      series: S,
      startMs: t0ms,
      durationS: S.lastT,
      rows: rows.length,
      columns: { time: headers[cT], ppb: headers[cP], temp: headers[cTemp], rh: headers[cRh], fan: headers[cFan] },
    };
  }

  F.data = { buildExp03, simulatePod, parseCsv, EXP03 };
})();
