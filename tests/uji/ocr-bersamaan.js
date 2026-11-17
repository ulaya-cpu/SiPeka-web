// UJI OCR BERSAMAAN (data nyata ber-halaman scan): OCR otomatis menyala SELAMA pembacaan berjalan.
// Menjaga dua hal: (1) teks hasil baca yang tersimpan tidak pernah rusak/terhapus oleh OCR,
// (2) status tiap berkas konsisten dengan teks yang tersimpan, dan OCR tidak pernah membuat
// dokumen yang tadinya ditemukan menjadi "tidak ditemukan".
LAB.ready(async function () {
  var n = LAB.num("n", 250), out = { uji: "ocr-bersamaan" }, rusak = [], tidakKonsisten = [];
  autoOcrEnabled = true;
  var t0 = performance.now();
  await processFilesBatch(await LAB.loadPdfs(0, n));
  out.drained = await LAB.waitOcr(LAB.num("batas", 900) * 1000);
  out.totalMs = Math.round(performance.now() - t0);
  out.files = files.length; out.failed = files.filter(function (e) { return e.error; }).length;
  out.scanFiles = files.filter(function (e) { return (e.ocrCandidates || []).length; }).length;
  for (var i = 0; i < files.length; i++) {
    var e = files[i]; if (e.error) continue;
    var row = await dbGet(DB_ANALYSIS_STORE, e.id);
    var teks = (row && row.digitalText) || "", halaman = ((row && row.pageTexts) || []).length;
    var segmen = teks.split("\n"); if (segmen.length && segmen[segmen.length - 1] === "") segmen.pop();
    // Satu halaman = satu baris di digitalText. Bila jumlahnya tidak cocok, teks tersimpan rusak.
    if (!row || !halaman || segmen.length !== halaman) { rusak.push(e.name + " halaman=" + halaman + " baris=" + segmen.length + " panjang=" + teks.length); continue; }
    // Status saat ini harus sama dengan penilaian ulang dari teks tersimpan.
    var sekarang = fileMissingItems(e).map(function (m) { return m.id; }).sort().join(",");
    var salinan = { id: e.id, name: e.name, category: e.category, digitalText: teks, ocrText: row.ocrText || "", pageTexts: row.pageTexts || [], ocrPageTexts: row.ocrPageTexts || {}, itemsStatus: {} };
    evaluateFile(salinan);
    var ulang = fileMissingItems(salinan).map(function (m) { return m.id; }).sort().join(",");
    // Tanpa OCR sama sekali: dokumen yang ditemukan dari teks digital tidak boleh hilang.
    var digital = { id: e.id, name: e.name, category: e.category, digitalText: teks, ocrText: "", pageTexts: row.pageTexts || [], ocrPageTexts: {}, itemsStatus: {} };
    evaluateFile(digital);
    var hilang = fileMissingItems(e).filter(function (m) { return digital.itemsStatus[m.id] && digital.itemsStatus[m.id].source === "digital"; }).map(function (m) { return m.id; });
    if (sekarang !== ulang || hilang.length) tidakKonsisten.push(e.name + " sekarang=[" + sekarang + "] dariTeks=[" + ulang + "] hilang=[" + hilang.join(",") + "]");
  }
  out.teksRusak = rusak.length; out.contohRusak = rusak.slice(0, 5);
  out.tidakKonsisten = tidakKonsisten.length; out.contohTidakKonsisten = tidakKonsisten.slice(0, 5);
  out.complete = files.filter(function (e) { return !e.error && fileMissingItems(e).length === 0; }).length;
  out.ocrDone = files.filter(function (e) { return (e.ocrCandidates || []).length && e.ocr.done; }).length;
  out.ocrErrors = files.filter(function (e) { return e.ocr && e.ocr.error; }).length;
  await LAB.send(out);
});
