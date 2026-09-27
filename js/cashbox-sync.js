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
  // true/false: αν ο browser μπλοκάρει την αποθήκευση, η σύνδεση δεν έγινε — ο καλών
  // πρέπει να το πει, όχι να δείξει «✅ συνδέθηκε» για κάτι που δεν γράφτηκε.
  function setCreds(c) {
    try { localStorage.setItem(LS_CREDS, JSON.stringify({ repo: c.repo, token: c.token, key: c.key })); return true; }
    catch (e) { return false; }
  }
  function clearCreds() { try { localStorage.removeItem(LS_CREDS); return true; } catch (e) { return false; } }
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
  // `creds` προαιρετικό: η σύνδεση (pair) δοκιμάζει ΝΕΑ κλειδιά ΠΡΙΝ τα αποθηκεύσει.
  function gh(method, path, body, creds) {
    var c = creds || getCreds();
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
  function pullState(creds) {
    var c = creds || getCreds();
    if (!c) return Promise.resolve(null);
    return gh('GET', 'state.enc', null, c).then(function (g) {
      // ΛΚ2 — Ο έλεγχος ταυτότητας ΠΡΩΤΑ. Το σώμα ενός 401 της GitHub είναι
      // `{"message":"Bad credentials"}` — δεν έχει `content`, οπότε ο παλιός έλεγχος
      // «δεν έχει content» επέστρεφε `null` μία γραμμή νωρίτερα και ο κλάδος από κάτω
      // ήταν ΑΠΡΟΣΙΤΟΣ: «ληγμένο κλειδί» και «δεν έχει γραφτεί κατάσταση ακόμη»
      // κατέληγαν στην ίδια, σιωπηλή απάντηση.
      if (g.status === 401 || g.status === 403) throw new Error('auth');
      if (g.status === 404 || !g.json || !g.json.content) return null;
      var encAscii = atob(String(g.json.content).replace(/\s/g, ''));
      return fernetDecrypt(c.key, encAscii).then(function (txt) { return JSON.parse(txt); });
    });
  }

  // Πλήρης έλεγχος των κλειδιών: round-trip κρυπτογράφησης + πρόσβαση στο repo
  // (χτυπά το repo metadata → καθαρή διάκριση auth / repo_not_found / offline).
  function testConnection(creds) {
    var c = creds || getCreds();
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

  /* 🔐 ΛΩ19 — Η ΜΙΑ πόρτα σύνδεσης κινητού (QR / σύνδεσμος #cb= / επικόλληση / χειροκίνητα).
     Πριν, ΚΑΘΕ σύνδεσμος #cb=… γραφόταν αμέσως ως νέα θυρίδα ΚΑΙ έσβηνε το κλείδωμα (PIN)
     — ένας πλαστός σύνδεσμος αρκούσε για να ανοίξει το ταμείο και να στέλνει τις κινήσεις
     αλλού. Τώρα τα νέα κλειδιά γίνονται δεκτά (και το κλείδωμα μηδενίζεται) ΜΟΝΟ όταν:
       1. η θυρίδα απαντά με αυτά (testConnection με τα ΝΕΑ κλειδιά),
       2. το state.enc του υπολογιστή ΑΝΟΙΓΕΙ με το ΝΕΟ κλειδί (αποκρυπτογράφηση + σχήμα),
       3. αν υπάρχουν ήδη ΑΛΛΑ κλειδιά, ο άνθρωπος το επιβεβαιώνει στην οθόνη,
       4. αν είναι ΑΛΛΗ θυρίδα και υπάρχει κλείδωμα (PIN), δίνεται ο ΤΩΡΙΝΟΣ κωδικός (Q2).
     «Ίδια θυρίδα» = ίδιο repo + ίδιο κλειδί κρυπτογράφησης (το token μπορεί να αλλάξει).
     Συγκρίνεται με τα τωρινά κλειδιά ΚΑΙ με το «σπίτι» (cb_sync_home: repo + hash κλειδιού)
     που κρατιέται και μετά την «Αποσύνδεση» — αλλιώς «αποσύνδεση → ξένη θυρίδα» θα
     παρέκαμπτε τον κωδικό. Ίδια θυρίδα = ο μόνος δρόμος για «ξέχασα τον κωδικό» (μηδενισμός).
     Κάθε σελίδα σύνδεσης καλεί ΑΥΤΟ — καμία δεν κάνει δικό της setCreds/clearAll.
     Επιστρέφει Promise<{ok:true, state} | {ok:false, reason}>. */
  var LS_HOME = 'cb_sync_home';
  function sha256hex(str) {
    return subtle.digest('SHA-256', new TextEncoder().encode(String(str))).then(function (buf) {
      var a = new Uint8Array(buf), h = ''; for (var i = 0; i < a.length; i++) h += (a[i] < 16 ? '0' : '') + a[i].toString(16); return h;
    });
  }
  function getHome() {
    try { var v = JSON.parse(localStorage.getItem(LS_HOME)); return (v && v.repo && v.kh) ? v : null; }
    catch (e) { return null; }
  }
  function setHome(c) {
    return sha256hex(c.key).then(function (kh) {
      try { localStorage.setItem(LS_HOME, JSON.stringify({ repo: c.repo, kh: kh })); } catch (e) {}
    });
  }
  function sameMailbox(a, b) { return !!(a && b && a.repo === b.repo && a.key === b.key); }
  // Promise<bool>: είναι η θυρίδα που είχε ήδη αυτό το κινητό (τωρινή ή η τελευταία πριν την αποσύνδεση);
  function isHomeMailbox(c) {
    if (sameMailbox(getCreds(), c)) return Promise.resolve(true);
    var home = getHome();
    if (!home || home.repo !== c.repo) return Promise.resolve(false);
    return sha256hex(c.key).then(function (kh) { return kh === home.kh; });
  }
  // Υπάρχει κλείδωμα; Αν λείπει το CBLock αλλά υπάρχει αποθηκευμένο PIN → «ναι» (ποτέ παράκαμψη).
  function pinIsSet() {
    var L = window.CBLock;
    if (L && typeof L.hasPin === 'function') return !!L.hasPin();
    try { return !!localStorage.getItem('cb_lock_pin'); } catch (e) { return false; }
  }
  function askCurrentPin() {
    var L = window.CBLock;
    if (!L || typeof L.askPin !== 'function') return Promise.resolve(false);
    return L.askPin({ title: 'Αλλαγή θυρίδας', sub: 'Βάλε τον τωρινό 6ψήφιο κωδικό' })
      .then(function (ok) { return !!ok; }, function () { return false; });
  }
  function askReplace(oldC, newC, needPin) {
    return new Promise(function (resolve) {
      if (typeof window.showConfirm !== 'function') { resolve(false); return; }
      window.showConfirm('Αυτό το κινητό είναι ήδη συνδεδεμένο με τη θυρίδα «' + oldC.repo + '».\n\n'
        + 'Να αντικατασταθεί με «' + newC.repo + '»;'
        + (needPin ? ' Θα χρειαστεί ο τωρινός κωδικός (PIN).' : '') + '\n\n'
        + 'Αν δεν σκάναρες εσύ τώρα το QR του υπολογιστή σου, πάτα «Ακύρωση».',
        function () { resolve(true); }, function () { resolve(false); },
        { title: '⚠️ Αλλαγή σύνδεσης κινητού', yesLabel: 'Αντικατάσταση' });
    });
  }
  function pair(creds) {
    if (!creds || !creds.repo || !creds.token || !creds.key) return Promise.resolve({ ok: false, reason: 'invalid' });
    if (!subtle) return Promise.resolve({ ok: false, reason: 'no_crypto' });
    var c = { repo: String(creds.repo), token: String(creds.token), key: String(creds.key) };
    return testConnection(c).then(function (t) {
      if (!t.ok) return { ok: false, reason: t.reason };
      return pullState(c).then(function (st) {
        // το κλειδί ΠΡΕΠΕΙ να ανοίγει την κατάσταση του υπολογιστή — όχι απλώς «ένα κλειδί»
        if (!st) return { ok: false, reason: 'no_state' };
        if (typeof st !== 'object' || !Array.isArray(st.synced_uids)) return { ok: false, reason: 'bad_state' };
        var old = getCreds();
        return isHomeMailbox(c).then(function (home) {
          var needPin = !home && pinIsSet();
          var gate = (old && !sameMailbox(old, c)) ? askReplace(old, c, needPin) : Promise.resolve(true);
          return gate.then(function (yes) {
            if (!yes) return { ok: false, reason: 'cancelled' };
            return (needPin ? askCurrentPin() : Promise.resolve(true)).then(function (pinOk) {
              if (!pinOk) return { ok: false, reason: 'pin_needed' };
              if (!setCreds(c)) return { ok: false, reason: 'storage_blocked' };
              return setHome(c).then(function () {
                // Ίδια θυρίδα (ή κινητό χωρίς κλείδωμα) = μηδενισμός κλειδώματος — ο δρόμος του
                // «ξέχασα τον κωδικό». Άλλη θυρίδα με ΣΩΣΤΟ κωδικό → το κλείδωμα μένει όπως ήταν.
                if (!needPin && window.CBLock && typeof window.CBLock.clearAll === 'function') window.CBLock.clearAll();
                return { ok: true, state: st };
              });
            });
          });
        });
      }, function (e) {
        return { ok: false, reason: (e && e.message === 'auth') ? 'auth' : 'bad_key' };
      });
    });
  }
  // Το μήνυμα κάθε αιτίας, ΜΙΑ φορά (οι σελίδες δεν κρατούν δικό τους αντίγραφο).
  var PAIR_MSG = {
    invalid: 'Ο κωδικός δεν είναι έγκυρος. Έλεγξε ότι αντιγράφηκε ολόκληρος.',
    no_crypto: 'Αυτό το κινητό δεν υποστηρίζει κρυπτογράφηση (χρειάζεται ασφαλής σύνδεση https).',
    not_configured: 'Λείπουν κλειδιά.',
    bad_key: 'Το κλειδί δεν ανοίγει τα δεδομένα του υπολογιστή σου — η σύνδεση δεν έγινε.',
    auth: 'Το token είναι λάθος ή χωρίς δικαίωμα «Contents» — η σύνδεση δεν έγινε.',
    repo_not_found: 'Δεν βρέθηκε η θυρίδα — η σύνδεση δεν έγινε.',
    offline: 'Χωρίς σύνδεση στο internet αυτή τη στιγμή — η σύνδεση δεν έγινε. Ξαναδοκίμασε με internet.',
    no_state: 'Ο υπολογιστής δεν έχει στείλει ακόμα την κατάσταση του ταμείου στη θυρίδα.\n\nΣτον υπολογιστή πάτα «🔄 Έλεγχος τώρα» στο Ταμείο και ξανασκάναρε.',
    bad_state: 'Η θυρίδα δεν περιέχει δεδομένα ταμείου — η σύνδεση δεν έγινε.',
    cancelled: 'Η σύνδεση ακυρώθηκε — το κινητό έμεινε όπως ήταν.',
    pin_needed: 'Για σύνδεση με άλλη θυρίδα χρειάζεται ο τωρινός κωδικός (PIN) — το κινητό έμεινε όπως ήταν.\n\n'
      + 'Ξέχασες τον κωδικό; Σκάναρε το QR του δικού σου υπολογιστή (Ρυθμίσεις → 📮 Συγχρονισμός κινητού): '
      + 'η ίδια θυρίδα μηδενίζει το κλείδωμα χωρίς κωδικό.',
    storage_blocked: 'Το πρόγραμμα περιήγησης δεν επιτρέπει αποθήκευση σε αυτό το κινητό, οπότε η σύνδεση δεν ολοκληρώθηκε.\n\nΆνοιξε τη σελίδα σε κανονικό παράθυρο (όχι ανώνυμη περιήγηση) και ξαναπροσπάθησε.'
  };
  function pairMessage(reason) { return PAIR_MSG[reason] || ('Η σύνδεση δεν έγινε (' + reason + ').'); }

  window.CBSync = {
    // ❌ ΛΩ19 — ΚΑΝΕΝΑ δημόσιο setCreds: νέα κλειδιά μπαίνουν ΜΟΝΟ μέσα από το `pair`.
    getCreds: getCreds, clearCreds: clearCreds, configured: configured,
    parsePayload: parsePayload, pushOps: pushOps, pullState: pullState,
    testConnection: testConnection, hasCrypto: function () { return !!subtle; },
    pair: pair, pairMessage: pairMessage
  };
})();
