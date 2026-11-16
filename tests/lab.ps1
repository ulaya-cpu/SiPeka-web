param(
  [Parameter(Mandatory=$true)][string]$Test,
  [string]$Query='',
  [int]$TimeoutSec=420,
  [int]$Port=8765,
  [string[]]$Pdfs=@(),
  [switch]$Offline
)
# Laboratorium uji SIPEKA.
# Melayani aplikasi lewat http://localhost (sama seperti di situs: worker PDF asli, jam nyata),
# menyajikan PDF uji, menjalankan Edge tanpa tampilan, lalu menunggu halaman mengirim hasil ke /result.
# Keluaran: satu baris JSON hasil uji, atau teks "TIDAK ADA HASIL ..." bila waktu habis.
$here=$PSScriptRoot
$appDir=Split-Path $here -Parent
$work=Join-Path $env:TEMP 'sipeka-uji'
New-Item -ItemType Directory -Force $work | Out-Null
$edge=@("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe","$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe","$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if(-not $edge){ 'TIDAK ADA HASIL: Edge/Chrome tidak ditemukan'; return }
$profile=Join-Path $work 'profil-peramban'
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
$listener=New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try{ $listener.Start() }catch{ "TIDAK ADA HASIL: port $Port tidak bisa dipakai ($($_.Exception.Message))"; return }
$mime=@{'.html'='text/html; charset=utf-8';'.js'='application/javascript; charset=utf-8';'.css'='text/css; charset=utf-8';'.pdf'='application/pdf';'.json'='application/json';'.gz'='application/gzip'}
function Send-Bytes($ctx,[byte[]]$bytes,[string]$type,[int]$code=200){
  try{
    $ctx.Response.StatusCode=$code
    if($type){ $ctx.Response.ContentType=$type }
    $ctx.Response.Headers['Cache-Control']='no-store'
    $ctx.Response.ContentLength64=$bytes.Length
    $ctx.Response.OutputStream.Write($bytes,0,$bytes.Length)
    $ctx.Response.OutputStream.Close()
  }catch{}
}
$flags=@('--headless=new','--disable-gpu','--no-first-run','--disable-extensions',"--user-data-dir=`"$profile`"")
# Mode luring: semua host selain localhost dibuat tidak dapat dihubungi.
if($Offline){ $flags+='--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"' }
$flags+="`"http://localhost:$Port/app/index.html?$Query`""
$proc=Start-Process -FilePath $edge -ArgumentList $flags -PassThru -NoNewWindow -RedirectStandardError (Join-Path $work 'peramban-err.txt') -RedirectStandardOutput (Join-Path $work 'peramban-out.txt')
$result=$null; $pending=$null; $deadline=(Get-Date).AddSeconds($TimeoutSec)
try{
  while($null -eq $result -and (Get-Date) -lt $deadline){
    # Satu permintaan tertunda dipertahankan antar putaran; membuat yang baru tiap putaran membuat permintaan hilang.
    if($null -eq $pending){ $pending=$listener.BeginGetContext($null,$null) }
    if(-not $pending.AsyncWaitHandle.WaitOne(1000)){ continue }
    $ctx=$listener.EndGetContext($pending); $pending=$null
    $path=[Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if($path -eq '/result' -and $ctx.Request.HttpMethod -eq 'POST'){
      $reader=New-Object IO.StreamReader($ctx.Request.InputStream,[Text.Encoding]::UTF8)
      $result=$reader.ReadToEnd()
      Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes('ok')) 'text/plain'
    }elseif($path -eq '/app/index.html'){
      # Skrip uji disisipkan sebagai berkas terpisah; skrip sebaris diblokir oleh CSP aplikasi.
      $html=[IO.File]::ReadAllText((Join-Path $appDir 'index.html'),[Text.Encoding]::UTF8)
      $html=[regex]::Replace($html,'<script src="\./app\.js[^"]*"></script>','<script src="/lab/halaman/pra.js"></script><script src="./app.js"></script><script src="/lab/halaman/umum.js"></script><script src="/lab/'+$Test+'"></script>')
      Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes($html)) $mime['.html']
    }elseif($path -like '/app/*'){
      $file=Join-Path $appDir ($path.Substring(5))
      if((Test-Path -LiteralPath $file -PathType Leaf) -and ([IO.Path]::GetFullPath($file)).StartsWith($appDir)){ Send-Bytes $ctx ([IO.File]::ReadAllBytes($file)) $mime[[IO.Path]::GetExtension($file).ToLower()] }
      else{ Send-Bytes $ctx ([byte[]]@()) 'text/plain' 404 }
    }elseif($path -like '/lab/*'){
      $file=Join-Path $here ($path.Substring(5))
      if((Test-Path -LiteralPath $file -PathType Leaf) -and ([IO.Path]::GetFullPath($file)).StartsWith($here)){ Send-Bytes $ctx ([IO.File]::ReadAllBytes($file)) $mime['.js'] }
      else{ Send-Bytes $ctx ([byte[]]@()) 'text/plain' 404 }
    }elseif($path -like '/pdf/*'){
      $index=-1; [void][int]::TryParse($path.Substring(5),[ref]$index)
      if($index -ge 0 -and $index -lt $Pdfs.Count){
        $ctx.Response.Headers['X-File-Name']=[Uri]::EscapeDataString([IO.Path]::GetFileName($Pdfs[$index]))
        Send-Bytes $ctx ([IO.File]::ReadAllBytes($Pdfs[$index])) $mime['.pdf']
      }else{ Send-Bytes $ctx ([byte[]]@()) 'text/plain' 404 }
    }else{ Send-Bytes $ctx ([byte[]]@()) 'text/plain' 404 }
  }
}finally{
  $listener.Stop(); $listener.Close()
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
  Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
}
if($null -eq $result){ "TIDAK ADA HASIL dalam $TimeoutSec detik" } else { $result }
