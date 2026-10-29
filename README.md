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
- **Users** (`/users`, admins only): add and delete accounts, and reset passwords.

Door and elevator integration, and robot commands, come later.

## Architecture

```
Browser (React + Vite SPA)
   │  fetch /api/*  (HttpOnly session cookie)
   ▼
Node server in a container (server/)  ── service-role key ──▶  Supabase Postgres + Storage
   serves the built SPA (dist/) and the API routes (server/api)
```

- The browser **never** talks to Supabase with a key. All data goes through the `/api/*` routes, which check the session and role.
- One container image runs on **Amazon EKS** (Kubernetes): `server/main.ts` (Hono on Node 24) serves the web app and every API route listed in `server/routes.ts`. An hourly CronJob runs `server/jobs/maintenance.ts`.
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
podman run --rm --env-file .env.local -p 8080:8080 starhub-rmf:dev
```
Health checks: `/healthz` (process is up) and `/readyz` (database reachable).

## Deploying (Amazon EKS)
Manifests are in `deploy/` (Kustomize): `deploy/base` is cluster-agnostic, and `deploy/overlays/dev` holds the environment-specific values.

The cluster needs the **AWS Load Balancer Controller** (it turns the Ingress into an Application Load Balancer). You also need an **ECR** repository for the image, an **ACM** certificate for the hostname, and a DNS record pointing the hostname at the load balancer.

1. Push the image to ECR. CI does this on every push to `main` once the `AWS_ROLE_ARN` and `ECR_REPOSITORY` repository variables are set (see `.github/workflows/ci.yml`). To push by hand:
   ```bash
   aws ecr get-login-password --region ap-southeast-1 | podman login --username AWS --password-stdin <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com
   podman tag starhub-rmf:dev <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/starhub-rmf:dev
   podman push <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/starhub-rmf:dev
   ```
2. In `deploy/overlays/dev/kustomization.yaml`, replace every `CHANGE-ME`: namespace, image, hostname, certificate ARN and `PUBLIC_SITE_URL`.
3. Copy `deploy/overlays/dev/secret.env.example` to `deploy/overlays/dev/.env.secret` (git-ignored) and fill in the same values as `.env.local`.
4. `kubectl apply -k deploy/overlays/dev`
5. Point the hostname's DNS at the load balancer address shown by `kubectl get ingress starhub-rmf -n <namespace>`, then give Keenon the new callback URL (Vendors → Keenon).

This creates the Deployment (2 replicas), Service, Ingress (internet-facing ALB, TLS at the load balancer), the hourly maintenance CronJob and a PodDisruptionBudget. The container runs as a non-root user with a read-only filesystem.

For outbound calls to Keenon, run the nodes in private subnets behind a NAT gateway with an Elastic IP, and have Keenon whitelist that IP. If the cluster enforces network policies, add one that allows port 8080 from the load balancer's subnets.

| Environment variable | Purpose |
|---|---|
| `PORT` | Listen port (default `8080`) |
| `TRUST_PROXY=true` | Use `X-Forwarded-Proto`/`Host` from the load balancer, so cookies get `Secure` and the origin check sees the public URL. Only set it behind a trusted proxy. |

## Robot vendors
Each vendor integration is code. There's one adapter folder per vendor, registered in a list:

| Piece | Where |
|---|---|
| Adapter interface | `server/vendors/types.ts` |
| Server registry | `server/vendors/index.ts` |
| Keenon adapter (API client, callbacks, signature) | `server/vendors/keenon/` |
| Config page per vendor | `src/vendors/index.ts` → `src/vendors/keenon/KeenonConfig.tsx` |
| Map positions (robots on the Map page) | `VendorAdapter.mapPositions`, used by `server/vendors/mapRobots.ts` (`GET /api/map/robots`) |
| Tables | `0002_vendors.sql` (all vendors: `vendor_configs`, `vendor_stores`, `robots`, `vendor_events`); `0003`–`0005` (Keenon only: robot maps, calibration, position alignment) |

To add a vendor, write an adapter that implements `VendorAdapter`, add it to both registries, and give it a config page. To show its robots on the Map, also implement `mapPositions`. The Map page itself needs no changes.

### Keenon setup
1. Run the database migrations (see [First-time setup](#first-time-setup)).
2. **Keenon only accepts API calls from whitelisted IPs.** Run the app locally on the whitelisted network (`npm run dev`), or whitelist the cluster's fixed outbound IP.
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
6. Give Keenon the **callback URL** shown on the page. It uses `PUBLIC_SITE_URL`, so it points to the live site even when the app runs locally. Callbacks are logged on the page for 30 days.
7. Optional: once Keenon support has enabled callback signing, turn on **Require signature**.

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
| `npm run keenon:callbacks` | Send example Keenon callbacks to a webhook URL |

## Security notes
- Sessions are HS256 JWTs in an `HttpOnly; SameSite=Strict` cookie, valid for 12 hours. Every request re-checks the account in the database, so a deleted account is signed out immediately.
- After 5 failed sign-ins, an account is locked for 15 minutes. An admin password reset unlocks it.
- The server refuses to delete your own account or the last admin.
- Changing `SESSION_SECRET` signs everyone out.
