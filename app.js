/* Whereabouts — location app logic.
 *
 * Everything is local: positions come from the browser's Geolocation API and
 * saved places live in localStorage. No account, no server, no telemetry.
 */
(function () {
  'use strict';

  var STORE_PLACES = 'whereabouts.places';
  var STORE_PREFS = 'whereabouts.prefs';
  var STORE_TRIP = 'whereabouts.trip';
  var EARTH_RADIUS = 6371008.8; // metres, IUGG mean radius

  var I18N = window.WhereaboutsI18n;
  var t = I18N.t;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    position: null,      // most recent GeolocationPosition
    watchId: null,
    tracking: false,
    track: [],           // [{lat, lng, ts, alt, speed, accuracy}]
    trackStart: null,
    maxSpeed: 0,
    climb: 0,
    places: [],
    prefs: {
      units: 'metric', coordFormat: 'decimal', theme: 'auto', live: true, rate: 'turbo',
      headingUp: false, sheetExpanded: false, activeTab: 'now', trainMode: false,
      accent: null
    },
    followMe: true,
    immersive: false,
    advisedOnPrecision: false,
    pollTimer: null,
    pollStartedAt: 0,
    headingUp: false,
    heading: null,
    appliedHeading: null,
    compassEvent: null,
    compassSeen: false,
    locateBusy: false,
    sheetExpanded: false,
    mapToolsOpen: false,
    deadReckonTimer: null,
    streetName: null,
    streetLookupAt: 0,
    streetLookupPoint: null,
    weather: null,
    weatherAt: 0,
    weatherPoint: null,
    train: {
      track: null,       // the railway way we think you're on
      stations: [],      // every named station the last query found nearby
      stops: [],         // of those, the ones ahead of you, nearest first
      queryAt: 0,
      queryPoint: null,
      busy: false,
      failed: false,
      prevPoint: null,   // for deriving heading when the GPS won't report one
      // The confirmation filter's answers — a bearing you picked for "which
      // way am I going", and whether you're on the stopping or fast service.
      // In-memory only: they belong to this journey, not to the saved prefs.
      chosenBearing: null,
      stopPattern: 'all',
      mode: null,        // 'rail' | 'bus' | null — which of the two we think you're near
      busRoutes: []      // route_ref values tagged on nearby bus stops
    }
  };

  // WMO weather codes, as used by Open-Meteo. Collapsed to the common cases —
  // exact sub-variety (e.g. which of three fog codes) isn't worth showing.
  // The description is an i18n key rather than literal text, so it's shown
  // in whichever language is active, including after a language switch.
  var WEATHER_CODES = {
    0: ['weather.clearSky', '☀️'], 1: ['weather.mainlyClear', '🌤️'], 2: ['weather.partlyCloudy', '⛅'], 3: ['weather.overcast', '☁️'],
    45: ['weather.fog', '🌫️'], 48: ['weather.fog', '🌫️'],
    51: ['weather.lightDrizzle', '🌦️'], 53: ['weather.drizzle', '🌦️'], 55: ['weather.denseDrizzle', '🌦️'],
    56: ['weather.freezingDrizzle', '🌧️'], 57: ['weather.freezingDrizzle', '🌧️'],
    61: ['weather.lightRain', '🌧️'], 63: ['weather.rain', '🌧️'], 65: ['weather.heavyRain', '🌧️'],
    66: ['weather.freezingRain', '🌨️'], 67: ['weather.freezingRain', '🌨️'],
    71: ['weather.lightSnow', '🌨️'], 73: ['weather.snow', '🌨️'], 75: ['weather.heavySnow', '❄️'], 77: ['weather.snowGrains', '🌨️'],
    80: ['weather.rainShowers', '🌦️'], 81: ['weather.rainShowers', '🌦️'], 82: ['weather.violentShowers', '⛈️'],
    85: ['weather.snowShowers', '🌨️'], 86: ['weather.snowShowers', '🌨️'],
    95: ['weather.thunderstorm', '⛈️'], 96: ['weather.thunderstormHail', '⛈️'], 99: ['weather.thunderstormHail', '⛈️']
  };

  var map;

  /* ---------------------------------------------------------------- utils */

  function toRad(d) { return d * Math.PI / 180; }

  // Haversine distance in metres.
  function distance(a, b) {
    var dLat = toRad(b.lat - a.lat);
    var dLng = toRad(b.lng - a.lng);
    var lat1 = toRad(a.lat);
    var lat2 = toRad(b.lat);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Initial bearing in degrees from a to b.
  function bearing(a, b) {
    var lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    var dLng = toRad(b.lng - a.lng);
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // The forward geodesic problem: where do you end up, given a start point,
  // a bearing, and a distance. Used to dead-reckon the marker forward from
  // the last real fix between updates.
  function destinationPoint(lat, lng, bearingDeg, meters) {
    var delta = meters / EARTH_RADIUS;
    var theta = toRad(bearingDeg);
    var phi1 = toRad(lat);
    var lambda1 = toRad(lng);
    var phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
    var lambda2 = lambda1 + Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );
    return { lat: phi2 * 180 / Math.PI, lng: ((lambda2 * 180 / Math.PI) + 540) % 360 - 180 };
  }

  function compassPoint(deg) {
    var points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return points[Math.round(deg / 22.5) % 16];
  }

  function isMetric() { return state.prefs.units === 'metric'; }

  function formatDistance(m) {
    if (m == null || isNaN(m)) return '—';
    if (isMetric()) {
      return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
    }
    var feet = m * 3.280839895;
    return feet < 1000 ? Math.round(feet) + ' ft' : (feet / 5280).toFixed(feet < 52800 ? 2 : 1) + ' mi';
  }

  function formatSpeed(mps) {
    if (mps == null || isNaN(mps)) return '—';
    return isMetric()
      ? (mps * 3.6).toFixed(1) + ' km/h'
      : (mps * 2.236936292).toFixed(1) + ' mph';
  }

  // Pace — minutes per km/mi — is how walkers and runners actually think
  // about effort, where a speed-based tile answers a different question.
  function formatPace(meters, ms) {
    if (!meters || meters < 10 || !ms) return '—';
    var units = meters / (isMetric() ? 1000 : 1609.344);
    var minutesPerUnit = (ms / 60000) / units;
    if (!isFinite(minutesPerUnit) || minutesPerUnit > 999) return '—';
    var m = Math.floor(minutesPerUnit);
    var s = Math.round((minutesPerUnit - m) * 60);
    if (s === 60) { s = 0; m += 1; }
    return m + "'" + (s < 10 ? '0' : '') + s + '" /' + (isMetric() ? 'km' : 'mi');
  }

  function formatAltitude(m) {
    if (m == null || isNaN(m)) return '—';
    return isMetric() ? Math.round(m) + ' m' : Math.round(m * 3.280839895) + ' ft';
  }

  function toDMS(value, positive, negative) {
    var hemisphere = value >= 0 ? positive : negative;
    var abs = Math.abs(value);
    var deg = Math.floor(abs);
    var minFloat = (abs - deg) * 60;
    var min = Math.floor(minFloat);
    var sec = ((minFloat - min) * 60).toFixed(1);
    return deg + '° ' + min + "' " + sec + '" ' + hemisphere;
  }

  function formatLat(lat) {
    return state.prefs.coordFormat === 'dms' ? toDMS(lat, 'N', 'S') : lat.toFixed(6) + '°';
  }

  function formatLng(lng) {
    return state.prefs.coordFormat === 'dms' ? toDMS(lng, 'E', 'W') : lng.toFixed(6) + '°';
  }

  function formatDuration(ms) {
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = (m < 10 && h > 0) ? '0' + m : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + (s < 10 ? '0' + s : s);
  }

  function relativeTime(ts) {
    var secs = Math.round((Date.now() - ts) / 1000);
    if (secs < 5) return t('time.justNow');
    if (secs < 60) return t('time.secsAgo', { n: secs });
    if (secs < 3600) return t('time.minAgo', { n: Math.round(secs / 60) });
    if (secs < 86400) return t('time.hAgo', { n: Math.round(secs / 3600) });
    return new Date(ts).toLocaleDateString(I18N.getLang());
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.hidden = false;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
      setTimeout(function () { el.hidden = true; }, 250);
    }, 2600);
  }

  // Errors (permission denied, insecure context) matter more than the
  // merely informational warnings (offline tiles, a coarse fix) — without
  // this, whichever happened to fire last would silently win, and since
  // both auto-locate and tile loading now kick off immediately on load,
  // that race is no longer rare enough to leave to chance.
  var BANNER_PRIORITY = { error: 2, warn: 1, precision: 1 };

  function banner(message, kind) {
    var el = $('banner');
    if (!message) { el.hidden = true; return; }
    var shown = (BANNER_PRIORITY[kind] || 0);
    var current = el.hidden ? -1 : (BANNER_PRIORITY[el.dataset.kind] || 0);
    if (shown < current) return;
    // Only the text node is replaced — the dismiss button lives alongside it.
    $('banner-text').textContent = message;
    el.className = 'banner' + (kind ? ' banner-' + kind : '');
    el.dataset.kind = kind || '';
    el.hidden = false;
  }

  // A good fix clears a location error, but not the standing offline notice.
  function clearBanner(kind) {
    var el = $('banner');
    if (!el.hidden && el.dataset.kind === kind) el.hidden = true;
  }

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // A small triangular waypoint arrow, rotated to the bearing from here to
  // the place — inherits the accent color of the meta line it sits in
  // rather than carrying its own, so light/dark theming needs no extra work.
  function waypointArrowSvg(bearingDeg) {
    return '<svg class="place-arrow" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" ' +
      'style="transform:rotate(' + Math.round(bearingDeg) + 'deg)">' +
      '<path d="M12 2.5 L17 15.5 L12 12.7 L7 15.5 Z" fill="currentColor"/></svg>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* -------------------------------------------------------------- storage */

  function loadStorage() {
    try {
      state.places = JSON.parse(localStorage.getItem(STORE_PLACES) || '[]');
      if (!Array.isArray(state.places)) state.places = [];
    } catch (e) {
      state.places = [];
    }
    try {
      var prefs = JSON.parse(localStorage.getItem(STORE_PREFS) || '{}');
      Object.keys(prefs).forEach(function (k) {
        if (k in state.prefs) state.prefs[k] = prefs[k];
      });
    } catch (e) { /* defaults are fine */ }
    try {
      var trip = JSON.parse(localStorage.getItem(STORE_TRIP) || 'null');
      if (trip && Array.isArray(trip.track)) {
        state.track = trip.track;
        state.trackStart = trip.trackStart || null;
        state.tracking = !!trip.tracking;
        state.maxSpeed = trip.maxSpeed || 0;
        state.climb = trip.climb || 0;
      }
    } catch (e) { /* no trip to resume */ }
  }

  function savePlaces() {
    try {
      localStorage.setItem(STORE_PLACES, JSON.stringify(state.places));
    } catch (e) {
      toast(t('toast.storageBlocked'));
    }
  }

  // Recording a trip is exactly the situation where losing everything to an
  // accidental reload or a crashed tab would sting most, so this is saved on
  // every accepted point rather than only when you explicitly stop.
  function saveTrip() {
    try {
      localStorage.setItem(STORE_TRIP, JSON.stringify({
        track: state.track, trackStart: state.trackStart,
        tracking: state.tracking, maxSpeed: state.maxSpeed, climb: state.climb
      }));
    } catch (e) { /* non-fatal — the trip just won't survive a reload */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORE_PREFS, JSON.stringify(state.prefs));
    } catch (e) { /* non-fatal */ }
  }

  /* ---------------------------------------------------------- geolocation */

  function geoErrorMessage(err) {
    switch (err.code) {
      case err.PERMISSION_DENIED:
        return t('banner.geo.permissionDenied');
      case err.POSITION_UNAVAILABLE:
        return t('banner.geo.unavailable');
      case err.TIMEOUT:
        return t('banner.geo.timeout');
      default:
        return err.message || t('banner.geo.generic');
    }
  }

  function preflight() {
    if (!('geolocation' in navigator)) {
      banner(t('banner.geoUnsupported'), 'error');
      return false;
    }
    if (!window.isSecureContext) {
      banner(t('banner.needsSecureContext'), 'error');
      return false;
    }
    return true;
  }

  function locateOnce() {
    if (!preflight()) return;
    setLocateBusy(true);
    navigator.geolocation.getCurrentPosition(function (pos) {
      setLocateBusy(false);
      clearBanner('error');
      state.followMe = true;
      handlePosition(pos, true);
      // Permission is granted now, so the readout can start keeping itself current.
      syncWatch();
    }, function (err) {
      setLocateBusy(false);
      banner(geoErrorMessage(err), 'error');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function setLocateBusy(busy) {
    state.locateBusy = busy;
    $('recenter').classList.toggle('is-busy', busy);
    renderSheetSummary();
  }

  /* One watch serves both jobs: keeping the readout live, and recording a
   * trip. Running two would ask the GPS for the same fixes twice. */

  function startWatch() {
    if (state.watchId != null) return true;
    if (!preflight()) return false;
    state.watchId = navigator.geolocation.watchPosition(function (pos) {
      clearBanner('error');
      handlePosition(pos, false);
    }, function (err) {
      if (err.code === err.PERMISSION_DENIED) {
        banner(geoErrorMessage(err), 'error');
        state.prefs.live = false;
        savePrefs();
        stopTracking();
        stopWatch();
        renderLive();
        return;
      }
      /* A watch that times out or briefly loses the satellites is routine, and
       * shouting about it while a current fix is on screen is just noise — the
       * watch and the poll both keep trying. Only speak up once the position
       * shown has actually gone stale. */
      var stale = !state.position || (Date.now() - state.position.timestamp) > 60000;
      if (stale) banner(geoErrorMessage(err), 'error');
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    return true;
  }

  function stopWatch() {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    stopDeadReckoning();
  }

  /* Dead reckoning: watchPosition/poll only deliver a handful of fixes per
   * second at best, so on a moving device the dot would otherwise sit still
   * and then jump. Between real fixes, nudge the marker forward from the
   * last one using its own reported speed and heading — real GPS chips
   * already report both, so this needs no extra sensor. Purely a rendering
   * effect: state.position, the numeric readout, and the track never see
   * anything but real fixes, so nothing estimated can end up saved, shared,
   * or exported. */
  function startDeadReckoning() {
    if (state.deadReckonTimer) return;
    state.deadReckonTimer = setInterval(tickDeadReckoning, 200);
  }

  function stopDeadReckoning() {
    if (!state.deadReckonTimer) return;
    clearInterval(state.deadReckonTimer);
    state.deadReckonTimer = null;
    // Undo any drift the last few ticks introduced — once extrapolation
    // isn't actively running, the dot should only ever sit where the last
    // real fix put it.
    if (state.position) {
      var c = state.position.coords;
      map.setMarker('me', c.latitude, c.longitude, 'mm-marker-me', t('now.youAreHere'));
      map.setAccuracy(c.latitude, c.longitude, c.accuracy);
    }
  }

  function tickDeadReckoning() {
    var pos = state.position;
    if (!pos) return;
    var c = pos.coords;
    // Below walking pace this would just be amplifying GPS speed noise into
    // a wandering dot; heading is meaningless without real movement anyway.
    if (c.speed == null || c.speed < 0.3 || c.heading == null || isNaN(c.heading)) return;
    var elapsed = (Date.now() - pos.timestamp) / 1000;
    // A fix that's gotten this stale isn't worth extrapolating further —
    // freeze rather than compound a guess on top of a guess.
    if (elapsed <= 0 || elapsed > 20) return;
    var dest = destinationPoint(c.latitude, c.longitude, c.heading, c.speed * elapsed);
    map.setMarker('me', dest.lat, dest.lng, 'mm-marker-me', t('now.youAreHere'));
    map.setAccuracy(dest.lat, dest.lng, c.accuracy);
    if (state.followMe) map.setView(dest.lat, dest.lng, null);
  }

  /* watchPosition only fires when the device decides you've moved far enough,
   * which on a stationary phone can mean nothing for a minute. Polling for a
   * fresh fix alongside it keeps the readout genuinely current — at a rate the
   * user picks, because this is the expensive part of the battery bill. */
  var RATES = { turbo: 1000, fast: 2000, normal: 5000, saver: 15000 };

  // Long enough that a slow fix isn't abandoned, short enough that a stuck one
  // doesn't hold up the next attempt for long.
  function pollTimeout() {
    return Math.max(5000, (RATES[state.prefs.rate] || RATES.turbo) * 2);
  }

  function pollNow() {
    if (!state.prefs.live && !state.tracking) return;
    if (document.hidden && !state.tracking) return;

    /* Keep one request outstanding at a time, but expire the guard with the
     * request's own timeout: some providers answer neither callback, and a
     * plain boolean would then wedge polling for the rest of the session. */
    var now = Date.now();
    if (state.pollStartedAt && now - state.pollStartedAt < pollTimeout()) return;
    state.pollStartedAt = now;

    navigator.geolocation.getCurrentPosition(function (pos) {
      state.pollStartedAt = 0;
      clearBanner('error');
      handlePosition(pos, false);
    }, function () {
      // A missed poll isn't worth a banner — the watch reports real errors,
      // and the next poll is seconds away.
      state.pollStartedAt = 0;
    }, { enableHighAccuracy: true, timeout: pollTimeout(), maximumAge: 0 });
  }

  function rateLabel() {
    return t('footer.every', { n: (RATES[state.prefs.rate] || RATES.turbo) / 1000 });
  }

  function syncPoll() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (state.watchId == null) return;
    if (!state.prefs.live && !state.tracking) return;
    state.pollTimer = setInterval(pollNow, RATES[state.prefs.rate] || RATES.turbo);
  }

  // Hold the watch open while either job still wants it, and not otherwise.
  function syncWatch() {
    if (state.prefs.live || state.tracking) {
      if (startWatch()) startDeadReckoning();
    } else {
      stopWatch();
    }
    syncPoll();
    renderLive();
  }

  function setLive(on) {
    state.prefs.live = on;
    savePrefs();
    syncWatch();
  }

  function renderLive() {
    var on = state.prefs.live;
    var btn = $('live-toggle');
    btn.classList.toggle('is-live', on && state.watchId != null);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? t('now.liveTitleOn') : t('now.liveTitleOff');
    $('live-label').textContent = on ? t('now.live') : t('now.paused');
    renderSheetSummary();
  }

  function startTracking() {
    state.tracking = true;
    if (!startWatch()) { state.tracking = false; return; }
    state.trackStart = state.trackStart || Date.now();
    $('track-toggle').textContent = t('trip.stopTracking');
    $('track-toggle').classList.add('is-active');
    renderLive();
    saveTrip();
    toast(t('toast.recordingTrip'));
  }

  function stopTracking() {
    state.tracking = false;
    $('track-toggle').textContent = t('trip.startTracking');
    $('track-toggle').classList.remove('is-active');
    // Live updates outlive the trip, so only drop the watch if nothing wants it.
    syncWatch();
    saveTrip();
  }

  /* A GPS that has just dropped to Wi-Fi or cell positioning reports a fix
   * that is both fresh and far worse. Taking it would throw the marker
   * hundreds of metres and poison the track, so hold the better fix — but
   * only briefly, or a stale reading would outlive its usefulness once
   * you've actually moved. */
  function isWorseFix(pos) {
    var current = state.position;
    if (!current) return false;
    var was = current.coords.accuracy;
    var now = pos.coords.accuracy;
    if (was == null || now == null) return false;
    var age = pos.timestamp - current.timestamp;
    if (!(now > was * 3 && now > 50 && age < 15000)) return false;
    // Only hold it if taking it would actually move the marker. A vaguer
    // reading of the same spot still deserves to refresh the accuracy
    // readout, otherwise the precision shown goes stale and misleads.
    var moved = distance(
      { lat: current.coords.latitude, lng: current.coords.longitude },
      { lat: pos.coords.latitude, lng: pos.coords.longitude }
    );
    return moved > was;
  }

  function precisionOf(accuracy) {
    if (accuracy == null) return { key: 'unknown', label: t('precision.unknown') };
    if (accuracy <= 20) return { key: 'precise', label: t('precision.precise') };
    if (accuracy <= 75) return { key: 'good', label: t('precision.good') };
    if (accuracy <= 500) return { key: 'approx', label: t('precision.approx') };
    return { key: 'coarse', label: t('precision.coarse') };
  }

  // Only worth saying once, and only when the fix is bad enough to act on.
  function maybeAdviseOnPrecision(accuracy) {
    if (state.advisedOnPrecision || accuracy == null || accuracy <= 500) return;
    state.advisedOnPrecision = true;
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    banner(t('precision.advice', { acc: formatDistance(accuracy) }) +
      (ios ? t('precision.adviceIOS') : t('precision.adviceOther')), 'precision');
  }

  /* Nominatim is a free, shared public service, so this stays well inside
   * its usage policy on purpose: at most one lookup every 12s, and only
   * when we've actually moved far enough that the street has probably
   * changed — a sudden large jump (jump-to-coordinates, a teleporting fix)
   * bypasses the wait, since a 12s-stale street name right after that would
   * just be wrong rather than merely a little behind. */
  function maybeLookUpStreet(lat, lng) {
    var last = state.streetLookupPoint;
    var due = true;
    if (last) {
      var moved = distance(last, { lat: lat, lng: lng });
      var elapsed = Date.now() - state.streetLookupAt;
      due = moved > 300 || (moved > 30 && elapsed > 12000);
    }
    if (!due) return;
    state.streetLookupAt = Date.now();
    state.streetLookupPoint = { lat: lat, lng: lng };
    reverseGeocode(lat, lng);
  }

  function reverseGeocode(lat, lng) {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' +
      encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng) + '&zoom=17&addressdetails=1';
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var a = data && data.address;
        // Nominatim's address fields vary by what's actually mapped there —
        // fall back through the closest things to "a street" it offers.
        var name = a && (a.road || a.pedestrian || a.footway || a.cycleway || a.path);
        state.streetName = name || null;
        renderStreet();
        renderSheetSummary();
      })
      .catch(function () { /* offline or rate-limited — coordinates remain the fallback */ });
  }

  // The reverse of reverseGeocode: turn a typed address into coordinates,
  // via the same free Nominatim service. Unlike the automatic street lookup
  // above, this only ever runs from an explicit form submit, so it needs no
  // rate-limiting of its own — a person typing and submitting an address is
  // already self-throttling in a way a fix arriving every second isn't.
  function forwardGeocode(query) {
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=' +
      encodeURIComponent(query);
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) {
        // Distinct from "no results": a non-ok response means the search
        // itself didn't run, so it should surface as a failure rather than
        // silently reading the same as a genuine no-match.
        if (!r.ok) throw new Error('geocode request failed: ' + r.status);
        return r.json();
      })
      .then(function (results) {
        var hit = results && results[0];
        if (!hit) return null;
        return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), displayName: hit.display_name || query };
      });
  }

  function renderStreet() {
    var row = $('street-row');
    row.hidden = !state.streetName;
    if (state.streetName) $('street-name').textContent = state.streetName;
  }

  /* Weather doesn't need Nominatim's care — Open-Meteo has no key and a
   * generous free tier — but there's still no reason to ask again every
   * time a fix arrives: conditions don't meaningfully change minute to
   * minute, so refresh at most every 10 minutes, or immediately after
   * travelling far enough (20 km) that local weather might actually differ. */
  function maybeFetchWeather(lat, lng) {
    var last = state.weatherPoint;
    var due = true;
    if (last) {
      var moved = distance(last, { lat: lat, lng: lng });
      var elapsed = Date.now() - state.weatherAt;
      due = moved > 20000 || elapsed > 600000;
    }
    if (!due) return;
    state.weatherAt = Date.now();
    state.weatherPoint = { lat: lat, lng: lng };
    fetchWeather(lat, lng);
  }

  function fetchWeather(lat, lng) {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lng) + '&current=temperature_2m,weather_code&timezone=auto';
    fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var cur = data && data.current;
        if (!cur || cur.temperature_2m == null) return;
        state.weather = { tempC: cur.temperature_2m, code: cur.weather_code };
        renderWeather();
      })
      .catch(function () { /* offline — the row just stays hidden */ });
  }

  function renderWeather() {
    var row = $('weather-row');
    if (!state.weather) { row.hidden = true; return; }
    var info = WEATHER_CODES[state.weather.code] || [null, '🌡️'];
    var tempC = state.weather.tempC;
    var tempText = isMetric() ? Math.round(tempC) + '°C' : Math.round(tempC * 9 / 5 + 32) + '°F';
    $('weather-icon').textContent = info[1];
    $('weather-text').textContent = tempText + ' · ' + (info[0] ? t(info[0]) : '—');
    row.hidden = false;
  }

  /* ETA formatting, shared by anything that has a duration in seconds to
   * show — currently train mode's upcoming stops. */

  function formatEta(seconds) {
    if (seconds == null || isNaN(seconds)) return '\u2014';
    var mins = Math.round(seconds / 60);
    if (mins < 60) return t('time.etaMin', { n: mins });
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? t('time.etaHourMin', { h: h, m: m }) : t('time.etaHour', { h: h });
  }

  /* -------------------------------------------------------- train mode */

  /* What this can and cannot know, stated plainly because the difference
   * matters: OpenStreetMap describes *infrastructure* — where the rails
   * run, what the line is called, which stations and bus stops sit where.
   * It says nothing about which service is running right now. So this
   * infers the line or stop you're near from real mapped data plus your
   * own speed and heading, and estimates the *kind* of service that
   * implies. It never claims a train number or bus run: that would need a
   * live timetable feed, which needs a backend and an operator's API key,
   * and inventing one from a plausible guess would be worse than saying so.
   * Rails and roads aren't the same kind of evidence, though: being on
   * tracks is close to unambiguous, while being near a bus stop just means
   * a stop is near — so rail always takes priority when both are found,
   * and a bus guess never claims to be as sure as a rail one. */

  var RAILWAY_TILES = 'https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png';

  // Overpass is a small, donation-funded, heavily-loaded shared service, so
  // this is deliberately frugal: only while train mode is on, at most once
  // a minute, and only once you've actually moved far enough for the answer
  // to plausibly have changed. A train covers 500 m in well under a minute,
  // so in practice the interval floor is what governs.
  var TRAIN_QUERY_INTERVAL = 60000;
  var TRAIN_QUERY_DISTANCE = 500;
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

  // Buses run on ordinary roads, so there's no equivalent of "on the rails":
  // the closest honest signal is standing right by a stop. This is deliberately
  // tight, close to GPS accuracy in a street, so it doesn't fire for someone
  // merely walking down the same street as a stop.
  var BUS_STOP_RANGE = 150;

  // Rails that carry a service worth naming, scored so a running line beats
  // the sidings and yard tracks that sit alongside it in every station.
  function scoreTrack(tags) {
    var score = 0;
    if (tags.name || tags.ref) score += 2;
    if (tags.usage === 'main') score += 3;
    else if (tags.usage === 'branch') score += 2;
    // service=* on a railway means siding/yard/spur/crossover — real rails,
    // but not the line a passenger service runs on.
    if (tags.service) score -= 4;
    if (tags.railway === 'rail') score += 1;
    return score;
  }

  function pickTrack(ways) {
    var best = null, bestScore = -Infinity;
    ways.forEach(function (w) {
      var tags = w.tags || {};
      var s = scoreTrack(tags);
      if (s > bestScore) { bestScore = s; best = tags; }
    });
    return best;
  }

  /* The service estimate. Track class carries most of it — a subway tunnel
   * is never an intercity — with speed breaking the remaining tie between
   * long-distance and regional services on shared main line. */
  function estimateService(tags, speedMps) {
    if (!tags) return null;
    var kmh = (speedMps != null && !isNaN(speedMps)) ? speedMps * 3.6 : null;
    switch (tags.railway) {
      case 'subway': return 'train.svcSubway';
      case 'tram': return 'train.svcTram';
      case 'light_rail': return 'train.svcLightRail';
      case 'monorail': return 'train.svcMonorail';
      case 'narrow_gauge': return 'train.svcNarrowGauge';
    }
    if (tags.highspeed === 'yes' || (kmh != null && kmh > 200)) return 'train.svcHighSpeed';
    if (kmh != null && kmh > 120) return 'train.svcIntercity';
    if (tags.usage === 'branch') return 'train.svcRegional';
    if (tags.usage === 'main') return 'train.svcMainLine';
    return 'train.svcRail';
  }

  /* How much to trust the above. A named main line under you while you're
   * moving at train speed with stations lining up ahead is about as good as
   * this gets; an unnamed track while stationary is a guess and says so. */
  function trainConfidence(tags, speedMps, stops) {
    var named = !!(tags && (tags.name || tags.ref));
    var moving = speedMps != null && speedMps > 8; // ~30 km/h, past tram-in-traffic
    if (named && moving && stops.length) return 'high';
    if (named && (moving || stops.length)) return 'medium';
    return 'low';
  }

  // route_ref lists the route numbers a stop serves, semicolon- or
  // comma-separated. It's the one honestly-taggable fact OSM offers about
  // buses near you — there's no OSM equivalent of "which one you're on".
  function uniqueRouteRefs(nodes) {
    var seen = {}, out = [];
    nodes.forEach(function (n) {
      var ref = n.tags && n.tags.route_ref;
      if (!ref) return;
      ref.split(/[;,]/).forEach(function (part) {
        var r = part.trim();
        if (r && !seen[r]) { seen[r] = true; out.push(r); }
      });
    });
    return out;
  }

  /* Capped below rail's ceiling on purpose: a named line under you at train
   * speed is about as sure as this gets, but standing near a bus stop never
   * rules out just standing there — so this can say "likely", never
   * "confident". */
  function busConfidence(routes, speedMps, stops) {
    var moving = speedMps != null && speedMps > 2.5; // faster than a stroll
    if (routes.length && moving && stops.length) return 'medium';
    return 'low';
  }

  // Which way are we pointing? The GPS reports a heading when it's confident;
  // when it isn't, two fixes far enough apart give the same answer.
  function trainHeading() {
    var c = state.position && state.position.coords;
    if (c && c.heading != null && !isNaN(c.heading) && c.speed != null && c.speed > 2) return c.heading;
    var prev = state.train.prevPoint;
    if (!prev || !c) return null;
    var here = { lat: c.latitude, lng: c.longitude };
    return distance(prev, here) > 60 ? bearing(prev, here) : null;
  }

  /* Stations you're heading towards, nearest first. A cone rather than a
   * strict bearing because track curves: a stop 10 km down a bending line
   * is still ahead of you even when it isn't straight ahead of you. This is
   * the honest limit of doing it without the line's own geometry — good for
   * the next few stops, vaguer the further out it reaches. A 'fast' pattern
   * drops the minor halts a stopping service calls at but an express skips. */
  function stopsAhead(here, headingDeg, stations, speedMps, pattern) {
    if (headingDeg == null) return [];
    return stations
      .filter(function (s) { return pattern !== 'fast' || s.railway !== 'halt'; })
      .map(function (s) {
        var d = distance(here, s);
        return {
          name: s.name,
          lat: s.lat,
          lng: s.lng,
          distance: d,
          off: Math.abs(angleDelta(headingDeg, bearing(here, s))),
          eta: (speedMps != null && speedMps > 2) ? d / speedMps : null
        };
      })
      .filter(function (s) { return s.off < 75 && s.distance > 250; })
      .sort(function (a, b) { return a.distance - b.distance; })
      .slice(0, 6);
  }

  /* The two ways along the line, for the "which way are you heading?"
   * question. Without the line's own geometry, the farthest station sets
   * one end; every station within 90° of it is that direction, the rest are
   * the other. Each option is labelled by its farthest station — the one
   * that reads as a destination. Returns [] if there's only one cluster
   * (you're at or near a terminus) or nothing to split. */
  function directionOptions(here, stations) {
    if (!here || !stations || !stations.length) return [];
    var withBearing = stations
      .map(function (s) { return { name: s.name, bearing: bearing(here, s), distance: distance(here, s) }; })
      .filter(function (s) { return s.distance > 250; })
      .sort(function (a, b) { return b.distance - a.distance; });
    if (!withBearing.length) return [];

    var anchor = withBearing[0];
    var fwd = [], back = [];
    withBearing.forEach(function (s) {
      (Math.abs(angleDelta(anchor.bearing, s.bearing)) < 90 ? fwd : back).push(s);
    });

    var opts = [{ bearing: anchor.bearing, toward: fwd[0].name }];
    if (back.length) opts.push({ bearing: (anchor.bearing + 180) % 360, toward: back[0].name });
    return opts;
  }

  // The bearing driving the stops list: the direction you confirmed if you
  // picked one, otherwise the one derived from your movement.
  function activeBearing() {
    return state.train.chosenBearing != null ? state.train.chosenBearing : trainHeading();
  }

  function maybeQueryRailway(lat, lng) {
    if (!state.prefs.trainMode || state.train.busy) return;
    var last = state.train.queryPoint;
    var due = true;
    if (last) {
      var moved = distance(last, { lat: lat, lng: lng });
      due = (Date.now() - state.train.queryAt) > TRAIN_QUERY_INTERVAL && moved > TRAIN_QUERY_DISTANCE;
    }
    if (!due) return;
    queryRailway(lat, lng);
  }

  function queryRailway(lat, lng) {
    state.train.busy = true;
    state.train.queryAt = Date.now();
    state.train.queryPoint = { lat: lat, lng: lng };

    // Three named sets so each gets its own result cap — without that, a
    // dense city's stations could crowd the track we're actually standing
    // on out of a shared limit. Bus stops get a shorter radius than rail
    // stations: they're far denser, and a bus's useful "ahead" horizon is
    // shorter than a train's.
    var query = '[out:json][timeout:25];' +
      'way(around:80,' + lat + ',' + lng + ')' +
      '["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail)$"]->.tracks;' +
      'node(around:15000,' + lat + ',' + lng + ')["railway"~"^(station|halt)$"]["name"]->.stops;' +
      'node(around:3000,' + lat + ',' + lng + ')["highway"="bus_stop"]->.busstops;' +
      '.tracks out tags 12;' +
      '.stops out 150;' +
      '.busstops out tags 200;';

    fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('overpass failed: ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var elements = (data && data.elements) || [];
        var ways = elements.filter(function (e) { return e.type === 'way'; });
        var stations = elements.filter(function (e) {
          return e.type === 'node' && e.tags && e.tags.name && e.lat != null && e.tags.railway;
        }).map(function (e) {
          return { name: e.tags.name, lat: e.lat, lng: e.lon, railway: e.tags.railway };
        });
        var busStops = elements.filter(function (e) {
          return e.type === 'node' && e.tags && e.tags.highway === 'bus_stop' && e.lat != null;
        });

        state.train.track = pickTrack(ways);
        if (state.train.track) {
          // Rails win when both are present: being physically on tracks
          // within 80 m is close to unambiguous, while a bus stop nearby
          // just means a stop is nearby, not that you're riding anything.
          state.train.mode = 'rail';
          state.train.stations = stations;
          state.train.busRoutes = [];
        } else {
          var here = { lat: lat, lng: lng };
          var nearStops = busStops.filter(function (e) {
            return distance(here, { lat: e.lat, lng: e.lon }) < BUS_STOP_RANGE;
          });
          if (nearStops.length) {
            state.train.mode = 'bus';
            state.train.stations = busStops.filter(function (e) { return e.tags.name; })
              .map(function (e) { return { name: e.tags.name, lat: e.lat, lng: e.lon }; });
            state.train.busRoutes = uniqueRouteRefs(nearStops);
          } else {
            state.train.mode = null;
            state.train.stations = [];
            state.train.busRoutes = [];
          }
        }
        state.train.failed = false;
        // Cleared before rendering, not in a .finally() afterwards: the
        // render reads this flag to decide between "still looking" and
        // "looked, found nothing", and .finally() runs too late for that.
        state.train.busy = false;
        renderTrain();
      })
      .catch(function () {
        state.train.failed = true;
        state.train.busy = false;
        renderTrain();
      });
  }

  function setTrainMode(on) {
    state.prefs.trainMode = on;
    savePrefs();
    map.setOverlayTileUrl(on ? RAILWAY_TILES : null);
    $('tab-train').hidden = !on;
    applyToggleLabels();

    if (on) {
      state.train.failed = false;
      activateTab('train');
      state.prefs.activeTab = 'train';
      savePrefs();
      var c = state.position && state.position.coords;
      if (c) queryRailway(c.latitude, c.longitude);
    } else {
      // Nothing about a mode you've left should linger on screen.
      state.train.track = null;
      state.train.stations = [];
      state.train.stops = [];
      state.train.queryPoint = null;
      state.train.queryAt = 0;
      state.train.chosenBearing = null;
      state.train.stopPattern = 'all';
      state.train.mode = null;
      state.train.busRoutes = [];
      if (state.prefs.activeTab === 'train') {
        activateTab('now');
        state.prefs.activeTab = 'now';
        savePrefs();
      }
    }
    renderTrain();
  }

  function setTrainDirection(bearingDeg) {
    state.train.chosenBearing = bearingDeg;
    renderTrain();
  }

  function setTrainPattern(pattern) {
    state.train.stopPattern = pattern;
    renderTrain();
  }

  // The two direction buttons — the "which way?" filter. The one matching
  // your movement (when we can tell) is flagged as likely, so the guess is a
  // nudge rather than a blank choice.
  function renderDirections(opts, derived) {
    var host = $('train-directions');
    host.innerHTML = '';
    opts.forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'train-dir';
      var chosen = state.train.chosenBearing != null &&
        Math.abs(angleDelta(state.train.chosenBearing, opt.bearing)) < 45;
      var likely = state.train.chosenBearing == null && derived != null &&
        Math.abs(angleDelta(derived, opt.bearing)) < 60;
      b.classList.toggle('is-active', chosen);
      b.innerHTML = '<span class="train-dir-arrow" aria-hidden="true">→</span>' +
        '<span class="train-dir-name">' + escapeHtml(opt.toward) + '</span>' +
        (likely ? '<span class="train-dir-hint">' + escapeHtml(t('train.likely')) + '</span>' : '');
      b.addEventListener('click', function () { setTrainDirection(opt.bearing); });
      host.appendChild(b);
    });
  }

  function renderTrain() {
    if (!state.prefs.trainMode) return;

    var c = state.position && state.position.coords;
    var speed = c ? c.speed : null;
    var tags = state.train.track;
    var mode = state.train.mode;
    var here = c ? { lat: c.latitude, lng: c.longitude } : null;

    var known = mode === 'rail' || mode === 'bus';
    $('train-card').hidden = !known;
    $('train-status').hidden = known;
    $('train-filter').hidden = !(known && here);

    var bearing = activeBearing();
    var haveDir = bearing != null;
    var stops = (here && haveDir)
      ? stopsAhead(here, bearing, state.train.stations || [], speed, state.train.stopPattern)
      : [];
    state.train.stops = stops;

    if (known) {
      var service, confidence;
      if (mode === 'rail') {
        service = estimateService(tags, speed);
        confidence = trainConfidence(tags, speed, stops);
      } else {
        service = 'train.svcBus';
        confidence = busConfidence(state.train.busRoutes, speed, stops);
      }
      $('train-service').textContent = t(service);
      $('train-confidence').textContent = t('train.confidence' +
        confidence.charAt(0).toUpperCase() + confidence.slice(1));
      $('train-confidence').dataset.level = confidence;

      if (mode === 'rail') {
        var lineName = tags.name || tags.ref;
        $('train-line').textContent = lineName ? t('train.onLine', { line: lineName }) : t('train.unnamedLine');
      } else {
        var routes = state.train.busRoutes;
        $('train-line').textContent = routes.length
          ? t('train.busRoutesNear', { routes: routes.join(', ') })
          : t('train.busRoutesNone');
      }
      $('train-line').hidden = false;

      // The interactive filter: the robot asks which way, then — once it
      // knows — turns the question into a confirmation for you to check
      // against the real train.
      var opts = directionOptions(here, state.train.stations || []);
      renderDirections(opts, trainHeading());
      $('train-directions').hidden = opts.length < 2;

      var toward = stops.length ? stops[stops.length - 1].name : null;
      if (!haveDir) {
        $('train-ask').textContent = t('train.whichWay');
      } else if (toward) {
        $('train-ask').textContent = t('train.confirmAsk', { stop: toward });
      } else {
        $('train-ask').textContent = t('train.confirmNoStops');
      }

      // The stopping-pattern filter only makes sense for rail: OSM has no
      // honest basis for "this bus skips stops" the way railway=halt does.
      $('train-pattern').hidden = !haveDir || mode !== 'rail';
      $('train-pattern-all').classList.toggle('is-active', state.train.stopPattern !== 'fast');
      $('train-pattern-fast').classList.toggle('is-active', state.train.stopPattern === 'fast');

      var far = stops.length ? stops[stops.length - 1] : null;
      $('train-direction').hidden = !far;
      if (far) $('train-direction').textContent = t('train.towards', { stop: far.name });
    } else {
      $('train-status').textContent = state.train.failed
        ? t('train.lookupFailed')
        : (state.train.busy ? t('train.searching') : t('train.noTrack'));
    }

    $('train-speed').textContent = formatSpeed(speed);
    $('train-next').textContent = stops.length ? stops[0].name : '—';

    var list = $('train-stops');
    $('train-stops-empty').hidden = stops.length > 0;
    $('train-stops-empty').textContent = (known && !haveDir) ? t('train.pickDirection') : t('train.noStops');
    list.innerHTML = stops.map(function (s) {
      return '<li class="train-stop">' +
        '<span class="train-stop-name">' + escapeHtml(s.name) + '</span>' +
        '<span class="train-stop-meta">' + escapeHtml(formatDistance(s.distance)) +
          (s.eta != null ? ' · ' + escapeHtml(formatEta(s.eta)) : '') +
        '</span>' +
      '</li>';
    }).join('');
  }

  function handlePosition(pos, recenter) {
    if (!recenter && isWorseFix(pos)) return;
    state.position = pos;
    var c = pos.coords;
    var point = {
      lat: c.latitude,
      lng: c.longitude,
      ts: pos.timestamp,
      alt: c.altitude,
      speed: c.speed,
      accuracy: c.accuracy
    };

    if (state.tracking) appendTrackPoint(point);
    maybeLookUpStreet(point.lat, point.lng);
    maybeFetchWeather(point.lat, point.lng);
    maybeQueryRailway(point.lat, point.lng);

    map.setMarker('me', point.lat, point.lng, 'mm-marker-me', t('now.youAreHere'));
    map.setAccuracy(point.lat, point.lng, c.accuracy);
    if (recenter || state.followMe) {
      // An explicit locate reframes the map; a passive watch update just slides.
      map.setView(point.lat, point.lng, recenter ? zoomForAccuracy(c.accuracy) : null);
    }

    renderNow();
    renderPlaces();
    renderTrain();
    // Kept behind the same threshold the heading fallback needs, so a fix
    // that has barely moved doesn't overwrite the one useful reference point.
    if (!state.train.prevPoint || distance(state.train.prevPoint, point) > 60) {
      state.train.prevPoint = { lat: point.lat, lng: point.lng };
    }
    syncHash();
  }

  // Pick a zoom where the accuracy circle is a sensible fraction of the view.
  function zoomForAccuracy(accuracy) {
    if (!accuracy || accuracy <= 0) return 16;
    if (accuracy < 25) return 17;
    if (accuracy < 100) return 16;
    if (accuracy < 500) return 14;
    if (accuracy < 2000) return 12;
    return 10;
  }

  function appendTrackPoint(point) {
    var last = state.track[state.track.length - 1];
    if (last) {
      var moved = distance(last, point);
      // Consumer GPS jitters while standing still; ignore hops inside the
      // noise floor so the trip distance doesn't drift upward.
      var noiseFloor = Math.max(3, (point.accuracy || 0) * 0.5);
      if (moved < noiseFloor) return;
      var dt = (point.ts - last.ts) / 1000;
      if (dt > 0) {
        var derived = moved / dt;
        if (derived < 120) state.maxSpeed = Math.max(state.maxSpeed, point.speed != null ? point.speed : derived);
      }
      if (last.alt != null && point.alt != null) {
        var gain = point.alt - last.alt;
        if (gain > 1) state.climb += gain;
      }
    }
    state.track.push(point);
    map.setTrack(state.track);
    renderTrip();
    saveTrip();
  }

  function trackDistance() {
    var total = 0;
    for (var i = 1; i < state.track.length; i++) total += distance(state.track[i - 1], state.track[i]);
    return total;
  }

  /* --------------------------------------------------------------- render */

  function renderNow() {
    var pos = state.position;
    if (!pos) return;
    var c = pos.coords;
    $('lat').textContent = formatLat(c.latitude);
    $('lng').textContent = formatLng(c.longitude);
    $('accuracy').textContent = c.accuracy != null ? '±' + formatDistance(c.accuracy) : '—';
    $('altitude').textContent = formatAltitude(c.altitude);
    $('speed').textContent = formatSpeed(c.speed);
    $('heading').textContent = (c.heading != null && !isNaN(c.heading))
      ? Math.round(c.heading) + '° ' + compassPoint(c.heading)
      : '—';
    $('fix-age').textContent = t('now.fixFrom', { time: relativeTime(pos.timestamp) }) +
      (state.tracking ? t('now.recordingTrip') : '');

    var quality = precisionOf(c.accuracy);
    $('precision').dataset.quality = quality.key;
    $('precision-text').textContent = c.accuracy != null
      ? quality.label + ' · ±' + formatDistance(c.accuracy)
      : quality.label;
    if (c.accuracy != null && c.accuracy <= 500) clearBanner('precision');
    maybeAdviseOnPrecision(c.accuracy);

    $('hud').hidden = !state.immersive;
    $('hud-coords').textContent = c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5);
    $('hud-meta').textContent = (c.accuracy != null ? '±' + formatDistance(c.accuracy) : '') +
      (c.speed != null && !isNaN(c.speed) ? ' · ' + formatSpeed(c.speed) : '');

    renderSheetSummary();
  }

  // The collapsed sheet's one line of text — coordinates until something
  // more useful (like a street name) is available, and never blank.
  function renderSheetSummary() {
    var dot = $('sheet-status-dot');
    var text = $('sheet-summary-text');
    if (!dot || !text) return;
    dot.classList.toggle('is-live', !!(state.prefs.live && state.watchId != null));
    if (!state.position) {
      text.textContent = state.locateBusy ? t('sheet.findingYou') : t('sheet.locationUnavailable');
      return;
    }
    var c = state.position.coords;
    text.textContent = state.streetName || (c.latitude.toFixed(4) + ', ' + c.longitude.toFixed(4));
  }

  function renderTrip() {
    var dist = trackDistance();
    var elapsed = state.trackStart ? Date.now() - state.trackStart : 0;
    $('trip-distance').textContent = formatDistance(dist);
    $('trip-duration').textContent = formatDuration(elapsed);
    $('trip-avg').textContent = elapsed > 1000 && dist > 0 ? formatSpeed(dist / (elapsed / 1000)) : '—';
    $('trip-pace').textContent = formatPace(dist, elapsed);
    $('trip-max').textContent = state.maxSpeed > 0 ? formatSpeed(state.maxSpeed) : '—';
    $('trip-points').textContent = String(state.track.length);
    $('trip-climb').textContent = state.climb > 0 ? formatAltitude(state.climb) : '—';
  }

  function renderPlaces() {
    var list = $('places-list');
    var here = state.position
      ? { lat: state.position.coords.latitude, lng: state.position.coords.longitude }
      : null;

    $('places-empty').hidden = state.places.length > 0;
    list.innerHTML = '';

    state.places
      .slice()
      .sort(function (a, b) {
        if (!here) return b.savedAt - a.savedAt;
        return distance(here, a) - distance(here, b);
      })
      .forEach(function (place) {
        var li = document.createElement('li');
        li.className = 'place';

        // Only meaningful relative to where you're currently standing — with
        // no fix yet there's nothing for it to point from, so it's omitted
        // rather than drawn pointing nowhere.
        var brg = here ? bearing(here, place) : null;
        var meta = here
          ? formatDistance(distance(here, place)) + ' · ' + compassPoint(brg)
          : new Date(place.savedAt).toLocaleDateString(I18N.getLang());
        var arrow = brg != null ? waypointArrowSvg(brg) : '';

        li.innerHTML =
          '<button class="place-main" type="button">' +
            '<span class="place-name">' + escapeHtml(place.name) + '</span>' +
            '<span class="place-meta">' + arrow + escapeHtml(meta) + '</span>' +
            '<span class="place-coords">' + place.lat.toFixed(5) + ', ' + place.lng.toFixed(5) + '</span>' +
          '</button>' +
          '<button class="place-del" type="button" title="' + escapeHtml(t('places.deleteTitle')) + '" aria-label="' + escapeHtml(t('places.deleteAria', { name: place.name })) + '">×</button>';

        li.querySelector('.place-main').addEventListener('click', function () {
          state.followMe = false;
          map.setView(place.lat, place.lng, 16);
        });
        li.querySelector('.place-del').addEventListener('click', function () {
          state.places = state.places.filter(function (p) { return p.id !== place.id; });
          savePlaces();
          syncPlaceMarkers();
          renderPlaces();
          toast(t('toast.deleted', { name: place.name }));
        });

        list.appendChild(li);
      });
  }

  // Static across a render, but not across a language switch — set once
  // rather than rebuilt on every renderPlaces() call, and kept as innerHTML
  // only because the <strong> mid-sentence can't be a plain data-i18n key.
  function applyPlacesEmptyText() {
    $('places-empty').innerHTML = escapeHtml(t('places.emptyPrefix')) +
      '<strong>' + escapeHtml(t('places.emptyStrong')) + '</strong>' + escapeHtml(t('places.emptySuffix'));
  }

  // A classic map-pin outline — rounded top tapering to a point at (12,32),
  // the exact spot .mm-marker-place's CSS anchors to the coordinate. Fill
  // is currentColor (themed via that class's `color`); the punched-out dot
  // uses the page surface color so it reads as a hole rather than a mark.
  var PLACE_PIN_SVG =
    '<svg viewBox="0 0 24 32" width="24" height="32" aria-hidden="true">' +
      '<path d="M12 32C12 32 3 17.5 3 10C3 4.5 7 1 12 1C17 1 21 4.5 21 10C21 17.5 12 32 12 32Z" fill="currentColor"/>' +
      '<circle cx="12" cy="10" r="3.5" fill="var(--surface)"/>' +
    '</svg>';

  function syncPlaceMarkers() {
    map.clearMarkers('place:');
    state.places.forEach(function (p) {
      var el = map.setMarker('place:' + p.id, p.lat, p.lng, 'mm-marker-place', p.name);
      el.innerHTML = PLACE_PIN_SVG;
    });
  }

  /* ------------------------------------------------------------- compass */

  /* Heading-up mode. Three complications, all handled here: iOS exposes a
   * ready-made compass heading and demands a permission gesture, other
   * browsers give an absolute alpha measured the other way round, and a
   * device held in landscape reports relative to the device rather than the
   * screen. */

  function headingFromEvent(e) {
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      return e.webkitCompassHeading;                 // iOS: degrees clockwise from north
    }
    if (typeof e.alpha === 'number' && !isNaN(e.alpha) && (e.absolute || e.type === 'deviceorientationabsolute')) {
      return (360 - e.alpha) % 360;                  // alpha runs anticlockwise
    }
    return null;
  }

  function screenAngle() {
    if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
      return window.screen.orientation.angle;
    }
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }

  // Shortest signed way round from a to b, so smoothing across 359°→1° doesn't
  // spin the map the long way.
  function angleDelta(a, b) {
    return ((b - a + 540) % 360) - 180;
  }

  function onOrientation(e) {
    var raw = headingFromEvent(e);
    if (raw == null) return;
    state.compassSeen = true;

    var heading = (raw + screenAngle() + 360) % 360;
    state.heading = state.heading == null
      ? heading
      // Low-pass filter: raw compass output is far too jittery to drive a map.
      : (state.heading + angleDelta(state.heading, heading) * 0.25 + 360) % 360;

    // Only repaint on a change big enough to see.
    if (state.appliedHeading == null || Math.abs(angleDelta(state.appliedHeading, state.heading)) > 1.5) {
      state.appliedHeading = state.heading;
      map.setBearing(state.heading);
      renderCompass();
    }
  }

  function attachCompass() {
    var evt = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(evt, onOrientation);
    state.compassEvent = evt;

    // Nothing reports a heading on a desktop without a magnetometer; say so
    // rather than leaving a toggle that silently does nothing.
    setTimeout(function () {
      if (state.headingUp && !state.compassSeen) {
        toast(t('toast.noCompass'));
        setHeadingUp(false);
      }
    }, 2500);
  }

  function detachCompass() {
    if (state.compassEvent) window.removeEventListener(state.compassEvent, onOrientation);
    state.compassEvent = null;
    state.heading = null;
    state.appliedHeading = null;
    state.compassSeen = false;
  }

  function setHeadingUp(on) {
    state.headingUp = on;
    state.prefs.headingUp = on;
    savePrefs();
    map.setRotationEnabled(on);

    if (on) {
      // iOS 13+ only hands over orientation after an explicit grant, and only
      // from a user gesture — which is why this lives on the button.
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(function (result) {
          if (result === 'granted') attachCompass();
          else { toast(t('toast.compassDenied')); setHeadingUp(false); }
        }).catch(function () { toast(t('toast.compassUnavailable')); setHeadingUp(false); });
      } else if (typeof DeviceOrientationEvent === 'undefined') {
        toast(t('toast.noCompassSupport'));
        state.headingUp = false;
        state.prefs.headingUp = false;
        map.setRotationEnabled(false);
      } else {
        attachCompass();
      }
    } else {
      detachCompass();
      map.setBearing(0);
    }
    renderCompass();
  }

  function renderCompass() {
    var btn = $('compass');
    btn.classList.toggle('is-active', !!state.headingUp);
    btn.setAttribute('aria-pressed', state.headingUp ? 'true' : 'false');
    btn.title = state.headingUp ? t('controls.compassOn') : t('controls.compassOff');
    // The needle keeps pointing at true north as the map turns beneath it.
    $('compass-needle').style.transform = 'rotate(' + (-(map ? map.getBearing() : 0)) + 'deg)';
  }

  /* ---------------------------------------------------------- fullscreen */

  /* Two separate things, deliberately driven by one button: the Fullscreen
   * API (which iOS Safari doesn't offer at all) and an immersive layout that
   * hides the panel. The layout half always works, so the button still does
   * something useful where the API is missing. */

  function setImmersive(on) {
    state.immersive = on;
    document.body.classList.toggle('is-immersive', on);
    $('hud').hidden = !on || !state.position;
    var btn = $('fullscreen');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? t('controls.fullscreenExit') : t('controls.fullscreenEnter');
    // The stage resized, so the map needs to refill it.
    if (map) map.render();
  }

  function toggleFullscreen() {
    var el = document.documentElement;
    var request = el.requestFullscreen || el.webkitRequestFullscreen;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    var active = document.fullscreenElement || document.webkitFullscreenElement;

    if (!state.immersive) {
      setImmersive(true);
      if (request) {
        // Rejection is normal (denied, or unsupported on iOS) — the
        // immersive layout is already in place either way.
        var p = request.call(el);
        if (p && p.catch) p.catch(function () {});
      }
    } else {
      setImmersive(false);
      if (active && exit) {
        var q = exit.call(document);
        if (q && q.catch) q.catch(function () {});
      }
    }
  }

  /* ---------------------------------------------------------------- hash */

  function syncHash() {
    var v = map.getView();
    var next = '#' + v.lat.toFixed(5) + ',' + v.lng.toFixed(5) + ',' + v.zoom;
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  function parseHash() {
    var m = /^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+))?$/.exec(location.hash);
    if (!m) return null;
    return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom: m[3] ? parseInt(m[3], 10) : 15 };
  }

  function parseCoordInput(text) {
    var m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
    if (!m) return null;
    var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat: lat, lng: lng };
  }

  /* --------------------------------------------------------------- export */

  function toGPX() {
    var head = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Whereabouts" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '  <trk><name>Trip ' + new Date(state.trackStart || Date.now()).toISOString() + '</name><trkseg>\n';
    var body = state.track.map(function (p) {
      return '    <trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lng.toFixed(7) + '">' +
        (p.alt != null ? '<ele>' + p.alt.toFixed(1) + '</ele>' : '') +
        '<time>' + new Date(p.ts).toISOString() + '</time></trkpt>';
    }).join('\n');
    return head + body + '\n  </trkseg></trk>\n</gpx>\n';
  }

  /* ----------------------------------------------------------------- init */

  /* CARTO's Positron and Dark Matter, at @2x so the labels stay sharp on
   * dense screens. A native dark basemap beats inverting a light one: an
   * inverted map gets the ground right but turns every label into a
   * photographic negative. */
  var BASEMAP = {
    light: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
    dark: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
  };

  function prefersDark() {
    var theme = state.prefs.theme;
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme() {
    var theme = state.prefs.theme;
    document.documentElement.dataset.theme = theme === 'auto' ? '' : theme;
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    if (map) map.setTileUrl(prefersDark() ? BASEMAP.dark : BASEMAP.light);

    // Matches --bg exactly, so the browser/OS chrome blends with the page
    // rather than the OS scheme and the in-app override disagreeing.
    $('theme-color').setAttribute('content', prefersDark() ? '#0d1117' : '#f5f6f8');
  }

  /* -------------------------------------------------------- accent colour */

  /* A chosen accent overrides the whole --accent family on the document
   * root, which every accent-coloured thing already reads through — the
   * location dot, the track line, primary buttons, active tabs. An inline
   * style on the root beats the stylesheet's :root rules, so it wins in
   * both light and dark; the default (null) removes the override and lets
   * the theme-aware stylesheet value take back over. */
  var ACCENT_PRESETS = [
    '#2563eb', '#0ea5e9', '#14b8a6', '#22c55e',
    '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'
  ];

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  // A translucent wash of the accent, for the soft-fill backgrounds.
  function accentSoft(hex) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', 0.15)';
  }

  // Black or white, whichever reads on top of the accent — a yellow button
  // needs dark text, a navy one needs white, and guessing wrong makes the
  // primary button's own label vanish. Standard relative-luminance test.
  function accentText(hex) {
    var c = hexToRgb(hex);
    var lin = function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    var L = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    // Tuned so genuinely light accents (amber, yellow, pale customs) take
    // dark text, while mid blues/greens/reds keep white — the conventional
    // pairing rather than the strict max-contrast one, which would put dark
    // text on a red button.
    return L > 0.42 ? '#14171c' : '#ffffff';
  }

  function applyAccent() {
    var root = document.documentElement.style;
    var hex = state.prefs.accent;
    if (!hex) {
      root.removeProperty('--accent');
      root.removeProperty('--accent-soft');
      root.removeProperty('--accent-text');
      return;
    }
    root.setProperty('--accent', hex);
    root.setProperty('--accent-soft', accentSoft(hex));
    root.setProperty('--accent-text', accentText(hex));
  }

  function buildAccentSwatches() {
    var host = $('accent-presets');
    host.innerHTML = '';
    ACCENT_PRESETS.forEach(function (hex) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'accent-swatch';
      b.dataset.accent = hex;
      // The ring drawn on the active swatch is currentColor, so each swatch
      // carries its own colour rather than sharing one accent variable.
      b.style.color = hex;
      b.style.background = hex;
      b.title = hex;
      b.addEventListener('click', function () { setAccent(hex); });
      host.appendChild(b);
    });
  }

  function renderAccentSwatches() {
    var current = state.prefs.accent;
    var isPreset = current && ACCENT_PRESETS.some(function (h) {
      return h.toLowerCase() === current.toLowerCase();
    });

    $('accent-default').classList.toggle('is-active', !current);
    $('accent-default').style.color = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim() || '#2563eb';

    Array.prototype.forEach.call($('accent-presets').children, function (b) {
      b.classList.toggle('is-active', !!current && b.dataset.accent.toLowerCase() === current.toLowerCase());
    });

    var custom = document.querySelector('.accent-custom');
    var customActive = !!current && !isPreset;
    custom.classList.toggle('is-active', customActive);
    custom.style.color = customActive ? current : '';
    custom.classList.toggle('has-colour', customActive);
    if (customActive) $('accent-custom-input').value = current;
  }

  function setAccent(hex) {
    state.prefs.accent = hex || null;
    savePrefs();
    applyAccent();
    renderAccentSwatches();
  }

  function activateTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) {
      var active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('is-active', p.dataset.panel === name);
    });
  }

  function setSheetExpanded(on) {
    state.sheetExpanded = on;
    state.prefs.sheetExpanded = on;
    savePrefs();
    $('sheet').dataset.state = on ? 'expanded' : 'collapsed';
    $('sheet-handle').setAttribute('aria-expanded', on ? 'true' : 'false');
    $('sheet-handle').setAttribute('aria-label', on ? t('sheet.collapse') : t('sheet.expand'));
  }

  // The handful of pill buttons whose visible label is the current value of
  // a preference (theme, units, coordinate format, refresh rate) rather than
  // a fixed caption — translated afresh on every change, including a bare
  // language switch, so it never freezes in the language it was drawn in.
  var COORD_KEYS = { decimal: 'toggles.coordDecimal', dms: 'toggles.coordDms' };
  var UNIT_KEYS = { metric: 'toggles.unitsMetric', imperial: 'toggles.unitsImperial' };
  var THEME_KEYS = { auto: 'toggles.themeAuto', light: 'toggles.themeLight', dark: 'toggles.themeDark' };

  function applyToggleLabels() {
    $('coord-format').textContent = t(COORD_KEYS[state.prefs.coordFormat]);
    $('unit-toggle').textContent = t(UNIT_KEYS[state.prefs.units]);
    $('theme-toggle').textContent = t(THEME_KEYS[state.prefs.theme]);
    $('rate-toggle').textContent = rateLabel();
    $('train-state').textContent = t(state.prefs.trainMode ? 'train.on' : 'train.off');
    $('train-toggle').classList.toggle('is-on', !!state.prefs.trainMode);
    $('train-toggle').setAttribute('aria-pressed', state.prefs.trainMode ? 'true' : 'false');
  }

  /* The map's controls live behind one settings button rather than sitting
   * on the map permanently. The gear's rotation is a plain CSS transition
   * between two angles, which means the closing spin runs backwards through
   * the same arc for free — no second animation, and an interrupted click
   * reverses from wherever it had got to rather than jumping. */
  function setMapToolsOpen(on) {
    state.mapToolsOpen = on;
    $('map-controls').classList.toggle('is-open', on);
    var btn = $('map-settings');
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    btn.title = t(on ? 'controls.settingsOpen' : 'controls.settings');
    btn.setAttribute('aria-label', btn.title);
  }

  function wireUI() {
    $('map-settings').addEventListener('click', function () {
      setMapToolsOpen(!state.mapToolsOpen);
    });

    $('accent-default').addEventListener('click', function () { setAccent(null); });
    // 'input' fires live as the native picker moves, so the whole app tints
    // under your finger; the value is only committed to prefs on 'change'.
    $('accent-custom-input').addEventListener('input', function () {
      state.prefs.accent = this.value;
      applyAccent();
    });
    $('accent-custom-input').addEventListener('change', function () {
      setAccent(this.value);
    });

    $('zoom-in').addEventListener('click', function () { map.zoomBy(1); });
    $('zoom-out').addEventListener('click', function () { map.zoomBy(-1); });

    // Recenter now doubles as "find me": one control, always a fresh fix,
    // rather than a separate always-visible pill for the same job.
    $('recenter').addEventListener('click', locateOnce);

    $('sheet-handle').addEventListener('click', function () {
      setSheetExpanded(!state.sheetExpanded);
    });

    // Tapping the map while the sheet is open gets it out of the way, same
    // as Apple/Google Maps — but a drag is a pan, not a dismissal.
    map.on('click', function () {
      if (state.sheetExpanded) setSheetExpanded(false);
    });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        activateTab(tab.dataset.tab);
        state.prefs.activeTab = tab.dataset.tab;
        savePrefs();
      });
    });

    $('coord-format').addEventListener('click', function () {
      state.prefs.coordFormat = state.prefs.coordFormat === 'decimal' ? 'dms' : 'decimal';
      savePrefs();
      applyToggleLabels();
      renderNow();
    });

    $('unit-toggle').addEventListener('click', function () {
      state.prefs.units = isMetric() ? 'imperial' : 'metric';
      savePrefs();
      applyToggleLabels();
      renderNow();
      renderTrip();
      renderPlaces();
      renderWeather();
    });

    $('rate-toggle').addEventListener('click', function () {
      var order = ['turbo', 'fast', 'normal', 'saver'];
      state.prefs.rate = order[(order.indexOf(state.prefs.rate) + 1) % order.length];
      savePrefs();
      applyToggleLabels();
      syncPoll();
      if (state.prefs.live || state.tracking) pollNow();
    });

    $('theme-toggle').addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      state.prefs.theme = order[(order.indexOf(state.prefs.theme) + 1) % order.length];
      savePrefs();
      applyToggleLabels();
      applyTheme();
      // The default swatch previews whatever accent the theme resolves to,
      // which differs between light and dark, so refresh it on a theme flip.
      renderAccentSwatches();
    });

    $('lang-toggle').addEventListener('click', function () { I18N.cycleLang(); });

    $('train-toggle').addEventListener('click', function () {
      setTrainMode(!state.prefs.trainMode);
    });

    $('train-pattern-all').addEventListener('click', function () { setTrainPattern('all'); });
    $('train-pattern-fast').addEventListener('click', function () { setTrainPattern('fast'); });

    $('copy').addEventListener('click', function () {
      if (!state.position) { toast(t('toast.noFix')); return; }
      var c = state.position.coords;
      var text = c.latitude.toFixed(6) + ', ' + c.longitude.toFixed(6);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { toast(t('toast.copied', { text: text })); },
          function () { toast(text); }
        );
      } else {
        toast(text);
      }
    });

    $('share').addEventListener('click', function () {
      if (!state.position) { toast(t('toast.noFix')); return; }
      var c = state.position.coords;
      var geoUrl = 'https://www.openstreetmap.org/?mlat=' + c.latitude.toFixed(6) +
                   '&mlon=' + c.longitude.toFixed(6) + '#map=17/' +
                   c.latitude.toFixed(5) + '/' + c.longitude.toFixed(5);
      if (navigator.share) {
        navigator.share({ title: t('now.shareTitle'), text: t('now.shareText'), url: geoUrl })
          .catch(function () { /* user dismissed the sheet */ });
      } else {
        window.open(geoUrl, '_blank', 'noopener');
      }
    });

    $('save-place').addEventListener('click', function () {
      if (!state.position) { toast(t('toast.findLocationFirst')); return; }
      var name = prompt(t('now.namePlacePrompt'));
      if (name == null) return;
      name = name.trim() || t('now.unnamedPlace');
      var c = state.position.coords;
      state.places.push({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        name: name,
        lat: c.latitude,
        lng: c.longitude,
        accuracy: c.accuracy,
        savedAt: Date.now()
      });
      savePlaces();
      syncPlaceMarkers();
      renderPlaces();
      toast(t('toast.saved', { name: name }));
    });

    $('jump-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var parsed = parseCoordInput($('jump-input').value);
      if (!parsed) { toast(t('toast.enterCoords')); return; }
      state.followMe = false;
      map.setView(parsed.lat, parsed.lng, 15);
    });

    $('address-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var query = $('address-input').value.trim();
      if (!query) { toast(t('places.enterAddress')); return; }
      var btn = $('address-submit');
      var restingLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = t('places.searching');
      forwardGeocode(query)
        .then(function (hit) {
          if (!hit) { toast(t('places.noAddressResults')); return; }
          var name = prompt(t('now.namePlacePrompt'), query);
          if (name == null) return;
          name = name.trim() || t('now.unnamedPlace');
          state.places.push({
            id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
            name: name,
            lat: hit.lat,
            lng: hit.lng,
            accuracy: null,
            savedAt: Date.now()
          });
          savePlaces();
          syncPlaceMarkers();
          renderPlaces();
          state.followMe = false;
          map.setView(hit.lat, hit.lng, 16);
          toast(t('toast.saved', { name: name }));
          $('address-input').value = '';
          $('address-form').closest('details').open = false;
        })
        .catch(function () { toast(t('places.addressSearchFailed')); })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = restingLabel;
        });
    });

    $('banner-close').addEventListener('click', function () {
      $('banner').hidden = true;
    });

    $('compass').addEventListener('click', function () {
      setHeadingUp(!state.headingUp);
    });

    // Rotating the phone changes what "up" means for the compass reading.
    if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
      window.screen.orientation.addEventListener('change', function () {
        state.heading = null;
        state.appliedHeading = null;
      });
    }

    $('fullscreen').addEventListener('click', toggleFullscreen);

    // Esc and the browser's own controls leave fullscreen without telling the
    // button, so follow the document rather than assuming our click did it.
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (evt) {
      document.addEventListener(evt, function () {
        var active = document.fullscreenElement || document.webkitFullscreenElement;
        if (!active && state.immersive) setImmersive(false);
      });
    });

    $('live-toggle').addEventListener('click', function () {
      if (state.tracking && state.prefs.live) {
        toast(t('toast.stopTripFirst'));
        return;
      }
      setLive(!state.prefs.live);
    });

    $('track-toggle').addEventListener('click', function () {
      if (state.tracking) {
        stopTracking();
        toast(state.prefs.live ? t('toast.tripSavedStillLive') : t('toast.tripStopped'));
      } else {
        startTracking();
      }
    });

    $('trip-clear').addEventListener('click', function () {
      state.track = [];
      state.trackStart = state.tracking ? Date.now() : null;
      state.maxSpeed = 0;
      state.climb = 0;
      map.setTrack([]);
      renderTrip();
      saveTrip();
      toast(t('toast.tripCleared'));
    });

    $('trip-export').addEventListener('click', function () {
      if (state.track.length < 2) { toast(t('toast.notEnoughPoints')); return; }
      download('whereabouts-' + new Date().toISOString().slice(0, 19).replace(/:/g, '') + '.gpx',
               toGPX(), 'application/gpx+xml');
    });

    $('places-export').addEventListener('click', function () {
      if (!state.places.length) { toast(t('toast.noPlacesToExport')); return; }
      download('whereabouts-places.json', JSON.stringify(state.places, null, 2), 'application/json');
    });


    // Tile images fail silently; surface it once so a blank map isn't a mystery.
    var tileErrors = 0;
    map.el.addEventListener('error', function (e) {
      if (!e.target || !e.target.classList.contains('mm-tile')) return;
      if (++tileErrors === 4) {
        banner(t('banner.tilesOffline'), 'warn');
      }
    }, true);

    // Dragging the map means the user is looking somewhere else on purpose.
    map.on('move', function () { syncHash(); });
    map.el.addEventListener('pointerdown', function () { state.followMe = false; });

    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'l') locateOnce();
      if (e.key === 'f') toggleFullscreen();
      if (e.key === 'Escape' && state.immersive) setImmersive(false);
      if (e.key === '+' || e.key === '=') map.zoomBy(1);
      if (e.key === '-') map.zoomBy(-1);
    });
  }

  function init() {
    loadStorage();
    applyTheme();
    applyAccent();

    var start = parseHash() || { lat: 20, lng: 0, zoom: 3 };
    start.tileUrl = prefersDark() ? BASEMAP.dark : BASEMAP.light;
    map = new MiniMap($('map'), start);

    // Follow the OS theme while the app is set to auto.
    if (window.matchMedia) {
      var dark = window.matchMedia('(prefers-color-scheme: dark)');
      var onSchemeChange = function () { if (state.prefs.theme === 'auto') applyTheme(); };
      if (dark.addEventListener) dark.addEventListener('change', onSchemeChange);
      else if (dark.addListener) dark.addListener(onSchemeChange);
    }

    applyToggleLabels();
    applyPlacesEmptyText();

    // Train mode survives a reload the same way every other preference does,
    // so a phone that locked mid-journey comes back to the same screen. The
    // overlay and tab are restored directly rather than through
    // setTrainMode(), which would also force the tab and fire a query before
    // there's a fix to query with.
    if (state.prefs.trainMode) {
      map.setOverlayTileUrl(RAILWAY_TILES);
      $('tab-train').hidden = false;
    }

    // Remembers where you left the sheet and which tab was open.
    activateTab(state.prefs.activeTab || 'now');
    setSheetExpanded(!!state.prefs.sheetExpanded);

    wireUI();
    buildAccentSwatches();
    renderAccentSwatches();
    // Collapsed to just the gear on load — sets the button's own label and
    // aria-expanded rather than leaving them to the markup's defaults.
    setMapToolsOpen(false);
    renderLive();
    renderSheetSummary();
    renderCompass();
    // Heading-up needs a gesture on iOS, so a saved preference re-arms the
    // control rather than silently starting the compass.
    if (state.prefs.headingUp) toast(t('toast.tapCompass'));
    syncPlaceMarkers();
    renderPlaces();
    renderTrip();

    // A language switch needs to redraw every piece of currently-visible
    // dynamic text, not just the static data-i18n markup i18n.js already
    // handles on its own — anything a render* function or a toggle button
    // set imperatively needs a second pass in the new language.
    I18N.onChange(function () {
      applyToggleLabels();
      applyPlacesEmptyText();
      renderLive();
      renderCompass();
      renderWeather();
      renderTrain();
      renderPlaces();
      if (state.position) renderNow(); else renderSheetSummary();
      renderTrip();
      setImmersive(state.immersive);
      setMapToolsOpen(state.mapToolsOpen);
      $('sheet-handle').setAttribute('aria-label', state.sheetExpanded ? t('sheet.collapse') : t('sheet.expand'));
    });

    // A trip in progress (or just finished but not cleared) survives a
    // reload — restore its polyline and the recording button's own state;
    // syncWatch() below picks the watch back up if it was still recording.
    if (state.track.length) map.setTrack(state.track);
    if (state.tracking) {
      $('track-toggle').textContent = t('trip.stopTracking');
      $('track-toggle').classList.add('is-active');
    }

    if (!window.isSecureContext) {
      banner(t('banner.needsSecureContext'), 'warn');
    }

    // Keep "fix from …" and the trip clock honest without extra fixes.
    setInterval(function () {
      if (state.position) renderNow();
      if (state.tracking) renderTrip();
    }, 1000);

    // Geolocation prompts don't need a prior click the way more sensitive
    // APIs do, so ask right away rather than waiting for a tap — locateOnce()
    // already handles "unsupported" and "insecure context" via its own banner.
    locateOnce();

    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(function (status) {
        status.addEventListener('change', function () {
          if (status.state === 'granted') syncWatch();
          else stopWatch();
        });
      }).catch(function () { /* Safari and friends: no permission-change tracking */ });
    }

    // A hidden tab can't show a live readout, so stop drawing on the GPS for
    // one. A trip in progress is different — that has to keep recording.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (!state.tracking) stopWatch();
      } else if (state.position) {
        // Only resume once we've had a fix — never spring a permission
        // prompt on someone just for switching back to the tab.
        syncWatch();
      }
    });
  }

  /* Geolocation shouldn't be requested — and no watch/poll/timer should be
   * running — until whoever's behind the sign-in gate is actually confirmed.
   * auth.js calls this once that's settled, immediately if sign-in isn't
   * configured at all, so the app boots exactly as it always did in that
   * case. */
  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  window.Whereabouts = { start: boot, started: false };
})();
