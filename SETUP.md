# Going live

How readings get from the DGS2 to everyone watching the dashboard:

```
DGS2  --USB-->  sensor laptop: bridge/dgs2_bridge.py  --internet-->  Firebase Realtime Database  -->  dashboard (any browser)
```

The bridge asks the sensor for one reading a second (it only ever sends a carriage return, never a
settings command), saves every reading to `logs/`, and sends a 5-second average to Firebase. The
dashboard loads the last 12 hours and then updates as each reading arrives.

Setting it up takes about 15 minutes, once. Steps 1 to 4 happen in the browser; 5 to 7 on the sensor laptop.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and sign in with a Google account the team can share.
2. **Add project**, name it e.g. `fresh-food-off-earth`. Google Analytics is not needed; turn it off.

## 2. Create the database

1. In the left menu: **Build > Realtime Database > Create Database**.
2. Location: United States (`us-central1`). Start in **locked mode**.
3. Copy the database URL shown at the top of the Data tab, e.g.
   `https://fresh-food-off-earth-default-rtdb.firebaseio.com`

## 3. Create the sensor account

Only this account can write readings; everyone can read them.

1. **Build > Authentication > Get started**, then enable **Email/Password**.
2. **Users > Add user**. Use an address only the team uses (it does not need to receive mail) and a long password.
3. Copy the new user's **User UID**.

## 4. Paste the security rules

1. **Realtime Database > Rules**.
2. Replace everything with the contents of [`firebase/database.rules.json`](firebase/database.rules.json),
   and swap `PASTE_SENSOR_ACCOUNT_UID_HERE` for the UID from step 3.
3. **Publish**.

The rules let anyone read `pods/`, only the sensor account write it, and reject readings without
a time, a ppb value and a temperature. Nothing outside `pods/` can be read or written.

## 5. Point the dashboard at the database

In [`js/config.js`](js/config.js), set:

```js
cloud: {
  databaseURL: 'https://fresh-food-off-earth-default-rtdb.firebaseio.com',
```

Commit and push. The URL is safe to publish; the rules protect writing. The dashboard now opens in
**Live** mode. Until the bridge runs it shows *No signal*.

## 6. Set up the sensor laptop

```bash
pip3 install pyserial
```

```bash
cp bridge/.env.example bridge/.env
```

Open `bridge/.env` and fill in:

| Setting | Where to find it |
|---|---|
| `FIREBASE_DB_URL` | the database URL from step 2 |
| `FIREBASE_API_KEY` | Project settings (gear icon) > General > Web API key |
| `SENSOR_EMAIL`, `SENSOR_PASSWORD` | the account from step 3 |

`bridge/.env` is listed in `.gitignore`, so the password never reaches GitHub.

## 7. Run it

Plug in the DGS2 and find its port:

```bash
ls /dev/tty.usb*
```

Start the bridge with that port and the fruit in the pod:

```bash
python3 bridge/dgs2_bridge.py --port /dev/tty.usbserial-0001 --fruit banana
```

Each line it prints is one 5-second average sent to the dashboard. While it runs, type a letter and press Enter:

- `l` the produce just went in (marks the load; the baseline is the two minutes before)
- `c` clear the load mark
- `q` quit

Leave the bridge running in the background for at least two minutes before loading the fruit, so the dashboard has a clean baseline.

## Try it without the sensor

- **Dashboard only:** open the page with `?feed=practice` to see live mode with a made-up banana on your own computer.
- **Whole pipeline, no sensor:** `python3 bridge/dgs2_bridge.py --fake` sends made-up readings (labelled FAKE) to the real database.
- **Nothing sent anywhere:** add `--dry-run` to print what would be sent.

## If something is wrong

| On the dashboard | Check |
|---|---|
| *Not set up* | `databaseURL` in `js/config.js` is empty |
| *Offline* | the viewer's internet connection |
| *No signal* | the bridge is not running, or has never sent a reading |
| *Stale* (amber) | the bridge stopped sending: laptop asleep, cable out, or no internet on the laptop. Readings are still saved to `logs/` and are sent when the connection returns |
| Bridge prints `could not reach Firebase` | laptop internet, or the URL in `bridge/.env` |
| Bridge prints `Permission denied` | the UID in the rules does not match the sensor account, or wrong password |
| Bridge prints `no reply from the sensor` | the USB cable or the port name |

Firebase's free plan (Spark) covers this easily: one pod sends about 17,000 readings a day, roughly 1.5 MB.
