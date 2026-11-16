/*
 * model.js
 * Series: one pod's readings, with the temperature correction applied.
 * rules:  the explainable rule set that turns readings into cautions,
 *         fan decisions and log entries. No machine learning here.
 */
(function () {
  'use strict';
  const F = (window.FFOE = window.FFOE || {});

  /* ---------- formatting helpers shared by every module ---------- */
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  F.fmt = {
    signed(v, d = 0) {
      if (!Number.isFinite(v)) return 'N/A';
      const s = Math.abs(v).toFixed(d);
      return (v < 0 && Number(s) !== 0 ? '-' : '+') + s;
    },
    num(v, d = 0) { return Number.isFinite(v) ? v.toFixed(d) : 'N/A'; },
    met(s) {
      if (!Number.isFinite(s)) return 'T+--:--:--';
      const neg = s < 0; s = Math.abs(Math.floor(s));
      return (neg ? 'T-' : 'T+') + pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
    },
    metShort(s) {
      const neg = s < 0; s = Math.abs(Math.round(s));
      return (neg ? 'T-' : 'T+') + Math.floor(s / 3600) + ':' + pad(Math.floor(s % 3600 / 60));
    },
    gmt(ms) {
      const d = new Date(ms);
      const start = Date.UTC(d.getUTCFullYear(), 0, 0);
      const doy = Math.floor((ms - start) / 86400000);
      return pad(doy, 3) + '/' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    },
    local(ms) {
      const d = new Date(ms);
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    },
    dur(s) {
      s = Math.round(s);
      if (s < 120) return s + ' s';
      if (s < 7200) return Math.round(s / 60) + ' min';
      return (s / 3600).toFixed(1) + ' h';
    },
  };

  /* ---------- Series ---------- */
  class Series {
    constructor(cfg, nominalDt) {
      this.cfg = cfg;
      this.nominalDt = nominalDt || cfg.run.sampleS;
      this.t = []; this.raw = []; this.temp = []; this.rh = []; this.fan = [];
      this.corr = []; this.delta = []; this.rawDelta = [];
      // Prefix sums of the rise, skipping fan runs, so a rate over any window is O(1).
      this.D = []; this.M = [];
      this.base = null;
      this.loadT = null;
      this._lastFanT = -Infinity;
    }

    get length() { return this.t.length; }
    get lastT() { return this.t.length ? this.t[this.t.length - 1] : -Infinity; }

    push(s) {
      const i = this.t.length;
      this.t.push(s.t);
      this.raw.push(s.raw);
      this.temp.push(s.temp);
      this.rh.push(Number.isFinite(s.rh) ? s.rh : NaN);
      this.fan.push(s.fan ? 1 : 0);
      if (!this.base) this.base = { raw: s.raw, temp: s.temp, t0: s.t, t1: s.t, provisional: true, n: 1 };
      this._derive(i);
      return i;
    }

    _derive(i) {
      const slope = this.cfg.sensor.tempSlopePpbPerC;
      const b = this.base;
      // Temperature correction: remove what the sensor reads just from being warmer or cooler
      // than it was during the baseline.
      const corr = this.raw[i] - slope * (this.temp[i] - b.temp);
      this.corr[i] = corr;
      this.delta[i] = corr - b.raw;
      this.rawDelta[i] = this.raw[i] - b.raw;
      if (this.fan[i]) this._lastFanT = this.t[i];
      if (i === 0) { this.D[0] = 0; this.M[0] = 0; return; }
      const dt = this.t[i] - this.t[i - 1];
      const ok = !this.fan[i] && !this.fan[i - 1] &&
        this.t[i] - this._lastFanT > this.cfg.rules.postFanMaskS &&
        dt <= this.nominalDt * 5;
      this.D[i] = this.D[i - 1] + (ok ? this.delta[i] - this.delta[i - 1] : 0);
      this.M[i] = this.M[i - 1] + (ok ? dt : 0);
    }

    recompute() {
      this._lastFanT = -Infinity;
      for (let i = 0; i < this.t.length; i++) this._derive(i);
    }

    /** Baseline = mean of the readings in [t0, t1]; loadT = when produce went in. */
    setBaseline(t0, t1, loadT) {
      const a = Math.max(0, this.indexAtOrAfter(t0));
      const z = this.indexAt(t1);
      if (z < a) return false;
      let sr = 0, st = 0;
      for (let i = a; i <= z; i++) { sr += this.raw[i]; st += this.temp[i]; }
      const n = z - a + 1;
      this.base = { raw: sr / n, temp: st / n, t0: this.t[a], t1: this.t[z], provisional: loadT == null, n };
      this.loadT = loadT;
      this.recompute();
      return true;
    }

    /** Last index with t <= time, or -1. */
    indexAt(time) {
      const t = this.t;
      if (!t.length || time < t[0]) return -1;
      let lo = 0, hi = t.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (t[mid] <= time) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    /** First index with t >= time, or length. */
    indexAtOrAfter(time) {
      const t = this.t;
      let lo = 0, hi = t.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] < time) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    /** Ripening rate in ppb/h over the window ending at index i, fan runs excluded. */
    rate(i, windowS) {
      if (i <= 0) return NaN;
      const s = Math.max(0, this.indexAt(this.t[i] - windowS));
      const m = this.M[i] - this.M[s];
      if (m < windowS * 0.35) return NaN;
      return (this.D[i] - this.D[s]) / m * 3600;
    }
  }
  F.Series = Series;

  /* ---------- Rules ---------- */
  const COLS = ['C2H4', 'RATE', 'VENT', 'TEMP', 'RH', 'DATA', 'CAM', 'PWR'];
  const COL_NAMES = {
    C2H4: 'Ethylene rise', RATE: 'Ripening rate', VENT: 'Vent / fan', TEMP: 'Temperature',
    RH: 'Humidity', DATA: 'Sensor data', CAM: 'Camera', PWR: 'Power',
  };

  function ventDecision(series, i, pod, cfg) {
    const R = cfg.rules;
    if (i < 0 || series.loadT == null) return { advised: false };
    const t = series.t[i];
    if (t - series.loadT < R.minHistoryS) return { advised: false };
    const d = series.delta[i];
    if (d >= R.ventDeltaPpb) {
      return { advised: true, reason: 'rise ' + F.fmt.signed(d) + ' ppb over vent limit ' + R.ventDeltaPpb };
    }
    const r15 = series.rate(i, R.accelShortS);
    const j = series.indexAt(t - R.accelShortS);
    const rPrev = j > 0 ? series.rate(j, R.accelLongS) : NaN;
    if (r15 >= R.accelFloorPpbH && rPrev > 0 && r15 >= R.accelRatio * rPrev) {
      return { advised: true, reason: 'rate ' + F.fmt.signed(r15) + ' ppb/h, ' + (r15 / rPrev).toFixed(1) + 'x the hour before' };
    }
    return { advised: false };
  }

  function evaluate(series, i, pod, cfg, prev, ctx) {
    const R = cfg.rules;
    const t = series.t[i];
    const loaded = series.loadT != null && t >= series.loadT;
    const delta = series.delta[i];
    const raw = series.raw[i];
    const temp = series.temp[i];
    const rh = series.rh[i];
    const fan = series.fan[i];
    const rate30 = series.rate(i, R.rateWindowS);
    const rate15 = series.rate(i, R.accelShortS);
    const j = series.indexAt(t - R.accelShortS);
    const ratePrev = j > 0 ? series.rate(j, R.accelLongS) : NaN;
    // Eat readiness: the higher of the rate step and the rise step, latched so it never goes back.
    let stage = null;
    if (loaded) {
      const E = cfg.eat;
      const rs = Number.isFinite(rate30) && t - series.loadT >= R.rateMinS
        ? E.rateSteps.filter(v => rate30 >= v).length : 0;
      const ds = E.riseSteps.filter(v => delta >= v).length;
      stage = Math.max(rs, ds);
      if (prev && prev.loaded && prev.stage != null) stage = Math.max(stage, prev.stage);
    }
    // Venting only slows fruit that has not ripened yet (NIAB). At "Eat now" the answer is to eat it.
    const vent = stage === 3 ? { advised: false, held: true } : ventDecision(series, i, pod, cfg);
    const pf = prev ? prev.flags : {};
    const hyst = (cur, val, thr) =>
      (val >= thr || (cur === 'caution' && val >= thr * R.hysteresis)) ? 'caution' : 'off';

    const flags = {};
    flags.C2H4 = loaded ? hyst(pf.C2H4, delta, R.deltaCautionPpb) : 'off';
    flags.RATE = loaded && Number.isFinite(rate30) && t - series.loadT >= R.rateMinS
      ? hyst(pf.RATE, rate30, R.rateCautionPpbH) : 'off';
    flags.VENT = (fan || vent.advised) ? 'advisory' : 'off';
    flags.TEMP = (temp < R.tempWarnLowC || temp > R.tempWarnHighC) ? 'warning'
      : (temp < R.tempMinC || temp > R.tempMaxC) ? 'caution' : 'off';
    flags.RH = Number.isFinite(rh) ? hyst(pf.RH, rh, R.rhCautionPct) : 'na';
    const fault = !Number.isFinite(raw) || raw < R.faultLowPpb || raw > R.faultHighPpb;
    flags.DATA = fault ? 'warning' : 'off';
    flags.CAM = 'na';

    let pwrDays = null;
    if (pod.power === 'battery') {
      pwrDays = cfg.power.estimatedDays - (pod.batteryUsedDays || 0) - t / 86400;
      flags.PWR = pwrDays < R.pwrCautionDays ? 'caution' : 'off';
    } else {
      flags.PWR = 'off';
    }

    const st = {
      i, t, loaded, delta, rawDelta: series.rawDelta[i], raw, corr: series.corr[i],
      tcorr: series.corr[i] - raw, temp, rh, fan, rate30, rate15, ratePrev, vent, flags, pwrDays, stage,
    };
    if (ctx) applyContext(st, ctx);
    else finishStatus(st);
    return st;
  }

  /** Runtime conditions that are not in the recorded data: staleness and the camera. */
  function applyContext(st, ctx) {
    st.flags = Object.assign({}, st.flags);
    if (ctx.stale && st.flags.DATA !== 'warning') st.flags.DATA = 'caution';
    if (ctx.cam) st.flags.CAM = ctx.cam;
    finishStatus(st, ctx);
    return st;
  }

  function finishStatus(st, ctx) {
    const f = st.flags;
    let status = st.loaded ? 'Nominal' : 'Baseline', sev = st.loaded ? 'nominal' : 'idle';
    if (f.VENT === 'advisory') { status = st.fan ? 'Venting' : 'Vent advised'; sev = 'advisory'; }
    if (f.C2H4 === 'caution') { status = 'Ethylene high'; sev = 'caution'; }
    if (f.RATE === 'caution') { status = 'Ripening fast'; sev = 'caution'; }
    if (f.RH === 'caution') { status = 'Humidity high'; sev = 'caution'; }
    if (f.TEMP === 'caution') { status = 'Temp limit'; sev = 'caution'; }
    if (f.PWR === 'caution') { status = 'Battery low'; sev = 'caution'; }
    if (f.DATA === 'caution') { status = 'No data'; sev = 'caution'; }
    if (f.TEMP === 'warning') { status = 'Temp out of range'; sev = 'warning'; }
    if (f.CAM === 'warning') { status = 'Spoilage seen'; sev = 'warning'; }
    if (f.DATA === 'warning') { status = 'Sensor fault'; sev = 'warning'; }
    st.status = status;
    st.sev = sev;
  }

  const FLAG_TEXT = {
    C2H4: (st, R) => ['Ethylene rise ' + F.fmt.signed(st.delta) + ' ppb, limit ' + R.deltaCautionPpb,
      'Ethylene rise back under limit (' + F.fmt.signed(st.delta) + ' ppb)'],
    RATE: (st, R) => ['Ripening rate ' + F.fmt.signed(st.rate30) + ' ppb/h, limit ' + R.rateCautionPpbH,
      'Ripening rate nominal (' + F.fmt.signed(st.rate30) + ' ppb/h)'],
    TEMP: (st) => ['Sensor temperature ' + F.fmt.num(st.temp, 1) + ' C outside cabin range',
      'Sensor temperature back in range (' + F.fmt.num(st.temp, 1) + ' C)'],
    RH: (st, R) => ['Humidity ' + F.fmt.num(st.rh, 0) + ' %RH, limit ' + R.rhCautionPct,
      'Humidity back under limit (' + F.fmt.num(st.rh, 0) + ' %RH)'],
    DATA: (st) => [st.flags.DATA === 'warning' ? 'Sensor reading out of range (' + F.fmt.num(st.raw, 0) + ' ppb)' : 'No new sensor data',
      'Sensor data nominal'],
    PWR: (st) => ['Battery estimate under 1 day', 'Battery estimate nominal'],
  };
  const SEV_CODE = { warning: 'WARN', caution: 'CAUT', advisory: 'ADVS' };

  /** Compare two states and append log entries. Keeps onset times for flashing lamps. */
  function diffEvents(pod, series, prev, st, events, onset, cfg) {
    const R = cfg.rules;
    const t = st.t;
    const add = (sev, text) => events.push({ t, pod: pod.id, sev, text });

    if (series.loadT != null && prev && prev.t < series.loadT && t >= series.loadT) {
      const b = series.base;
      add('INFO', pod.fruit + ' loaded. Baseline ' + F.fmt.num(b.raw, 1) + ' ppb at ' + F.fmt.num(b.temp, 2) +
        ' C (' + b.n + ' samples)');
    }

    // Eat readiness steps
    if (st.loaded && st.stage != null && (!prev || prev.stage == null || st.stage > prev.stage) && st.stage > 0) {
      const sg = cfg.eat.stages[st.stage];
      add(st.stage === 3 ? 'ADVS' : 'INFO', pod.fruit + ' now ' + sg.label.toLowerCase());
    }

    // Fan and vent advice
    const pFan = prev ? prev.fan : 0;
    if (st.fan && !pFan) {
      add('ADVS', 'Fan on ' + R.fanRunS + ' s: ' + ((prev && prev.vent.reason) || 'manual'));
    } else if (!st.fan && pFan) {
      add('INFO', 'Fan off. Rise now ' + F.fmt.signed(st.delta) + ' ppb');
    }
    if (!pod.fan) {
      const pAdv = prev ? prev.vent.advised : false;
      if (st.vent.advised && !pAdv) add('ADVS', 'Vent advised: ' + st.vent.reason + '. No fan fitted');
      if (!st.vent.advised && pAdv) add('INFO', st.vent.held ? 'Vent no longer needed: ready to eat' : 'Vent no longer advised');
    }

    for (const col of COLS) {
      const p = prev ? prev.flags[col] : 'off';
      const c = st.flags[col];
      if (p === c) continue;
      onset[col] = t;
      const txt = FLAG_TEXT[col];
      if (!txt) continue;
      const [on, off] = txt(st, R);
      if (c === 'caution' || c === 'warning') add(SEV_CODE[c], on);
      else if ((p === 'caution' || p === 'warning') && c === 'off') add('INFO', off);
    }
  }

  function buildTimeline(pod, series, cfg) {
    const states = new Array(series.length);
    const events = [];
    const onset = {};
    let prev = null;
    for (let i = 0; i < series.length; i++) {
      const st = evaluate(series, i, pod, cfg, prev, null);
      diffEvents(pod, series, prev, st, events, onset, cfg);
      st.onset = Object.assign({}, onset);
      states[i] = st;
      prev = st;
    }
    return { states, events };
  }

  /** Intervals where the fan ran, or venting was advised with no fan fitted. */
  function intervals(series, states, iEnd, hasFan) {
    const on = [], adv = [];
    let a = null, b = null;
    const n = Math.min(series.length - 1, iEnd);
    for (let i = 0; i <= n; i++) {
      const t = series.t[i];
      if (series.fan[i]) { if (a == null) a = t; } else if (a != null) { on.push([a, t]); a = null; }
      // Advice is only drawn for pods with no fan; a fitted fan acts on it.
      const ad = !hasFan && states[i] && states[i].vent.advised && !series.fan[i];
      if (ad) { if (b == null) b = t; } else if (b != null) { adv.push([b, t]); b = null; }
    }
    const last = n >= 0 ? series.t[n] : 0;
    if (a != null) on.push([a, last]);
    if (b != null) adv.push([b, last]);
    return { on, adv };
  }

  F.rules = { COLS, COL_NAMES, ventDecision, evaluate, applyContext, diffEvents, buildTimeline, intervals };
})();
