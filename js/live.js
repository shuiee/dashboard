/*
 * live.js
 * Hardware adapters.
 *
 * The ethylene sensor is read by bridge/dgs2_bridge.py on the sensor laptop, which
 * publishes to Firebase; the page reads it through js/feeds.js.
 *
 * Camera: polls the XIAO ESP32S3 CameraWebServer /capture endpoint and can run the
 * team's Teachable Machine model on each frame.
 */
(function () {
  'use strict';
  const F = window.FFOE;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  class Camera {
    constructor(cfg, onUpdate) {
      this.cfg = cfg;
      this.onUpdate = onUpdate;
      this.timer = null; this.busy = false;
      this.model = null; this.modelUrl = '';
      this.photoUrl = null;
      this.state = { link: 'none', msg: '', preds: null, lastMs: null, ms: null, w: 0, h: 0 };
      this.opts = null;
    }

    get running() { return !!this.timer; }

    start(opts) {
      this.stop(true);
      this.opts = opts;
      this.state.link = 'connecting';
      this.state.msg = 'Asking ' + opts.ip + ' for a frame';
      this.onUpdate(this.state);
      this.grab();
      this.timer = setInterval(() => this.grab(), Math.max(5, opts.intervalS) * 1000);
    }

    stop(silent) {
      clearInterval(this.timer);
      this.timer = null;
      if (!silent) {
        this.state.link = 'none';
        this.state.msg = 'Camera disconnected';
        this.onUpdate(this.state);
      }
    }

    async ensureModel(url) {
      if (!url.endsWith('/')) url += '/';
      if (this.model && this.modelUrl === url) return;
      await loadScript(this.cfg.camera.tfjs);
      await loadScript(this.cfg.camera.tmImage);
      /* global tmImage */
      this.model = await tmImage.load(url + 'model.json', url + 'metadata.json');
      this.modelUrl = url;
    }

    static square(img) {
      const size = 224, c = document.createElement('canvas');
      c.width = size; c.height = size;
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      return c;
    }

    async grab() {
      if (this.busy || !this.opts) return;
      this.busy = true;
      const t0 = performance.now();
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch('http://' + this.opts.ip + '/capture?t=' + Date.now(), { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error('Camera answered HTTP ' + res.status);
        const blob = await res.blob();
        if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
        this.photoUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.src = this.photoUrl;
        await img.decode();
        this.state.w = img.naturalWidth; this.state.h = img.naturalHeight;
        this.state.preds = null;
        let note = '';
        if (this.opts.classify && this.opts.modelUrl) {
          try {
            await this.ensureModel(this.opts.modelUrl);
            const preds = await this.model.predict(Camera.square(img));
            this.state.preds = preds.map(p => ({ name: p.className, p: p.probability })).sort((a, b) => b.p - a.p);
          } catch (e) {
            note = 'Frame received, classifier failed: ' + e.message;
          }
        }
        this.state.link = 'ok';
        this.state.lastMs = Date.now();
        this.state.ms = Math.round(performance.now() - t0);
        this.state.photo = this.photoUrl;
        this.state.msg = note;
      } catch (e) {
        const m = String(e && e.message || e);
        this.state.link = 'lost';
        if (location.protocol === 'https:') {
          this.state.msg = 'Browsers block http cameras on https pages. Open index.html from your laptop to use the live camera.';
        } else if (e.name === 'AbortError' || /Failed to fetch|NetworkError|Load failed/i.test(m)) {
          this.state.msg = 'Camera not reachable. Same hotspot? IP matches Serial Monitor? Stream tab closed?';
        } else {
          this.state.msg = m;
        }
      } finally {
        clearTimeout(to);
        this.busy = false;
        this.onUpdate(this.state);
      }
    }
  }

  F.live = { Camera };
})();
