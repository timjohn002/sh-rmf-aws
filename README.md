# Starhub RMF

Web app for managing robots, doors and elevators across building floors.

**Current features**
- **Map** (`/`): floor selector, drag/zoom floor plans, cursor position in meters.
  - Robots appear as blue dots on the floor they're on, updated every 5 s. A robot is faded when it's offline or hasn't sent a position for 2 minutes.
  - A **Robot names: Show / Hide** toggle (Show by default; Hide shows names on hover).
  - Works for any vendor that supports map positions (Keenon today).
- **Setup** (`/setup`): add floors, upload floor plans, and calibrate scale and origin.
- **Robots** (`/robots`): live status of every vendor robot (online, battery, work state, current task).
- **Vendors** (`/vendors`, admins only): configure robot vendor integrations. **Keenon** is supported, including its robot maps: discover each robot's floors, match them to app floors, align positions and calibrate to the floor plans.
- **Elevators** (`/elevators`, admins only): connect to LiftMind (Owlsome Tech) over MQTT, set up the lifts each floor has, check a lift's queue and try a test ride.
- **Users** (`/users`, admins only): add and delete accounts, and reset passwords.

Door integration, robot commands and robots riding lifts on their own come later.

## Architecture

```
Browser (React + Vite SPA)
   │  fetch /api/*  (HttpOnly session cookie)
   ▼
Node server in a container (server/)  ── service-role key ──▶  Supabase Postgres + Storage
   serves the built SPA (dist/) and the API routes (server/api)
```

- The browser **never** talks to Supabase with a key. All data goes through the `/api/*` routes, which check the session and role.
- One container image runs on an **AWS Lightsail** instance, behind Caddy for HTTPS: `server/main.ts` (Hono on Node 24) serves the web app and every API route listed in `server/routes.ts`. An hourly systemd timer runs `server/jobs/maintenance.ts`.
- Accounts live in the `app_users` table, with passwords hashed using **bcrypt**. Supabase Auth and email are not used.
- Row-level security is enabled with no policies, so the public anon key can't read any table. The `floor-plans` storage bucket is private, and images are shown through 1-hour signed URLs.
- Floor plan coordinates: each floor stores `scale_m_per_px` and an origin in pixels. World coordinates are in meters, with +Y pointing up (ROS / Open-RMF convention). See `src/lib/coords.ts`.

## First-time setup

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com).
2. Run every file in `supabase/migrations/`, **in number order**. For each one, open **SQL Editor**, paste the file's contents, and click **Run**.

   | File | Adds |
   |---|---|
   | `0001_init.sql` | Accounts (`app_users`), floors, and the private `floor-plans` storage bucket |
   | `0002_vendors.sql` | Vendor settings, stores, robots, and the callback log |
   | `0003_keenon_robot_maps.sql` | Robot positions, Keenon scenes and floors (robot maps), and floor matching |
   | `0004_keenon_floor_calibration.sql` | Keenon map → floor plan calibration |
   | `0005_keenon_position_alignment.sql` | Keenon reported position → map alignment |
   | `0006_vendor_event_details.sql` | Callback log: the URL that received each callback and our reply |
   | `0007_elevators.sql` | LiftMind connection, lifts, the floors they serve and the robots allowed to use them |

   The files are safe to run again, so re-running one by mistake does no harm.

**Updating an existing project:** if a `git pull` brings a new migration file, run just that file the same way.

### 2. Local settings (`.env.local`)
`.env.local` in the project folder holds your settings and is never committed. If it's missing, copy `.env.example`. Fill in:

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → **Data API** → Project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → **API Keys** → **Secret key** (`sb_secret_…`), or the legacy `service_role` key. **Not** the publishable/anon key. |
| `SESSION_SECRET` | Any random string of 32+ characters: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |

### 3. Create the first admin account
```bash
npm install
npm run create-user -- --username admin --role admin
```
The script prints a randomly generated password. Sign in with it, then change it from the user menu (top right).

Other uses:
```bash
npm run create-user -- --username bob                    # new "user" account, random password
npm run create-user -- --username bob --password 'S3cret!!'
npm run create-user -- --username admin --reset          # forgot the admin password? set a new one
```

