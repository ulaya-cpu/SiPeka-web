// Utilitas bersama untuk semua skrip uji. Dimuat setelah app.js.
window.LAB = {
  q: new URLSearchParams(location.search),
  num: function (key, fallback) { var v = this.q.get(key); return v === null ? fallback : Number(v); },
  // Mengambil PDF uji dari server lab sebagai objek File.
  loadPdfs: async function (from, count) {
    var out = [];
    for (var i = from; i < from + count; i++) {
      var r = await fetch("/pdf/" + i); if (!r.ok) break;
      var name = decodeURIComponent(r.headers.get("X-File-Name") || ("berkas" + i + ".pdf"));
      out.push(new File([await r.arrayBuffer()], name, { type: "application/pdf", lastModified: 1700000000000 + i }));
    }
    return out;
  },
  // Menunggu antrean OCR otomatis kosong. Mengembalikan false bila melewati batas waktu.
  waitOcr: async function (limitMs) {
    var t = performance.now();
    while (!(autoOcrQueue.length === 0 && autoOcrActiveEntries.size === 0 && autoOcrLanesRunning === 0)) {
      if (performance.now() - t > limitMs) return false;
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    return true;
  },
  send: async function (obj) {
    obj.errors = window.__errs || ["penangkap galat tidak aktif"];
    obj.alerts = window.__alerts || [];
    obj.warns = (window.__warns || []).slice(0, 10);
    try { await fetch("/result", { method: "POST", body: JSON.stringify(obj) }); } catch (e) { }
  },
  ready: function (fn) {
    setTimeout(function () { fn().catch(function (e) { window.LAB.send({ exception: String(e && e.stack || e) }); }); }, 1200);
  }
};
