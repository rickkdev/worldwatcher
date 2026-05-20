# Worldwatcher

🛰️ **Worldwatcher** is a local-first public situational-awareness dashboard for watching aircraft, vessels, crisis alerts, cyber/security signals, sanctions lists, and other open public data in one map-and-records interface.

It is built with **React**, **Vite**, **Leaflet**, and a small **Express** API layer that normalizes external feeds before they reach the browser.

> Worldwatcher is an open-source intelligence helper, not a verified command-and-control, emergency response, or military tracking system. Public feeds are incomplete, delayed, noisy, and sometimes wrong. Treat every record as a lead that needs source checking.

## ✨ What It Does

- 🗺️ **Live signal map** with Leaflet and a dark CARTO basemap.
- ✈️ **Aircraft markers** from OpenSky ADS-B/state vectors.
- 🚢 **Vessel markers** from AISStream position reports.
- ⚠️ **Disaster and public alert context** from GDACS, USGS, and NWS.
- 📰 **Conflict/news coverage** from GDELT.
- 🧰 **Humanitarian dataset discovery** from HDX.
- 🛡️ **Cyber threat context** from CISA Known Exploited Vulnerabilities.
- 📜 **Sanctions/watchlist context** from UN Security Council and OFAC SDN lists.
- 🔎 **Searchable text records** with source, time, location, summary, severity, and source link.
- 🎛️ **Per-feed filtering** for both records and map visibility.
- ♻️ **Server-side and browser-side backups** so the dashboard can fall back to the latest successful snapshot when a feed fails.
- 🔐 **Local `.env` secrets** for keyed feeds; credentials are not committed.

## 🧭 Interface

The app has three main surfaces:

| Area | Purpose |
|---|---|
| 🗺️ Map | Shows geospatial records with aircraft, vessel, alert, seismic, and generic signal markers. |
| 📡 Text Feeds | Lists every configured feed, its record count, keyed/no-key status, and map visibility switch. |
| 🧾 Signal Records | Searchable card list of normalized feed records with source links and timestamps. |

Clicking a marker opens a popup with feed-specific details. Aircraft and vessel records include movement-related fields when the upstream feed provides them.

## 🧱 Architecture

```text
External public feeds
        │
        ▼
server.mjs
  ├─ Express API routes
  ├─ feed fetchers/parsers
  ├─ OpenSky OAuth token handling
  ├─ AISStream WebSocket subscription
  ├─ in-memory response cache
  └─ local JSON feed backups
        │
        ▼
React app
  ├─ /api/feeds feed discovery
  ├─ /api/feed/:id data loading
  ├─ IndexedDB browser snapshots
  ├─ Leaflet map + canvas marker layer
  └─ searchable record drawer
```

The browser does not call most external feeds directly. `server.mjs` acts as a local API adapter so the app avoids browser CORS problems, keeps API keys out of client code, and normalizes all feeds into a shared record shape.

## 🚀 Quick Start

### Requirements

- Node.js 20+ recommended
- npm

### Install

```bash
npm install
```

### Configure Optional Secrets

Create a local `.env` file from the example:

```bash
cp .env.example .env
```

You can run the dashboard without keyed feeds, but OpenSky and AISStream require credentials.

### Run Locally

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

The dev command runs `node server.mjs`, which starts Express and mounts Vite middleware in development.

## 🔑 Environment Variables

| Variable | Required | Purpose |
|---|---:|---|
| `PORT` | No | Local server port. Defaults to `5173`. |
| `OPENSKY_CLIENT_ID` | For OpenSky | OAuth client ID for OpenSky Network. |
| `OPENSKY_CLIENT_SECRET` | For OpenSky | OAuth client secret for OpenSky Network. |
| `OPENSKY_BBOX` | No | Bounding box for OpenSky states: `lamin,lomin,lamax,lomax`. |
| `OPENSKY_TIMEOUT_MS` | No | OpenSky request timeout. Defaults to `60000`. |
| `AISSTREAM_API_KEY` | For AISStream | AISStream WebSocket API key. |
| `AISSTREAM_BOUNDING_BOXES_JSON` | For AISStream scope | JSON bounding boxes, for example `[[[-90,-180],[90,180]]]`. |
| `AISSTREAM_MAX_VESSELS` | No | Maximum vessel records kept in memory. Defaults to `10000`. |
| `FEED_BACKUP_DIR` | No | Directory for server feed snapshots. Defaults to `.data/feed-backups`. |

