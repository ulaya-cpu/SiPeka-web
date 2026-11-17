// UJI SINTETIS: PDF dibuat di tempat dengan data rekaan (tidak ada data pasien), lalu diproses
// lewat alur asli aplikasi. Menjaga logika inti: deteksi dokumen, kategori otomatis, catatan
// kondisional, pemeriksaan identitas, SEP ganda, berkas rusak, duplikat, buka-ulang, dan laporan.
(function () {
  // ---- pembuat PDF minimal (teks saja, satu baris = satu potong teks) ----
  function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
  function makePdf(pages) {
    var objs = [], n = pages.length, fontId = 3, firstPage = 4;
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    var kids = []; for (var i = 0; i < n; i++) kids.push((firstPage + i * 2) + " 0 R");
    objs[2] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + n + " >>";
    objs[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    pages.forEach(function (lines, i) {
      var pageId = firstPage + i * 2, contentId = pageId + 1;
      var body = lines.length ? "BT /F1 9 Tf 40 800 Td 12 TL " + lines.map(function (l) { return "(" + esc(l) + ") Tj T*"; }).join(" ") + " ET" : "";
      objs[pageId] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 " + fontId + " 0 R >> >> /Contents " + contentId + " 0 R >>";
      objs[contentId] = "<< /Length " + body.length + " >>\nstream\n" + body + "\nendstream";
    });
    var out = "%PDF-1.4\n", offsets = [];
    for (var id = 1; id < objs.length; id++) { offsets[id] = out.length; out += id + " 0 obj\n" + objs[id] + "\nendobj\n"; }
    var xref = out.length; out += "xref\n0 " + objs.length + "\n0000000000 65535 f \n";
    for (var k = 1; k < objs.length; k++) out += String(offsets[k]).padStart(10, "0") + " 00000 n \n";
    out += "trailer\n<< /Size " + objs.length + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
    var bytes = new Uint8Array(out.length); for (var b = 0; b < out.length; b++) bytes[b] = out.charCodeAt(b) & 255;
    return bytes;
  }
  var stamp = 1700000000000;
  function pdfFile(name, pages) { return new File([makePdf(pages)], name, { type: "application/pdf", lastModified: stamp++ }); }

  // ---- lembar rekaan ----
  function eklaim(o) {
    return ["KEMENTERIAN KESEHATAN REPUBLIK INDONESIA JKN", "Berkas Klaim Individual Pasien 01/01/2026", "Kode Rumah Sakit : 9999999 Kelas Rumah Sakit : C", "Nama RS : RS UJI SINTETIS Jenis Tarif : TARIF RS KELAS C PEMERINTAH",
      "Nomor Peserta : " + o.kartu + " Nomor SEP : " + o.sep, "Nomor Rekam Medis : " + (o.rmEklaim || o.rm) + " Tanggal Masuk : 01/01/2026", "Umur Tahun : 40 Tanggal Keluar : 01/01/2026", "Umur Hari : 14600 Jenis Perawatan : " + (o.inap ? "1 - Rawat Inap" : "2 - Rawat Jalan"),
      "Tanggal Lahir : 01/01/1986 Cara Pulang : 1 - Atas Persetujuan Dokter", "Diagnosa Utama : K30 Dyspepsia", "Hasil Grouping INA-CBG : Q-5-44-0 PENYAKIT KRONIS KECIL LAIN-LAIN Rp 188,700.00", "Total Tarif : Rp 188,700.00", "Generated : E-Klaim 5.10.9 @ 2026-01-02 10:00:00 Lembar 1 / 1"];
  }
  function sep(o) {
    return [o.sep + " No. SEP : 01/01/2026 Tgl. SEP :", o.kartu + " ( MR : " + o.rm + " ) No. Kartu :", ": " + o.nama + " Nama Peserta Tgl. Lahir 01/01/1986", "No.Telepon 080000000000 Penyakit Dalam Sub/Spesialis", "SURAT ELEGIBILITAS PESERTA RS UJI SINTETIS", "Diagnosa Awal : Dyspepsia Jns. Rawat : " + (o.inap ? "Rawat Inap" : "Rawat Jalan"), "*Saya menyetujui BPJS Kesehatan menggunakan informasi medis pasien jika diperlukan."];
  }
  function resume(o) {
    var judul = o.inap ? "RINGKASAN PULANG" : "RESUME MEDIS PASIEN";
    return [judul + " RS UJI SINTETIS Jl. Contoh No. 1", "Nama Pasien : " + o.nama + " Umur : 40 th Ruang : Klinik Penyakit Dalam", "No. Rekam Medis : " + o.rm + " Tgl Lahir : 01-01-1986", "Keluhan utama : nyeri ulu hati sejak tiga hari", "Jalannya penyakit selama perawatan : membaik setelah terapi",
      "Diagnosa utama : Dispepsia " + (o.tanpaIcd ? "" : "Kode ICD ( K30 )"), "Diagnosa sekunder : -", "Kondisi pasien pulang : hidup, membaik", "Dokter penanggung jawab : dr. Uji Sintetis"];
  }
  function riwayat(o) {
    return ["RS UJI SINTETIS Jl. Contoh No. 1", "RIWAYAT PERAWATAN No.RM : " + (o.rmRiwayat || o.rm) + " Nama Pasien : " + o.nama, "Unit/Poliklinik : Klinik Penyakit Dalam Cara Bayar : BPJS Kesehatan", "Biaya & Perawatan : Administrasi : 30,000", "Tindakan Rawat Jalan Dokter : Pemeriksaan oleh dokter spesialis 75,000",
      o.tanpaObat ? "Tindakan paramedis : -" : "Pemberian Obat/BHP/Alkes : Antasida 15 tab 3 x 1 3,540", "Total Biaya : 108,540", "Tanda Tangan/Verifikasi : dokter poli"];
  }
  function pasien(i, extra) {
    var base = { sep: "9999R00101" + "26V" + String(i).padStart(6, "0"), kartu: "000" + String(1000000000 + i), rm: String(110000 + i), nama: "PASIEN UJI " + i };
    Object.keys(extra || {}).forEach(function (k) { base[k] = extra[k]; });
    return base;
  }
  function berkas(o, lembar) { return pdfFile((o.namaFile || o.sep) + ".pdf", lembar); }

  LAB.ready(async function () {
    var lulus = [], gagal = [];
    function cek(nama, kondisi, detail) { (kondisi ? lulus : gagal).push(kondisi ? nama : nama + (detail !== undefined ? " -> " + JSON.stringify(detail) : "")); }
    function entri(o) { return files.find(function (e) { return e.name === (o.namaFile || o.sep) + ".pdf"; }); }
    function kurang(e) { return fileMissingItems(e).map(function (m) { return m.id; }).sort().join(","); }
    function catatan(e) { return fileConditionalNotes(e).map(function (m) { return m.id; }).sort().join(","); }

    autoOcrEnabled = false;
    // Uji-diri (?sabotase=1): aturan sengaja dirusak; uji HARUS melaporkan kegagalan.
    // Dipakai run-tests.ps1 untuk membuktikan bahwa uji ini memang bisa menangkap kerusakan.
    if (LAB.num("sabotase", 0) === 1) {
      categories.rs_jalan.items.forEach(function (item) { if (item.id === "resume_poli") item.keywords = ["judul yang tidak pernah ada"]; });
    }
    // Mode unggah sengaja "Rawat Inap": aplikasi harus mengoreksi kategori dari isi Berkas Klaim.
    currentEditorCat = "rs_inap";

    var p1 = pasien(1), p2 = pasien(2), p3 = pasien(3, { rmRiwayat: "999999" }), p4 = pasien(4, { tanpaIcd: true }),
      p5 = pasien(5, { inap: true }), p6 = pasien(6, { namaFile: "9999R0010126V777777" }), p7 = pasien(7), p8 = pasien(8, { tanpaObat: true }),
      p9 = pasien(9, { rmEklaim: "0" + String(110009) }), p1b = pasien(1, { namaFile: "salinan-" + pasien(1).sep });
    var unggahan = [
      berkas(p1, [eklaim(p1), sep(p1), resume(p1), riwayat(p1)]),            // lengkap
      berkas(p2, [eklaim(p2), sep(p2), riwayat(p2)]),                        // tanpa resume
      berkas(p3, [eklaim(p3), sep(p3), resume(p3), riwayat(p3)]),            // No. RM beda di halaman 4
      berkas(p4, [eklaim(p4), sep(p4), resume(p4), riwayat(p4)]),            // resume tanpa kode ICD
      berkas(p5, [eklaim(p5), sep(p5), resume(p5), riwayat(p5)]),            // rawat inap
      berkas(p6, [eklaim(p6), sep(p6), resume(p6), riwayat(p6)]),            // nama file != SEP di isi
      berkas(p7, [eklaim(p7), sep(p7), resume(p7), riwayat(p7), []]),        // ada halaman kosong (calon OCR)
      berkas(p8, [eklaim(p8), sep(p8), resume(p8), riwayat(p8)]),            // tanpa lembar obat
      berkas(p9, [eklaim(p9), sep(p9), resume(p9), riwayat(p9)]),            // No. RM e-klaim berawalan nol
      berkas(p1b, [eklaim(p1), sep(p1), resume(p1), riwayat(p1)]),           // SEP sama dengan p1, nama file lain
      new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])], "rusak.pdf", { type: "application/pdf", lastModified: stamp++ })
    ];
    var hasil = await processFilesBatch(unggahan);
    cek("semua berkas masuk antrean", hasil.added === 11 && files.length === 11, hasil);
    cek("tidak ada yang tertahan (pending)", files.every(function (e) { return !e.pending; }));
    cek("PDF tidak disalin ke browser", (await dbRequest(DB_BLOB_STORE, "readonly", function (s) { return s.count(); })) === 0);

    var e1 = entri(p1), e2 = entri(p2), e3 = entri(p3), e4 = entri(p4), e5 = entri(p5), e6 = entri(p6), e7 = entri(p7), e8 = entri(p8), e9 = entri(p9), e1b = entri(p1b);
    var rusak = files.find(function (e) { return e.name === "rusak.pdf"; });

    cek("kategori dikoreksi otomatis ke Rawat Jalan", e1.category === "rs_jalan" && e1.categoryAuto === true, [e1.category, e1.categoryAuto]);
    cek("berkas lengkap dinyatakan lengkap", kurang(e1) === "", kurang(e1));
    cek("dokumen kondisional jadi catatan, bukan kekurangan", catatan(e1) === "penunjang,rujukan", catatan(e1));
    cek("lembar obat dikenali sebagai resep", e1.itemsStatus.resep.source === "digital");
    cek("tanpa lembar obat -> resep masuk catatan", catatan(e8) === "penunjang,resep,rujukan" && kurang(e8) === "", [catatan(e8), kurang(e8)]);
    cek("resume hilang terdeteksi", kurang(e2) === "resume_poli", kurang(e2));
    cek("nomor SEP terbaca dari isi berkas", e1.sep === p1.sep, e1.sep);
    cek("No. RM acuan terbaca", e1.identity && e1.identity.rm === p1.rm, e1.identity);
    cek("berkas tanpa masalah tidak diberi peringatan identitas", identityWarnings(e2, findDuplicateSeps()).length === 0, identityWarnings(e2, findDuplicateSeps()));
    cek("No. RM berbeda ditandai pada halaman yang benar", e3.identity.rmMismatch.length === 1 && e3.identity.rmMismatch[0].page === 4 && e3.identity.rmMismatch[0].rm === "999999", e3.identity.rmMismatch);
    cek("No. RM berbeda tidak mengubah status lengkap", kurang(e3) === "");
    cek("nol di depan No. RM dianggap sama", e9.identity.rmMismatch.length === 0, e9.identity.rmMismatch);
    cek("resume tanpa kode ICD diberi peringatan", e4.itemsStatus.resume_poli.contentWarning === "icd", e4.itemsStatus.resume_poli);
    cek("resume berkode ICD tidak diberi peringatan", !e1.itemsStatus.resume_poli.contentWarning, e1.itemsStatus.resume_poli);
    cek("rawat inap tetap di kategori Rawat Inap", e5.category === "rs_inap", e5.category);
    cek("rawat inap: dokumen wajib yang hilang terdaftar", kurang(e5) === "consent,penunjang,sprin", kurang(e5));
    cek("nama file tidak cocok dengan SEP di isi -> ditandai", e6.identity.sepNameMismatch === true, e6.identity);
    cek("halaman kosong menjadi calon OCR", (e7.ocrCandidates || []).length === 1 && e7.ocrCandidates[0] === 4, e7.ocrCandidates);
    var ganda = findDuplicateSeps();
    cek("SEP ganda terdeteksi di kedua berkas", ganda.has(p1.sep) && identityWarnings(e1, ganda).length === 1 && identityWarnings(e1b, ganda).length === 1, Array.from(ganda));
    cek("berkas rusak gagal dibaca tanpa menghentikan yang lain", !!rusak.error && rusak.errorKind === "permanent", [rusak.error, rusak.errorKind]);

    // OCR tidak boleh merusak teks hasil baca maupun status, walaupun data analisis berkas itu
    // dilepas dari memori tepat ketika OCR sedang bersiap (terjadi saat OCR berjalan bersamaan
    // dengan pembacaan gelombang besar). Pelepasan dipancing terus-menerus selama OCR berjalan.
    var kurangSebelumOcr = kurang(e7), barisSebelum = (await dbGet(DB_ANALYSIS_STORE, e7.id)).digitalText.length;
    releaseEntryHeavyData(e7);
    var usik = setInterval(function () { releaseEntryHeavyData(e7); }, 1);
    try { await runOcr(e7, function () { }, evaluateFile, { automatic: false }); } finally { clearInterval(usik); }
    var tersimpan = await dbGet(DB_ANALYSIS_STORE, e7.id), baris = tersimpan.digitalText.split("\n"); if (baris[baris.length - 1] === "") baris.pop();
    cek("OCR selesai pada berkas ber-halaman kosong", e7.ocr.done === true && !e7.ocr.error, e7.ocr);
    cek("OCR tidak menghapus teks hasil baca yang tersimpan", tersimpan.digitalText.length === barisSebelum && baris.length === tersimpan.pageTexts.length, [tersimpan.digitalText.length, barisSebelum, baris.length, tersimpan.pageTexts.length]);
    cek("OCR tidak mengubah berkas lengkap menjadi tidak lengkap", kurang(e7) === kurangSebelumOcr, [kurang(e7), kurangSebelumOcr]);

    // Mesin OCR yang mati di tengah jalan tidak boleh membuat halaman gagal: halaman diulang di mesin lain.
    var kanvas = document.createElement("canvas"); kanvas.width = 300; kanvas.height = 120;
    var ktx = kanvas.getContext("2d"); ktx.fillStyle = "#fff"; ktx.fillRect(0, 0, 300, 120); ktx.fillStyle = "#000"; ktx.font = "40px Arial"; ktx.fillText("UJI 12345", 20, 75);
    var mesinPalsu = { worker: { recognize: function () { return Promise.reject(new Error("mesin tambahan mati")); }, terminate: function () { mesinPalsu.dimatikan = true; } }, barrier: Promise.resolve(), pending: -1 };
    await ensureTesseractWorker(); await recognizeCanvasWithTesseract(kanvas); // pastikan mesin utama terdaftar
    ocrEngineSlots.push(mesinPalsu);
    var hasilTambahan = null, galatTambahan = null;
    try { hasilTambahan = await recognizeCanvasWithTesseract(kanvas); } catch (err) { galatTambahan = String(err && err.message || err); }
    cek("mesin OCR tambahan mati -> halaman tetap terbaca di mesin lain", !!hasilTambahan && /12345/.test(hasilTambahan.data.text) && ocrEngineSlots.indexOf(mesinPalsu) < 0 && mesinPalsu.dimatikan === true, [galatTambahan, hasilTambahan && hasilTambahan.data.text]);
    var utama = ocrEngineSlots[0].worker;
    utama.recognize = function () { return Promise.reject(new Error("mesin utama mati")); };
    var hasilUtama = null, galatUtama = null;
    try { hasilUtama = await recognizeCanvasWithTesseract(kanvas); } catch (err) { galatUtama = String(err && err.message || err); }
    cek("mesin OCR utama mati -> dibuat ulang dan halaman tetap terbaca", !!hasilUtama && /12345/.test(hasilUtama.data.text) && ocrEngineSlots[0].worker !== utama, [galatUtama, hasilUtama && hasilUtama.data.text]);

    // unggah ulang berkas yang sama -> dilewati, bukan digandakan
    var ulang = await processFilesBatch([unggahan[0], unggahan[1]]);
    cek("unggah ulang berkas yang sama dilewati", ulang.added === 0 && ulang.skipped === 2 && files.length === 11, ulang);

    // pilihan kategori manual tidak boleh ditimpa
    e2.category = "rs_inap"; e2.categoryManual = true; e2.categoryAuto = false; await ensureAnalysisData(e2);
    cek("kategori pilihan pengguna tidak ditimpa deteksi otomatis", applyDetectedCategory(e2) === false && e2.category === "rs_inap");
    e2.category = "rs_jalan"; e2.categoryManual = false; evaluateFile(e2); releaseEntryHeavyData(e2);

    // tampilan dan filter
    resultFilter = "identity"; renderResults();
    cek("filter Peringatan identitas menampilkan berkas yang tepat", document.querySelectorAll("#results .file-card").length === 4, document.querySelectorAll("#results .file-card").length);
    resultFilter = "all"; renderResults();
    cek("nomor versi tampil di layar", /^v\d+\.\d+\.\d+/.test(document.getElementById("appVersion").textContent), document.getElementById("appVersion").textContent);

    // laporan
    var rows = verificationReportRows();
    var r1 = rows.find(function (r) { return r.name === e1.name; }), r2 = rows.find(function (r) { return r.name === e2.name; }), r3 = rows.find(function (r) { return r.name === e3.name; }), rr = rows.find(function (r) { return r.name === "rusak.pdf"; });
    cek("laporan: semua berkas tercantum", rows.length === 11, rows.length);
    cek("laporan: No. RM di kolom tersendiri", r1.rm === p1.rm, r1.rm);
    cek("laporan: berkas tidak lengkap menyebut dokumennya", r2.keterangan !== "Lengkap" && /Resume/.test(r2.rincian), [r2.keterangan, r2.rincian]);
    cek("laporan: peringatan identitas di kolom tersendiri", /999999/.test(r3.identitas) && !/999999/.test(r3.rincian), [r3.identitas, r3.rincian]);
    cek("laporan: berkas rusak berstatus Gagal Baca", rr.keterangan === "Gagal Baca", rr.keterangan);
    try {
      var Zip = await ensureZipEngine(), blob = await buildVerificationWorkbook(rows, Zip), zip = await Zip.loadAsync(blob);
      var sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
      cek("Excel terbentuk dan XML-nya sah", blob.size > 2000 && !new DOMParser().parseFromString(sheet, "application/xml").querySelector("parsererror"), blob.size);
      cek("Excel memuat nomor versi aplikasi", sheet.indexOf("SIPEKA Klaim v" + SIPEKA_VERSION) >= 0);
    } catch (err) { cek("Excel terbentuk dan XML-nya sah", false, String(err && err.message || err)); }

    // browser dibuka ulang: hasil tetap ada, PDF terlepas, lalu terpasang kembali tanpa duplikat
    var lengkapSebelum = files.filter(function (e) { return !e.error && fileMissingItems(e).length === 0; }).length;
    files = (await dbGetAll(DB_ACTIVE_STORE)).map(rebuildEntry); refreshKnownFingerprints();
    cek("setelah buka ulang: jumlah berkas sama", files.length === 11, files.length);
    cek("setelah buka ulang: hasil pemeriksaan sama", files.filter(function (e) { return !e.error && fileMissingItems(e).length === 0; }).length === lengkapSebelum);
    cek("setelah buka ulang: PDF berstatus belum terpasang", files.filter(function (e) { return e.sourceOnly && !e.blob; }).length === 11);
    var pasang = await processFilesBatch(unggahan);
    cek("pilih ulang berkas: terpasang kembali tanpa duplikat", pasang.added === 0 && files.length === 11 && files.filter(function (e) { return e.sourceOnly && !e.blob; }).length === 0, pasang);

    // arsip: hasil tetap ikut laporan
    await archiveFiles(files.filter(function (e) { return !e.error; }).slice(0, 3));
    cek("arsip: berkas pindah ke hasil tersimpan", archivedFiles.length === 3 && files.length === 8, [archivedFiles.length, files.length]);
    cek("arsip: laporan tetap memuat semua berkas", verificationReportRows().length === 11, verificationReportRows().length);

    // OCR berkas scan banyak halaman tidak boleh gagal bila, selama OCR berjalan, bagian lain
    // aplikasi menutup dokumen PDF berkas itu (pengguna membuka/menutup kartu lain, pindah menu,
    // atau pembacaan berkas itu baru saja selesai). Dulu: "Cannot read properties of null (reading 'getPage')".
    var pScan = pasien(20);
    await processFilesBatch([berkas(pScan, [eklaim(pScan), sep(pScan), resume(pScan), riwayat(pScan), [], [], []])]);
    var eScan = entri(pScan), lain = files.find(function (e) { return e !== eScan && !e.error; });
    var ganggu = setInterval(function () { closeAllActivePreviews(lain); if (eScan.pdfDoc) { try { eScan.pdfDoc.destroy(); } catch (x) { } eScan.pdfDoc = null; } }, 1);
    try { await runOcr(eScan, function () { }, evaluateFile, { automatic: false }); } finally { clearInterval(ganggu); }
    cek("OCR 3 halaman tuntas walau dokumen PDF berkas ditutup bagian lain", eScan.ocr.done === true && !eScan.ocr.error && eScan.ocr.processedPages.length === 3, [eScan.ocr.done, eScan.ocr.error, eScan.ocr.processedPages]);
    cek("berkas itu tetap lengkap setelah OCR", kurang(eScan) === "", kurang(eScan));

    // PDF asal hilang dari lokasinya setelah dipilih (dipindah, diganti nama, dihapus, flashdisk dilepas).
    // Browser lalu menolak membacanya dengan NotFoundError. Dulu OCR mencatat "Gagal memuat ulang berkas
    // untuk OCR: A requested file or directory could not be found..." dan memilih ulang berkas yang sama
    // dianggap duplikat sehingga berkas itu tidak bisa dipulihkan.
    var autoSemula = autoOcrEnabled; autoOcrEnabled = false;
    function berkasHilang(f) {
      var gagalBaca = function () { return Promise.reject(new DOMException("A requested file or directory could not be found at the time an operation was processed.", "NotFoundError")); };
      return { name: f.name, size: f.size, type: f.type, lastModified: f.lastModified, slice: function () { return { arrayBuffer: gagalBaca }; }, arrayBuffer: gagalBaca };
    }
    var pHilang = pasien(21), fHilang = berkas(pHilang, [eklaim(pHilang), sep(pHilang), resume(pHilang), riwayat(pHilang), [], []]);
    await processFilesBatch([fHilang]);
    var eHilang = entri(pHilang);
    eHilang.blob = berkasHilang(fHilang);
    await runOcr(eHilang, function () { }, evaluateFile, { automatic: false });
    cek("PDF asal hilang: OCR tidak dicatat gagal", !eHilang.ocr.error, eHilang.ocr.error);
    cek("PDF asal hilang: berkas berstatus menunggu PDF dipilih ulang", entryAwaitsSourcePdf(eHilang) && !eHilang.ocr.done, [entryAwaitsSourcePdf(eHilang), eHilang.ocr.done]);
    var pasangHilang = await processFilesBatch([fHilang]);
    cek("PDF asal hilang: pilih ulang berkas yang sama memasangnya kembali", pasangHilang.reattached === 1 && pasangHilang.added === 0, pasangHilang);
    await runOcr(eHilang, function () { }, evaluateFile, { automatic: false });
    cek("PDF asal hilang: OCR tuntas setelah dipilih ulang", eHilang.ocr.done === true && !eHilang.ocr.error && eHilang.ocr.processedPages.length === 2, [eHilang.ocr.done, eHilang.ocr.error, eHilang.ocr.processedPages]);
    // Baca ulang berkas yang PDF-nya hilang: galat jelas, lalu pulih setelah dipilih ulang.
    eHilang.blob = berkasHilang(fHilang);
    await retryActiveEntryAnalysis(eHilang);
    cek("PDF asal hilang saat baca ulang: pesan menyuruh pilih ulang", /pilih ulang/i.test(eHilang.error || "") && entryAwaitsSourcePdf(eHilang), [eHilang.error, entryAwaitsSourcePdf(eHilang)]);
    var pasangUlang = await processFilesBatch([fHilang]);
    cek("PDF asal hilang saat baca ulang: pulih setelah dipilih ulang", pasangUlang.reattached === 1 && !eHilang.error && !eHilang.pending && kurang(eHilang) === "", [pasangUlang, eHilang.error, eHilang.pending, kurang(eHilang)]);

    // Pilih ulang berkas yang sama tetapi waktu ubahnya berbeda (disalin lewat flashdisk FAT32/exFAT,
    // diunduh/disalin ulang, diekstrak lagi dari ZIP). Dulu dianggap berkas baru: kartu lama tetap
    // "PDF asal belum terpasang" dan muncul kartu kembar.
    function lepas(e) { e.blob = null; e.sourceMissing = true; }
    function salinan(f, opsi) { opsi = opsi || {}; var g = new File([f], f.name, { type: f.type, lastModified: opsi.lastModified || f.lastModified }); if (opsi.relPath) Object.defineProperty(g, "webkitRelativePath", { value: opsi.relPath }); return g; }
    var jumlahSebelum = files.length;
    lepas(eHilang);
    var pasangWaktu = await processFilesBatch([salinan(fHilang, { lastModified: fHilang.lastModified + 2000 })]);
    cek("pilih ulang dengan waktu ubah berbeda: terpasang kembali, bukan berkas baru", pasangWaktu.reattached === 1 && pasangWaktu.added === 0 && files.length === jumlahSebelum && !entryAwaitsSourcePdf(eHilang), [pasangWaktu, files.length - jumlahSebelum, entryAwaitsSourcePdf(eHilang)]);
    // Berkas yang sama pernah masuk dua kali (mis. sekali lewat Sampling dengan jalur folder, sekali
    // diunggah langsung). Satu kali pilih ulang harus memasang keduanya.
    var pKembar = pasien(22), fKembar = berkas(pKembar, [eklaim(pKembar), sep(pKembar), resume(pKembar), riwayat(pKembar)]);
    await processFilesBatch([salinan(fKembar, { relPath: "SAMPLING/" + fKembar.name })]);
    await processFilesBatch([fKembar]);
    var kembar = files.filter(function (e) { return e.name === fKembar.name; });
    cek("berkas kembar: memang tercatat dua kali", kembar.length === 2, kembar.length);
    kembar.forEach(lepas);
    jumlahSebelum = files.length;
    var pasangKembar = await processFilesBatch([fKembar]);
    cek("berkas kembar: satu kali pilih ulang memasang keduanya", pasangKembar.reattached === 2 && pasangKembar.added === 0 && files.length === jumlahSebelum && kembar.every(function (e) { return !entryAwaitsSourcePdf(e); }), [pasangKembar, kembar.map(entryAwaitsSourcePdf)]);
    // Pengaman: nama sama tetapi ukuran berbeda = isi berbeda; tidak boleh dipasangkan ke kartu lama.
    lepas(eHilang);
    var beda = new File([fHilang, new Uint8Array([10, 37, 37, 69, 79, 70, 10])], fHilang.name, { type: "application/pdf", lastModified: fHilang.lastModified });
    var pasangBeda = await processFilesBatch([beda]);
    cek("nama sama, ukuran berbeda: tidak dipasangkan ke kartu lama", pasangBeda.reattached === 0 && entryAwaitsSourcePdf(eHilang), [pasangBeda, entryAwaitsSourcePdf(eHilang)]);
    cek("nama sama, ukuran berbeda: pengguna diberi tahu", pasangBeda.sameNameNew === 1 && /Perhatian: 1 berkas bernama sama/.test(document.getElementById("progressLine").textContent), [pasangBeda.sameNameNew, document.getElementById("progressLine").textContent]);
    autoOcrEnabled = autoSemula;

    await LAB.send({ uji: "sintetis", lulus: lulus.length, gagal: gagal, total: lulus.length + gagal.length, versi: SIPEKA_VERSION });
  });
})();
