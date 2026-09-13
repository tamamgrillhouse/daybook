(function () {
  function _overlay(inner) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    ov.innerHTML = inner;
    document.body.appendChild(ov);
    return ov;
  }

  /* 🔒 Ο τίτλος και το μήνυμα μπαίνουν ΠΑΝΤΑ ως ΚΕΙΜΕΝΟ, ποτέ ως HTML (ΛΚ2).
     Γιατί: το `data-confirm` των forms το επιστρέφει ο browser ΑΠΟ-ΚΩΔΙΚΟΠΟΙΗΜΕΝΟ,
     οπότε η προστασία της Jinja χάνεται πριν φτάσει εδώ — και τα μηνύματα διαγραφής
     πελάτη περιέχουν ονόματα που γράφονται στο ΤΑΜΕΙΟ (auth-free `/api/pos/customers`).
     Με `innerHTML` ένα «πονηρό» όνομα έτρεχε κώδικα μέσα στη συνεδρία του ιδιοκτήτη.
     ❌ ΠΟΤΕ να μην ξαναμπεί επιλογή «πέρνα το ως HTML»: ό,τι πρέπει να το θυμάται ο
     καλών, ξεχνιέται (ΗΜ1). Για έμφαση χρησιμοποιούμε αλλαγή γραμμής («\n»), που την
     αποδίδει το `white-space:pre-line` παρακάτω. */
  function _setText(ov, sel, txt) {
    var el = ov.querySelector(sel);
    if (el) el.textContent = (txt === null || txt === undefined) ? '' : String(txt);
  }

  window.showConfirm = function (msg, onYes, onNo, opts) {
    opts = opts || {};
    var title    = opts.title    || 'Επιβεβαίωση';
    var yesLabel = opts.yesLabel || 'Επιβεβαίωση';
    var noLabel  = opts.noLabel  || 'Ακύρωση';
    var yesCls   = (opts.dangerous !== false) ? 'btn-danger' : 'btn-primary';

    var ov = _overlay(
      '<div style="background:#fff;border-radius:10px;padding:24px 28px;max-width:420px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.18);">' +
        '<div id="_tc_title" style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:8px;"></div>' +
        '<div id="_tc_msg" style="font-size:14px;color:#64748b;margin-bottom:22px;line-height:1.5;white-space:pre-line;"></div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
          '<button id="_tc_no"  class="btn-secondary" style="min-height:44px;padding:0 20px;"></button>' +
          '<button id="_tc_yes" class="' + yesCls + '" style="min-height:44px;padding:0 20px;"></button>' +
        '</div>' +
      '</div>'
    );
    _setText(ov, '#_tc_title', title);
    _setText(ov, '#_tc_msg', msg);
    _setText(ov, '#_tc_no', noLabel);
    _setText(ov, '#_tc_yes', yesLabel);

    function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') { close(); if (onNo) onNo(); } }

    ov.querySelector('#_tc_yes').addEventListener('click', function () { close(); if (onYes) onYes(); });
    ov.querySelector('#_tc_no') .addEventListener('click', function () { close(); if (onNo)  onNo();  });
    ov.addEventListener('click', function (e) { if (e.target === ov) { close(); if (onNo) onNo(); } });
    document.addEventListener('keydown', onKey);
  };

  window.showAlert = function (msg, onOk, opts) {
    opts = opts || {};
    var title = opts.title || 'Ειδοποίηση';

    var ov = _overlay(
      '<div style="background:#fff;border-radius:10px;padding:24px 28px;max-width:380px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.18);">' +
        '<div id="_ta_title" style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:8px;"></div>' +
        '<div id="_ta_msg" style="font-size:14px;color:#64748b;margin-bottom:22px;line-height:1.5;white-space:pre-line;"></div>' +
        '<div style="display:flex;justify-content:flex-end;">' +
          '<button id="_ta_ok" class="btn-primary" style="min-height:44px;padding:0 24px;width:auto;margin-top:0;display:inline-block;">ΟΚ</button>' +
        '</div>' +
      '</div>'
    );
    _setText(ov, '#_ta_title', title);
    _setText(ov, '#_ta_msg', msg);

    function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') { close(); if (onOk) onOk(); } }

    ov.querySelector('#_ta_ok').addEventListener('click', function () { close(); if (onOk) onOk(); });
    ov.addEventListener('click', function (e) { if (e.target === ov) { close(); if (onOk) onOk(); } });
    document.addEventListener('keydown', onKey);
  };

  /* Αυτόματο intercept για forms με data-confirm */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.dataset.confirm) return;
    e.preventDefault();
    showConfirm(
      form.dataset.confirm,
      function () { form.submit(); },
      null,
      {
        title:    form.dataset.confirmTitle || 'Επιβεβαίωση',
        yesLabel: form.dataset.confirmYes   || 'Επιβεβαίωση'
      }
    );
  });
})();
