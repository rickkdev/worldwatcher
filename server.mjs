import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const app = express();
const port = Number(process.env.PORT || 5173);
const cache = new Map();
const cacheTtlMs = 5 * 60 * 1000;
const requestTimeoutMs = 25 * 1000;
const openSkyRequestTimeoutMs = Number(process.env.OPENSKY_TIMEOUT_MS || 60_000);
const backupDir = path.join(__dirname, process.env.FEED_BACKUP_DIR || '.data/feed-backups');
const modActivityDir = path.join(__dirname, process.env.MOD_ACTIVITY_DIR || '.data/mod-activity');
const aisMaxVessels = Number(process.env.AISSTREAM_MAX_VESSELS || 10000);
const modActivityRadiusM = Number(process.env.MOD_ACTIVITY_RADIUS_M || 750);
const modActivityLimit = Number(process.env.MOD_ACTIVITY_LIMIT || 10);
const modActivityMediumSpikePct = Number(process.env.MOD_ACTIVITY_MEDIUM_SPIKE_PCT || 50);
const modActivityHighSpikePct = Number(process.env.MOD_ACTIVITY_HIGH_SPIKE_PCT || 150);
const modActivityMediumDeltaScore = Number(process.env.MOD_ACTIVITY_MEDIUM_DELTA_SCORE || 5);
const modActivityHighDeltaScore = Number(process.env.MOD_ACTIVITY_HIGH_DELTA_SCORE || 12);
const overpassTimeoutMs = Number(process.env.OVERPASS_TIMEOUT_MS || 6000);
const overpassEndpoints = String(
  process.env.OVERPASS_ENDPOINTS ||
  'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.openstreetmap.ru/api/interpreter',
).split(',').map((endpoint) => endpoint.trim()).filter(Boolean);
const openSkyToken = { value: null, expiresAt: 0 };
const aisVessels = new Map();
const aisStatus = { connected: false, lastMessageAt: null, error: null };
let aisSocket = null;
let modActivityRefreshPromise = null;

const FEEDS = [
  {
    id: 'opensky',
    name: 'OpenSky Aircraft',
    category: 'Aircraft tracking',
    sourceUrl: 'https://opensky-network.org/api/states/all',
    handler: fetchOpenSkyFeed,
    ttlMs: 30 * 1000,
    keyed: true,
  },
  {
    id: 'aisstream',
    name: 'AISStream Vessels',
    category: 'Maritime tracking',
    sourceUrl: 'wss://stream.aisstream.io/v0/stream',
    handler: fetchAisStreamFeed,
    ttlMs: 5 * 1000,
    keyed: true,
  },
  {
    id: 'gdelt',
    name: 'GDELT Conflict Coverage',
    category: 'News-derived events',
    url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=(military%20OR%20defense%20OR%20airstrike%20OR%20missile%20OR%20drone%20OR%20border%20OR%20conflict)&mode=artlist&format=json&maxrecords=25&sort=hybridrel',
    parser: parseGdelt,
  },
  {
    id: 'hdx',
    name: 'HDX Conflict Datasets',
    category: 'Humanitarian datasets',
    url: 'https://data.humdata.org/api/3/action/package_search?q=conflict%20security%20displacement&rows=25',
    parser: parseHdx,
  },
  {
    id: 'mod-activity',
    name: 'MOD Restaurant Activity',
    category: 'OSINT activity proxy',
    sourceUrl: 'Wikidata SPARQL + Overpass API',
    handler: fetchModActivityFeed,
    ttlMs: 0,
  },
  {
    id: 'gdacs',
    name: 'GDACS Global Alerts',
    category: 'Disaster/crisis alerts',
    url: () =>
      `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventtypes=EQ,TC,FL,VO,DR&fromDate=${lastMonthDate()}&alertlevel=Green;Orange;Red`,
    parser: parseGdacs,
  },
  {
    id: 'usgs',
    name: 'USGS Significant Earthquakes',
    category: 'Seismic events',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson',
    parser: parseUsgs,
  },
  {
    id: 'nws',
    name: 'NWS Active Alerts',
    category: 'U.S. public alerts',
    url: 'https://api.weather.gov/alerts/active?status=actual&message_type=alert',
    parser: parseNws,
  },
  {
    id: 'cisa-kev',
    name: 'CISA Known Exploited Vulnerabilities',
    category: 'Cyber threat context',
    url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
    parser: parseCisaKev,
  },
  {
    id: 'un-sanctions',
    name: 'UN Security Council Sanctions',
    category: 'Sanctions/economic pressure',
    url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
    parser: parseUnSanctions,
    text: true,
  },
  {
    id: 'ofac-sdn',
    name: 'OFAC SDN Sanctions',
    category: 'Sanctions/economic pressure',
    url: 'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv',
    parser: parseOfacSdnCsv,
    text: true,
  },
];

