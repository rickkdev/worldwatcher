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
const aisMaxVessels = Number(process.env.AISSTREAM_MAX_VESSELS || 10000);
const openSkyToken = { value: null, expiresAt: 0 };
const aisVessels = new Map();
const aisStatus = { connected: false, lastMessageAt: null, error: null };
let aisSocket = null;

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
    return {
      ...payload,
      stale: true,
      backupReason: reason,
      servedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
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
  return (data.articles || []).slice(0, 25).map((article) => ({
    title: article.title || 'Untitled article',
    summary: article.seendate ? `Seen ${formatCompactDate(article.seendate)} from ${article.domain || 'unknown source'}.` : article.domain || '',
    location: article.sourcecountry || article.domain || 'Unknown',
    timestamp: article.seendate || null,
    url: article.url,
    source: article.domain || 'GDELT',
    severity: 'info',
  }));
}

function parseHdx(data) {
  return (data.result?.results || []).slice(0, 25).map((dataset) => {
    const organizations = [dataset.organization?.title, dataset.dataset_source].filter(Boolean).join(' / ');
    return {
      title: dataset.title || dataset.name || 'Untitled HDX dataset',
      summary: stripHtml(dataset.notes || dataset.license_other || '').slice(0, 320),
      location: dataset.groups?.map((group) => group.display_name || group.name).join(', ') || 'Global',
      timestamp: dataset.last_modified || dataset.metadata_modified || null,
      url: dataset.url || `https://data.humdata.org/dataset/${dataset.name}`,
      source: organizations || 'HDX',
      severity: 'info',
    };
  });
}

function parseGdacs(data) {
  return (data.features || []).slice(0, 25).map((feature) => {
    const props = feature.properties || {};
    return {
      title: props.name || props.eventname || `${props.eventtype || 'Alert'} event`,
      summary: `${props.eventtype || 'GDACS'} alert level ${props.alertlevel || 'unknown'}${props.severitydata ? `, severity ${props.severitydata}` : ''}.`,
      location: props.country || props.iso3 || 'Unknown',
      timestamp: props.fromdate || props.todate || null,
      url: props.url?.report || props.url?.geometry || 'https://www.gdacs.org/',
      source: 'GDACS',
      severity: String(props.alertlevel || 'info').toLowerCase(),
    };
  });
}

function parseUsgs(data) {
  return (data.features || []).map((feature) => {
    const props = feature.properties || {};
    return {
      title: props.title || 'Earthquake',
      summary: `Magnitude ${props.mag ?? 'unknown'} earthquake. Status: ${props.status || 'unknown'}.`,
      location: props.place || 'Unknown',
      timestamp: props.time ? new Date(props.time).toISOString() : null,
      url: props.url,
      source: 'USGS',
      severity: props.tsunami ? 'warning' : 'info',
    };
  });
}

function parseNws(data) {
  return (data.features || []).slice(0, 25).map((feature) => {
    const props = feature.properties || {};
    return {
      title: props.headline || props.event || 'NWS Alert',
      summary: stripHtml(props.description || props.instruction || '').slice(0, 320),
      location: props.areaDesc || 'United States',
      timestamp: props.sent || props.effective || null,
      url: props['@id'] || 'https://api.weather.gov/alerts/active',
      source: props.senderName || 'NWS',
      severity: String(props.severity || 'info').toLowerCase(),
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

function timestampValue(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}
