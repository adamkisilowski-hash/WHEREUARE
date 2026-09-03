/* Whereabouts — sign-in gate.
 *
 * A module (not a classic script) so it can import the Firebase SDK
 * directly from its CDN — the one external dependency in this app, and
 * only loaded at all once a real project config is supplied. Module
 * scripts run after the document is parsed, so by the time this executes,
 * firebase-config.js and app.js (both plain classic scripts placed earlier)
 * have already run and set up window.WHEREABOUTS_FIREBASE_CONFIG and
 * window.Whereabouts.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var I18N = window.WhereaboutsI18n;
  var t = I18N.t;
  var config = window.WHEREABOUTS_FIREBASE_CONFIG || {};
  var configured = !!(config.apiKey && config.apiKey !== 'PLACEHOLDER');

  var authLangToggle = $('auth-lang-toggle');
  if (authLangToggle) authLangToggle.addEventListener('click', function () { I18N.cycleLang(); });

  function startApp() {
    if (window.Whereabouts && !window.Whereabouts.started) {
      window.Whereabouts.started = true;
      window.Whereabouts.start();
    }
  }

  // Guest mode: use the app without an account at all, same as before
  // sign-in existed, but as a deliberate choice rather than the only option.
  // Remembered across reloads so a returning guest isn't dropped back behind
  // the gate every time — but a real sign-in always wins over a stale guest
  // flag, and signing out for real clears it rather than silently re-entering.
  var GUEST_KEY = 'whereabouts.guest';
  var guestMode = false;
  try { guestMode = localStorage.getItem(GUEST_KEY) === '1'; } catch (e) {}

  function enterGuestMode() {
    guestMode = true;
    try { localStorage.setItem(GUEST_KEY, '1'); } catch (e) {}
    $('auth-gate').hidden = true;
    $('app-root').hidden = false;
    $('guest-badge').hidden = false;
    startApp();
  }

  function exitGuestMode() {
    guestMode = false;
    try { localStorage.removeItem(GUEST_KEY); } catch (e) {}
    // A full reload, same as signing out for real — the simplest reliable
    // way back to a clean gate.
    location.reload();
  }

  var guestBtn = $('auth-guest');
  if (guestBtn) guestBtn.addEventListener('click', enterGuestMode);
  var guestBadge = $('guest-badge');
  if (guestBadge) guestBadge.addEventListener('click', exitGuestMode);

  // Sign-in isn't set up — behave exactly as this app did before accounts
  // existed, rather than showing a gate nobody can get past.
  if (!configured) {
    $('auth-gate').remove();
    $('app-root').hidden = false;
    startApp();
    return;
  }

  if (guestMode) enterGuestMode();

  run();

  async function run() {
    var fb, fbAuth;
    try {
      fb = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js');
      fbAuth = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js');
    } catch (e) {
      // The CDN is unreachable (offline, blocked) — same fallback as an
      // unconfigured project: don't strand the user behind a gate that
      // can never load.
      $('auth-gate').remove();
      $('app-root').hidden = false;
      startApp();
      return;
    }

    var app = fb.initializeApp(config);
    var auth = fbAuth.getAuth(app);
    var mode = 'signin';

    var ERROR_KEYS = {
      'auth/invalid-email': 'auth.err.invalidEmail',
      'auth/email-already-in-use': 'auth.err.emailInUse',
      'auth/weak-password': 'auth.err.weakPassword',
      'auth/user-not-found': 'auth.err.userNotFound',
      'auth/wrong-password': 'auth.err.wrongPassword',
      'auth/invalid-credential': 'auth.err.invalidCredential',
      'auth/missing-password': 'auth.err.missingPassword',
      'auth/too-many-requests': 'auth.err.tooManyRequests',
      'auth/network-request-failed': 'auth.err.networkFailed'
    };

    function authErrorMessage(err) {
      var key = ERROR_KEYS[err && err.code];
      return key ? t(key) : ((err && err.message) || t('auth.genericError'));
    }

    function setError(msg) {
      var el = $('auth-error');
      if (!msg) { el.hidden = true; return; }
      el.textContent = msg;
      el.hidden = false;
    }

    function setStatus(msg) {
      var el = $('auth-status');
      if (!msg) { el.hidden = true; return; }
      el.textContent = msg;
      el.hidden = false;
    }

    function setBusy(busy) {
      $('auth-submit').disabled = busy;
    }

    function applyMode() {
      $('auth-submit').textContent = mode === 'signin' ? t('auth.signIn') : t('auth.createAccount');
      $('auth-toggle-mode').textContent = mode === 'signin' ? t('auth.needAccount') : t('auth.haveAccount');
      $('auth-password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
    }

    I18N.onChange(applyMode);

    $('auth-toggle-mode').addEventListener('click', function () {
      mode = mode === 'signin' ? 'register' : 'signin';
      applyMode();
      setError(null);
      setStatus(null);
    });

    $('auth-forgot').addEventListener('click', function () {
      var email = $('auth-email').value.trim();
      if (!email) { setError(t('auth.enterEmailFirst')); return; }
      setError(null);
      fbAuth.sendPasswordResetEmail(auth, email).then(function () {
        setStatus(t('auth.resetSent'));
      }).catch(function (err) { setError(authErrorMessage(err)); });
    });

    $('auth-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('auth-email').value.trim();
      var password = $('auth-password').value;
      setError(null);
      setStatus(null);
      setBusy(true);
      var action = mode === 'signin' ? fbAuth.signInWithEmailAndPassword : fbAuth.createUserWithEmailAndPassword;
      action(auth, email, password)
        .catch(function (err) { setError(authErrorMessage(err)); })
        .finally(function () { setBusy(false); });
    });

    /* The avatar's dropdown — kept as three tiny functions rather than a
     * generic menu component, since this app has exactly one menu. */
    function openMenu() {
      $('account-menu').hidden = false;
      $('account-avatar').setAttribute('aria-expanded', 'true');
    }
    function closeMenu() {
      $('account-menu').hidden = true;
      $('account-avatar').setAttribute('aria-expanded', 'false');
    }
    function menuIsOpen() { return !$('account-menu').hidden; }

    $('account-avatar').addEventListener('click', function (e) {
      e.stopPropagation();
      if (menuIsOpen()) closeMenu(); else openMenu();
    });

    // A click anywhere outside the menu closes it — the standard contract
    // for any dropdown, and without it the menu would just sit open over
    // the tabs underneath.
    document.addEventListener('click', function (e) {
      if (menuIsOpen() && !$('account-menu').contains(e.target) && e.target !== $('account-avatar')) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuIsOpen()) closeMenu();
    });

    $('account-change-password').addEventListener('click', function () {
      var user = auth.currentUser;
      if (!user || !user.email) return;
      fbAuth.sendPasswordResetEmail(auth, user.email).then(function () {
        closeMenu();
        toastLike(t('auth.resetSent'));
      }).catch(function () { closeMenu(); });
    });

    $('account-signout').addEventListener('click', function () {
      // A full reload is the simplest reliable way to stop every running
      // watch/timer/poll rather than writing a bespoke teardown for each.
      fbAuth.signOut(auth).then(function () { location.reload(); });
    });

    // A minimal stand-in for app.js's own toast — this module can't reach
    // into app.js's private state, and duplicating a whole toast system for
    // one confirmation message here isn't worth it.
    function toastLike(message) {
      var el = $('toast');
      if (!el) return;
      el.textContent = message;
      el.hidden = false;
      el.classList.add('is-visible');
      setTimeout(function () {
        el.classList.remove('is-visible');
        setTimeout(function () { el.hidden = true; }, 250);
      }, 2600);
    }

    fbAuth.onAuthStateChanged(auth, function (user) {
      if (user) {
        // A real sign-in always wins over a leftover guest flag.
        guestMode = false;
        try { localStorage.removeItem(GUEST_KEY); } catch (e) {}
        $('guest-badge').hidden = true;
        $('auth-gate').hidden = true;
        $('app-root').hidden = false;
        $('account-avatar').hidden = false;
        $('account-initial').textContent = (user.email || '?').charAt(0).toUpperCase();
        $('account-menu-email').textContent = user.email;
        startApp();
      } else if (guestMode) {
        // Already showing the app as a guest (entered above, or restored
        // from a previous session) — nothing to do, and critically, don't
        // fall through to showing the gate.
      } else {
        $('app-root').hidden = true;
        $('account-avatar').hidden = true;
        closeMenu();
        $('auth-gate').hidden = false;
      }
    });

    applyMode();
  }
})();
