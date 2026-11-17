// UJI OCR SETELAH BROWSER DIBUKA ULANG (data nyata ber-halaman scan).
// Setelah browser dibuka ulang, PDF belum terpasang. OCR otomatis TIDAK boleh mencoba lalu
// gagal pada berkas-berkas itu; ia harus menunggu, dan berjalan sendiri setelah PDF dipilih ulang.
LAB.ready(async function () {
  var n = LAB.num("n", 12), lulus = [], gagal = [];
  function cek(nama, kondisi, detail) { (kondisi ? lulus : gagal).push(kondisi ? nama : nama + (detail !== undefined ? " -> " + JSON.stringify(detail) : "")); }
  var pdfs = await LAB.loadPdfs(0, n);
  autoOcrEnabled = false;                       // gelombang dibaca, OCR belum sempat berjalan
  await processFilesBatch(pdfs);
  var perluOcr = files.filter(function (e) { return (e.ocrCandidates || []).length; }).length;
  cek("ada berkas ber-halaman scan untuk diuji", perluOcr > 0, perluOcr);

  // --- browser dibuka ulang: entri dibangun dari data tersimpan, tanpa PDF ---
  files = (await dbGetAll(DB_ACTIVE_STORE)).map(rebuildEntry); refreshKnownFingerprints();
  autoOcrEnabled = true; enqueueAllPendingOcr(); processAutoOcrQueue();
  await LAB.waitOcr(60000);
  var galatOcr = files.filter(function (e) { return e.ocr && e.ocr.error; });
  cek("OCR tidak menghasilkan galat pada berkas yang PDF-nya belum terpasang", galatOcr.length === 0, galatOcr.slice(0, 3).map(function (e) { return e.ocr.error; }));
  cek("berkas itu tidak ditandai OCR selesai", files.filter(function (e) { return (e.ocrCandidates || []).length && e.ocr.done; }).length === 0);
  renderResults();
  cek("status OCR menjelaskan bahwa PDF perlu dipilih ulang", /pilih ulang|dipasang|terpasang/i.test(document.getElementById("autoOcrStatus").textContent), document.getElementById("autoOcrStatus").textContent);

  // --- PDF dipilih ulang: OCR berjalan sendiri sampai tuntas ---
  var pasang = await processFilesBatch(pdfs);
  cek("PDF terpasang kembali", pasang.reattached === n && files.filter(function (e) { return e.sourceOnly && !e.blob; }).length === 0, pasang);
  var beres = await LAB.waitOcr(LAB.num("batas", 400) * 1000);
  cek("OCR tuntas setelah PDF dipasang", beres && files.filter(function (e) { return (e.ocrCandidates || []).length && e.ocr.done; }).length === perluOcr, [beres, files.filter(function (e) { return (e.ocrCandidates || []).length && e.ocr.done; }).length, perluOcr]);
  cek("tidak ada galat OCR tersisa", files.filter(function (e) { return e.ocr && e.ocr.error; }).length === 0, files.filter(function (e) { return e.ocr && e.ocr.error; }).map(function (e) { return e.ocr.error; }).slice(0, 3));
  await LAB.send({ uji: "ocr-buka-ulang", lulus: lulus.length, gagal: gagal, total: lulus.length + gagal.length });
});
