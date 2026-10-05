/* MiniMap — a small dependency-free slippy map over OpenStreetMap tiles.
 *
 * Covers what this app needs and nothing more: pan with momentum, smooth
 * fractional zoom (animated wheel/buttons, continuous pinch, double-tap),
 * markers that can glide, an accuracy circle, and a track polyline. Web Mercator throughout, with
 * tiles at 256px so world size is 256 * 2^zoom pixels.
 */
(function (global) {
  'use strict';

  var TILE = 256;
  var MIN_ZOOM = 2;
  var MAX_ZOOM = 19;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Latitude beyond this can't be represented in Web Mercator.
  function clampLat(lat) { return clamp(lat, -85.05112878, 85.05112878); }

  function worldSize(zoom) { return TILE * Math.pow(2, zoom); }

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function project(lat, lng, zoom) {
    var size = worldSize(zoom);
    var s = Math.sin(clampLat(lat) * Math.PI / 180);
    return {
      x: size * (lng / 360 + 0.5),
      y: size * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI))
    };
  }

  function unproject(x, y, zoom) {
    var size = worldSize(zoom);
    var n = Math.PI * (1 - 2 * y / size);
    return {
      lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
      lng: 360 * (x / size - 0.5)
    };
  }

  // Ground resolution in metres per screen pixel at a given latitude/zoom.
  function metersPerPixel(lat, zoom) {
    return 156543.03392804097 * Math.cos(clampLat(lat) * Math.PI / 180) / Math.pow(2, zoom);
  }

  function MiniMap(container, options) {
    options = options || {};
    this.el = container;
    this.el.classList.add('minimap');
    this.center = { lat: options.lat != null ? options.lat : 20, lng: options.lng != null ? options.lng : 0 };
    this.zoom = clamp(options.zoom != null ? options.zoom : 3, MIN_ZOOM, MAX_ZOOM);
    this.tileUrl = options.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    this.markers = Object.create(null);
    this.listeners = { move: [], click: [] };
    this.tiles = Object.create(null);
    this.track = [];

    this.tileLayer = document.createElement('div');
    this.tileLayer.className = 'mm-tiles';

    /* A second, optional raster layer painted over the basemap — used for
     * the railway overlay in train mode. Kept as its own tile cache rather
     * than folded into the basemap's, so toggling it on and off doesn't
     * disturb any basemap tile that's already loaded. */
    this.overlayTileLayer = document.createElement('div');
    this.overlayTileLayer.className = 'mm-tiles mm-tiles-overlay';
    this.overlayTiles = Object.create(null);
    this.overlayTileUrl = options.overlayTileUrl || null;

    this.overlay = document.createElementNS(SVG_NS, 'svg');
    this.overlay.setAttribute('class', 'mm-overlay');

    // Two paths for one line: a casing underneath keeps the track legible
    // wherever it crosses something the same colour as itself.
    this.trackCasing = document.createElementNS(SVG_NS, 'path');
    this.trackCasing.setAttribute('class', 'mm-track-casing');
    this.trackCasing.setAttribute('fill', 'none');
    this.overlay.appendChild(this.trackCasing);

    this.trackPath = document.createElementNS(SVG_NS, 'path');
    this.trackPath.setAttribute('class', 'mm-track');
    this.trackPath.setAttribute('fill', 'none');
    this.overlay.appendChild(this.trackPath);

    this.accuracyCircle = document.createElementNS(SVG_NS, 'circle');
    this.accuracyCircle.setAttribute('class', 'mm-accuracy');
    this.accuracyCircle.setAttribute('r', '0');
    this.overlay.appendChild(this.accuracyCircle);

    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'mm-markers';

    /* Everything that belongs to the world goes inside a rotator, so a
     * heading-up map is one transform rather than a re-projection. It is
     * inset by `_pad` past every edge, because a rotated square has to be
     * bigger than its viewport or the corners come up empty. */
    this.rotator = document.createElement('div');
    this.rotator.className = 'mm-rotator';
    this.rotator.appendChild(this.tileLayer);
    this.rotator.appendChild(this.overlayTileLayer);
    this.rotator.appendChild(this.overlay);
    this.rotator.appendChild(this.markerLayer);
    this.el.appendChild(this.rotator);

    this.bearing = 0;
    this.rotationEnabled = false;
    this._pad = 0;

    // Animation state, all driven by one requestAnimationFrame loop.
    this._zoomAnim = null;    // { from, to, t0, dur, anchor }
    this._panAnim = null;     // { from, to, t0, dur } — eased recentring
    this._inertia = null;     // { vx, vy } in screen px per ms
    this._raf = 0;
    this._renderQueued = false;

    this._bindPointer();
    this._bindWheel();

    var self = this;
    this._onResize = function () { self.render(); };
    global.addEventListener('resize', this._onResize);
    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.render(); });
      this._ro.observe(this.el);
    }

    this.render();
  }

  MiniMap.prototype.size = function () {
    return { w: this.el.clientWidth, h: this.el.clientHeight };
  };

  // Top-left corner of the viewport in world pixel coordinates.
  MiniMap.prototype._origin = function () {
    var c = project(this.center.lat, this.center.lng, this.zoom);
    var s = this.size();
    return { x: c.x - s.w / 2, y: c.y - s.h / 2 };
  };

  MiniMap.prototype.latLngToPoint = function (lat, lng) {
    var p = project(lat, lng, this.zoom);
    var o = this._origin();
    return { x: p.x - o.x, y: p.y - o.y };
  };

  /* The rotator is transformed by rotate(-bearing), so a CSS transform maps a
   * plane point p to M(-bearing)·p. Going the other way — screen to plane, for
   * clicks, drags and zoom anchors — means applying M(+bearing). */
  MiniMap.prototype._screenToPlane = function (x, y) {
    if (!this.bearing) return { x: x, y: y };
    var s = this.size();
    var cx = s.w / 2, cy = s.h / 2;
    var v = this._rotateVector(x - cx, y - cy);
    return { x: cx + v.x, y: cy + v.y };
  };

  MiniMap.prototype._rotateVector = function (dx, dy) {
    if (!this.bearing) return { x: dx, y: dy };
    var r = this.bearing * Math.PI / 180;
    var cos = Math.cos(r), sin = Math.sin(r);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };

  MiniMap.prototype.pointToLatLng = function (x, y) {
    var p = this._screenToPlane(x, y);
    var o = this._origin();
    return unproject(o.x + p.x, o.y + p.y, this.zoom);
  };

  /* Rotation ---------------------------------------------------------- */

  // Half the difference between the viewport's diagonal and its shorter side:
  // the most any corner can swing outside the box at any angle.
  MiniMap.prototype._padFor = function (s) {
    if (!this.rotationEnabled) return 0;
    return Math.ceil((Math.hypot(s.w, s.h) - Math.min(s.w, s.h)) / 2) + TILE;
  };

  MiniMap.prototype.setRotationEnabled = function (on) {
    if (this.rotationEnabled === on) return this;
    this.rotationEnabled = on;
    if (!on) this.bearing = 0;
    this.render();
    return this;
  };

  MiniMap.prototype.setBearing = function (deg) {
    this.bearing = ((deg % 360) + 360) % 360;
    this.rotator.style.transform = 'rotate(' + (-this.bearing) + 'deg)';
    // Markers would otherwise ride the rotation and end up upside down.
    this._placeMarkers();
    return this;
  };

  MiniMap.prototype.getBearing = function () { return this.bearing; };

  MiniMap.prototype.on = function (event, fn) {
    if (this.listeners[event]) this.listeners[event].push(fn);
    return this;
  };

  MiniMap.prototype._emit = function (event, payload) {
    var fns = this.listeners[event] || [];
    for (var i = 0; i < fns.length; i++) fns[i](payload);
  };

  /* Instant by default. With opts.animate the map glides to the new centre
   * (used for follow-me updates) unless the jump is too far to be worth
   * animating, in which case it just goes there. */
  MiniMap.prototype.setView = function (lat, lng, zoom, opts) {
    var target = { lat: clampLat(lat), lng: lng };
    if (zoom != null) {
      this._zoomAnim = null;
      this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    }
    this._inertia = null;
    if (opts && opts.animate && zoom == null) {
      var a = project(this.center.lat, this.center.lng, this.zoom);
      var b = project(target.lat, target.lng, this.zoom);
      var s = this.size();
      if (Math.hypot(a.x - b.x, a.y - b.y) < Math.max(s.w, s.h) * 2) {
        this._panAnim = { from: this.center, to: target, t0: now(), dur: opts.duration || 600 };
        this._loop();
        return this;
      }
    }
    this._panAnim = null;
    this.center = target;
    this.render();
    this._emit('move', this.getView());
    return this;
  };

  MiniMap.prototype.getView = function () {
    return { lat: this.center.lat, lng: this.center.lng, zoom: this.zoom };
  };

  // Set a (fractional) zoom keeping the geographic point under `anchor`
  // pinned to the same screen pixel. No render — callers batch that.
  MiniMap.prototype._zoomAround = function (z, anchor) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (!anchor) { this.zoom = z; return; }
    var before = this.pointToLatLng(anchor.x, anchor.y);
    this.zoom = z;
    var after = this.pointToLatLng(anchor.x, anchor.y);
    this.center = {
      lat: clampLat(this.center.lat + (before.lat - after.lat)),
      lng: this.center.lng + (before.lng - after.lng)
    };
  };

  /* Animated zoom. Repeated calls while one is running (wheel ticks, fast
   * button taps) extend the target instead of queueing, so it never
   * stutters. Ends on whatever fraction it lands on — tiles scale to fit. */
  MiniMap.prototype.zoomBy = function (delta, anchor, duration) {
    var base = this._zoomAnim ? this._zoomAnim.to : this.zoom;
    var to = clamp(base + delta, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(to - this.zoom) < 1e-4 && !this._zoomAnim) return this;
    // Whole-step zooms (buttons, keys, double-tap) land on whole levels so
    // tiles end up pin-sharp.
    if (Math.abs(delta) >= 1) to = clamp(Math.round(to), MIN_ZOOM, MAX_ZOOM);
    this._inertia = null;
    this._zoomAnim = {
      from: this.zoom, to: to, t0: now(),
      dur: duration != null ? duration : 300,
      anchor: anchor || null
    };
    this._loop();
    return this;
  };

  MiniMap.prototype._loop = function () {
    if (this._raf) return;
    var self = this;
    var last = now();
    var step = function () {
      var t = now();
      var dt = Math.min(64, t - last);
      last = t;
      var active = false;

      var za = self._zoomAnim;
      if (za) {
        var k = Math.min(1, (t - za.t0) / za.dur);
        self._zoomAround(za.from + (za.to - za.from) * easeOut(k), za.anchor);
        if (k >= 1) self._zoomAnim = null; else active = true;
      }

      var pa = self._panAnim;
      if (pa) {
        var q = Math.min(1, (t - pa.t0) / pa.dur);
        var e = easeInOut(q);
        self.center = {
          lat: pa.from.lat + (pa.to.lat - pa.from.lat) * e,
          lng: pa.from.lng + (pa.to.lng - pa.from.lng) * e
        };
        if (q >= 1) self._panAnim = null; else active = true;
      }

      var inr = self._inertia;
      if (inr) {
        self._panRaw(-inr.vx * dt, -inr.vy * dt);
        var decay = Math.exp(-dt / 320);
        inr.vx *= decay; inr.vy *= decay;
        if (Math.hypot(inr.vx, inr.vy) < 0.02) self._inertia = null; else active = true;
      }

      if (self._stepMarkers(t)) active = true;

      self.render();
      if (za || pa || inr) self._emit('move', self.getView());
      self._raf = active ? global.requestAnimationFrame(step) : 0;
    };
    this._raf = global.requestAnimationFrame(step);
  };

  MiniMap.prototype._bindPointer = function () {
    var self = this;
    var dragging = false;
    var moved = 0;
    var last = null;
    var samples = [];          // recent {x, y, t} for the release velocity
    var pointers = Object.create(null);
    var pinch = null;          // { dist, zoom, mid }
    var lastTap = null;        // for double-tap zoom

    function pointerCount() { return Object.keys(pointers).length; }

    function midpoint() {
      var rect = self.el.getBoundingClientRect();
      var ids = Object.keys(pointers);
      return {
        x: (pointers[ids[0]].x + pointers[ids[1]].x) / 2 - rect.left,
        y: (pointers[ids[0]].y + pointers[ids[1]].y) / 2 - rect.top
      };
    }

    this.el.addEventListener('pointerdown', function (e) {
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      // Touching the map stops any glide or momentum dead, like a real map.
      self._inertia = null;
      self._panAnim = null;
      if (pointerCount() === 1) {
        dragging = true;
        moved = 0;
        last = { x: e.clientX, y: e.clientY };
        samples = [{ x: e.clientX, y: e.clientY, t: now() }];
        self.el.setPointerCapture(e.pointerId);
        self.el.classList.add('is-dragging');
      } else if (pointerCount() === 2) {
        dragging = false;
        self._zoomAnim = null;
        pinch = { dist: self._pinchDistance(pointers), zoom: self.zoom, mid: midpoint() };
      }
    });

    this.el.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };

      if (pointerCount() === 2 && pinch) {
        // Continuous pinch: zoom follows the fingers exactly, and moving
        // both fingers together pans at the same time.
        var dist = self._pinchDistance(pointers);
        var mid = midpoint();
        if (pinch.dist > 0 && dist > 0) {
          self._panRaw(pinch.mid.x - mid.x, pinch.mid.y - mid.y);
          self._zoomAround(pinch.zoom + Math.log(dist / pinch.dist) / Math.LN2, mid);
        }
        pinch.mid = mid;
        self._scheduleRender(true);
        return;
      }

      if (!dragging || !last) return;
      var dx = e.clientX - last.x;
      var dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: e.clientX, y: e.clientY };
      var t = now();
      samples.push({ x: e.clientX, y: e.clientY, t: t });
      while (samples.length > 2 && t - samples[0].t > 100) samples.shift();
      self._panRaw(-dx, -dy);
      self._scheduleRender(true);
    });

    function release(e) {
      if (!pointers[e.pointerId]) return;
      delete pointers[e.pointerId];
      if (pointerCount() < 2 && pinch) {
        pinch = null;
        // Lifting one finger of a pinch shouldn't turn into a drag jump.
        var ids = Object.keys(pointers);
        if (ids.length === 1) {
          last = { x: pointers[ids[0]].x, y: pointers[ids[0]].y };
          samples = [];
          dragging = true;
          moved = 99;
        }
      }
      if (pointerCount() === 0) {
        var rect = self.el.getBoundingClientRect();
        var t = now();
        if (dragging && moved < 5) {
          var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          self._emit('click', self.pointToLatLng(pt.x, pt.y));
          if (lastTap && t - lastTap.t < 320 && Math.hypot(pt.x - lastTap.x, pt.y - lastTap.y) < 30) {
            self.zoomBy(1, pt, 320);
            lastTap = null;
          } else {
            lastTap = { x: pt.x, y: pt.y, t: t };
          }
        } else if (dragging && samples.length >= 2) {
          // Fling: carry on at the release speed and coast to a stop.
          var a = samples[0], b = samples[samples.length - 1];
          var span = b.t - a.t;
          if (span > 0 && t - b.t < 60) {
            var vx = (b.x - a.x) / span, vy = (b.y - a.y) / span;
            var speed = Math.hypot(vx, vy);
            if (speed > 0.25) {
              var cap = 4 / speed; // keep a wild flick from throwing the map across a continent
              if (cap < 1) { vx *= cap; vy *= cap; }
              self._inertia = { vx: vx, vy: vy };
              self._loop();
            }
          }
        }
        dragging = false;
        last = null;
        samples = [];
        self.el.classList.remove('is-dragging');
      }
    }

    this.el.addEventListener('pointerup', release);
    this.el.addEventListener('pointercancel', release);
    this.el.addEventListener('dblclick', function (e) { e.preventDefault(); });
  };

  MiniMap.prototype._pinchDistance = function (pointers) {
    var ids = Object.keys(pointers);
    if (ids.length < 2) return 0;
    var a = pointers[ids[0]], b = pointers[ids[1]];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  /* Wheel and trackpad: every event nudges the zoom target by an amount
   * proportional to how far the wheel moved, and the animation loop eases
   * toward it — so a mouse notch is a short glide and a trackpad pinch
   * (which browsers report as ctrl+wheel) tracks the fingers. */
  MiniMap.prototype._bindWheel = function () {
    var self = this;
    this.el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var px = e.deltaY;
      if (e.deltaMode === 1) px *= 33;
      else if (e.deltaMode === 2) px *= 600;
      var dz = -px / (e.ctrlKey ? 100 : 220);
      dz = clamp(dz, -1, 1);
      if (!dz) return;
      var rect = self.el.getBoundingClientRect();
      self.zoomBy(dz, { x: e.clientX - rect.left, y: e.clientY - rect.top }, e.ctrlKey ? 90 : 220);
    }, { passive: false });
  };

  // Move the centre by screen pixels without rendering.
  MiniMap.prototype._panRaw = function (dx, dy) {
    var d = this._rotateVector(dx, dy);
    var c = project(this.center.lat, this.center.lng, this.zoom);
    var next = unproject(c.x + d.x, c.y + d.y, this.zoom);
    this.center = { lat: clampLat(next.lat), lng: next.lng };
  };

  // Coalesce many input events into one render per frame.
  MiniMap.prototype._scheduleRender = function (emitMove) {
    if (emitMove) this._pendingMove = true;
    if (this._renderQueued) return;
    this._renderQueued = true;
    var self = this;
    global.requestAnimationFrame(function () {
      self._renderQueued = false;
      self.render();
      if (self._pendingMove) {
        self._pendingMove = false;
        self._emit('move', self.getView());
      }
    });
  };

  MiniMap.prototype.panByPixels = function (dx, dy) {
    // Dragging should follow the finger, not the map's underlying axes.
    this._panRaw(dx, dy);
    this._scheduleRender(true);
    return this;
  };

  /* opts.glide (ms): an existing marker slides from where it is to the new
   * position instead of jumping. New markers always appear in place. */
  MiniMap.prototype.setMarker = function (id, lat, lng, className, label, opts) {
    var marker = this.markers[id];
    var glide = opts && opts.glide;
    if (!marker) {
      var el = document.createElement('div');
      el.className = 'mm-marker ' + (className || '');
      if (label) el.title = label;
      this.markerLayer.appendChild(el);
      marker = this.markers[id] = { el: el };
      glide = 0;
    }
    if (glide && marker.lat != null && (marker.lat !== lat || marker.lng !== lng)) {
      marker.anim = { from: { lat: marker.lat, lng: marker.lng }, to: { lat: lat, lng: lng }, t0: now(), dur: glide };
      if (label) marker.el.title = label;
      this._loop();
      return marker.el;
    }
    marker.anim = null;
    marker.lat = lat;
    marker.lng = lng;
    if (label) marker.el.title = label;
    this._placeMarkers();
    return marker.el;
  };

  // Advance gliding markers; true while any are still moving.
  MiniMap.prototype._stepMarkers = function (t) {
    var any = false;
    for (var id in this.markers) {
      var m = this.markers[id];
      if (!m.anim) continue;
      var k = Math.min(1, (t - m.anim.t0) / m.anim.dur);
      var e = easeInOut(k);
      m.lat = m.anim.from.lat + (m.anim.to.lat - m.anim.from.lat) * e;
      m.lng = m.anim.from.lng + (m.anim.to.lng - m.anim.from.lng) * e;
      if (k >= 1) m.anim = null; else any = true;
    }
    return any;
  };

  MiniMap.prototype.removeMarker = function (id) {
    var marker = this.markers[id];
    if (!marker) return;
    marker.el.remove();
    delete this.markers[id];
  };

  MiniMap.prototype.clearMarkers = function (prefix) {
    var self = this;
    Object.keys(this.markers).forEach(function (id) {
      if (!prefix || id.indexOf(prefix) === 0) self.removeMarker(id);
    });
  };

  MiniMap.prototype.setAccuracy = function (lat, lng, meters) {
    this._accuracy = (meters > 0) ? { lat: lat, lng: lng, meters: meters } : null;
    this._drawOverlay();
    return this;
  };

  MiniMap.prototype.setTrack = function (points) {
    this.track = points || [];
    this._drawOverlay();
    return this;
  };

  MiniMap.prototype._placeMarkers = function () {
    var self = this;
    var pad = this._pad;
    var upright = self.bearing ? ' rotate(' + self.bearing + 'deg)' : '';
    Object.keys(this.markers).forEach(function (id) {
      var m = self.markers[id];
      var p = self.latLngToPoint(m.lat, m.lng);
      m.el.style.transform = 'translate3d(' + (p.x + pad).toFixed(1) + 'px,' + (p.y + pad).toFixed(1) + 'px,0)' + upright;
    });
  };

  MiniMap.prototype._drawOverlay = function () {
    var size = this.size();
    var pad = this._pad;
    var s = { w: size.w + pad * 2, h: size.h + pad * 2 };
    this.overlay.setAttribute('width', s.w);
    this.overlay.setAttribute('height', s.h);
    this.overlay.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);

    if (this._accuracy) {
      var c = this.latLngToPoint(this._accuracy.lat, this._accuracy.lng);
      var r = this._accuracy.meters / metersPerPixel(this._accuracy.lat, this.zoom);
      this.accuracyCircle.setAttribute('cx', c.x + pad);
      this.accuracyCircle.setAttribute('cy', c.y + pad);
      // Below a few pixels the circle reads as noise around the marker.
      this.accuracyCircle.setAttribute('r', r > 4 ? Math.min(r, s.w + s.h) : 0);
    } else {
      this.accuracyCircle.setAttribute('r', '0');
    }

    if (this.track.length > 1) {
      var d = '';
      for (var i = 0; i < this.track.length; i++) {
        var p = this.latLngToPoint(this.track[i].lat, this.track[i].lng);
        d += (i === 0 ? 'M' : 'L') + (p.x + pad).toFixed(1) + ' ' + (p.y + pad).toFixed(1);
      }
      this.trackPath.setAttribute('d', d);
      this.trackCasing.setAttribute('d', d);
    } else {
      this.trackPath.setAttribute('d', '');
      this.trackCasing.setAttribute('d', '');
    }
  };

  // Swapping basemaps (light <-> dark) drops every cached tile, since the old
  // images are still correct for their coordinates but wrong for the style.
  MiniMap.prototype.setTileUrl = function (url) {
    if (url === this.tileUrl) return this;
    this.tileUrl = url;
    for (var key in this.tiles) {
      this.tiles[key].remove();
      delete this.tiles[key];
    }
    this.render();
    return this;
  };

  // Null clears the overlay entirely (and drops its tiles); anything else
  // swaps it, same drop-and-reload contract as the basemap above.
  MiniMap.prototype.setOverlayTileUrl = function (url) {
    if (url === this.overlayTileUrl) return this;
    this.overlayTileUrl = url || null;
    for (var key in this.overlayTiles) {
      this.overlayTiles[key].remove();
      delete this.overlayTiles[key];
    }
    this.render();
    return this;
  };

  function fillTemplate(template, z, x, y) {
    return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  MiniMap.prototype._tileUrl = function (z, x, y) {
    return fillTemplate(this.tileUrl, z, x, y);
  };

  MiniMap.prototype.render = function () {
    var s = this.size();
    if (!s.w || !s.h) return;

    var pad = this._padFor(s);
    this._pad = pad;
    this.rotator.style.inset = (-pad) + 'px';
    this.rotator.style.transform = 'rotate(' + (-this.bearing) + 'deg)';

    // Top-left of the rotator's box in world pixels at the current
    // (possibly fractional) zoom.
    var o = this._origin();
    o = { x: o.x - pad, y: o.y - pad };
    var w = s.w + pad * 2;
    var h = s.h + pad * 2;

    /* Tiles only exist at whole zoom levels, so draw the nearest level and
     * scale it by the leftover fraction. Tiles from the level we just left
     * stay underneath, scaled the same way, until the new ones have loaded —
     * so zooming never flashes blank. */
    var z = clamp(Math.round(this.zoom), MIN_ZOOM, MAX_ZOOM);
    var box = { z: z, o: o, w: w, h: h, zoom: this.zoom };
    this._renderTileLayer(this.tileLayer, this.tiles, this.tileUrl, box);
    this._renderTileLayer(this.overlayTileLayer, this.overlayTiles, this.overlayTileUrl, box);

    this._placeMarkers();
    this._drawOverlay();
  };

  /* One loop, two layers: the basemap and the optional overlay differ only
   * in which cache and URL template they draw from. */
  MiniMap.prototype._renderTileLayer = function (layerEl, cache, template, box) {
    var key;
    if (!template) {
      for (key in cache) {
        cache[key].remove();
        delete cache[key];
      }
      return;
    }

    var self = this;
    var z = box.z;
    var n = Math.pow(2, z);
    var k = Math.pow(2, box.zoom - z);      // on-screen scale of a level-z tile
    var size = TILE * k;
    var minX = Math.floor(box.o.x / size);
    var maxX = Math.floor((box.o.x + box.w) / size);
    var minY = clamp(Math.floor(box.o.y / size), 0, n - 1);
    var maxY = clamp(Math.floor((box.o.y + box.h) / size), 0, n - 1);

    var wanted = Object.create(null);
    var allLoaded = true;

    for (var x = minX; x <= maxX; x++) {
      for (var y = minY; y <= maxY; y++) {
        // Wrap horizontally so panning past the antimeridian keeps working.
        var tx = ((x % n) + n) % n;
        var kk = z + '/' + tx + '/' + y + '@' + x;
        wanted[kk] = true;

        var tile = cache[kk];
        if (!tile) {
          tile = document.createElement('img');
          tile.className = 'mm-tile';
          tile.alt = '';
          tile.decoding = 'async';
          tile.loading = 'eager';
          tile._z = z; tile._x = x; tile._y = y;
          tile.addEventListener('load', function () {
            this.classList.add('is-loaded');
            self._scheduleRender(false);
          });
          tile.addEventListener('error', function () {
            this.classList.add('is-error');
            self._scheduleRender(false);
          });
          tile.src = fillTemplate(template, z, tx, y);
          layerEl.appendChild(tile);
          cache[kk] = tile;
        }
        if (!tile.classList.contains('is-loaded') && !tile.classList.contains('is-error')) allLoaded = false;
        placeTile(tile, box, 2);
      }
    }

    for (key in cache) {
      if (wanted[key]) continue;
      var t = cache[key];
      // Keep a loaded tile from another level as a backdrop while this level
      // fills in, as long as it's still on screen and not absurdly scaled.
      if (!allLoaded && t._z !== z && Math.abs(t._z - z) <= 2 && t.classList.contains('is-loaded')) {
        var tk = Math.pow(2, box.zoom - t._z) * TILE;
        var left = t._x * tk - box.o.x, top = t._y * tk - box.o.y;
        if (left < box.w && top < box.h && left + tk > 0 && top + tk > 0) {
          placeTile(t, box, 1);
          continue;
        }
      }
      t.remove();
      delete cache[key];
    }
  };

  function placeTile(tile, box, layer) {
    var k = Math.pow(2, box.zoom - tile._z);
    var size = TILE * k;
    var left = tile._x * size - box.o.x;
    var top = tile._y * size - box.o.y;
    // A hair of overlap hides the seams fractional scaling would show.
    var scale = (size + 0.6) / TILE;
    tile.style.transform = 'translate3d(' + left.toFixed(2) + 'px,' + top.toFixed(2) + 'px,0) scale(' + scale.toFixed(5) + ')';
    if (tile._layer !== layer) {
      tile.style.zIndex = layer;
      tile._layer = layer;
    }
  }

  MiniMap.metersPerPixel = metersPerPixel;
  MiniMap.MIN_ZOOM = MIN_ZOOM;
  MiniMap.MAX_ZOOM = MAX_ZOOM;

  global.MiniMap = MiniMap;
})(window);
