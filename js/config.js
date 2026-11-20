/*
 * config.js
 * Every number the console uses lives here, so the team can tune it without
 * touching the rest of the code. Thresholds marked PLACEHOLDER are our
 * assumptions and should be replaced with values from the test runs.
 */
window.FFOE = window.FFOE || {};

FFOE.config = {
  mission: {
    name: 'RipeBy',
    console: 'Produce pod telemetry',
    repo: 'https://github.com/shuiee/dashboard',
  },

  // The replay timeline. Experiment 3, phase D started 7:42 PM on Nov 8.
  run: {
    start: '2026-11-08T19:42:00-05:00',
    durationS: 14400,      // four hours
    sampleS: 10,           // replay resolution (10 s means of the 1 Hz log)
  },

  replay: {
    startAtS: 7800,        // open the demo at T+02:10 so there is history on screen
    speed: 10,
  },

  // Live data path:
  //   DGS2 -> bridge/dgs2_bridge.py on the sensor laptop -> Supabase -> this page.
  // Fill in url and key after creating the Supabase project (see SETUP.md). Both are safe to
  // publish: anyone may read readings, only the sensor account may write them (supabase/schema.sql).
  cloud: {
    url: 'https://btwqapyikyjubvrwznpz.supabase.co', // Project URL, e.g. 'https://abcdefghijklmnop.supabase.co'
    key: 'sb_publishable_DqunAp1iVN9v56kmQMo4vA_9DmKjmyC', // publishable key (sb_publishable_...) or the legacy anon key
    historyHours: 12,      // how much past data a viewer loads when the page opens
    pushS: 5,              // the bridge sends a 5 s average (bridge --push-every)
    sdk: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js',
  },

  sensor: {
    model: 'DGS2 970-650',
    tempSlopePpbPerC: 120, // measured inside the banana run (80 to 170 across runs)
    resolutionPpb: 20,     // datasheet
    liveBaud: 9600,
    livePollMs: 1000,      // one reading a second, carriage return only
  },

  rules: {
    // Ethylene
    ventDeltaPpb: 300,         // PLACEHOLDER: flush the pod above this rise
    deltaCautionPpb: 500,      // PLACEHOLDER: caution above this rise
    rateCautionPpbH: 150,      // PLACEHOLDER: "ripening fast" above this rate
    rateWindowS: 1800,         // ripening rate is measured over 30 min
    rateMinS: 600,             // need 10 min after loading before judging rate
    accelShortS: 900,          // "speeding up" compares the last 15 min ...
    accelLongS: 3600,          // ... with the hour before it
    accelRatio: 1.5,
    accelFloorPpbH: 120,
    minHistoryS: 900,          // no venting in the first 15 min after loading
    postFanMaskS: 180,         // ignore 3 min after a fan run when measuring rate
    hysteresis: 0.92,          // a caution clears at 92% of its limit
    // Fan
    fanRunS: 120,              // "a couple of minutes"
    fanCooldownS: 600,
    // Environment (ISS cabin range 18.3 to 26.7 C)
    tempMinC: 18.3,
    tempMaxC: 26.7,
    tempWarnLowC: 10,
    tempWarnHighC: 35,
    rhCautionPct: 90,          // PLACEHOLDER: condensation and mould risk
    // Data quality
    faultLowPpb: -2000,
    faultHighPpb: 20000,
    staleFactor: 5,            // data is stale after 5 missed samples
    pwrCautionDays: 1,
    // Spoilage from the camera classifier
    spoilageClasses: /overripe|mould|mold|rotten|spoil|decay/i,
    spoilageConfidence: 0.8,
  },

  // Eat readiness. The crew view leads with this.
  // A pod steps up a stage when its ripening rate OR its ethylene rise passes a step.
  // Ripening only goes one way, so a pod never steps back down during a load.
  eat: {
    stages: [
      { key: 'wait', word: 'Wait', label: 'Not ripe yet' },
      { key: 'soon', word: 'Soon', label: 'Ripening' },
      { key: 'ready', word: 'Ready', label: 'Ready to eat' },
      { key: 'now', word: 'Eat now', label: 'Eat today' },
    ],
    rateSteps: [60, 150, 250],   // PLACEHOLDER ppb/h to reach Soon / Ready / Eat now
    riseSteps: [150, 400, 700],  // PLACEHOLDER ppb rise to reach Soon / Ready / Eat now
  },

  power: {
    estimatedDays: 6,          // pinup estimate: about 13 mA with fan, 2500 mAh. Not measured.
    currentMa: 13,
    capacityMah: 2500,
  },

  camera: {
    ip: '172.20.10.3',
    intervalS: 1800,           // design: one photo every 30 min
    modelUrl: 'https://teachablemachine.withgoogle.com/models/DygpdxY9L/',
    tfjs: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js',
    tmImage: 'https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8.5/dist/teachablemachine-image.min.js',
  },

  pods: [
    {
      // live: true = this pod has a real sensor publishing through the bridge.
      // Add live: true to another pod when its sensor is running.
      id: 'POD-1', fruit: 'Banana', note: 'Spotted, 167 g', source: 'replay', live: true,
      label: 'EXP-03 replay', loadT: 274, fan: false, cartridge: false, power: 'usb',
    },
    {
      id: 'POD-2', fruit: 'Apple', note: 'Ripe', source: 'sim', profile: 'apple',
      label: 'Simulated', loadT: 180, fan: true, cartridge: false, power: 'battery', batteryUsedDays: 0.6,
    },
    {
      id: 'POD-3', fruit: 'Tomato', note: 'Green', source: 'sim', profile: 'tomato',
      label: 'Simulated', loadT: 240, fan: true, cartridge: false, power: 'battery', batteryUsedDays: 1.4,
    },
    {
      id: 'POD-4', fruit: 'Avocado', note: 'Firm', source: 'sim', profile: 'avocado',
      label: 'Simulated', loadT: 300, fan: true, cartridge: false, power: 'battery', batteryUsedDays: 0.2,
    },
  ],
};
