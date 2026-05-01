# Worldwatcher Public Data Feeds

This document tracks candidate public data feeds for a global defense, military, conflict, crisis, and situational-awareness dashboard.

The initial implementation should start with feeds that require no API key. Free-key and registration-based feeds are listed separately for a later integration phase.

## No API Key Required

| Source | Category | What It Provides | Update Pattern | Integration Notes |
|---|---|---|---|---|
| [GDELT 2.0 Events/GKG](https://www.gdeltproject.org/data.html) | News-derived events | Global news events, actors, CAMEO conflict codes, locations, themes, article metadata | About every 15 minutes | Best no-key firehose for global reported events. Treat as media-derived signal, not verified ground truth. |
| [GDACS API/RSS](https://www.gdacs.org/gdacsapi/api/events/geteventlist/events4app) | Disaster alerts | Global disaster alerts for earthquakes, storms, floods, volcanoes, droughts, tropical cyclones | Near-real-time | Good crisis-context layer; not military-specific. |
| [USGS Earthquake GeoJSON/API](https://earthquake.usgs.gov/earthquakes/feed/) | Seismic events | Earthquake event feeds, GeoJSON, detail products, tsunami flags | Minutes | Reliable global seismic layer. Useful for blast/disaster differentiation context, but not an attack detector. |
| [NOAA AviationWeather API](https://aviationweather.gov/data/api/) | Aviation hazards | SIGMETs, AIRMETs, METARs, TAFs, PIREPs, aviation advisories | Frequent | Adds airspace/weather-risk context. |
| [FAA NASR downloads](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription) | Aviation reference | U.S. airports, navaids, frequencies, special activity airspace, obstacles | 28-day cycle | U.S.-focused authoritative aviation reference data. |
| [OurAirports CSV](https://ourairports.com/data/) | Aviation reference | Global airports, runways, navaids, frequencies, countries, regions | Nightly | Public-domain global aviation reference dataset. Non-authoritative. |
| [ADSB.lol API/archive](https://www.adsb.lol/docs/open-data/api/) | Aircraft tracking | Community ADS-B aircraft data and historical daily archive | Live plus daily archive | No key. Coverage depends on volunteer receivers and aircraft transponders. |
| [Airplanes.live API](https://airplanes.live/api-guide/) | Aircraft tracking | ADS-B aircraft positions, point/radius queries, military-tagged aircraft endpoint | Live | No key for public REST endpoints. Rate-limited and no SLA. |
| [adsb.fi](https://adsb.fi/) | Aircraft tracking | Community ADS-B aircraft tracking | Live | Open/unfiltered access is advertised; API terms should be rechecked before production use. |
| [NOAA / MarineCadastre AIS](https://github.com/ocm-marinecadastre/ais-vessel-traffic) | Maritime tracking | Historical U.S. AIS vessel traffic data | Historical bulk releases | Excellent U.S. maritime history source. Not global live AIS. |
| [OFAC Sanctions List Service](https://ofac.treasury.gov/sanctions-list-service) | Sanctions/economic pressure | U.S. sanctions lists in downloadable structured formats | Updated on OFAC changes | Useful entity and economic-pressure overlay. |
| [UN Security Council Consolidated Sanctions List](https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list) | Sanctions/economic pressure | UN sanctions individuals and entities in XML, HTML, and PDF | Updated on changes | Official UN sanctions list. |
| [SIPRI Arms Transfers Database](https://www.sipri.org/databases) | Arms transfers | Major conventional arms transfers since 1950 | Annual/periodic | Useful strategic layer. Not realtime and excludes many smaller systems. |
| [OpenStreetMap / Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) | Infrastructure/reference | Bases, ports, airports, roads, infrastructure, admin boundaries, points of interest | Continuously edited | For production, prefer OSM extracts/planet files over heavy public Overpass usage. |
| [CISA Known Exploited Vulnerabilities JSON](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) | Cyber threat context | Known exploited vulnerabilities catalog | Updated as CISA adds items | Useful for cyber risk layer. |
| [NWS Alerts API](https://www.weather.gov/documentation/services-web-api) | Public alerts | U.S. weather and emergency alerts in CAP/JSON | Live | U.S.-only emergency layer. |
| [UNHCR Public API](https://www.unhcr.org/what-we-do/reports-and-publications/data-and-statistics/global-public-api) | Displacement/refugees | Refugee, asylum, statelessness, and displacement statistics | Semiannual/periodic | Humanitarian impact layer. Not tactical. |
| [HDX / OCHA Humanitarian Data Exchange](https://data.humdata.org/) | Humanitarian datasets | Humanitarian datasets, admin boundaries, affected populations, operational data | Dataset-dependent | Some datasets are public; some are restricted or available on request. |
| [Global Terrorism Database / START](https://www.start.umd.edu/gtd/) | Historical terrorism | Historical terrorism incidents and metadata | Historical download | Requires terms acceptance, but not an API key. Not current live feed. |
| [Natural Earth](https://www.naturalearthdata.com/) | Basemap/reference | Public-domain admin boundaries, populated places, physical geography, raster/vector map data | Periodic releases | Good low-resolution global reference and basemap data. |

## Free API Key, Token, Account, or Registration Required

| Source | Category | What It Provides | Update Pattern | Integration Notes |
|---|---|---|---|---|
| [ACLED API](https://acleddata.com/acled-api-documentation) | Conflict events | Political violence, battles, explosions, protests, remote violence, actor data | Frequent/near-real-time | One of the strongest conflict-event sources. Requires account, email, and API key. |
| [UCDP API](https://ucdp.uu.se/apidocs/) | Conflict events | Georeferenced conflict events, actors, fatalities, conflict metadata | Research-grade periodic updates | As of this build, live API calls return an access-token requirement. Treat as keyed until verified otherwise. |
| [ReliefWeb API](https://apidoc.reliefweb.int/) | Humanitarian/crisis reporting | Humanitarian reports, situation reports, disasters, maps, sources | Continuous | v1 is decommissioned and v2 requires an approved `appname`; treat as registration-required for now. |
| [NASA FIRMS API](https://firms.modaps.eosdis.nasa.gov/usfs/api/data_availability/) | Thermal anomalies/fires | MODIS/VIIRS active fires and thermal anomalies | Near-real-time, usually within hours | Free `MAP_KEY`. Thermal anomaly does not equal strike; needs correlation. |
| [OpenSky Network API](https://openskynetwork.github.io/opensky-api/) | Aircraft tracking | ADS-B aircraft states, callsigns, origin country, position, altitude, velocity, track, squawk, ground/airborne state | Live/historical | Integrated via OAuth client credentials in `server.mjs`. Coverage depends on receiver visibility and transponder behavior. |
| [AISStream](https://aisstream.io/) | Maritime tracking | Live AIS vessel position and static ship messages over WebSocket | Live stream | Integrated via WebSocket in `server.mjs`. Current local default subscribes to the configured bounding boxes in `.env`. |
| [Global Fishing Watch API](https://globalfishingwatch.org/our-apis/documentation) | Maritime analytics | AIS-derived vessel presence, vessel identity, fishing/encounter events, SAR detections | Delayed by dataset | Free account/token. Strong for maritime analytics, not live naval tracking. |
| [AISHub API](https://www.aishub.net/api) | Maritime tracking | AIS vessel data in XML, JSON, or CSV | Live-ish | Free access generally requires contributing AIS data. |
| [Alerts.in.ua API](https://devs.alerts.in.ua/) | Ukraine civil-defense alerts | Ukraine air raid, artillery shelling, urban fighting, chemical, nuclear alerts | Live | Free token. Strict rate limits; proxy requests for public apps. |
| [NVD API](https://nvd.nist.gov/general/news/API-Key-Announcement) | Cyber vulnerability | CVEs, CVSS, CPEs, vulnerability metadata | Continuous | API key improves rate limits. |
| [AlienVault OTX](https://otx.alienvault.com/api) | Cyber threat intelligence | Threat pulses, IP/domain/hash reputation, indicators of compromise | Continuous | Free account/API key. Community data quality varies. |
| [OpenSanctions API](https://www.opensanctions.org/api/) | Sanctions/watchlists | Aggregated sanctions, PEPs, watchlists, risk entities | Frequent | Free/community access exists; commercial licensing needs review. |
| [GDELT Cloud](https://docs.gdeltcloud.com/) | AI-structured news events | Structured conflict/CAMEO+ events, stories, entities, summaries | Hourly | Separate from public GDELT bulk files. Requires key. |

## Public Web Sources With API or Licensing Caveats

| Source | What It Adds | Caveat |
|---|---|---|
| [Liveuamap](https://liveuamap.com/) | Visual OSINT-style conflict mapping and incident reports | Public web access exists, but raw API access and licensing are unclear/freemium/paid. Do not assume full ingest rights. |
| Israel Home Front Command alerts | Rocket and civil-defense alert context | Official app exists; public API access is not clearly stable. Unofficial wrappers may break or violate terms. |
| DeepStateMap / Ukraine war maps | Ukraine front-line and conflict context | Useful public OSINT layer, but not a clean global public API. Validate licensing and access before ingestion. |

## Sources To Avoid As Primary Free Feeds

These may still be useful as enrichment, but they do not satisfy the initial requirement for full, reliable, public, no-key or clearly free access.

| Source Type | Reason |
|---|---|
| X/Twitter API | Free access is heavily limited and often sampled. |
| Telegram scraping | Legally and operationally fragile; source quality varies. |
| FlightRadar24, MarineTraffic, VesselFinder | Public UIs exist, but full data/API access is generally paid or restricted. |
| ADS-B Exchange commercial endpoints | API access generally requires key/paid authorization. |
| NewsAPI free tier | Limited, not complete global coverage. |
| Google Maps data | Useful map product, not a raw public intelligence feed. |
| Commercial geopolitical risk APIs | Often excellent, but not free/full public data. |
| Random AI conflict tracker sites | Often unaudited aggregations with unclear source rights and incomplete feeds. |

## Recommended No-Key Starting Stack

Start with a small set that provides broad coverage and clean integration paths:

1. GDELT 2.0 Events/GKG for global media-derived event signal.
2. UCDP for validated conflict baseline.
3. ReliefWeb, GDACS, USGS, UNHCR, and HDX for humanitarian/disaster context.
4. ADSB.lol and Airplanes.live for public aircraft tracks.
5. OurAirports, Natural Earth, OSM extracts, and FAA NASR for reference layers.
6. OFAC and UN sanctions for strategic/economic-pressure overlays.
7. CISA KEV and NWS alerts for cyber and U.S. emergency context.

## Accuracy Notes

- No public feed provides a complete view of all military activity.
- ADS-B and AIS are voluntary or regulated broadcast systems; military aircraft and vessels may disable, spoof, obscure, or omit transmissions.
- News-derived datasets like GDELT are fast but noisy. They need deduplication, entity resolution, geocoding confidence, and source scoring.
- Research datasets like UCDP and GTD are more curated but slower.
- Thermal anomalies from FIRMS are not equivalent to strikes or combat. They should be correlated with other sources.
- Production use should cache data locally, respect rate limits, and store raw source records for auditability.
