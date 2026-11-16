// UJI FOLDER CADANGAN (data nyata): memakai OPFS, yaitu FileSystemDirectoryHandle asli milik
// browser, sebagai pengganti folder harddisk. Memeriksa: tidak ada PDF yang disalin, analisis
// ditulis berkelompok, pemulihan sesi, pemasangan ulang PDF, pengarsipan, dan laporan.
LAB.ready(async function () {
  var n = LAB.num("n", 120), lulus = [], gagal = [];
  function cek(nama, kondisi, detail) { (kondisi ? lulus : gagal).push(kondisi ? nama : nama + (detail !== undefined ? " -> " + JSON.stringify(detail) : "")); }
  async function daftar(dir, prefix) { var res = []; for await (var pair of dir.entries()) { if (pair[1].kind === "directory") res = res.concat(await daftar(pair[1], prefix + pair[0] + "/")); else res.push(prefix + pair[0]); } return res.sort(); }
  autoOcrEnabled = false;
  var root = await navigator.storage.getDirectory();
  try { await root.removeEntry("cadangan-uji", { recursive: true }); } catch (e) { }
  var ws = await root.getDirectoryHandle("cadangan-uji", { create: true });
  var pdfs = await LAB.loadPdfs(0, n);
  await processFilesBatch(pdfs);
  var lengkapAwal = files.filter(function (e) { return !e.error && fileMissingItems(e).length === 0; }).length;
  cek("berkas terbaca semua", files.length === pdfs.length && files.every(function (e) { return !e.pending; }), files.length);
  var contoh = files[Math.min(3, files.length - 1)], contohId = contoh.id;
  await ensureAnalysisData(contoh); var panjangTeks = contoh.digitalText.length, kurangAwal = fileMissingItems(contoh).length; releaseEntryHeavyData(contoh);

  workspaceDirHandle = ws; workspaceSyncedPdfIds.clear(); workspaceSyncedAnalysisIds.clear();
  cek("pencadangan berhasil", (await saveWorkspaceBackup(true)) === true);
  var isi = await daftar(ws, "");
  cek("tidak ada PDF yang disalin ke folder cadangan", isi.filter(function (x) { return /\.pdf$/i.test(x); }).length === 0, isi);
  var kelompokHarapan = Math.ceil(files.length / ANALYSIS_GROUP_SIZE);
  cek("analisis ditulis berkelompok", isi.filter(function (x) { return /^analysis\/kelompok-\d+\.json$/.test(x); }).length === kelompokHarapan, isi);
  cek("file sesi tertulis", isi.indexOf("sipeka-session.json") >= 0, isi);

  var manifest = await readExistingWorkspaceManifest();
  cek("file sesi memuat semua berkas", manifest.activeFiles.length === files.length, manifest.activeFiles.length);
  await restoreFromWorkspaceManifest(manifest);
  cek("pemulihan: jumlah berkas sama", files.length === pdfs.length, files.length);
  cek("pemulihan: jumlah lengkap sama", files.filter(function (e) { return !e.error && fileMissingItems(e).length === 0; }).length === lengkapAwal);
  var pulih = files.find(function (e) { return e.id === contohId; });
  await ensureAnalysisData(pulih);
  cek("pemulihan: teks analisis terbaca dari kelompok", pulih.digitalText.length === panjangTeks && panjangTeks > 0, [pulih.digitalText.length, panjangTeks]);
  evaluateFile(pulih); cek("pemulihan: penilaian ulang memberi hasil sama", fileMissingItems(pulih).length === kurangAwal); releaseEntryHeavyData(pulih);
  for (var i = 0; i < files.length; i++) { await ensureAnalysisData(files[i]); evaluateFile(files[i]); releaseEntryHeavyData(files[i]); }
  cek("pemulihan: penilaian ulang SEMUA berkas memberi jumlah lengkap sama", files.filter(function (e) { return !e.error && fileMissingItems(e).length === 0; }).length === lengkapAwal);

  var pasang = await processFilesBatch(pdfs);
  cek("pilih ulang berkas: terpasang kembali tanpa duplikat", pasang.added === 0 && files.length === pdfs.length && files.filter(function (e) { return e.sourceOnly && !e.blob; }).length === 0, pasang);

  var sepuluh = files.slice(0, 10), sisa = files.length - 10;
  await archiveFiles(sepuluh); await saveWorkspaceBackup(true);
  var total = 0, daftarKelompok = (await daftar(ws, "")).filter(function (x) { return /^analysis\/kelompok-/.test(x); });
  var dirAnalisis = await ws.getDirectoryHandle("analysis");
  for (var k = 0; k < daftarKelompok.length; k++) { var teks = await (await (await dirAnalisis.getFileHandle(daftarKelompok[k].split("/")[1])).getFile()).text(); total += Object.keys(JSON.parse(teks).items).length; }
  cek("arsip sebagian: kelompok hanya memuat berkas yang masih aktif", total === sisa, [total, sisa]);
  await archiveFiles(files.slice()); await saveWorkspaceBackup(true);
  cek("arsip semua: file kelompok dihapus", (await daftar(ws, "")).filter(function (x) { return /^analysis\//.test(x); }).length === 0, await daftar(ws, ""));
  cek("laporan memuat semua berkas", verificationReportRows().length === pdfs.length, verificationReportRows().length);
  try { await root.removeEntry("cadangan-uji", { recursive: true }); } catch (e) { }
  await LAB.send({ uji: "cadangan", lulus: lulus.length, gagal: gagal, total: lulus.length + gagal.length });
});
