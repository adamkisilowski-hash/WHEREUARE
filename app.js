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
    weatherPoint: null
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

  // Other modules (friends.js) hear about position updates through this
  // rather than reaching into state directly — the one seam this app
  // exposes across its otherwise-private per-file closures.
  var positionListeners = [];
  function notifyPositionListeners(point) {
    positionListeners.forEach(function (fn) { fn(point); });
  }

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
    // 200 ms ticks with a 220 ms glide each: the dot moves continuously
    // instead of hopping five times a second.
    map.setMarker('me', dest.lat, dest.lng, 'mm-marker-me', t('now.youAreHere'), { glide: 220 });
    map.setAccuracy(dest.lat, dest.lng, c.accuracy);
    if (state.followMe) map.setView(dest.lat, dest.lng, null, { animate: true, duration: 220 });
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
    renderSheetSummary();
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

  /* ----------------------------------------------------- transit mode */

  // Transit mode shows the live trains, trams and U-Bahn on the map, with the
  // railway overlay underneath. (It no longer tries to work out which line
  // you are riding; the search finds a specific train instead.)
  var RAILWAY_TILES = 'https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png';

  function setTrainMode(on) {
    state.prefs.trainMode = on;
    savePrefs();
    map.setOverlayTileUrl(on ? RAILWAY_TILES : null);
    applyToggleLabels();

    if (on) {
      startVehicles();
    } else {
      stopVehicles();
    }
    renderTrain();
  }

  function renderTrain() {
    $('train-body').hidden = !state.prefs.trainMode;
  }

  /* ------------------------------------------------------- live vehicles */

  /* Where the trains, trams and U-Bahns actually are right now. This comes
   * from the ÖBB/VOR timetable system (HAFAS) via a public hafas-rest-api
   * instance: positions are interpolated by the operator from real-time
   * prognoses, so they're "where it should be now, delays included" rather
   * than raw GPS — but they're real services with real line numbers, which
   * is the one thing OpenStreetMap can't tell us. Covers Austria (and
   * through-running trains). Buses are left out on purpose: they'd bury the
   * map. Only polled while transit mode is on, the tab is visible and the
   * map is zoomed in enough for the box to be a neighbourhood, not a
   * country. */
  var LIVE_URL = 'https://oebb.macistry.com/api/radar';
  /* Why the positions used to lag: the server caches each answer for 30 s
   * and we only asked every 30 s, so a marker could sit up to a minute
   * behind the real vehicle. Now every request is fresh (cache-busted) and,
   * instead of a single point, asks for the vehicle's predicted path over
   * the next LIVE_HORIZON seconds in LIVE_FRAMES steps. The marker is then
   * moved along that path in real time, every animation frame, so between
   * polls it keeps travelling where the timetable says it is right now —
   * delays included — rather than waiting for the next answer. The horizon
   * is capped at 60 s because above that HAFAS stops honouring the map
   * bounds and returns every vehicle in the region. */
  var LIVE_INTERVAL = 20000;
  var LIVE_HORIZON = 60;
  var LIVE_FRAMES = 6;
  var LIVE_BLEND = 1500;     // ms to ease from the shown spot onto a fresh path
  var LIVE_MIN_ZOOM = 13;
  var LIVE_KINDS = {
    nationalExpress: 'train', national: 'train', interregional: 'train',
    regional: 'train', suburban: 'train', subway: 'subway', tram: 'tram'
  };

  state.veh = { vehicles: [], timer: null, moveTimer: null, raf: 0, busy: false, failed: false, at: 0, tooFar: false };

  function liveKind(line) {
    if (!line) return null;
    var kind = LIVE_KINDS[line.product];
    // Rail replacement buses are filed under the train product they replace.
    if (kind === 'train' && /^bus/i.test(line.name || '')) return null;
    return kind || null;
  }

  // "Tram 2" -> "2", "S 80" -> "S80", "RJX19915" -> "RJX"; short enough for a marker.
  function liveShortName(line, kind) {
    var name = (line && line.name) || '';
    if (kind === 'tram') return name.replace(/^tram\s*/i, '') || 'T';
    if (kind === 'subway') return name.replace(/\s+/g, '') || 'U';
    var m = name.match(/^([A-Za-z]+)\s*(\d*)/);
    if (!m) return name || 'Zug';
    var prefix = m[1].toUpperCase(), num = m[2];
    // Long-distance trains carry a train number, not a line number.
    if (num && (num.length <= 3 || prefix === 'S')) return prefix + num;
    return prefix;
  }

  // Delay, in minutes, at the next stop the vehicle hasn't reached yet.
  function liveDelay(m) {
    var now = Date.now();
    var stops = m.nextStopovers || [];
    for (var i = 0; i < stops.length; i++) {
      var s = stops[i];
      var when = s.departure || s.arrival;
      if (!when || new Date(when).getTime() < now) continue;
      var d = s.departureDelay != null ? s.departureDelay : s.arrivalDelay;
      return d != null ? Math.round(d / 60) : null;
    }
    return null;
  }

  function mapBounds() {
    var size = map.size();
    var corners = [
      map.pointToLatLng(0, 0), map.pointToLatLng(size.w, 0),
      map.pointToLatLng(0, size.h), map.pointToLatLng(size.w, size.h)
    ];
    var b = { north: -90, south: 90, west: 180, east: -180 };
    corners.forEach(function (c) {
      b.north = Math.max(b.north, c.lat); b.south = Math.min(b.south, c.lat);
      b.east = Math.max(b.east, c.lng); b.west = Math.min(b.west, c.lng);
    });
    return b;
  }

  /* Loading by map cells. Instead of one request for whatever is on screen
   * (slow, and thrown away on every pan), the world is cut into a grid whose
   * cell size follows the zoom level. Each cell is its own small, fast
   * request, cells load in parallel, and every answer is kept for a while.
   * Panning only has to ask for the few cells that are new, and anything
   * already seen is on screen instantly while it refreshes in the background. */
  var LIVE_CELL_TTL = 18000;     // ms before a cell is asked for again
  var LIVE_KEEP = 150000;        // ms an old answer may still be shown
  var LIVE_MAX_CELLS = 12;
  var LIVE_MAX_INFLIGHT = 6;
  state.veh.cells = {};
  state.veh.plan = null;
  state.veh.inflight = 0;
  state.veh.moveFirst = 0;

  function cellPlan() {
    var b = mapBounds();
    var span = Math.max(b.east - b.west, b.north - b.south, 1e-4);
    var level = clampNum(Math.ceil(Math.log(360 / span) / Math.LN2), 6, 16);
    var cell, i0, i1, j0, j1, pad;
    for (; level >= 6; level--) {
      cell = 360 / Math.pow(2, level);
      pad = cell * 0.2;                      // a little look-ahead past the edges
      i0 = Math.floor((b.south - pad) / cell); i1 = Math.floor((b.north + pad) / cell);
      j0 = Math.floor((b.west - pad) / cell);  j1 = Math.floor((b.east + pad) / cell);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) <= LIVE_MAX_CELLS) break;
    }
    var cells = [];
    var c = map.getView();
    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var cell0 = {
          key: level + ':' + i + ':' + j,
          south: i * cell, north: (i + 1) * cell, west: j * cell, east: (j + 1) * cell
        };
        cell0.d = Math.hypot((cell0.south + cell0.north) / 2 - c.lat, (cell0.west + cell0.east) / 2 - c.lng);
        cells.push(cell0);
      }
    }
    cells.sort(function (p, q) { return p.d - q.d; });   // nearest the centre first
    return { level: level, cells: cells };
  }

  function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function refreshVehicles(force) {
    if (!state.prefs.trainMode) return;
    if (document.hidden) return;
    if (map.getView().zoom < LIVE_MIN_ZOOM) {
      state.veh.tooFar = true;
      state.veh.vehicles = [];
      state.veh.plan = null;
      map.clearMarkers('veh:');
      vehOnMap = {};
      renderVehicles();
      return;
    }
    state.veh.tooFar = false;
    var plan = state.veh.plan = cellPlan();
    var now = Date.now();
    var queue = plan.cells.filter(function (c) {
      var e = state.veh.cells[c.key];
      if (e && e.busy) return false;
      return force || !e || now - e.at >= LIVE_CELL_TTL;
    });
    rebuildVehicles();                       // cached cells show up right away
    var room = LIVE_MAX_INFLIGHT - state.veh.inflight;
    for (var i = 0; i < queue.length && i < room; i++) fetchCell(queue[i]);
  }

  function fetchVehicles() { refreshVehicles(false); }

  function fetchCell(c) {
    var e = state.veh.cells[c.key] || (state.veh.cells[c.key] = { at: 0, list: [], busy: false, failed: false });
    e.busy = true;
    state.veh.inflight++;
    var url = LIVE_URL + '?north=' + c.north.toFixed(5) + '&south=' + c.south.toFixed(5) +
      '&west=' + c.west.toFixed(5) + '&east=' + c.east.toFixed(5) +
      '&results=600&duration=' + LIVE_HORIZON + '&frames=' + LIVE_FRAMES +
      '&polylines=true&_=' + Date.now() + Math.floor(Math.random() * 1000);
    // The server works out "where is it now" when the request arrives, so
    // the moment we send it is the path's t=0 (give or take the latency).
    var sentAt = Date.now();
    var ctl = window.AbortController ? new AbortController() : null;
    var timeout = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('radar failed: ' + r.status);
        return r.json();
      })
      .then(function (data) {
        e.list = parseMovements((data && data.movements) || [], sentAt);
        e.at = Date.now();
        e.failed = false;
      })
      .catch(function () {
        e.failed = true;
        e.at = Date.now() - LIVE_CELL_TTL + 4000;   // try again in a few seconds
      })
      .then(function () {
        clearTimeout(timeout);
        e.busy = false;
        state.veh.inflight--;
        state.veh.at = Date.now();
        rebuildVehicles();
        // Pick up any cells that had to wait for a free slot.
        if (state.veh.plan && state.veh.plan.cells.some(function (p) {
          var q = state.veh.cells[p.key]; return !q || (!q.busy && !q.at);
        })) refreshVehicles(false);
      });
  }

  function parseMovements(list, sentAt) {
    var seen = {};
    return list.map(function (m) {
      var kind = liveKind(m.line);
      if (!kind || !m.location || m.location.latitude == null) return null;
      if (seen[m.tripId]) return null;
      seen[m.tripId] = true;
      return {
        id: m.tripId,
        kind: kind,
        name: (m.line && m.line.name) || '',
        short: liveShortName(m.line, kind),
        direction: m.direction || '',
        lat: m.location.latitude,
        lng: m.location.longitude,
        delay: liveDelay(m),
        path: livePath(m),
        t0: sentAt,
        step: LIVE_HORIZON * 1000 / LIVE_FRAMES,
        blend: null,
        adopted: false,
        next: (m.nextStopovers || []).slice(0, 6).map(function (x) {
          return {
            stop: { name: (x.stop && x.stop.name) || '' },
            arrival: x.arrival, departure: x.departure,
            arrivalDelay: x.arrivalDelay, departureDelay: x.departureDelay,
            cancelled: x.cancelled
          };
        })
      };
    }).filter(Boolean);
  }

  /* Merges every wanted cell into the vehicle set that is drawn. A vehicle
   * that sits in two cells takes the fresher answer. When a fresh path
   * replaces one already on screen, the marker eases over instead of jumping. */
  function rebuildVehicles() {
    var plan = state.veh.plan;
    if (!plan) return;
    var now = Date.now();
    var entries = [];
    var pending = false, failedAll = true;
    plan.cells.forEach(function (c) {
      var e = state.veh.cells[c.key];
      if (!e) { pending = true; return; }
      if (e.busy) pending = true;
      if (!e.failed) failedAll = false;
      if (e.at && now - e.at < LIVE_KEEP && e.list) entries.push(e);
    });
    entries.sort(function (p, q) { return p.at - q.at; });
    var byId = {};
    entries.forEach(function (e) { e.list.forEach(function (v) { byId[v.id] = v; }); });

    var previous = {};
    state.veh.vehicles.forEach(function (v) { previous[v.id] = v; });
    var out = [];
    Object.keys(byId).forEach(function (id) {
      var v = byId[id];
      var old = previous[id];
      if (old && old !== v && !v.adopted) {
        var fresh = pathPosition(v, now);
        v.blend = { dlat: old.lat - fresh.lat, dlng: old.lng - fresh.lng, t0: now };
        v.lat = old.lat;
        v.lng = old.lng;
      }
      v.adopted = true;
      out.push(v);
    });
    state.veh.vehicles = out;
    state.veh.failed = failedAll && !entries.length && !pending;
    if (entries.length || !pending) state.veh.at = state.veh.at || now;
    drawVehicleMarkers();
    renderVehicles();
    tickVehicles();
  }

  // The predicted path as [{lat, lng}], one point per LIVE_HORIZON/LIVE_FRAMES
  // seconds starting at "now". Falls back to the single current position.
  function livePath(m) {
    var feats = m.polyline && m.polyline.features;
    var pts = [];
    if (feats && feats.length) {
      feats.forEach(function (f) {
        var c = f && f.geometry && f.geometry.coordinates;
        if (c && c.length >= 2) pts.push({ lat: c[1], lng: c[0] });
      });
    }
    if (!pts.length) pts.push({ lat: m.location.latitude, lng: m.location.longitude });
    return pts;
  }

  // Where along its path a vehicle is at wall-clock `now`. Past the end of
  // the path it holds the last point rather than inventing movement.
  function pathPosition(v, now) {
    var path = v.path;
    if (path.length === 1) return path[0];
    var e = Math.max(0, now - v.t0);
    var i = Math.floor(e / v.step);
    if (i >= path.length - 1) return path[path.length - 1];
    var f = (e - i * v.step) / v.step;
    var a = path[i], b = path[i + 1];
    return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
  }

  /* Runs every animation frame while vehicles are shown: advances each one
   * along its predicted path, eases out any blend from the previous poll,
   * and moves the markers in one batch. Pauses itself when the tab is
   * hidden (rAF stops) and when there's nothing left to move. */
  function tickVehicles() {
    if (state.veh.raf) return;
    var step = function () {
      state.veh.raf = 0;
      if (!state.prefs.trainMode || !state.veh.vehicles.length) return;
      var now = Date.now();
      // Vehicles creep a fraction of a pixel per frame; moving them ~20x a
      // second looks identical but saves the GPU re-blurring the glass above.
      if (state.veh.lastTick && now - state.veh.lastTick < 48 && !state.veh.forceTick) {
        state.veh.raf = requestAnimationFrame(step);
        return;
      }
      state.veh.lastTick = now;
      state.veh.forceTick = false;
      var moving = false;
      state.veh.vehicles.forEach(function (v) {
        var p = pathPosition(v, now);
        if (v.blend) {
          var k = Math.min(1, (now - v.blend.t0) / LIVE_BLEND);
          var w = 1 - (1 - Math.pow(1 - k, 3));
          p = { lat: p.lat + v.blend.dlat * w, lng: p.lng + v.blend.dlng * w };
          if (k >= 1) v.blend = null;
        }
        if (v.blend || (now - v.t0) < v.step * (v.path.length - 1)) moving = true;
        v.lat = p.lat;
        v.lng = p.lng;
        map.setMarkerPosition('veh:' + v.id, p.lat, p.lng);
      });
      map.refreshMarkers();
      if (moving) state.veh.raf = requestAnimationFrame(step);
    };
    state.veh.raf = requestAnimationFrame(step);
  }

  /* Markers are created once per vehicle and then only moved by the ticker;
   * departed vehicles are removed, new ones fade in. */
  var vehOnMap = {};
  function drawVehicleMarkers() {
    if (!state.prefs.trainMode) { map.clearMarkers('veh:'); vehOnMap = {}; return; }
    var next = {};
    state.veh.vehicles.forEach(function (v) {
      var id = 'veh:' + v.id;
      var label = t('live.kind.' + v.kind) + ' ' + v.short + ' → ' + v.direction;
      var el = map.setMarker(id, v.lat, v.lng, 'mm-marker-veh mm-veh-' + v.kind, label);
      if (el.textContent !== v.short) el.textContent = v.short;
      next[id] = true;
    });
    Object.keys(vehOnMap).forEach(function (id) {
      if (!next[id]) map.removeMarker(id);
    });
    vehOnMap = next;
    if (state.vcard && state.vcard.id) selectVehicleMarker(state.vcard.id);
  }

  function liveTypeLabel(kind) { return t('live.kind.' + kind); }

  function renderVehicles() {
    var host = $('veh-list');
    if (!host) return;
    var status = $('veh-status');
    var c = state.position && state.position.coords;
    var ref = c ? { lat: c.latitude, lng: c.longitude } : map.getView();
    var items = state.veh.vehicles.map(function (v) {
      return { v: v, d: distance(ref, v) };
    }).sort(function (a, b) { return a.d - b.d; }).slice(0, 10);

    if (state.veh.tooFar) status.textContent = t('live.zoomIn');
    else if (state.veh.failed) status.textContent = t('live.failed');
    else if (!state.veh.at) status.textContent = t('live.loading');
    else if (!items.length) status.textContent = t('live.none');
    else status.textContent = t('live.updated', { n: state.veh.vehicles.length });

    host.innerHTML = items.map(function (it) {
      var v = it.v;
      var delay = v.delay == null ? '' : (v.delay > 0 ? ' · +' + v.delay + ' min' : ' · ' + t('live.onTime'));
      return '<li class="train-stop veh-item">' +
        '<span class="veh-badge mm-veh-' + v.kind + '">' + escapeHtml(v.short) + '</span>' +
        '<span class="train-stop-name">' + escapeHtml(liveTypeLabel(v.kind)) + ' → ' + escapeHtml(v.direction) + '</span>' +
        '<span class="train-stop-meta">' + escapeHtml(formatDistance(it.d)) + escapeHtml(delay) + '</span>' +
      '</li>';
    }).join('');
  }

  function startVehicles() {
    stopVehicles();
    refreshVehicles(true);
    state.veh.timer = setInterval(function () { refreshVehicles(false); }, LIVE_INTERVAL);
  }

  function stopVehicles() {
    if (state.veh.timer) clearInterval(state.veh.timer);
    if (state.veh.moveTimer) clearTimeout(state.veh.moveTimer);
    closeVehicleCard();
    if (state.veh.raf) cancelAnimationFrame(state.veh.raf);
    state.veh.timer = null;
    state.veh.moveTimer = null;
    state.veh.raf = 0;
    state.veh.vehicles = [];
    state.veh.cells = {};
    state.veh.plan = null;
    state.veh.at = 0;
    if (map) map.clearMarkers('veh:');
    vehOnMap = {};
    renderVehicles();
  }

  // Panning or zooming asks for the cells that came into view: shortly after
  // the map pauses, and at the latest every 350 ms while it keeps moving.
  function scheduleVehicles() {
    if (!state.prefs.trainMode) return;
    var v = state.veh, t = Date.now();
    if (!v.moveFirst) v.moveFirst = t;
    if (v.moveTimer) clearTimeout(v.moveTimer);
    v.moveTimer = setTimeout(function () {
      v.moveFirst = 0;
      v.moveTimer = null;
      refreshVehicles(false);
    }, t - v.moveFirst > 350 ? 0 : 120);
  }

  /* ------------------------------------------------------ vehicle details */

  /* Tapping a train, tram or U-Bahn opens a small card: where it's going,
   * where it came from, when it arrives, and the next five stops. The live
   * radar only knows the next few stops, so the full run comes from a
   * second request for that one trip (cached, refreshed while the card is
   * open). Markers sit in a pointer-events:none layer, so taps are matched
   * to the nearest vehicle in the map's own click handler instead. */
  var TRIP_URL = 'https://oebb.macistry.com/api/trips/';
  var TAP_RADIUS = 30;       // px — fat-finger forgiveness
  var NEXT_STOPS = 5;
  var tripCache = {};        // tripId -> { at, trip } | { at, failed }
  state.vcard = { id: null, timer: null, loading: {}, leaveTimer: null, html: '' };

  function cleanStopName(name) {
    return String(name || '')
      .replace(/^Wien\s+/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim() || String(name || '');
  }

  function clockTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function delayChip(seconds) {
    if (seconds == null) return '';
    var min = Math.round(seconds / 60);
    return min > 0
      ? '<span class="vc-delay is-late">+' + min + ' min</span>'
      : '<span class="vc-delay">' + escapeHtml(t('live.onTime')) + '</span>';
  }

  function findVehicle(id) {
    for (var i = 0; i < state.veh.vehicles.length; i++) {
      if (state.veh.vehicles[i].id === id) return state.veh.vehicles[i];
    }
    return null;
  }

  // Nearest shown vehicle to a tap, if one is close enough.
  function vehicleAt(latlng) {
    if (!state.prefs.trainMode) return null;
    var tap = map.latLngToPoint(latlng.lat, latlng.lng);
    var best = null, bestD = TAP_RADIUS;
    state.veh.vehicles.forEach(function (v) {
      var p = map.latLngToPoint(v.lat, v.lng);
      var d = Math.hypot(p.x - tap.x, p.y - tap.y);
      if (d <= bestD) { bestD = d; best = v; }
    });
    return best;
  }

  function selectVehicleMarker(id) {
    Object.keys(map.markers).forEach(function (k) {
      if (k.indexOf('veh:') === 0) map.markers[k].el.classList.toggle('is-selected', k === 'veh:' + id);
    });
  }

  function openVehicleCard(v) {
    var host = $('veh-card');
    clearSearchPin();
    var wasOpen = !host.hidden && !host.classList.contains('is-leaving');
    clearTimeout(state.vcard.leaveTimer);
    host.classList.remove('is-leaving');
    host.style.removeProperty('translate');
    host.style.removeProperty('transition');
    state.vcard.id = v.id;
    state.vcard.last = v;
    state.vcard.html = '';
    state.vcard.pinSeen = false;
    selectVehicleMarker(v.id);
    // First open: the card springs up and its rows cascade in. Switching to
    // another vehicle while open: just a quick cross-fade, no re-entrance.
    host.classList.toggle('is-entering', !wasOpen);
    host.classList.toggle('is-swapping', wasOpen);
    clearTimeout(state.vcard.settleTimer);
    state.vcard.settleTimer = setTimeout(function () {
      host.classList.remove('is-entering', 'is-swapping');
    }, 900);
    host.scrollTop = 0;
    renderVehicleCard();
    loadTrip(v.id, false);
    clearInterval(state.vcard.timer);
    // Re-evaluate "which stops are still ahead" every few seconds, and pull
    // fresh delays every 30 s while the card stays open.
    var n = 0;
    state.vcard.timer = setInterval(function () {
      n++;
      if (n % 6 === 0 || (state.vcard.pin && n % 2 === 0)) loadTrip(state.vcard.id, true);
      renderVehicleCard();
    }, 5000);
  }

  function closeVehicleCard(instant) {
    if (!state.vcard.id) return;
    var host = $('veh-card');
    state.vcard.id = null;
    clearInterval(state.vcard.timer);
    state.vcard.timer = null;
    selectVehicleMarker(null);
    clearTimeout(state.vcard.leaveTimer);
    var finish = function () {
      host.hidden = true;
      host.innerHTML = '';
      host.classList.remove('is-leaving', 'is-entering', 'is-swapping');
      host.style.removeProperty('translate');
      host.style.removeProperty('transition');
      state.vcard.html = '';
      clearSearchPin();
    };
    if (instant === true || host.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    host.classList.add('is-leaving');
    state.vcard.leaveTimer = setTimeout(finish, 260);
  }

  function loadTrip(id, force) {
    var cached = tripCache[id];
    if (!force && cached && !cached.failed && Date.now() - cached.at < 25000) return;
    if (state.vcard.loading[id]) return;
    state.vcard.loading[id] = true;
    fetch(TRIP_URL + encodeURIComponent(id) + '?stopovers=true&remarks=false&polyline=false', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('trip failed: ' + r.status);
        return r.json();
      })
      .then(function (data) {
        tripCache[id] = { at: Date.now(), trip: data.trip || data };
        var loc = tripCache[id].trip.currentLocation;
        if (state.vcard.id === id && state.vcard.pin && loc && loc.latitude != null) {
          var first = !state.vcard.pinSeen;
          state.vcard.pinSeen = true;
          map.setMarkerPosition('search:pin', loc.latitude, loc.longitude);
          map.refreshMarkers();
          if (first && state.vcard.last && state.vcard.last.fromDeparture) {
            map.setView(loc.latitude, loc.longitude, null, { animate: true, duration: 800 });
          }
        }
      })
      .catch(function () {
        // Keep an older successful answer rather than replace it with an error.
        if (!tripCache[id] || tripCache[id].failed) tripCache[id] = { at: Date.now(), failed: true };
      })
      .then(function () {
        state.vcard.loading[id] = false;
        if (state.vcard.id === id) renderVehicleCard();
      });
  }

  // The stop the vehicle is heading for: first one whose (delay-adjusted)
  // time hasn't passed yet, with a little grace so a stop it's standing at
  // doesn't vanish the instant the clock ticks over.
  function upcomingStops(trip) {
    var cutoff = Date.now() - 20000;
    var stops = trip.stopovers || [];
    var out = [];
    for (var i = 0; i < stops.length; i++) {
      var s = stops[i];
      if (s.cancelled) continue;
      var when = s.arrival || s.departure;
      if (!when) continue;
      if (new Date(when).getTime() >= cutoff) out.push(s);
    }
    return out;
  }

  // The headsign names where the service is going ("Dornbach"); the trip's
  // own last stop can be a stop or two further on. Prefer the stop that
  // matches the headsign, fall back to the trip's end.
  function pickDestination(trip, direction, ahead) {
    var want = cleanStopName(direction).toLowerCase();
    if (want) {
      for (var i = ahead.length - 1; i >= 0; i--) {
        var n = cleanStopName(ahead[i].stop.name).toLowerCase();
        if (n === want || n.indexOf(want) === 0 || want.indexOf(n) === 0) {
          return { name: ahead[i].stop.name, at: ahead[i].arrival || ahead[i].departure, delay: ahead[i].arrivalDelay };
        }
      }
    }
    return { name: trip.destination && trip.destination.name, at: trip.arrival, delay: trip.arrivalDelay };
  }

  function renderVehicleCard() {
    var id = state.vcard.id;
    var host = $('veh-card');
    if (!id) return;
    var v = findVehicle(id);
    var entry = tripCache[id];
    // The vehicle can leave the visible area; keep what we last knew.
    if (!v) { v = state.vcard.last; } else { state.vcard.last = v; }
    if (!v) { closeVehicleCard(); return; }

    var head =
      '<div class="vc-head">' +
        '<span class="vc-badge mm-veh-' + v.kind + '">' + escapeHtml(v.short) + '</span>' +
        '<div class="vc-title"><strong>' + escapeHtml(liveTypeLabel(v.kind) + ' ' + v.short) + '</strong>' +
          '<span>' + escapeHtml(t('veh.toward', { dest: cleanStopName(v.direction) })) + '</span></div>' +
        '<button type="button" class="vc-close" id="vc-close" aria-label="' + escapeHtml(t('veh.close')) + '">×</button>' +
      '</div>';

    var body;
    if (!entry && v.next && v.next.length) {
      // The trip request is still on its way, but the radar already named
      // the next stops: show those straight away instead of a blank card.
      var soon = upcomingStops({ stopovers: v.next }).slice(0, NEXT_STOPS);
      body =
        '<div class="vc-route vc-skeleton" aria-busy="true"><span class="vc-shimmer"></span></div>' +
        '<h3 class="vc-sub">' + escapeHtml(t('veh.nextStops')) + '</h3>' +
        stopListHtml(soon);
    } else if (!entry) {
      body = '<div class="vc-route vc-skeleton" aria-busy="true"><span class="vc-shimmer"></span></div>' +
        '<p class="vc-note">' + escapeHtml(t('veh.loading')) + '</p>';
    } else if (entry.failed) {
      body = '<p class="vc-note">' + escapeHtml(t('veh.failed')) + '</p>';
    } else {
      var trip = entry.trip;
      var ahead = upcomingStops(trip);
      var dest = pickDestination(trip, v.direction, ahead);
      var next = ahead.slice(0, NEXT_STOPS);
      var from = trip.origin || {};
      body =
        '<div class="vc-route">' +
          '<div class="vc-end"><span class="vc-label">' + escapeHtml(t('veh.from')) + '</span>' +
            '<span class="vc-place">' + escapeHtml(cleanStopName(from.name)) + '</span>' +
            '<span class="vc-time">' + escapeHtml(t('veh.dep')) + ' ' + escapeHtml(clockTime(trip.departure)) + '</span></div>' +
          '<span class="vc-arrow" aria-hidden="true">→</span>' +
          '<div class="vc-end"><span class="vc-label">' + escapeHtml(t('veh.dest')) + '</span>' +
            '<span class="vc-place">' + escapeHtml(cleanStopName(dest.name)) + '</span>' +
            '<span class="vc-time">' + escapeHtml(t('veh.arr')) + ' ' + escapeHtml(clockTime(dest.at)) + ' ' + delayChip(dest.delay) + '</span></div>' +
        '</div>' +
        '<h3 class="vc-sub">' + escapeHtml(t('veh.nextStops')) + '</h3>' +
        (next.length ? stopListHtml(next) : '<p class="vc-note">' + escapeHtml(t('veh.lastStop')) + '</p>');
    }

    var html = head + body;
    // Nothing changed since the last pass (the common case on the 5 s
    // refresh): leave the DOM alone, so there is no flicker, no restarted
    // animation and no lost scroll position.
    if (html === state.vcard.html && !host.hidden) return;
    state.vcard.html = html;
    var keep = host.scrollTop;
    host.innerHTML = html;
    host.hidden = false;
    host.scrollTop = keep;
    // Only a card taller than its limit scrolls; otherwise vertical touch
    // belongs to the swipe-to-dismiss gesture.
    host.classList.toggle('is-scrollable', host.scrollHeight > host.clientHeight + 2);
    $('vc-close').addEventListener('click', function () { closeVehicleCard(); });
  }

  function stopListHtml(next) {
    if (!next.length) return '<p class="vc-note">' + escapeHtml(t('veh.lastStop')) + '</p>';
    return '<ol class="vc-stops">' + next.map(function (s, i) {
      var when = s.arrival || s.departure;
      var mins = Math.round((new Date(when).getTime() - Date.now()) / 60000);
      return '<li' + (i === 0 ? ' class="is-next"' : '') + '>' +
        '<span class="vc-stop-name" title="' + escapeHtml(s.stop.name) + '">' + escapeHtml(cleanStopName(s.stop.name)) + '</span>' +
        '<span class="vc-stop-time">' + escapeHtml(clockTime(when)) +
          (mins > 0 && mins < 60 ? ' <em>' + escapeHtml(t('time.etaMin', { n: mins })) + '</em>' : '') + '</span>' +
      '</li>';
    }).join('') + '</ol>';
  }


  /* ------------------------------------------------------ transit search */

  /* Search for a train, tram or U-Bahn line, a destination, or a station.
   *  - Trains: one snapshot of every train, tram and U-Bahn in Austria,
   *    fetched in a few parallel pieces the first time the field is used and
   *    kept for a minute. Matching happens on the phone, so typing is instant.
   *  - Stations: the timetable's own station search. Tapping a station lists
   *    its next departures, and tapping a departure opens that train's card. */
  var TS_TTL = 60000;
  var TS_LAT = [46.3, 47.7, 49.1];
  var TS_LNG = [9.5, 11.5, 13.5, 15.5, 17.2];
  var TS = {
    index: [], at: 0, loading: false, failed: false,
    stops: [], stopsFor: '', stopsPending: false, stopsFailed: false,
    seq: 0, timer: null, station: null
  };

  function tsLoadIndex(force) {
    if (TS.loading) return;
    if (!force && TS.index.length && Date.now() - TS.at < TS_TTL) return;
    TS.loading = true;
    TS.failed = false;
    var jobs = [];
    for (var i = 0; i < TS_LAT.length - 1; i++) {
      for (var j = 0; j < TS_LNG.length - 1; j++) {
        jobs.push({ s: TS_LAT[i], n: TS_LAT[i + 1], w: TS_LNG[j], e: TS_LNG[j + 1] });
      }
    }
    var okCount = 0, all = [];
    Promise.all(jobs.map(function (b) {
      var url = LIVE_URL + '?north=' + b.n + '&south=' + b.s + '&west=' + b.w + '&east=' + b.e +
        '&results=1000&duration=0&frames=1&polylines=false&_=' + Date.now() + Math.floor(Math.random() * 1000);
      return fetch(url, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('radar ' + r.status); return r.json(); })
        .then(function (d) { okCount++; return (d && d.movements) || []; })
        .catch(function () { return []; });
    })).then(function (parts) {
      var seen = {};
      parts.forEach(function (list) {
        list.forEach(function (m) {
          var kind = liveKind(m.line);
          if (!kind || !m.location || m.location.latitude == null || seen[m.tripId]) return;
          seen[m.tripId] = true;
          var name = (m.line && m.line.name) || '';
          var dir = m.direction || '';
          all.push({
            id: m.tripId, kind: kind, name: name, short: liveShortName(m.line, kind),
            direction: dir, lat: m.location.latitude, lng: m.location.longitude,
            t0: Date.now(), path: [{ lat: m.location.latitude, lng: m.location.longitude }], step: 1000,
            next: (m.nextStopovers || []).slice(0, 6).map(function (x) {
              return { stop: { name: (x.stop && x.stop.name) || '' }, arrival: x.arrival, departure: x.departure,
                arrivalDelay: x.arrivalDelay, departureDelay: x.departureDelay, cancelled: x.cancelled };
            }),
            nameKey: name.toLowerCase().replace(/[\s.\-]/g, ''),
            shortKey: liveShortName(m.line, kind).toLowerCase(),
            text: (name + ' ' + dir).toLowerCase()
          });
        });
      });
      if (okCount === 0) { TS.failed = true; } else { TS.index = all; TS.at = Date.now(); }
      TS.loading = false;
      tsRender();
    });
  }

  function tsMatch(q) {
    var qn = q.replace(/[\s.\-]/g, '');
    var tokens = q.split(/\s+/).filter(Boolean);
    var c = map.getView();
    var out = [];
    TS.index.forEach(function (v) {
      var score = 0;
      if (qn === v.shortKey) score = 100;
      else if (v.nameKey.indexOf(qn) === 0 || v.nameKey.replace(/^(tram|bus)/, '').indexOf(qn) === 0) score = 85;
      else if (v.nameKey.indexOf(qn) > -1) score = 70;
      else if (tokens.every(function (tk) { return v.text.indexOf(tk) > -1; })) score = 50;
      if (score) out.push({ v: v, score: score, d: distance(c, v) });
    });
    out.sort(function (a, b) { return b.score - a.score || a.d - b.d; });
    return out.slice(0, 30);
  }

  function tsRef() {
    var p = state.position && state.position.coords;
    return p ? { lat: p.latitude, lng: p.longitude } : map.getView();
  }

  function tsRender() {
    var input = $('ts-input');
    var q = input.value.trim().toLowerCase();
    $('ts-clear').hidden = !input.value;
    var box = $('ts-results');
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    $('ts-deps').hidden = true;

    var ref = tsRef();
    var hits = TS.index.length ? tsMatch(q) : [];
    $('ts-trains-wrap').hidden = !hits.length;
    $('ts-trains').innerHTML = hits.map(function (h, i) {
      var v = h.v;
      return '<li class="train-stop veh-item ts-item" tabindex="0" role="button" data-train="' + i + '">' +
        '<span class="veh-badge mm-veh-' + v.kind + '">' + escapeHtml(v.short) + '</span>' +
        '<span class="train-stop-name">' + escapeHtml(liveTypeLabel(v.kind) + ' → ' + cleanStopName(v.direction)) + '</span>' +
        '<span class="train-stop-meta">' + escapeHtml(formatDistance(distance(ref, v))) + '</span></li>';
    }).join('');
    TS.hits = hits;

    var stops = TS.stopsFor === q ? TS.stops : [];
    $('ts-stops-wrap').hidden = !stops.length;
    $('ts-stops').innerHTML = stops.map(function (s, i) {
      return '<li class="train-stop ts-item" tabindex="0" role="button" data-stop="' + i + '">' +
        '<span class="ts-pin" aria-hidden="true"></span>' +
        '<span class="train-stop-name">' + escapeHtml(s.name) + '</span>' +
        (s.location ? '<span class="train-stop-meta">' + escapeHtml(formatDistance(distance(ref, { lat: s.location.latitude, lng: s.location.longitude }))) + '</span>' : '') +
      '</li>';
    }).join('');

    var status = '';
    if (!hits.length && !stops.length) {
      if (TS.loading || TS.stopsPending) status = TS.loading && !TS.index.length ? t('ts.loading') : t('ts.searching');
      else if (TS.failed && TS.stopsFailed) status = t('ts.failed');
      else status = t('ts.none');
    } else if (TS.loading && !TS.index.length) {
      status = t('ts.loading');
    }
    $('ts-status').textContent = status;
    $('ts-status').hidden = !status;
  }

  function tsQueryStops(q) {
    var my = ++TS.seq;
    if (q.length < 2) { TS.stops = []; TS.stopsFor = ''; TS.stopsPending = false; tsRender(); return; }
    TS.stopsPending = true;
    TS.stopsFailed = false;
    fetch(TRIP_URL.replace('/trips/', '/locations') + '?query=' + encodeURIComponent(q) +
      '&results=6&fuzzy=true&stops=true&addresses=false&poi=false', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('loc ' + r.status); return r.json(); })
      .then(function (d) {
        if (my !== TS.seq) return;
        TS.stops = (d || []).filter(function (x) { return x && x.name && x.id && x.location; });
        TS.stopsFor = q;
      })
      .catch(function () { if (my === TS.seq) { TS.stops = []; TS.stopsFor = q; TS.stopsFailed = true; } })
      .then(function () { if (my === TS.seq) { TS.stopsPending = false; tsRender(); } });
  }

  // Bring a train into view and open its card. If it is not one of the live
  // markers already on the map (transit mode off, or out of the loaded area),
  // a temporary marker stands in for it.
  function tsOpenVehicle(v) {
    var live = findVehicle(v.id);
    var target = live || v;
    setSheetExpanded(false);
    openVehicleCard(target);
    if (!live) showSearchPin(v);
    var z = map.getView().zoom;
    if (z < 14.5) map.setView(target.lat, target.lng, 15);
    else map.setView(target.lat, target.lng, null, { animate: true, duration: 700 });
  }

  function showSearchPin(v) {
    var el = map.setMarker('search:pin', v.lat, v.lng, 'mm-marker-veh mm-veh-' + v.kind + ' is-selected',
      liveTypeLabel(v.kind) + ' ' + v.short);
    if (el.textContent !== v.short) el.textContent = v.short;
    state.vcard.pin = true;
  }

  function clearSearchPin() {
    if (!state.vcard.pin) return;
    state.vcard.pin = false;
    if (map) map.removeMarker('search:pin');
  }

  function tsOpenStation(stop) {
    TS.station = stop;
    var ll = stop.location ? { lat: stop.location.latitude, lng: stop.location.longitude } : null;
    if (ll) map.setView(ll.lat, ll.lng, Math.max(16, Math.round(map.getView().zoom)));
    $('ts-results').hidden = true;
    $('ts-deps').hidden = false;
    $('ts-dep-title').textContent = t('ts.depTitle') + ' · ' + stop.name;
    $('ts-dep-list').innerHTML = '';
    $('ts-dep-status').textContent = t('ts.searching');
    $('ts-dep-status').hidden = false;
    fetch(TRIP_URL.replace('/trips/', '/stops/') + encodeURIComponent(stop.id) +
      '/departures?duration=90&results=40&remarks=false&stopovers=false&linesOfStops=false', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('dep ' + r.status); return r.json(); })
      .then(function (d) {
        if (TS.station !== stop) return;
        var deps = ((d && d.departures) || d || []).filter(function (x) { return x && x.line && liveKind(x.line); }).slice(0, 16);
        TS.deps = deps;
        $('ts-dep-status').textContent = deps.length ? '' : t('ts.noDeps');
        $('ts-dep-status').hidden = !!deps.length;
        $('ts-dep-list').innerHTML = deps.map(function (x, i) {
          var kind = liveKind(x.line), short = liveShortName(x.line, kind);
          var when = x.when || x.plannedWhen;
          var delay = x.delay != null ? Math.round(x.delay / 60) : null;
          return '<li class="train-stop veh-item ts-item" tabindex="0" role="button" data-dep="' + i + '">' +
            '<span class="veh-badge mm-veh-' + kind + '">' + escapeHtml(short) + '</span>' +
            '<span class="train-stop-name">' + escapeHtml(cleanStopName(x.direction || '')) + '</span>' +
            '<span class="train-stop-meta ts-when">' + escapeHtml(clockTime(when)) +
              (delay > 0 ? ' <em class="ts-late">+' + delay + '</em>' : '') +
              (x.platform ? ' · ' + escapeHtml(t('ts.platform', { p: x.platform })) : '') + '</span></li>';
        }).join('');
      })
      .catch(function () {
        if (TS.station !== stop) return;
        $('ts-dep-status').textContent = t('ts.failed');
        $('ts-dep-status').hidden = false;
      });
  }

  function wireTransitSearch() {
    var input = $('ts-input');
    input.addEventListener('focus', function () { tsLoadIndex(false); });
    input.addEventListener('input', function () {
      tsLoadIndex(false);
      var q = input.value.trim().toLowerCase();
      tsRender();
      clearTimeout(TS.timer);
      TS.timer = setTimeout(function () { tsQueryStops(q); }, 350);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    $('ts-clear').addEventListener('click', function () {
      input.value = '';
      TS.stopsFor = '';
      tsRender();
      input.focus();
    });
    $('ts-back').addEventListener('click', function () {
      TS.station = null;
      tsRender();
    });

    function pick(e) {
      var li = e.target.closest && e.target.closest('.ts-item');
      if (!li) return;
      if (li.dataset.train != null && TS.hits[+li.dataset.train]) {
        input.blur();
        tsOpenVehicle(TS.hits[+li.dataset.train].v);
      } else if (li.dataset.stop != null) {
        var q = input.value.trim().toLowerCase();
        input.blur();
        if (TS.stopsFor === q && TS.stops[+li.dataset.stop]) tsOpenStation(TS.stops[+li.dataset.stop]);
      } else if (li.dataset.dep != null && TS.deps && TS.deps[+li.dataset.dep]) {
        var x = TS.deps[+li.dataset.dep];
        var kind = liveKind(x.line), st = TS.station && TS.station.location;
        tsOpenVehicle({
          id: x.tripId, kind: kind, name: x.line.name || '', short: liveShortName(x.line, kind),
          direction: x.direction || '', lat: st ? st.latitude : map.getView().lat, lng: st ? st.longitude : map.getView().lng,
          next: null, path: [], t0: Date.now(), step: 1000, fromDeparture: true
        });
      }
    }
    ['ts-trains', 'ts-stops', 'ts-dep-list'].forEach(function (id) {
      $(id).addEventListener('click', pick);
      $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); }
      });
    });
  }

  /* Swipe the card down to dismiss it. It follows the finger one-to-one,
   * resists a little upward, and either flies off (fast or far enough) or
   * springs back. Only starts when the list is scrolled to the top, so
   * scrolling a long stop list still works. */
  function wireVehicleCardDrag() {
    var host = $('veh-card');
    var startY = 0, dy = 0, active = false, t0 = 0, pid = null;
    host.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button') || host.scrollTop > 0) return;
      active = true; pid = e.pointerId; startY = e.clientY; dy = 0; t0 = performance.now();
    });
    host.addEventListener('pointermove', function (e) {
      if (!active || e.pointerId !== pid) return;
      var d = e.clientY - startY;
      if (Math.abs(d) < 6 && dy === 0) return;
      if (dy === 0) {
        try { host.setPointerCapture(pid); } catch (err) { /* gone */ }
        host.style.transition = 'none';
      }
      dy = d > 0 ? d : d / 4;                  // rubber-band upwards
      host.style.translate = '0 ' + dy + 'px';
    });
    function end(e) {
      if (!active || (e && e.pointerId !== pid)) return;
      active = false;
      if (dy === 0) return;
      var v = dy / Math.max(1, performance.now() - t0);   // px per ms
      host.style.transition = '';
      if (dy > 70 || v > 0.5) {
        host.style.transition = 'translate 0.22s cubic-bezier(0.4, 0, 1, 1), opacity 0.22s';
        host.style.translate = '0 ' + Math.max(dy + 160, 220) + 'px';
        host.style.opacity = '0';
        setTimeout(function () {
          host.style.removeProperty('opacity');
          closeVehicleCard(true);
        }, 220);
      } else {
        host.style.transition = 'translate 0.45s cubic-bezier(0.22, 1.25, 0.36, 1)';
        host.style.translate = '0 0';
      }
      dy = 0;
    }
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
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

    map.setMarker('me', point.lat, point.lng, 'mm-marker-me', t('now.youAreHere'), recenter ? null : { glide: 600 });
    map.setAccuracy(point.lat, point.lng, c.accuracy);
    if (recenter) {
      // An explicit locate reframes the map; a passive watch update just slides.
      map.setView(point.lat, point.lng, zoomForAccuracy(c.accuracy));
    } else if (state.followMe) {
      map.setView(point.lat, point.lng, null, { animate: true, duration: 600 });
    }

    renderNow();
    renderPlaces();
    renderTrain();
    if (state.prefs.trainMode) renderVehicles();
    notifyPositionListeners({ lat: point.lat, lng: point.lng });
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

  // The collapsed sheet: where you are, plus the numbers that matter at a
  // glance — speed, accuracy, altitude, heading — and a chip for the live
  // trip distance (while recording) or the weather.
  function renderSheetSummary() {
    var dot = $('sheet-status-dot');
    var text = $('sheet-summary-text');
    if (!dot || !text) return;
    dot.classList.toggle('is-live', !!(state.prefs.live && state.watchId != null));
    var c = state.position && state.position.coords;
    if (!c) {
      text.textContent = state.locateBusy ? t('sheet.findingYou') : t('sheet.locationUnavailable');
    } else {
      text.textContent = state.streetName || (c.latitude.toFixed(4) + ', ' + c.longitude.toFixed(4));
    }
    setMini('mini-speed', c ? formatSpeed(c.speed) : '—');
    setMini('mini-accuracy', c && c.accuracy != null ? '±' + formatDistance(c.accuracy) : '—');
    setMini('mini-altitude', c ? formatAltitude(c.altitude) : '—');
    setMini('mini-heading', c && c.heading != null && !isNaN(c.heading) ? Math.round(c.heading) + '° ' + compassPoint(c.heading) : '—');

    var chip = $('mini-chip');
    var label = '';
    if (state.tracking) {
      label = '● ' + t('mini.trip') + ' ' + formatDistance(trackDistance());
    } else if (state.weather) {
      var info = WEATHER_CODES[state.weather.code] || [null, '🌡️'];
      var tc = state.weather.tempC;
      label = info[1] + ' ' + (isMetric() ? Math.round(tc) + '°C' : Math.round(tc * 9 / 5 + 32) + '°F');
    }
    chip.hidden = !label;
    chip.classList.toggle('is-trip', !!state.tracking);
    if (chip.textContent !== label) chip.textContent = label;
  }

  function setMini(id, value) {
    var el = $(id);
    if (el && el.textContent !== value) el.textContent = value;
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
    renderSheetSummary();
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

  // Debounced: the map now emits a move every animation frame, and Safari
  // throws if replaceState is called more than ~100 times in 10 seconds.
  var hashTimer = null;
  function syncHash() {
    if (hashTimer) clearTimeout(hashTimer);
    hashTimer = setTimeout(function () {
      hashTimer = null;
      var v = map.getView();
      var next = '#' + v.lat.toFixed(5) + ',' + v.lng.toFixed(5) + ',' + Math.round(v.zoom);
      if (location.hash !== next) history.replaceState(null, '', next);
    }, 300);
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
   * photographic negative.
   *
   * CARTO requires an API key on basemaps.cartocdn.com (since Aug 2026);
   * without one every tile carries an "API KEY REQUIRED" watermark. This is
   * a client-side key meant to be public — restrict it to this site's
   * domain in the CARTO basemaps dashboard. */
  var CARTO_KEY = 'cb1_4apb_1_f02a21833f2f32466be96328';
  var BASEMAP = {
    light: 'https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}@2x.png?key=' + CARTO_KEY,
    dark: 'https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png?key=' + CARTO_KEY
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
    $('theme-color').setAttribute('content', prefersDark() ? '#0a0a0a' : '#ffffff');
  }

  /* -------------------------------------------------------- accent colour */

  /* A chosen accent overrides the whole --accent family on the document
   * root, which every accent-coloured thing already reads through — the
   * location dot, the track line, primary buttons, active tabs. An inline
   * style on the root beats the stylesheet's :root rules, so it wins in
   * both light and dark; the default (null) removes the override and lets
   * the theme-aware stylesheet value take back over. */
  var ACCENT_PRESETS = [
    '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a',
    '#ff9f0a', '#ffd60a', '#30d158', '#00c7be', '#64d2ff',
    '#8e8e93', '#000000'
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
    return L > 0.42 ? '#111111' : '#ffffff';
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
      .getPropertyValue('--accent').trim() || '#000000';

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
    var order = Array.prototype.map.call(document.querySelectorAll('#tabs .tab'), function (t) { return t.dataset.tab; });
    var prev = document.querySelector('#tabs .tab.is-active');
    var dir = prev ? order.indexOf(name) - order.indexOf(prev.dataset.tab) : 0;
    if (dir) $('sheet-body').dataset.dir = dir > 0 ? 'fwd' : 'back';
    document.querySelectorAll('.tab').forEach(function (t) {
      var active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    moveSegPill(true);
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('is-active', p.dataset.panel === name);
    });
  }

  function setSheetExpanded(on) {
    state.sheetExpanded = on;
    state.prefs.sheetExpanded = on;
    savePrefs();
    $('sheet').dataset.state = on ? 'expanded' : 'collapsed';
    if (on && typeof closeVehicleCard === 'function') closeVehicleCard();
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
    $('train-body').hidden = !state.prefs.trainMode;
    $('train-intro').hidden = !!state.prefs.trainMode;
  }

  /* ------------------------------------------------ liquid glass slider */

  /* The tab bar is a glass track with one translucent lens under the
   * active tab. The lens is driven by a small spring simulation instead of
   * CSS transitions, which is what makes it feel liquid on a phone:
   *  - it overshoots and settles, and it stretches with its own speed;
   *  - you can grab it and drag it along the bar; it swells while held,
   *    follows your finger 1:1, reshapes to whichever tab is under it, and
   *    on release flicks to the tab its momentum points at;
   *  - a tap interrupts a move in flight and continues with the velocity it
   *    already had, so quick successive taps never snap or restart.
   * Only transform/width/scale are touched per frame. */
  var seg = {
    x: 0, w: 0, vx: 0, vw: 0, tx: 0, tw: 0, grab: 1, vg: 0, grabT: 1,
    raf: 0, last: 0, ready: false, drag: null, hot: null
  };

  function segVisibleTabs() {
    return Array.prototype.filter.call($('tabs').querySelectorAll('.tab'), function (t) { return !t.hidden && t.offsetWidth; });
  }

  function segRender() {
    var pill = $('seg-pill');
    pill.style.width = seg.w + 'px';
    pill.style.transform = 'translate3d(' + seg.x + 'px,0,0)';
    // Stretch along the direction of travel, squash a touch across it, so
    // the lens reads as a droplet in motion; "grab" is the held-swell.
    var st = Math.min(Math.abs(seg.vx) / 3400, 0.12);
    pill.style.scale = (seg.grab * (1 + st)) + ' ' + (seg.grab * (1 - st * 0.45));
  }

  // Soft, nearly critically damped spring (damping ratio ~0.9): it glides in
  // and settles with just a whisper of overshoot. Integrated in small fixed
  // steps so a slow frame can never make it jitter or blow up.
  function segSpring(p, v, target, k, c, dt) {
    var h = 1 / 240, n = Math.max(1, Math.round(dt / h)), step = dt / n;
    for (var i = 0; i < n; i++) {
      v += (-k * (p - target) - c * v) * step;
      p += v * step;
    }
    return [p, v];
  }

  // Where the lens should sit for a tab: exactly centred on the word itself
  // (measured from the text, not the button), as wide as the tab.
  function segSlot(tab) {
    var nav = $('tabs');
    var w = tab.offsetWidth;
    var node = tab.firstChild;
    if (node && node.nodeType === 3 && node.textContent.trim()) {
      var range = document.createRange();
      range.selectNodeContents(node);
      var tr = range.getBoundingClientRect();
      if (tr.width) {
        var nr = nav.getBoundingClientRect();
        var center = tr.left - nr.left - nav.clientLeft + nav.scrollLeft + tr.width / 2;
        return { left: center - w / 2, width: w };
      }
    }
    return { left: tab.offsetLeft, width: w };
  }

  function segFrame(now) {
    seg.raf = 0;
    var dt = Math.min(Math.max((now - seg.last) / 1000, 0.001), 0.034);
    seg.last = now;
    var nav = $('tabs');

    var r;
    if (seg.drag && seg.drag.moved) {
      // The finger owns x; width still springs to the tab underneath.
      var px = nav.getBoundingClientRect();
      var cx = seg.drag.lastX;
      if (cx < px.left + 28) nav.scrollLeft -= 9;
      else if (cx > px.right - 28) nav.scrollLeft += 9;
    } else {
      r = segSpring(seg.x, seg.vx, seg.tx, 380, 35, dt);
      seg.x = r[0]; seg.vx = r[1];
    }
    r = segSpring(seg.w, seg.vw, seg.tw, 380, 35, dt);
    seg.w = r[0]; seg.vw = r[1];
    r = segSpring(seg.grab, seg.vg, seg.grabT, 520, 36, dt);
    seg.grab = r[0]; seg.vg = r[1];
    segRender();

    var dragging = !!(seg.drag && seg.drag.moved);
    var settled = !dragging && !seg.drag &&
      Math.abs(seg.x - seg.tx) < 0.2 && Math.abs(seg.vx) < 1 &&
      Math.abs(seg.w - seg.tw) < 0.2 && Math.abs(seg.vw) < 1 &&
      Math.abs(seg.grab - seg.grabT) < 0.002 && Math.abs(seg.vg) < 0.02;
    if (settled) {
      seg.x = seg.tx; seg.w = seg.tw; seg.vx = seg.vw = 0; seg.grab = seg.grabT; seg.vg = 0;
      segRender();
      return;
    }
    seg.raf = requestAnimationFrame(segFrame);
  }

  function segKick() {
    if (seg.raf) return;
    seg.last = performance.now();
    seg.raf = requestAnimationFrame(segFrame);
  }

  function moveSegPill(animate) {
    var nav = $('tabs'), pill = $('seg-pill');
    if (!nav || !pill) return;
    var active = nav.querySelector('.tab.is-active');
    if (!active || active.hidden || !active.offsetWidth) { pill.style.opacity = '0'; return; }
    pill.style.opacity = '1';
    var slot = segSlot(active);
    seg.tx = slot.left;
    seg.tw = slot.width;

    if (!animate || !seg.ready) {
      seg.x = seg.tx; seg.w = seg.tw; seg.vx = seg.vw = 0;
      segRender();
      seg.ready = true;
    } else {
      segKick();
    }

    var left = seg.tx, width = seg.tw;
    var viewLeft = nav.scrollLeft, viewRight = viewLeft + nav.clientWidth;
    if (left < viewLeft + 8 || left + width > viewRight - 8) {
      nav.scrollTo({ left: Math.max(0, left - (nav.clientWidth - width) / 2), behavior: animate ? 'smooth' : 'auto' });
    }
  }

  function wireSegDrag() {
    var nav = $('tabs'), pill = $('seg-pill');

    nav.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var pr = pill.getBoundingClientRect();
      // Only a press that lands on the lens picks it up; anywhere else the
      // bar scrolls natively and a tap is a normal tab tap.
      if (e.clientX < pr.left || e.clientX > pr.right) {
        seg.grabT = 1.04;       // tiny press feedback on the lens
        segKick();
        return;
      }
      seg.drag = {
        id: e.pointerId, offset: e.clientX - pr.left - (pr.width - seg.w) / 2,
        moved: false, startX: e.clientX, lastX: e.clientX, lastT: e.timeStamp
      };
      seg.grabT = 1.1;
      segKick();
      try { nav.setPointerCapture(e.pointerId); } catch (err) {}
    });

    nav.addEventListener('pointermove', function (e) {
      var d = seg.drag;
      if (!d || d.id !== e.pointerId) return;
      if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return;
      d.moved = true;
      var tabs = segVisibleTabs();
      if (!tabs.length) return;
      var rect = nav.getBoundingClientRect();
      var first = tabs[0], last = tabs[tabs.length - 1];
      var minX = first.offsetLeft;
      var maxX = last.offsetLeft + last.offsetWidth - seg.w;
      var nx = e.clientX - rect.left + nav.scrollLeft - d.offset;
      // Rubber-band past either end rather than a hard stop.
      if (nx < minX) nx = minX - Math.min((minX - nx) * 0.35, 26);
      if (nx > maxX) nx = maxX + Math.min((nx - maxX) * 0.35, 26);
      var dt = Math.max((e.timeStamp - d.lastT) / 1000, 0.008);
      var v = (nx - seg.x) / dt;
      seg.vx = seg.vx * 0.6 + v * 0.4;
      seg.x = nx;
      d.lastX = e.clientX;
      d.lastT = e.timeStamp;

      var center = nx + seg.w / 2;
      var hot = tabs.filter(function (t) { return center >= t.offsetLeft && center < t.offsetLeft + t.offsetWidth; })[0] || (center < minX ? first : last);
      if (hot !== seg.hot) {
        if (seg.hot) seg.hot.classList.remove('is-hot');
        hot.classList.add('is-hot');
        seg.hot = hot;
        seg.tw = hot.offsetWidth;
        if (navigator.vibrate) { try { navigator.vibrate(6); } catch (err) {} }
      }
      segKick();
    });

    function release(e) {
      var d = seg.drag;
      if (!d || (e && d.id !== e.pointerId)) return;
      seg.drag = null;
      seg.grabT = 1;
      try { nav.releasePointerCapture(d.id); } catch (err) {}
      if (seg.hot) seg.hot.classList.remove('is-hot');
      if (d.moved) {
        // Where the lens is heading, not just where it is: a flick carries
        // it to the neighbouring tab.
        var tabs = segVisibleTabs();
        var center = seg.x + seg.w / 2 + Math.max(-500, Math.min(500, seg.vx)) * 0.1;
        var target = tabs.filter(function (t) { return center >= t.offsetLeft && center < t.offsetLeft + t.offsetWidth; })[0] ||
          (center < tabs[0].offsetLeft ? tabs[0] : tabs[tabs.length - 1]);
        seg.hot = null;
        if (target && target.dataset.tab !== (nav.querySelector('.tab.is-active') || {}).dataset.tab) {
          target.click();
        } else {
          moveSegPill(true);
        }
      } else {
        seg.hot = null;
      }
      segKick();
    }

    nav.addEventListener('pointerup', release);
    nav.addEventListener('pointercancel', release);
  }

  function wireUI() {
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
    map.on('click', function (latlng) {
      if (state.sheetExpanded) setSheetExpanded(false);
      var hit = vehicleAt(latlng);
      if (hit) { if (hit.id !== state.vcard.id) openVehicleCard(hit); }
      else closeVehicleCard();
    });

    // The lens has to follow the tabs whenever they change size or appear
    // (language switch, Friends tab showing up after sign-in, rotation).
    wireSegDrag();
    wireVehicleCardDrag();
    wireTransitSearch();
    var segRefresh = function () { moveSegPill(false); };
    window.addEventListener('resize', segRefresh);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(segRefresh);
    window.addEventListener('load', segRefresh);
    if (window.MutationObserver) {
      new MutationObserver(segRefresh).observe($('tabs'), { attributes: true, attributeFilter: ['hidden'], subtree: true, childList: true, characterData: true });
    }
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(segRefresh);
      ro.observe($('tabs'));
      ro.observe($('sheet'));
    }
    setTimeout(segRefresh, 60);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(segRefresh);

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
    map.on('move', function () { syncHash(); scheduleVehicles(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.prefs.trainMode) { fetchVehicles(); tickVehicles(); }
    });
    map.el.addEventListener('pointerdown', function () { state.followMe = false; });

    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'l') locateOnce();
      if (e.key === 'f') toggleFullscreen();
      if (e.key === 'Escape' && state.vcard.id) closeVehicleCard();
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
      setTimeout(startVehicles, 0);
    }

    // Remembers where you left the sheet and which tab was open.
    activateTab(state.prefs.activeTab || 'now');
    setSheetExpanded(!!state.prefs.sheetExpanded);

    wireUI();
    buildAccentSwatches();
    renderAccentSwatches();
    // Collapsed to just the gear on load — sets the button's own label and
    // aria-expanded rather than leaving them to the markup's defaults.
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
      if (state.vcard.id) renderVehicleCard();
      applyToggleLabels();
      applyPlacesEmptyText();
      renderLive();
      renderVehicles();
      drawVehicleMarkers();
      renderCompass();
      renderWeather();
      renderTrain();
      tsRender();
      renderPlaces();
      if (state.position) renderNow(); else renderSheetSummary();
      renderTrip();
      setImmersive(state.immersive);
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

  window.Whereabouts = {
    start: boot,
    started: false,
    activateTab: activateTab,
    formatDistance: formatDistance,
    getPosition: function () {
      var c = state.position && state.position.coords;
      return c ? { lat: c.latitude, lng: c.longitude } : null;
    },
    onPosition: function (fn) { positionListeners.push(fn); },
    // opts.color / opts.textColor: the colour you picked for this friend;
    // without one the marker keeps the default monochrome outline style.
    setFriendMarker: function (id, lat, lng, label, opts) {
      if (!map) return;
      var el = map.setMarker('friend:' + id, lat, lng, 'mm-marker-friend', label, { glide: 800 });
      var letter = (label || '?').charAt(0).toUpperCase();
      if (el.textContent !== letter) el.textContent = letter;
      var color = opts && opts.color;
      el.classList.toggle('has-color', !!color);
      el.style.background = color || '';
      el.style.borderColor = color ? '#ffffff' : '';
      el.style.color = color ? (opts.textColor || '#ffffff') : '';
      // Name tag under the dot, so you can tell friends apart at a glance.
      el.dataset.name = label || '';
    },
    removeFriendMarker: function (id) {
      if (map) map.removeMarker('friend:' + id);
    }
  };
})();