### 4. Run locally
```bash
npm run dev          # http://localhost:5173  (Vite; /api is proxied to the API server on :8080)
```
If port 5173 is busy, Vite picks the next free port and prints it. The API server restarts when you change files in `server/`.

### Run the production build or container locally
```bash
npm run build
node --env-file=.env.local dist-server/main.mjs   # http://localhost:8080 (in a container, `npm start` with env vars set)

podman build -t starhub-rmf:dev .              # Red Hat UBI 9 + Node 24 image
podman run --rm --env-file .env.local -p 8090:8080 starhub-rmf:dev   # http://localhost:8090
```
The container uses host port 8090 so it can run next to `npm run dev`, which uses 8080. Don't put `PORT` in `.env.local`: the container reads that file too.

Health checks: `/healthz` (process is up) and `/readyz` (database reachable).

## Deploying (AWS Lightsail)
The app runs on one Lightsail **instance** with a **Static IP**. That fixed IP is what Keenon whitelists for API calls; the Lightsail container service has no fixed outbound IP, which is why it isn't used. Everything for the instance is in `deploy/lightsail/`:

| On the instance | What it does |
|---|---|
| `starhub-rmf` service (Podman Quadlet, `starhub-rmf.container`) | Runs the app container, restarts it on failure and at boot. Listens on `127.0.0.1:8080` only. |
| Caddy (`Caddyfile.template`) | HTTPS on ports 80/443 with an automatic Let's Encrypt certificate, forwarding to the app |
| `starhub-rmf-maintenance.timer` | Runs the maintenance job every hour (old callback logs, optional robot re-sync) |
| `/etc/starhub-rmf/app.env` | The app's settings and secrets (root-only) |

The image is built on the instance from this (public) GitHub repository, so no registry is needed.

**Hostname:** without a domain of your own, use `<static-ip-with-dashes>.sslip.io` (for IP `13.250.1.2`: `13-250-1-2.sslip.io`). It's a free name that resolves to that IP, so HTTPS works with no DNS setup; `setup.sh` uses it by default. To use a real domain later, point its DNS A record at the static IP, set `PUBLIC_SITE_URL` in `app.env`, and re-run `setup.sh <domain>`.

### First deployment
1. **Create the instance** in the Lightsail console: region **Singapore** (`ap-southeast-1`), **Linux/Unix → OS Only → Ubuntu 24.04 LTS**, the **2 GB** plan.
2. **Networking** tab of the instance:
   - Create a **Static IP** and attach it.
   - IPv4 firewall: allow **HTTP (80)** and **HTTPS (443)**. Restrict **SSH (22)** to your own IP if you can.
   - **Turn IPv6 off**, unless Keenon also whitelists an IPv6 address. Otherwise calls to Keenon may go out over IPv6 and be refused.
3. **Connect with SSH** (the browser terminal in the console is fine) and run:
   ```bash
   sudo apt-get install -y git
   sudo git clone https://github.com/timjohn002/sh-rmf-aws.git /opt/starhub-rmf/src
   sudo bash /opt/starhub-rmf/src/deploy/lightsail/setup.sh
   ```
   This installs Podman and Caddy, builds the image and creates `/etc/starhub-rmf/app.env`, then stops.
4. **Fill in the settings** (`sudo nano /etc/starhub-rmf/app.env`): Supabase URL and key as in your `.env.local`, and a **new** `SESSION_SECRET` (`openssl rand -base64 48`). `PUBLIC_SITE_URL` is already filled in.
5. **Run `setup.sh` again** (same command). It starts the app and the maintenance timer and ends with `Ready: https://<host>`.
6. **Keenon:** ask Keenon to whitelist the **static IP**, and change the callback URL in the Keenon portal to `https://<host>/keenon/webhook`. Then stop your local `npm run tunnel`. After the whitelist is active, **Save & test connection** on Vendors → Keenon works, and you can set `KEENON_SCHEDULED_SYNC=true` in `app.env`.

