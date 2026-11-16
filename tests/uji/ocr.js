// UJI OCR (data nyata, berkas yang punya halaman scan): alur OCR otomatis dijalankan dengan satu
// jalur lalu dua jalur pada berkas yang sama. Teks hasil harus identik; hanya waktunya yang boleh beda.
LAB.ready(async function () {
  var n = LAB.num("n", 30), out = { uji: "ocr" };
  var maks = 0, pantau = setInterval(function () { maks = Math.max(maks, autoOcrActiveEntries.size); }, 20);
  async function teks() { var m = {}; for (var i = 0; i < files.length; i++) { await ensureAnalysisData(files[i]); m[files[i].id] = files[i].ocrText; releaseEntryHeavyData(files[i]); } return m; }
  autoOcrEnabled = false;
  await processFilesBatch(await LAB.loadPdfs(0, n));
  out.files = files.length; out.scanPages = files.reduce(function (s, e) { return s + (e.ocrCandidates || []).length; }, 0);
  await ensureTesseractWorker();
  out.mesinLokal = !ocrLocalAssetsFailed;
  async function putaran(mesin) {
    ocrEngineCount = function () { return mesin; };
    if (mesin > 1) { ocrExtraEnginesStarted = false; startExtraOcrEngines(); var t = performance.now(); while (ocrEngineSlots.length < mesin && performance.now() - t < 60000) await new Promise(function (r) { setTimeout(r, 100); }); }
    for (var i = 0; i < files.length; i++) { var e = files[i]; await ensureAnalysisData(e); e.ocrText = ""; e.ocrPageTexts = {}; e.ocr = { running: false, done: false, error: null, progress: "", processedPages: [], automatic: false }; dirtyAnalysisIds.add(e.id); dirtyActiveIds.add(e.id); }
    await flushDirtyAnalysisEntries(); await flushDirtyActiveEntries(); files.forEach(releaseEntryHeavyData);
    maks = 0; autoOcrEnabled = true;
    var t0 = performance.now(); enqueueAllPendingOcr(); processAutoOcrQueue();
    var selesai = await LAB.waitOcr(280000), ms = performance.now() - t0; autoOcrEnabled = false;
    var tx = await teks();
    return { mesin: mesin, mesinSiap: ocrEngineSlots.length, selesai: selesai, ms: Math.round(ms), berkasBersamaanMaks: maks, done: files.filter(function (e) { return (e.ocrCandidates || []).length && e.ocr.done; }).length, galat: files.filter(function (e) { return e.ocr && e.ocr.error; }).length, karakter: Object.keys(tx).reduce(function (s, k) { return s + tx[k].length; }, 0), teks: tx };
  }
  var satu = await putaran(1), dua = await putaran(2), sama = 0;
  Object.keys(satu.teks).forEach(function (k) { if (satu.teks[k] === dua.teks[k]) sama++; });
  delete satu.teks; delete dua.teks; clearInterval(pantau);
  out.satuJalur = satu; out.duaJalur = dua; out.teksIdentik = sama; out.percepatan = Math.round(satu.ms / Math.max(1, dua.ms) * 100) / 100;
  await LAB.send(out);
});
