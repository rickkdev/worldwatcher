# Worldwatcher

Text-first public situational-awareness dashboard built with Vite and React.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Local Secrets

Runtime credentials live in `.env`, which is ignored by git. Use `.env.example` as the template.

Required for keyed live tracking:

- `OPENSKY_CLIENT_ID`
- `OPENSKY_CLIENT_SECRET`
- `OPENSKY_BBOX`
- `AISSTREAM_API_KEY`
- `AISSTREAM_BOUNDING_BOXES_JSON`

`OPENSKY_BBOX` is `lamin,lomin,lamax,lomax`. The local default is `35,-15,72,45`, which covers much of Europe, North Africa, and West Asia. The full global OpenSky states call can time out, so keep this bounded until we add tiled polling.

## Current Text Feeds

Keyed:

- OpenSky aircraft states
- AISStream vessel position reports

No-key:

- GDELT conflict/news coverage
- HDX conflict/security/displacement dataset search
- GDACS global disaster and crisis alerts
- USGS significant earthquakes
- NWS active U.S. public alerts
- CISA Known Exploited Vulnerabilities
- UN Security Council sanctions
- OFAC SDN sanctions

The app uses a local Node API layer in `server.mjs` so the browser can read public feeds without CORS failures. Results are normalized into text cards with source, location, timestamp, summary, and source link fields.

## Tested Pulls

The following feeds were pulled successfully through the local server:

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