### Updating
After changes are merged to `main`:
```bash
sudo bash /opt/starhub-rmf/src/deploy/lightsail/update.sh
```
It pulls `main`, rebuilds the image, restarts the app (a few seconds of downtime) and waits until it's ready.

### Day to day
| Task | Command |
|---|---|
| App logs (incl. `elevator step received`) | `sudo journalctl -u starhub-rmf -f` |
| HTTPS / certificate logs | `sudo journalctl -u caddy -n 50` |
| Is the maintenance job scheduled / did it run? | `systemctl list-timers starhub-rmf-maintenance.timer`, `sudo journalctl -u starhub-rmf-maintenance -n 20` |
| Restart the app | `sudo systemctl restart starhub-rmf` |
| Change settings | `sudo nano /etc/starhub-rmf/app.env`, then restart the app |

| Environment variable | Purpose |
|---|---|
| `PORT` | Listen port (default `8080`) |
| `TRUST_PROXY=true` | Use `X-Forwarded-Proto`/`Host` from the reverse proxy (Caddy), so cookies get `Secure` and the origin check sees the public URL. Only set it behind a trusted proxy. |

## Robot vendors
Each vendor integration is code. There's one adapter folder per vendor, registered in a list:

| Piece | Where |
|---|---|
| Adapter interface | `server/vendors/types.ts` |
| Server registry | `server/vendors/index.ts` |
| Keenon adapter (API client, callbacks, signature) | `server/vendors/keenon/` |
| Config page per vendor | `src/vendors/index.ts` → `src/vendors/keenon/KeenonConfig.tsx` |
| Map positions (robots on the Map page) | `VendorAdapter.mapPositions`, used by `server/vendors/mapRobots.ts` (`GET /api/map/robots`) |
| Follow-up work on callbacks | `VendorAdapter.onCallback` (Keenon: `server/vendors/keenon/callbackActions.ts`) |
| Tables | `0002_vendors.sql` and `0006` (all vendors: `vendor_configs`, `vendor_stores`, `robots`, `vendor_events`); `0003`–`0005` (Keenon only: robot maps, calibration, position alignment) |

To add a vendor, write an adapter that implements `VendorAdapter`, add it to both registries, and give it a config page. To show its robots on the Map, also implement `mapPositions`. The Map page itself needs no changes.

