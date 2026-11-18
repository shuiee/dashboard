# Pod Telemetry Console

Live console for **Fresh Food Off Earth**: modular sealed pods, one fruit each, that sense the ethylene the fruit gives off, watch it with a camera, and run a small fan to flush the gas before ripening spreads.

**Open it:** <https://shuiee.github.io/dashboard/>, or double-click `index.html`. No build step and no install.

## Live data

```
DGS2  --USB-->  sensor laptop: bridge/dgs2_bridge.py  -->  Firebase Realtime Database  -->  this dashboard, on any device
```

- The **bridge** reads the DGS2 once a second (carriage return only, never a settings command), keeps every reading in `logs/`, and sends a 5-second average to Firebase. It holds readings while offline and sends them when the connection returns.
- The **dashboard** loads the last 12 hours and updates as each reading arrives. The word next to the clock says what you are looking at: **Live**, **Stale** (no reading for 25 s), **No signal**, **Offline**, **Not set up**, or **Demo**.
- **Mark the load** on the sensor laptop: type `l` and Enter in the bridge window when the produce goes in. Every viewer gets the same baseline (the two minutes before).
- Pods with `live: true` in `js/config.js` get a feed; the others show *No sensor*.

First-time setup (Firebase project, sensor account, security rules, sensor laptop): **[SETUP.md](SETUP.md)**.

The **Demo** softkey replays Experiment 3 (rebuilt from the write-up) and three simulated pods, for when the sensor is not running. `?feed=practice` shows live mode with a made-up banana on your own computer.

## Two screens

Switch between them with the green softkeys at the bottom, like the menu row on a Shuttle display.

### Crew

Built to be read in a few seconds, on the "dark cockpit" principle: nothing appears unless it matters.

Each pod gets one tile, always in the same position, with just three things:

1. **Eat order**: the boxed number in the corner (1 = eat first).
2. **The fruit**: an icon inside a ring with tick marks, after the Shuttle's attitude indicator.
3. **One word**: *Wait*, *Soon*, *Ready* or *Eat now* (inverse video).

Everything else stays hidden until it needs someone:

- **Venting** appears under a pod only while its fan runs; **Open vent** (outlined) appears only when a pod without a fan needs venting by hand.
- **A notice line** appears above the tiles only when the crew must act (sensor stopped, condensation, battery, spoilage seen by the camera).

Click a tile to open that pod on the Ethylene screen.

### Ethylene

One pod at a time: three boxed readouts (rise, ripening rate, fan), one chart of the temperature-corrected rise with the vent and caution limits and fan runs shaded, and that pod's events. Hover the chart to read any moment. In live mode the camera appears here for POD-1.

**Always one screen.** Nothing scrolls, from a phone to a projector (the event list scrolls inside its own column). Crew tiles are CSS size containers, so the number, ring and word scale with the space they get. Landscape screens show the pods in one row; portrait screens show a 2 x 2 block.

**Fruit icons, not names.** The name stays in a hover tooltip and for screen readers.

Replay and live controls sit in the same softkey row. Keyboard: `Space` play/pause, `1` to `4` select a pod, arrow keys jump 5 minutes. The flag key marks the moment produce went in.

## Demo data (please read before presenting)

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

## Display language

Taken from the Space Shuttle glass cockpit (MEDS) and NASA caution and warning practice:

- **Deep violet screen, yellow line graphics, boxed digital readouts, green softkeys** along the bottom edge.
- **Inverse video means "look at this"**: *Eat now* and cautions are yellow blocks. Red is kept for warnings (sensor fault, spoilage seen by the camera, temperature far out of range) and never used for decoration.
- **Master caution** lights for any new caution or warning and flashes until acknowledged. Reduced-motion settings replace flashing with an outline.
- **Colour is never the only cue**: every state also carries a word.
- **B612 Mono**, the typeface Airbus designed for cockpit displays, for every label and number.
- **Mission elapsed time** is the only clock.
- **Staleness is a caution**: in live mode, a sensor that stops reporting raises a notice.

## Camera

The camera is separate from the cloud path. In live mode with POD-1 selected, the Ethylene screen shows a camera panel: enter the XIAO's IP from Serial Monitor and press *Connect*. The console fetches `http://<ip>/capture` every `camera.intervalS` seconds and runs the Teachable Machine model in `camera.modelUrl` on each frame. Browsers block `http://` cameras on `https://` pages, so this works when `index.html` is opened from the laptop on the camera's hotspot, not from GitHub Pages.

**Logged CSV.** In Demo, drop a CSV from the bridge's `logs/` (or the old logging script) onto the page, or use the CSV key. Recognised headers: a time column (`time`, `timestamp`, `iso`, `epoch`, `elapsed`), `ppb` or `ethylene`, `temp`, and optionally `rh` or `humidity`, and `fan`. Scrub to the moment the produce went in and press the flag key.

## Files

```
index.html        layout
css/console.css   display tokens, layout
js/config.js      every threshold, the pods, the database URL, camera settings
js/feeds.js       live readings from Firebase (and the practice feed)
js/icons.js       fruit icons (IconPark, Apache 2.0)
js/model.js       Series (temperature correction, rates) and the rule set
js/data.js        Experiment 3 reconstruction, simulated pods, CSV import
js/charts.js      canvas chart
js/live.js        XIAO camera client
bridge/           dgs2_bridge.py (sensor laptop to Firebase) and .env.example
firebase/         database.rules.json (public read, sensor-only write)
js/app.js         wiring, replay clock, rendering
```

## Credits

Typeface: [B612 Mono](https://github.com/polarsys/b612), Open Font License. Fruit icons: [IconPark](https://github.com/bytedance/IconPark) Outline by ByteDance, Apache License 2.0 (banana, apple-one, tomato, avocado), inlined unmodified in `js/icons.js`. Interface icons: [Phosphor](https://phosphoricons.com), MIT.

## Open items

- Replace the Experiment 3 reconstruction with the raw CSV in the repo.
- Add a CO2 channel when the SCD41 arrives (the ML summary calls CO2 our most reliable early signal).
- Add a cabin reference sensor so the alcohol in ISS air (about 1 to 6 ppm) can be subtracted.
- Days-left estimate (model 4, stretch goal).
- Cartridge state once the permanganate cartridge is built.
