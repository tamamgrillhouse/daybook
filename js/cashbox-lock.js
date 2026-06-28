/* 🔒 Ταμείο — κλείδωμα εφαρμογής (PIN + δαχτυλικό)
   Αυτόνομο, σαν το timepicker.js: βάζει μόνο του CSS + οθόνη κλειδώματος.
   - PIN 6 ψηφίων (αποθηκεύεται ΜΟΝΟ κρυπτογραφημένος hash + αλάτι, ποτέ καθαρός).
   - Δαχτυλικό μέσω WebAuthn (platform authenticator) — ζητάει το ΙΔΙΟ το Android.
     Δουλεύει ΜΟΝΟ σε ασφαλή σύνδεση (https → GitHub Pages) ή localhost.
   - Κανόνας: το δαχτυλικό ΔΕΝ ανοίγει χωρίς ορισμένο PIN.
   - Κλειδώνει σε ΚΑΘΕ άνοιγμα + ξανακλειδώνει όταν αφήνεις την εφαρμογή στην άκρη.
   - Reset: γίνεται από τον υπολογιστή — με νέα σύνδεση QR/κωδικού (βλ. cashbox-app.js handleConnectHash
     & connect/settings) που σβήνει το κλείδωμα (μόνο όποιος έχει το QR του υπολογιστή).
   Όλα ζουν ΜΟΝΟ στο κινητό (localStorage). Εκτίθεται ως window.CBLock. */
