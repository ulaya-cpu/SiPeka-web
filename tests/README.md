# Uji mutu SIPEKA

Satu perintah, dijalankan sebelum setiap perubahan dirilis:

```
powershell -ExecutionPolicy Bypass -File tests\run-tests.ps1
```

Hasil akhir `RINGKASAN: semua ... uji LULUS` berarti boleh dirilis. Bila ada `GAGAL`, jangan dirilis.

## Yang diuji

| No | Uji | Data | Yang dijaga |
| --- | --- | --- | --- |
| 1 | Logika inti | PDF rekaan dibuat di tempat, tanpa internet | Deteksi dokumen, kategori otomatis, catatan kondisional, identitas (No. RM, SEP ganda), berkas rusak, duplikat, buka-ulang, laporan Excel |
| 2 | Uji-diri | Sama, dengan aturan sengaja dirusak | Membuktikan uji no. 1 memang menangkap kerusakan |
| 3 | Regresi | PDF klaim asli (lokal) | Angka hasil harus sama persis dengan `acuan.json` |
| 4 | Folder Cadangan | PDF klaim asli (lokal) | Tidak ada PDF disalin, analisis berkelompok, pemulihan sesi, arsip |
| 5 | OCR | Berkas ber-halaman scan (lokal), tanpa internet | Mesin OCR lokal, teks dua jalur identik dengan satu jalur |

Uji 1 dan 2 selalu jalan. Uji 3 sampai 5 hanya jalan bila `tests\lokal.json` ada.

## Data pasien tidak boleh masuk repo

PDF klaim berisi data medis pasien. Repo ini hanya menyimpan angka acuan (`acuan.json`).
Lokasi PDF di komputer Anda ditulis di `tests\lokal.json`, yang sengaja tidak ikut ke repo
(lihat `.gitignore`). Salin `lokal.contoh.json` menjadi `lokal.json` lalu isi:

- `dataset`: nama set acuan di `acuan.json`
- `pdfDir`: folder berisi PDF klaim; uji memakai berkas pertama menurut urutan nama
- `scanFiles`: nama berkas di folder itu yang punya halaman hasil scan (minimal 10) untuk uji OCR

## Bila angka acuan memang harus berubah

Uji regresi gagal bila hasil pemeriksaan bergeser. Itu disengaja. Kalau perubahan memang
dimaksudkan mengubah hasil (misalnya aturan baru), periksa dulu selisihnya masuk akal, baru
perbarui `acuan.json` dalam commit yang sama dan sebutkan alasannya di pesan commit.

## Yang tidak tercakup uji otomatis

- Folder Cadangan di harddisk sungguhan (uji memakai penyimpanan browser yang perilakunya sama).
- Tampilan layar dan pengalaman pemakaian.
- Faskes selain yang ada di `acuan.json`.

## Cara kerja singkat

`lab.ps1` melayani aplikasi lewat `http://localhost`, menjalankan Edge tanpa tampilan, dan
menunggu halaman mengirim hasil. Skrip uji ada di `uji\`; pembantu halaman di `halaman\`.
