# Pod Telemetry Console

Operator console for **Fresh Food Off Earth**: modular sealed pods, one fruit each, that sense the ethylene the fruit gives off, watch it with a camera, and run a small fan to flush the gas before ripening spreads.

**Open it:** double-click `index.html`, or visit the GitHub Pages site at <https://shuiee.github.io/dashboard/>. No build step and no install.

## Two screens

### Crew view (default)

Built to be read in a few seconds. It answers two questions and stays quiet otherwise ("dark cockpit": nothing lights up unless it needs you).

| Area | What it answers |
|---|---|
| **Eat next** | Which fruit to eat now, and what comes after it |
| **Ventilation** | Whether any fan is running, or a pod with no fan needs venting by hand |
| **Crew actions** | Anything else that needs a person (sensor stopped, condensation, battery, spoilage seen by the camera). Says *No action needed* most of the time, on purpose |
| **Pod tiles** | One per pod, in fixed positions: the fruit as an icon in a spacecraft porthole, its eat order, a big readiness word (Wait, Soon, Ready, Eat now) with a four-step bar, the fan state, and one small ethylene line |

Click a tile to open that pod in the ethylene monitor.

**Always one screen.** The crew view never scrolls, from a phone to a projector. Each tile is a CSS size container, so its text and porthole scale with the space it gets, and the least important detail (the ethylene line, then the stage labels) drops out first when space is short. Landscape screens show the pods in one row; portrait screens show a 2 x 2 block.

**Fruit icons, not names.** Fruits are shown as icons so they can be recognised at a glance; the name stays in a hover tooltip and for screen readers. The rim of the porthole turns amber when that fruit should be eaten today.

### Ethylene monitor

The engineering detail for the team and the jury: strip charts for ethylene rise (temperature-corrected and as read), ripening rate, temperature, humidity and fan runs; a caution and warning lamp matrix; the camera; and the event log.

Replay and live controls sit in the footer, out of the crew's way. Keyboard: `Space` play/pause, `1` to `4` select a pod, arrow keys jump 5 minutes.

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
4. **Readiness.** A pod steps from *Wait* to *Soon* to *Ready* to *Eat now* when its ripening rate (60 / 150 / 250 ppb/h) or its rise (150 / 400 / 700 ppb) passes a step, whichever is higher. Ripening only goes one way, so a pod never steps back during a load. These steps are placeholders until we calibrate them against daily peel scores.
5. **Eat order** = most ripe stage first, then fastest ripening.
6. **Vent** when the rise passes 300 ppb, or when the last 15 minutes rise at least 1.5x faster than the hour before (ripening speeding up). The fan runs 120 s, then waits 10 minutes. Pods without a fan show *Vent needed* instead. **No venting at *Eat now***: flushing only slows fruit that has not ripened yet (NIAB), so at that point the answer is to eat it.

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
js/icons.js       fruit icons (IconPark, Apache 2.0)
js/model.js       Series (temperature correction, rates) and the rule set
js/data.js        Experiment 3 reconstruction, simulated pods, CSV import
js/charts.js      canvas strip charts and sparklines
js/live.js        DGS2 Web Serial reader and XIAO camera client
js/app.js         wiring, replay clock, rendering
```

## Credits

Fruit icons: [IconPark](https://github.com/bytedance/IconPark) Outline by ByteDance, Apache License 2.0 (banana, apple-one, tomato, avocado), inlined unmodified in `js/icons.js`. Interface icons: [Phosphor](https://phosphoricons.com), MIT.

## Open items

- Replace the Experiment 3 reconstruction with the raw CSV in the repo.
- Add a CO2 channel when the SCD41 arrives (the ML summary calls CO2 our most reliable early signal).
- Add a cabin reference sensor so the alcohol in ISS air (about 1 to 6 ppm) can be subtracted.
- Days-left estimate (model 4, stretch goal).
- Cartridge state once the permanganate cartridge is built.
