# Pod Telemetry Console

Operator console for **Fresh Food Off Earth**: modular sealed pods, one fruit each, that sense the ethylene the fruit gives off, watch it with a camera, and run a small fan to flush the gas before ripening spreads.

The console is built to read like a NASA mission-control display rather than a website: one screen, dense, dark, with a caution and warning panel, strip charts on a shared time axis, time-tagged values and an event log.

**Open it:** double-click `index.html`, or visit the GitHub Pages site at <https://shuiee.github.io/dashboard/>. No build step and no install.

## What is on screen

| Area | What it shows |
|---|---|
| Top bar | Data source (Replay or Live), replay transport, mission elapsed time (MET), GMT as day-of-year, local time, master caution, day/night display |
| Pods (left) | Each pod's status word, ethylene rise, ripening rate, trend, temperature, humidity, fan, power and eat-first rank |
| Telemetry (centre) | The selected pod: readouts, then strip charts for ethylene rise (temperature-corrected and as read), ripening rate, temperature, humidity, and fan runs |
| Caution and warning (right) | A lamp matrix, one row per pod: `C2H4` `RATE` `VENT` `TEMP` `RH` `DATA` `CAM` `PWR` |
| Camera | Latest XIAO frame for POD-1, with the Teachable Machine classifier result |
| Event log | Every caution, fan run and state change, newest first, tagged with MET |

Keyboard: `Space` play/pause, `1` to `4` select a pod, arrow keys jump 5 minutes.

## Where the data comes from (please read before presenting)

- **POD-1 Banana** replays Experiment 3, phase D (one spotted banana, 167 g, closed bowl, four hours). It is **reconstructed from the values published in our experiment write-up** (baseline -146.7 ppb, rise of about 297 / 545 / 711 / 814 ppb at 1 / 2 / 3 / 4 h, the 1.7 &deg;C temperature swing, the humidity jump at 7:46:34 PM), not from the raw CSV. Drag the real CSV onto the console to replace it.
- **POD-2 Apple, POD-3 Tomato, POD-4 Avocado are simulated.** They run the same fan rules the console shows, so their fan runs are what our logic would do, not measurements.
- Thresholds marked `PLACEHOLDER` in `js/config.js` are our assumptions. Tune them with test data.
- The battery figure is the pinup estimate (about 13 mA with the fan, roughly six days on 2500 mAh). It has not been measured.

## The rules (no machine learning on this side)

Every decision has a reason the console can print.

1. **Temperature correction first.** `corrected = reading - 120 ppb/&deg;C x (T - T at baseline)`. The slope is `sensor.tempSlopePpbPerC`.
2. **Rise** = corrected reading minus the baseline (the mean of the readings just before the produce went in).
3. **Ripening rate** = how fast the rise grows over 30 minutes, in ppb/h. Fan runs and the 3 minutes after them are left out, because venting dilutes the gas and would look like the fruit got less ripe.
4. **Vent** when the rise passes 300 ppb, or when the last 15 minutes rise at least 1.5x faster than the hour before (ripening speeding up). The fan runs 120 s, then waits 10 minutes. Pods without a fan show *Vent advised* instead.
5. **Eat first** ranks pods by ripening rate.

## NASA display conventions applied

- **Caution and warning classes.** Red = warning (sensor fault, spoilage seen by the camera, temperature far out of range). Amber = caution (needs attention: ripening fast, ethylene high, humidity high, no data). White outline = advisory (fan running or vent advised). Unlit = nominal. Red is never used for decoration.
- **Master caution** lights for any new caution or warning and flashes until acknowledged. New lamps flash too. Reduced-motion settings replace flashing with an outline.
- **Colour is never the only cue.** Every lamp carries its label and every status chip carries a word.
- **Units on every value**, numbers in a monospaced face, time tags in MET and GMT day-of-year.
- **Dark field by default** to cut glare; a day display for bright crit rooms.
- **One y-axis per chart**, all charts on one time axis with a shared crosshair.
- **Staleness is a caution.** In live mode, if no reading arrives for 5 samples, `DATA` lights.

## Live hardware

Switch the top bar to **Live**.

**Ethylene sensor (DGS2 over USB).** Press *Connect DGS2* and pick the serial port (Chrome or Edge on a laptop). The console sends only a carriage return once a second, the documented single-read command, and never sends zero, calibration or settings commands. After a minute it takes a provisional baseline; press **Mark load** the moment the produce goes in.

**Camera (XIAO ESP32S3).** Enter the IP from Serial Monitor and press *Connect*. The console fetches `http://<ip>/capture` on the chosen interval and, with *Classify* ticked, runs the Teachable Machine model on each frame. Close the camera stream tab first, and keep the laptop on the same hotspot.

> Browsers block `http://` cameras on `https://` pages, so the live camera works when you open `index.html` from your laptop, not from the GitHub Pages site. Replay works everywhere.

**Logged CSV.** Drop a CSV from the logging script onto the page, or use the *CSV* button. Recognised headers: a time column (`time`, `timestamp`, `iso`, `epoch`, `elapsed`), `ppb` or `ethylene`, `temp`, and optionally `rh` or `humidity`, and `fan`. Scrub to the moment the produce went in and press **Mark load**.

## Files

```
index.html        layout
css/console.css   display tokens (night and day), layout, lamp styles
js/config.js      every threshold, the pods, sensor and camera settings
js/model.js       Series (temperature correction, rates) and the rule set
js/data.js        Experiment 3 reconstruction, simulated pods, CSV import
js/charts.js      canvas strip charts and sparklines
js/live.js        DGS2 Web Serial reader and XIAO camera client
js/app.js         wiring, replay clock, rendering
```

## Open items

- Replace the Experiment 3 reconstruction with the raw CSV in the repo.
- Add a CO2 channel when the SCD41 arrives (the ML summary calls CO2 our most reliable early signal).
- Add a cabin reference sensor so the alcohol in ISS air (about 1 to 6 ppm) can be subtracted.
- Days-left estimate (model 4, stretch goal).
- Cartridge state once the permanganate cartridge is built.