(function () {
  'use strict';
  var LS_PIN = 'cb_lock_pin';   // {salt, hash}  (παρουσία = κλείδωμα ενεργό)
  var LS_FP = 'cb_lock_fp';     // {credId}      (παρουσία = δαχτυλικό ενεργό)
  var LS_GRACE = 'cb_lock_grace'; // λεπτά «περιθωρίου» πριν ξανακλειδώσει (0 = άμεσα)· default 2
  var LS_SEEN = 'cb_lock_seen';   // πότε ήταν τελευταία ενεργή η εφαρμογή (epoch-ms)
  var DEFAULT_GRACE = 2;
  var PIN_LEN = 6;
  var subtle = (window.crypto && window.crypto.subtle) || null;
  var CFG = window.CB_CONFIG || {};
  var CONNECT_URL = CFG.noLocal ? './connect.html' : '/cashbox/m/settings';

  // ── helpers (base64 / bytes / hash) ───────────────────────────────────────────
  function rand(n) { var a = new Uint8Array(n); window.crypto.getRandomValues(a); return a; }
  function bytesToB64url(b) { var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_'); }
  function b64urlToBytes(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var bin = atob(s), o = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }
  function sha256hex(str) {
    var data = new TextEncoder().encode(str);
    return subtle.digest('SHA-256', data).then(function (buf) {
      var a = new Uint8Array(buf), h = ''; for (var i = 0; i < a.length; i++) h += (a[i] < 16 ? '0' : '') + a[i].toString(16); return h;
    });
  }
  function jload(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function jsave(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ── κατάσταση κλειδώματος ──────────────────────────────────────────────────────
  function hasPin() { var p = jload(LS_PIN); return !!(p && p.salt && p.hash); }
  function isEnabled() { return hasPin(); }                 // κλείδωμα ενεργό = υπάρχει PIN
  function fpOn() { var f = jload(LS_FP); return !!(f && f.credId); }
  function setPin(pin) {
    if (!subtle) return Promise.reject(new Error('no_crypto'));
    var salt = bytesToB64url(rand(16));
    return sha256hex(salt + ':' + pin).then(function (h) { jsave(LS_PIN, { salt: salt, hash: h }); stampSeen(); return true; });
  }
  function verifyPin(pin) {
    var p = jload(LS_PIN); if (!p || !subtle) return Promise.resolve(false);
    return sha256hex(p.salt + ':' + pin).then(function (h) {
      // σύγκριση σταθερού χρόνου (όσο γίνεται σε JS)
      if (h.length !== (p.hash || '').length) return false;
      var diff = 0; for (var i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ p.hash.charCodeAt(i);
      return diff === 0;
    });
  }
  function clearPin() { try { localStorage.removeItem(LS_PIN); } catch (e) {} clearFp(); }
  function clearFp() { try { localStorage.removeItem(LS_FP); } catch (e) {} }
  function clearAll() { clearPin(); }                        // reset = σβήνει PIN + δαχτυλικό

  // ── περιθώριο χρόνου (πότε ξανακλειδώνει) ──────────────────────────────────────
  // Ξανακλειδώνει ΜΟΝΟ αν λείψεις πάνω από «grace» λεπτά (ή στο φρέσκο άνοιγμα).
  // Γρήγορη εναλλαγή εφαρμογής & επιστροφή → δεν ενοχλεί. grace=0 → άμεσα (κάθε φορά).
  function getGrace() { var v = parseInt(localStorage.getItem(LS_GRACE), 10); return isNaN(v) ? DEFAULT_GRACE : Math.max(0, v); }
  function setGrace(min) { try { localStorage.setItem(LS_GRACE, String(Math.max(0, parseInt(min, 10) || 0))); } catch (e) {} }
  function stampSeen() { try { localStorage.setItem(LS_SEEN, String(Date.now())); } catch (e) {} }
  function getSeen() { var v = parseInt(localStorage.getItem(LS_SEEN), 10); return isNaN(v) ? 0 : v; }
  function shouldLock() { return isEnabled() && (Date.now() - getSeen()) > getGrace() * 60000; }

  // ── δαχτυλικό (WebAuthn) ───────────────────────────────────────────────────────
  function fpSupported() { return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }
  function fpPlatformAvailable() {
    if (!fpSupported() || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return Promise.resolve(false);
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false; });
  }
  // Εγγραφή δαχτυλικού — ΑΠΑΙΤΕΙ ορισμένο PIN (κανόνας). Δεν κρατάμε δημόσιο κλειδί:
  // είναι «κλειδαριά παρουσίας» — το Android επιβεβαιώνει ότι είσαι εσύ (userVerification).
  function registerFp() {
    if (!hasPin()) return Promise.reject(new Error('need_pin'));
    if (!fpSupported()) return Promise.reject(new Error('no_fp'));
    return navigator.credentials.create({
      publicKey: {
        challenge: rand(32), rp: { name: 'Ταμείο' },
        user: { id: rand(16), name: 'owner', displayName: 'Owner' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000, attestation: 'none'
      }
    }).then(function (cred) {
      if (!cred) throw new Error('no_cred');
      jsave(LS_FP, { credId: bytesToB64url(new Uint8Array(cred.rawId)) });
      return true;
    });
  }
  function verifyFp() {
    var f = jload(LS_FP); if (!f || !f.credId || !fpSupported()) return Promise.reject(new Error('no_fp'));
    return navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: b64urlToBytes(f.credId) }],
        userVerification: 'required', timeout: 60000
      }
    }).then(function (assertion) { if (!assertion) throw new Error('no_assertion'); return true; });
  }

  // ── οθόνη κλειδώματος (φτιάχνεται μία φορά) ─────────────────────────────────────
  var built = false, ovEl, dotsEl, errEl, padEl, forgotPanel, buf = '', onPass = null, armed = false, wasHidden = false;
  var viewFp, viewPin, fpcEl, fpGlyphEl, fpLabelEl, fpSubEl, retryBtn, backfpBtn;

  function injectCss() {
    if (document.getElementById('cbl-css')) return;
    var css = ''
      + '.cbl-ov{position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;'
      + 'justify-content:space-between;align-items:center;padding:38px 26px;color:#fff;'
      + 'background:linear-gradient(160deg,#f6953f 0%,#e8722c 55%,#cf5f1e 100%);'
      + "font-family:'Segoe UI',system-ui,Roboto,Arial,sans-serif;overflow:auto}"
      + '.cbl-ov.on{display:flex}'
      + '.cbl-top{display:flex;flex-direction:column;align-items:center;gap:14px;margin-top:10px}'
      + '.cbl-glyph{width:76px;height:76px;border-radius:24px;background:rgba(255,255,255,.18);display:flex;'
      + 'align-items:center;justify-content:center;font-size:36px;box-shadow:0 6px 20px rgba(0,0,0,.18)}'
      + '.cbl-title{font-weight:800;font-size:21px;text-align:center}'
      + '.cbl-sub{font-size:13.5px;opacity:.92;text-align:center;margin-top:-4px;max-width:300px}'
      + '.cbl-mid{display:flex;flex-direction:column;align-items:center;gap:8px}'
      + '.cbl-dots{display:flex;gap:15px;margin-top:6px}'
      + '.cbl-dot{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.75);transition:.12s}'
      + '.cbl-dot.fill{background:#fff;border-color:#fff;transform:scale(1.12)}'
      + '.cbl-err{font-size:13px;font-weight:700;min-height:20px;color:#ffe2da;text-align:center}'
      + '.cbl-shake{animation:cbl-shake .42s}'
      + '@keyframes cbl-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-9px)}40%{transform:translateX(9px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}'
      + '.cbl-bottom{display:flex;flex-direction:column;align-items:center;gap:14px;width:100%}'
      + '.cbl-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;width:100%;max-width:300px}'
      + '.cbl-key{height:62px;border-radius:18px;border:0;background:rgba(255,255,255,.16);color:#fff;'
      + 'font-size:25px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;'
      + "transition:.1s;font-family:inherit;-webkit-tap-highlight-color:transparent}"
      + '.cbl-key:active{background:rgba(255,255,255,.34);transform:scale(.96)}'
      + '.cbl-key.fn,.cbl-key.bk{font-size:27px;background:rgba(255,255,255,.10)}'
      + '.cbl-key.ph{background:none;pointer-events:none}'
      + '.cbl-forgot{background:none;border:0;color:#fff;font:inherit;font-size:14px;font-weight:700;'
      + 'text-decoration:underline;opacity:.92;cursor:pointer;padding:8px}'
      // δύο «όψεις» μέσα στην ίδια πορτοκαλί οθόνη: δαχτυλικό / κωδικός
      + '.cbl-view{display:none;flex:1;width:100%;flex-direction:column;align-items:center;justify-content:space-between}'
      + '.cbl-view.on{display:flex}'
      // animated δαχτυλικό στο κέντρο
      + '.cbl-fpc{display:flex;flex-direction:column;align-items:center;gap:15px}'
      + '.cbl-fpwrap{position:relative;width:140px;height:140px;display:flex;align-items:center;justify-content:center}'
      + '.cbl-ring{position:absolute;inset:0;border-radius:50%;border:3px solid rgba(255,255,255,.5)}'
      + '.cbl-ring.r2{inset:14px;border-color:rgba(255,255,255,.28)}'
      + '.cbl-fpglyph{font-size:60px;line-height:1;z-index:2;filter:drop-shadow(0 4px 10px rgba(0,0,0,.18));transition:transform .25s}'
      + '.cbl-sweep{position:absolute;left:0;right:0;height:46%;top:27%;overflow:hidden;border-radius:14px;z-index:3;opacity:0;pointer-events:none}'
      + '.cbl-bar{position:absolute;left:-10%;right:-10%;height:5px;background:linear-gradient(90deg,transparent,#fff,transparent);box-shadow:0 0 14px 4px rgba(255,255,255,.7);border-radius:4px}'
      + '.cbl-fplabel{font-size:15px;font-weight:700;text-align:center;min-height:22px}'
      + '.cbl-fpsub{font-size:12.5px;opacity:.9;text-align:center;margin-top:-8px;max-width:240px}'
      // κατάσταση «αναμονή»
      + '.cbl-fpc.wait .cbl-ring{animation:cbl-ringp 1.6s ease-in-out infinite}'
      + '.cbl-fpc.wait .cbl-ring.r2{animation:cbl-ringp 1.6s ease-in-out infinite .3s}'
      + '.cbl-fpc.wait .cbl-fpglyph{animation:cbl-breathe 1.6s ease-in-out infinite}'
      + '.cbl-fpc.wait .cbl-sweep{opacity:1}'
      + '.cbl-fpc.wait .cbl-bar{animation:cbl-sweepm 1.5s linear infinite}'
      + '@keyframes cbl-ringp{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.06);opacity:.9}}'
      + '@keyframes cbl-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}'
      + '@keyframes cbl-sweepm{0%{top:-10%}100%{top:104%}}'
      // κατάσταση «πέτυχε»
      + '.cbl-fpc.ok .cbl-ring{border-color:#bff0cf}.cbl-fpc.ok .cbl-ring.r2{border-color:#8fe0ad}'
      + '.cbl-fpc.ok .cbl-fpwrap{animation:cbl-popok .4s ease}'
      + '@keyframes cbl-popok{0%{transform:scale(.9)}55%{transform:scale(1.12)}100%{transform:scale(1)}}'
      // κατάσταση «απέτυχε»
      + '.cbl-fpc.fail .cbl-ring{border-color:#ffc9c2}.cbl-fpc.fail .cbl-ring.r2{border-color:#ff9d92}'
      + '.cbl-fpc.fail .cbl-fpwrap{animation:cbl-shake .5s}'
      // κουμπιά όψης δαχτυλικού
      + '.cbl-usepin,.cbl-bigbtn{border-radius:14px;padding:14px;font:inherit;font-size:14.5px;font-weight:700;width:100%;max-width:300px;cursor:pointer;min-height:48px}'
      + '.cbl-usepin{background:rgba(255,255,255,.16);border:1.5px solid rgba(255,255,255,.45);color:#fff}'
      + '.cbl-bigbtn{background:#fff;color:#cf5f1e;border:1.5px solid #fff;display:none}'
      + '.cbl-backfp{background:none;border:0;color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer;padding:8px;display:none}'
      + '.cbl-forgot-panel{position:fixed;inset:0;z-index:2147483002;display:none;background:#f5f6f8;color:#1f2430;overflow:auto;padding:18px 16px}'
      + '.cbl-forgot-panel.on{display:block}'
      + '.cbl-fcard{background:#fff;border:1px solid #e6e8ec;border-radius:16px;padding:16px 15px;max-width:520px;margin:0 auto 14px}'
      + '.cbl-fh{font-weight:800;font-size:16px;margin-bottom:10px}'
      + '.cbl-note{background:#fff3eb;border:1px solid #f3cfb3;border-radius:12px;padding:12px 14px;font-size:13px;color:#7a4a22;margin-bottom:12px}'
      + '.cbl-steps{counter-reset:cs;list-style:none;margin:4px 0;padding:0}'
      + '.cbl-steps li{position:relative;padding:10px 0 10px 40px;font-size:13.5px;border-bottom:1px solid #e6e8ec}'
      + '.cbl-steps li:last-child{border-bottom:0}'
      + '.cbl-steps li::before{counter-increment:cs;content:counter(cs);position:absolute;left:0;top:9px;width:27px;height:27px;'
      + 'background:#e8722c;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px}'
      + '.cbl-fbtn{width:100%;border-radius:12px;padding:13px 16px;font:inherit;font-weight:800;cursor:pointer;min-height:48px;border:0;margin-top:6px}'
      + '.cbl-fbtn.p{background:#e8722c;color:#fff}.cbl-fbtn.s{background:#fff;color:#1f2430;border:1px solid #e6e8ec;font-weight:700}';
    var st = document.createElement('style'); st.id = 'cbl-css'; st.textContent = css; document.head.appendChild(st);
  }

  function build() {
    if (built) return; built = true; injectCss();
    ovEl = document.createElement('div'); ovEl.className = 'cbl-ov';
    ovEl.innerHTML =
      // ── όψη ΔΑΧΤΥΛΙΚΟΥ (animated κέντρο) ──
      '<div class="cbl-view" id="cbl-view-fp">'
      + '<div class="cbl-top"><div class="cbl-glyph">🔒</div>'
      + '<div class="cbl-title">Ξεκλείδωσε το Ταμείο</div></div>'
      + '<div class="cbl-fpc wait" id="cbl-fpc">'
      +   '<div class="cbl-fpwrap"><div class="cbl-ring"></div><div class="cbl-ring r2"></div>'
      +     '<div class="cbl-sweep"><div class="cbl-bar"></div></div>'
      +     '<div class="cbl-fpglyph" id="cbl-fpglyph">👆</div></div>'
      +   '<div class="cbl-fplabel" id="cbl-fplabel">Σάρωσε το δαχτυλικό σου</div>'
      +   '<div class="cbl-fpsub" id="cbl-fpsub">Άγγιξε τον αισθητήρα του κινητού</div>'
      + '</div>'
      + '<div class="cbl-bottom">'
      +   '<button type="button" class="cbl-bigbtn" id="cbl-retry">👆 Ξαναδοκίμασε το δαχτυλικό</button>'
      +   '<button type="button" class="cbl-usepin" id="cbl-usepin">🔢 Χρήση κωδικού</button>'
      +   '<button type="button" class="cbl-forgot" data-forgot>Ξέχασα τον κωδικό;</button>'
      + '</div></div>'
      // ── όψη ΚΩΔΙΚΟΥ (πληκτρολόγιο) ──
      + '<div class="cbl-view" id="cbl-view-pin">'
      + '<div class="cbl-top"><div class="cbl-glyph">🔢</div>'
      + '<div class="cbl-title">Βάλε τον κωδικό</div>'
      + '<div class="cbl-sub">6ψήφιος κωδικός</div></div>'
      + '<div class="cbl-mid"><div class="cbl-dots" id="cbl-dots"></div><div class="cbl-err" id="cbl-err"></div></div>'
      + '<div class="cbl-bottom"><div class="cbl-pad" id="cbl-pad"></div>'
      +   '<button type="button" class="cbl-backfp" id="cbl-backfp">👆 Πίσω στο δαχτυλικό</button>'
      +   '<button type="button" class="cbl-forgot" data-forgot>Ξέχασα τον κωδικό;</button></div>'
      + '</div>';
    document.body.appendChild(ovEl);

    // οθόνη «ξέχασα τον κωδικό»
    forgotPanel = document.createElement('div'); forgotPanel.className = 'cbl-forgot-panel'; forgotPanel.id = 'cbl-forgot-panel';
    forgotPanel.innerHTML =
      '<div class="cbl-fcard"><div class="cbl-fh">🔓 Ξέχασα / αλλάζω τον κωδικό</div>'
      + '<div class="cbl-note">Το κλείδωμα μηδενίζεται <b>μόνο από τον υπολογιστή σου</b> — εκεί που υπάρχει ο κωδικός QR σύνδεσης. '
      + 'Έτσι κανείς άλλος δεν μπορεί να το ανοίξει.</div>'
      + '<ol class="cbl-steps">'
      + '<li>Άνοιξε στον υπολογιστή: <b>Ρυθμίσεις → 📮 Συγχρονισμός κινητού</b></li>'
      + '<li>Εμφανίζεται ο <b>κωδικός QR σύνδεσης</b></li>'
      + '<li>Σάρωσέ τον με την κάμερα του κινητού (ή επικόλλησε τον κωδικό στη σελίδα σύνδεσης)</li>'
      + '<li>Το κλείδωμα μηδενίζεται — όρισε <b>νέο κωδικό</b> από τις Ρυθμίσεις</li></ol>'
      + '<button type="button" class="cbl-fbtn p" id="cbl-goconn">📮 Άνοιγμα σελίδας σύνδεσης (επικόλληση κωδικού)</button>'
      + '<button type="button" class="cbl-fbtn s" id="cbl-fback">← Πίσω στο κλείδωμα</button></div>';
    document.body.appendChild(forgotPanel);

    dotsEl = document.getElementById('cbl-dots');
    errEl = document.getElementById('cbl-err');
    padEl = document.getElementById('cbl-pad');
    viewFp = document.getElementById('cbl-view-fp');
    viewPin = document.getElementById('cbl-view-pin');
    fpcEl = document.getElementById('cbl-fpc');
    fpGlyphEl = document.getElementById('cbl-fpglyph');
    fpLabelEl = document.getElementById('cbl-fplabel');
    fpSubEl = document.getElementById('cbl-fpsub');
    retryBtn = document.getElementById('cbl-retry');
    backfpBtn = document.getElementById('cbl-backfp');
    for (var i = 0; i < PIN_LEN; i++) { var d = document.createElement('div'); d.className = 'cbl-dot'; dotsEl.appendChild(d); }

    padEl.addEventListener('click', function (e) {
      var k = e.target.closest('button'); if (!k) return;
      if (k.dataset.bk !== undefined) { buf = buf.slice(0, -1); paintDots(); return; }
      if (k.dataset.k === undefined) return;
      if (buf.length >= PIN_LEN) return;
      buf += k.dataset.k; paintDots();
      if (buf.length === PIN_LEN) setTimeout(tryPin, 120);
    });
    // «Ξέχασα τον κωδικό;» υπάρχει και στις δύο όψεις
    var fbs = ovEl.querySelectorAll('[data-forgot]');
    for (var j = 0; j < fbs.length; j++) fbs[j].addEventListener('click', function () { forgotPanel.classList.add('on'); });
    document.getElementById('cbl-fback').addEventListener('click', function () { forgotPanel.classList.remove('on'); });
    document.getElementById('cbl-goconn').addEventListener('click', function () { location.href = CONNECT_URL; });
    // εναλλαγή δαχτυλικό ↔ κωδικός
    document.getElementById('cbl-usepin').addEventListener('click', showPinView);
    backfpBtn.addEventListener('click', startFp);
    retryBtn.addEventListener('click', startFp);
  }

  function renderPad() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    var html = '';
    keys.forEach(function (n) { html += '<button type="button" class="cbl-key" data-k="' + n + '">' + n + '</button>'; });
    // κάτω σειρά: [κενό] [0] [⌫]  (το δαχτυλικό έχει δική του όψη πλέον)
    html += '<span class="cbl-key ph"></span>';
    html += '<button type="button" class="cbl-key" data-k="0">0</button>';
    html += '<button type="button" class="cbl-key bk" data-bk title="Σβήσιμο">⌫</button>';
    padEl.innerHTML = html;
  }

  function paintDots() {
    var ds = dotsEl.querySelectorAll('.cbl-dot');
    for (var i = 0; i < ds.length; i++) ds[i].classList.toggle('fill', i < buf.length);
  }
  function resetEntry() { buf = ''; paintDots(); errEl.textContent = ''; }
  function tryPin() {
    verifyPin(buf).then(function (ok) {
      if (ok) { pass(); }
      else {
        dotsEl.classList.add('cbl-shake');
        errEl.textContent = 'Λάθος κωδικός — δοκίμασε ξανά';
        setTimeout(function () { dotsEl.classList.remove('cbl-shake'); resetEntry(); }, 480);
      }
    });
  }
  function pass() {
    forgotPanel.classList.remove('on');
    ovEl.classList.remove('on');
    document.body.style.overflow = '';
    var cb = onPass; onPass = null; resetEntry();
    stampSeen();                          // ξεκλείδωσε τώρα → ξεκινά το περιθώριο από εδώ
    if (cb) try { cb(); } catch (e) {}
  }

  // ── εναλλαγή όψεων ─────────────────────────────────────────────────────────────
  function setFpc(state, glyph, label, sub) {
    fpcEl.className = 'cbl-fpc ' + state;
    fpGlyphEl.textContent = glyph; fpLabelEl.textContent = label; fpSubEl.textContent = sub;
  }
  // Δείξε την όψη δαχτυλικού σε «αναμονή» (χωρίς να καλέσει ακόμα το WebAuthn).
  function showFpView() {
    viewPin.classList.remove('on'); viewFp.classList.add('on');
    retryBtn.style.display = 'none';
    setFpc('wait', '👆', 'Σάρωσε το δαχτυλικό σου', 'Άγγιξε τον αισθητήρα του κινητού');
  }
  // Δείξε την όψη κωδικού· κουμπί «πίσω στο δαχτυλικό» μόνο αν το δαχτυλικό είναι ενεργό.
  function showPinView() {
    viewFp.classList.remove('on'); viewPin.classList.add('on');
    resetEntry();
    backfpBtn.style.display = (fpOn() && fpSupported()) ? 'block' : 'none';
  }

  // δαχτυλικό: όψη-αναμονής + κάλεσε το WebAuthn (το Android βγάζει το δικό του παράθυρο).
  // Το εφέ στο κέντρο δείχνει live το ΤΕΛΙΚΟ αποτέλεσμα (πέτυχε/απέτυχε) — όχι ανά άγγιγμα (όριο του Android).
  function startFp() {
    if (!(fpOn() && fpSupported())) { showPinView(); return; }
    showFpView();
    verifyFp().then(function () {
      setFpc('ok', '✓', 'Ξεκλείδωσε!', 'Καλώς ήρθες');
      setTimeout(pass, 600);
    }).catch(function () {
      // αποτυχία/άκυρο (ή ο χρήστης έκλεισε το παράθυρο του Android) → δείξε «ξαναδοκίμασε / κωδικός»
      setFpc('fail', '✗', 'Δεν αναγνωρίστηκε', 'Ξαναδοκίμασε ή πάτησε «Χρήση κωδικού»');
      retryBtn.style.display = 'block';
    });
  }

  // ── δημόσιο API ────────────────────────────────────────────────────────────────
  // Δείξε το κλείδωμα· τρέξε onUnlock όταν ξεκλειδώσει (ή αμέσως αν δεν είναι ενεργό).
  function guard(onUnlock) {
    if (!isEnabled()) { if (onUnlock) onUnlock(); return; }
    build();
    onPass = onUnlock || null;
    resetEntry(); renderPad();
    ovEl.classList.add('on');
    document.body.style.overflow = 'hidden';
    // Δαχτυλικό ενεργό → η όψη δαχτυλικού εμφανίζεται ΠΑΝΤΑ πρώτη + αυτόματο σκανάρισμα·
    // ο χρήστης μπορεί να πατήσει «Χρήση κωδικού». Αλλιώς → κατευθείαν ο κωδικός.
    if (fpOn() && fpSupported()) { showFpView(); setTimeout(startFp, 250); }
    else { showPinView(); }
  }
  function lockNow() { guard(null); }
  function isOpen() { return !!(ovEl && ovEl.classList.contains('on')); }
  // Κλείδωσε ΜΟΝΟ αν χρειάζεται (φρέσκο άνοιγμα ή πέρασε το περιθώριο)· αλλιώς απλώς «ενεργός τώρα».
  function lockIfNeeded() { if (shouldLock()) lockNow(); else if (isEnabled()) stampSeen(); }

  // Ξανακλείδωμα όταν επιστρέφεις στην εφαρμογή — ΜΟΝΟ αν έλειψες πάνω από το περιθώριο.
  function arm() {
    if (armed) return; armed = true;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { wasHidden = true; stampSeen(); }   // κατέγραψε πότε έφυγες
      else if (document.visibilityState === 'visible' && wasHidden) {
        wasHidden = false;
        if (shouldLock() && !isOpen()) lockNow();
      }
    });
    window.addEventListener('pagehide', function () { stampSeen(); });
    // bfcache / επαναφορά σελίδας
    window.addEventListener('pageshow', function (e) { if (e.persisted && shouldLock() && !isOpen()) lockNow(); });
  }

  window.CBLock = {
    isEnabled: isEnabled, hasPin: hasPin, fpOn: fpOn,
    setPin: setPin, verifyPin: verifyPin, clearPin: clearPin, clearFp: clearFp, clearAll: clearAll,
    getGrace: getGrace, setGrace: setGrace,
    fpSupported: fpSupported, fpPlatformAvailable: fpPlatformAvailable, registerFp: registerFp,
    guard: guard, lockNow: lockNow, lockIfNeeded: lockIfNeeded, arm: arm,
    hasCrypto: function () { return !!subtle; },
    // Κάρτα ρυθμίσεων (μία πηγή): mountSettings(el) → φτιάχνει & συνδέει το UI «Κλείδωμα εφαρμογής».
    mountSettings: mountSettings
  };

  // ── κάρτα ρυθμίσεων (χρησιμοποιείται από mobile_settings.html & connect.html) ────
  function mountSettings(el) {
    if (!el) return;
    injectCss();
    el.innerHTML =
      '<div class="m-card" style="background:#fff;border:1px solid #e6e8ec;border-radius:16px;padding:16px 15px;margin-bottom:16px">'
      + '<div class="m-card-h" style="font-weight:800;font-size:15px;margin-bottom:12px;display:flex;align-items:center;gap:8px">🔒 Κλείδωμα εφαρμογής</div>'
      + '<div class="m-note">Όταν είναι ενεργό, η εφαρμογή ζητάει κωδικό (ή δαχτυλικό) <b>κάθε φορά</b> που την ανοίγεις — και ξανακλειδώνει όταν την αφήνεις στην άκρη.</div>'
      + '<div id="cbl-set-pinrow"></div>'
      + '<div id="cbl-set-pinbox" style="display:none"></div>'
      + '<div id="cbl-set-gracerow"></div>'
      + '<div id="cbl-set-fprow" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 0;border-top:1px solid #e6e8ec;margin-top:6px"></div>'
      + '<div id="cbl-set-msg" class="m-note" style="display:none;margin-top:10px"></div>'
      + '</div>';
    var msg = el.querySelector('#cbl-set-msg');
    function note(t, ok) { msg.style.display = 'block'; msg.innerHTML = t; msg.style.color = ok ? '#166534' : '#b45309'; }
    function noteClear() { msg.style.display = 'none'; }

    function renderPinRow() {
      var row = el.querySelector('#cbl-set-pinrow');
      row.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 0">'
        + '<div><div style="font-weight:700;font-size:14px">Κωδικός PIN (6 ψηφία)</div>'
        + '<div style="font-size:12px;color:#6b7280;margin-top:2px">' + (hasPin() ? '✓ Έχει οριστεί' : 'Δεν έχει οριστεί ακόμα') + '</div></div>'
        + '<button type="button" class="btn-secondary" id="cbl-pinbtn" style="width:auto;padding:10px 14px">' + (hasPin() ? 'Αλλαγή' : 'Ορισμός') + '</button>'
        + '</div>'
        + (hasPin() ? '<button type="button" class="btn-danger" id="cbl-pinoff" style="width:100%;margin-top:4px">Κατάργηση κλειδώματος</button>' : '');
      el.querySelector('#cbl-pinbtn').addEventListener('click', togglePinBox);
      var off = el.querySelector('#cbl-pinoff');
      if (off) off.addEventListener('click', removePin);
    }
    function togglePinBox() {
      var box = el.querySelector('#cbl-set-pinbox');
      if (box.style.display !== 'none') { box.style.display = 'none'; return; }
      noteClear();
      box.style.display = 'block';
      box.innerHTML =
        (hasPin() ? '<div class="m-fld"><label>Τωρινός κωδικός</label><input id="cbl-cur" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center"></div>' : '')
        + '<div class="m-fld"><label>Νέος 6ψήφιος κωδικός</label><input id="cbl-n1" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center"></div>'
        + '<div class="m-fld"><label>Ξανά ο νέος κωδικός</label><input id="cbl-n2" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center"></div>'
        + '<button type="button" class="btn-primary" id="cbl-pinsave" style="width:100%">Αποθήκευση κωδικού</button>';
      el.querySelector('#cbl-pinsave').addEventListener('click', savePin);
    }
    function savePin() {
      if (!subtle) { note('⚠️ Αυτό το κινητό δεν υποστηρίζει κρυπτογράφηση (χρειάζεται ασφαλής σύνδεση https).'); return; }
      var n1 = (el.querySelector('#cbl-n1').value || '').trim(), n2 = (el.querySelector('#cbl-n2').value || '').trim();
      if (!/^\d{6}$/.test(n1)) { note('Ο κωδικός πρέπει να είναι ακριβώς 6 ψηφία.'); return; }
      if (n1 !== n2) { note('Οι δύο κωδικοί δεν ταιριάζουν.'); return; }
      var check = hasPin() ? verifyPin((el.querySelector('#cbl-cur').value || '').trim()) : Promise.resolve(true);
      check.then(function (ok) {
        if (!ok) { note('Ο τωρινός κωδικός είναι λάθος.'); return; }
        setPin(n1).then(function () {
          el.querySelector('#cbl-set-pinbox').style.display = 'none';
          renderPinRow(); renderGraceRow(); renderFpRow();
          note('✓ Ο κωδικός αποθηκεύτηκε. Το κλείδωμα είναι ενεργό.', true);
        });
      });
    }
    function removePin() {
      window.showConfirm('Κατάργηση του κλειδώματος; Η εφαρμογή δεν θα ζητάει πια κωδικό.', function () {
        var box = el.querySelector('#cbl-set-pinbox');
        box.style.display = 'block';
        box.innerHTML = '<div class="m-fld"><label>Επιβεβαίωσε τον τωρινό κωδικό για κατάργηση</label>'
          + '<input id="cbl-rmcur" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center"></div>'
          + '<button type="button" class="btn-danger" id="cbl-rmgo" style="width:100%">Κατάργηση κλειδώματος</button>';
        el.querySelector('#cbl-rmgo').addEventListener('click', function () {
          verifyPin((el.querySelector('#cbl-rmcur').value || '').trim()).then(function (ok) {
            if (!ok) { note('Λάθος κωδικός — δεν έγινε κατάργηση.'); return; }
            clearAll(); box.style.display = 'none'; renderPinRow(); renderGraceRow(); renderFpRow();
            note('Το κλείδωμα καταργήθηκε.', true);
          });
        });
      }, null, { title: 'Κατάργηση κλειδώματος', yesLabel: 'Συνέχεια' });
    }

    function renderGraceRow() {
      var row = el.querySelector('#cbl-set-gracerow');
      if (!hasPin()) { row.innerHTML = ''; return; }       // χωρίς PIN δεν έχει νόημα
      var g = getGrace();
      var opts = [[0, 'Άμεσα (κάθε φορά)'], [1, 'Μετά από 1 λεπτό'], [2, 'Μετά από 2 λεπτά'], [5, 'Μετά από 5 λεπτά'], [15, 'Μετά από 15 λεπτά']];
      var sel = '';
      opts.forEach(function (o) { sel += '<option value="' + o[0] + '"' + (o[0] === g ? ' selected' : '') + '>' + o[1] + '</option>'; });
      row.innerHTML =
        '<div style="padding:13px 0;border-top:1px solid #e6e8ec">'
        + '<div style="font-weight:700;font-size:14px">Να ξαναζητάει κωδικό</div>'
        + '<div style="font-size:12px;color:#6b7280;margin:2px 0 8px">Όταν φεύγεις από την εφαρμογή και γυρνάς — γρήγορη εναλλαγή δεν σε ενοχλεί.</div>'
        + '<select id="cbl-grace" style="width:100%;padding:12px;border:1px solid #e6e8ec;border-radius:12px;font:inherit;background:#fff">' + sel + '</select></div>';
      var s = el.querySelector('#cbl-grace');
      if (s) s.addEventListener('change', function () { setGrace(s.value); note('✓ Αποθηκεύτηκε.', true); });
    }

    function renderFpRow() {
      var row = el.querySelector('#cbl-set-fprow');
      fpPlatformAvailable().then(function (avail) {
        var canUse = hasPin() && fpSupported() && avail;
        var sub;
        if (!fpSupported() || !avail) sub = 'Δεν είναι διαθέσιμο σε αυτό το κινητό/σύνδεση';
        else if (!hasPin()) sub = 'Χρειάζεται πρώτα κωδικό PIN';
        else sub = fpOn() ? '✓ Ενεργό' : 'Διαθέσιμο — άνοιξέ το αν θες';
        row.innerHTML =
          '<div><div style="font-weight:700;font-size:14px">Άνοιγμα με δαχτυλικό 👆</div>'
          + '<div style="font-size:12px;color:#6b7280;margin-top:2px">' + sub + '</div></div>'
          + '<label class="cbl-sw" style="position:relative;width:52px;height:30px;flex:0 0 auto;cursor:pointer;' + (canUse ? '' : 'opacity:.4;pointer-events:none') + '">'
          + '<input type="checkbox" id="cbl-fpchk" style="display:none"' + (fpOn() ? ' checked' : '') + '>'
          + '<span style="position:absolute;inset:0;background:' + (fpOn() ? '#2e9e5b' : '#cfd3da') + ';border-radius:999px;transition:.2s" id="cbl-fptrack"></span>'
          + '<span style="position:absolute;top:3px;left:' + (fpOn() ? '25px' : '3px') + ';width:24px;height:24px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2)" id="cbl-fpknob"></span>'
          + '</label>';
        var chk = el.querySelector('#cbl-fpchk');
        if (chk) chk.addEventListener('change', function () {
          if (chk.checked) {
            registerFp().then(function () { note('✓ Το δαχτυλικό ενεργοποιήθηκε.', true); renderFpRow(); })
              .catch(function (err) {
                var m = (err && err.message) || '';
                note(m === 'need_pin' ? 'Όρισε πρώτα κωδικό PIN.' : 'Δεν ολοκληρώθηκε η ενεργοποίηση του δαχτυλικού.');
                renderFpRow();
              });
          } else {
            clearFp(); note('Το δαχτυλικό απενεργοποιήθηκε.', true); renderFpRow();
          }
        });
      });
    }

    renderPinRow(); renderGraceRow(); renderFpRow();
  }
})();
