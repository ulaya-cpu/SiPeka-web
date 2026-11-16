// UJI REGRESI DATA NYATA: N PDF klaim asli dalam satu gelombang lewat alur asli, OCR menyala.
// Hasilnya (hanya angka, tanpa data pasien) dibandingkan dengan tests/acuan.json oleh run-tests.ps1.
LAB.ready(async function () {
  var n = LAB.num("n", 500), chunk = LAB.num("chunk", 0), out = { uji: "regresi" };
  autoOcrEnabled = LAB.num("ocr", 1) === 1;
  var t0 = performance.now(), loaded = 0;
  if (chunk > 0) {
    // Gelombang besar: PDF dimuat dan diproses per potongan, lalu dilepas dari memori (di aplikasi
    // sungguhan PDF tetap di harddisk; di lab PDF berada di memori sehingga harus dilepas).
    for (var from = 0; from < n; from += chunk) {
      var part = await LAB.loadPdfs(from, Math.min(chunk, n - from)); if (!part.length) break;
      loaded += part.length;
      await processFilesBatch(part);
      await LAB.waitOcr(600000);
      files.forEach(function (e) { if (e.blob && !e.open) { e.blob = null; } });
    }
  } else {
    var pdfs = await LAB.loadPdfs(0, n); loaded = pdfs.length;
    var tr = performance.now(); await processFilesBatch(pdfs); out.readMs = Math.round(performance.now() - tr);
    out.ocrDrained = await LAB.waitOcr(600000);
  }
  out.totalMs = Math.round(performance.now() - t0); out.loaded = loaded;
  var tRender = performance.now(); renderResults(); out.renderMs = Math.round(performance.now() - tRender);
  var tSave = performance.now(); await persistState(); out.saveMs = Math.round(performance.now() - tSave);
  var dup = findDuplicateSeps();
  out.files = files.length;
  out.pending = files.filter(function (e) { return e.pending; }).length;
  out.failed = files.filter(function (e) { return e.error; }).length;
  out.complete = files.filter(function (e) { return !e.pending && !e.error && fileMissingItems(e).length === 0; }).length;
  out.incomplete = files.filter(function (e) { return !e.pending && !e.error && fileMissingItems(e).length > 0; }).length;
  out.identityWarnFiles = files.filter(function (e) { return !e.error && identityWarnings(e, dup).length; }).length;
  out.rmMismatchFiles = files.filter(function (e) { return e.identity && e.identity.rmMismatch.length; }).length;
  out.duplicateSepFiles = files.filter(function (e) { return e.sep && dup.has(e.sep); }).length;
  out.noRmFiles = files.filter(function (e) { return !e.error && !(e.identity && e.identity.rm); }).length;
  out.icdWarnFiles = files.filter(function (e) { return Object.keys(e.itemsStatus || {}).some(function (k) { return e.itemsStatus[k].contentWarning === "icd"; }); }).length;
  out.scanFiles = files.filter(function (e) { return (e.ocrCandidates || []).length; }).length;
  out.scanPages = files.reduce(function (s, e) { return s + (e.ocrCandidates || []).length; }, 0);
  out.ocrDone = files.filter(function (e) { return (e.ocrCandidates || []).length && e.ocr && e.ocr.done; }).length;
  out.ocrErrors = files.filter(function (e) { return e.ocr && e.ocr.error; }).length;
  out.blobsInBrowser = await dbRequest(DB_BLOB_STORE, "readonly", function (s) { return s.count(); });
  out.analysisInBrowser = await dbRequest(DB_ANALYSIS_STORE, "readonly", function (s) { return s.count(); });
  out.heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  var tx = performance.now(), rep = verificationReportRows(), Zip = await ensureZipEngine(), blob = await buildVerificationWorkbook(rep, Zip);
  out.excelRows = rep.length; out.excelMs = Math.round(performance.now() - tx); out.excelBytes = blob.size;
  out.versi = SIPEKA_VERSION;
  await LAB.send(out);
});
