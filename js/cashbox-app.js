/* 👜 Ταμείο — εφαρμογή κινητού (Βήμα 2: offline-first)
   - Κρατάει το δικό της αντίγραφο (localStorage) → δουλεύει ΧΩΡΙΣ internet.
   - Κάθε ενέργεια: εφαρμόζεται τοπικά ΑΜΕΣΩΣ + μπαίνει σε «ουρά» + συγχρονίζεται όταν βρει δίκτυο.
   - Idempotent: κάθε ενέργεια έχει μοναδικό uid → ο server δεν τη διπλομετράει. */
(function () {
  'use strict';
  // Ρυθμίσεις «φιλοξενίας»: η ΙΔΙΑ εφαρμογή τρέχει (α) από τον τοπικό server και
  // (β) από το GitHub Pages (στατικά, https). Όταν τρέχει στο Pages, ο τοπικός
  // server δεν υπάρχει → CFG.noLocal=true → πάμε κατευθείαν στη θυρίδα. Χωρίς
  // CB_CONFIG, οι προεπιλογές = ακριβώς η παλιά συμπεριφορά (τοπικός server).
  var CFG = window.CB_CONFIG || {};
  var BASE = (CFG.apiBase != null) ? CFG.apiBase : '/cashbox';
  var API_STATE = BASE + '/api/state', API_OPS = BASE + '/api/ops';
  var SW_PATH = CFG.swPath || '/cashbox/sw.js', SW_SCOPE = CFG.swScope || '/cashbox';
  var LS_STATE = 'cb_state', LS_QUEUE = 'cb_queue', LS_LASTSYNC = 'cb_last_sync';

  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function emptyState() { return { balance: 0, settings: {}, week: { rows: [], totals: {} }, picker: { days: [], default: '' }, categories: [], recent: [], closed_days: [], stats: {} }; }

  var state = load(LS_STATE, null);
  var queue = load(LS_QUEUE, []);
  if (!state) {
    try { state = JSON.parse(document.getElementById('cb-initial').textContent); } catch (e) { state = emptyState(); }
    save(LS_STATE, state);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  var uidc = 0;
  function uid() { return 'op' + Date.now() + '_' + (uidc++) + '_' + Math.floor(Math.random() * 1e6); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtDate(iso) { if (!iso) return ''; var p = String(iso).split('-'); return p.length === 3 ? (p[2] + '-' + p[1] + '-' + p[0]) : iso; }
  function euro(n) {
    n = round2(n); var neg = n < 0; n = Math.abs(n);
    var s = n.toFixed(2).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '−' : '') + s[0] + ',' + s[1] + ' €';
  }
  function parseAmt(s) {
    s = (s == null ? '' : String(s)).trim().replace('€', '').replace(/\s/g, '');
    if (!s) return 0;
    if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(',', '.');
    var n = parseFloat(s); return isNaN(n) ? 0 : round2(n);
  }
  function byId(id) { return document.getElementById(id); }

  // ── rendering ─────────────────────────────────────────────────────────────────
  // Το υπόλοιπο φαίνεται ΜΟΝΟ όσο κρατάς πατημένο (peek) — αλλιώς κρυμμένο.
  var peeking = false;
  function renderBalance() {
    var bal = byId('m-bal'); if (!bal) return;
    bal.dataset.real = euro(state.balance);
    bal.textContent = peeking ? bal.dataset.real : '••••• €';
  }
  // Κατάσταση μιας κίνησης: ✓ έφτασε στον υπολογιστή / 📮 στη θυρίδα / ⏳ αναμονή.
  // Προσωρινό id (tmp_…) = δεν έχει φτάσει ακόμα· πραγματικό (αριθμός) = έφτασε.
  function itemState(e) {
    var pending = (typeof e.id === 'string' && e.id.indexOf('tmp_') === 0);
    if (!pending) return { cls: 'ok', txt: '✓ έφτασε' };
    if (navigator.onLine && window.CBSync && CBSync.configured()) return { cls: 'box', txt: '📮 στη θυρίδα' };
    return { cls: 'wait', txt: '⏳ αναμονή' };
  }
  function buildRow(e) {
    var emo = e.withdrawal ? '💸' : (e.category_icon || '🧾');
    var title = e.withdrawal ? 'Πήρα μετρητά' : (e.category_name || 'Έξοδο');
    var biz = e.is_business ? '🟢' : '⚪';
    var sub = e.withdrawal ? ('γενική ανάληψη · ' + fmtDate(e.entry_date)) : ('από ταμείο ' + fmtDate(e.source_day || e.entry_date));
    if (e.description) sub += ' · ' + e.description;
    var sign = e.direction === 'in' ? '+' : '−';
    var ss = itemState(e);
    var div = document.createElement('div'); div.className = 'm-it';
    div.innerHTML = '<span class="emo">' + emo + '</span>'
      + '<div class="tx"><div class="t1">' + esc(title) + ' <span class="bz">' + biz + '</span></div>'
      + '<div class="t2">' + esc(sub) + '</div></div>'
      + '<div class="meta"><div class="amt' + (e.direction === 'in' ? ' inn' : '') + '">' + sign + euro(e.amount) + '</div>'
      + '<span class="st ' + ss.cls + '">' + ss.txt + '</span></div>'
      + '<div class="acts"><button type="button" class="m-edit">✏️</button><button type="button" class="m-del">🗑</button></div>';
    div.querySelector('.m-edit').addEventListener('click', function () { openEdit(e); });
    div.querySelector('.m-del').addEventListener('click', function () { delEntry(e); });
    return div;
  }
  var histOpen = false;
  function renderFeed() {
    var feed = byId('m-feed'), empty = byId('m-empty'), foot = byId('m-foot');
    var moreBtn = byId('m-more'), hist = byId('m-hist'), histFeed = byId('m-hist-feed');
    feed.innerHTML = '';
    var rec = state.recent || [];
    if (!rec.length) {
      empty.style.display = 'block'; foot.style.display = 'none'; feed.style.display = 'none';
      if (moreBtn) moreBtn.style.display = 'none';
      if (hist) hist.classList.remove('show');
      return;
    }
    empty.style.display = 'none'; foot.style.display = 'block'; feed.style.display = 'block';
    var limit = (state.settings && state.settings.mobile_recent) || 5;
    var head = rec.slice(0, limit), tail = rec.slice(limit);
    head.forEach(function (e) { feed.appendChild(buildRow(e)); });
    if (histFeed) { histFeed.innerHTML = ''; tail.forEach(function (e) { histFeed.appendChild(buildRow(e)); }); }
    if (moreBtn) {
      if (tail.length) {
        moreBtn.style.display = 'flex';
        moreBtn.classList.toggle('open', histOpen);
        var t = moreBtn.querySelector('.m-more-t');
        if (t) t.textContent = histOpen ? 'Λιγότερες' : ('Δες περισσότερες (' + tail.length + ')');
      } else {
        moreBtn.style.display = 'none'; histOpen = false;
      }
    }
    if (hist) hist.classList.toggle('show', histOpen && tail.length > 0);
  }
  function fillDayOptions(sel) {
    sel.innerHTML = '';
    (state.picker.days || []).forEach(function (d) {
      if (d.future || d.closed) return;
      var o = document.createElement('option'); o.value = d.iso; o.textContent = d.label;
      if (d.iso === state.picker.default) o.selected = true;
      sel.appendChild(o);
    });
  }
  function renderSelects() {
    fillDayOptions(byId('pay-day'));
    fillDayOptions(byId('edit-day'));
    var pc = byId('pay-cat'); pc.innerHTML = '';
    var ec = byId('edit-cat'); ec.innerHTML = '<option value="">— καμία —</option>';
    (state.categories || []).forEach(function (c) {
      var o = document.createElement('option'); o.value = c.id; o.textContent = c.icon + ' ' + c.name; o.dataset.biz = c.default_business ? '1' : '0';
      pc.appendChild(o);
      var o2 = document.createElement('option'); o2.value = c.id; o2.textContent = c.icon + ' ' + c.name; ec.appendChild(o2);
    });
  }
  function recomputeWeekCounted() {
    var t = 0; (state.week.rows || []).forEach(function (r) { if (r.counted != null) t += Number(r.counted); });
    state.week.totals.counted = round2(t);
  }
  function renderCount() {
    var box = byId('count-rows'); box.innerHTML = '';
    (state.week.rows || []).forEach(function (r) {
      var div = document.createElement('div'); div.className = 'm-cnt-row' + (r.closed ? ' closed' : '');
      var ex = r.out ? '<br><span class="ex">έξοδα −' + euro(r.out) + '</span>' : '';
      if (r.closed) div.innerHTML = '<div class="d">' + r.label + ' (ρεπό)' + ex + '</div><span class="m-dash">—</span>';
      else div.innerHTML = '<div class="d">' + r.label + ex + '</div><input class="m-cin" data-iso="' + r.iso + '" inputmode="decimal" placeholder="0,00" value="' + (r.counted != null ? Number(r.counted).toFixed(2).replace('.', ',') : '') + '">';
      box.appendChild(div);
    });
    var t = state.week.totals || {};
    byId('count-sum').innerHTML =
      '<div class="r"><span>💰 Εισπράξεις εβδομάδας</span><b>' + euro(t.counted || 0) + '</b></div>'
      + '<div class="r"><span>💸 Πληρωμές εβδομάδας</span><b>' + (t.out ? ('−' + euro(t.out)) : '—') + '</b></div>'
      + '<div class="r"><span>👜 Υπόλοιπο ταμείου</span><b>' + euro(state.balance) + '</b></div>';
  }
  function hhmm(ms) {
    if (!ms) return '';
    var d = new Date(Number(ms));
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function renderSync() {
    var line = byId('m-syncline'), conn = byId('m-conn');
    var mailbox = (window.CBSync && CBSync.configured());
    var emo, full, warn = false;
    if (!navigator.onLine) {
      emo = '📴'; warn = true; full = 'Χωρίς δίκτυο — θα συγχρονιστεί μόλις βρεις internet';
    } else if (queue.length && mailbox) {
      emo = '📮'; warn = true; full = queue.length + ' κινήσεις στη θυρίδα — περιμένουν τον υπολογιστή';
    } else if (queue.length) {
      emo = '⏳'; warn = true; full = queue.length + ' αλλαγές περιμένουν συγχρονισμό';
    } else {
      emo = '✓'; var t = hhmm(load(LS_LASTSYNC, 0));
      full = 'Όλα συγχρονισμένα' + (t ? ' · τελευταίος συγχρονισμός ' + t : '');
    }
    if (line) {
      line.innerHTML = '<span class="ic">' + emo + '</span><span>' + esc(full) + '</span>';
      line.className = 'm-syncline' + (warn ? ' warn' : '');
    }
    // ζωντανό σηματάκι σύνδεσης: 🟢 συνδεδεμένο (online+θυρίδα) / 🟡 τοπικά / 🔴 χωρίς ίντερνετ
    if (conn) {
      var ck, ct;
      if (!navigator.onLine) { ck = 'off'; ct = 'Χωρίς ίντερνετ'; }
      else if (mailbox) { ck = 'ok'; ct = 'Συνδεδεμένο'; }
      else { ck = 'loc'; ct = 'Τοπικά'; }
      conn.className = 'm-conn ' + ck;
      conn.innerHTML = '<span class="dot"></span><span>' + ct + '</span>';
    }
  }
  function renderAll() { renderBalance(); renderFeed(); renderSelects(); renderCount(); renderSync(); }

  // ── sheets (bottom) ─────────────────────────────────────────────────────────
  var ov;
  function openSheet(id) { var s = byId(id); if (!s) return; ov.classList.add('on'); s.classList.add('on'); document.body.style.overflow = 'hidden'; }
  function closeSheets() { ov.classList.remove('on'); var l = document.querySelectorAll('.m-sheet.on'); for (var i = 0; i < l.length; i++) l[i].classList.remove('on'); document.body.style.overflow = ''; }

  // ── actions ─────────────────────────────────────────────────────────────────
  // κάθε γράμμα κουβαλά «πότε έγινε στο κινητό» (ts) → ο υπολογιστής κρατά την πιο πρόσφατη αλλαγή
  function enqueue(op) { if (op.ts == null) op.ts = Date.now(); queue.push(op); save(LS_QUEUE, queue); }

  function addPay() {
    var amt = parseAmt(byId('pay-amount').value); if (!(amt > 0)) { closeSheets(); return; }
    var day = byId('pay-day').value || null;
    var catRaw = byId('pay-cat').value; var cat = catRaw ? Number(catRaw) : null;
    var biz = (document.querySelector('input[name=pay-biz]:checked') || {}).value === '1';
    var desc = byId('pay-desc').value || '';
    var u = uid();
    enqueue({ uid: u, type: 'pay', amount: amt, category_id: cat, is_business: biz, source_day: day, description: desc });
    state.balance = round2(state.balance - amt);
    var c = (state.categories || []).filter(function (x) { return String(x.id) === String(cat); })[0];
    state.recent.unshift({ id: 'tmp_' + u, entry_date: todayIso(), source_day: day, amount: amt, direction: 'out', category_id: cat, category_name: c ? c.name : null, category_icon: c ? c.icon : null, description: desc, is_business: biz, withdrawal: false });
    save(LS_STATE, state); byId('pay-amount').value = ''; byId('pay-desc').value = '';
    renderAll(); closeSheets(); trySync();
  }
  function addDraw() {
    var amt = parseAmt(byId('draw-amount').value); if (!(amt > 0)) { closeSheets(); return; }
    var biz = (document.querySelector('input[name=draw-biz]:checked') || {}).value === '1';
    var desc = byId('draw-desc').value || '';
    var u = uid();
    enqueue({ uid: u, type: 'withdraw', amount: amt, is_business: biz, description: desc });
    state.balance = round2(state.balance - amt);
    state.recent.unshift({ id: 'tmp_' + u, entry_date: todayIso(), source_day: null, amount: amt, direction: 'out', category_id: null, category_name: null, category_icon: null, description: desc, is_business: biz, withdrawal: true });
    save(LS_STATE, state); byId('draw-amount').value = ''; byId('draw-desc').value = '';
    renderAll(); closeSheets(); trySync();
  }
  function saveCount() {
    var inputs = document.querySelectorAll('#count-rows .m-cin'), changed = false;
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i], iso = inp.getAttribute('data-iso'), val = parseAmt(inp.value);
      var row = (state.week.rows || []).filter(function (r) { return r.iso === iso; })[0];
      var old = row && row.counted != null ? Number(row.counted) : 0;
      if (val === old) continue;
      enqueue({ uid: uid(), type: 'count', day: iso, amount: val });
      if (row) { state.balance = round2(state.balance - old + val); row.counted = val; }
      changed = true;
    }
    if (changed) { recomputeWeekCounted(); save(LS_STATE, state); renderAll(); trySync(); }
    closeSheets();
  }

  var editId = null, editWithdrawal = false;
  function openEdit(e) {
    editId = e.id; editWithdrawal = !!e.withdrawal;
    byId('edit-amount').value = Number(e.amount).toFixed(2).replace('.', ',');
    byId('edit-cat').value = e.category_id || '';
    byId('edit-desc').value = e.description || '';
    byId('edit-day').value = e.source_day || '';
    byId('edit-day-wrap').style.display = e.withdrawal ? 'none' : '';
    byId(e.is_business ? 'edit-biz1' : 'edit-biz0').checked = true;
    openSheet('s-edit');
  }
  function saveEdit() {
    var item = (state.recent || []).filter(function (x) { return x.id === editId; })[0];
    if (!item) { closeSheets(); return; }
    var amt = parseAmt(byId('edit-amount').value); if (!(amt > 0)) { closeSheets(); return; }
    var catRaw = byId('edit-cat').value; var cat = catRaw ? Number(catRaw) : null;
    var biz = (document.querySelector('input[name=edit-biz]:checked') || {}).value === '1';
    var desc = byId('edit-desc').value || '';
    var day = editWithdrawal ? null : (byId('edit-day').value || null);
    var oldAmt = Number(item.amount);
    state.balance = round2(state.balance + (item.direction === 'out' ? (oldAmt - amt) : (amt - oldAmt)));
    item.amount = amt; item.category_id = cat; item.is_business = biz; item.description = desc;
    if (!editWithdrawal) item.source_day = day;
    var c = (state.categories || []).filter(function (x) { return String(x.id) === String(cat); })[0];
    item.category_name = c ? c.name : null; item.category_icon = c ? c.icon : null;
    if (String(editId).indexOf('tmp_') === 0) {
      var u = String(editId).slice(4);
      queue.forEach(function (op) { if (op.uid === u) { op.amount = amt; op.category_id = cat; op.is_business = biz; op.description = desc; if (!editWithdrawal) op.source_day = day; } });
      save(LS_QUEUE, queue);
    } else {
      enqueue({ uid: uid(), type: 'entry_edit', id: editId, amount: amt, category_id: cat, is_business: biz, description: desc, source_day: editWithdrawal ? null : day });
    }
    save(LS_STATE, state); renderAll(); closeSheets(); trySync();
  }
  function delEntry(e) {
    window.showConfirm('Σβήσιμο αυτής της κίνησης (' + euro(e.amount) + ');', function () {
      state.balance = round2(state.balance + (e.direction === 'in' ? -e.amount : e.amount));
      state.recent = (state.recent || []).filter(function (x) { return x.id !== e.id; });
      if (typeof e.id === 'string' && e.id.indexOf('tmp_') === 0) {
        var u = e.id.slice(4); queue = queue.filter(function (op) { return op.uid !== u; });
      } else {
        enqueue({ uid: uid(), type: 'entry_delete', id: e.id });
      }
      save(LS_STATE, state); save(LS_QUEUE, queue); renderAll(); trySync();
    }, null, { title: 'Σβήσιμο', yesLabel: 'Σβήσιμο' });
  }

  // ── sync ────────────────────────────────────────────────────────────────────
  // Δύο δρόμοι: (1) τοπικός server (όταν ο υπολογιστής είναι ανοιχτός & στο ίδιο δίκτυο)·
  // (2) θυρίδα GitHub (όταν ο υπολογιστής είναι ΚΛΕΙΣΤΟΣ) — μέσω window.CBSync.
  var syncing = false;
  var uploadedRemote = {};        // uid → 1 : ήδη ανεβασμένο στη θυρίδα (μην ξανα-στείλεις)
  var lastVia = '';               // 'local' | 'mailbox' | '' → για το σηματάκι

  function ackAndAdopt(authState, ackUids) {
    if (ackUids && ackUids.length) {
      var s = {}; ackUids.forEach(function (u) { s[u] = 1; });
      queue = queue.filter(function (o) { return !s[o.uid]; }); save(LS_QUEUE, queue);
    }
    // Υιοθέτησε το «επίσημο» state ΜΟΝΟ όταν δεν περιμένει τίποτα — αλλιώς θα έκρυβε
    // τις τοπικές κινήσεις που ο υπολογιστής δεν έχει δει ακόμα (single-user → ασφαλές).
    if (!queue.length) save(LS_LASTSYNC, Date.now());   // άδεια ουρά = ο υπολογιστής τα έχει όλα
    if (authState && authState.balance != null && !queue.length) {
      state = authState; save(LS_STATE, state);
    }
  }

  function trySyncMailbox(sending) {
    if (!(window.CBSync && CBSync.configured())) { syncing = false; renderSync(); return; }
    lastVia = 'mailbox';
    var toSend = sending.filter(function (o) { return !uploadedRemote[o.uid]; });
    CBSync.pushOps(toSend).then(function (r) {
      (r.uploaded || []).forEach(function (u) { uploadedRemote[u] = 1; });
      return CBSync.pullState();
    }).then(function (st) {
      var acked = [];
      if (st && st.synced_uids) {
        var setu = {}; st.synced_uids.forEach(function (u) { setu[u] = 1; });
        acked = sending.filter(function (o) { return setu[o.uid]; }).map(function (o) { return o.uid; });
      }
      ackAndAdopt(st, acked);
      syncing = false; renderAll();
    }).catch(function () { syncing = false; renderSync(); });
  }

  function trySync() {
    renderSync();
    if (syncing || !navigator.onLine || !queue.length) return;
    syncing = true;
    var sending = queue.slice();
    if (CFG.noLocal) { trySyncMailbox(sending); return; }   // Pages → καμία τοπική προσπάθεια, κατευθείαν θυρίδα
    fetch(API_OPS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ ops: sending }) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (res) {
        lastVia = 'local';
        ackAndAdopt(res.state, sending.map(function (o) { return o.uid; }));  // ο server τα εφάρμοσε → ack όλα
        syncing = false; renderAll();
        if (queue.length) trySync();
      })
      .catch(function () { trySyncMailbox(sending); });   // τοπικός server κλειστός → θυρίδα
  }
  function refreshState() {
    if (queue.length) { trySync(); return; } // μη σβήσεις τοπικές αλλαγές — συγχρόνισε πρώτα
    if (CFG.noLocal) {                        // Pages → διάβασε κατευθείαν από τη θυρίδα
      if (window.CBSync && CBSync.configured()) {
        CBSync.pullState().then(function (st) {
          if (st && st.balance != null) { state = st; save(LS_STATE, state); renderAll(); }
        }).catch(function () {});
      }
      return;
    }
    fetch(API_STATE, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s && s.balance != null) { state = s; save(LS_STATE, state); renderAll(); } })
      .catch(function () {
        if (window.CBSync && CBSync.configured()) {       // τοπικός server κλειστός → διάβασε από θυρίδα
          CBSync.pullState().then(function (st) {
            if (st && st.balance != null) { state = st; save(LS_STATE, state); renderAll(); }
          }).catch(function () {});
        }
      });
  }

  // Διάβασε κλειδιά θυρίδας από QR/σύνδεσμο (#cb=…) → αποθήκευσε τοπικά, καθάρισε το URL.
  function handleConnectHash() {
    try {
      var h = location.hash || '';
      var m = h.match(/[#&]cb=([^&]+)/);
      if (!m || !window.CBSync) return;
      var creds = CBSync.parsePayload(decodeURIComponent(m[1]));
      if (creds) {
        CBSync.setCreds(creds);
        // Νέα σύνδεση από το QR του υπολογιστή = μηδενισμός κλειδώματος (μόνος τρόπος reset PIN/δαχτυλικού).
        if (window.CBLock) CBLock.clearAll();
        history.replaceState(null, '', location.pathname + location.search);
        if (window.showAlert) showAlert('✅ Το κινητό συνδέθηκε με τη θυρίδα. Τώρα το Ταμείο δουλεύει και με κλειστό υπολογιστή.', { title: '📮 Σύνδεση κινητού' });
      }
    } catch (e) {}
  }

  // ── wiring ──────────────────────────────────────────────────────────────────
  function setup() {
    ov = byId('m-ov');
    ov.addEventListener('click', closeSheets);
    var closers = document.querySelectorAll('[data-close]'); for (var i = 0; i < closers.length; i++) closers[i].addEventListener('click', closeSheets);
    var tiles = document.querySelectorAll('[data-sheet]'); for (var j = 0; j < tiles.length; j++) (function (b) { b.addEventListener('click', function () { openSheet(b.dataset.sheet); }); })(tiles[j]);

    // 👁 peek: το υπόλοιπο φαίνεται ΜΟΝΟ όσο κρατάς πατημένο (ματάκι Ή ποσό)
    function setPeek(on) { peeking = on; renderBalance(); }
    [byId('m-eye'), byId('m-bal')].forEach(function (el) {
      if (!el) return;
      el.addEventListener('touchstart', function (ev) { ev.preventDefault(); setPeek(true); }, { passive: false });
      el.addEventListener('touchend', function (ev) { ev.preventDefault(); setPeek(false); });
      el.addEventListener('touchcancel', function () { setPeek(false); });
      el.addEventListener('mousedown', function (ev) { ev.preventDefault(); setPeek(true); });
    });
    document.addEventListener('mouseup', function () { if (peeking) setPeek(false); });

    var moreBtn = byId('m-more');
    if (moreBtn) moreBtn.addEventListener('click', function () { histOpen = !histOpen; renderFeed(); });

    byId('pay-save').addEventListener('click', addPay);
    byId('draw-save').addEventListener('click', addDraw);
    byId('count-save').addEventListener('click', saveCount);
    byId('edit-save').addEventListener('click', saveEdit);

    var payCat = byId('pay-cat');
    payCat.addEventListener('change', function () {
      var o = payCat.options[payCat.selectedIndex]; var biz = o && o.dataset.biz === '1';
      var r = document.querySelector('input[name=pay-biz][value="' + (biz ? '1' : '0') + '"]'); if (r) r.checked = true;
    });

    renderAll();
    if (navigator.onLine) refreshState();
    trySync();
    window.addEventListener('online', function () { renderSync(); trySync(); refreshState(); });
    window.addEventListener('offline', renderSync);

    // Όσο εκκρεμούν κινήσεις, ξαναδοκίμασε ήσυχα κάθε 60'' (πιάνει & το «ο υπολογιστής
    // άνοιξε & απορρόφησε τα γράμματα της θυρίδας» χωρίς να χρειαστεί άνοιγμα/κλείσιμο).
    setInterval(function () { if (navigator.onLine && queue.length) trySync(); }, 60000);

  }

  // ── ΚΑΜΟΥΦΛΑΖ: δείξε την πραγματική εφαρμογή ΜΟΝΟ με το κλειδί (ή στον τοπικό server) ──
  // Όποιος ανοίξει τη δημόσια διεύθυνση χωρίς το κλειδί βλέπει μια ουδέτερη, λειτουργική
  // οθόνη «Σημειώσεις» (κρατάει τις σημειώσεις του τοπικά) → δεν υποψιάζεται τίποτα.
  function decoySetup() {
    var LSN = 'nx_notes';
    var list = byId('nx-list'), input = byId('nx-input'), addb = byId('nx-add'), emptyEl = byId('nx-empty');
    if (!list) return;
    var notes; try { notes = JSON.parse(localStorage.getItem(LSN)) || []; } catch (e) { notes = []; }
    function persist() { try { localStorage.setItem(LSN, JSON.stringify(notes)); } catch (e) {} }
    function render() {
      list.innerHTML = '';
      if (!notes.length) { emptyEl.style.display = ''; return; }
      emptyEl.style.display = 'none';
      notes.forEach(function (n, i) {
        var d = document.createElement('div'); d.className = 'm-it';
        d.innerHTML = '<span class="emo">📝</span><div class="tx"><div class="t1">' + esc(n) + '</div></div>'
          + '<div class="acts"><button type="button" class="m-del">🗑</button></div>';
        d.querySelector('.m-del').addEventListener('click', function () { notes.splice(i, 1); persist(); render(); });
        list.appendChild(d);
      });
    }
    addb.addEventListener('click', function () { var v = (input.value || '').trim(); if (!v) return; notes.unshift(v); persist(); input.value = ''; render(); });
    render();
  }

  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }

  function boot() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () { navigator.serviceWorker.register(SW_PATH, { scope: SW_SCOPE }).catch(function () {}); });
    }
    handleConnectHash();                                   // QR/σύνδεσμος μπορεί να βάλει το κλειδί
    var hasKey = !!(window.CBSync && CBSync.getCreds && CBSync.getCreds());
    var showReal = hasKey || !CFG.noLocal;                 // τοπικός server = έμπιστος· Pages θέλει κλειδί
    if (showReal) {
      show(byId('app-decoy'), false); show(byId('app-real'), true);
      // 🔒 Κλείδωμα: δείξε την κλειδαριά ΠΡΙΝ φανεί οτιδήποτε — αλλά ΜΟΝΟ αν χρειάζεται
      // (φρέσκο άνοιγμα ή πέρασε το περιθώριο χρόνου)· μετά «οπλίζει» το ξανακλείδωμα.
      if (window.CBLock) CBLock.lockIfNeeded();
      setup();
      if (window.CBLock) CBLock.arm();
    }
    else { show(byId('app-real'), false); show(byId('app-decoy'), true); decoySetup(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