const COUNTRY_CENTROIDS = {
  afghanistan: [33.9391, 67.71],
  argentina: [-38.4161, -63.6167],
  australia: [-25.2744, 133.7751],
  brazil: [-14.235, -51.9253],
  canada: [56.1304, -106.3468],
  china: [35.8617, 104.1954],
  colombia: [4.5709, -74.2973],
  congo: [-0.228, 15.8277],
  cuba: [21.5218, -77.7812],
  egypt: [26.8206, 30.8025],
  ethiopia: [9.145, 40.4897],
  france: [46.2276, 2.2137],
  germany: [51.1657, 10.4515],
  india: [20.5937, 78.9629],
  indonesia: [-0.7893, 113.9213],
  iran: [32.4279, 53.688],
  iraq: [33.2232, 43.6793],
  israel: [31.0461, 34.8516],
  italy: [41.8719, 12.5674],
  japan: [36.2048, 138.2529],
  kenya: [-0.0236, 37.9062],
  lebanon: [33.8547, 35.8623],
  libya: [26.3351, 17.2283],
  macedonia: [41.6086, 21.7453],
  malaysia: [4.2105, 101.9758],
  mali: [17.5707, -3.9962],
  mexico: [23.6345, -102.5528],
  myanmar: [21.9162, 95.956],
  niger: [17.6078, 8.0817],
  nigeria: [9.082, 8.6753],
  pakistan: [30.3753, 69.3451],
  palestine: [31.9522, 35.2332],
  philippines: [12.8797, 121.774],
  poland: [51.9194, 19.1451],
  russia: [61.524, 105.3188],
  somalia: [5.1521, 46.1996],
  sudan: [12.8628, 30.2176],
  syria: [34.8021, 38.9968],
  taiwan: [23.6978, 120.9605],
  turkey: [38.9637, 35.2433],
  ukraine: [48.3794, 31.1656],
  "united arab emirates": [23.4241, 53.8478],
  "united kingdom": [55.3781, -3.436],
  "united states": [37.0902, -95.7129],
  venezuela: [6.4238, -66.5897],
  yemen: [15.5527, 48.5164],
};

const COUNTRY_ALIASES = {
  ae: "united arab emirates",
  au: "australia",
  br: "brazil",
  ca: "canada",
  cn: "china",
  de: "germany",
  eg: "egypt",
  fr: "france",
  gb: "united kingdom",
  il: "israel",
  in: "india",
  iq: "iraq",
  ir: "iran",
  jp: "japan",
  lb: "lebanon",
  mm: "myanmar",
  mx: "mexico",
  ng: "nigeria",
  pk: "pakistan",
  ps: "palestine",
  ru: "russia",
  sd: "sudan",
  sy: "syria",
  tr: "turkey",
  tw: "taiwan",
  ua: "ukraine",
  uk: "united kingdom",
  us: "united states",
  usa: "united states",
  "united states of america": "united states",
};

app.get('/api/feeds', (_req, res) => {
  res.json(FEEDS.map(({ id, name, category, url, sourceUrl, keyed }) => ({
    id,
    name,
    category,
    url: sourceUrl || (typeof url === 'function' ? 'dynamic' : url),
    keyed: Boolean(keyed),
  })));
});

