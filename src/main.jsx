import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Crosshair, Database, ExternalLink, Plane, RefreshCw, Search, Shield, Signal } from 'lucide-react';
import shipMarkerUrl from './assets/ship-marker.png';
import './styles.css';

const feedOrder = ['opensky', 'aisstream', 'gdelt', 'hdx', 'gdacs', 'usgs', 'nws', 'cisa-kev', 'un-sanctions', 'ofac-sdn'];
const visibleCardLimit = 250;
const feedContext = {
  opensky: {
    label: 'Aircraft transponder position',
    description: 'OpenSky reports live aircraft states from ADS-B and Mode S receivers. It is useful for visible aircraft movement, not a complete military air picture.',
    marker: 'aircraft',
    glyph: 'A',
  },
  aisstream: {
    label: 'Vessel AIS position',
    description: 'AISStream reports vessel self-broadcast AIS positions. It is useful for ship movement and identity, but vessels can be delayed, absent, spoofed, or unnamed.',
    marker: 'vessel',
    glyph: '',
  },
  gdacs: {
    label: 'Disaster alert',
    description: 'GDACS reports global disaster alerts such as earthquakes, storms, floods, volcanoes, and droughts for crisis context.',
    marker: 'alert',
    glyph: '!',
  },
  usgs: {
    label: 'Seismic event',
    description: 'USGS reports earthquake events and related seismic products. This helps separate natural seismic activity from other incident signals.',
    marker: 'seismic',
    glyph: 'S',
  },
  nws: {
    label: 'U.S. public warning',
    description: 'NWS reports active U.S. weather and emergency alerts from official public warning channels.',
    marker: 'warning',
    glyph: '!',
  },
};

