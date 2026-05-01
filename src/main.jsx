import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Database, ExternalLink, RefreshCw, Search, Shield, Signal } from 'lucide-react';
import './styles.css';

const feedOrder = ['opensky', 'aisstream', 'gdelt', 'hdx', 'gdacs', 'usgs', 'nws', 'cisa-kev', 'un-sanctions', 'ofac-sdn'];

function App() {
  const [feeds, setFeeds] = useState([]);
  const [feedData, setFeedData] = useState({});
  const [selectedFeed, setSelectedFeed] = useState('all');
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
      setFeedData({});

      await Promise.all(
        feedList.map(async (feed) => {
          try {
            const data = await fetchJson(`/api/feed/${feed.id}`);
            setFeedData((current) => ({ ...current, [feed.id]: data }));
          } catch (error) {
            setFeedData((current) => ({
              ...current,
              [feed.id]: {
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

  const sourceStats = feeds.map((feed) => ({
    ...feed,
    count: feedData[feed.id]?.items?.length || 0,
    error: feedData[feed.id]?.error,
    fetchedAt: feedData[feed.id]?.fetchedAt,
  }));
  const selectedSource = selectedFeed === 'all' ? null : sourceStats.find((feed) => feed.id === selectedFeed);

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
          <button className={selectedFeed === 'all' ? 'source active' : 'source'} onClick={() => setSelectedFeed('all')}>
            <span>All sources</span>
            <strong>{records.length}</strong>
          </button>
          {sourceStats.map((feed) => (
            <button
              key={feed.id}
              className={selectedFeed === feed.id ? 'source active' : 'source'}
              onClick={() => setSelectedFeed(feed.id)}
            >
              <span>
                {feed.name}
                <small>{feed.keyed ? `${feed.category} · keyed` : feed.category}</small>
              </span>
              <strong className={feed.error ? 'error-count' : ''}>{feed.error ? '!' : feed.count}</strong>
            </button>
          ))}
        </aside>

        <section className="feed-board">
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
            {filteredRecords.map((item, index) => (
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

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
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

createRoot(document.getElementById('root')).render(<App />);