app.get('/api/feed/:id', async (req, res) => {
  const feed = FEEDS.find((item) => item.id === req.params.id);
  if (!feed) {
    res.status(404).json({ error: 'Unknown feed' });
    return;
  }

  try {
    const sourceUrl = sourceUrlFor(feed);
    const cached = cache.get(feed.id);
    if (cached && Date.now() - cached.cachedAt < (feed.ttlMs || cacheTtlMs)) {
      res.json(cached.payload);
      return;
    }

    if (feed.handler) {
      const payload = await feed.handler(feed);
      if (isEmptyPayload(payload)) {
        const backup = await readFeedBackup(feed.id, 'live feed returned no items');
        if (backup) {
          cache.set(feed.id, { cachedAt: Date.now(), payload: backup });
          res.json(backup);
          return;
        }
      }
      cache.set(feed.id, { cachedAt: Date.now(), payload });
      await writeFeedBackup(feed.id, payload);
      res.json(payload);
      return;
    }

    const response = await fetch(sourceUrl, {
      headers: {
        'Accept': feed.text ? 'application/xml,text/plain,*/*' : 'application/json,*/*',
        'User-Agent': 'worldwatcher-local-dashboard/0.1',
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const raw = feed.text ? await response.text() : await response.json();
    const items = feed.parser(raw);
    const payload = {
      id: feed.id,
      name: feed.name,
      category: feed.category,
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      items,
    };
    if (isEmptyPayload(payload)) {
      const backup = await readFeedBackup(feed.id, 'live feed returned no items');
      if (backup) {
        cache.set(feed.id, { cachedAt: Date.now(), payload: backup });
        res.json(backup);
        return;
      }
    }
    cache.set(feed.id, { cachedAt: Date.now(), payload });
    await writeFeedBackup(feed.id, payload);
    res.json(payload);
  } catch (error) {
    const backup = await readFeedBackup(feed.id, error.message);
    if (backup) {
      cache.set(feed.id, { cachedAt: Date.now(), payload: backup });
      res.json(backup);
      return;
    }

    res.status(502).json({
      id: feed.id,
      name: feed.name,
      category: feed.category,
      sourceUrl: sourceUrlFor(feed),
      fetchedAt: new Date().toISOString(),
      error: error.message,
      items: [],
    });
  }
});

if (isProduction) {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
} else {
  const vite = await import('vite');
  const viteServer = await vite.createServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(viteServer.middlewares);
}

app.listen(port, () => {
  console.log(`Worldwatcher running at http://localhost:${port}`);
});

startAisStream();

async function writeFeedBackup(feedId, payload) {
  if (isEmptyPayload(payload)) return;

  await fs.mkdir(backupDir, { recursive: true });
  const filePath = feedBackupPath(feedId);
  const tempPath = `${filePath}.tmp`;
  const backupPayload = {
    ...payload,
    backupWrittenAt: new Date().toISOString(),
  };
  await fs.writeFile(tempPath, JSON.stringify(backupPayload, null, 2));
  await fs.rename(tempPath, filePath);
}

async function readFeedBackup(feedId, reason) {
  try {
    const raw = await fs.readFile(feedBackupPath(feedId), 'utf8');
    const payload = JSON.parse(raw);
    const enrichedPayload = enrichBackupPayload(feedId, payload);
    return {
      ...enrichedPayload,
      stale: true,
      backupReason: reason,
      servedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function enrichBackupPayload(feedId, payload) {
  if (!Array.isArray(payload?.items)) return payload;

  return {
    ...payload,
    items: payload.items.map((item) => {
      if (Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))) return item;

      if (feedId === 'gdelt') {
        const coordinates = countryCoordinates(item.location);
        return coordinates
          ? {
              ...item,
              severity: item.severity === 'info' ? 'warning' : item.severity,
              latitude: coordinates[0],
              longitude: coordinates[1],
              locationPrecision: 'Country-level approximation from GDELT source country',
            }
          : item;
      }

      if (feedId === 'hdx') {
        const coordinates = countryCoordinates(item.location);
        return coordinates
          ? {
              ...item,
              latitude: coordinates[0],
              longitude: coordinates[1],
              locationPrecision: 'Country-level dataset coverage approximation',
            }
          : item;
      }

      return item;
    }),
  };
}

function feedBackupPath(feedId) {
  return path.join(backupDir, `${feedId}.latest.json`);
}

function isEmptyPayload(payload) {
  return !Array.isArray(payload?.items) || payload.items.length === 0;
}

async function fetchOpenSkyFeed(feed) {
  if (!process.env.OPENSKY_CLIENT_ID || !process.env.OPENSKY_CLIENT_SECRET) {
    throw new Error('Missing OPENSKY_CLIENT_ID or OPENSKY_CLIENT_SECRET');
  }

  const token = await getOpenSkyAccessToken();
  const sourceUrl = openSkyStatesUrl();
  const response = await fetch(sourceUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'worldwatcher-local-dashboard/0.1',
    },
    signal: AbortSignal.timeout(openSkyRequestTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    id: feed.id,
    name: feed.name,
    category: feed.category,
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    items: parseOpenSkyStates(data),
  };
}

async function getOpenSkyAccessToken() {
  if (openSkyToken.value && Date.now() < openSkyToken.expiresAt - 30_000) {
    return openSkyToken.value;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.OPENSKY_CLIENT_ID,
    client_secret: process.env.OPENSKY_CLIENT_SECRET,
  });

  const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OpenSky auth failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  openSkyToken.value = data.access_token;
  openSkyToken.expiresAt = Date.now() + Number(data.expires_in || 1800) * 1000;
  return openSkyToken.value;
}

function openSkyStatesUrl() {
  const bbox = String(process.env.OPENSKY_BBOX || '').split(',').map((value) => Number(value.trim()));
  if (bbox.length !== 4 || bbox.some((value) => Number.isNaN(value))) {
    return 'https://opensky-network.org/api/states/all';
  }

  const [lamin, lomin, lamax, lomax] = bbox;
  return `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
}

function sourceUrlFor(feed) {
  if (feed.id === 'opensky') return openSkyStatesUrl();
  return feed.sourceUrl || (typeof feed.url === 'function' ? feed.url() : feed.url);
}

function parseOpenSkyStates(data) {
  return (data.states || [])
    .filter((state) => state[5] !== null && state[6] !== null)
    .map((state) => {
      const callsign = String(state[1] || '').trim();
      const country = state[2] || 'Unknown country';
      const lastContact = state[4] ? new Date(state[4] * 1000).toISOString() : null;
      const altitude = state[13] ?? state[7];
      const speedKts = state[9] !== null ? Math.round(Number(state[9]) * 1.94384) : null;
      const track = state[10] !== null ? Math.round(Number(state[10])) : null;
      return {
        title: `${callsign || state[0]} over ${country}`,
        summary: [
          `ICAO ${state[0]}`,
          speedKts !== null ? `${speedKts} kt` : null,
          altitude !== null ? `${Math.round(Number(altitude))} m altitude` : null,
          track !== null ? `${track} deg track` : null,
          state[8] ? 'on ground' : 'airborne',
        ].filter(Boolean).join(' · '),
        location: `${Number(state[6]).toFixed(3)}, ${Number(state[5]).toFixed(3)}`,
        timestamp: lastContact,
        url: 'https://opensky-network.org/network/explorer',
        source: 'OpenSky',
        severity: state[8] ? 'info' : 'live',
        latitude: Number(state[6]),
        longitude: Number(state[5]),
        altitudeMeters: altitude !== null ? Math.round(Number(altitude)) : null,
        speedKts,
        track,
        callsign: callsign || null,
        icao24: state[0],
        onGround: Boolean(state[8]),
      };
    });
}

function fetchAisStreamFeed(feed) {
  if (!process.env.AISSTREAM_API_KEY) {
    throw new Error('Missing AISSTREAM_API_KEY');
  }

  if (!aisSocket || !aisStatus.connected) {
    startAisStream();
  }

  const items = [...aisVessels.values()]
    .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp))
    .map((vessel) => ({
      title: `${vessel.name || `MMSI ${vessel.mmsi}`} position report`,
      summary: [
        vessel.shipType ? `type ${vessel.shipType}` : null,
        vessel.speed !== null && vessel.speed !== undefined ? `${Number(vessel.speed).toFixed(1)} kt` : null,
        vessel.course !== null && vessel.course !== undefined ? `${Number(vessel.course).toFixed(0)} deg course` : null,
        vessel.heading !== null && vessel.heading !== undefined ? `${Number(vessel.heading).toFixed(0)} deg heading` : null,
      ].filter(Boolean).join(' · ') || `MMSI ${vessel.mmsi}`,
      location: vessel.latitude !== null && vessel.longitude !== null
        ? `${Number(vessel.latitude).toFixed(3)}, ${Number(vessel.longitude).toFixed(3)}`
        : 'Unknown',
      timestamp: vessel.timestamp,
      url: 'https://aisstream.io/',
      source: 'AISStream',
      severity: 'live',
      latitude: vessel.latitude,
      longitude: vessel.longitude,
      speedKts: vessel.speed !== null && vessel.speed !== undefined ? Number(vessel.speed) : null,
      course: vessel.course !== null && vessel.course !== undefined ? Number(vessel.course) : null,
      heading: vessel.heading !== null && vessel.heading !== undefined ? Number(vessel.heading) : null,
      mmsi: vessel.mmsi,
      vesselName: vessel.name || null,
      shipType: vessel.shipType || null,
    }));

  return {
    id: feed.id,
    name: feed.name,
    category: feed.category,
    sourceUrl: feed.sourceUrl,
    fetchedAt: new Date().toISOString(),
    status: aisStatus,
    items,
  };
}

async function fetchModActivityFeed(feed) {
  const sites = await fetchModSites();
  const previous = await readModActivityLatest();
  if (!modActivityRefreshPromise) {
    modActivityRefreshPromise = collectModActivityPayload(feed, sites, previous)
      .catch((error) => console.warn('MOD activity refresh failed:', error.message))
      .finally(() => {
        modActivityRefreshPromise = null;
      });
  }

  if (Array.isArray(previous.items) && previous.items.length) {
    return {
      ...previous,
      stale: true,
      refreshInProgress: true,
      servedAt: new Date().toISOString(),
      items: previous.items.map((item) => ({ ...item, refreshInProgress: true })),
    };
  }

  return {
    id: feed.id,
    name: feed.name,
    category: feed.category,
    sourceUrl: feed.sourceUrl,
    fetchedAt: new Date().toISOString(),
    refreshInProgress: true,
    items: sites.slice(0, modActivityLimit).map((site) => buildPendingModActivityItem(site)),
  };
}

async function collectModActivityPayload(feed, sites, previous) {
  const sampledSites = sites.slice(0, modActivityLimit);
  const previousById = new Map((previous.items || []).map((item) => [item.siteId, item]));
  const fetchedAt = new Date().toISOString();

  const settled = await promiseAllSettledLimit(sampledSites, 3, (site) => fetchFoodActivity(site));
  const items = settled.map((result, index) => {
    const site = sampledSites[index];
    if (result.status === 'fulfilled') {
      const previousItem = previousById.get(site.siteId);
      return buildModActivityItem(site, result.value, previousItem, fetchedAt);
    }

    const previousItem = previousById.get(site.siteId);
    return buildModActivityItem(
      site,
      {
        error: result.reason?.message || 'Unable to fetch nearby restaurant activity',
        restaurants: previousItem?.restaurants || [],
        restaurantCount: previousItem?.restaurantCount || 0,
        deliveryTaggedCount: previousItem?.deliveryTaggedCount || 0,
        recentlyEditedCount: previousItem?.recentlyEditedCount || 0,
      },
      previousItem,
      fetchedAt,
    );
  });

  const payload = {
    id: feed.id,
    name: feed.name,
    category: feed.category,
    sourceUrl: feed.sourceUrl,
    fetchedAt,
    items,
  };

  await writeModActivityHistory(payload, previous);
  return payload;
}

function buildPendingModActivityItem(site) {
  return {
    siteId: site.siteId,
    title: site.title,
    summary: `Restaurant activity lookup pending within ${modActivityRadiusM} m.`,
    location: site.country,
    timestamp: new Date().toISOString(),
    url: site.website || site.sourceUrl,
    source: 'Wikidata + Overpass',
    severity: 'low',
    latitude: site.latitude,
    longitude: site.longitude,
    country: site.country,
    radiusMeters: modActivityRadiusM,
    activityLevel: 'low',
    activityScore: 0,
    restaurantCount: 0,
    deliveryTaggedCount: 0,
    recentlyEditedCount: 0,
    activityDelta: null,
    restaurants: [],
    sourceUrl: site.sourceUrl,
    website: site.website,
    locationPrecision: site.locationPrecision,
    refreshInProgress: true,
  };
}

async function fetchModSites() {
  const configured = await readConfiguredModSites();
  if (configured.length) return configured;
  if (process.env.MOD_ACTIVITY_DISCOVER_WIKIDATA !== 'true') return seedModSites();

  const query = `
    SELECT ?item ?itemLabel ?countryLabel ?coord ?website WHERE {
      ?item rdfs:label ?itemLabel.
      FILTER(LANG(?itemLabel) = "en")
      FILTER(
        CONTAINS(LCASE(?itemLabel), "ministry of defence") ||
        CONTAINS(LCASE(?itemLabel), "ministry of defense") ||
        CONTAINS(LCASE(?itemLabel), "department of defence") ||
        CONTAINS(LCASE(?itemLabel), "department of defense")
      )
      OPTIONAL { ?item wdt:P17 ?country. }
      OPTIONAL { ?item wdt:P625 ?coord. }
      OPTIONAL { ?item wdt:P856 ?website. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 200
  `;

  try {
    const response = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`, {
      headers: {
        Accept: 'application/sparql-results+json,application/json',
        'User-Agent': 'worldwatcher-local-dashboard/0.1 (local OSINT dashboard)',
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    const sites = (data.results?.bindings || [])
      .map(wikidataModBindingToSite)
      .filter(Boolean);

    const deduped = dedupeBy(sites, (site) => site.siteId);
    if (deduped.length) return deduped;
  } catch (error) {
    console.warn('Unable to load MOD sites from Wikidata, using seed list:', error.message);
  }

  return seedModSites();
}

async function readConfiguredModSites() {
  if (!process.env.MOD_ACTIVITY_SITES_JSON) return [];

  try {
    const raw = await fs.readFile(path.resolve(__dirname, process.env.MOD_ACTIVITY_SITES_JSON), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.map(configuredModSiteToSite).filter(Boolean) : [];
  } catch (error) {
    console.warn('Unable to read MOD_ACTIVITY_SITES_JSON:', error.message);
    return [];
  }
}

function wikidataModBindingToSite(binding) {
  const coords = pointToCoordinates(binding.coord?.value);
  if (!coords) return null;

  const name = binding.itemLabel?.value;
  if (!name) return null;

  const country = binding.countryLabel?.value || 'Unknown country';
  return {
    siteId: stableSiteId(`${country}-${name}`),
    title: name,
    country,
    latitude: coords[0],
    longitude: coords[1],
    sourceUrl: binding.item?.value,
    website: binding.website?.value || null,
    locationPrecision: 'Wikidata coordinate',
  };
}

function configuredModSiteToSite(site) {
  const latitude = Number(site.latitude);
  const longitude = Number(site.longitude);
  if (!site.title || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    siteId: stableSiteId(site.siteId || `${site.country || ''}-${site.title}`),
    title: site.title,
    country: site.country || 'Unknown country',
    latitude,
    longitude,
    sourceUrl: site.sourceUrl || null,
    website: site.website || null,
    locationPrecision: site.locationPrecision || 'Configured coordinate',
  };
}

async function fetchFoodActivity(site) {
  const query = `
    [out:json][timeout:18];
    (
      node(around:${modActivityRadiusM},${site.latitude},${site.longitude})["amenity"~"^(restaurant|fast_food|cafe|food_court)$"];
      way(around:${modActivityRadiusM},${site.latitude},${site.longitude})["amenity"~"^(restaurant|fast_food|cafe|food_court)$"];
      relation(around:${modActivityRadiusM},${site.latitude},${site.longitude})["amenity"~"^(restaurant|fast_food|cafe|food_court)$"];
    );
    out center tags meta 80;
  `;

  const data = await fetchOverpassJson(query);
  const restaurants = (data.elements || []).map(overpassFoodElement).filter(Boolean);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  return {
    restaurants,
    restaurantCount: restaurants.length,
    deliveryTaggedCount: restaurants.filter((item) => item.delivery || item.takeaway).length,
    recentlyEditedCount: restaurants.filter((item) => timestampValue(item.updatedAt) >= cutoff).length,
  };
}

async function fetchOverpassJson(query) {
  const errors = [];
  for (const endpoint of overpassEndpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
          'User-Agent': 'worldwatcher-local-dashboard/0.1 (local OSINT dashboard)',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(overpassTimeoutMs),
      });

      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    } catch (error) {
      errors.push(`${endpoint.replace(/^https?:\/\//, '')}: ${error.message}`);
    }
  }

  throw new Error(`Overpass unavailable (${errors.join('; ')})`);
}

function overpassFoodElement(element) {
  const tags = element.tags || {};
  const latitude = firstNumber(element.lat, element.center?.lat);
  const longitude = firstNumber(element.lon, element.center?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    id: `${element.type}/${element.id}`,
    name: tags.name || tags.brand || tags.amenity || 'Unnamed food POI',
    amenity: tags.amenity || null,
    cuisine: tags.cuisine || null,
    delivery: tags.delivery || null,
    takeaway: tags.takeaway || null,
    openingHours: tags.opening_hours || null,
    updatedAt: element.timestamp || null,
    latitude,
    longitude,
  };
}

function buildModActivityItem(site, activity, previousItem, fetchedAt) {
  const metrics = modActivityMetrics(activity, previousItem);
  const delta = previousItem ? {
    restaurantCount: activity.restaurantCount - Number(previousItem.restaurantCount || 0),
    deliveryTaggedCount: activity.deliveryTaggedCount - Number(previousItem.deliveryTaggedCount || 0),
    recentlyEditedCount: activity.recentlyEditedCount - Number(previousItem.recentlyEditedCount || 0),
    activityScore: metrics.deltaScore,
    spikePercent: metrics.spikePercent,
    activityLevelChanged: previousItem.activityLevel && previousItem.activityLevel !== metrics.activityLevel,
  } : null;

  return {
    siteId: site.siteId,
    title: site.title,
    summary: activity.error && previousItem
      ? `Using previous public restaurant activity proxy values; live Overpass refresh unavailable: ${activity.error}.`
      : activity.error
      ? `Public restaurant activity proxy unavailable: ${activity.error}.`
      : `${activity.restaurantCount} public food POIs within ${modActivityRadiusM} m; ${activity.deliveryTaggedCount} tagged for delivery/takeaway.`,
    location: site.country,
    timestamp: fetchedAt,
    url: site.website || site.sourceUrl,
    source: 'Wikidata + Overpass',
    severity: metrics.activityLevel,
    latitude: site.latitude,
    longitude: site.longitude,
    country: site.country,
    radiusMeters: modActivityRadiusM,
    activityLevel: metrics.activityLevel,
    activityScore: metrics.currentScore,
    baselineScore: metrics.previousScore,
    spikePercent: metrics.spikePercent,
    restaurantCount: activity.restaurantCount,
    deliveryTaggedCount: activity.deliveryTaggedCount,
    recentlyEditedCount: activity.recentlyEditedCount,
    activityDelta: delta,
    restaurants: activity.restaurants.slice(0, 20),
    sourceUrl: site.sourceUrl,
    website: site.website,
    locationPrecision: site.locationPrecision,
    collectionError: activity.error || null,
  };
}

function modActivityMetrics(activity, previousItem) {
  const currentScore = modActivityScore(activity);
  const previousScore = previousItem ? modActivityScore(previousItem) : currentScore;
  const deltaScore = previousItem ? currentScore - previousScore : 0;
  const spikePercent = previousItem && previousScore > 0
    ? Math.round((deltaScore / previousScore) * 100)
    : 0;

  let activityLevel = 'low';
  if (
    previousItem &&
    deltaScore >= modActivityHighDeltaScore &&
    spikePercent >= modActivityHighSpikePct
  ) {
    activityLevel = 'high';
  } else if (
    previousItem &&
    deltaScore >= modActivityMediumDeltaScore &&
    spikePercent >= modActivityMediumSpikePct
  ) {
    activityLevel = 'medium';
  }

  return {
    activityLevel,
    currentScore,
    previousScore,
    deltaScore,
    spikePercent,
  };
}

function modActivityScore(item) {
  return (
    Math.min(Number(item.restaurantCount || 0), 30) +
    Number(item.deliveryTaggedCount || 0) * 2 +
    Number(item.recentlyEditedCount || 0) * 2
  );
}

async function writeModActivityHistory(payload, previous) {
  await fs.mkdir(modActivityDir, { recursive: true });
  const latestPath = path.join(modActivityDir, 'latest.json');
  const eventsPath = path.join(modActivityDir, 'changes.jsonl');
  const previousById = new Map((previous.items || []).map((item) => [item.siteId, item]));
  const events = payload.items
    .map((item) => modActivityChangeEvent(item, previousById.get(item.siteId), payload.fetchedAt))
    .filter(Boolean);

  await fs.writeFile(latestPath, JSON.stringify(payload, null, 2));
  if (events.length) {
    await fs.appendFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  }
}

async function readModActivityLatest() {
  try {
    const raw = await fs.readFile(path.join(modActivityDir, 'latest.json'), 'utf8');
    const payload = JSON.parse(raw);
    return normalizeModActivityPayload(payload);
  } catch {
    return { items: [] };
  }
}

function normalizeModActivityPayload(payload) {
  if (!Array.isArray(payload?.items)) return payload;

  return {
    ...payload,
    items: payload.items.map((item) => {
      const metrics = modActivityMetrics(item, null);
      return {
        ...item,
        activityLevel: 'low',
        severity: 'low',
        activityScore: metrics.currentScore,
        baselineScore: item.baselineScore ?? metrics.previousScore,
        spikePercent: item.spikePercent ?? 0,
      };
    }),
  };
}

function modActivityChangeEvent(item, previous, observedAt) {
  if (!previous) {
    return {
      observedAt,
      siteId: item.siteId,
      title: item.title,
      changeType: 'created',
      current: modActivityComparable(item),
    };
  }

  const before = modActivityComparable(previous);
  const current = modActivityComparable(item);
  const changed = Object.keys(current).filter((key) => current[key] !== before[key]);
  if (!changed.length) return null;

  return {
    observedAt,
    siteId: item.siteId,
    title: item.title,
    changeType: 'updated',
    changed,
    before,
    current,
  };
}

function modActivityComparable(item) {
  return {
    activityLevel: item.activityLevel,
    activityScore: item.activityScore,
    restaurantCount: item.restaurantCount,
    deliveryTaggedCount: item.deliveryTaggedCount,
    recentlyEditedCount: item.recentlyEditedCount,
    collectionError: item.collectionError || null,
  };
}

function startAisStream() {
  if (!process.env.AISSTREAM_API_KEY || aisSocket?.readyState === WebSocket.OPEN || aisSocket?.readyState === WebSocket.CONNECTING) {
    return;
  }

  aisSocket = new WebSocket('wss://stream.aisstream.io/v0/stream');
  aisSocket.on('open', () => {
    aisStatus.connected = true;
    aisStatus.error = null;
    aisSocket.send(JSON.stringify({
      APIKey: process.env.AISSTREAM_API_KEY,
      BoundingBoxes: parseBoundingBoxes(),
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }));
  });

  aisSocket.on('message', (raw) => {
    try {
      ingestAisMessage(JSON.parse(raw.toString()));
      aisStatus.lastMessageAt = new Date().toISOString();
    } catch (error) {
      aisStatus.error = error.message;
    }
  });

  aisSocket.on('close', () => {
    aisStatus.connected = false;
    setTimeout(startAisStream, 5000);
  });

  aisSocket.on('error', (error) => {
    aisStatus.connected = false;
    aisStatus.error = error.message;
  });
}

function ingestAisMessage(data) {
  const metadata = data.MetaData || {};
  const position = data.Message?.PositionReport || {};
  const staticData = data.Message?.ShipStaticData || {};
  const mmsi = String(metadata.MMSI || position.UserID || staticData.UserID || '');
  if (!mmsi) return;

  const existing = aisVessels.get(mmsi) || { mmsi };
  const latitude = firstNumber(position.Latitude, metadata.latitude, metadata.Latitude, existing.latitude);
  const longitude = firstNumber(position.Longitude, metadata.longitude, metadata.Longitude, existing.longitude);
  aisVessels.set(mmsi, {
    ...existing,
    mmsi,
    name: cleanShipName(staticData.Name || metadata.ShipName || existing.name),
    shipType: staticData.Type || existing.shipType,
    latitude,
    longitude,
    speed: firstNumber(position.Sog, position.SpeedOverGround, existing.speed),
    course: firstNumber(position.Cog, position.CourseOverGround, existing.course),
    heading: firstNumber(position.TrueHeading, existing.heading),
    timestamp: metadata.time_utc || metadata.Time_UTC || new Date().toISOString(),
  });

  if (aisVessels.size > aisMaxVessels) {
    const pruneCount = Math.max(1, Math.floor(aisMaxVessels * 0.1));
    const stale = [...aisVessels.entries()].sort((a, b) => timestampValue(a[1].timestamp) - timestampValue(b[1].timestamp)).slice(0, pruneCount);
    stale.forEach(([key]) => aisVessels.delete(key));
  }
}

function parseGdelt(data) {
  return (data.articles || []).slice(0, 25).map((article) => {
    const coordinates = countryCoordinates(article.sourcecountry);
    return {
      title: article.title || 'Untitled article',
      summary: article.seendate ? `Seen ${formatCompactDate(article.seendate)} from ${article.domain || 'unknown source'}.` : article.domain || '',
      location: article.sourcecountry || article.domain || 'Unknown',
      timestamp: article.seendate || null,
      url: article.url,
      source: article.domain || 'GDELT',
      severity: 'warning',
      latitude: coordinates?.[0] ?? null,
      longitude: coordinates?.[1] ?? null,
      locationPrecision: coordinates ? 'Country-level approximation from GDELT source country' : null,
    };
  });
}

function parseHdx(data) {
  return (data.result?.results || []).slice(0, 25).map((dataset) => {
    const organizations = [dataset.organization?.title, dataset.dataset_source].filter(Boolean).join(' / ');
    const location = dataset.groups?.map((group) => group.display_name || group.name).filter(Boolean).join(', ') || 'Global';
    const coordinates = countryCoordinates(location);
    return {
      title: dataset.title || dataset.name || 'Untitled HDX dataset',
      summary: stripHtml(dataset.notes || dataset.license_other || '').slice(0, 320),
      location,
      timestamp: dataset.last_modified || dataset.metadata_modified || null,
      url: dataset.url || `https://data.humdata.org/dataset/${dataset.name}`,
      source: organizations || 'HDX',
      severity: 'info',
      latitude: coordinates?.[0] ?? null,
      longitude: coordinates?.[1] ?? null,
      locationPrecision: coordinates ? 'Country-level dataset coverage approximation' : null,
    };
  });
}

function parseGdacs(data) {
  return (data.features || []).slice(0, 25).map((feature) => {
    const props = feature.properties || {};
    const coordinates = geoJsonCoordinates(feature.geometry);
    return {
      title: props.name || props.eventname || `${props.eventtype || 'Alert'} event`,
      summary: `${props.eventtype || 'GDACS'} alert level ${props.alertlevel || 'unknown'}${props.severitydata ? `, severity ${props.severitydata}` : ''}.`,
      location: props.country || props.iso3 || 'Unknown',
      timestamp: props.fromdate || props.todate || null,
      url: props.url?.report || props.url?.geometry || 'https://www.gdacs.org/',
      source: 'GDACS',
      severity: String(props.alertlevel || 'info').toLowerCase(),
      latitude: coordinates?.[0] ?? null,
      longitude: coordinates?.[1] ?? null,
      locationPrecision: coordinates ? 'Source geometry' : null,
    };
  });
}

function parseUsgs(data) {
  return (data.features || []).map((feature) => {
    const props = feature.properties || {};
    const coordinates = geoJsonCoordinates(feature.geometry);
    return {
      title: props.title || 'Earthquake',
      summary: `Magnitude ${props.mag ?? 'unknown'} earthquake. Status: ${props.status || 'unknown'}.`,
      location: props.place || 'Unknown',
      timestamp: props.time ? new Date(props.time).toISOString() : null,
      url: props.url,
      source: 'USGS',
      severity: props.tsunami ? 'warning' : 'info',
      latitude: coordinates?.[0] ?? null,
      longitude: coordinates?.[1] ?? null,
      locationPrecision: coordinates ? 'Source epicenter geometry' : null,
    };
  });
}

function parseNws(data) {
  return (data.features || []).slice(0, 25).map((feature) => {
    const props = feature.properties || {};
    const coordinates = geoJsonCoordinates(feature.geometry);
    return {
      title: props.headline || props.event || 'NWS Alert',
      summary: stripHtml(props.description || props.instruction || '').slice(0, 320),
      location: props.areaDesc || 'United States',
      timestamp: props.sent || props.effective || null,
      url: props['@id'] || 'https://api.weather.gov/alerts/active',
      source: props.senderName || 'NWS',
      severity: String(props.severity || 'info').toLowerCase(),
      latitude: coordinates?.[0] ?? null,
      longitude: coordinates?.[1] ?? null,
      locationPrecision: coordinates ? 'Approximate center of source alert geometry' : null,
    };
  });
}

function parseCisaKev(data) {
  return (data.vulnerabilities || []).slice(0, 25).map((item) => ({
    title: `${item.cveID}: ${item.vulnerabilityName}`,
    summary: `${item.vendorProject || 'Unknown vendor'} ${item.product || ''}. ${item.shortDescription || ''}`.trim(),
    location: 'Cyber',
    timestamp: item.dateAdded || null,
    url: `https://nvd.nist.gov/vuln/detail/${item.cveID}`,
    source: 'CISA KEV',
    severity: 'warning',
  }));
}

function parseUnSanctions(xml) {
  const entries = [...xml.matchAll(/<(INDIVIDUAL|ENTITY)>[\s\S]*?<\/\1>/g)].slice(0, 25);
  return entries.map((match) => {
    const chunk = match[0];
    const type = match[1] === 'ENTITY' ? 'Entity' : 'Individual';
    const name =
      getXmlValue(chunk, 'FIRST_NAME') ||
      getXmlValue(chunk, 'NAME_ORIGINAL_SCRIPT') ||
      getXmlValue(chunk, 'DATAID') ||
      'Sanctions listing';
    const second = getXmlValue(chunk, 'SECOND_NAME');
    const unListType = getXmlValue(chunk, 'UN_LIST_TYPE');
    const listedOn = getXmlValue(chunk, 'LISTED_ON');
    return {
      title: `${type}: ${[name, second].filter(Boolean).join(' ')}`,
      summary: `UN sanctions list${unListType ? `: ${unListType}` : ''}.`,
      location: getXmlValue(chunk, 'NATIONALITY') || getXmlValue(chunk, 'COUNTRY') || 'Global',
      timestamp: listedOn || null,
      url: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list',
      source: 'UN Security Council',
      severity: 'watchlist',
    };
  });
}

function parseOfacSdnCsv(csv) {
  return csv.split(/\r?\n/).filter(Boolean).slice(0, 25).map((line) => {
    const columns = parseCsvLine(line);
    const name = cleanOfacValue(columns[1]) || 'Sanctions listing';
    const type = cleanOfacValue(columns[2]) || 'SDN';
    const programs = cleanOfacValue(columns[3]);
    const country = cleanOfacValue(columns[11]) || cleanOfacValue(columns[9]);
    return {
      title: `${type}: ${name}`,
      summary: programs ? `OFAC sanctions programs: ${programs}.` : 'OFAC Specially Designated Nationals listing.',
      location: country || 'Global',
      timestamp: null,
      url: 'https://ofac.treasury.gov/specially-designated-nationals-list-data-formats-data-schemas',
      source: 'OFAC',
      severity: 'watchlist',
    };
  });
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  result.push(current.trim());
  return result;
}

function cleanOfacValue(value) {
  const cleaned = String(value || '').replace(/^"|"$/g, '').trim();
  return cleaned === '-0-' ? '' : cleaned;
}

function getXmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeEntities(stripHtml(match[1])).trim() : '';
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function formatCompactDate(value) {
  const parsed = String(value).replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1-$2-$3T$4:$5:$6Z',
  );
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function geoJsonCoordinates(geometry) {
  const pairs = coordinatePairs(geometry?.coordinates);
  if (!pairs.length) return null;

  const totals = pairs.reduce(
    (current, pair) => ({
      latitude: current.latitude + pair[1],
      longitude: current.longitude + pair[0],
    }),
    { latitude: 0, longitude: 0 },
  );

  return [totals.latitude / pairs.length, totals.longitude / pairs.length];
}

function coordinatePairs(value) {
  if (!Array.isArray(value)) return [];
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    return [[Number(value[0]), Number(value[1])]];
  }

  return value.flatMap((item) => coordinatePairs(item));
}

function countryCoordinates(value) {
  const candidates = String(value || '')
    .split(/[,;/|]/)
    .map((item) => normalizeCountryName(item))
    .filter(Boolean);

  for (const candidate of candidates) {
    const alias = COUNTRY_ALIASES[candidate] || candidate;
    if (COUNTRY_CENTROIDS[alias]) return COUNTRY_CENTROIDS[alias];
  }

  return null;
}

function normalizeCountryName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\bdemocratic republic of\b/g, ' ')
    .replace(/\bfederal republic of\b/g, ' ')
    .replace(/\brepublic of\b/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastMonthDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString().slice(0, 10);
}

function parseBoundingBoxes() {
  try {
    return JSON.parse(process.env.AISSTREAM_BOUNDING_BOXES_JSON || '[[[-90,-180],[90,180]]]');
  } catch {
    return [[[-90, -180], [90, 180]]];
  }
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function cleanShipName(value) {
  const cleaned = String(value || '').replace(/@/g, '').trim();
  return cleaned || null;
}

function pointToCoordinates(value) {
  const match = String(value || '').match(/Point\((-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)/);
  if (!match) return null;

  const longitude = Number(match[1]);
  const latitude = Number(match[2]);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] : null;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function promiseAllSettledLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runNext() {
    const currentIndex = index;
    index += 1;
    if (currentIndex >= items.length) return;

    try {
      results[currentIndex] = { status: 'fulfilled', value: await worker(items[currentIndex], currentIndex) };
    } catch (error) {
      results[currentIndex] = { status: 'rejected', reason: error };
    }

    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

function stableSiteId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function seedModSites() {
  return [
    ['United States Department of Defense', 'United States', 38.8719, -77.0563, 'https://www.defense.gov/'],
    ['UK Ministry of Defence', 'United Kingdom', 51.5048, -0.1266, 'https://www.gov.uk/government/organisations/ministry-of-defence'],
    ['Federal Ministry of Defence', 'Germany', 52.5203, 13.3736, 'https://www.bmvg.de/'],
    ['Ministry of the Armed Forces', 'France', 48.8569, 2.3205, 'https://www.defense.gouv.fr/'],
    ['Ministry of Defence', 'Italy', 41.9026, 12.4863, 'https://www.difesa.it/'],
    ['Ministry of Defence', 'India', 28.6139, 77.2090, 'https://mod.gov.in/'],
    ['Ministry of Defense', 'Japan', 35.6940, 139.7356, 'https://www.mod.go.jp/'],
    ['Ministry of National Defense', 'China', 39.9042, 116.4074, 'http://eng.mod.gov.cn/'],
    ['Department of Defence', 'Australia', -35.2809, 149.1300, 'https://www.defence.gov.au/'],
    ['Department of National Defence', 'Canada', 45.4215, -75.6972, 'https://www.canada.ca/en/department-national-defence.html'],
  ].map(([title, country, latitude, longitude, website]) => ({
    siteId: stableSiteId(`${country}-${title}`),
    title,
    country,
    latitude,
    longitude,
    website,
    sourceUrl: website,
    locationPrecision: 'Seed coordinate',
  }));
}

function timestampValue(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}
