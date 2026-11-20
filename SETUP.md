# Going live

How readings get from the DGS2 to everyone watching the dashboard:

```
DGS2  --USB-->  sensor laptop: bridge/dgs2_bridge.py  --internet-->  Supabase  -->  dashboard (any browser)
```

The bridge asks the sensor for one reading a second (it only ever sends a carriage return, never a
settings command), saves every reading to `logs/`, and sends a 5-second average to Supabase. The
dashboard loads the last 12 hours and then updates as each reading arrives.

Setting it up takes about 15 minutes, once. Steps 1 to 4 happen in the browser; 5 to 7 on the sensor laptop.

## 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard> and sign in (a GitHub account works) with an account the team can share.
2. **New project**. If it asks for an organization, create one on the **Free** plan.
3. Name it e.g. `ripeby`. The name can be changed later; the project URL is a random ID either way.
4. **Database password**: press *Generate a password* and keep it in a password manager. The
   dashboard and bridge never use it, but you need it to manage the database later.
5. Region: **Americas**.
6. Data access: keep **Enable Data API** ticked. The other two boxes (grant API access and enable
   RLS on new tables automatically) can stay off: `supabase/schema.sql` does both for its tables.
7. **Create new project** and wait about two minutes.

## 2. Create the sensor account

Only this account can write readings; everyone can read them.

1. **Authentication > Users > Add user > Create new user**.
2. Use an address only the team uses (no email is ever sent to it) and a long password.
   Tick **Auto Confirm User**, otherwise the account cannot sign in.
3. Click the new user and copy its **User UID**.
4. Optional, extra safety: **Authentication > Sign In / Providers**, turn off **Allow new users to sign up**.

## 3. Create the tables and access rules

1. **SQL Editor > New query**.
2. Paste the whole of [`supabase/schema.sql`](supabase/schema.sql). Check that the UID in the three
   `sensor write` lines is the User UID from step 2; if not, replace it.
3. **Run**. If Supabase warns about a destructive operation, that is the `drop policy` lines that make the script safe to run twice; confirm.

This creates two tables, `pods` (what is in each pod and when it was loaded) and `readings` (one row
per 5-second average), lets anyone read them, lets only the sensor account write them, and tells
Supabase to push new rows to open dashboards.

## 4. Copy the project URL and key

1. **Project Settings > API Keys**: copy the **publishable key** (`sb_publishable_...`). Older
   projects call it the **anon public** key; either works. Never use the *secret* or *service_role* key.
2. **Project Settings > Data API** (or the **Connect** button at the top): copy the **Project URL**,
   e.g. `https://abcdefghijklmnop.supabase.co`.

## 5. Point the dashboard at the project

In [`js/config.js`](js/config.js), set:

```js
cloud: {
  url: 'https://abcdefghijklmnop.supabase.co',
  key: 'sb_publishable_...',
```

Commit and push. Both values are safe to publish; the access rules protect writing. The dashboard
now opens in **Live** mode. Until the bridge runs it shows *No signal*.

## 6. Set up the sensor laptop

```bash
pip3 install pyserial certifi
```

(`certifi` gives Python the certificates it needs to connect securely; Python from python.org on macOS comes without them.)

```bash
cp bridge/.env.example bridge/.env
```

Open `bridge/.env` and fill in:

| Setting | Where to find it |
|---|---|
| `SUPABASE_URL` | the Project URL from step 4 |
| `SUPABASE_KEY` | the publishable key from step 4 |
| `SENSOR_EMAIL`, `SENSOR_PASSWORD` | the account from step 2 |

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

Leave the bridge running for at least two minutes before loading the fruit, so the dashboard has a clean baseline.

## Try it without the sensor

- **Dashboard only:** open the page with `?feed=practice` to see live mode with a made-up banana on your own computer.
- **Whole pipeline, no sensor:** `python3 bridge/dgs2_bridge.py --fake` sends made-up readings (labelled FAKE) to the real database.
- **Nothing sent anywhere:** add `--dry-run` to print what would be sent.

## If something is wrong

| On the dashboard | Check |
|---|---|
| *Not set up* | `url` or `key` in `js/config.js` is empty |
| *Offline* | the viewer's internet connection, or the Supabase project is paused (see below) |
| *No signal* | the bridge is not running, or has never sent a reading |
| *Stale* (amber) | the bridge stopped sending: laptop asleep, cable out, or no internet on the laptop. Readings are still saved to `logs/` and are sent when the connection returns |
| Bridge prints `could not reach Supabase` | laptop internet, or `SUPABASE_URL` in `bridge/.env` |
| Bridge prints `CERTIFICATE_VERIFY_FAILED` | run `pip3 install certifi` |
| Bridge prints `could not sign in` | the email or password in `bridge/.env`, or **Auto Confirm User** was not ticked |
| Bridge prints `the database refused a write` | the UID in the SQL does not match the sensor account: fix it and run `supabase/schema.sql` again |
| Bridge prints `no reply from the sensor` | the USB cable or the port name |

## Free plan limits

- **Pausing:** Supabase pauses free projects after a week with no activity. Open the project in the
  Supabase dashboard and press **Restore**; the data is kept.
- **Space:** one pod sends about 17,000 readings a day, roughly 3 MB, against 500 MB on the free
  plan. To clear readings older than 30 days, run this in the SQL Editor:

  ```sql
  delete from readings where t < (extract(epoch from now()) - 30 * 86400) * 1000;
  ```
