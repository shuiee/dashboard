#!/usr/bin/env python3
"""
dgs2_bridge.py: publishes live DGS2 ethylene readings to the dashboard.

    DGS2 (USB serial) -> this script on the sensor laptop -> Supabase -> dashboard

SAFETY: the only byte this script ever sends to the sensor is a carriage return (0x0D), the
documented single-read command. It never sends zero, calibration or settings commands.
A stray command once changed the sensor's stored settings; keep it read-only.

What it does
  * asks the sensor for one reading a second and saves every reading to a local CSV (logs/)
  * every --push-every seconds, sends the average to Supabase (the readings table)
  * if the network drops, keeps the readings and sends them when it comes back

While it runs, type a letter and press Enter:
  l   mark the load: the produce went into the pod now (the dashboard takes its baseline
      from the two minutes before this)
  c   clear the load mark
  q   quit

Examples
  python3 bridge/dgs2_bridge.py --port /dev/tty.usbserial-0001 --fruit banana
  python3 bridge/dgs2_bridge.py --fake --dry-run          # no sensor, no network: test the loop
  python3 bridge/dgs2_bridge.py --fake                    # made-up readings to a real database

Settings come from bridge/.env (copy bridge/.env.example). Needs pyserial for the real sensor and
certifi for secure connections on macOS:  pip3 install pyserial certifi
"""
import argparse
import csv
import datetime as dt
import json
import math
import os
import queue
import random
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- settings
def load_env(path):
    """Reads KEY=VALUE lines into os.environ (values already set in the shell win)."""
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ---------------------------------------------------------------- Supabase (REST)
def _tls_context():
    """Python from python.org on macOS ships without trusted certificates; certifi supplies them."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


TLS = _tls_context()


class SignInError(Exception):
    pass


def _http_detail(e):
    """Short reason from an HTTP error response."""
    try:
        body = json.loads(e.read().decode() or "{}")
        msg = body.get("message") or body.get("msg") or body.get("error_description") or body.get("error")
    except (ValueError, OSError, AttributeError):
        msg = None
    return "HTTP %s%s" % (e.code, ": " + str(msg) if msg else "")


class Supabase:
    """Minimal Supabase client over REST, signed in as the sensor account."""

    def __init__(self, url, key=None, email=None, password=None, dry_run=False):
        self.url = (url or "").rstrip("/")
        self.key, self.email, self.password = key, email, password
        self.dry_run = dry_run
        self.access = None
        self.refresh = None
        self.expires = 0

    def _call(self, method, url, body, headers):
        data = None if body is None else json.dumps(body, allow_nan=False).encode()
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=15, context=TLS) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt.strip() else None

    def _token(self):
        if self.access and time.time() < self.expires - 120:
            return self.access
        h = {"apikey": self.key, "Content-Type": "application/json"}
        auth = self.url + "/auth/v1/token?grant_type="
        try:
            if self.refresh:
                try:
                    r = self._call("POST", auth + "refresh_token", {"refresh_token": self.refresh}, h)
                except urllib.error.HTTPError:
                    self.refresh = None  # expired or already used: sign in again
                    return self._token()
            else:
                r = self._call("POST", auth + "password", {"email": self.email, "password": self.password}, h)
        except urllib.error.HTTPError as e:
            raise SignInError("could not sign in as %s (%s)" % (self.email, _http_detail(e)))
        self.access, self.refresh = r["access_token"], r["refresh_token"]
        self.expires = time.time() + int(r.get("expires_in", 3600))
        return self.access

    def request(self, method, path, body, prefer="return=minimal"):
        if self.dry_run:
            print("  [dry run] %s %s %s" % (method, path, json.dumps(body)))
            return None
        h = {"apikey": self.key, "Authorization": "Bearer " + self._token(),
             "Content-Type": "application/json", "Prefer": prefer}
        return self._call(method, self.url + "/rest/v1/" + path, body, h)


class Outbox(threading.Thread):
    """Sends writes in order; on failure waits and retries, so nothing is lost while offline."""

    def __init__(self, db):
        super().__init__(daemon=True)
        self.db, self.q, self.pending = db, queue.Queue(), None
        self.online = True

    def put(self, method, path, body, prefer="return=minimal"):
        self.q.put((method, path, body, prefer))

    def _retry_later(self, why, wait):
        if self.online:
            print("  %s; will keep retrying (every reading is still in the log)" % why)
        self.online = False
        time.sleep(wait)
        return min(wait * 2, 60)

    def run(self):
        wait = 2
        while True:
            item = self.pending or self.q.get()
            self.pending = item
            try:
                self.db.request(*item)
                self.pending = None
                if not self.online:
                    print("  sending again; queued readings are going out")
                self.online, wait = True, 2
            except SignInError as e:
                wait = self._retry_later(str(e), wait)
            except urllib.error.HTTPError as e:
                if e.code == 400:  # the database rejected this row; retrying would block the rest
                    print("  the database rejected a write (%s); skipped it" % _http_detail(e))
                    self.pending = None
                    continue
                wait = self._retry_later("the database refused a write (%s)" % _http_detail(e), wait)
            except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
                why = "could not reach Supabase (%s)" % e
                if "CERTIFICATE_VERIFY_FAILED" in str(e):
                    why += ". Fix: pip3 install certifi"
                wait = self._retry_later(why, wait)

    def backlog(self):
        return self.q.qsize() + (1 if self.pending else 0)


# ---------------------------------------------------------------- sensors
def parse_dgs2(line):
    """DGS2 reply: serial, ppb, temperature, humidity, raw counts, uptime. Returns a dict or None."""
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 4:
        return None
    try:
        ppb, temp, rh = float(parts[1]), float(parts[2]), float(parts[3])
    except ValueError:
        return None
    if not all(math.isfinite(v) for v in (ppb, temp, rh)):
        return None
    if abs(temp) > 100:  # some firmware reports hundredths
        temp /= 100.0
    if rh > 100:
        rh /= 100.0
    return {"serial": parts[0], "ppb": ppb, "temp": temp, "rh": rh, "line": line}


class DGS2:
    CR = b"\r"  # the ONLY thing ever written to the sensor

    def __init__(self, port, baud=9600):
        try:
            import serial  # pyserial
        except ImportError:
            sys.exit("pyserial is missing. Install it with:  pip3 install pyserial")
        self.s = serial.Serial(port, baud, timeout=0.6)
        self.serial_no = None

    def read(self):
        self.s.reset_input_buffer()
        self.s.write(self.CR)
        for _ in range(3):  # skip an echoed carriage return or a blank line
            raw = self.s.readline().decode(errors="replace").strip()
            if not raw:
                continue
            r = parse_dgs2(raw)
            if r:
                self.serial_no = r["serial"]
                return r
        return None

    def close(self):
        self.s.close()


class FakeSensor:
    """Made-up banana readings for testing the pipeline. Labelled FAKE in the database."""
    serial_no = "FAKE"

    def __init__(self):
        self.t0 = time.time()

    def read(self):
        m = (time.time() - self.t0) / 60.0
        temp = 23 + 0.3 * math.sin(m / 15)
        rise = 0 if m < 2 else 900 * (1 - math.exp(-(m - 2) / 140))
        return {"serial": "FAKE", "ppb": -150 + rise + 120 * (temp - 23) + random.uniform(-1, 1),
                "temp": temp, "rh": 42 if m < 2 else 80, "line": ""}

    def close(self):
        pass


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Publish live DGS2 readings to the dashboard.")
    ap.add_argument("--port", help="serial port, e.g. /dev/tty.usbserial-0001 (ls /dev/tty.usb*)")
    ap.add_argument("--pod", default="POD-1", help="pod ID on the dashboard (default POD-1)")
    ap.add_argument("--fruit", default=None, help="banana, apple, tomato or avocado")
    ap.add_argument("--push-every", type=float, default=5.0, help="seconds per average sent (default 5)")
    ap.add_argument("--env", default=os.path.join(HERE, ".env"), help="settings file")
    ap.add_argument("--logs", default=os.path.join(HERE, "..", "logs"), help="folder for the CSV log")
    ap.add_argument("--fake", action="store_true", help="made-up readings, no sensor needed")
    ap.add_argument("--dry-run", action="store_true", help="print what would be sent, send nothing")
    a = ap.parse_args()

    load_env(a.env)
    db_url = os.environ.get("SUPABASE_URL", "")
    if not a.dry_run:
        missing = [k for k in ("SUPABASE_URL", "SUPABASE_KEY", "SENSOR_EMAIL", "SENSOR_PASSWORD")
                   if not os.environ.get(k)]
        if missing:
            sys.exit("%s not set. Copy bridge/.env.example to bridge/.env and fill it in (see SETUP.md)."
                     % (", ".join(missing) + (" is" if len(missing) == 1 else " are")))
    if not a.fake and not a.port:
        sys.exit("Give the sensor port with --port (find it with: ls /dev/tty.usb*), or use --fake.")

    db = Supabase(db_url, os.environ.get("SUPABASE_KEY"), os.environ.get("SENSOR_EMAIL"),
                  os.environ.get("SENSOR_PASSWORD"), dry_run=a.dry_run)
    out = Outbox(db)
    out.start()

    sensor = FakeSensor() if a.fake else DGS2(a.port)
    pod = a.pod
    this_pod = "pods?id=eq." + urllib.parse.quote(pod)

    os.makedirs(a.logs, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    log_path = os.path.join(a.logs, "%s_%s.csv" % (pod, stamp))
    log_f = open(log_path, "w", newline="")
    log = csv.writer(log_f)
    log.writerow(["time", "epoch_ms", "ppb", "temp_c", "rh", "raw"])

    # Create or update this pod's row (columns not listed here, like load_t, are kept)
    meta = {"id": pod, "sensor": "FAKE" if a.fake else "DGS2", "started_at": int(time.time() * 1000),
            "bridge": "dgs2_bridge.py"}
    if a.fruit:
        meta["fruit"] = a.fruit.lower()
    out.put("POST", "pods", meta, prefer="resolution=merge-duplicates,return=minimal")

    cmds = queue.Queue()

    def read_keys():
        while True:  # readline, not "for line in sys.stdin": no read-ahead buffering on pipes
            line = sys.stdin.readline()
            if not line:
                return
            cmds.put(line.strip().lower())

    threading.Thread(target=read_keys, daemon=True).start()

    print("Publishing %s from %s to %s" % (pod, "FAKE sensor" if a.fake else a.port, db_url or "(dry run)"))
    print("Logging every reading to %s" % log_path)
    print("Type l + Enter when the produce goes in, c + Enter to clear, q + Enter to quit.\n")

    buf, missed = [], 0
    next_push = time.time() + a.push_every
    serial_sent = False
    try:
        while True:
            tick = time.time()
            r = sensor.read()
            now_ms = int(time.time() * 1000)
            if r:
                missed = 0
                log.writerow([dt.datetime.now().isoformat(timespec="seconds"), now_ms,
                              "%.1f" % r["ppb"], "%.2f" % r["temp"], "%.1f" % r["rh"], r["line"]])
                log_f.flush()
                buf.append(r)
                if not serial_sent and getattr(sensor, "serial_no", None):
                    out.put("PATCH", this_pod, {"serial": sensor.serial_no})
                    serial_sent = True
            else:
                missed += 1
                if missed in (3, 30):
                    print("  no reply from the sensor (%d tries); check the cable" % missed)

            if time.time() >= next_push:
                # After a stall, resume the normal rhythm instead of sending a burst to catch up
                next_push = max(next_push + a.push_every, time.time() + a.push_every * 0.5)
                if buf:
                    n = len(buf)
                    avg = {
                        "pod": pod,
                        "t": now_ms,
                        "ppb": round(sum(x["ppb"] for x in buf) / n, 1),
                        "temp": round(sum(x["temp"] for x in buf) / n, 3),
                        "rh": round(sum(x["rh"] for x in buf) / n, 1),
                        "n": n,
                    }
                    out.put("POST", "readings", avg)
                    print("%s  %7.1f ppb  %5.2f C  %4.1f %%RH  (n=%d, queued %d)" % (
                        dt.datetime.now().strftime("%H:%M:%S"), avg["ppb"], avg["temp"], avg["rh"], n,
                        out.backlog()))
                    buf = []

            while not cmds.empty():
                c = cmds.get()
                if c == "l":
                    out.put("PATCH", this_pod, {"load_t": now_ms})
                    print("  load marked at %s" % dt.datetime.now().strftime("%H:%M:%S"))
                elif c == "c":
                    out.put("PATCH", this_pod, {"load_t": None})
                    print("  load mark cleared")
                elif c == "q":
                    raise KeyboardInterrupt

            time.sleep(max(0.0, 1.0 - (time.time() - tick)))
    except KeyboardInterrupt:
        print("\nStopping. Sending what is left...")
        t_end = time.time() + 10
        while out.backlog() and time.time() < t_end:
            time.sleep(0.2)
        if out.backlog():
            print("  %d writes could not be sent; every reading is still in %s" % (out.backlog(), log_path))
    finally:
        sensor.close()
        log_f.close()


if __name__ == "__main__":
    main()
