param([switch]$Cepat)
# UJI MUTU SIPEKA - satu perintah. Jalankan sebelum setiap perubahan dirilis:
#     powershell -ExecutionPolicy Bypass -File tests\run-tests.ps1
#     powershell -ExecutionPolicy Bypass -File tests\run-tests.ps1 -Cepat   (hanya uji tanpa data pasien)
# Kode keluar 0 = semua lulus; 1 = ada yang gagal.
$here=$PSScriptRoot
$hasil=New-Object System.Collections.ArrayList
function Catat([string]$nama,[bool]$lulus,[string]$rincian){ [void]$hasil.Add([pscustomobject]@{Uji=$nama;Hasil=$(if($lulus){'LULUS'}else{'GAGAL'});Rincian=$rincian}); Write-Host ("[{0}] {1}  {2}" -f $(if($lulus){'LULUS'}else{'GAGAL'}),$nama,$rincian) }
function Jalankan([string]$test,[string]$query,[string[]]$pdfs,[int]$batas,[switch]$luring){
  $raw = & "$here\lab.ps1" -Test $test -Query $query -Pdfs $pdfs -TimeoutSec $batas -Offline:$luring
  $teks = ($raw | Out-String).Trim()
  try{ return ($teks | ConvertFrom-Json) }catch{ return [pscustomobject]@{ tanpaHasil=$teks } }
}
function Bersih($o){ return (-not $o.tanpaHasil) -and (-not $o.exception) -and (@($o.errors).Count -eq 0) }
function Masalah($o){ if($o.tanpaHasil){ return $o.tanpaHasil }; if($o.exception){ return "galat uji: $($o.exception)" }; if(@($o.errors).Count){ return "galat halaman: $(@($o.errors) -join ' | ')" }; return '' }

Write-Host "== 1. Uji sintetis (tanpa data pasien, tanpa internet) =="
$s = Jalankan 'uji/sintetis.js' '' @() 180 -luring
$ok = (Bersih $s) -and (@($s.gagal).Count -eq 0) -and ($s.total -gt 0)
Catat 'Logika inti (PDF rekaan, luring)' $ok $(if($ok){"$($s.lulus) dari $($s.total) pemeriksaan, versi $($s.versi)"}else{ (Masalah $s) + ' ' + (@($s.gagal) -join ' || ') })

Write-Host "== 2. Uji-diri: aturan sengaja dirusak, uji harus menangkapnya =="
$d = Jalankan 'uji/sintetis.js' 'sabotase=1' @() 180 -luring
$ok = (-not $d.tanpaHasil) -and (@($d.gagal).Count -ge 1)
Catat 'Uji mampu menangkap kerusakan' $ok $(if($ok){"$(@($d.gagal).Count) kegagalan terdeteksi sesuai harapan"}else{'kerusakan yang disengaja TIDAK tertangkap: ' + (Masalah $d)})

