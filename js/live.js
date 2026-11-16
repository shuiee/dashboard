/*
 * live.js
 * Hardware adapters.
 *
 * DGS2: reads the ethylene sensor straight from the browser over Web Serial
 * (Chrome or Edge, opened from localhost, a file, or https).
 * SAFETY: the only byte this code ever sends is a carriage return (0x0D), the
 * documented single-read command. It never sends zero, calibration or settings
 * commands. Keep it that way: a stray command once changed the sensor's stored settings.
 *
 * Camera: polls the XIAO ESP32S3 CameraWebServer /capture endpoint and can run the
 * team's Teachable Machine model on each frame.
 */
(function () {
  'use strict';
  const F = window.FFOE;

  class DGS2 {
    constructor(cfg, onSample, onStatus) {
      this.cfg = cfg;
      this.onSample = onSample;
      this.onStatus = onStatus;
      this.port = null; this.reader = null; this.writer = null; this.timer = null;
      this.connected = false;
      this.serial = null;
    }

    static supported() { return 'serial' in navigator; }

    async connect() {
      if (!DGS2.supported()) {
        throw new Error('This browser has no Web Serial. Use Chrome or Edge on a laptop, with the console opened from a file, localhost or https.');
      }
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.cfg.sensor.liveBaud });
      this.writer = this.port.writable.getWriter();
      this.connected = true;
      this.onStatus('connected', 'Connected. Waiting for the first reading');
      this._readLoop();
      const CR = new Uint8Array([0x0D]);
      this.timer = setInterval(() => {
        if (this.connected) this.writer.write(CR).catch(e => this._fail(e));
      }, this.cfg.sensor.livePollMs);
    }

    async _readLoop() {
      const dec = new TextDecoder();
      let buf = '';
      try {
        this.reader = this.port.readable.getReader();
        while (this.connected) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let k;
          while ((k = buf.search(/[\r\n]/)) >= 0) {
            const line = buf.slice(0, k).trim();
            buf = buf.slice(k + 1);
            if (line) this._line(line);
          }
          if (buf.length > 4096) buf = '';
        }
      } catch (e) {
        this._fail(e);
      } finally {
        try { this.reader && this.reader.releaseLock(); } catch (_) { /* already released */ }
      }
    }

    /** DGS2 reply: serial, ppb, temperature, humidity, then raw counts and uptime. */
    _line(line) {
      const p = line.split(',').map(s => s.trim());
      if (p.length < 4) return;
      const ppb = parseFloat(p[1]);
      let temp = parseFloat(p[2]);
      let rh = parseFloat(p[3]);
      if (!Number.isFinite(ppb) || !Number.isFinite(temp)) return;
      if (Math.abs(temp) > 100) temp /= 100;
      if (rh > 100) rh /= 100;
      this.serial = p[0];
      this.onSample({ raw: ppb, temp, rh, line });
    }

    _fail(e) {
      if (!this.connected) return;
      this.onStatus('error', 'Sensor link lost: ' + (e && e.message ? e.message : e));
      this.disconnect();
    }

    async disconnect() {
      this.connected = false;
      clearInterval(this.timer);
      try { if (this.reader) await this.reader.cancel(); } catch (_) { /* ignore */ }
      try { if (this.writer) this.writer.releaseLock(); } catch (_) { /* ignore */ }
      try { if (this.port) await this.port.close(); } catch (_) { /* ignore */ }
      this.port = this.reader = this.writer = null;
      this.onStatus('idle', 'Sensor not connected');
    }
  }

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

  F.live = { DGS2, Camera };
})();
