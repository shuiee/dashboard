/*
 * icons.js
 * Fruit glyphs from IconPark Outline by ByteDance (https://github.com/bytedance/IconPark),
 * Apache License 2.0. Unmodified paths, 48 x 48 grid, stroke in currentColor.
 * Inlined so the console works offline and when opened as a local file.
 *
 * The "porthole" frame around each glyph is plain CSS (see .porthole in console.css),
 * so each pod reads as fruit seen through a spacecraft window.
 */
(function () {
  'use strict';
  const F = (window.FFOE = window.FFOE || {});

  const GLYPHS = {
    banana: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="4"><path d="M16 32c-2.8-.933-6.035-3.173-7.476-5.425a1.7 1.7 0 0 1-.245-1.043l.245-3.75c.053-.81 1.01-1.24 1.671-.77C12.33 22.529 16.228 25 19 25c7 0 13-2.5 16-8"/><path d="M26 43c10-2 19.242-12.485 16.867-23.059L41.999 16V8l-6-1c0 12.941-3 23-16 25c-5.976.92-11.705-.386-16.129-2.922L5 36c2 5 11 9 21 7"/></g>',
    apple: '<g fill="none" stroke="currentColor" stroke-width="4"><path d="M24 41.02c2.431 0 3.431 1.31 4.734 1.601c1.303.292 2.397.372 3.517-.121c2.219-.978 3.571-2.142 5.212-3.881C40.505 35.395 42 30.964 42 25.029s-1.6-9.003-4.067-11.009s-3.896-2.39-6.878-2.006s-4.606 3.589-7.047 3.589s-5.415-3.16-8.002-3.589c-2.588-.43-4.006 0-6.246 2.006S6 19.15 6 25.03c0 5.878 1.552 10.236 4.593 13.46c1.64 1.739 2.937 3.033 5.156 4.01c1.12.494 2.278.414 3.535.122c1.258-.29 2.258-1.6 4.716-1.6Z" clip-rule="evenodd"/><path stroke-linecap="round" d="M24.009 15.603Q25.186 4 34.01 4q.81 2.441.418 4.727q-.185 1.085-1.153 3.095M14.229 26q-.415 2.019 0 4.157q.414 2.137 1.767 3.3"/></g>',
    tomato: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="4"><path d="M24 44c11.046 0 20-7.387 20-16.5c0-6.442-4.475-11.799-11-14.516L29.5 14.5L30 20l-6.5-2l-6.5 2v-5.5l-3-1.516C8.022 15.837 4 21.393 4 27.5C4 36.613 12.954 44 24 44"/><path d="m23.5 4l3.809 5.117L36 9.91l-6.337 4.573L31.5 21l-8-3l-8 3l1.837-6.517L11 9.91l8.691-.793z"/></g>',
    avocado: '<g fill="none" stroke="currentColor" stroke-width="4"><path d="M33 19c-2-5 0-15-9-15s-7 10-9 14s-5 7-5 13c0 9 7.5 13 14 13s14-4 14-13c0-5-3-7-5-12Z"/><path d="M30 30a6 6 0 0 1-12 0c0-3.314 2.686-7.5 6-7.5s6 4.186 6 7.5Z"/></g>',
  };

  /**
   * Fruit icon. With porthole: true it sits in a round spacecraft-window frame.
   * The fruit name stays available to screen readers and as a hover tooltip.
   */
  /*
   * Wireframe globe built from circles and ellipses: the outline, three latitude bands seen
   * from slightly above, and three meridians. After the "EST. EARTH RELATIVE" display.
   */
  const TILT = 0.26; // sin of the viewing angle above the equator
  function globeWire() {
    const R = 46, c = 50;
    let s = '<circle cx="50" cy="50" r="46"/>';
    [0, 30, -30, 60, -60].forEach(lat => {
      const a = lat * Math.PI / 180;
      const rx = R * Math.cos(a);
      s += '<ellipse class="lat" cx="' + c + '" cy="' + (c - R * Math.sin(a) * Math.cos(Math.asin(TILT))).toFixed(1) +
        '" rx="' + rx.toFixed(1) + '" ry="' + (rx * TILT).toFixed(1) + '"/>';
    });
    [30, 60].forEach(lon => {
      s += '<ellipse class="lon" cx="50" cy="50" rx="' + (R * Math.sin(lon * Math.PI / 180)).toFixed(1) + '" ry="46"/>';
    });
    s += '<line class="lon" x1="50" y1="4" x2="50" y2="96"/>';
    return s;
  }

  F.fruitIcon = function (pod, opts) {
    const o = opts || {};
    const key = pod.icon || pod.fruit.toLowerCase();
    const svg = '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">' + (GLYPHS[key] || '') + '</svg>';
    if (o.globe) {
      return '<span class="globe" role="img" aria-label="' + pod.fruit + '" title="' + pod.fruit + '">' +
        '<span class="floor" aria-hidden="true"></span>' +
        '<svg class="wire" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' + globeWire() + '</svg>' +
        '<span class="globe-fruit">' + svg + '</span></span>';
    }
    const cls = (o.porthole ? 'porthole' : 'fi') + (o.cls ? ' ' + o.cls : '');
    return '<span class="' + cls + '" role="img" aria-label="' + pod.fruit + '" title="' + pod.fruit + '">' +
      (o.porthole ? '<span class="porthole-glass">' + svg + '</span>' : svg) + '</span>';
  };
})();
