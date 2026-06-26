/* 📮 Ταμείο — πελάτης «θυρίδας» (§13 Φάση 2, #4)
   Όταν ο υπολογιστής είναι ΚΛΕΙΣΤΟΣ, το κινητό μιλάει ΚΑΤΕΥΘΕΙΑΝ στη θυρίδα GitHub:
     • ανεβάζει κάθε κίνηση ως ops/<uid>.enc  (κινητό ➜ υπολογιστής)
     • κατεβάζει το state.enc                 (υπολογιστής ➜ κινητό)
   Όλα κρυπτογραφημένα με Fernet — byte-compatible με την Python (cryptography).
   Τα κλειδιά (repo/token/κλειδί) ζουν ΜΟΝΟ στο κινητό (localStorage). Εκτίθεται ως window.CBSync. */
(function () {
  'use strict';
  var LS_CREDS = 'cb_sync';
  var subtle = (window.crypto && window.crypto.subtle) || null;

  // ── base64 / bytes ──────────────────────────────────────────────────────────
  function b64urlToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_'); // κράτα το padding '=' (το θέλει η Python)
  }
  function b64urlNoPadToString(s) {       // payload base64url (χωρίς padding) → utf-8 string
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function concat() {
    var n = 0, i; for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }

  // ── Fernet (AES-128-CBC + HMAC-SHA256) — ίδιο πρωτόκολλο με την Python ────────
  function fernetEncrypt(keyB64url, plaintext) {
    var key = b64urlToBytes(keyB64url);
    if (key.length !== 32) return Promise.reject(new Error('bad key'));
    var signingKey = key.slice(0, 16), encKey = key.slice(16, 32);
    var iv = new Uint8Array(16); window.crypto.getRandomValues(iv);
    var pt = new TextEncoder().encode(plaintext);
    return subtle.importKey('raw', encKey, { name: 'AES-CBC' }, false, ['encrypt'])
      .then(function (aes) { return subtle.encrypt({ name: 'AES-CBC', iv: iv }, aes, pt); })
      .then(function (ctBuf) {
        var ct = new Uint8Array(ctBuf);
        var tsB = new Uint8Array(8), ts = Math.floor(Date.now() / 1000);
        for (var i = 7; i >= 0; i--) { tsB[i] = ts & 0xff; ts = Math.floor(ts / 256); }
        var parts = concat(new Uint8Array([0x80]), tsB, iv, ct);
        return subtle.importKey('raw', signingKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
          .then(function (hk) { return subtle.sign('HMAC', hk, parts); })
          .then(function (sig) { return bytesToB64url(concat(parts, new Uint8Array(sig))); });
      });
  }
  function fernetDecrypt(keyB64url, token) {
    var key = b64urlToBytes(keyB64url);
    if (key.length !== 32) return Promise.reject(new Error('bad key'));
    var signingKey = key.slice(0, 16), encKey = key.slice(16, 32);
    var data = b64urlToBytes(token);
    if (data.length < 57 || data[0] !== 0x80) return Promise.reject(new Error('bad token'));
    var sig = data.slice(data.length - 32), parts = data.slice(0, data.length - 32);
    return subtle.importKey('raw', signingKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
      .then(function (hk) { return subtle.verify('HMAC', hk, sig, parts); })
      .then(function (ok) {
        if (!ok) throw new Error('bad signature');
        var iv = parts.slice(9, 25), ct = parts.slice(25);
        return subtle.importKey('raw', encKey, { name: 'AES-CBC' }, false, ['decrypt'])
          .then(function (aes) { return subtle.decrypt({ name: 'AES-CBC', iv: iv }, aes, ct); })
          .then(function (buf) { return new TextDecoder().decode(buf); });
      });
  }

  // ── credentials (localStorage) ───────────────────────────────────────────────
  function getCreds() {
    try { var v = JSON.parse(localStorage.getItem(LS_CREDS)); return (v && v.repo && v.token && v.key) ? v : null; }
    catch (e) { return null; }
  }
  function setCreds(c) { localStorage.setItem(LS_CREDS, JSON.stringify({ repo: c.repo, token: c.token, key: c.key })); }
  function clearCreds() { localStorage.removeItem(LS_CREDS); }
  function configured() { return !!getCreds() && !!subtle; }

  // Δέξου: «TS1.<base64url>», ή ολόκληρο URL που περιέχει cb=<payload> (#cb= ή ?cb=),
  // ή 3 χωριστά πεδία. Επιστρέφει {repo,token,key} ή null.
  function parsePayload(str) {
    str = (str == null ? '' : String(str)).trim();
    if (!str) return null;
    var m = str.match(/[#?&]cb=([^&\s]+)/);   // μέσα σε URL
    var token = m ? decodeURIComponent(m[1]) : str;
    var idx = token.indexOf('TS1.');
    if (idx >= 0) token = token.slice(idx + 4);
    try {
      var obj = JSON.parse(b64urlNoPadToString(token));
      if (obj && obj.r && obj.t && obj.k) return { repo: obj.r, token: obj.t, key: obj.k };
    } catch (e) {}
    return null;
  }

  // ── GitHub Contents API (από browser, fetch) ─────────────────────────────────
  function gh(method, path, body) {
    var c = getCreds();
    if (!c) return Promise.reject(new Error('not configured'));
    var url = 'https://api.github.com/repos/' + c.repo + '/contents/' + String(path).replace(/^\//, '');
    var opts = {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + c.token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return (r.status === 204 ? Promise.resolve(null) : r.json().catch(function () { return null; }))
        .then(function (j) { return { status: r.status, json: j }; });
    });
  }

  // Ανεβάζει ένα κρυπτογραφημένο γράμμα ops/<uid>.enc. Idempotent (αν υπάρχει → sha).
  function putOp(uid, encAscii) {
    var path = 'ops/' + uid + '.enc';
    var content = btoa(encAscii); // τα bytes του αρχείου = ascii του Fernet token
    return gh('GET', path).then(function (g) {
      var body = { message: 'cashbox op ' + uid, content: content };
      if (g.status === 200 && g.json && g.json.sha) body.sha = g.json.sha;
      return gh('PUT', path, body);
    });
  }

  // Στέλνει ουρά ops → επιστρέφει λίστα uid που ανέβηκαν (200/201). Σταματά σε auth error.
  function pushOps(ops) {
    var c = getCreds();
    if (!c || !ops || !ops.length) return Promise.resolve({ uploaded: [], error: ops && ops.length ? 'not_configured' : null });
    var uploaded = [], err = null;
    var chain = Promise.resolve();
    ops.forEach(function (op) {
      chain = chain.then(function () {
        if (err) return;
        return fernetEncrypt(c.key, JSON.stringify(op))
          .then(function (enc) { return putOp(op.uid, enc); })
          .then(function (res) {
            if (res.status === 200 || res.status === 201) uploaded.push(op.uid);
            else if (res.status === 401 || res.status === 403) err = 'auth';
            else if (res.status === 404) err = 'repo_not_found';
            else err = 'http_' + res.status;
          })
          .catch(function () { err = 'offline'; });
      });
    });
    return chain.then(function () { return { uploaded: uploaded, error: err }; });
  }

  // Κατεβάζει & αποκρυπτογραφεί το state.enc → αντικείμενο κατάστασης ή null.
  function pullState() {
    var c = getCreds();
    if (!c) return Promise.resolve(null);
    return gh('GET', 'state.enc').then(function (g) {
      if (g.status === 404 || !g.json || !g.json.content) return null;
      if (g.status === 401 || g.status === 403) throw new Error('auth');
      var encAscii = atob(String(g.json.content).replace(/\s/g, ''));
      return fernetDecrypt(c.key, encAscii).then(function (txt) { return JSON.parse(txt); });
    });
  }

  // Πλήρης έλεγχος των κλειδιών: round-trip κρυπτογράφησης + πρόσβαση στο repo
  // (χτυπά το repo metadata → καθαρή διάκριση auth / repo_not_found / offline).
  function testConnection() {
    var c = getCreds();
    if (!c) return Promise.resolve({ ok: false, reason: 'not_configured' });
    if (!subtle) return Promise.resolve({ ok: false, reason: 'no_crypto' });
    var secret = 'selftest-κινητό-✓';
    return fernetEncrypt(c.key, secret)
      .then(function (enc) { return fernetDecrypt(c.key, enc); })
      .then(function (dec) {
        if (dec !== secret) return { ok: false, reason: 'bad_key' };
        return fetch('https://api.github.com/repos/' + c.repo, {
          headers: {
            'Authorization': 'Bearer ' + c.token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }).then(function (r) {
          if (r.status === 200) return { ok: true, reason: 'ok' };
          if (r.status === 401 || r.status === 403) return { ok: false, reason: 'auth' };
          if (r.status === 404) return { ok: false, reason: 'repo_not_found' };
          return { ok: false, reason: 'http_' + r.status };
        });
      })
      .catch(function () { return { ok: false, reason: 'offline' }; });
  }

  window.CBSync = {
    getCreds: getCreds, setCreds: setCreds, clearCreds: clearCreds, configured: configured,
    parsePayload: parsePayload, pushOps: pushOps, pullState: pullState,
    testConnection: testConnection, hasCrypto: function () { return !!subtle; }
  };
})();