### OpenSky Bounding Box

`OPENSKY_BBOX` uses:

```text
lamin,lomin,lamax,lomax
```

Example for much of Europe, North Africa, and West Asia:

```text
35,-15,72,45
```

Keeping OpenSky bounded is important because full global state calls can be slow or time out. A future tiled polling system would make wider coverage more reliable.

## 📡 Current Feeds

### Keyed Live Tracking

| Icon | Feed | Category | Notes |
|---|---|---|---|
| ✈️ | OpenSky Aircraft | Aircraft tracking | Uses OpenSky OAuth credentials and optional bounding box. ADS-B/Mode S coverage is incomplete and receiver-dependent. |
| 🚢 | AISStream Vessels | Maritime tracking | Uses AISStream WebSocket. AIS can be delayed, absent, spoofed, or intentionally disabled. |

### No-Key Public Feeds

| Icon | Feed | Category | Notes |
|---|---|---|---|
| 📰 | GDELT Conflict Coverage | News-derived events | Fast media-derived signal. Noisy and not independently verified. |
| 🧰 | HDX Conflict Datasets | Humanitarian datasets | Dataset discovery for conflict, security, and displacement context. |
| 🌪️ | GDACS Global Alerts | Disaster/crisis alerts | Earthquakes, storms, floods, volcanoes, droughts, and related alerts. |
| 🌎 | USGS Significant Earthquakes | Seismic events | Significant earthquake feed for natural seismic context. |
| ⚠️ | NWS Active Alerts | U.S. public alerts | U.S.-only official alert feed. |
| 🛡️ | CISA KEV | Cyber threat context | Known exploited vulnerabilities catalog. |
| 📜 | UN Security Council Sanctions | Sanctions/economic pressure | Official UN consolidated sanctions XML. |
| 💼 | OFAC SDN Sanctions | Sanctions/economic pressure | U.S. Specially Designated Nationals data. |

More candidate feeds and integration notes live in [`DATA_FEEDS.md`](./DATA_FEEDS.md).

## 🧾 Normalized Record Shape

Each feed is normalized into records with fields like:

| Field | Meaning |
|---|---|
| `title` | Human-readable headline or object label. |
| `summary` | Short feed-specific context. |
| `location` | Place name or coordinate string. |
| `timestamp` | Best available source timestamp. |
| `url` | Source or detail link. |
| `source` | Upstream source name. |
| `severity` | Display hint such as `info`, `warning`, `live`, `watchlist`, `red`, or `orange`. |
| `latitude` / `longitude` | Optional coordinates for map rendering. |

Aircraft and vessel feeds include extra movement fields such as callsign, ICAO24, MMSI, speed, altitude, heading, course, and track when available.

## 🧠 Caching And Backups

Worldwatcher uses several layers to keep the UI useful during feed outages:

- 🧩 **In-memory API cache** in `server.mjs` to avoid hammering upstream feeds.
- 💾 **Server JSON backups** written under `.data/feed-backups` by default.
- 🗃️ **Browser IndexedDB backups** so the UI can show the latest successful local snapshot if a later fetch returns empty or fails.
- 🟡 **Stale indicators** in the UI when backup data is being shown.

Backups are convenience snapshots, not an audit-grade database. A production version should store raw source payloads with fetch metadata and retention rules.

## 🛠️ Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the local Express server with Vite middleware. |
| `npm run build` | Builds the frontend with Vite. |
| `npm run preview` | Runs `server.mjs` in production mode and serves `dist`. |

## 📁 Project Structure

```text
worldwatcher/
├── DATA_FEEDS.md          # Candidate public data sources and integration notes
├── README.md              # Project guide
├── index.html             # Vite entry HTML
├── package.json           # Scripts and dependencies
├── server.mjs             # Express API, feed fetchers, parsers, cache, backups
└── src/
    ├── assets/
    │   └── ship-marker.png
    ├── main.jsx           # React app, Leaflet map, record UI
    └── styles.css         # App styling
```

