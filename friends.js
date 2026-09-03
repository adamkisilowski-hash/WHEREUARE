/* Whereabouts — find my friends.
 *
 * A module, parallel to auth.js rather than layered on top of it: each
 * independently imports the Firebase SDK and calls initializeApp/getAuth on
 * the same config, which Firebase treats as idempotent (getApps().length
 * guards against a duplicate-app error), so neither file needs to reach into
 * the other's internals. This one adds Firestore on top for exactly two
 * things: friend requests/friendships, and opt-in location sharing.
 *
 * The privacy shape, stated plainly: your email is looked up by an exact
 * match only (a single-document read, never a listable collection), so
 * someone can find you if they already know your email, not by browsing.
 * Your location is a separate document only you and your *accepted* friends
 * can read — enforced by Firestore's own security rules, not by this client
 * code — and it only ever contains what "Share my location" last wrote, so
 * turning that off stops new reads immediately. See firestore.rules in this
 * repo for the exact rules a project owner needs to publish for any of this
 * to work; without them Firestore denies every read and write here, and
 * every failure below is caught and swallowed rather than surfaced as a
 * crash, so the rest of the app keeps working regardless.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var I18N = window.WhereaboutsI18n;
  var t = I18N.t;
  var config = window.WHEREABOUTS_FIREBASE_CONFIG || {};
  var configured = !!(config.apiKey && config.apiKey !== 'PLACEHOLDER');

  // No accounts at all means no way to identify a friend by anything durable
  // — same "don't show a feature nobody can use" call auth.js makes for the
  // sign-in gate itself.
  if (!configured) return;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var EARTH_RADIUS = 6371000;
  function toRad(d) { return d * Math.PI / 180; }
  function distance(a, b) {
    var dLat = toRad(b.lat - a.lat);
    var dLng = toRad(b.lng - a.lng);
    var lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Both sides of a friendship need to land on the same document id without
  // talking to each other first — sorting the pair is the deterministic way.
  function pairId(a, b) { return a < b ? a + '_' + b : b + '_' + a; }

  run();

  async function run() {
    var fbApp, fbAuth, fbStore;
    try {
      fbApp = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js');
      fbAuth = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js');
      fbStore = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js');
    } catch (e) {
      // CDN unreachable — same silent skip auth.js falls back to; the rest
      // of the app must not depend on this ever loading.
      return;
    }

    var app = fbApp.getApps().length ? fbApp.getApp() : fbApp.initializeApp(config);
    var auth = fbAuth.getAuth(app);
    var db = fbStore.getFirestore(app);
    var doc = fbStore.doc, getDoc = fbStore.getDoc, setDoc = fbStore.setDoc,
        deleteDoc = fbStore.deleteDoc, onSnapshot = fbStore.onSnapshot,
        collection = fbStore.collection, query = fbStore.query, where = fbStore.where,
        addDoc = fbStore.addDoc, serverTimestamp = fbStore.serverTimestamp,
        writeBatch = fbStore.writeBatch;

    // Firestore's free tier and any project's wallet both prefer this stay
    // rare — the same frugal-by-default stance train mode takes with
    // Overpass, applied to writes instead of reads.
    var LOCATION_WRITE_INTERVAL = 15000;

    var currentUid = null, currentEmail = null;
    var sharing = false;
    var incoming = [], outgoing = [], friendships = [];
    var friendLocations = {}; // uid -> { lat, lng, sharing, unsub }
    var emailByUid = {};
    var lastWriteAt = 0;
    var unsubs = [];

    function toDocObj(d) { var o = d.data(); o.id = d.id; return o; }

    function setAddError(msg) {
      var el = $('friends-add-error');
      if (!msg) { el.hidden = true; return; }
      el.textContent = msg;
      el.hidden = false;
    }
    function setAddStatus(msg) {
      var el = $('friends-add-status');
      if (!msg) { el.hidden = true; return; }
      el.textContent = msg;
      el.hidden = false;
    }

    function renderShareToggle() {
      $('friends-share-toggle').classList.toggle('is-on', sharing);
      $('friends-share-state').textContent = sharing ? t('friends.shareOn') : t('friends.shareOff');
    }

    function friendMeta(uid) {
      var loc = friendLocations[uid];
      if (!loc || !loc.sharing || loc.lat == null) return t('friends.notSharing');
      var here = window.Whereabouts && window.Whereabouts.getPosition();
      if (!here) return t('friends.sharing');
      var d = distance(here, { lat: loc.lat, lng: loc.lng });
      var formatted = window.Whereabouts.formatDistance ? window.Whereabouts.formatDistance(d) : Math.round(d) + ' m';
      return t('friends.distanceAway', { distance: formatted });
    }

    function updateFriendMarker(uid) {
      if (!window.Whereabouts) return;
      var f = friendLocations[uid];
      if (!f || !f.sharing || f.lat == null) { window.Whereabouts.removeFriendMarker(uid); return; }
      window.Whereabouts.setFriendMarker(uid, f.lat, f.lng, emailByUid[uid] || uid);
    }

    function dropFriendLocation(uid) {
      var f = friendLocations[uid];
      if (f && f.unsub) { try { f.unsub(); } catch (e) {} }
      delete friendLocations[uid];
      if (window.Whereabouts) window.Whereabouts.removeFriendMarker(uid);
    }

    function ensureFriendLocation(uid) {
      if (friendLocations[uid]) return;
      var entry = { lat: null, lng: null, sharing: false, unsub: null };
      friendLocations[uid] = entry;
      entry.unsub = onSnapshot(doc(db, 'locations', uid), function (snap) {
        var data = snap.exists() ? snap.data() : {};
        var live = friendLocations[uid];
        if (!live) return; // unfriended since this listener was set up
        live.lat = data.lat;
        live.lng = data.lng;
        live.sharing = !!data.sharing;
        updateFriendMarker(uid);
        renderFriendMetas();
      }, function () { dropFriendLocation(uid); });
    }

    function renderFriendMetas() {
      // Refresh just the meta text on each row rather than rebuilding the
      // whole list (and re-binding its delete handlers) on every location
      // ping or GPS fix — those can arrive every few seconds.
      var ul = $('friends-list');
      Array.prototype.forEach.call(ul.children, function (li) {
        var f = friendships.filter(function (x) { return x.id === li.dataset.id; })[0];
        if (!f) return;
        var otherUid = f.uids[0] === currentUid ? f.uids[1] : f.uids[0];
        var meta = li.querySelector('.friend-meta');
        if (meta) meta.textContent = friendMeta(otherUid);
      });
    }

    function bindRowAction(root, selector, fn) {
      root.querySelectorAll(selector).forEach(function (btn) {
        btn.addEventListener('click', function () { fn(btn.closest('li').dataset.id); });
      });
    }

    function renderIncoming() {
      $('friends-incoming').hidden = incoming.length === 0;
      var ul = $('friends-incoming-list');
      ul.innerHTML = incoming.map(function (req) {
        return '<li class="friend-item" data-id="' + req.id + '">' +
          '<span class="friend-main"><span class="friend-name">' + escapeHtml(req.fromEmail) + '</span></span>' +
          '<button class="friend-accept" type="button" data-action="accept">' + escapeHtml(t('friends.accept')) + '</button>' +
          '<button class="friend-del" type="button" data-action="decline" title="' + escapeHtml(t('friends.declineTitle')) + '">×</button>' +
        '</li>';
      }).join('');
      bindRowAction(ul, '[data-action="accept"]', function (id) {
        var req = incoming.filter(function (r) { return r.id === id; })[0];
        if (req) acceptRequest(req);
      });
      bindRowAction(ul, '[data-action="decline"]', function (id) {
        deleteDoc(doc(db, 'friendRequests', id)).catch(function () {});
      });
    }

    function renderOutgoing() {
      $('friends-outgoing').hidden = outgoing.length === 0;
      var ul = $('friends-outgoing-list');
      ul.innerHTML = outgoing.map(function (req) {
        return '<li class="friend-item" data-id="' + req.id + '">' +
          '<span class="friend-main"><span class="friend-name">' + escapeHtml(req.toEmail) + '</span>' +
          '<span class="friend-meta">' + escapeHtml(t('friends.pending')) + '</span></span>' +
          '<button class="friend-del" type="button" data-action="cancel" title="' + escapeHtml(t('friends.cancelTitle')) + '">×</button>' +
        '</li>';
      }).join('');
      bindRowAction(ul, '[data-action="cancel"]', function (id) {
        deleteDoc(doc(db, 'friendRequests', id)).catch(function () {});
      });
    }

    function renderFriends() {
      $('friends-empty').hidden = friendships.length > 0;

      var seen = {};
      friendships.forEach(function (f) {
        var otherUid = f.uids[0] === currentUid ? f.uids[1] : f.uids[0];
        seen[otherUid] = true;
        emailByUid[otherUid] = (f.emails && f.emails[otherUid]) || otherUid;
        ensureFriendLocation(otherUid);
      });
      Object.keys(friendLocations).forEach(function (uid) {
        if (!seen[uid]) dropFriendLocation(uid);
      });

      var ul = $('friends-list');
      ul.innerHTML = friendships.map(function (f) {
        var otherUid = f.uids[0] === currentUid ? f.uids[1] : f.uids[0];
        return '<li class="friend-item" data-id="' + f.id + '">' +
          '<span class="friend-main"><span class="friend-name">' + escapeHtml(emailByUid[otherUid]) + '</span>' +
          '<span class="friend-meta">' + escapeHtml(friendMeta(otherUid)) + '</span></span>' +
          '<button class="friend-del" type="button" data-action="remove" title="' + escapeHtml(t('friends.removeTitle')) + '">×</button>' +
        '</li>';
      }).join('');
      bindRowAction(ul, '[data-action="remove"]', function (id) {
        deleteDoc(doc(db, 'friendships', id)).catch(function () {});
      });
      Object.keys(friendLocations).forEach(updateFriendMarker);
    }

    async function acceptRequest(req) {
      var pid = pairId(req.from, req.to);
      var emails = {};
      emails[req.from] = req.fromEmail;
      emails[req.to] = req.toEmail;
      var batch = writeBatch(db);
      batch.set(doc(db, 'friendships', pid), { uids: [req.from, req.to].sort(), emails: emails, createdAt: serverTimestamp() });
      batch.delete(doc(db, 'friendRequests', req.id));
      try { await batch.commit(); } catch (e) {}
    }

    $('friends-share-toggle').addEventListener('click', function () {
      if (!currentUid) return;
      setSharing(!sharing);
    });

    function setSharing(on) {
      sharing = on;
      renderShareToggle();
      var payload = { sharing: on };
      if (on) {
        payload.updatedAt = serverTimestamp();
        var here = window.Whereabouts && window.Whereabouts.getPosition();
        if (here) { payload.lat = here.lat; payload.lng = here.lng; }
        lastWriteAt = Date.now();
      }
      setDoc(doc(db, 'locations', currentUid), payload, { merge: true }).catch(function () {});
    }

    function maybeWriteLocation(pos) {
      if (!sharing || !currentUid) return;
      var now = Date.now();
      if (now - lastWriteAt < LOCATION_WRITE_INTERVAL) return;
      lastWriteAt = now;
      setDoc(doc(db, 'locations', currentUid),
        { lat: pos.lat, lng: pos.lng, sharing: true, updatedAt: serverTimestamp() },
        { merge: true }).catch(function () {});
    }

    if (window.Whereabouts) {
      window.Whereabouts.onPosition(function (pos) {
        if (!currentUid) return;
        maybeWriteLocation(pos);
        renderFriendMetas();
      });
    }

    $('friends-add-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!currentUid) return;
      setAddError(null);
      setAddStatus(null);
      var email = $('friends-add-email').value.trim().toLowerCase();
      if (!email) return;
      if (email === currentEmail.toLowerCase()) { setAddError(t('friends.errSelf')); return; }
      $('friends-add-submit').disabled = true;
      try {
        var idxSnap = await getDoc(doc(db, 'emailIndex', email));
        if (!idxSnap.exists()) { setAddError(t('friends.errNotFound')); return; }
        var targetUid = idxSnap.data().uid;
        if (targetUid === currentUid) { setAddError(t('friends.errSelf')); return; }
        if (friendships.some(function (f) { return f.uids.indexOf(targetUid) !== -1; })) {
          setAddError(t('friends.errAlready'));
          return;
        }
        if (outgoing.some(function (r) { return r.to === targetUid; })) {
          setAddError(t('friends.errPending'));
          return;
        }
        await addDoc(collection(db, 'friendRequests'), {
          from: currentUid, fromEmail: currentEmail,
          to: targetUid, toEmail: email,
          status: 'pending', createdAt: serverTimestamp()
        });
        setAddStatus(t('friends.requestSent', { email: email }));
        $('friends-add-email').value = '';
      } catch (err) {
        setAddError(t('friends.errGeneric'));
      } finally {
        $('friends-add-submit').disabled = false;
      }
    });

    function teardown() {
      unsubs.forEach(function (u) { try { u(); } catch (e) {} });
      unsubs = [];
      Object.keys(friendLocations).forEach(dropFriendLocation);
      friendLocations = {};
      incoming = [];
      outgoing = [];
      friendships = [];
      emailByUid = {};
      sharing = false;
      lastWriteAt = 0;
      currentUid = null;
      currentEmail = null;

      $('friends-incoming-list').innerHTML = '';
      $('friends-outgoing-list').innerHTML = '';
      $('friends-list').innerHTML = '';
      $('friends-incoming').hidden = true;
      $('friends-outgoing').hidden = true;
      $('friends-empty').hidden = false;
      setAddError(null);
      setAddStatus(null);
      renderShareToggle();

      var panel = document.querySelector('.tab-panel[data-panel="friends"]');
      var wasActive = !$('tab-friends').hidden && panel && panel.classList.contains('is-active');
      $('tab-friends').hidden = true;
      if (wasActive && window.Whereabouts) window.Whereabouts.activateTab('now');
    }

    fbAuth.onAuthStateChanged(auth, function (user) {
      teardown();
      if (!user) return;

      currentUid = user.uid;
      currentEmail = user.email;
      $('tab-friends').hidden = false;

      // Claim/refresh our own lookup entry so a friend searching our email
      // finds us — idempotent, safe to redo on every sign-in.
      setDoc(doc(db, 'emailIndex', currentEmail.toLowerCase()), { uid: currentUid }, { merge: true }).catch(function () {});

      unsubs.push(onSnapshot(doc(db, 'locations', currentUid), function (snap) {
        sharing = !!(snap.exists() && snap.data().sharing);
        renderShareToggle();
      }, function () {}));

      unsubs.push(onSnapshot(
        query(collection(db, 'friendRequests'), where('to', '==', currentUid), where('status', '==', 'pending')),
        function (snap) { incoming = snap.docs.map(toDocObj); renderIncoming(); },
        function () {}
      ));
      unsubs.push(onSnapshot(
        query(collection(db, 'friendRequests'), where('from', '==', currentUid), where('status', '==', 'pending')),
        function (snap) { outgoing = snap.docs.map(toDocObj); renderOutgoing(); },
        function () {}
      ));
      unsubs.push(onSnapshot(
        query(collection(db, 'friendships'), where('uids', 'array-contains', currentUid)),
        function (snap) { friendships = snap.docs.map(toDocObj); renderFriends(); },
        function () {}
      ));
    });
  }
})();
