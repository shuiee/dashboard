/*
 * charts.js
 * Strip charts on canvas: one y-axis each, a shared time axis, a shared crosshair.
 * Colours are read from the CSS tokens so the day and night displays both work.
 */
(function () {
  'use strict';
  const F = window.FFOE;
  let C = null;

  function refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    C = {
      panel: g('--panel'), ink: g('--ink'), ink2: g('--ink-2'), ink3: g('--ink-3'), ink4: g('--ink-4'),
      grid: g('--grid'), axis: g('--axis'), data: g('--data'), data2: g('--data-2'), fill: g('--data-fill'),
      caution: g('--caution'), warning: g('--warning'), advisory: g('--advisory'), advFill: g('--advisory-fill'),
      now: g('--now'), mono: g('--font-mono'),
    };
  }

  function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }

  function timeStep(span) {
    if (span <= 1200) return 120;
    if (span <= 3700) return 600;
    if (span <= 4.2 * 3600) return 1800;
    if (span <= 12 * 3600) return 3600;
    return 3 * 3600;
  }

  class StripChart {
    constructor(wrap, opt) {
      this.wrap = wrap;
      this.opt = Object.assign({ padL: 50, padR: 12, padT: 8, padB: 6, xAxis: false, kind: 'line', minSpan: 1, decimals: 0 }, opt);
      if (this.opt.xAxis) this.opt.padB = 20;
      this.c = document.createElement('canvas');
      this.c.setAttribute('role', 'img');
      this.c.setAttribute('aria-label', opt.label || 'chart');
      wrap.appendChild(this.c);
      this.ctx = this.c.getContext('2d');
      this.d = null;
      this.w = 10; this.h = 10;
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(wrap);
      const move = e => {
        if (!this.d) return;
        const r = this.c.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (x < this.opt.padL || x > this.w - this.opt.padR) { this.opt.onHover && this.opt.onHover(null); return; }
        this.opt.onHover && this.opt.onHover(this.xToT(x));
      };
      this.c.addEventListener('pointermove', move);
      this.c.addEventListener('pointerdown', move);
      this.c.addEventListener('pointerleave', () => this.opt.onHover && this.opt.onHover(null));
    }

    resize() {
      const r = this.wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = Math.max(10, r.width);
      this.h = Math.max(10, r.height);
      this.c.width = Math.round(this.w * dpr);
      this.c.height = Math.round(this.h * dpr);
      this.c.style.width = this.w + 'px';
      this.c.style.height = this.h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    xToT(x) {
      const o = this.opt, [a, b] = this.d.x;
      return a + (x - o.padL) / (this.w - o.padL - o.padR) * (b - a);
    }
    tToX(t) {
      const o = this.opt, [a, b] = this.d.x;
      return o.padL + (t - a) / (b - a) * (this.w - o.padL - o.padR);
    }
    yToP(v) {
      const o = this.opt;
      return o.padT + (1 - (v - this.lo) / (this.hi - this.lo)) * (this.h - o.padT - o.padB);
    }

    set(d) { this.d = d; }

    draw() {
      const ctx = this.ctx, o = this.opt, d = this.d;
      if (!C) refreshColors();
      ctx.clearRect(0, 0, this.w, this.h);
      if (!d || !d.t) return;
      const x0 = o.padL, x1 = this.w - o.padR, y0 = o.padT, y1 = this.h - o.padB;
      if (x1 - x0 < 20 || y1 - y0 < 10) return;

      // visible index range
      const t = d.t;
      const iEnd = d.iEnd;
      let iStart = 0;
      while (iStart < iEnd && t[iStart] < d.x[0]) iStart++;
      iStart = Math.max(0, iStart - 1);

      ctx.font = '400 10.5px ' + C.mono;
      ctx.textBaseline = 'middle';

      if (o.kind === 'state') {
        this.drawState(d, x0, x1, y0, y1);
      } else if (!d.series || !d.series.length) {
        this.lo = 0; this.hi = 1;
      } else {
        // y range from what is on screen
        let lo = Infinity, hi = -Infinity;
        for (const s of d.series) {
          for (let i = iStart; i <= iEnd; i++) {
            const v = s.y[i];
            if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
          }
        }
        for (const th of d.thresholds || []) {
          if (th.include) { lo = Math.min(lo, th.v); hi = Math.max(hi, th.v); }
        }
        if (o.includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (hi - lo < o.minSpan) { const m = (hi + lo) / 2; lo = m - o.minSpan / 2; hi = m + o.minSpan / 2; }
        const padV = (hi - lo) * 0.1;
        lo -= padV; hi += padV;
        const step = niceStep(hi - lo, Math.max(2, Math.floor((y1 - y0) / 70)));
        this.lo = Math.floor(lo / step) * step;
        this.hi = Math.ceil(hi / step) * step;

        // grid + y labels
        ctx.textAlign = 'right';
        for (let v = this.lo; v <= this.hi + step / 2; v += step) {
          const y = Math.round(this.yToP(v)) + 0.5;
          ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
          ctx.fillStyle = C.ink3;
          const dec = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
          ctx.fillText(v.toFixed(dec), x0 - 6, y);
        }
      }

      this.drawTimeGrid(d, x0, x1, y0, y1);

      // shaded intervals (fan running)
      if (d.shade) {
        ctx.fillStyle = C.advFill;
        for (const [a, b] of d.shade) {
          const xa = Math.max(x0, this.tToX(a)), xb = Math.min(x1, this.tToX(b) + 1);
          if (xb > xa) ctx.fillRect(xa, y0, xb - xa, y1 - y0);
        }
      }

      if (o.kind !== 'state') {
        // thresholds
        for (const th of d.thresholds || []) {
          if (th.v < this.lo || th.v > this.hi) continue;
          const y = Math.round(this.yToP(th.v)) + 0.5;
          ctx.save();
          ctx.strokeStyle = th.color === 'caution' ? C.caution : th.color === 'warning' ? C.warning : th.color === 'advisory' ? C.advisory : C.ink3;
          ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
          ctx.restore();
          ctx.fillStyle = C.ink2; ctx.textAlign = 'right';
          ctx.fillText(th.label, x1 - 4, y - 7);
        }

        ctx.save();
        ctx.beginPath(); ctx.rect(x0, y0 - 2, x1 - x0, y1 - y0 + 4); ctx.clip();
        for (const s of d.series) this.drawLine(t, s, iStart, iEnd, x0, x1);
        ctx.restore();
      }

      // markers (load)
      for (const m of d.markers || []) {
        if (m.t < d.x[0] || m.t > d.x[1]) continue;
        const x = Math.round(this.tToX(m.t)) + 0.5;
        ctx.save();
        ctx.strokeStyle = C.ink2; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
        ctx.restore();
        if (o.markerLabels) {
          ctx.fillStyle = C.ink2; ctx.textAlign = 'left';
          ctx.fillText(m.label, x + 4, y0 + 7);
        }
      }

      // now line
      if (d.now >= d.x[0] && d.now <= d.x[1]) {
        const x = Math.round(this.tToX(d.now)) + 0.5;
        ctx.strokeStyle = C.now; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
        if (o.nowLabel) {
          ctx.fillStyle = C.ink2; ctx.textAlign = x > x1 - 40 ? 'right' : 'left';
          ctx.fillText('NOW', x + (x > x1 - 40 ? -4 : 4), y1 - 8);
        }
      }

      // crosshair
      if (d.hoverT != null && d.hoverT >= d.x[0] && d.hoverT <= Math.min(d.x[1], d.now)) {
        const x = Math.round(this.tToX(d.hoverT)) + 0.5;
        ctx.strokeStyle = C.ink; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
        ctx.globalAlpha = 1;
        if (o.kind !== 'state' && d.hoverI != null && d.hoverI >= 0) {
          for (const s of d.series) {
            const v = s.y[d.hoverI];
            if (!Number.isFinite(v) || s.noDot) continue;
            const y = this.yToP(v), xx = this.tToX(t[d.hoverI]);
            ctx.beginPath(); ctx.arc(xx, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = s.color === 'data2' ? C.data2 : C.data; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = C.panel; ctx.stroke();
          }
        }
      }

      if (d.empty) {
        ctx.fillStyle = C.ink3; ctx.textAlign = 'center';
        ctx.fillText(d.empty, (x0 + x1) / 2, (y0 + y1) / 2);
      }
    }

    drawTimeGrid(d, x0, x1, y0, y1) {
      const ctx = this.ctx, o = this.opt;
      const span = d.x[1] - d.x[0];
      const step = timeStep(span);
      const first = Math.ceil(d.x[0] / step) * step;
      ctx.textAlign = 'center';
      for (let s = first; s <= d.x[1]; s += step) {
        const x = Math.round(this.tToX(s)) + 0.5;
        ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
        if (o.xAxis) {
          ctx.fillStyle = C.ink3;
          ctx.fillText(F.fmt.metShort(s), x, y1 + 11);
        }
      }
      // axis line
      ctx.strokeStyle = C.axis;
      ctx.beginPath(); ctx.moveTo(x0, Math.round(y1) + 0.5); ctx.lineTo(x1, Math.round(y1) + 0.5); ctx.stroke();
    }

    drawLine(t, s, i0, i1, x0, x1) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = s.color === 'data2' ? C.data2 : C.data;
      ctx.lineWidth = s.width || 2;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (s.dash) ctx.setLineDash(s.dash);
      const count = i1 - i0 + 1;
      const dense = count > (x1 - x0) * 1.5;
      const pts = [];
      ctx.beginPath();
      let started = false, col = null, mn = 0, mx = 0;
      for (let i = i0; i <= i1; i++) {
        const v = s.y[i];
        if (!Number.isFinite(v)) { started = false; col = null; continue; }
        const x = this.tToX(t[i]), y = this.yToP(v);
        if (!dense) {
          if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
          if (s.fill) pts.push([x, y]);
          continue;
        }
        const cx = Math.round(x);
        if (cx !== col) {
          if (col != null) { ctx.lineTo(col, mn); ctx.lineTo(col, mx); }
          if (!started) { ctx.moveTo(cx, y); started = true; }
          col = cx; mn = mx = y;
          if (s.fill) pts.push([cx, y]);
        } else { if (y < mn) mn = y; if (y > mx) mx = y; }
      }
      if (dense && col != null) { ctx.lineTo(col, mn); ctx.lineTo(col, mx); }
      ctx.stroke();
      if (s.fill && pts.length > 1) {
        const yz = this.yToP(Math.max(this.lo, Math.min(this.hi, 0)));
        ctx.beginPath();
        ctx.moveTo(pts[0][0], yz);
        for (const [x, y] of pts) ctx.lineTo(x, y);
        ctx.lineTo(pts[pts.length - 1][0], yz);
        ctx.closePath();
        ctx.fillStyle = C.fill; ctx.fill();
      }
      ctx.restore();
    }

    drawState(d, x0, x1, y0, y1) {
      const ctx = this.ctx;
      const rows = [['FAN', d.intervals ? d.intervals.on : [], 'fill'], ['ADV', d.intervals ? d.intervals.adv : [], 'line']];
      const rh = (y1 - y0) / rows.length;
      ctx.textAlign = 'right';
      rows.forEach(([label, list, kind], r) => {
        const yt = y0 + r * rh + rh * 0.22, hh = rh * 0.56;
        ctx.fillStyle = C.ink3;
        ctx.fillText(label, x0 - 6, yt + hh / 2);
        ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, Math.round(yt + hh / 2) + 0.5); ctx.lineTo(x1, Math.round(yt + hh / 2) + 0.5); ctx.stroke();
        for (const [a, b] of list) {
          const xa = Math.max(x0, this.tToX(a)), xb = Math.min(x1, Math.max(this.tToX(b), this.tToX(a) + 2));
          if (xb <= xa) continue;
          if (kind === 'fill') {
            ctx.fillStyle = C.advisory; ctx.fillRect(xa, yt, xb - xa, hh);
          } else {
            ctx.strokeStyle = C.advisory; ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(xa) + 0.5, Math.round(yt) + 0.5, Math.max(1, xb - xa - 1), hh);
          }
        }
      });
    }
  }

  /** Small trend line for a pod card. */
  function spark(canvas, t, y, iEnd, xr, threshold) {
    if (!C) refreshColors();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!t || iEnd < 1) return;
    let lo = 0, hi = threshold || 1;
    for (let i = 0; i <= iEnd; i++) { const v = y[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    hi += (hi - lo) * 0.08;
    const X = tt => (tt - xr[0]) / (xr[1] - xr[0]) * (w - 2) + 1;
    const Y = v => h - 2 - (v - lo) / (hi - lo) * (h - 4);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Math.round(Y(0)) + 0.5); ctx.lineTo(w, Math.round(Y(0)) + 0.5); ctx.stroke();
    if (threshold) {
      ctx.save(); ctx.strokeStyle = C.caution; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, Math.round(Y(threshold)) + 0.5); ctx.lineTo(w, Math.round(Y(threshold)) + 0.5); ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = C.data; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    const stride = Math.max(1, Math.floor((iEnd + 1) / (w * 1.5)));
    let started = false;
    for (let i = 0; i <= iEnd; i += stride) {
      const v = y[i]; if (!Number.isFinite(v)) continue;
      if (started) ctx.lineTo(X(t[i]), Y(v)); else { ctx.moveTo(X(t[i]), Y(v)); started = true; }
    }
    if (Number.isFinite(y[iEnd])) ctx.lineTo(X(t[iEnd]), Y(y[iEnd]));
    ctx.stroke();
  }

  F.charts = { StripChart, spark, refreshColors };
})();
