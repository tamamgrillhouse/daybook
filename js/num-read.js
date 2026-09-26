/* 🔢 ΛΩ19 (R11) — Ο ΕΝΑΣ αναγνώστης αριθμών του browser: ο δίδυμος του `parse_decimal`.

   Κάθε αριθμητικό κουτί ΚΕΙΜΕΝΟΥ δηλώνει τον ΚΑΝΟΝΑ ΑΝΑΓΝΩΣΗΣ του:
     • `data-money` — ΠΟΣΟ σε € (μισθός, τιμή, σύνολο, υπόλοιπο…): εδώ «1.200» = χίλια
       διακόσια, όπως γράφει ένας Έλληνας (ΛΦ4).
     • `data-count` — ΜΕΓΑΛΗ ΜΕΤΡΗΣΗ (κατανάλωση kWh, ένδειξη ρολογιού ρεύματος/νερού, κυβικά,
       Mbps): ίδιος κανόνας με το ποσό — «12.345» kWh = 12345 (απόφαση ιδιοκτήτη 7Α, ΛΩ19).
     • `data-qty`   — ΠΟΣΟΤΗΤΑ (κιλά, λίτρα, ώρες, °C, %, συντελεστής, μήνες…): εδώ η ΜΟΝΗ
       τελεία είναι υποδιαστολή — «1.250» κιλά = 1,25 (απόφαση ιδιοκτήτη, 2026-09-26).
   Κουτί χωρίς δήλωση ΔΕΝ παίρνει ποτέ τον κανόνα των χιλιάδων (το φυλά
   `tests/test_lw19_input_declared.py`: κάθε `inputmode="decimal"` πρέπει να δηλώνει).
   Οι δηλώσεις που διαβάζουν χιλιάδες ζουν ΜΙΑ φορά, στο `THOUSANDS_KINDS` παρακάτω.

   `readNum(κουτί ή id, προεπιλογή)` — ό,τι διαβάζει μια σελίδα για ζωντανό υπολογισμό
   περνά από εδώ, ώστε ο υπολογισμός στην οθόνη να συμφωνεί με ό,τι θα αποθηκεύσει ο
   server. ❌ ΠΟΤΕ ξανά ιδιωτικό `parseFloat(x.replace(',', '.'))` σε σελίδα.

   Κανόνες του `parse_decimal` (app/services/form_parsing.py), ένας-προς-έναν:
     «1.234,56» → 1234,56 · «12,5» → 12,5 · «8.50» → 8,5 · «5 €» → 5
     κενό / άκυρο / μη-πεπερασμένο (Infinity, NaN, 1e400) → προεπιλογή.
     «−» (U+2212, το τυπογραφικό πλην κινητού/PDF/Excel) = «-» — ΛΩ19 Q9, ίδιο με το
     `UNICODE_MINUS` του server. */
(function () {
  var MINUS = /−/g;
  var GROUPED = /^\s*([-−]?)([1-9]\d{0,2}(?:\.\d{3})+)\s*(€?)\s*$/;
  var DOT3 = /\d\.\d{3}\s*€?\s*$/;
  var NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

  // «1.200» → «1200» · «−1.200» → «-1200» · οτιδήποτε άλλο → null (όχι «8.50», «0.500», «1.2345»).
  function thousands(v) {
    var m = GROUPED.exec(v == null ? '' : String(v));
    return m ? (m[1] ? '-' : '') + m[2].replace(/\./g, '') : null;
  }

  // Ο καθρέφτης του parse_decimal(ndigits=None): αριθμός ή null.
  function parse(s) {
    var raw = String(s == null ? '' : s).trim().replace(MINUS, '-').replace(/€/g, '').replace(/\s/g, '');
    if (!raw) return null;
    if (raw.indexOf(',') >= 0 && raw.indexOf('.') >= 0) raw = raw.replace(/\./g, '').replace(/,/g, '.');
    else raw = raw.replace(/,/g, '.');
    if (!NUMBER.test(raw)) return null;
    var n = Number(raw);
    return isFinite(n) ? n : null;
  }

  // Οι δηλώσεις όπου «1.200» = χίλια διακόσια: ποσό € και μεγάλη μέτρηση (kWh, ένδειξη).
  var THOUSANDS_KINDS = ['data-money', 'data-count'];

  // Ισχύει ο κανόνας των χιλιάδων σε αυτό το κουτί; ΜΟΝΟ σε κουτί που τον ΔΗΛΩΝΕΙ.
  function thousandsRule(el) {
    if (!el || el.tagName !== 'INPUT' || el.type === 'number') return false;
    if (el.hasAttribute('data-no-thousands') || DOT3.test(el.defaultValue || '')) return false;
    for (var i = 0; i < THOUSANDS_KINDS.length; i++) if (el.hasAttribute(THOUSANDS_KINDS[i])) return true;
    return false;
  }

  function readNum(elOrId, dflt) {
    var el = (typeof elOrId === 'string') ? document.getElementById(elOrId) : elOrId;
    var fallback = (dflt === undefined) ? null : dflt;
    if (!el) return fallback;
    var v = el.value;
    if (v !== el.defaultValue && thousandsRule(el)) {
      var t = thousands(v);
      if (t !== null) v = t;
    }
    var n = parse(v);
    return n === null ? fallback : n;
  }

  window.grThousands = thousands;
  window.grParseNum = parse;
  window.grThousandsRule = thousandsRule;
  window.readNum = readNum;
})();
