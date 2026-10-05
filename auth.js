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


    /* "Real email" check, before an account is created. Three layers:
     * shape, a list of throwaway-inbox providers, and a DNS lookup that the
     * domain can actually receive mail at all. The decisive check is the
     * confirmation link every account must click before the app opens; this
     * just stops obvious junk early and with a clear message. */
    var DISPOSABLE = ["mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.de", "sharklasers.com", "grr.la", "guerrillamailblock.com", "spam4.me", "10minutemail.com", "10minutemail.net", "20minutemail.com", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmail.net", "tempmailo.com", "tempr.email", "tmpmail.org", "tmpmail.net", "trashmail.com", "trashmail.net", "trashmail.de", "yopmail.com", "yopmail.net", "yopmail.fr", "cool.fr.nf", "jetable.org", "nospam.ze.tc", "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "mailnesia.com", "mintemail.com", "throwawaymail.com", "fakeinbox.com", "fakemailgenerator.com", "emailondeck.com", "moakt.com", "mohmal.com", "mytemp.email", "burnermail.io", "discard.email", "discardmail.com", "spamgourmet.com", "mailcatch.com", "mailnull.com", "mailforspam.com", "mail-temporary.com", "einrot.com", "wegwerfmail.de", "wegwerfmail.net", "wegwerfmail.org", "byom.de", "trash-mail.com", "trash-mail.de", "33mail.com", "anonbox.net", "inboxkitten.com", "harakirimail.com", "spambox.us", "spamfree24.org", "tempinbox.com", "tempail.com", "emailfake.com", "email-fake.com", "fakemail.net", "luxusmail.org", "throwam.com", "tmail.ws", "mail.tm", "mail.gw", "1secmail.com", "1secmail.net", "1secmail.org"];
    var DISPOSABLE_SET = {};
    DISPOSABLE.forEach(function (d) { DISPOSABLE_SET[d] = true; });

    function dnsHas(name, type) {
      return fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=' + type, {
        headers: { accept: 'application/dns-json' }
      }).then(function (r) { return r.json(); });
    }

    // Resolves to an error message, or null when the address looks real.
    // Network trouble in the DNS check never blocks anyone — confirmation
    // still guards the door.
    function checkRealEmail(email) {
      var m = /^[^\s@]+@([^\s@]+\.[^\s@.]{2,})$/.exec(email);
      if (!m || /\.\./.test(email)) return Promise.resolve(t('auth.err.invalidEmail'));
      var domain = m[1].toLowerCase();
      var parts = domain.split('.');
      for (var i = 0; i < parts.length - 1; i++) {
        if (DISPOSABLE_SET[parts.slice(i).join('.')]) return Promise.resolve(t('auth.err.disposable'));
      }
      return dnsHas(domain, 'MX').then(function (res) {
        if (res.Status === 3) return t('auth.err.noMail');
        if (res.Answer && res.Answer.some(function (a) { return a.type === 15; })) return null;
        // No MX record: mail can still go to the domain's own address record.
        return dnsHas(domain, 'A').then(function (a) {
          return (a.Answer && a.Answer.length) ? null : t('auth.err.noMail');
        });
      }).catch(function () { return null; });
    }

    /* Everyone must confirm their address before the app opens. The page
     * re-checks on its own (every few seconds, and when you come back to the
     * tab), so tapping the link in your inbox is usually enough. */
    var verifyUser = null;
    var verifyTimer = 0;
    var lastSent = 0;

    function vSet(id, msg) {
      var el = $(id);
      if (!msg) { el.hidden = true; return; }
      el.textContent = msg;
      el.hidden = false;
    }

    function sendVerification(user) {
      lastSent = Date.now();
      return fbAuth.sendEmailVerification(user);
    }

    function showVerify(user) {
      verifyUser = user;
      $('app-root').hidden = true;
      $('auth-gate').hidden = false;
      $('auth-form').hidden = true;
      var g = $('auth-guest'); if (g) g.hidden = true;
      $('auth-verify').hidden = false;
      $('auth-verify-text').textContent = t('auth.verify.text', { email: user.email });
      clearInterval(verifyTimer);
      verifyTimer = setInterval(function () { checkVerified(false); }, 4000);
    }

    function checkVerified(manual) {
      var user = verifyUser;
      if (!user) return Promise.resolve();
      return user.reload().then(function () {
        if (user.emailVerified) {
          clearInterval(verifyTimer);
          // The confirmed flag lives in the sign-in token: refresh it so the
          // database rules see it straight away.
          return user.getIdToken(true).then(function () {
            verifyUser = null;
            enterAsUser(user);
            window.dispatchEvent(new CustomEvent('whereabouts:verified'));
          });
        }
        if (manual) vSet('auth-verify-status', t('auth.verify.notYet'));
      }).catch(function (err) {
        if (manual) vSet('auth-verify-error', authErrorMessage(err));
      });
    }

    $('auth-verify-done').addEventListener('click', function () {
      vSet('auth-verify-error', null); vSet('auth-verify-status', null);
      checkVerified(true);
    });

    $('auth-verify-resend').addEventListener('click', function () {
      vSet('auth-verify-error', null); vSet('auth-verify-status', null);
      var wait = 60 - Math.floor((Date.now() - lastSent) / 1000);
      if (verifyUser && wait > 0 && lastSent) { vSet('auth-verify-status', t('auth.verify.cooldown', { s: wait })); return; }
      sendVerification(verifyUser).then(function () {
        vSet('auth-verify-status', t('auth.verify.resent'));
      }).catch(function (err) { vSet('auth-verify-error', authErrorMessage(err)); });
    });

    $('auth-verify-other').addEventListener('click', function () {
      fbAuth.signOut(auth).then(function () { location.reload(); });
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && verifyUser) checkVerified(false);
    });

    function enterAsUser(user) {
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
      var action = mode === 'signin'
        ? fbAuth.signInWithEmailAndPassword(auth, email, password)
        : checkRealEmail(email).then(function (problem) {
            if (problem) { var err = new Error(problem); err.code = 'app/fake-email'; throw err; }
            return fbAuth.createUserWithEmailAndPassword(auth, email, password).then(function (cred) {
              return sendVerification(cred.user).catch(function () {});
            });
          });
      action
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
      if (user && !user.emailVerified) {
        showVerify(user);
      } else if (user) {
        enterAsUser(user);
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