function App() {
  const [feeds, setFeeds] = useState([]);
  const [feedData, setFeedData] = useState({});
  const [selectedFeed, setSelectedFeed] = useState('all');
  const [mapVisibility, setMapVisibility] = useState({});
  const [query, setQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    loadFeeds();
  }, []);

  async function loadFeeds() {
    setIsRefreshing(true);
    try {
      const feedList = await fetchJson('/api/feeds');
      setFeeds(feedList.sort((a, b) => feedOrder.indexOf(a.id) - feedOrder.indexOf(b.id)));
      setMapVisibility((current) => {
        const next = { ...current };
        feedList.forEach((feed) => {
          if (next[feed.id] === undefined) next[feed.id] = true;
        });
        return next;
      });

      await Promise.all(
        feedList.map(async (feed) => {
          try {
            const data = await fetchJson(`/api/feed/${feed.id}`);
            if (hasFeedItems(data)) {
              await writeBrowserFeedBackup(feed.id, data);
              setFeedData((current) => ({ ...current, [feed.id]: data }));
            } else {
              const backup = await readBrowserFeedBackup(feed.id);
              setFeedData((current) => ({ ...current, [feed.id]: backup || data }));
            }
          } catch (error) {
            const backup = await readBrowserFeedBackup(feed.id);
            setFeedData((current) => ({
              ...current,
              [feed.id]: backup || {
                ...feed,
                fetchedAt: new Date().toISOString(),
                error: error.message,
                items: [],
              },
            }));
          }
        }),
      );
    } finally {
      setIsRefreshing(false);
    }
  }

  const records = useMemo(() => {
    return Object.values(feedData)
      .flatMap((feed) => (feed.items || []).map((item) => ({ ...item, feedId: feed.id, feedName: feed.name, category: feed.category })))
      .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp));
  }, [feedData]);

  const filteredRecords = records.filter((item) => {
    const matchesFeed = selectedFeed === 'all' || item.feedId === selectedFeed;
    const haystack = `${item.title} ${item.summary} ${item.location} ${item.source} ${item.category}`.toLowerCase();
    return matchesFeed && haystack.includes(query.toLowerCase());
  });
  const visibleRecords = filteredRecords.slice(0, visibleCardLimit);

  const sourceStats = feeds.map((feed) => ({
    ...feed,
    count: feedData[feed.id]?.items?.length || 0,
    error: feedData[feed.id]?.error,
    stale: feedData[feed.id]?.stale,
    backupReason: feedData[feed.id]?.backupReason,
    fetchedAt: feedData[feed.id]?.fetchedAt,
  }));
  const selectedSource = selectedFeed === 'all' ? null : sourceStats.find((feed) => feed.id === selectedFeed);
  const allMapRecords = useMemo(() => records.filter((item) => hasCoordinates(item)), [records]);
  const mapRecords = useMemo(() => allMapRecords.filter((item) => mapVisibility[item.feedId] !== false), [allMapRecords, mapVisibility]);
  const allFlightRecords = useMemo(() => allMapRecords.filter((item) => item.feedId === 'opensky'), [allMapRecords]);
  const flightRecords = useMemo(() => mapRecords.filter((item) => item.feedId === 'opensky'), [mapRecords]);
  const openSkyStatus = sourceStats.find((feed) => feed.id === 'opensky');

  function toggleMapFeed(feedId) {
    setMapVisibility((current) => ({ ...current, [feedId]: current[feedId] === false }));
  }

  function setAllMapFeeds(visible) {
    setMapVisibility((current) => {
      const next = { ...current };
      feeds.forEach((feed) => {
        next[feed.id] = visible;
      });
      return next;
    });
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <div className="eyebrow"><Shield size={15} /> Worldwatcher</div>
          <h1>Public Signal Board</h1>
          <p>Text-first feed aggregation for aircraft, vessels, conflict, crisis, sanctions, cyber, and alert context.</p>
        </div>
        <button className="refresh-button" onClick={loadFeeds} disabled={isRefreshing}>
          <RefreshCw size={17} className={isRefreshing ? 'spinning' : ''} />
          Refresh
        </button>
      </section>

      <section className="metrics-row">
        <Metric icon={<Database size={18} />} label="Sources" value={feeds.length} />
        <Metric icon={<Signal size={18} />} label="Records Loaded" value={records.length} />
        <Metric icon={<AlertTriangle size={18} />} label="Feed Errors" value={sourceStats.filter((feed) => feed.error).length} />
      </section>

      <section className="workspace">
        <aside className="source-panel">
          <div className="panel-title">Text Feeds</div>
          <div className="source-row">
            <button className={selectedFeed === 'all' ? 'source active' : 'source'} onClick={() => setSelectedFeed('all')}>
              <span>All sources</span>
              <strong>{records.length}</strong>
            </button>
          </div>
          <div className="map-toggle-actions">
            <button type="button" onClick={() => setAllMapFeeds(true)}>Show all on map</button>
            <button type="button" onClick={() => setAllMapFeeds(false)}>Hide all</button>
          </div>
          {sourceStats.map((feed) => (
            <div className="source-row" key={feed.id}>
              <button
                className={selectedFeed === feed.id ? 'source active' : 'source'}
                onClick={() => setSelectedFeed(feed.id)}
              >
                <span>
                  {feed.name}
                  <small>{feed.keyed ? `${feed.category} · keyed` : feed.category}</small>
                </span>
                <strong className={feed.error ? 'error-count' : feed.stale ? 'backup-count' : ''}>{feed.error ? '!' : feed.stale ? 'B' : feed.count}</strong>
              </button>
              <label className="map-switch" title={`${mapVisibility[feed.id] === false ? 'Show' : 'Hide'} ${feed.name} on map`}>
                <input
                  type="checkbox"
                  checked={mapVisibility[feed.id] !== false}
                  onChange={() => toggleMapFeed(feed.id)}
                />
                <span />
              </label>
            </div>
          ))}
        </aside>

        <section className="feed-board">
          <MapPanel
            records={mapRecords}
            flights={flightRecords}
            totalFlights={allFlightRecords.length}
            isRefreshing={isRefreshing}
            openSkyStatus={openSkyStatus}
          />

          <div className="controls">
            <label className="search-box">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search reports, alerts, places, sources"
              />
            </label>
            <div className="last-updated">
              {isRefreshing ? 'Refreshing feeds...' : `Showing ${filteredRecords.length} records`}
            </div>
          </div>

          <div className="cards">
            {selectedSource?.error && (
              <div className="feed-error">
                <strong>{selectedSource.name} error</strong>
                <span>{selectedSource.error}</span>
              </div>
            )}
            {selectedSource?.stale && (
              <div className="feed-warning">
                <strong>{selectedSource.name} backup</strong>
                <span>Showing the latest local snapshot because {selectedSource.backupReason || 'the live feed was unavailable'}.</span>
              </div>
            )}
            {filteredRecords.length > visibleCardLimit && (
              <div className="feed-warning">
                <strong>List limited</strong>
                <span>Showing the latest {visibleCardLimit} matching records. Search or select a source to narrow the list.</span>
              </div>
            )}
            {visibleRecords.map((item, index) => (
              <article className="record-card" key={`${item.feedId}-${item.url || item.title}-${index}`}>
                <div className="record-meta">
                  <span className={`severity ${normalizeSeverity(item.severity)}`}>{item.severity || 'info'}</span>
                  <span>{item.feedName}</span>
                  <span>{formatDate(item.timestamp)}</span>
                </div>
                <h2>{item.title}</h2>
                <p>{item.summary || 'No summary provided by source.'}</p>
                <div className="record-footer">
                  <span>{item.location || 'Unknown location'}</span>
                  {item.url && (
                    <a href={item.url} target="_blank" rel="noreferrer">
                      Source <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </article>
            ))}
            {!filteredRecords.length && (
              <div className="empty-state">
                <h2>No records match the current filter.</h2>
                <p>Clear the search field or select a different source.</p>
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function Metric({ icon, label, value }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

class SignalCanvasLayer extends L.Layer {
  constructor(records = []) {
    super();
    this.records = records;
    this.hits = [];
    this.shipImage = new Image();
    this.shipImage.onload = () => this.draw();
    this.shipImage.src = shipMarkerUrl;
    this.handleClick = this.handleClick.bind(this);
    this.reset = this.reset.bind(this);
  }

  onAdd(mapInstance) {
    this.map = mapInstance;
    this.canvas = L.DomUtil.create('canvas', 'signal-canvas-layer');
    this.canvas.addEventListener('click', this.handleClick);
    this.map.getPanes().overlayPane.appendChild(this.canvas);
    this.map.on('moveend zoomend resize viewreset', this.reset, this);
    this.reset();
  }

  onRemove() {
    this.map.off('moveend zoomend resize viewreset', this.reset, this);
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.remove();
  }

  setRecords(records) {
    this.records = records;
    this.draw();
  }

  reset() {
    if (!this.map || !this.canvas) return;

    const size = this.map.getSize();
    const scale = window.devicePixelRatio || 1;
    this.origin = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, this.origin);
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.canvas.width = Math.round(size.x * scale);
    this.canvas.height = Math.round(size.y * scale);
    this.context = this.canvas.getContext('2d');
    this.context.setTransform(scale, 0, 0, scale, 0, 0);
    this.draw();
  }

  draw() {
    if (!this.map || !this.context) return;

    const size = this.map.getSize();
    const bounds = this.map.getBounds().pad(0.12);
    this.context.clearRect(0, 0, size.x, size.y);
    this.hits = [];

    this.records.forEach((record) => {
      const coords = coordinatesFor(record);
      if (!coords) return;

      const latLng = L.latLng(coords[0], coords[1]);
      if (!bounds.contains(latLng)) return;

      const point = this.map.latLngToLayerPoint(latLng).subtract(this.origin);
      if (record.feedId === 'opensky') {
        this.drawAircraft(point, Number(record.track || 0));
        this.hits.push({ x: point.x, y: point.y, radius: 9, record, latLng });
      } else if (record.feedId === 'aisstream') {
        this.drawShip(point, shipHeading(record));
        this.hits.push({ x: point.x, y: point.y, radius: 13, record, latLng });
      } else {
        this.drawSignal(point, contextFor(record));
        this.hits.push({ x: point.x, y: point.y, radius: 10, record, latLng });
      }
    });
  }

  drawAircraft(point, heading) {
    const ctx = this.context;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.fillStyle = '#122431';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(4, 3);
    ctx.lineTo(9, 5);
    ctx.lineTo(9, 8);
    ctx.lineTo(3, 7);
    ctx.lineTo(2, 11);
    ctx.lineTo(0, 9);
    ctx.lineTo(-2, 11);
    ctx.lineTo(-3, 7);
    ctx.lineTo(-9, 8);
    ctx.lineTo(-9, 5);
    ctx.lineTo(-4, 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  drawShip(point, heading) {
    const ctx = this.context;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate((heading * Math.PI) / 180);
    if (this.shipImage.complete && this.shipImage.naturalWidth) {
      ctx.drawImage(this.shipImage, -7, -13, 14, 26);
    } else {
      ctx.fillStyle = '#1f6f57';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -13);
      ctx.lineTo(7, -2);
      ctx.lineTo(5, 12);
      ctx.lineTo(-5, 12);
      ctx.lineTo(-7, -2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  drawSignal(point, context) {
    const ctx = this.context;
    const color = markerColor(context.marker);
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(context.glyph || '?', 0, 0.5);
    ctx.restore();
  }

  handleClick(event) {
    if (!this.map) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = this.hits.findLast((item) => Math.hypot(item.x - x, item.y - y) <= item.radius);
    if (!hit) return;

    L.popup()
      .setLatLng(hit.latLng)
      .setContent(popupHtml(hit.record, contextFor(hit.record)))
      .openOn(this.map);
  }
}

function MapPanel({ records, flights, totalFlights, isRefreshing, openSkyStatus }) {
  const mapElement = useRef(null);
  const map = useRef(null);
  const signalLayer = useRef(null);

  useEffect(() => {
    if (!mapElement.current || map.current) return;

    map.current = L.map(mapElement.current, {
      center: [35, 18],
      zoom: 3,
      minZoom: 2,
      maxZoom: 9,
      zoomControl: false,
      worldCopyJump: true,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map.current);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map.current);
    signalLayer.current = new SignalCanvasLayer(records).addTo(map.current);

    setTimeout(() => map.current?.invalidateSize(), 0);
  }, []);

  useEffect(() => {
    signalLayer.current?.setRecords(records);
  }, [records]);

  useEffect(() => {
    if (!map.current || !flights.length) return;
    const bounds = L.latLngBounds(flights.map((flight) => coordinatesFor(flight)).filter(Boolean));
    if (bounds.isValid()) {
      map.current.fitBounds(bounds.pad(0.22), { maxZoom: 5, animate: true });
    }
  }, [flights]);

  return (
    <section className="map-panel">
      <div className="map-frame" ref={mapElement} />
      <div className="map-hud top-left">
        <div className="hud-kicker"><Crosshair size={14} /> Live Geospatial View</div>
        <strong>{isRefreshing && !openSkyStatus ? '...' : flights.length}</strong>
        <span>
          {openSkyStatus?.error
            ? 'OpenSky aircraft feed error'
            : `${totalFlights} OpenSky aircraft loaded${flights.length !== totalFlights ? ` · ${flights.length} visible` : ''}`}
        </span>
      </div>
      <div className="map-hud top-right">
        <Plane size={17} />
        <span>{isRefreshing ? 'Refreshing' : `${records.length} mapped signals`}</span>
      </div>
    </section>
  );
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

function hasFeedItems(data) {
  return Array.isArray(data?.items) && data.items.length > 0;
}

async function writeBrowserFeedBackup(feedId, data) {
  if (!hasFeedItems(data)) return;

  try {
    const db = await openFeedBackupDb();
    const tx = db.transaction('feeds', 'readwrite');
    tx.objectStore('feeds').put({
      id: feedId,
      payload: {
        ...data,
        browserBackupWrittenAt: new Date().toISOString(),
      },
    });
    await txDone(tx);
    db.close();
  } catch (error) {
    console.warn('Unable to write browser feed backup', feedId, error);
  }
}

async function readBrowserFeedBackup(feedId) {
  try {
    const db = await openFeedBackupDb();
    const tx = db.transaction('feeds', 'readonly');
    const request = tx.objectStore('feeds').get(feedId);
    const record = await requestResult(request);
    await txDone(tx);
    db.close();

    if (!hasFeedItems(record?.payload)) return null;
    return {
      ...record.payload,
      stale: true,
      backupReason: record.payload.backupReason || 'browser IndexedDB snapshot',
      servedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn('Unable to read browser feed backup', feedId, error);
    return null;
  }
}

function openFeedBackupDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('worldwatcher-feed-backups', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('feeds', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function timestampValue(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDate(value) {
  if (!value) return 'No timestamp';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function normalizeSeverity(value) {
  const severity = String(value || '').toLowerCase();
  if (['red', 'extreme', 'severe', 'warning'].includes(severity)) return 'high';
  if (['orange', 'moderate', 'watchlist'].includes(severity)) return 'medium';
  if (['live'].includes(severity)) return 'live';
  return 'low';
}

function hasCoordinates(item) {
  return Boolean(coordinatesFor(item));
}

function coordinatesFor(item) {
  const latitude = Number(item.latitude);
  const longitude = Number(item.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return [latitude, longitude];
  }

  const match = String(item.location || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;

  const parsedLatitude = Number(match[1]);
  const parsedLongitude = Number(match[2]);
  return Number.isFinite(parsedLatitude) && Number.isFinite(parsedLongitude) ? [parsedLatitude, parsedLongitude] : null;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function contextFor(record) {
  return feedContext[record.feedId] || {
    label: record.feedName || 'Mapped signal',
    description: `${record.feedName || 'This feed'} provides mapped public data for situational context. Treat it as a lead to inspect, not as standalone confirmation.`,
    marker: 'generic',
    glyph: '?',
  };
}

function markerHtml(record, context) {
  if (record.feedId === 'opensky') {
    return `<span class="flight-marker" style="--heading:${Number(record.track || 0)}deg"></span>`;
  }

  if (record.feedId === 'aisstream') {
    return `<span class="ship-marker" style="--heading:${shipHeading(record)}deg"><img src="${shipMarkerUrl}" alt="" /></span>`;
  }

  return `<span class="signal-marker ${context.marker}">${escapeHtml(context.glyph)}</span>`;
}

function markerSize(record) {
  if (record.feedId === 'opensky') return [26, 26];
  if (record.feedId === 'aisstream') return [18, 32];
  return [24, 24];
}

function markerAnchor(record) {
  if (record.feedId === 'opensky') return [13, 13];
  if (record.feedId === 'aisstream') return [9, 16];
  return [12, 12];
}

function markerColor(marker) {
  if (marker === 'vessel') return '#1f6f57';
  if (marker === 'alert' || marker === 'warning') return '#8f2f1e';
  if (marker === 'seismic') return '#745116';
  return '#34424f';
}

function shipHeading(record) {
  const heading = Number(record.heading);
  if (validDirection(heading)) return heading;

  const course = Number(record.course);
  if (validDirection(course)) return course;

  const summaryHeading = extractDegrees(record.summary, 'heading');
  if (validDirection(summaryHeading)) return summaryHeading;

  const summaryCourse = extractDegrees(record.summary, 'course');
  if (validDirection(summaryCourse)) return summaryCourse;

  return 0;
}

function validDirection(value) {
  const degrees = Number(value);
  return Number.isFinite(degrees) && degrees >= 0 && degrees < 360;
}

function extractDegrees(value, label) {
  const match = String(value || '').match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*deg\\s+${label}`, 'i'));
  if (!match) return null;

  const degrees = Number(match[1]);
  return Number.isFinite(degrees) ? degrees : null;
}

function popupHtml(record, context) {
  const details = detailLines(record);
  const sourceUrl = record.url || record.sourceUrl;

  return `
    <div class="popup-feed">${escapeHtml(context.label)}</div>
    <strong>${escapeHtml(record.title || 'Mapped signal')}</strong>
    <p>${escapeHtml(context.description)}</p>
    ${details.length ? `<dl>${details.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
    <small>${escapeHtml(formatDate(record.timestamp))}</small>
    ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">Open source</a>` : ''}
  `;
}

function detailLines(record) {
  if (record.feedId === 'opensky') {
    return [
      ['Callsign', record.callsign || record.icao24 || 'Unknown'],
      ['Origin', record.title?.split(' over ')[1] || 'Unknown'],
      ['State', record.onGround ? 'On ground' : 'Airborne'],
      ['Speed', record.speedKts !== null && record.speedKts !== undefined ? `${record.speedKts} kt` : 'Unknown'],
      ['Altitude', record.altitudeMeters !== null && record.altitudeMeters !== undefined ? `${record.altitudeMeters} m` : 'Unknown'],
      ['Track', record.track !== null && record.track !== undefined ? `${record.track} deg` : 'Unknown'],
    ];
  }

  if (record.feedId === 'aisstream') {
    return [
      ['Vessel', record.vesselName || record.title?.replace(' position report', '') || 'Unknown'],
      ['MMSI', record.mmsi || 'Unknown'],
      ['Type', record.shipType || 'Unknown'],
      ['Speed', record.speedKts !== null && record.speedKts !== undefined ? `${Number(record.speedKts).toFixed(1)} kt` : 'Unknown'],
      ['Course', validDirection(record.course) ? `${Number(record.course).toFixed(0)} deg` : 'Unknown'],
      ['Heading', validDirection(record.heading) ? `${Number(record.heading).toFixed(0)} deg` : 'Unavailable'],
    ];
  }

  return [
    ['Feed', record.feedName || record.source || 'Unknown'],
    ['Location', record.location || 'Unknown'],
    ['Report', record.summary || 'No summary provided'],
  ];
}

createRoot(document.getElementById('root')).render(<App />);
