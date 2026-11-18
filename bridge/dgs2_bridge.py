#!/usr/bin/env python3
"""
dgs2_bridge.py: publishes live DGS2 ethylene readings to the dashboard.

    DGS2 (USB serial) -> this script on the sensor laptop -> Firebase Realtime Database -> dashboard

SAFETY: the only byte this script ever sends to the sensor is a carriage return (0x0D), the
documented single-read command. It never sends zero, calibration or settings commands.
A stray command once changed the sensor's stored settings; keep it read-only.

What it does
  * asks the sensor for one reading a second and saves every reading to a local CSV (logs/)
  * every --push-every seconds, sends the average to Firebase (pods/<POD>/readings)
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

Settings come from bridge/.env (copy bridge/.env.example). Only the standard library is used,
plus pyserial for the real sensor (pip3 install pyserial).
"""
import argparse
import csv
import datetime as dt
import json
import math
import os
import queue
import random
import sys
import threading
import time
import urllib.error
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


# ---------------------------------------------------------------- Firebase (REST)
class Firebase:
    """Minimal Realtime Database client over REST, signed in as the sensor account."""

    def __init__(self, db_url, api_key=None, email=None, password=None, dry_run=False):
        self.db_url = (db_url or "").rstrip("/")
        self.api_key, self.email, self.password = api_key, email, password
        self.dry_run = dry_run
        self.id_token = None
        self.refresh_token = None
        self.expires = 0

    def _post_json(self, url, body):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())

    def _token(self):
        if not self.api_key:  # local emulator or open test database
            return None
        if self.id_token and time.time() < self.expires - 120:
            return self.id_token
        if self.refresh_token:
            r = self._post_json("https://securetoken.googleapis.com/v1/token?key=" + self.api_key,
                                {"grant_type": "refresh_token", "refresh_token": self.refresh_token})
            self.id_token, self.refresh_token = r["id_token"], r["refresh_token"]
            self.expires = time.time() + int(r["expires_in"])
        else:
            r = self._post_json(
                "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + self.api_key,
                {"email": self.email, "password": self.password, "returnSecureToken": True})
            self.id_token, self.refresh_token = r["idToken"], r["refreshToken"]
            self.expires = time.time() + int(r["expiresIn"])
        return self.id_token

    def request(self, method, path, body):
        if self.dry_run:
            print("  [dry run] %s %s %s" % (method, path, json.dumps(body)))
            return {}
        root, _, query = self.db_url.partition("?")  # the local emulator uses ?ns=<project>
        params = [query] if query else []
        tok = self._token()
        if tok:
            params.append("auth=" + tok)
        url = "%s/%s.json" % (root, path) + ("?" + "&".join(params) if params else "")
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode() or "null")


class Outbox(threading.Thread):
    """Sends writes in order; on failure waits and retries, so nothing is lost while offline."""

    def __init__(self, fb):
        super().__init__(daemon=True)
        self.fb, self.q, self.pending = fb, queue.Queue(), None
        self.online = True

    def put(self, method, path, body):
        self.q.put((method, path, body))

    def run(self):
        wait = 2
        while True:
            item = self.pending or self.q.get()
            self.pending = item
            try:
                self.fb.request(*item)
                self.pending = None
                if not self.online:
                    print("  network back, sending queued readings")
                self.online, wait = True, 2
            except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
                if self.online:
                    print("  could not reach Firebase (%s); will keep retrying" % e)
                self.online = False
                time.sleep(wait)
                wait = min(wait * 2, 60)

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
    db_url = os.environ.get("FIREBASE_DB_URL", "")
    if not a.dry_run and not db_url:
        sys.exit("FIREBASE_DB_URL is not set. Copy bridge/.env.example to bridge/.env and fill it in.")
    if not a.fake and not a.port:
        sys.exit("Give the sensor port with --port (find it with: ls /dev/tty.usb*), or use --fake.")

    fb = Firebase(db_url, os.environ.get("FIREBASE_API_KEY"), os.environ.get("SENSOR_EMAIL"),
                  os.environ.get("SENSOR_PASSWORD"), dry_run=a.dry_run)
    out = Outbox(fb)
    out.start()

    sensor = FakeSensor() if a.fake else DGS2(a.port)
    pod = a.pod
    base = "pods/" + pod

    os.makedirs(a.logs, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    log_path = os.path.join(a.logs, "%s_%s.csv" % (pod, stamp))
    log_f = open(log_path, "w", newline="")
    log = csv.writer(log_f)
    log.writerow(["time", "epoch_ms", "ppb", "temp_c", "rh", "raw"])

    meta = {"sensor": "FAKE" if a.fake else "DGS2", "startedAt": int(time.time() * 1000),
            "bridge": "dgs2_bridge.py"}
    if a.fruit:
        meta["fruit"] = a.fruit.lower()
    out.put("PATCH", base + "/meta", meta)

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
                    out.put("PATCH", base + "/meta", {"serial": sensor.serial_no})
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
                        "t": now_ms,
                        "ppb": round(sum(x["ppb"] for x in buf) / n, 1),
                        "temp": round(sum(x["temp"] for x in buf) / n, 3),
                        "rh": round(sum(x["rh"] for x in buf) / n, 1),
                        "n": n,
                    }
                    out.put("POST", base + "/readings", avg)
                    print("%s  %7.1f ppb  %5.2f C  %4.1f %%RH  (n=%d, queued %d)" % (
                        dt.datetime.now().strftime("%H:%M:%S"), avg["ppb"], avg["temp"], avg["rh"], n,
                        out.backlog()))
                    buf = []

            while not cmds.empty():
                c = cmds.get()
                if c == "l":
                    out.put("PATCH", base + "/meta", {"loadT": now_ms})
                    print("  load marked at %s" % dt.datetime.now().strftime("%H:%M:%S"))
                elif c == "c":
                    out.put("PATCH", base + "/meta", {"loadT": None})
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