### Keenon setup
1. Run the database migrations (see [First-time setup](#first-time-setup)).
2. **Keenon only accepts API calls from whitelisted IPs.** Run the app locally on the whitelisted network (`npm run dev`), or have Keenon whitelist the Lightsail instance's static IP.
3. Go to **Vendors → Keenon** and choose the region:

   | Region | Base URL |
   |---|---|
   | Global | `www.robotkeenon.com` |
   | China | `console.peanut.keenonrobot.com` |
   | EU | `es.robotkeenon.com` |
   | Japan | `cloud.robotkeenon.com` |
   | Custom | any URL you enter |

4. Enter the client ID and secret, then click **Save & test connection**.
5. Pick stores and click **Sync now**.
6. Turn on **Enabled**, then give Keenon the **callback URL** shown on the page (`<PUBLIC_SITE_URL>/api/vendors/keenon/webhook`). For elevator riding, register it under the `openAdapt` scenario. The app also accepts `<PUBLIC_SITE_URL>/keenon/webhook`, which is what the Keenon portal currently calls. **Live callbacks** shows each callback as it arrives: the URL that received it, the payload and our reply. All callbacks are kept in the **Callback log** for 30 days.
7. The callback URL contains no secret for now (older `/webhook/<token>` URLs still work). Once Keenon support has enabled callback signing, turn on **Require signature**.

Callbacks that need follow-up work go through `VendorAdapter.onCallback`, which runs after the callback is logged and doesn't delay the reply to Keenon. For Keenon this is `server/vendors/keenon/callbackActions.ts`. Elevator steps (`openAdapt`) appear as `openAdapt/<action>`, e.g. `openAdapt/QueryElevatorGroup`, and are only logged for now.

Environment variables:

| Variable | Purpose |
|---|---|
| `PUBLIC_SITE_URL` | Public base URL used in callback URLs |
| `KEENON_SCHEDULED_SYNC=true` | Hourly robot re-sync. Only enable it once the server has a whitelisted outbound IP. |

### Putting Keenon robots on the map
Set this up for each robot, from the whitelisted network. Start at **Vendors → Keenon → Robot maps** and click **Open** next to the robot.

1. **Discover floors.** Finds the floors (maps) of the robot's current scene. Floors from older scenes are removed.
2. **Match** each Keenon floor to an app floor ("Matches app floor").
3. **Align position.** Keenon reports positions in a different frame from its map image (usually rotated 180° and shifted). Turn on **Track robot**, then either:
   - take one sample with the 180° preset (quick), or
   - take 2–3 samples a few metres apart (more accurate).

   Push the robot and check that the red dot follows it. Then save.
4. **Calibrate.** Pair points on the Keenon map with the same spots on the app floor plan.
5. The robot now appears on the **Map** page.

The alignment can change when a robot restarts or relocalizes. If a robot looks out of place, re-check that floor with **Align position → Track robot**. Admins see a "robots not on the map" note on the Map page that explains what's missing for each robot.

Where Keenon can't be reached (IP not whitelisted), the Map shows the last known positions, faded after 2 minutes.

### Testing without real robots
```bash
npm run keenon:mock      # fake Keenon Cloud on http://localhost:4010 (client "mock-client" / "mock-secret")
npm run keenon:callbacks -- --url <callback URL> [--secret <client secret>]   # replays the API doc's callback examples
```

### Receiving real callbacks on your machine (ngrok)
Until the app is deployed, Keenon can reach the app on your machine through an [ngrok](https://ngrok.com) tunnel. By default the tunnel goes to the Podman container on port 8090. Only webhook paths go through (`/api/vendors/<vendor>/webhook[/<token>]` and `/keenon/webhook`, see `scripts/ngrok-policy.yml`); the login page and the rest of the API stay private.

One-time setup:
1. Install ngrok 3.20 or later from the Microsoft Store (or ngrok.com/download), sign up, and run `ngrok config add-authtoken <your token>`. On managed laptops Microsoft Defender may quarantine the winget/zip download; the Store version is signed and runs.
2. In the ngrok dashboard, claim your free static domain (**Domains**).
3. Set `PUBLIC_SITE_URL=https://<your-domain>` in `.env.local`.
4. Build the image and create the container (in the Podman machine, from the project folder):
   ```bash
   podman build -t starhub-rmf:dev .
   podman run -d --name starhub-rmf --restart unless-stopped --log-driver k8s-file --env-file .env.local -p 8090:8080 starhub-rmf:dev
   ```
   `--log-driver k8s-file` keeps the app's output for `podman logs`; the default (journald) loses it in the Podman machine on Windows.

Each time:
1. Make sure the container is running (`podman start starhub-rmf`, or start it in Podman Desktop).
2. Run `npm run tunnel` (`https://<your-domain>` → `localhost:8090`) and leave it open.
3. Use the app at **http://localhost:8090**. Vendors → Keenon → **Live callbacks** shows callbacks as they arrive.

Callbacks only arrive while the container and the tunnel are running. Log lines from callback actions (e.g. `elevator step received`) are in `podman logs -f starhub-rmf`, or in the container's Logs tab in Podman Desktop. ngrok's inspector at http://127.0.0.1:4040 shows every request that reached the tunnel, including ones the app refused (404s are not logged in the app). Once the app is deployed, change the URL at Keenon to the deployed hostname.

**After changing code**, the container still runs the old image. Rebuild it and re-create the container:
```bash
podman build -t starhub-rmf:dev .
podman rm -f starhub-rmf
podman run -d --name starhub-rmf --restart unless-stopped --log-driver k8s-file --env-file .env.local -p 8090:8080 starhub-rmf:dev
```

**While writing code**, dev mode avoids the rebuilds: run `npm run dev` (pages on http://localhost:5173, API on :8080, both reload on changes) and `npm run tunnel:dev` (tunnel → :8080) instead. Both modes use the same database, so settings like **Enabled** are shared.

## Elevators (LiftMind)
Lifts are controlled through Owlsome Tech's **LiftMind D Mode API**: MQTT over TLS, with a CA certificate from Owlsome Tech. The server keeps one MQTT connection open; its client ID is the prefix from Owlsome Tech plus a unique ending, so your laptop and the server can be connected at the same time.

| Piece | Where |
|---|---|
| Messages, topics, title aliases (`ELEVATOR_REQUEST_RESPONSE` → `ELEVATOR_RESPONSE`, …) | `server/elevators/liftmind/messages.ts` |
| MQTT connection, message log, test ride | `server/elevators/liftmind/connection.ts`, `testRide.ts` |
| Settings and lifts (database) | `server/elevators/store.ts`, `0007_elevators.sql` |
| API | `server/api/elevators.ts` (admins only) |
| Page | `src/pages/ElevatorsPage.tsx`, `src/components/elevators/` |

### Setting up
1. Run `0007_elevators.sql` in Supabase.
2. **Elevators → LiftMind connection:** enter the MQTT server and port, the client ID prefix, and choose the **CA certificate** file. Then **Import setting.json** (from Owlsome Tech). It fills in the manufacturer ID, username and password and creates a lift for every elevator in it, with its robots. Click **Save & connect**: the badges should show **Connected** and **LiftMind service: online**.
3. For each lift, click it (or **Edit**) and tick the **floors it serves**, with **LiftMind's name** for each floor (`1F`, `B1F`, `G`…, exactly as Owlsome Tech set up the site). A floor can have several lifts.
4. **Check** asks LiftMind for the lift's queue: a quick test that the connection and the elevator UUID are right.

The password is write-only: it's stored in the database and never sent back to the browser. The Lightsail server needs outbound access to the MQTT port (allowed by default).

### Test ride
**Test ride** on a lift calls it from one floor to another while **you play the robot**: after the lift arrives, press **Robot entered**, and at the destination **Robot exited**. You can also report a failed entry or exit (then choose a floor to recover to) or cancel. Every message to and from LiftMind appears under **MQTT messages**.

**A test ride moves a real lift** unless the connection points at Owlsome Tech's Beta / virtual elevator, or at the local fake below.

### Without a real lift
```bash
npm run liftmind:mock   # fake LiftMind (virtual elevator) on mqtt://localhost:1883, no TLS, no login
```
On the Elevators page set the server to `localhost`, port `1883`, **Use TLS** off, and any manufacturer ID. The fake lift takes 3 s per trip (`LIFTMIND_MOCK_TRAVEL_MS`). When the app runs in the Podman container, use the server name `host.containers.internal` instead of `localhost` (inside the container, `localhost` is the container itself).

## Scripts
| Command | What it does |
|---|---|
| `npm run dev` | App and API locally (Vite on :5173, API on :8080) |
| `npm run build` | Type-check, build the web app (`dist/`) and bundle the server (`dist-server/`) |
| `npm start` | Run the built server |
| `npm run job:maintenance` | Run the hourly maintenance job once (after a build) |
| `npm test` | Unit tests (server routing and static serving, coordinates, passwords, sessions, Keenon client and callbacks, map calibration and alignment, Map placement) |
| `npm run create-user` | Create or reset an account from the command line |
| `npm run keenon:mock` | Fake Keenon Cloud for local testing |
| `npm run liftmind:mock` | Fake LiftMind (virtual elevator) for local testing |
| `npm run keenon:callbacks` | Send example Keenon callbacks to a webhook URL |
| `npm run tunnel` | ngrok tunnel to the Podman container (:8090), for real vendor callbacks |
| `npm run tunnel:dev` | ngrok tunnel to the `npm run dev` API server (:8080) |

## Security notes
- Sessions are HS256 JWTs in an `HttpOnly; SameSite=Strict` cookie, valid for 12 hours. Every request re-checks the account in the database, so a deleted account is signed out immediately.
- After 5 failed sign-ins, an account is locked for 15 minutes. An admin password reset unlocks it.
- The server refuses to delete your own account or the last admin.
- Changing `SESSION_SECRET` signs everyone out.