$lokalFile=Join-Path $here 'lokal.json'
if($Cepat){ Write-Host "(-Cepat: uji data nyata dilewati)" }
elseif(-not (Test-Path $lokalFile)){ Write-Host "(tests\lokal.json tidak ada: uji data nyata dilewati. Lihat tests\README.md)" }
else{
  $lokal=Get-Content $lokalFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $acuanSemua=Get-Content (Join-Path $here 'acuan.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $acuan=$acuanSemua.($lokal.dataset)
  $pdfs=@()
  if(Test-Path -LiteralPath $lokal.pdfDir){ $pdfs=@(Get-ChildItem -LiteralPath $lokal.pdfDir -Filter *.pdf | Sort-Object Name | ForEach-Object FullName) }
  if(-not $acuan -or $pdfs.Count -lt $acuan.n){ Catat 'Data nyata tersedia' $false "dataset '$($lokal.dataset)' butuh $($acuan.n) PDF di $($lokal.pdfDir), ditemukan $($pdfs.Count)" }
  else{
    Write-Host "== 3. Regresi data nyata: $($acuan.n) PDF dalam satu gelombang, OCR menyala =="
    $r = Jalankan 'uji/regresi.js' "n=$($acuan.n)&ocr=1" ($pdfs | Select-Object -First $acuan.n) 900
    $beda=@()
    if(Bersih $r){ foreach($p in $acuan.harus.PSObject.Properties){ if([string]$r.($p.Name) -ne [string]$p.Value){ $beda += "$($p.Name): harus $($p.Value), dapat $($r.($p.Name))" } } }
    $ok = (Bersih $r) -and ($beda.Count -eq 0)
    Catat "Hasil pemeriksaan sama dengan acuan ($($lokal.dataset))" $ok $(if($ok){"baca $([math]::Round($r.readMs/1000,1)) dtk ($([math]::Round($r.readMs/$r.files)) ms/berkas), total $([math]::Round($r.totalMs/1000,1)) dtk, memori $($r.heapMB) MB"}else{ (Masalah $r) + ' ' + ($beda -join ' || ') })

    Write-Host "== 4. Folder Cadangan: 120 PDF, cadangkan, pulihkan, arsipkan =="
    $c = Jalankan 'uji/cadangan.js' 'n=120' ($pdfs | Select-Object -First 120) 600
    $ok = (Bersih $c) -and (@($c.gagal).Count -eq 0) -and ($c.total -gt 0)
    Catat 'Folder Cadangan dan pemulihan sesi' $ok $(if($ok){"$($c.lulus) dari $($c.total) pemeriksaan"}else{ (Masalah $c) + ' ' + (@($c.gagal) -join ' || ') })

    $scan=@($lokal.scanFiles | ForEach-Object { Join-Path $lokal.pdfDir $_ } | Where-Object { Test-Path -LiteralPath $_ })
    if($scan.Count -ge 10){
      $jumlah=[Math]::Min(30,$scan.Count)
      Write-Host "== 5. OCR: $jumlah berkas ber-halaman scan, satu jalur lalu dua jalur, tanpa internet =="
      $o = Jalankan 'uji/ocr.js' "n=$jumlah" ($scan | Select-Object -First $jumlah) 900 -luring
      $ok = (Bersih $o) -and ($o.teksIdentik -eq $o.files) -and ($o.satuJalur.galat -eq 0) -and ($o.duaJalur.galat -eq 0) -and $o.satuJalur.selesai -and $o.duaJalur.selesai -and $o.mesinLokal -and ($o.satuJalur.done -eq $o.files)
      Catat 'OCR luring, teks dua jalur identik dengan satu jalur' $ok $(if($ok){"$($o.teksIdentik)/$($o.files) identik, $($o.scanPages) halaman, $([math]::Round($o.satuJalur.ms/1000)) dtk -> $([math]::Round($o.duaJalur.ms/1000)) dtk (x$($o.percepatan))"}else{ (Masalah $o) + " identik=$($o.teksIdentik)/$($o.files) mesinLokal=$($o.mesinLokal) galat=$($o.satuJalur.galat)/$($o.duaJalur.galat)" })
      $jumlah2=[Math]::Min(40,$scan.Count)
      Write-Host "== 6. OCR bersamaan dengan pembacaan: $jumlah2 berkas, teks tersimpan harus utuh =="
      $k = Jalankan 'uji/ocr-bersamaan.js' "n=$jumlah2&batas=700" ($scan | Select-Object -First $jumlah2) 900 -luring
      $ok = (Bersih $k) -and $k.drained -and ($k.teksRusak -eq 0) -and ($k.tidakKonsisten -eq 0) -and ($k.ocrErrors -eq 0) -and ($k.failed -eq 0) -and ($k.files -eq $jumlah2)
      Catat 'OCR tidak merusak teks tersimpan maupun status' $ok $(if($ok){"$($k.files) berkas, $($k.ocrDone) di-OCR, 0 teks rusak, 0 status tidak konsisten"}else{ (Masalah $k) + " rusak=$($k.teksRusak) tidakKonsisten=$($k.tidakKonsisten) galatOcr=$($k.ocrErrors) $(@($k.contohRusak)+@($k.contohTidakKonsisten) -join ' || ')" })
    }else{ Write-Host "(scanFiles di lokal.json kurang dari 10 berkas: uji OCR dilewati)" }
  }
}
Write-Host ""
$gagal=@($hasil | Where-Object { $_.Hasil -eq 'GAGAL' })
if($gagal.Count){ Write-Host "RINGKASAN: $($gagal.Count) dari $($hasil.Count) uji GAGAL. Jangan dirilis." ; exit 1 }
Write-Host "RINGKASAN: semua $($hasil.Count) uji LULUS."
exit 0