## 🧪 Feed Pulls Seen Working

The following record counts were previously pulled successfully through the local server:

| Feed | Records |
|---|---:|
| OpenSky aircraft states | 100 |
| AISStream vessel reports | 100 |
| GDELT conflict/news coverage | 25 |
| HDX conflict/security/displacement datasets | 25 |
| GDACS global alerts | 25 |
| USGS significant earthquakes | 7 |
| NWS active alerts | 25 |
| CISA Known Exploited Vulnerabilities | 25 |
| UN Security Council sanctions | 25 |
| OFAC SDN sanctions | 25 |

Counts vary by time, credentials, bounding boxes, upstream availability, rate limits, and whether backup data is being served.

## ⚠️ Accuracy And Safety Notes

- Public aircraft and vessel feeds are not complete military tracking systems.
- ADS-B and AIS can be disabled, blocked, spoofed, delayed, filtered, or missing.
- News-derived data can duplicate stories, misread locations, or amplify inaccurate reporting.
- Sanctions lists and cyber vulnerability catalogs are strategic context, not live incident confirmation.
- Natural hazards and public alerts should not be interpreted as conflict events without corroboration.
- Source links should be inspected before drawing conclusions.
- Production use needs clear rate-limit handling, source licensing review, raw-data retention, provenance, and monitoring.

## 🧩 Troubleshooting

| Problem | What to check |
|---|---|
| OpenSky shows an error | Confirm `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, and `OPENSKY_BBOX`. Try a smaller bounding box. |
| AISStream has no vessels | Confirm `AISSTREAM_API_KEY` and `AISSTREAM_BOUNDING_BOXES_JSON`. The WebSocket may need time to collect messages. |
| A feed shows `B` or backup state | The live pull failed or returned empty, so Worldwatcher is showing a saved snapshot. |
| Browser shows no records | Check the server terminal for feed errors and confirm the app is open on the same port as `server.mjs`. |
| Build fails | Run `npm install`, then `npm run build`, and check Node/npm versions. |

## 🛣️ Future Roadmap

Ideas to add next:

- 🧱 **Tiled polling** for OpenSky and other large geospatial feeds so broad areas do not time out.
- 🗄️ **Persistent database storage** with raw payloads, normalized records, fetch history, and replay.
- 🧭 **Timeline playback** for seeing how aircraft, vessels, alerts, and reports changed over time.
- 🧬 **Deduplication and clustering** for news stories, alerts, and repeated source records.
- 📍 **Geocoding and confidence scores** for records that only include place names.
- 🧪 **Source reliability scoring** and stronger provenance display.
- 🔔 **Watch zones and alerts** for user-defined regions, keywords, vessels, aircraft, or severity levels.
- 🛰️ **More public layers**, such as ADSB.lol, Airplanes.live, NASA FIRMS, ReliefWeb, UNHCR, ACLED, OpenSanctions, OurAirports, and OSM reference data where licensing and access allow.
- 🌐 **Region presets** for Europe, Middle East, Black Sea, Indo-Pacific, North America, and custom bounding boxes.
- 🧑‍💻 **Admin/config UI** for feeds, credentials status, polling intervals, and backup health.
- 📤 **Export tools** for CSV/JSON snapshots and shareable filtered views.
- 🧪 **Automated tests** for feed parsers and API fallback behavior.
- 📊 **Operational health panel** showing upstream latency, cache age, backup age, and feed errors.
- 🔐 **Production hardening** with authentication, rate limiting, secret management, and deployment documentation.

## 🤝 Development Notes

When adding a new feed:

1. Add the feed metadata to `FEEDS` in `server.mjs`.
2. Create a parser that returns normalized records.
3. Keep browser secrets out of `src/`; use the server for keyed APIs.
4. Add coordinates when the source provides reliable latitude/longitude.
5. Add UI marker context in `src/main.jsx` if the feed should appear on the map with a specific marker type.
6. Document the source, caveats, and licensing notes in `DATA_FEEDS.md`.

## 📄 License

No license file is currently included. Add one before publishing or accepting external contributions.
