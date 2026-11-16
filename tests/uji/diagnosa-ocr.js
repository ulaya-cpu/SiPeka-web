// DIAGNOSA OCR: memproses N berkas dengan OCR menyala dan mencatat lama tiap halaman.
// Bila antrean tidak kunjung kosong, melaporkan berkas/halaman yang sedang dikerjakan saat itu.
LAB.ready(async function () {
  var n = LAB.num("n", 250), from = LAB.num("from", 0), batas = LAB.num("batas", 240) * 1000, out = { uji: "diagnosa-ocr" };
  var lama = [], asli = recognizeCanvasWithTesseract, berjalan = {}, urut = 0;
  recognizeCanvasWithTesseract = function (canvas) {
    var id = ++urut, t = performance.now(), info = { id: id, w: canvas.width, h: canvas.height, mulai: Math.round(t) };
    berjalan[id] = info;
    var p = asli(canvas);
    var selesai = function () { info.ms = Math.round(performance.now() - t); delete berjalan[id]; lama.push(info); };
    p.then(selesai, selesai);
    return p;
  };
  autoOcrEnabled = true;
  var t0 = performance.now();
  await processFilesBatch(await LAB.loadPdfs(from, n));
  out.readMs = Math.round(performance.now() - t0);
  out.scanPages = files.reduce(function (s, e) { return s + (e.ocrCandidates || []).length; }, 0);
  out.drained = await LAB.waitOcr(batas);
  out.totalMs = Math.round(performance.now() - t0);
  out.pagesRecognized = lama.length;
  var sorted = lama.slice().sort(function (a, b) { return b.ms - a.ms; });
  out.slowest = sorted.slice(0, 6).map(function (x) { return x.ms + "ms " + x.w + "x" + x.h; });
  out.medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)].ms : null;
  out.sumMs = lama.reduce(function (s, x) { return s + x.ms; }, 0);
  out.stuck = Object.keys(berjalan).map(function (k) { var x = berjalan[k]; return "sudah " + Math.round(performance.now() - x.mulai) + "ms " + x.w + "x" + x.h; });
  out.active = Array.from(autoOcrActiveEntries).map(function (e) { return { nama: e.name, halaman: (e.ocrCandidates || []).length, selesai: (e.ocr.processedPages || []).length, progres: e.ocr.progress, ukuranKB: Math.round((e.size || 0) / 1024) }; });
  out.queue = autoOcrQueue.length; out.lanes = autoOcrLanesRunning; out.engines = ocrEngineSlots.map(function (s) { return s.pending; });
  out.ocrDone = files.filter(function (e) { return (e.ocrCandidates || []).length && e.ocr.done; }).length;
  out.ocrErrors = files.filter(function (e) { return e.ocr && e.ocr.error; }).map(function (e) { return e.ocr.error; }).slice(0, 4);
  out.scanFiles = files.filter(function (e) { return (e.ocrCandidates || []).length; }).length;
  await LAB.send(out);
});
