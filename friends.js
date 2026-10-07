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
        writeBatch = fbStore.writeBatch, orderBy = fbStore.orderBy, limit = fbStore.limit;

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
    var chatMeta = {};         // pairId -> { lastFrom, lastAt(ms), lastText }
    var chatOpen = null;       // { pid, uid } while a conversation is showing
    var chatUnsub = null;
    var chatMsgs = [];

    /* Nicknames and colours are private to you: your friend never sees what
     * you called them. They're kept per account in localStorage so they work
     * immediately, and mirrored to friendPrefs/{yourUid} in Firestore (only
     * readable/writable by you — see firestore.rules) so they follow you to
     * other devices. If those rules haven't been published yet the Firestore
     * half just fails quietly and everything still works on this device. */
    var FRIEND_COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1',
                         '#1e88e5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41'];
    var friendPrefs = {};      // friendUid -> { nick, color }
    var editingUid = null;     // whose editor is open
    var draft = null;          // { nick, color } while editing

    function prefsKey() { return 'whereabouts.friendPrefs.' + currentUid; }

    function loadLocalPrefs() {
      try { friendPrefs = JSON.parse(localStorage.getItem(prefsKey()) || '{}') || {}; }
      catch (e) { friendPrefs = {}; }
    }

    function savePrefs() {
      try { localStorage.setItem(prefsKey(), JSON.stringify(friendPrefs)); } catch (e) {}
      if (currentUid) {
        setDoc(doc(db, 'friendPrefs', currentUid), { prefs: friendPrefs, updatedAt: serverTimestamp() })
          .catch(function () {});
      }
    }

    function prefOf(uid) { return friendPrefs[uid] || {}; }

    function displayName(uid) {
      var nick = prefOf(uid).nick;
      return nick || emailByUid[uid] || uid;
    }

    // Black or white text, whichever reads better on the chosen colour.
    function textOn(hex) {
      var n = parseInt(hex.slice(1), 16);
      var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111111' : '#ffffff';
    }

    function friendDot(uid) {
      var c = prefOf(uid).color;
      var letter = escapeHtml((displayName(uid) || '?').charAt(0).toUpperCase());
      return c
        ? '<span class="friend-dot" style="background:' + c + ';color:' + textOn(c) + ';border-color:' + c + '">' + letter + '</span>'
        : '<span class="friend-dot">' + letter + '</span>';
    }

    function toDocObj(d) { var o = d.data(); o.id = d.id; return o; }

    /* ---------------------------------------------------------------- chat */

    /* One conversation per friendship, stored under chats/{pairId}. A small
     * summary document (last text/sender/time) powers the unread dots with a
     * single listener; the messages themselves are only subscribed to while
     * a conversation is open, newest 60, so a quiet chat costs nothing. The
     * "read up to" mark is kept on this device. */
    var CHAT_LIMIT = 60;

    function readKey() { return 'whereabouts.chatRead.' + currentUid; }
    function readMarks() {
      try { return JSON.parse(localStorage.getItem(readKey()) || '{}') || {}; } catch (e) { return {}; }
    }
    function markRead(pid) {
      var m = readMarks();
      m[pid] = Date.now();
      try { localStorage.setItem(readKey(), JSON.stringify(m)); } catch (e) {}
      renderUnread();
    }
    function isUnread(pid) {
      var c = chatMeta[pid];
      if (!c || !c.lastFrom || c.lastFrom === currentUid) return false;
      if (chatOpen && chatOpen.pid === pid) return false;
      return c.lastAt > (readMarks()[pid] || 0);
    }
    function renderUnread() {
      var any = false;
      document.querySelectorAll('#friends-list .friend-item').forEach(function (li) {
        var un = isUnread(li.dataset.id);
        any = any || un;
        li.classList.toggle('has-unread', un);
        var btn = li.querySelector('.friend-chat');
        if (btn) btn.classList.toggle('is-unread', un);
      });
      // Rows can be missing while the list is re-rendering; check the data too.
      Object.keys(chatMeta).forEach(function (pid) { if (isUnread(pid)) any = true; });
      $('tab-friends').classList.toggle('has-unread', any);
    }

    function dayLabel(d) {
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var that = new Date(d); that.setHours(0, 0, 0, 0);
      var diff = Math.round((today - that) / 86400000);
      if (diff === 0) return t('chat.today');
      if (diff === 1) return t('chat.yesterday');
      try {
        return d.toLocaleDateString(document.documentElement.lang || undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      } catch (e) { return d.toDateString(); }
    }
    function clock(d) {
      try { return d.toLocaleTimeString(document.documentElement.lang || undefined, { hour: '2-digit', minute: '2-digit' }); }
      catch (e) { return ''; }
    }

    function renderChat(stick) {
      var log = $('chat-log');
      var nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      if (!chatMsgs.length) {
        log.innerHTML = '<p class="chat-empty muted">' + escapeHtml(t('chat.empty')) + '</p>';
        return;
      }
      var html = '', lastDay = '', prevFrom = null;
      chatMsgs.forEach(function (m) {
        var d = m.at;
        var day = d.toDateString();
        if (day !== lastDay) {
          html += '<div class="chat-day"><span>' + escapeHtml(dayLabel(d)) + '</span></div>';
          lastDay = day; prevFrom = null;
        }
        var mine = m.from === currentUid;
        html += '<div class="chat-row ' + (mine ? 'is-mine' : 'is-theirs') + (prevFrom === m.from ? ' is-follow' : '') + '">' +
          '<div class="chat-bubble' + (m.pending ? ' is-pending' : '') + '">' +
            '<span class="chat-text">' + escapeHtml(m.text) + '</span>' +
            '<span class="chat-time">' + escapeHtml(clock(d)) + '</span>' +
          '</div></div>';
        prevFrom = m.from;
      });
      log.innerHTML = html;
      if (stick || nearBottom) log.scrollTop = log.scrollHeight;
    }

    function chatError(msg) {
      var el = $('chat-error');
      el.textContent = msg || '';
      el.hidden = !msg;
    }

    function openChat(pid, uid) {
      closeChat(true);
      chatOpen = { pid: pid, uid: uid };
      chatMsgs = [];
      chatError(null);
      $('chat-name').textContent = displayName(uid);
      $('chat-dot').innerHTML = friendDot(uid);
      $('chat-input').value = '';
      $('chat-send').disabled = true;
      var panel = document.querySelector('.tab-panel[data-panel="friends"]');
      panel.classList.add('is-chatting');
      $('chat-view').hidden = false;
      renderChat(true);
      markRead(pid);
      chatUnsub = onSnapshot(
        query(collection(db, 'chats', pid, 'messages'), orderBy('createdAt', 'desc'), limit(CHAT_LIMIT)),
        function (snap) {
          if (!chatOpen || chatOpen.pid !== pid) return;
          chatMsgs = snap.docs.map(function (d) {
            var x = d.data();
            var at = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate() : new Date();
            return { id: d.id, from: x.from, text: x.text, at: at, pending: d.metadata.hasPendingWrites };
          }).reverse();
          renderChat(false);
          chatError(null);
          markRead(pid);
        },
        function (err) {
          chatError(err && err.code === 'permission-denied' ? t('chat.denied') : t('chat.failed'));
        }
      );
      setTimeout(function () { var i = $('chat-input'); if (i && !i.closest('[hidden]')) i.focus({ preventScroll: true }); }, 60);
    }

    function closeChat(silent) {
      if (chatUnsub) { try { chatUnsub(); } catch (e) {} chatUnsub = null; }
      var was = chatOpen;
      chatOpen = null;
      chatMsgs = [];
      var panel = document.querySelector('.tab-panel[data-panel="friends"]');
      if (panel) panel.classList.remove('is-chatting');
      $('chat-view').hidden = true;
      $('chat-log').innerHTML = '';
      chatError(null);
      if (was && !silent) markRead(was.pid);
    }

    async function sendChat(text) {
      if (!chatOpen) return;
      var pid = chatOpen.pid;
      var uids = pid.split('_');
      chatError(null);
      try {
        // Both writes in one batch: the message and the summary the other
        // person's unread dot is built from.
        var batch = writeBatch(db);
        batch.set(doc(collection(db, 'chats', pid, 'messages')), { from: currentUid, text: text, createdAt: serverTimestamp() });
        batch.set(doc(db, 'chats', pid), { uids: uids, lastFrom: currentUid, lastText: text.slice(0, 80), lastAt: serverTimestamp() });
        await batch.commit();
      } catch (err) {
        chatError(err && err.code === 'permission-denied' ? t('chat.denied') : t('chat.failed'));
      }
    }

    $('chat-back').addEventListener('click', function () { closeChat(false); });
    $('chat-input').addEventListener('input', function () {
      $('chat-send').disabled = !$('chat-input').value.trim();
    });
    $('chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chat-input');
      var text = input.value.trim();
      if (!text || !chatOpen) return;
      input.value = '';
      $('chat-send').disabled = true;
      sendChat(text);
      input.focus({ preventScroll: true });
      // Show it right away; the snapshot re-renders it with the server time.
      var log = $('chat-log');
      setTimeout(function () { log.scrollTop = log.scrollHeight; }, 30);
    });

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
      var c = prefOf(uid).color || null;
      // On the map a bare email is too long for the name tag — use the part
      // before the @ unless you've given them a nickname.
      var tag = prefOf(uid).nick || String(emailByUid[uid] || uid).split('@')[0];
      window.Whereabouts.setFriendMarker(uid, f.lat, f.lng, tag,
        { color: c, textColor: c ? textOn(c) : null });
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
      // Removing a friend closes the conversation for both of you.
      if (chatOpen && !friendships.some(function (x) { return x.id === chatOpen.pid; })) closeChat(true);

      var ul = $('friends-list');
      ul.innerHTML = friendships.map(function (f) {
        var otherUid = f.uids[0] === currentUid ? f.uids[1] : f.uids[0];
        var nick = prefOf(otherUid).nick;
        var row = '<li class="friend-item" data-id="' + f.id + '" data-uid="' + escapeHtml(otherUid) + '">' +
          friendDot(otherUid) +
          '<span class="friend-main"><span class="friend-name">' + escapeHtml(displayName(otherUid)) + '</span>' +
          (nick ? '<span class="friend-email">' + escapeHtml(emailByUid[otherUid]) + '</span>' : '') +
          '<span class="friend-meta">' + escapeHtml(friendMeta(otherUid)) + '</span></span>' +
          '<button class="friend-chat' + (isUnread(f.id) ? ' is-unread' : '') + '" type="button" data-action="chat" title="' + escapeHtml(t('friends.chatTitle')) + '" aria-label="' + escapeHtml(t('friends.chatTitle')) + '">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg><span class="friend-chat-dot"></span></button>' +
          '<button class="friend-edit" type="button" data-action="edit" title="' + escapeHtml(t('friends.editTitle')) + '" aria-label="' + escapeHtml(t('friends.editTitle')) + '">✎</button>' +
          '<button class="friend-del" type="button" data-action="remove" title="' + escapeHtml(t('friends.removeTitle')) + '">×</button>' +
        '</li>';
        if (editingUid === otherUid) row += editorHtml(otherUid);
        return row;
      }).join('');
      bindRowAction(ul, '[data-action="remove"]', function (id) {
        deleteDoc(doc(db, 'friendships', id)).catch(function () {});
      });
      ul.querySelectorAll('[data-action="chat"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var li = btn.closest('li');
          openChat(li.dataset.id, li.dataset.uid);
        });
      });
      ul.querySelectorAll('[data-action="edit"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var uid = btn.closest('li').dataset.uid;
          if (editingUid === uid) { closeEditor(); return; }
          editingUid = uid;
          var p = prefOf(uid);
          draft = { nick: p.nick || '', color: p.color || null };
          renderFriends();
          var input = $('friend-nick-input');
          if (input) { input.focus(); input.select(); }
        });
      });
      bindEditor();
      renderUnread();
      Object.keys(friendLocations).forEach(updateFriendMarker);
    }

    function editorHtml(uid) {
      var swatches = '<button type="button" class="friend-swatch friend-swatch-none' + (!draft.color ? ' is-active' : '') +
        '" data-color="" title="' + escapeHtml(t('friends.colorNone')) + '" aria-label="' + escapeHtml(t('friends.colorNone')) + '"></button>' +
        FRIEND_COLORS.map(function (c) {
          return '<button type="button" class="friend-swatch' + (draft.color === c ? ' is-active' : '') +
            '" data-color="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>';
        }).join('');
      return '<li class="friend-editor" data-uid="' + escapeHtml(uid) + '">' +
        '<label class="auth-field"><span>' + escapeHtml(t('friends.nickLabel')) + '</span>' +
          '<input id="friend-nick-input" type="text" maxlength="30" autocomplete="off" value="' + escapeHtml(draft.nick) +
          '" placeholder="' + escapeHtml(t('friends.nickPlaceholder')) + '"></label>' +
        '<span class="friend-editor-label">' + escapeHtml(t('friends.colorLabel')) + '</span>' +
        '<div class="friend-swatches" role="group">' + swatches + '</div>' +
        '<div class="friend-editor-actions">' +
          '<button type="button" class="btn" data-action="cancel-edit">' + escapeHtml(t('friends.cancel')) + '</button>' +
          '<button type="button" class="btn btn-primary" data-action="save-edit">' + escapeHtml(t('friends.save')) + '</button>' +
        '</div>' +
      '</li>';
    }

    function bindEditor() {
      var ed = document.querySelector('#friends-list .friend-editor');
      if (!ed) return;
      var input = $('friend-nick-input');
      input.addEventListener('input', function () { draft.nick = input.value; });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveEditor(); }
        if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
      });
      ed.querySelectorAll('.friend-swatch').forEach(function (b) {
        b.addEventListener('click', function () {
          draft.color = b.dataset.color || null;
          ed.querySelectorAll('.friend-swatch').forEach(function (x) { x.classList.toggle('is-active', x === b); });
        });
      });
      ed.querySelector('[data-action="cancel-edit"]').addEventListener('click', closeEditor);
      ed.querySelector('[data-action="save-edit"]').addEventListener('click', saveEditor);
    }

    function closeEditor() {
      editingUid = null;
      draft = null;
      renderFriends();
    }

    function saveEditor() {
      if (!editingUid || !draft) return;
      var nick = (draft.nick || '').trim().slice(0, 30);
      var entry = {};
      if (nick) entry.nick = nick;
      if (draft.color) entry.color = draft.color;
      if (entry.nick || entry.color) friendPrefs[editingUid] = entry;
      else delete friendPrefs[editingUid];
      savePrefs();
      closeEditor();
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
      chatMeta = {};
      closeChat(true);
      $('tab-friends').classList.remove('has-unread');
      emailByUid = {};
      friendPrefs = {};
      editingUid = null;
      draft = null;
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

    function onUser(user) {
      teardown();
      // Unconfirmed addresses get nothing: the rules reject them anyway, and
      // the Friends tab shouldn't appear for an account that can't use it.
      if (!user || !user.emailVerified) return;

      currentUid = user.uid;
      currentEmail = user.email;
      $('tab-friends').hidden = false;
      loadLocalPrefs();

      // Nicknames/colours from your other devices. Remote wins when present;
      // if the rule for friendPrefs isn't published this just errors quietly.
      unsubs.push(onSnapshot(doc(db, 'friendPrefs', currentUid), function (snap) {
        if (!snap.exists() || snap.metadata.hasPendingWrites) return;
        var remote = snap.data().prefs;
        if (!remote || typeof remote !== 'object') return;
        friendPrefs = remote;
        try { localStorage.setItem(prefsKey(), JSON.stringify(friendPrefs)); } catch (e) {}
        if (!editingUid) renderFriends();
        else Object.keys(friendLocations).forEach(updateFriendMarker);
      }, function () {}));

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
        query(collection(db, 'chats'), where('uids', 'array-contains', currentUid)),
        function (snap) {
          var fresh = {};
          snap.docs.forEach(function (d) {
            var x = d.data();
            fresh[d.id] = {
              lastFrom: x.lastFrom,
              lastAt: x.lastAt && x.lastAt.toMillis ? x.lastAt.toMillis() : Date.now(),
              lastText: x.lastText || ''
            };
          });
          chatMeta = fresh;
          if (chatOpen) markRead(chatOpen.pid); else renderUnread();
        },
        function () {}
      ));
      unsubs.push(onSnapshot(
        query(collection(db, 'friendships'), where('uids', 'array-contains', currentUid)),
        function (snap) { friendships = snap.docs.map(toDocObj); renderFriends(); },
        function () {}
      ));
    }

    fbAuth.onAuthStateChanged(auth, onUser);
    // Confirming the address doesn't change who is signed in, so there is no
    // auth-state event — auth.js announces it instead.
    window.addEventListener('whereabouts:verified', function () { onUser(auth.currentUser); });
  }
})();
