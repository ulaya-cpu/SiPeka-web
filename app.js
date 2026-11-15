
/* ---------------- Global stability guard ----------------
   Menangkap error tak terduga (mis. file korup, memori penuh) agar aplikasi
   tidak "diam-diam macet" tanpa pemberitahuan. Data yang sudah tersimpan di
   IndexedDB tidak ikut hilang hanya karena satu error render/proses gagal. */
let __lastGlobalErrorToast = 0;
function showGlobalErrorToast(msg){
  const now = Date.now();
  if(now - __lastGlobalErrorToast < 4000) return; // cegah spam notifikasi beruntun
  __lastGlobalErrorToast = now;
  let box = document.getElementById("globalErrorToast");
  if(!box){
    box = document.createElement("div");
    box.id = "globalErrorToast";
    box.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:min(520px,92vw);background:#3a1616;color:#fff;font:12.5px/1.5 'IBM Plex Mono',monospace;padding:10px 14px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.25);z-index:99999;";
    document.body.appendChild(box);
  }
  box.textContent = "Terjadi kendala teknis sementara: " + msg + " — data yang sudah tersimpan tetap aman. Coba ulangi, atau muat ulang halaman jika berlanjut.";
  box.style.display = "block";
  clearTimeout(box._hideTimer);
  box._hideTimer = setTimeout(()=>{ box.style.display="none"; }, 8000);
}
window.addEventListener("error", e=>{
  console.error("Uncaught error:", e.error||e.message);
  showGlobalErrorToast((e.error&&e.error.message)||e.message||"kesalahan tak dikenal");
});
window.addEventListener("unhandledrejection", e=>{
  console.error("Unhandled promise rejection:", e.reason);
  showGlobalErrorToast((e.reason&&e.reason.message)||String(e.reason||"kesalahan tak dikenal"));
});

const PDFJS_PRIMARY_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const PDFJS_FALLBACK_SCRIPT = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
const PDFJS_FALLBACK_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
const JSZIP_FALLBACK_SCRIPT = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
let pdfEnginePromise = null;
let zipEnginePromise = null;
let preferredPdfWorker = PDFJS_PRIMARY_WORKER;

function loadRuntimeScript(src,label,integrity){
  return new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    script.src=src;
    script.async=true;
    if(integrity){ script.integrity=integrity; script.crossOrigin="anonymous"; }
    script.dataset.runtimeFallback=label;
    script.onload=()=>resolve();
    script.onerror=()=>{ script.remove(); reject(new Error(`${label} tidak dapat dimuat. Periksa koneksi internet lalu buka ulang aplikasi.`)); };
    document.head.appendChild(script);
  });
}
function configurePdfEngine(workerSrc){
  if(!window.pdfjsLib) return false;
  preferredPdfWorker=workerSrc||preferredPdfWorker||PDFJS_PRIMARY_WORKER;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc=preferredPdfWorker;
  return true;
}
async function ensurePdfEngine(){
  if(window.pdfjsLib){ configurePdfEngine(preferredPdfWorker); return window.pdfjsLib; }
  if(!pdfEnginePromise){
    pdfEnginePromise=(async()=>{
      await loadRuntimeScript(PDFJS_FALLBACK_SCRIPT,"Mesin pembaca PDF","sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e");
      if(!window.pdfjsLib) throw new Error("Mesin pembaca PDF gagal diinisialisasi.");
      configurePdfEngine(PDFJS_FALLBACK_WORKER);
      return window.pdfjsLib;
    })().catch(err=>{ pdfEnginePromise=null; throw err; });
  }
  return pdfEnginePromise;
}
async function ensureZipEngine(){
  if(window.JSZip) return window.JSZip;
  if(!zipEnginePromise){
    zipEnginePromise=(async()=>{
      await loadRuntimeScript(JSZIP_FALLBACK_SCRIPT,"Mesin ekspor ZIP","sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG");
      if(!window.JSZip) throw new Error("Mesin ekspor ZIP gagal diinisialisasi.");
      return window.JSZip;
    })().catch(err=>{ zipEnginePromise=null; throw err; });
  }
  return zipEnginePromise;
}
if(window.pdfjsLib) configurePdfEngine(PDFJS_PRIMARY_WORKER);

/* ================= PENYIMPANAN OTOMATIS (IndexedDB) =================
   Checklist, daftar pasien, status centang, dan PDF disimpan otomatis sebagai
   lapisan cepat di browser. Karena penyimpanan browser tetap dapat dibersihkan
   oleh pengguna/sistem, Folder Cadangan di bawah menjadi lapisan pemulihan kedua. */
const DB_NAME = "verifikatorKlaimDB";
const DB_VERSION = 4;
const DB_STORE = "state";
const DB_ACTIVE_STORE = "activeFiles";
const DB_BLOB_STORE = "fileBlobs";
const DB_ANALYSIS_STORE = "analysisData";
const DB_RESULTS_STORE = "results";
const DB_MEDICINE_STORE = "medicineRecords";
const DB_KEY = "singleton";
let saveTimer = null;
let saveInFlight = false;
let saveAgainAfter = false;
let lastSaveError = null;
let activeStorageBarrier = Promise.resolve();
const dirtyActiveIds = new Set();
const dirtyAnalysisIds = new Set();
let workspaceDirHandle = null;
let workspaceSaveTimer = null;
let workspaceSaveInFlight = false;
let workspaceSaveAgain = false;
const workspaceSyncedPdfIds = new Set();
const workspaceSyncedAnalysisIds = new Set();
const workspaceDirtyAnalysisIds = new Set();
const workspaceDeletedIds = new Set();
const workspaceDeletedMedicineIds = new Set();
let autoOcrEnabled = true;
let medicineFiles=[];
let medicineCounter=0;
let medicinePage=1;
const MEDICINE_PAGE_SIZE=200;
let medicineImportQueue=Promise.resolve();
let medicineQueuedTasks=0;
let medicineExporting=false;
let medicineUploadPending=0;
let medicineStorageBarrier=Promise.resolve();
const deletedMedicineRecordIds=new Set();
let medicineSaveTimer=null;
const dirtyMedicineIds=new Set();

/* Versi 4 menambahkan penyimpanan hasil Obat per berkas, tetap terpisah dari PDF,
   konfigurasi, teks analisis, dan hasil final agar perubahan tabel tidak menulis ulang data berat. */
function dbOpenFresh(){
  return new Promise((resolve, reject)=>{
    if(!("indexedDB" in window) || !window.indexedDB){ reject(new Error("Penyimpanan lokal (IndexedDB) tidak tersedia di lingkungan ini.")); return; }
    let req;
    try{ req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch(err){ reject(err); return; }
    if(!req || typeof req.addEventListener!=="function"){
      reject(new Error("Penyimpanan lokal tidak didukung di lingkungan ini (mis. mode pratinjau).")); return;
    }
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      if(!db.objectStoreNames.contains(DB_ACTIVE_STORE)) db.createObjectStore(DB_ACTIVE_STORE);
      if(!db.objectStoreNames.contains(DB_BLOB_STORE)) db.createObjectStore(DB_BLOB_STORE);
      if(!db.objectStoreNames.contains(DB_ANALYSIS_STORE)) db.createObjectStore(DB_ANALYSIS_STORE);
      if(!db.objectStoreNames.contains(DB_RESULTS_STORE)) db.createObjectStore(DB_RESULTS_STORE);
      if(!db.objectStoreNames.contains(DB_MEDICINE_STORE)) db.createObjectStore(DB_MEDICINE_STORE);
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error || new Error("Gagal membuka penyimpanan."));
    req.onblocked = ()=> reject(new Error("Penyimpanan sedang dipakai tab lain, coba lagi sebentar."));
  });
}

function dbRequest(storeName, mode, action){
  return new Promise(async (resolve, reject)=>{
    let db;
    try{ db = await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx, request;
    try{
      tx = db.transaction(storeName, mode);
      request = action(tx.objectStore(storeName));
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete = ()=>{ db.close(); resolve(request && request.result!==undefined ? request.result : null); };
    tx.onerror = ()=>{ db.close(); reject(tx.error||new Error("Operasi penyimpanan gagal.")); };
    tx.onabort = ()=>{ db.close(); reject(tx.error||new Error("Penyimpanan penuh atau operasi dibatalkan.")); };
  });
}
function dbPut(storeName, key, value){ return dbRequest(storeName,"readwrite",store=>store.put(value,key)); }
function dbGet(storeName, key){ return dbRequest(storeName,"readonly",store=>store.get(key)); }
function dbGetAll(storeName){ return dbRequest(storeName,"readonly",store=>store.getAll()); }
function dbDelete(storeName, key){ return dbRequest(storeName,"readwrite",store=>store.delete(key)); }

function dbWriteActiveEntries(entries, includeBlobs){
  if(!entries.length) return Promise.resolve();
  return new Promise(async (resolve, reject)=>{
    let db;
    try{ db = await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx = db.transaction(includeBlobs ? [DB_ACTIVE_STORE,DB_BLOB_STORE] : [DB_ACTIVE_STORE], "readwrite");
      const activeStore = tx.objectStore(DB_ACTIVE_STORE);
      const blobStore = includeBlobs ? tx.objectStore(DB_BLOB_STORE) : null;
      entries.forEach(entry=>{
        activeStore.put(serializeEntry(entry, false), entry.id);
        if(blobStore && entry.blob) blobStore.put(entry.blob, entry.id);
      });
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete = ()=>{ db.close(); resolve(); };
    tx.onerror = ()=>{ db.close(); reject(tx.error||new Error("Gagal menyimpan antrean berkas.")); };
    tx.onabort = ()=>{ db.close(); reject(tx.error||new Error("Penyimpanan penuh atau operasi dibatalkan.")); };
  });
}

function serializeAnalysis(entry){
  return {
    digitalText:entry.digitalText||"",
    ocrText:entry.ocrText||"",
    ocrPageTexts:entry.ocrPageTexts||{},
    pageTexts:entry.pageTexts||[]
  };
}

function dbWriteAnalysisEntries(entries){
  if(!entries.length) return Promise.resolve();
  return new Promise(async (resolve,reject)=>{
    let db;
    try{ db=await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx=db.transaction(DB_ANALYSIS_STORE,"readwrite");
      const store=tx.objectStore(DB_ANALYSIS_STORE);
      entries.forEach(entry=>store.put(serializeAnalysis(entry),entry.id));
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete=()=>{ entries.forEach(entry=>{ entry.analysisStored=true; }); db.close(); resolve(); };
    tx.onerror=()=>{ db.close(); reject(tx.error||new Error("Gagal menyimpan hasil analisis PDF.")); };
    tx.onabort=()=>{ db.close(); reject(tx.error||new Error("Penyimpanan analisis dibatalkan.")); };
  });
}

function dbWritePayloadEntries(entries,includeBlobs,includeAnalysis){
  if(!entries.length||(!includeBlobs&&!includeAnalysis)) return Promise.resolve();
  return new Promise(async(resolve,reject)=>{
    let db;
    try{ db=await dbOpenFresh(); }catch(err){ reject(err); return; }
    const storeNames=[];
    if(includeBlobs) storeNames.push(DB_BLOB_STORE);
    if(includeAnalysis) storeNames.push(DB_ANALYSIS_STORE);
    let tx;
    try{
      tx=db.transaction(storeNames,"readwrite");
      const blobStore=includeBlobs?tx.objectStore(DB_BLOB_STORE):null;
      const analysisStore=includeAnalysis?tx.objectStore(DB_ANALYSIS_STORE):null;
      entries.forEach(entry=>{
        if(blobStore&&entry.blob) blobStore.put(entry.blob,entry.id);
        if(analysisStore&&entry._analysisLoaded) analysisStore.put(serializeAnalysis(entry),entry.id);
      });
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete=()=>{
      entries.forEach(entry=>{
        if(includeBlobs&&entry.blob) entry.blobStored=true;
        if(includeAnalysis&&entry._analysisLoaded) entry.analysisStored=true;
      });
      db.close(); resolve();
    };
    tx.onerror=()=>{ db.close(); reject(tx.error||new Error("Gagal menyimpan data berkas kolektif.")); };
    tx.onabort=()=>{ db.close(); reject(tx.error||new Error("Penyimpanan data berkas kolektif dibatalkan.")); };
  });
}

function dbDeletePayloadEntries(ids){
  if(!ids.length) return Promise.resolve();
  return new Promise(async(resolve,reject)=>{
    let db;
    try{ db=await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx=db.transaction([DB_BLOB_STORE,DB_ANALYSIS_STORE],"readwrite");
      const blobStore=tx.objectStore(DB_BLOB_STORE);
      const analysisStore=tx.objectStore(DB_ANALYSIS_STORE);
      ids.forEach(id=>{ blobStore.delete(id); analysisStore.delete(id); });
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete=()=>{ db.close(); resolve(); };
    tx.onerror=()=>{ db.close(); reject(tx.error||new Error("Gagal membersihkan penyimpanan berkas kolektif.")); };
    tx.onabort=()=>{ db.close(); reject(tx.error||new Error("Pembersihan berkas kolektif dibatalkan.")); };
  });
}

function serializeMedicineRecord(entry){
  return {
    id:entry.id,name:entry.name||"",order:Number(entry.order)||0,size:Number(entry.size)||0,
    lastModified:Number(entry.lastModified)||0,fingerprint:entry.fingerprint||"",
    pending:!!entry.pending,error:entry.error||null,participantName:entry.participantName||"",
    sep:entry.sep||"",source:entry.source||"",reviewNote:entry.reviewNote||"",createdAt:Number(entry.createdAt)||Date.now(),
    blobStored:!!entry.blobStored,externalStored:!!entry.externalStored,
    externalPdfFolder:entry.externalPdfFolder||"medicine-pdfs",
    externalFileName:entry.externalFileName||`${workspaceFileName(entry.id)}.pdf`,
    drugs:(entry.drugs||[]).map((drug,index)=>({
      id:drug.id||`${entry.id}_d${index}`,name:drug.name||"",quantity:drug.quantity||"",dose:drug.dose||""
    }))
  };
}

function rebuildMedicineRecord(row){
  const entry=Object.assign({},row);
  entry.pending=!!row.pending;
  entry.error=row.error||null;
  entry.participantName=row.participantName||"";
  entry.sep=row.sep||"";
  entry.drugs=(row.drugs||[]).map((drug,index)=>({
    id:drug.id||`${row.id}_d${index}`,name:drug.name||"",quantity:drug.quantity||"",dose:drug.dose||""
  }));
  entry.blob=null;
  entry.blobStored=!!row.blobStored;
  return entry;
}

function dbStageMedicineEntry(entry){
  return queueMedicineStorage(()=>new Promise(async(resolve,reject)=>{
    let db;
    try{ db=await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx=db.transaction([DB_MEDICINE_STORE,DB_BLOB_STORE],"readwrite");
      tx.objectStore(DB_MEDICINE_STORE).put(serializeMedicineRecord(Object.assign({},entry,{blobStored:!!entry.blob})),entry.id);
      if(entry.blob) tx.objectStore(DB_BLOB_STORE).put(entry.blob,entry.id);
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete=()=>{ entry.blobStored=!!entry.blob; db.close(); resolve(); };
    tx.onerror=()=>{ db.close(); reject(tx.error||new Error("Gagal menyimpan PDF Obat sementara.")); };
    tx.onabort=()=>{ db.close(); reject(tx.error||new Error("Penyimpanan PDF Obat dibatalkan.")); };
  }));
}

function queueMedicineStorage(task){
  const operation=medicineStorageBarrier.catch(()=>{}).then(task);
  medicineStorageBarrier=operation;
  return operation;
}

function dbSaveMedicineRecords(entries){
  if(!entries.length) return Promise.resolve();
  return queueMedicineStorage(()=>new Promise(async(resolve,reject)=>{
    let db;
    try{ db=await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx=db.transaction(DB_MEDICINE_STORE,"readwrite");
      const store=tx.objectStore(DB_MEDICINE_STORE);
      entries.filter(entry=>!deletedMedicineRecordIds.has(entry.id)).forEach(entry=>store.put(serializeMedicineRecord(entry),entry.id));
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete=()=>{ db.close(); resolve(); };
    tx.onerror=()=>{ db.close(); reject(tx.error||new Error("Gagal menyimpan hasil pemeriksaan Obat.")); };
    tx.onabort=()=>{ db.close(); reject(tx.error||new Error("Penyimpanan hasil Obat dibatalkan.")); };
  }));
}

function dbFinalizeMedicineEntry(entry){
  return queueMedicineStorage(()=>new Promise(async(resolve,reject)=>{
    let db;
    try{ db=await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx=db.transaction([DB_MEDICINE_STORE,DB_BLOB_STORE],"readwrite");
      const finalRow=serializeMedicineRecord(Object.assign({},entry,{blobStored:false}));
      tx.objectStore(DB_MEDICINE_STORE).put(finalRow,entry.id);
      tx.objectStore(DB_BLOB_STORE).delete(entry.id);
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete=()=>{ entry.blobStored=false;entry.blob=null;db.close();resolve(); };
    tx.onerror=()=>{ db.close(); reject(tx.error||new Error("Gagal menyelesaikan penyimpanan hasil Obat.")); };
    tx.onabort=()=>{ db.close(); reject(tx.error||new Error("Finalisasi hasil Obat dibatalkan.")); };
  }));
}

function dbDeleteMedicineEntries(ids){
  if(!ids.length) return Promise.resolve();
  ids.forEach(id=>deletedMedicineRecordIds.add(id));
  return queueMedicineStorage(()=>new Promise(async(resolve,reject)=>{
    let db;
    try{ db=await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx=db.transaction([DB_MEDICINE_STORE,DB_BLOB_STORE],"readwrite");
      const records=tx.objectStore(DB_MEDICINE_STORE),blobs=tx.objectStore(DB_BLOB_STORE);
      ids.forEach(id=>{ records.delete(id);blobs.delete(id); });
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete=()=>{ db.close();resolve(); };
    tx.onerror=()=>{ db.close();reject(tx.error||new Error("Gagal menghapus hasil Obat.")); };
    tx.onabort=()=>{ db.close();reject(tx.error||new Error("Penghapusan hasil Obat dibatalkan.")); };
  })).catch(err=>{ids.forEach(id=>deletedMedicineRecordIds.delete(id));throw err;});
}

function dbWriteResults(rows){
  if(!rows.length) return Promise.resolve();
  return new Promise(async (resolve,reject)=>{
    let db;
    try{ db=await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx=db.transaction(DB_RESULTS_STORE,"readwrite");
      const store=tx.objectStore(DB_RESULTS_STORE);
      rows.forEach(row=>store.put(row,row.id));
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete=()=>{ db.close(); resolve(); };
    tx.onerror=()=>{ db.close(); reject(tx.error||new Error("Gagal memulihkan hasil pemeriksaan.")); };
    tx.onabort=()=>{ db.close(); reject(tx.error||new Error("Pemulihan hasil dibatalkan.")); };
  });
}

function dbArchiveEntries(summaries, ids){
  if(!ids.length) return Promise.resolve();
  return new Promise(async (resolve, reject)=>{
    let db;
    try{ db = await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx = db.transaction([DB_RESULTS_STORE,DB_ACTIVE_STORE,DB_BLOB_STORE,DB_ANALYSIS_STORE],"readwrite");
      const resultStore = tx.objectStore(DB_RESULTS_STORE);
      const activeStore = tx.objectStore(DB_ACTIVE_STORE);
      const blobStore = tx.objectStore(DB_BLOB_STORE);
      const analysisStore = tx.objectStore(DB_ANALYSIS_STORE);
      summaries.forEach(row=>resultStore.put(row,row.id));
      ids.forEach(id=>{ activeStore.delete(id); blobStore.delete(id); analysisStore.delete(id); });
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete = ()=>{ db.close(); resolve(); };
    tx.onerror = ()=>{ db.close(); reject(tx.error||new Error("Gagal menyimpan hasil pemeriksaan.")); };
    tx.onabort = ()=>{ db.close(); reject(tx.error||new Error("Penyimpanan penuh atau operasi dibatalkan.")); };
  });
}

function dbClearApplicationData(){
  return new Promise(async (resolve, reject)=>{
    let db;
    try{ db = await dbOpenFresh(); }catch(err){ reject(err); return; }
    let tx;
    try{
      tx = db.transaction([DB_STORE,DB_ACTIVE_STORE,DB_BLOB_STORE,DB_ANALYSIS_STORE,DB_RESULTS_STORE,DB_MEDICINE_STORE],"readwrite");
      [DB_STORE,DB_ACTIVE_STORE,DB_BLOB_STORE,DB_ANALYSIS_STORE,DB_RESULTS_STORE,DB_MEDICINE_STORE].forEach(name=>tx.objectStore(name).clear());
    }catch(err){ db.close(); reject(err); return; }
    tx.oncomplete = ()=>{ db.close(); resolve(); };
    tx.onerror = ()=>{ db.close(); reject(tx.error||new Error("Gagal menghapus data.")); };
    tx.onabort = ()=>{ db.close(); reject(tx.error||new Error("Penghapusan data dibatalkan.")); };
  });
}

function serializeEntry(e, includeBlob, includeAnalysis){
  const row = {
    id:e.id, name:e.name, category:e.category, categoryManual:!!e.categoryManual, categoryAuto:!!e.categoryAuto,
    itemsStatus:e.itemsStatus||{}, open:!!e.open, pending:!!e.pending, error:e.error||null, errorKind:e.errorKind||null, sep:e.sep||"",
    fingerprint:e.fingerprint||"", order:Number.isFinite(e.order)?e.order:0,
    size:Number.isFinite(e.size)?e.size:0, lastModified:Number.isFinite(e.lastModified)?e.lastModified:0,
    blobStored:!!e.blobStored, analysisStored:!!e.analysisStored, sourceOnly:!!e.sourceOnly,
    externalStored:!!e.externalStored, externalAnalysisStored:!!e.externalAnalysisStored,
    externalPdfFolder:e.externalPdfFolder||"active-pdfs", externalFileName:e.externalFileName||`${e.id}.pdf`,
    ocrCandidates:Array.isArray(e.ocrCandidates)?e.ocrCandidates:[],
    identity:e.identity||null,
    rosterIndex: (typeof e.rosterIndex === "number") ? e.rosterIndex : undefined,
    ocr:{
      running:false,
      done:!!(e.ocr&&e.ocr.done),
      error:(e.ocr&&e.ocr.error)||null,
      progress:"",
      processedPages:Array.isArray(e.ocr&&e.ocr.processedPages) ? e.ocr.processedPages.slice() : [],
      automatic:!!(e.ocr&&e.ocr.automatic)
    }
  };
  if(includeAnalysis){
    row.digitalText=e.digitalText||"";
    row.ocrText=e.ocrText||"";
    row.ocrPageTexts=e.ocrPageTexts||{};
    row.pageTexts=e.pageTexts||[];
  }
  if(includeBlob) row.blob = e.blob || null;
  return row;
}

function buildSnapshot(){
  return {
    categories, kolektifCategories, currentEditorCat, activeView, autoOcrEnabled,
    fileCounter, batchCounter, medicineCounter, medicinePage,
    // Berkas per-file dan hasil final berada di object store terpisah agar snapshot tetap kecil.
    batches: batches.map(b=>({
      id:b.id, service:b.service, label:b.label, rosterText:b.rosterText, roster:b.roster,
      open:!!b.open, checklistEditorOpen:!!b.checklistEditorOpen,
      // PDF dan teks analisis kolektif memakai penyimpanan per berkas yang sama
      // dengan verifikasi utama; snapshot hanya membawa metadata ringan.
      patientFiles: b.patientFiles.map(e=>serializeEntry(
        e,
        !e.blobStored&&!e.externalStored,
        !e.analysisStored&&!e.externalAnalysisStored
      ))
    })),
    // File objek dari pemilih folder tidak bisa diandalkan setelah browser ditutup.
    // Metadata sampling tetap disimpan; saat dipulihkan pengguna cukup memilih ulang
    // folder asal dan aplikasi akan memasangkan PDF berdasarkan fingerprint.
    samplingFiles: samplingFiles.map(item=>({
      id:item.id, name:item.name, relPath:item.relPath||"", size:item.size||0,
      lastModified:item.lastModified||0, checked:false, fingerprint:item.fingerprint||"",
      originalOrder:Number.isFinite(item.originalOrder)?item.originalOrder:0, unavailable:!item.file&&!item.externalStored,
      externalStored:!!item.externalStored, externalPdfFolder:item.externalPdfFolder||"sampling-pdfs",
      externalFileName:item.externalFileName||`${workspaceFileName(item.id)}.pdf`
    })),
    samplingCounter, samplingSortMode, samplingPage, samplingThreshold:samplingThresholdKB(),
    savedAt: Date.now(), storageVersion:5
  };
}

function markEntryDirty(entry){
  if(entry && entry.id) dirtyActiveIds.add(entry.id);
  scheduleSave();
}

function markAnalysisDirty(entry){
  if(entry && entry.id){
    dirtyAnalysisIds.add(entry.id);
    workspaceDirtyAnalysisIds.add(entry.id);
  }
  scheduleSave();
}

async function flushDirtyActiveEntries(){
  if(dirtyActiveIds.size===0) return;
  const ids = Array.from(dirtyActiveIds);
  dirtyActiveIds.clear();
  const activeById = new Map(files.map(entry=>[entry.id,entry]));
  const rows = ids.map(id=>activeById.get(id)).filter(Boolean);
  const CHUNK = 200;
  for(let i=0;i<rows.length;i+=CHUNK) await dbWriteActiveEntries(rows.slice(i,i+CHUNK),false);
}

async function flushDirtyAnalysisEntries(){
  if(dirtyAnalysisIds.size===0) return;
  const ids=Array.from(dirtyAnalysisIds);
  dirtyAnalysisIds.clear();
  const activeById=new Map(files.map(entry=>[entry.id,entry]));
  const rows=ids.map(id=>activeById.get(id)).filter(entry=>entry&&entry._analysisLoaded);
  const CHUNK=100;
  try{
    for(let i=0;i<rows.length;i+=CHUNK) await dbWriteAnalysisEntries(rows.slice(i,i+CHUNK));
  }catch(err){
    rows.forEach(entry=>dirtyAnalysisIds.add(entry.id));
    throw err;
  }
}

async function persistState(){
  if(saveInFlight){ saveAgainAfter = true; return; }
  saveInFlight = true;
  try{
    await dbPut(DB_STORE, DB_KEY, buildSnapshot());
    await flushDirtyAnalysisEntries();
    await flushDirtyActiveEntries();
    await flushDirtyMedicineRecords();
    lastSaveError = null;
    updateSaveIndicator(true);
    if(workspaceDirHandle) scheduleWorkspaceBackup();
    return true;
  }catch(err){
    lastSaveError = err;
    console.warn("Gagal menyimpan data otomatis:", err);
    updateSaveIndicator(false, err);
    return false;
  }finally{
    saveInFlight = false;
    if(saveAgainAfter){ saveAgainAfter = false; persistState(); }
  }
}

function scheduleSave(delay){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistState, typeof delay==="number" ? delay : 900);
}
function saveNow(){ clearTimeout(saveTimer); persistState(); }

function updateSaveIndicator(ok, err){
  const el = document.getElementById("saveStatus");
  if(!el) return;
  if(ok){
    const t = new Date();
    el.innerHTML = `<span class="dot"></span> Tersimpan otomatis \u2022 ${t.toLocaleTimeString("id-ID")}`;
    el.classList.remove("save-err");
  }else{
    el.innerHTML = `<span class="dot"></span> Gagal menyimpan otomatis${err&&err.message?": "+escapeAttr(err.message):""}`;
    el.classList.add("save-err");
  }
}

async function loadSnapshot(){
  try{
    return await dbGet(DB_STORE, DB_KEY);
  }catch(err){
    console.warn("Gagal memuat data tersimpan:", err);
    updateSaveIndicator(false, err);
    return null;
  }
}

function compactPageText(value){
  const text=String(value||"");
  return text.trim().length<20 ? text : "#";
}

function rebuildEntry(stored){
  const entry = Object.assign({}, stored);
  entry.pdfDoc = null;
  entry.pending = !!stored.pending;
  const hasEmbeddedAnalysis = Object.prototype.hasOwnProperty.call(stored,"digitalText") ||
    Object.prototype.hasOwnProperty.call(stored,"pageTexts") || Object.prototype.hasOwnProperty.call(stored,"text");
  entry.digitalText = stored.digitalText||"";
  entry.ocrText = stored.ocrText || ((stored.ocr&&stored.ocr.done&&stored.text)?stored.text:"");
  entry.pageTexts = (stored.pageTexts||[]).map(compactPageText);
  entry.ocrPageTexts = (stored.ocrPageTexts && typeof stored.ocrPageTexts==="object") ? stored.ocrPageTexts : {};
  entry.ocrCandidates = Array.isArray(stored.ocrCandidates) ? stored.ocrCandidates :
    entry.pageTexts.map((text,idx)=>({text,idx})).filter(row=>row.text.trim().length<20).map(row=>row.idx);
  entry._analysisLoaded = hasEmbeddedAnalysis;
  entry.analysisStored = !!stored.analysisStored || hasEmbeddedAnalysis;
  delete entry.text;
  entry.itemsStatus = entry.itemsStatus || {};
  entry.ocr = entry.ocr || {running:false, done:false, error:null, progress:""};
  entry.ocr.running = false;
  entry.ocr.processedPages = Array.isArray(entry.ocr.processedPages) ? entry.ocr.processedPages : [];
  entry.ocr.automatic = !!entry.ocr.automatic;
  if(entry.blob){
    entry.blobStored = true;
    entry.objectUrl = ""; // URL dibuat secara lazy hanya ketika pratinjau dibuka.
  }else if(entry.blobStored){
    entry.objectUrl = "";
  }else if(entry.externalStored){
    entry.objectUrl="";
  }else if(entry.sourceOnly){
    // Hasil tetap utuh; PDF asal perlu dipilih ulang untuk pratinjau/OCR/baca ulang.
    entry.objectUrl="";
    entry.sourceMissing=true;
  }else{
    entry.objectUrl = "";
    entry.error = entry.error || "Berkas asli tidak tersimpan.";
  }
  return entry;
}

/* ================= CADANGAN FOLDER (FILE SYSTEM ACCESS API) =================
   IndexedDB tetap menjadi penyimpanan cepat utama. Folder cadangan adalah lapisan
   kedua yang eksplisit: PDF aktif disalin satu kali, sedangkan manifest/checklist
   ditulis ulang secara ringan. Manifest selalu ditulis paling akhir agar sesi yang
   terlihat pengguna tidak pernah menunjuk ke PDF yang belum selesai disalin. */
function delayMs(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

async function validatePdfBlob(blob,fileName){
  if(!blob || !Number.isFinite(blob.size) || blob.size<=0) throw new Error(`PDF ${fileName||""} kosong atau tidak tersedia.`);
  const head=new Uint8Array(await blob.slice(0,1024).arrayBuffer());
  let signature="";
  for(let i=0;i<head.length;i++) signature+=String.fromCharCode(head[i]);
  if(!signature.includes("%PDF-")) throw new Error(`Berkas ${fileName||""} bukan PDF yang valid.`);
  return true;
}

/* Satu "mesin baca" PDF dipakai bersama untuk semua berkas. Sebelumnya setiap PDF
   membuat worker baru; pada ratusan berkas hal ini menguras memori/CPU dan menjadi
   penyebab utama "gagal membaca PDF" secara acak. Worker diganti otomatis bila macet. */
let sharedPdfWorker=null;
let sharedPdfWorkerSrc="";
function getSharedPdfWorker(){
  const src=window.pdfjsLib.GlobalWorkerOptions.workerSrc||"";
  if(sharedPdfWorker && sharedPdfWorkerSrc===src && !sharedPdfWorker.destroyed) return sharedPdfWorker;
  if(sharedPdfWorker) retireSharedPdfWorker();
  sharedPdfWorker=new window.pdfjsLib.PDFWorker({name:"sipeka-pdf"});
  sharedPdfWorkerSrc=src;
  return sharedPdfWorker;
}
function retireSharedPdfWorker(){
  const old=sharedPdfWorker;
  sharedPdfWorker=null; sharedPdfWorkerSrc="";
  if(!old) return;
  // Worker lama baru dimatikan setelah semua dokumen yang masih memakainya ditutup
  // (mis. pratinjau yang sedang dibuka), dengan batas aman 5 menit untuk worker yang benar-benar macet.
  old._sipekaRetired=true;
  if(!old._sipekaDocs) destroyRetiredWorker(old);
  else old._sipekaKillTimer=setTimeout(()=>destroyRetiredWorker(old),300000);
}
function destroyRetiredWorker(worker){
  if(worker._sipekaKillTimer) clearTimeout(worker._sipekaKillTimer);
  try{ worker.destroy(); }catch(e){}
}
function trackPdfDocWorker(doc,worker){
  if(!doc||!worker) return doc;
  worker._sipekaDocs=(worker._sipekaDocs||0)+1;
  const originalDestroy=typeof doc.destroy==="function" ? doc.destroy.bind(doc) : null;
  let released=false;
  doc.destroy=function(){
    if(!released){
      released=true;
      worker._sipekaDocs=Math.max(0,(worker._sipekaDocs||1)-1);
      if(worker._sipekaRetired&&!worker._sipekaDocs) setTimeout(()=>destroyRetiredWorker(worker),0);
    }
    return originalDestroy ? originalDestroy() : Promise.resolve();
  };
  return doc;
}
function withTimeout(promise,ms,message){
  let timer=null;
  return Promise.race([
    promise,
    new Promise((_,reject)=>{ timer=setTimeout(()=>{ const e=new Error(message); e.code="TIMEOUT"; reject(e); },ms); })
  ]).finally(()=>{ if(timer!==null) clearTimeout(timer); });
}
function classifyPdfError(err){
  const name=(err&&err.name)||"";
  const msg=String((err&&err.message)||err||"");
  if(name==="PasswordException"||/password/i.test(msg))
    return {kind:"permanent",message:"PDF terkunci kata sandi. Buka kuncinya lalu unggah ulang."};
  if(name==="InvalidPDFException"||/bukan PDF yang valid|kosong atau tidak tersedia|Invalid PDF/i.test(msg))
    return {kind:"permanent",message:"Berkas PDF rusak atau bukan PDF yang valid."};
  if(/tidak ditemukan|tidak tersedia|izin folder|cadangan/i.test(msg))
    return {kind:"storage",message:`Berkas asli tidak dapat diambil: ${msg}`};
  if((err&&err.code==="TIMEOUT")||/batas waktu|tidak merespons/i.test(msg))
    return {kind:"transient",message:"Waktu baca habis (perangkat sedang sibuk). Bisa dimuat ulang."};
  return {kind:"transient",message:`Gagal membaca file: ${msg||"kesalahan tidak dikenal"}.`};
}

async function openPdfDocument(blob,fileName,timeoutMs){
  await ensurePdfEngine();
  await validatePdfBlob(blob,fileName);
  const limit=Math.max(30000,Number(timeoutMs)||120000);
  async function attempt(workerSrc){
    configurePdfEngine(workerSrc);
    const buffer=await blob.arrayBuffer();
    const pdfWorker=getSharedPdfWorker();
    const loadingTask=window.pdfjsLib.getDocument({data:buffer,isEvalSupported:false,stopAtErrors:false,worker:pdfWorker});
    let timeoutId=null;
    const timeoutPromise=new Promise((_,reject)=>{
      timeoutId=setTimeout(()=>{
        const e=new Error(`Pembacaan PDF ${fileName||""} melewati batas waktu ${Math.round(limit/1000)} detik.`);
        e.code="TIMEOUT"; reject(e);
      },limit);
    });
    try{ return trackPdfDocWorker(await Promise.race([loadingTask.promise,timeoutPromise]),pdfWorker); }
    catch(err){
      try{ await loadingTask.destroy(); }catch(e){}
      if(err&&(err.code==="TIMEOUT"||/worker/i.test(String(err.message||"")))) retireSharedPdfWorker();
      throw err;
    }
    finally{ if(timeoutId!==null) clearTimeout(timeoutId); }
  }
  try{
    return await attempt(window.pdfjsLib.GlobalWorkerOptions.workerSrc||PDFJS_PRIMARY_WORKER);
  }catch(err){
    const message=String(err&&err.message||err||"");
    const currentWorker=window.pdfjsLib.GlobalWorkerOptions.workerSrc||"";
    if(currentWorker!==PDFJS_FALLBACK_WORKER && /worker|fetch|network|loading|dynamically imported/i.test(message)){
      return await attempt(PDFJS_FALLBACK_WORKER);
    }
    throw err;
  }
}

async function destroyPdfDocument(pdfDoc){
  if(!pdfDoc) return;
  try{
    if(typeof pdfDoc.destroy==="function") await pdfDoc.destroy();
    else if(typeof pdfDoc.cleanup==="function") pdfDoc.cleanup();
  }catch(e){}
}

function boundedCanvasScale(width,height,desiredScale,maxDimension,maxPixels){
  const safeWidth=Math.max(1,Number(width)||1);
  const safeHeight=Math.max(1,Number(height)||1);
  const dimensionCap=Math.min(maxDimension/safeWidth,maxDimension/safeHeight);
  const pixelCap=Math.sqrt(maxPixels/(safeWidth*safeHeight));
  return Math.max(0.1,Math.min(desiredScale,dimensionCap,pixelCap));
}

function setWorkspaceStatus(message, warn){
  const el=document.getElementById("workspaceStatus");
  if(!el) return;
  el.textContent=message;
  el.classList.toggle("warn",!!warn);
}

function workspaceFileName(id){
  return String(id||"file").replace(/[^a-z0-9._-]+/gi,"_");
}

async function ensureWorkspacePermission(handle, requestPermission){
  if(!handle) return false;
  const options={mode:"readwrite"};
  try{
    if((await handle.queryPermission(options))==="granted") return true;
    if(requestPermission && (await handle.requestPermission(options))==="granted") return true;
  }catch(err){ console.warn("Izin folder cadangan tidak tersedia:",err); }
  return false;
}

async function getWorkspaceDirectory(folderName, create){
  if(!workspaceDirHandle) throw new Error("Folder cadangan belum terhubung.");
  return await workspaceDirHandle.getDirectoryHandle(folderName,{create:create!==false});
}

async function writeWorkspaceFile(directory, name, data){
  const handle=await directory.getFileHandle(name,{create:true});
  const writable=await handle.createWritable();
  try{ await writable.write(data); }
  finally{ await writable.close(); }
}

async function writeWorkspaceRootFile(name,data){
  if(!workspaceDirHandle) throw new Error("Folder cadangan belum terhubung.");
  await writeWorkspaceFile(workspaceDirHandle,name,data);
}

async function readWorkspaceRootJSON(name){
  if(!workspaceDirHandle) throw new Error("Folder cadangan belum terhubung.");
  const handle=await workspaceDirHandle.getFileHandle(name);
  const file=await handle.getFile();
  return JSON.parse(await file.text());
}

async function readWorkspaceBlob(folderName,fileName){
  if(!(await ensureWorkspacePermission(workspaceDirHandle,false))){
    throw new Error("Izin folder cadangan perlu diberikan kembali.");
  }
  const dir=await getWorkspaceDirectory(folderName,false);
  const handle=await dir.getFileHandle(fileName);
  return await handle.getFile();
}

// Berkas "baca langsung" (entry.sourceOnly) tidak punya salinan PDF. Referensi File hanya hidup
// selama sesi browser; setelah browser dibuka ulang PDF harus dipilih ulang agar terpasang kembali.
const SOURCE_MISSING_MESSAGE="PDF asal tidak tersedia di sesi ini. Pilih/unggah ulang berkas yang sama agar terpasang kembali (hasil pemeriksaan tetap tersimpan).";
async function getEntryBlobForBackup(entry){
  if(entry.blob) return entry.blob;
  if(entry.blobStored){
    const localBlob=await dbGet(DB_BLOB_STORE,entry.id);
    if(localBlob) return localBlob;
  }
  if(entry.externalStored && workspaceDirHandle){
    return await readWorkspaceBlob(entry.externalPdfFolder||"active-pdfs",entry.externalFileName||`${workspaceFileName(entry.id)}.pdf`);
  }
  if(entry.sourceOnly) throw new Error(SOURCE_MISSING_MESSAGE);
  throw new Error(`PDF ${entry.name||entry.id} tidak tersedia untuk dicadangkan.`);
}

function samplingMetadataRows(){
  return samplingFiles.map(item=>({
    id:item.id, name:item.name, relPath:item.relPath||"", size:item.size||0,
    lastModified:item.lastModified||0, checked:false, fingerprint:item.fingerprint||"",
    originalOrder:Number.isFinite(item.originalOrder)?item.originalOrder:0,
    unavailable:!item.file&&!item.externalStored, externalStored:!!item.externalStored,
    externalPdfFolder:item.externalPdfFolder||"sampling-pdfs",
    externalFileName:item.externalFileName||`${workspaceFileName(item.id)}.pdf`
  }));
}

async function getSamplingBlobForBackup(item){
  if(item.file) return item.file;
  if(item.externalStored && workspaceDirHandle){
    return await readWorkspaceBlob(item.externalPdfFolder||"sampling-pdfs",item.externalFileName||`${workspaceFileName(item.id)}.pdf`);
  }
  throw new Error(`PDF sampling ${item.name||item.id} tidak tersedia untuk dicadangkan.`);
}

function workspaceManifest(){
  const activeRows=files.map(entry=>{
    const row=serializeEntry(entry,false,false);
    row.blobStored=false;
    row.analysisStored=false;
    row.externalStored=!entry.sourceOnly;
    row.externalAnalysisStored=true;
    row.externalPdfFolder="active-pdfs";
    row.externalFileName=`${workspaceFileName(entry.id)}.pdf`;
    return row;
  });
  const batchRows=batches.map(batch=>({
    id:batch.id, service:batch.service, label:batch.label, rosterText:batch.rosterText,
    roster:batch.roster, open:!!batch.open, checklistEditorOpen:!!batch.checklistEditorOpen,
    patientFiles:batch.patientFiles.map(entry=>{
      const row=serializeEntry(entry,false,true);
      row.blobStored=false;
      row.analysisStored=false;
      row.externalStored=true;
      row.externalAnalysisStored=false;
      row.externalPdfFolder="batch-pdfs";
      row.externalFileName=`${workspaceFileName(batch.id)}--${workspaceFileName(entry.id)}.pdf`;
      return row;
    })
  }));
  return {
    format:"SIPEKA_SESSION", version:1, savedAt:Date.now(),
    appState:{
      categories, kolektifCategories, currentEditorCat, activeView, autoOcrEnabled,
      fileCounter, batchCounter, samplingCounter, samplingSortMode, samplingPage, medicineCounter, medicinePage,
      samplingThreshold:samplingThresholdKB(),
      batches:batchRows
    },
    activeFiles:activeRows,
    archivedFiles:archivedFiles.map(row=>Object.assign({},row)),
    samplingFiles:samplingMetadataRows(),
    medicineFiles:medicineFiles.map(serializeMedicineRecord)
  };
}

async function deleteWorkspaceEntryIfPresent(directory,name){
  try{ await directory.removeEntry(name); }
  catch(err){ if(err && err.name!=="NotFoundError") console.warn("Gagal membersihkan cadangan lama:",err); }
}

async function performWorkspaceBackup(){
  if(!(await ensureWorkspacePermission(workspaceDirHandle,false))){
    setWorkspaceStatus("Izin folder berakhir. Klik Hubungkan Folder Cadangan.",true);
    return false;
  }
  await activeStorageBarrier.catch(()=>{});
  const activePdfDir=await getWorkspaceDirectory("active-pdfs",true);
  const analysisDir=await getWorkspaceDirectory("analysis",true);
  const batchPdfDir=await getWorkspaceDirectory("batch-pdfs",true);
  const medicinePdfDir=await getWorkspaceDirectory("medicine-pdfs",true);
  const pendingMedicine=medicineFiles.filter(entry=>entry.pending||entry.error);
  const totalPdfs=files.length+pendingMedicine.length+batches.reduce((n,b)=>n+b.patientFiles.length,0);
  let copied=0;
  const activeExternalUpdates=[];
  let snapshotExternalStateChanged=false;

  for(const entry of files){
    if(entry.sourceOnly) continue; // dibaca langsung dari tempat asal: PDF tidak disalin ke folder cadangan
    const key=`active:${entry.id}`;
    const targetName=`${workspaceFileName(entry.id)}.pdf`;
    if(!workspaceSyncedPdfIds.has(key)){
      setWorkspaceStatus(`Mencadangkan PDF ${copied+1} dari ${Math.max(totalPdfs,1)}…`);
      const blob=await getEntryBlobForBackup(entry);
      await writeWorkspaceFile(activePdfDir,targetName,blob);
      workspaceSyncedPdfIds.add(key);
    }
    if(!entry.externalStored) activeExternalUpdates.push(entry);
    entry.externalStored=true;
    entry.externalPdfFolder="active-pdfs";
    entry.externalFileName=targetName;
    copied++;
    if(copied%25===0) await yieldToBrowser();
  }

  for(const batch of batches){
    for(const entry of batch.patientFiles){
      const key=`batch:${batch.id}:${entry.id}`;
      const targetName=`${workspaceFileName(batch.id)}--${workspaceFileName(entry.id)}.pdf`;
      if(!workspaceSyncedPdfIds.has(key)){
        setWorkspaceStatus(`Mencadangkan PDF ${copied+1} dari ${Math.max(totalPdfs,1)}…`);
        const blob=await getEntryBlobForBackup(entry);
        await writeWorkspaceFile(batchPdfDir,targetName,blob);
        workspaceSyncedPdfIds.add(key);
      }
      if(!entry.externalStored) snapshotExternalStateChanged=true;
      entry.externalStored=true;
      entry.externalPdfFolder="batch-pdfs";
      entry.externalFileName=targetName;
      copied++;
      if(copied%25===0) await yieldToBrowser();
    }
  }

  // PDF Sampling TIDAK lagi disalin ke folder cadangan. Sampling hanya memerlukan nama dan
  // ukuran berkas; menyalin ribuan PDF (mis. 7.664 berkas = 10 GB) memakan waktu berjam-jam.
  // Yang dicadangkan hanya DAFTAR-nya (di sipeka-session.json). Setelah browser ditutup,
  // pengguna cukup memilih ulang folder asal dan berkas dipasangkan kembali lewat fingerprint.
  // Item dari cadangan lama yang PDF-nya sudah terlanjur tersalin (externalStored) tetap dapat dipakai.

  for(const entry of pendingMedicine){
    if(deletedMedicineRecordIds.has(entry.id)||(!entry.pending&&!entry.error))continue;
    const key=`medicine:${entry.id}`;
    const targetName=`${workspaceFileName(entry.id)}.pdf`;
    if(!workspaceSyncedPdfIds.has(key)){
      setWorkspaceStatus(`Mencadangkan PDF ${copied+1} dari ${Math.max(totalPdfs,1)}…`);
      let blob;
      try{blob=await getMedicineBlob(entry);}
      catch(err){
        if(!entry.pending&&!entry.error)continue;
        if(!entry.blobStored&&!entry.externalStored){console.warn("PDF Obat tidak tersedia untuk cadangan:",entry.name);continue;}
        throw err;
      }
      await writeWorkspaceFile(medicinePdfDir,targetName,blob);
      workspaceSyncedPdfIds.add(key);
    }
    if(deletedMedicineRecordIds.has(entry.id)||(!entry.pending&&!entry.error)){
      workspaceDeletedMedicineIds.add(entry.id);workspaceSyncedPdfIds.delete(key);continue;
    }
    entry.externalStored=true;
    entry.externalPdfFolder="medicine-pdfs";
    entry.externalFileName=targetName;
    entry.blob=null;
    copied++;
    if(copied%25===0) await yieldToBrowser();
  }

  for(let i=0;i<files.length;i++){
    const entry=files[i];
    const mustWrite=!workspaceSyncedAnalysisIds.has(entry.id)||workspaceDirtyAnalysisIds.has(entry.id);
    if(mustWrite){
      if(i%25===0) setWorkspaceStatus(`Menyimpan progres analisis ${i+1} dari ${files.length}…`);
      await ensureAnalysisData(entry);
      await writeWorkspaceFile(analysisDir,`${workspaceFileName(entry.id)}.json`,JSON.stringify(serializeAnalysis(entry)));
      workspaceSyncedAnalysisIds.add(entry.id);
      workspaceDirtyAnalysisIds.delete(entry.id);
      entry.externalAnalysisStored=true;
      releaseEntryHeavyData(entry);
    }
    if(i%100===0) await yieldToBrowser();
  }

  // Commit manifest setelah seluruh penambahan selesai. Penghapusan PDF lama dilakukan
  // sesudahnya, sehingga gangguan mendadak paling buruk hanya meninggalkan file yatim
  // dan tidak pernah membuat manifest lama menunjuk ke PDF yang sudah hilang.
  const manifest=workspaceManifest();
  await writeWorkspaceRootFile("sipeka-session.json",JSON.stringify(manifest,null,2));
  for(const id of Array.from(workspaceDeletedIds)){
    await deleteWorkspaceEntryIfPresent(activePdfDir,`${workspaceFileName(id)}.pdf`);
    await deleteWorkspaceEntryIfPresent(analysisDir,`${workspaceFileName(id)}.json`);
    workspaceDeletedIds.delete(id);
  }
  for(const id of Array.from(workspaceDeletedMedicineIds)){
    await deleteWorkspaceEntryIfPresent(medicinePdfDir,`${workspaceFileName(id)}.pdf`);
    workspaceDeletedMedicineIds.delete(id);
  }
  if(activeExternalUpdates.length){
    for(let i=0;i<activeExternalUpdates.length;i+=200) await dbWriteActiveEntries(activeExternalUpdates.slice(i,i+200),false);
  }
  if(snapshotExternalStateChanged) await dbPut(DB_STORE,DB_KEY,buildSnapshot());
  await dbPut(DB_STORE,"workspaceHandle",workspaceDirHandle);
  const stamp=new Date(manifest.savedAt).toLocaleString("id-ID");
  setWorkspaceStatus(`Cadangan lengkap • ${stamp}`);
  return true;
}

async function saveWorkspaceBackup(forceNow){
  clearTimeout(workspaceSaveTimer);
  if(!workspaceDirHandle) return false;
  if(workspaceSaveInFlight){
    workspaceSaveAgain=true;
    while(workspaceSaveInFlight) await delayMs(60);
    return forceNow ? saveWorkspaceBackup(true) : true;
  }
  workspaceSaveInFlight=true;
  try{
    let result=false;
    do{
      workspaceSaveAgain=false;
      result=await performWorkspaceBackup();
    }while(workspaceSaveAgain && result);
    return result;
  }catch(err){
    console.warn("Cadangan folder gagal:",err);
    setWorkspaceStatus(`Cadangan gagal: ${err.message||err}`,true);
    return false;
  }finally{
    workspaceSaveInFlight=false;
  }
}

function scheduleWorkspaceBackup(delay){
  if(!workspaceDirHandle) return;
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer=setTimeout(()=>saveWorkspaceBackup(false),typeof delay==="number"?delay:3000);
}

async function waitForGuaranteedLocalSave(){
  clearTimeout(saveTimer);
  if(medicineUploadPending) throw new Error("PDF Obat masih sedang disalin. Tunggu status unggahan selesai sebelum menutup aplikasi.");
  await activeStorageBarrier.catch(()=>{});
  await medicineStorageBarrier;
  while(saveInFlight) await delayMs(50);
  const ok=await persistState();
  while(saveInFlight) await delayMs(50);
  if(ok===false || lastSaveError) throw (lastSaveError||new Error("Penyimpanan lokal gagal."));
  return true;
}

function applyVisibleView(view){
  const safeView=["perfile","batch","sampling"].includes(view)?view:"perfile";
  // Pratinjau adalah pemakai RAM terbesar. Saat menu ditinggalkan, lepaskan
  // dokumen PDF/canvas yang tidak terlihat agar menu lain tetap ringan.
  if(safeView!=="perfile") closeAllActivePreviews();
  if(safeView!=="batch") closeAllBatchPreviews();
  activeView=safeView;
  document.querySelectorAll("#viewSwitch button").forEach(b=>b.classList.toggle("active",b.dataset.view===safeView));
  document.getElementById("perFileView").style.display=safeView==="perfile"?"":"none";
  document.getElementById("batchView").style.display=safeView==="batch"?"":"none";
  document.getElementById("samplingView").style.display=safeView==="sampling"?"":"none";
  document.getElementById("medicineView").style.display=safeView==="medicine"?"":"none";
}

async function restoreFromWorkspaceManifest(manifest){
  if(medicineBusy()) throw new Error("Tunggu proses Obat selesai sebelum memulihkan sesi.");
  if(!manifest || manifest.format!=="SIPEKA_SESSION" || manifest.version!==1){
    throw new Error("Folder ini tidak berisi cadangan SIPEKA yang valid.");
  }
  clearTimeout(saveTimer);
  clearTimeout(workspaceSaveTimer);
  clearTimeout(medicineSaveTimer);
  await medicineStorageBarrier.catch(()=>{});
  deletedMedicineRecordIds.clear();
  resetAutoOcrQueue();
  while(saveInFlight||workspaceSaveInFlight) await delayMs(60);
  files.forEach(closeEntryResources);
  batches.forEach(batch=>(batch.patientFiles||[]).forEach(closeEntryResources));
  await dbClearApplicationData();

  const state=manifest.appState||{};
  if(state.categories) categories=state.categories;
  if(state.kolektifCategories) kolektifCategories=state.kolektifCategories;
  currentEditorCat=state.currentEditorCat&&categories[state.currentEditorCat]?state.currentEditorCat:Object.keys(categories)[0];
  fileCounter=Number.isFinite(state.fileCounter)?state.fileCounter:0;
  batchCounter=Number.isFinite(state.batchCounter)?state.batchCounter:0;
  samplingCounter=Number.isFinite(state.samplingCounter)?state.samplingCounter:0;
  medicineCounter=Number.isFinite(state.medicineCounter)?state.medicineCounter:0;
  medicinePage=Math.max(1,Number(state.medicinePage)||1);
  samplingSortMode=["original","smallest","largest"].includes(state.samplingSortMode)?state.samplingSortMode:"original";
  samplingPage=Math.max(1,Number(state.samplingPage)||1);
  autoOcrEnabled=state.autoOcrEnabled!==false;
  applyBuiltInKeywordAliases();
  applyBuiltInContentChecks();
  if(Number.isFinite(Number(state.samplingThreshold))) document.getElementById("samplingThreshold").value=Number(state.samplingThreshold);

  files=(manifest.activeFiles||[]).map(row=>{
    const entry=rebuildEntry(Object.assign({},row,{blobStored:false,analysisStored:false,externalStored:!row.sourceOnly,externalAnalysisStored:true}));
    entry.error=row.error||null;
    return entry;
  });
  archivedFiles=(manifest.archivedFiles||[]).map(row=>Object.assign({},row));
  batches=(state.batches||[]).map(batch=>({
    id:batch.id, service:batch.service, label:batch.label, rosterText:batch.rosterText||"", roster:batch.roster||[],
    open:!!batch.open, checklistEditorOpen:!!batch.checklistEditorOpen,
    patientFiles:(batch.patientFiles||[]).map(row=>{
      const entry=rebuildEntry(Object.assign({},row,{blobStored:false,externalStored:true}));
      entry.error=row.error||null;
      return entry;
    })
  }));
  samplingFiles=(manifest.samplingFiles||[]).map(row=>Object.assign({},row,{file:null,checked:false,unavailable:!row.externalStored}));
  medicineFiles=(manifest.medicineFiles||[]).map(rebuildMedicineRecord);

  refreshKnownFingerprints();
  const maxOrder=[...files,...archivedFiles].reduce((max,row)=>Math.max(max,Number(row.order)||0),0);
  fileCounter=Math.max(fileCounter,maxOrder+1);
  if(files.length){
    for(let i=0;i<files.length;i+=200) await dbWriteActiveEntries(files.slice(i,i+200),false);
  }
  if(archivedFiles.length){
    for(let i=0;i<archivedFiles.length;i+=500) await dbWriteResults(archivedFiles.slice(i,i+500));
  }
  if(medicineFiles.length){
    for(let i=0;i<medicineFiles.length;i+=200) await dbSaveMedicineRecords(medicineFiles.slice(i,i+200));
  }
  await dbPut(DB_STORE,"workspaceHandle",workspaceDirHandle);
  await dbPut(DB_STORE,DB_KEY,buildSnapshot());

  workspaceSyncedPdfIds.clear();
  workspaceSyncedAnalysisIds.clear();
  workspaceDirtyAnalysisIds.clear();
  workspaceDeletedIds.clear();
  workspaceDeletedMedicineIds.clear();
  files.forEach(entry=>{ workspaceSyncedPdfIds.add(`active:${entry.id}`); workspaceSyncedAnalysisIds.add(entry.id); });
  batches.forEach(batch=>batch.patientFiles.forEach(entry=>workspaceSyncedPdfIds.add(`batch:${batch.id}:${entry.id}`)));
  samplingFiles.forEach(item=>{ if(item.externalStored) workspaceSyncedPdfIds.add(`sampling:${item.id}`); });
  medicineFiles.filter(entry=>(entry.pending||entry.error)&&entry.externalStored).forEach(entry=>workspaceSyncedPdfIds.add(`medicine:${entry.id}`));

  renderTabs();
  renderEditor();
  initModeSelect();
  renderResults();
  renderBatches();
  renderSamplingList();
  renderMedicineTable();
  applyVisibleView(state.activeView||"perfile");
  syncAutoOcrControls();
  enqueueAllPendingOcr();
  updateSaveIndicator(true);
  const banner=document.getElementById("restoreBanner");
  document.getElementById("restoreBannerText").textContent=`Sesi cadangan berhasil dipulihkan: ${files.length} berkas aktif, ${archivedFiles.length} hasil, ${samplingFiles.length} data sampling, dan ${medicineFiles.length} resep Obat.`;
  banner.style.display="flex";
  setWorkspaceStatus(`Sesi dipulihkan • ${new Date(manifest.savedAt||Date.now()).toLocaleString("id-ID")}`);
  if(files.some(entry=>entry.pending)) fileImportQueue=fileImportQueue.then(()=>resumeInterruptedFiles());
  if(batches.some(batch=>batch.patientFiles.some(entry=>entry.pending))) fileImportQueue=fileImportQueue.then(()=>resumeInterruptedBatchFiles());
  if(medicineFiles.some(entry=>entry.pending)) queueMedicineTask(()=>resumeInterruptedMedicineFiles());
}

async function readExistingWorkspaceManifest(){
  try{ return await readWorkspaceRootJSON("sipeka-session.json"); }
  catch(err){ if(err&&err.name==="NotFoundError") return null; throw err; }
}

async function seedWorkspaceSetsFromManifest(){
  workspaceSyncedPdfIds.clear();
  workspaceSyncedAnalysisIds.clear();
  const manifest=await readExistingWorkspaceManifest();
  if(!manifest || manifest.format!=="SIPEKA_SESSION") return;
  (manifest.activeFiles||[]).forEach(row=>{
    workspaceSyncedPdfIds.add(`active:${row.id}`);
    workspaceSyncedAnalysisIds.add(row.id);
  });
  ((manifest.appState&&manifest.appState.batches)||[]).forEach(batch=>(batch.patientFiles||[]).forEach(row=>workspaceSyncedPdfIds.add(`batch:${batch.id}:${row.id}`)));
  (manifest.samplingFiles||[]).forEach(row=>{ if(row.externalStored) workspaceSyncedPdfIds.add(`sampling:${row.id}`); });
  (manifest.medicineFiles||[]).forEach(row=>{ if((row.pending||row.error)&&row.externalStored) workspaceSyncedPdfIds.add(`medicine:${row.id}`); });
}

async function restoreStoredWorkspaceHandle(){
  if(!("showDirectoryPicker" in window)){
    document.getElementById("connectWorkspaceBtn").disabled=true;
    document.getElementById("restoreWorkspaceBtn").disabled=true;
    setWorkspaceStatus("Cadangan folder memerlukan Chrome atau Edge versi baru.",true);
    return;
  }
  try{
    const handle=await dbGet(DB_STORE,"workspaceHandle");
    if(!handle) return;
    workspaceDirHandle=handle;
    if(await ensureWorkspacePermission(handle,false)){
      await seedWorkspaceSetsFromManifest();
      setWorkspaceStatus(`Folder cadangan terhubung: ${handle.name}`);
      renderSamplingList();
      scheduleWorkspaceBackup(1000);
    }else{
      setWorkspaceStatus(`Klik Hubungkan untuk mengizinkan kembali folder: ${handle.name}`,true);
    }
  }catch(err){ console.warn("Handle folder cadangan tidak dapat dimuat:",err); }
}

document.getElementById("forceSaveBtn").addEventListener("click",async e=>{
  const button=e.currentTarget;
  const oldText=button.textContent;
  button.disabled=true;
  button.textContent="Menyimpan…";
  try{
    await waitForGuaranteedLocalSave();
    let externalSaved=false;
    if(workspaceDirHandle && await ensureWorkspacePermission(workspaceDirHandle,false)){
      externalSaved=await saveWorkspaceBackup(true);
    }
    const el=document.getElementById("saveStatus");
    if(el) el.innerHTML=`<span class="dot"></span> ${externalSaved?"Semua perubahan dan PDF sudah dicadangkan.":"Perubahan tersimpan di browser. Hubungkan folder untuk perlindungan tambahan."}`;
  }catch(err){
    updateSaveIndicator(false,err);
    setWorkspaceStatus("Penyimpanan belum tuntas. Periksa ruang perangkat lalu coba lagi.",true);
  }finally{
    button.disabled=false;
    button.textContent=oldText;
  }
});

document.getElementById("connectWorkspaceBtn").addEventListener("click",async ()=>{
  if(medicineBusy()){ alert("Tunggu proses Obat selesai sebelum mengganti folder cadangan.");return; }
  if(!("showDirectoryPicker" in window)) return;
  const previousHandle=workspaceDirHandle;
  try{
    const reconnectingStoredHandle=!!workspaceDirHandle;
    let handle=workspaceDirHandle;
    if(!handle || !(await ensureWorkspacePermission(handle,true))){
      handle=await window.showDirectoryPicker({id:"sipeka-backup",mode:"readwrite"});
    }
    workspaceDirHandle=handle;
    if(!(await ensureWorkspacePermission(handle,true))) throw new Error("Izin tulis folder tidak diberikan.");
    renderSamplingList();
    await dbPut(DB_STORE,"workspaceHandle",handle);
    const existing=await readExistingWorkspaceManifest();
    if(existing && !reconnectingStoredHandle && !confirm("Folder ini sudah memiliki cadangan SIPEKA. Tekan OK untuk memperbaruinya dengan sesi saat ini, atau Batal lalu gunakan tombol Buka/Pulihkan Sesi.")){
      workspaceDirHandle=previousHandle;
      if(previousHandle) await dbPut(DB_STORE,"workspaceHandle",previousHandle);
      else await dbDelete(DB_STORE,"workspaceHandle");
      renderSamplingList();
      setWorkspaceStatus("Cadangan lama tidak diubah. Gunakan Buka/Pulihkan Sesi untuk membukanya.",true);
      return;
    }
    if(existing && reconnectingStoredHandle) await seedWorkspaceSetsFromManifest();
    else{
      workspaceSyncedPdfIds.clear();
      workspaceSyncedAnalysisIds.clear();
    }
    workspaceDirtyAnalysisIds.clear();
    setWorkspaceStatus(`Menyiapkan cadangan di ${handle.name}…`);
    await waitForGuaranteedLocalSave();
    await saveWorkspaceBackup(true);
    if(medicineFiles.some(entry=>entry.pending))queueMedicineTask(()=>resumeInterruptedMedicineFiles());
  }catch(err){
    workspaceDirHandle=previousHandle;
    try{
      if(previousHandle) await dbPut(DB_STORE,"workspaceHandle",previousHandle);
      else await dbDelete(DB_STORE,"workspaceHandle");
    }catch(e){}
    renderSamplingList();
    if(err&&err.name!=="AbortError") setWorkspaceStatus(`Folder gagal dihubungkan: ${err.message||err}`,true);
  }
});

document.getElementById("restoreWorkspaceBtn").addEventListener("click",async ()=>{
  if(medicineBusy()){ alert("Tunggu proses Obat selesai sebelum memulihkan sesi.");return; }
  if(!("showDirectoryPicker" in window)) return;
  const previousHandle=workspaceDirHandle;
  try{
    const handle=await window.showDirectoryPicker({id:"sipeka-restore",mode:"readwrite"});
    workspaceDirHandle=handle;
    if(!(await ensureWorkspacePermission(handle,true))) throw new Error("Izin folder tidak diberikan.");
    const manifest=await readExistingWorkspaceManifest();
    if(!manifest) throw new Error("File sipeka-session.json tidak ditemukan di folder ini.");
    const hasCurrent=files.length||archivedFiles.length||batches.length||samplingFiles.length||medicineFiles.length;
    if(hasCurrent && !confirm("Pulihkan sesi dari folder ini? Sesi aktif di browser akan diganti; hasil pada folder cadangan tidak akan dihapus.")){
      workspaceDirHandle=previousHandle;
      return;
    }
    setWorkspaceStatus("Memulihkan sesi dan daftar berkas…");
    await restoreFromWorkspaceManifest(manifest);
  }catch(err){
    workspaceDirHandle=previousHandle;
    if(err&&err.name!=="AbortError") setWorkspaceStatus(`Pemulihan gagal: ${err.message||err}`,true);
  }
});

async function clearAllStoredData(){
  if(medicineBusy()){ alert("Tunggu proses Obat selesai sebelum menghapus data aplikasi.");return; }
  if(!confirm("Hapus SEMUA data aplikasi dari browser ini, termasuk antrean aktif, PDF, hasil pemeriksaan, checklist, Sampling, dan hasil Obat? Cadangan di folder pilihan tidak akan dihapus dan masih bisa dipulihkan.")) return;
  clearTimeout(medicineSaveTimer);
  medicineFiles.forEach(entry=>deletedMedicineRecordIds.add(entry.id));
  await medicineStorageBarrier.catch(()=>{});
  resetAutoOcrQueue();
  try{ await dbClearApplicationData(); }
  catch(err){ console.warn("Gagal menghapus data tersimpan:", err); }
  files.forEach(entry=>{ if(entry.objectUrl) try{ URL.revokeObjectURL(entry.objectUrl); }catch(e){} });
  files = [];
  archivedFiles = [];
  batches = [];
  samplingFiles = [];
  medicineFiles = [];
  clearTimeout(medicineSaveTimer);
  dirtyMedicineIds.clear();
  medicinePage=1;
  dirtyActiveIds.clear();
  dirtyAnalysisIds.clear();
  workspaceDirHandle = null;
  workspaceSyncedPdfIds.clear();
  workspaceSyncedAnalysisIds.clear();
  workspaceDirtyAnalysisIds.clear();
  workspaceDeletedIds.clear();
  workspaceDeletedMedicineIds.clear();
  knownFingerprints.clear();
  activeFingerprints.clear();
  archivedFingerprints.clear();
  renderResults();
  renderBatches();
  renderSamplingList();
  renderMedicineTable();
  setWorkspaceStatus("Data browser dihapus. Cadangan folder, jika ada, tetap aman dan bisa dipulihkan.",true);
  const el = document.getElementById("saveStatus");
  if(el){ el.innerHTML = `<span class="dot"></span> Data tersimpan telah dihapus.`; el.classList.remove("save-err"); }
}
document.getElementById("clearDataBtn").addEventListener("click", clearAllStoredData);
document.getElementById("restoreBannerClose").addEventListener("click", ()=>{
  document.getElementById("restoreBanner").style.display = "none";
});

// Simpan segera saat tab disembunyikan/ditutup, jangan menunggu jeda debounce.
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="hidden") saveNow(); });
window.addEventListener("pagehide", saveNow);
window.addEventListener("beforeunload", e=>{
  let busy=false;
  try{ busy = !!(saveInFlight || saveTimer || autoOcrQueuedIds.size || (typeof files!=="undefined" && files.some(f=>f.pending || (f.ocr&&f.ocr.running)))); }catch(_){}
  if(busy){ e.preventDefault(); e.returnValue=""; }
});

if(navigator.storage && navigator.storage.persist){
  navigator.storage.persist().catch(()=>{});
}

/* ---------------- Pola deteksi "isi benar-benar terisi" untuk lapisan contentCheck ---------------- */
// Dipisah di sini (sebelum `categories`) supaya aman dirujuk langsung di dalam definisi
// checklist maupun di BUILTIN_CONTENT_CHECKS tanpa masalah urutan deklarasi.
// PENTING: pola-pola ini diuji terhadap teks yang SUDAH dinormalisasi oleh
// normalizeDetectionText (huruf kecil, tanda baca seperti . : / sudah diganti spasi).
// Jadi jangan pakai tanda baca literal di sini -- gunakan \s untuk menggantikannya.
const CONTENT_VALUE_PATTERNS = [
  /\b[a-z]\d{2}\b/,                    // kode dasar ICD-10, mis. e11 (dari "E11.6"), z09 (dari "Z09.8"), i10, m14
  /\bnip\s*\d{6,}\b/,                  // NIP dokter/petugas yang terisi
  /\bsp\s*[a-z]{1,8}\b/,               // gelar dokter spesialis mis. "sp pd", "sp b", "sp an"
  /\b\d{2,3}\s\d{2,3}\s*mmhg\b/,       // tensi terisi mis. "147 77 mmhg" (dari "147/77 mmHg")
];
const CONTENT_VALUE_PATTERNS_LAB = [
  /\b\d{1,4}(?:\s\d{1,3})?\s*(?:mg\s*dl|g\s*dl|iu\s*l|u\s*l|mmol\s*l|ribu\s*ul|juta\s*ul|meq\s*l|mm\s*jam)\b/, // nilai lab dgn satuan umum, mis. "12 5 mg dl"
  ...CONTENT_VALUE_PATTERNS,
];
// Catatan: untuk Laporan Operasi belum ada contoh berkas terisi yang bisa dijadikan acuan,
// jadi sementara memakai pola umum di atas (kode diagnosis/NIP/Sp/tensi) + ambang panjang teks
// yang lebih tinggi. Kalau nanti ada contoh Laporan Operasi yang benar-benar terisi, pola ini
// bisa dipertajam (mis. kode tindakan ICD-9-CM, jam mulai/selesai) seperti yang dilakukan untuk
// Ringkasan Pulang.
const CONTENT_VALUE_PATTERNS_OPERASI = [...CONTENT_VALUE_PATTERNS];

/* ---------------- Default checklist per kategori (draf awal, silakan sesuaikan) ---------------- */
let categories = {
  rs_inap: {
    label: "RS \u2014 Rawat Inap",
    items: [
      { id: "sep", name: "Surat Eligibilitas Peserta (SEP)", keywords: ["surat elegibilitas peserta","surat eligibilitas peserta"], conditional:false },
      { id: "ringkasan", name: "Resume Medis / Ringkasan Pulang", keywords: ["ringkasan pulang","resume medis","resume medis pasien","resume pasien pulang"], conditional:false, contentCheck:{ minChars:250, minValueHits:1, spanPages:1, requireIcd:true } },
      { id: "penunjang", name: "Hasil Penunjang (Lab/Radiologi)", keywords: ["hasil pemeriksaan laboratorium","hasil pemeriksaan radiologi","hasil laboratorium","hasil pemeriksaan penunjang","hasil usg","elektrokardiogram"], conditional:false, contentCheck:{ minChars:100, minValueHits:1, spanPages:2, valuePatterns:CONTENT_VALUE_PATTERNS_LAB } },
      { id: "rincian", name: "Rincian Biaya / Tagihan", keywords: ["rincian biaya","total tagihan","rincian tagihan","rincian biaya pelayanan pasien","billing","total biaya","biaya & perawatan"], conditional:false },
      { id: "inacbg", name: "Berkas Klaim Individual (INA-CBG)", keywords: ["berkas klaim individual","ina-cbg","ina cbg","hasil grouping","e-klaim"], conditional:false },
      { id: "sprin", name: "Surat Perintah Rawat Inap", keywords: ["surat perintah rawat inap"], conditional:false },
      { id: "consent", name: "Persetujuan Umum (General Consent)", keywords: ["general consent","persetujuan umum","pemberian informasi dan persetujuan"], conditional:false },
      { id: "operasi", name: "Laporan Operasi", keywords: ["laporan operasi","laporan tindakan operasi","keterangan tindakan operasi"], conditional:true, contentCheck:{ minChars:300, minValueHits:1, spanPages:1, valuePatterns:CONTENT_VALUE_PATTERNS_OPERASI } }
    ]
  },
  rs_jalan: {
    label: "RS \u2014 Rawat Jalan",
    items: [
      { id: "sep", name: "Surat Eligibilitas Peserta (SEP)", keywords: ["surat elegibilitas peserta","surat eligibilitas peserta"], conditional:false },
      { id: "resume_poli", name: "Resume / Ringkasan Pulang Rawat Jalan", keywords: ["resume poliklinik","catatan medis poliklinik","resume rawat jalan","ringkasan pulang","resume medis","resume medis pasien"], conditional:false, contentCheck:{ minChars:250, minValueHits:1, spanPages:1, requireIcd:true } },
      { id: "inacbg", name: "Berkas Klaim Individual (INA-CBG)", keywords: ["berkas klaim individual","ina-cbg","ina cbg"], conditional:false },
      { id: "resep", name: "Resep Obat / Kwitansi Farmasi", keywords: ["resep gawat darurat","resep obat","pemberian obat","kwitansi pelayanan obat"], conditional:true },
      { id: "rincian", name: "Rincian Biaya / Tagihan", keywords: ["rincian biaya","total tagihan","rincian biaya pelayanan pasien","rincian tagihan","total biaya","biaya & perawatan"], conditional:false },
      { id: "penunjang", name: "Hasil Penunjang (Lab/Radiologi)", keywords: ["hasil pemeriksaan laboratorium","hasil pemeriksaan radiologi"], conditional:true, contentCheck:{ minChars:100, minValueHits:1, spanPages:2, valuePatterns:CONTENT_VALUE_PATTERNS_LAB } },
      { id: "rujukan", name: "Surat Rujukan", keywords: ["surat rujukan"], conditional:true }
    ]
  },
  puskesmas: {
    label: "Puskesmas",
    items: [
      { id: "bukti_layanan", name: "Bukti Pelayanan / SEP", keywords: ["bukti pelayanan","surat elegibilitas peserta","no.sep"], conditional:false },
      { id: "catatan_medis", name: "Catatan Medis Kunjungan", keywords: ["catatan medis","rekam medis","anamnesa"], conditional:false, contentCheck:{ minChars:150, minValueHits:1, spanPages:1 } },
      { id: "rujukan", name: "Surat Rujukan", keywords: ["surat rujukan"], conditional:true },
      { id: "rincian", name: "Rincian Klaim Non-Kapitasi", keywords: ["rincian biaya","klaim non kapitasi","non-kapitasi"], conditional:false }
    ]
  },
  apotik: {
    label: "Apotik",
    items: [
      { id: "resep", name: "Resep Obat", keywords: ["resep","r/"], conditional:false },
      { id: "bukti_serah", name: "Bukti Penyerahan Obat", keywords: ["bukti penyerahan","tanda terima obat"], conditional:false },
      { id: "rujukan", name: "SEP / Surat Jaminan", keywords: ["surat elegibilitas peserta","no.sep","surat jaminan"], conditional:false },
      { id: "rincian", name: "Rincian Tagihan Obat", keywords: ["rincian tagihan","rincian biaya obat"], conditional:false }
    ]
  },
  optik: {
    label: "Optik",
    items: [
      { id: "persetujuan_bayar", name: "Formulir Persetujuan Pembayaran DJS Kesehatan", keywords: ["formulir persetujuan pembayaran","djs kesehatan"], conditional:false },
      { id: "rekap_verifikasi", name: "Rekapitulasi Hasil Verifikasi Tagihan", keywords: ["rekapitulasi hasil verifikasi tagihan"], conditional:false },
      { id: "kwitansi", name: "Kwitansi Pembayaran (bermaterai)", keywords: ["telah terima dari","terbilang rp","kwitansi"], conditional:false },
      { id: "fpk", name: "Formulir Pengajuan Klaim (FPK)", keywords: ["formulir pengajuan klaim","nomor fpk"], conditional:false },
      { id: "laporan_kacamata", name: "Laporan Pelayanan Kacamata", keywords: ["laporan pelayanan kacamata"], conditional:false },
      { id: "ba_serah_terima", name: "Berita Acara Serah Terima Klaim (Non INA-CBG)", keywords: ["berita acara serah terima","klaim non ina"], conditional:false },
      { id: "ba_kelengkapan", name: "Berita Acara Kelengkapan Berkas Klaim", keywords: ["berita acara kelengkapan berkas"], conditional:false },
      { id: "ba_verifikasi", name: "Berita Acara Hasil Verifikasi Klaim", keywords: ["berita acara hasil verifikasi klaim"], conditional:false },
      { id: "surat_pengajuan", name: "Surat Pengajuan Berkas Klaim", keywords: ["surat pengajuan berkas klaim"], conditional:false },
      { id: "sptjm", name: "Surat Pernyataan Tanggung Jawab Mutlak (SPTJM)", keywords: ["tanggung jawab mutlak","sptjm"], conditional:false },
      { id: "surat_pernyataan_tagihan", name: "Surat Pernyataan Klaim Tagihan Pelayanan Kesehatan", keywords: ["surat pernyataan klaim tagihan pelayanan kesehatan"], conditional:false }
    ]
  }
};

// Tambahan istilah baku ini juga diterapkan pada sesi lama, tanpa menghapus
// kata kunci yang pernah disesuaikan pengguna.
const BUILTIN_KEYWORD_ALIASES = {
  rs_inap:{
    sep:["surat elegibilitas peserta","surat eligibilitas peserta"],
    ringkasan:["ringkasan pulang","resume medis","resume medis pasien","resume pasien pulang"],
    penunjang:["hasil pemeriksaan laboratorium","hasil pemeriksaan radiologi","hasil laboratorium","hasil pemeriksaan penunjang","hasil usg","elektrokardiogram"],
    rincian:["rincian biaya","total tagihan","rincian tagihan","rincian biaya pelayanan pasien","billing","total biaya","biaya & perawatan"],
    inacbg:["berkas klaim individual","ina-cbg","ina cbg","hasil grouping","e-klaim"],
    sprin:["surat perintah rawat inap"],
    consent:["general consent","persetujuan umum","pemberian informasi dan persetujuan"],
    operasi:["laporan operasi","laporan tindakan operasi","keterangan tindakan operasi"]
  },
  // Rawat jalan: berkas RS umumnya memakai judul "Resume Medis Pasien" dan lembar
  // "Riwayat Perawatan" (berisi "Biaya & Perawatan" / "Total Biaya"), bukan "Rincian Biaya".
  rs_jalan:{
    resume_poli:["resume poliklinik","catatan medis poliklinik","resume rawat jalan","ringkasan pulang","resume medis","resume medis pasien"],
    resep:["resep gawat darurat","resep obat","pemberian obat","kwitansi pelayanan obat"],
    rincian:["rincian biaya","total tagihan","rincian biaya pelayanan pasien","rincian tagihan","total biaya","biaya & perawatan"]
  }
};
// Kata kunci bawaan lama yang terbukti terlalu umum. Dihapus SATU KALI dari sesi lama
// (ditandai cat.kwRev) supaya kata kunci yang sengaja ditambahkan lagi oleh pengguna tidak ikut hilang.
// "resep" saja cocok dengan label "Resep :" pada catatan SOAP, walau tidak ada lembar resep.
const BUILTIN_KEYWORD_REMOVALS = {
  rs_jalan:{ resep:["resep"] }
};
const BUILTIN_KEYWORD_REV = 2;
function applyBuiltInKeywordAliases(){
  Object.entries(BUILTIN_KEYWORD_ALIASES).forEach(([catKey,items])=>{
    const cat=categories[catKey];
    if(!cat||!Array.isArray(cat.items)) return;
    const removals=((cat.kwRev||0)<BUILTIN_KEYWORD_REV && BUILTIN_KEYWORD_REMOVALS[catKey]) || {};
    Object.entries(items).forEach(([itemId,aliases])=>{
      const item=cat.items.find(row=>row.id===itemId);
      if(!item) return;
      if(itemId==="sep"&&/Surat Elegibilitas Peserta/i.test(item.name||"")) item.name="Surat Eligibilitas Peserta (SEP)";
      const drop=removals[itemId]||[];
      const existingKeywords=(item.keywords||[]).filter(value=>{
        const v=String(value).trim().toLowerCase();
        if(itemId==="sep"&&["no.sep","nomor sep","no sep"].includes(v)) return false;
        return !drop.includes(v);
      });
      const merged=new Set([...existingKeywords,...aliases].map(value=>String(value).trim().toLowerCase()).filter(Boolean));
      item.keywords=Array.from(merged);
    });
    cat.kwRev=BUILTIN_KEYWORD_REV;
  });
}

// Sama seperti BUILTIN_KEYWORD_ALIASES di atas: `categories` bisa saja ditimpa oleh data
// checklist lama yang tersimpan di sesi pengguna (lihat initApp -> snapshot.categories),
// sehingga contentCheck yang didefinisikan di objek `categories` di atas tidak otomatis
// ikut termuat untuk sesi lama. Daftar di bawah ini memastikan lapisan contentCheck tetap
// aktif walau sesi lama dipulihkan, TANPA menimpa pengaturan yang mungkin sudah pernah
// disesuaikan pengguna sendiri (item.contentCheck yang sudah ada tidak akan ditimpa).
const BUILTIN_CONTENT_CHECKS = {
  rs_inap:{
    ringkasan:{ minChars:250, minValueHits:1, spanPages:1, requireIcd:true },
    penunjang:{ minChars:100, minValueHits:1, spanPages:2, valuePatterns:CONTENT_VALUE_PATTERNS_LAB },
    operasi:{ minChars:300, minValueHits:1, spanPages:1, valuePatterns:CONTENT_VALUE_PATTERNS_OPERASI }
  },
  rs_jalan:{
    resume_poli:{ minChars:250, minValueHits:1, spanPages:1, requireIcd:true },
    penunjang:{ minChars:100, minValueHits:1, spanPages:2, valuePatterns:CONTENT_VALUE_PATTERNS_LAB }
  },
  puskesmas:{
    catatan_medis:{ minChars:150, minValueHits:1, spanPages:1 }
  }
};
function applyBuiltInContentChecks(){
  Object.entries(BUILTIN_CONTENT_CHECKS).forEach(([catKey,items])=>{
    const cat=categories[catKey];
    if(!cat||!Array.isArray(cat.items)) return;
    Object.entries(items).forEach(([itemId,cfg])=>{
      const item=cat.items.find(row=>row.id===itemId);
      if(!item) return;
      if(item.contentCheck){
        // Sudah ada (mis. dari sesi lama): jangan timpa, hanya lengkapi opsi baru yang belum pernah diatur.
        if(cfg.requireIcd!=null && item.contentCheck.requireIcd==null) item.contentCheck.requireIcd=cfg.requireIcd;
        return;
      }
      item.contentCheck=Object.assign({},cfg);
    });
  });
}

/* ---------------- Checklist per-pasien untuk layanan kolektif Puskesmas (draf awal, silakan sesuaikan) ---------------- */
let kolektifCategories = {
  anc_usg: {
    label: "ANC / USG",
    items: [
      { id:"pernyataan", name:"Surat Pernyataan Pelayanan di FKTP", keywords:["surat pernyataan pelayanan"], conditional:false },
      { id:"formulir_primer", name:"Formulir Klaim Pelayanan Primer", keywords:["formulir klaim pelayanan primer"], conditional:false },
      { id:"kartu_ibu", name:"Identitas / Kartu Ibu (diisi bidan)", keywords:["diisi oleh ibu","identitas diisi oleh"], conditional:false },
      { id:"catatan_kia", name:"Catatan Pelayanan Kesehatan Ibu / Buku KIA", keywords:["pencatatan pelayanan kesehatan ibu","buku kia"], conditional:false },
      { id:"hasil_usg", name:"Hasil Pemeriksaan USG", keywords:["hasil usg","hasil pemeriksaan usg"], conditional:true }
    ]
  },
  inc: {
    label: "INC (Persalinan)",
    items: [
      { id:"pernyataan", name:"Surat Pernyataan Pelayanan di FKTP", keywords:["surat pernyataan pelayanan"], conditional:false },
      { id:"formulir_primer", name:"Formulir Klaim Pelayanan Primer", keywords:["formulir klaim pelayanan primer"], conditional:false },
      { id:"partograf", name:"Partograf Persalinan", keywords:["partograf"], conditional:false },
      { id:"laporan_persalinan", name:"Laporan / Catatan Persalinan", keywords:["laporan persalinan","catatan persalinan"], conditional:false },
      { id:"surat_lahir", name:"Surat Keterangan Lahir", keywords:["surat keterangan lahir"], conditional:true }
    ]
  },
  kb: {
    label: "KB",
    items: [
      { id:"pernyataan", name:"Surat Pernyataan Pelayanan di FKTP", keywords:["surat pernyataan pelayanan"], conditional:false },
      { id:"formulir_primer", name:"Formulir Klaim Pelayanan Primer", keywords:["formulir klaim pelayanan primer"], conditional:false },
      { id:"kartu_akseptor", name:"Kartu Peserta KB / K1", keywords:["kartu peserta kb","kartu akseptor"], conditional:false },
      { id:"informed_consent", name:"Informed Consent Tindakan KB", keywords:["informed consent","persetujuan tindakan"], conditional:true }
    ]
  },
  rujukan_ambulan: {
    label: "Rujukan & Ambulan",
    items: [
      { id:"surat_rujukan", name:"Surat Rujukan", keywords:["surat rujukan"], conditional:false },
      { id:"formulir_primer", name:"Formulir Klaim Pelayanan Primer", keywords:["formulir klaim pelayanan primer"], conditional:false },
      { id:"bukti_ambulan", name:"Bukti Pelayanan Ambulan", keywords:["bukti pelayanan ambulan","pelayanan ambulance"], conditional:true },
      { id:"tiket_jalan", name:"Tiket / Surat Jalan Ambulan", keywords:["surat jalan","tiket ambulan"], conditional:true }
    ]
  }
};
let batches = []; // {id, service, label, rosterText, roster:[{name,tanggal,tindakan}], patientFiles:[], unmatchedOpen:true}
let batchCounter = 0;

let currentEditorCat = "rs_jalan";
let files = []; // {id, name, category, text, pending, itemsStatus:{itemId:{source,manual,na}}}
/* Berkas yang sudah selesai diperiksa bisa "diarsipkan": dilepas dari `files` (berikut blob PDF,
   pdfDoc, dan teks halamannya) supaya render ulang & penyimpanan otomatis tetap ringan walau
   sudah memeriksa banyak berkas. Ringkasan hasilnya (nama, kategori, status, dokumen kurang)
   tetap disimpan di sini dan tetap ikut ke unduhan CSV. Tidak menyentuh daftar Sampling sama sekali. */
let archivedFiles = []; // ringkasan permanen; tidak menyimpan Blob/PDF
const knownFingerprints = new Set();
const activeFingerprints = new Set();
const archivedFingerprints = new Set();
let resultFilter = "all"; // "all" | "complete" | "incomplete" &mdash; filter kartu berdasarkan status kelengkapan
let resultSearchQuery = ""; // pencarian nama berkas di menu Verifikasi per Berkas
let categoryGroupOpen = {}; // catKey -> boolean; default terbuka (true) bila belum ada entri
let fileCounter = 0;
let activeView = "perfile";
const ACTIVE_PAGE_SIZE = 40;
const ARCHIVE_PAGE_SIZE = 100;
let activePage = 1;
let archivedPage = 1;

function fileFingerprint(fileOrRow){
  const relPath = fileOrRow.webkitRelativePath || fileOrRow.relPath || "";
  const name = String(fileOrRow.name||"").toLowerCase();
  const size = Number(fileOrRow.size)||0;
  const modified = Number(fileOrRow.lastModified)||0;
  return `${relPath.toLowerCase()}|${name}|${size}|${modified}`;
}

function refreshKnownFingerprints(){
  knownFingerprints.clear();
  activeFingerprints.clear();
  archivedFingerprints.clear();
  files.forEach(row=>{ if(row.fingerprint){ knownFingerprints.add(row.fingerprint); activeFingerprints.add(row.fingerprint); } });
  archivedFiles.forEach(row=>{ if(row.fingerprint){ knownFingerprints.add(row.fingerprint); archivedFingerprints.add(row.fingerprint); } });
}

function yieldToBrowser(){
  return new Promise(resolve=>{
    if(typeof requestIdleCallback==="function") requestIdleCallback(()=>resolve(),{timeout:60});
    else requestAnimationFrame(()=>resolve());
  });
}

function setActiveCategory(key){
  currentEditorCat = key;
  renderTabs();
  renderEditor();
  const modeSel = document.getElementById("modeSelect");
  if(modeSel) modeSel.value = key;
}

/* ---------------- Sidebar / editor rendering ---------------- */
function renderTabs(){
  const bar = document.getElementById("tabbar");
  bar.innerHTML = "";
  Object.keys(categories).forEach(key=>{
    const t = document.createElement("div");
    t.className = "tab" + (key===currentEditorCat ? " active":"");
    t.textContent = categories[key].label;
    t.onclick = ()=>{ setActiveCategory(key); };
    bar.appendChild(t);
  });
}

function renderEditor(){
  const cat = categories[currentEditorCat];
  document.getElementById("editorTitle").textContent = cat.label;
  const wrap = document.getElementById("itemEditor");
  wrap.innerHTML = "";
  cat.items.forEach((item, idx)=>{
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <input type="text" value="${escapeAttr(item.name)}" data-idx="${idx}" class="name-input">
      <textarea data-idx="${idx}" class="kw-input" placeholder="kata kunci, dipisah koma">${escapeAttr(item.keywords.join(", "))}</textarea>
      <label class="cond-check"><input type="checkbox" data-idx="${idx}" class="cond-input" ${item.conditional?"checked":""}> Kondisional (mis. hanya wajib jika ada tindakan tertentu &mdash; bila tidak ditemukan, berkas tetap Lengkap dengan catatan; bisa ditandai "tidak berlaku")</label>
      <div class="row-foot"><button class="mini-btn" data-idx="${idx}">Hapus</button></div>
    `;
    row.querySelector(".name-input").addEventListener("input", e=>{
      cat.items[idx].name = e.target.value;
      reprocessAllFilesOfCategory(currentEditorCat);
    });
    row.querySelector(".kw-input").addEventListener("input", e=>{
      cat.items[idx].keywords = e.target.value.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
      reprocessAllFilesOfCategory(currentEditorCat);
    });
    row.querySelector(".cond-input").addEventListener("change", e=>{
      cat.items[idx].conditional = e.target.checked;
      renderEditor();
      reprocessAllFilesOfCategory(currentEditorCat);
    });
    row.querySelector(".mini-btn").addEventListener("click", ()=>{
      cat.items.splice(idx,1);
      renderEditor();
      reprocessAllFilesOfCategory(currentEditorCat);
    });
    wrap.appendChild(row);
  });
  scheduleSave();
}

document.getElementById("addItemBtn").onclick = ()=>{
  const cat = categories[currentEditorCat];
  cat.items.push({id:"item_"+Date.now(), name:"Jenis dokumen baru", keywords:[], conditional:false});
  renderEditor();
};

function csvSafeCell(v){
  let t=String(v==null?"":v);
  // Cegah formula spreadsheet dari teks pengguna/OCR (angka negatif murni dibiarkan).
  if(/^[\s]*[=+@-]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t.trim())) t="'"+t;
  return `"${t.replace(/"/g,'""')}"`;
}
function escapeAttr(s){
  return String(s==null?"":s).replace(/[&<>"']/g,ch=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[ch]);
}

/* ---------------- Upload handling ---------------- */
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
dropZone.onclick = ()=>fileInput.click();
fileInput.onchange = e=>{ handleFiles(e.target.files); e.target.value=""; };
["dragenter","dragover"].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.add("drag");}));
["dragleave","drop"].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.remove("drag");}));
dropZone.addEventListener("drop", e=>{ handleFiles(e.dataTransfer.files); });

function guessCategory(filename, fallback){
  const n = filename.toLowerCase();
  if(n.includes("apotik")||n.includes("apotek")) return "apotik";
  if(n.includes("optik")) return "optik";
  if(n.includes("puskesmas")) return "puskesmas";
  if(n.includes("rawat inap")||n.includes("_inap")) return "rs_inap";
  if(n.includes("rawat jalan")||n.includes("_jalan")) return "rs_jalan";
  return fallback;
}


/* ---------------- Progres (bar + tahap + estimasi), dipakai Unggah & Sampling ---------------- */
function createProgressBar(rootId, cfg){
  // cfg.steps: [{key,label,weight,unit}] ; cfg.titles: {key:teks, done:teks}
  let st=null, hideTimer=null, queued=0;
  const root=()=>document.getElementById(rootId);
  const q=sel=>{ const r=root(); return r?r.querySelector(sel):null; };
  const fmtDur=s=>{ s=Math.max(1,Math.round(s)); return s<60 ? s+" dtk" : Math.floor(s/60)+" mnt "+(s%60)+" dtk"; };
  const stepCfg=k=>cfg.steps.find(s=>s.key===k);
  function pct(){
    if(!st) return 0;
    if(st.phase==="done") return 100;
    const totalW=st.keys.reduce((n,k)=>n+stepCfg(k).weight,0)||1;
    const cur=st.keys.indexOf(st.phase);
    let p=0;
    st.keys.forEach((k,i)=>{
      const w=stepCfg(k).weight;
      if(i<cur) p+=w;
      else if(i===cur){
        const t=st.total[k]||0;
        p+= k==="prep" ? w*0.5 : (t>0 ? w*Math.min(1,(st.done[k]||0)/t) : 0);
      }
    });
    return Math.round(Math.min(99,p*100/totalW));
  }
  function render(extra){
    const el=root(); if(!el||!st) return;
    el.classList.add("show");
    el.classList.toggle("busy", st.phase!=="done");
    const p=pct();
    q(".upp-pct").textContent=p+"%";
    q(".upp-fill").style.width=p+"%";
    q(".upp-track").setAttribute("aria-valuenow",String(p));
    q(".upp-title").textContent=(cfg.titles[st.phase]||"")+(queued?` (+${queued} menunggu)`:"");
    const cur=st.keys.indexOf(st.phase);
    el.querySelectorAll(".upp-step").forEach(chip=>{
      const i=st.keys.indexOf(chip.dataset.step);
      chip.classList.toggle("done", st.phase==="done" || i<cur);
      chip.classList.toggle("active", st.phase!=="done" && i===cur);
    });
    let meta=`${st.countTotal} berkas`+(st.totalBytes?` • ${formatBytes(st.totalBytes)}`:"");
    const k=st.phase;
    if(k!=="done" && k!=="prep" && st.total[k]!=null){
      const sc=stepCfg(k), d=st.done[k]||0, t=st.total[k];
      meta+=` • ${sc.unit} ${d}/${t}`;
      const secs=(Date.now()-(st.started[k]||Date.now()))/1000;
      if(d>=3 && secs>=3 && t>d) meta+=` • sisa ±${fmtDur((t-d)*(secs/d))}`;
    }
    if(extra) meta+=" • "+extra;
    q(".upp-meta").textContent=meta;
  }
  return {
    queue(n){ queued=Math.max(0,n); if(st&&st.phase!=="done") render(); },
    // opts: {total, totalBytes, steps:[key,...]}; langkah "prep" selalu ada di awal
    start(opts){
      clearTimeout(hideTimer);
      const keys=(opts.steps||cfg.steps.map(s=>s.key));
      st={phase:"prep",keys,countTotal:opts.total||0,totalBytes:opts.totalBytes||0,total:{},done:{},started:{},t0:Date.now()};
      keys.forEach(k=>{ st.total[k]=opts.total||0; st.done[k]=0; });
      const el=root();
      if(el){
        el.classList.remove("warn","err");
        const box=el.querySelector(".upp-steps");
        box.innerHTML=keys.map((k,i)=>`<span class="upp-step" data-step="${k}">${i+1}. ${escapeAttr(stepCfg(k).label)}</span>`).join("");
      }
      render();
    },
    active(){ return !!st && st.phase!=="done"; },
    has(key){ return !!st && st.keys.includes(key); },
    phase(key,total){
      if(!st) return;
      st.phase=key; st.started[key]=Date.now();
      if(typeof total==="number") st.total[key]=total;
      render();
    },
    progress(key,done,extra,total){
      if(!st) return;
      if(typeof total==="number") st.total[key]=total;
      if(st.phase!==key) this.phase(key);
      st.done[key]=Math.max(st.done[key]||0,done);
      render(extra);
    },
    note(text){ if(st) render(text); },
    finish(o){
      if(!st) return; o=o||{};
      st.phase="done"; render();
      const el=root();
      if(o.storageFailures) el.classList.add("err"); else if(o.failed||o.warn) el.classList.add("warn");
      const bits=[o.text||`${st.countTotal} berkas diproses`];
      if(o.failed) bits.push(`${o.failed} gagal dibaca`);
      if(o.storageFailures) bits.push(`${o.storageFailures} belum tersimpan permanen`);
      if(o.warn) bits.push(o.warn);
      bits.push(fmtDur((Date.now()-st.t0)/1000));
      q(".upp-meta").textContent=bits.join(" • ");
      if(!o.failed && !o.storageFailures && !o.warn){ hideTimer=setTimeout(()=>this.hide(),8000); }
    },
    hide(){ clearTimeout(hideTimer); st=null; const el=root(); if(el) el.classList.remove("show","busy","warn","err"); }
  };
}

/* Bar unggahan utama (tab pemeriksaan) — antarmuka lama dipertahankan */
const UploadProgress=(()=>{
  const b=createProgressBar("uploadProgress",{
    steps:[
      {key:"prep",label:"Persiapan",weight:5},
      {key:"store",label:"Menyimpan berkas",weight:30,unit:"tersimpan"},
      {key:"read",label:"Membaca isi PDF",weight:65,unit:"terbaca"}
    ],
    titles:{prep:"Menyiapkan unggahan…",store:"Menyimpan berkas…",read:"Membaca isi PDF…",done:"Unggahan selesai"}
  });
  return {
    queue:n=>b.queue(n),
    start:(total,bytes)=>b.start({total,totalBytes:bytes}),
    phase:k=>b.phase(k),
    store:n=>b.progress("store",n),
    read:(n,x)=>b.progress("read",n,x),
    note:t=>b.note(t),
    finish:(failed,storageFailures)=>b.finish({failed,storageFailures}),
    hide:()=>b.hide()
  };
})();

/* Bar Sampling ukuran berkas: tahap daftar (baca nama/ukuran) + cadangan ke folder (jika terhubung) */
const SamplingProgress=createProgressBar("samplingUploadProgress",{
  steps:[
    {key:"prep",label:"Persiapan",weight:5},
    {key:"list",label:"Menyusun daftar berkas",weight:55,unit:"terdaftar"},
    {key:"backup",label:"Mencadangkan ke folder",weight:40,unit:"tercadangkan"}
  ],
  titles:{prep:"Menyiapkan daftar sampling…",list:"Menyusun daftar berkas…",backup:"Mencadangkan PDF sampling ke folder…",done:"Sampling selesai"}
});

let fileImportQueue = Promise.resolve();
let uploadBatchesWaiting = 0;
function handleFiles(fileList){
  const captured = Array.from(fileList||[]);
  uploadBatchesWaiting++;
  const run = async ()=>{
    uploadBatchesWaiting = Math.max(0,uploadBatchesWaiting-1);
    UploadProgress.queue(uploadBatchesWaiting);
    try{ return await processFilesBatch(captured); }
    catch(err){ UploadProgress.hide(); throw err; }
  };
  UploadProgress.queue(uploadBatchesWaiting);
  fileImportQueue = fileImportQueue.then(run,run);
  return fileImportQueue;
}

async function analyzeEntryPdf(entry){
  entry.pageTexts = [];
  entry.digitalText = "";
  entry.ocrText = "";
  entry.ocrPageTexts = {};
  entry.ocrCandidates = [];
  entry._analysisLoaded = true;
  entry.analysisStored = false;
  entry.error = null;
  entry.errorKind = null;
  try{
    const sourceBlob=await getEntryBlobForBackup(entry);
    entry.blob=sourceBlob;
    entry.pdfDoc = await openPdfDocument(sourceBlob,entry.name,120000);
    let full = "";
    for(let p=1;p<=entry.pdfDoc.numPages;p++){
      const page = await withTimeout(entry.pdfDoc.getPage(p),45000,`Halaman ${p} tidak merespons.`);
      const content = await withTimeout(page.getTextContent(),45000,`Teks halaman ${p} tidak merespons.`);
      try{ page.cleanup(); }catch(e){}
      // Satu halaman = satu baris di digitalText (dipakai pengecekan isi per halaman).
      const t = content.items.map(it=>it.str).join(" ").replace(/[\r\n]+/g," ");
      if(t.trim().length<20) entry.ocrCandidates.push(p-1);
      entry.pageTexts.push(compactPageText(t));
      full += t + "\n";
      if(p%25===0) await yieldToBrowser();
    }
    entry.digitalText = full.toLowerCase();
  }catch(err){
    const info=classifyPdfError(err);
    entry.error=info.message;
    entry.errorKind=info.kind;
    if(err&&err.code==="TIMEOUT") retireSharedPdfWorker();
  }
  entry.pending = false;
  applyDetectedCategory(entry);
  evaluateFile(entry);
  if(!entry.error&&entry.ocrCandidates.length) enqueueAutoOcr(entry);
  dirtyActiveIds.add(entry.id);
  dirtyAnalysisIds.add(entry.id);
  workspaceDirtyAnalysisIds.add(entry.id);
  await destroyPdfDocument(entry.pdfDoc);
  entry.pdfDoc = null;
}

async function retryActiveEntryAnalysis(entry){
  if(!entry||entry.pending||retryAllState) return;
  entry.pending=true;
  entry.error=null;
  entry.ocrText="";
  entry.ocrPageTexts={};
  entry.ocr={running:false,done:false,error:null,progress:"",processedPages:[],automatic:false};
  markEntryDirty(entry);
  renderResults();
  await analyzeEntryPdf(entry);
  try{
    await flushDirtyAnalysisEntries();
    await flushDirtyActiveEntries();
    await persistState();
  }catch(err){ updateSaveIndicator(false,err); }
  releaseEntryHeavyData(entry);
  renderResults();
}

function releaseEntryHeavyData(entry){
  if((entry.blobStored||entry.externalStored) && entry.blob && !entry.objectUrl) entry.blob=null;
  if((entry.analysisStored||entry.externalAnalysisStored) && entry._analysisLoaded && !entry.open && !(entry.ocr&&entry.ocr.running)){
    entry.digitalText="";
    entry.ocrText="";
    entry.ocrPageTexts={};
    entry.pageTexts=[];
    entry._analysisLoaded=false;
  }
}

function closeEntryResources(entry){
  entry.open=false;
  if(entry._previewRenderTask){
    try{ entry._previewRenderTask.cancel(); }catch(e){}
    entry._previewRenderTask=null;
  }
  if(entry.pdfDoc&&typeof entry.pdfDoc.destroy==="function"){
    try{ entry.pdfDoc.destroy(); }catch(e){}
  }
  entry.pdfDoc=null;
  if(entry.objectUrl){ try{ URL.revokeObjectURL(entry.objectUrl); }catch(e){} }
  entry.objectUrl="";
  if(entry.blobStored||entry.externalStored) entry.blob=null;
  releaseEntryHeavyData(entry);
}

function closeAllActivePreviews(exceptEntry){
  files.forEach(entry=>{
    if(entry!==exceptEntry&&(entry.open||entry.pdfDoc||entry.objectUrl)){
      closeEntryResources(entry);
      dirtyActiveIds.add(entry.id);
    }
  });
}

function closeAllBatchPreviews(exceptEntry){
  batches.forEach(batch=>(batch.patientFiles||[]).forEach(entry=>{
    if(entry!==exceptEntry&&(entry.open||entry.pdfDoc||entry.objectUrl)) closeEntryResources(entry);
  }));
}

let analysisConcurrencyCap=3;
async function processAnalysisChunk(entries,onProgress,onRetry){
  let cursor=0;
  const hardware=Math.max(1,Number(navigator.hardwareConcurrency)||2);
  const memory=Number(navigator.deviceMemory)||4;
  const largest=entries.reduce((max,entry)=>Math.max(max,Number(entry.size)||(entry.blob&&entry.blob.size)||0),0);
  let safeLimit=memory<=4||hardware<=4||largest>=80*1024*1024 ? 1 : (memory<=8||hardware<=8||largest>=30*1024*1024 ? 2 : 3);
  safeLimit=Math.min(safeLimit,analysisConcurrencyCap);
  const concurrency=Math.max(1,Math.min(safeLimit,entries.length));
  async function worker(){
    while(cursor<entries.length){
      const entry=entries[cursor++];
      await analyzeEntryPdf(entry);
      onProgress(entry);
    }
  }
  await Promise.all(Array.from({length:concurrency},()=>worker()));
  // Coba ulang otomatis, satu per satu, untuk kegagalan sementara (timeout/perangkat sibuk).
  // Berkas terkunci/rusak tidak diulang karena hasilnya pasti sama.
  const retryable=entries.filter(entry=>entry.error&&entry.errorKind==="transient");
  if(retryable.length){
    analysisConcurrencyCap=Math.max(1,analysisConcurrencyCap-1);
    for(let i=0;i<retryable.length;i++){
      const entry=retryable[i];
      if(typeof onRetry==="function") onRetry(entry,i,retryable.length);
      await delayMs(300);
      entry.pending=true;
      await analyzeEntryPdf(entry);
      await yieldToBrowser();
    }
  }else{
    analysisConcurrencyCap=Math.min(3,analysisConcurrencyCap+1);
  }
}

function partitionEntriesBySize(entries,maxCount,maxBytes){
  const groups=[];
  let current=[];
  let bytes=0;
  entries.forEach(entry=>{
    const size=Math.max(0,Number(entry.size)||(entry.blob&&entry.blob.size)||0);
    if(current.length&&(current.length>=maxCount||bytes+size>maxBytes)){
      groups.push(current); current=[]; bytes=0;
    }
    current.push(entry); bytes+=size;
  });
  if(current.length) groups.push(current);
  return groups;
}

function formatBytes(bytes){
  if(bytes>=1073741824) return (bytes/1073741824).toFixed(2)+" GB";
  if(bytes>=1048576) return (bytes/1048576).toFixed(1)+" MB";
  return (bytes/1024).toFixed(1)+" KB";
}

async function preflightStorageForFiles(rows, externalFolderReady){
  // Bila Folder Cadangan aktif, PDF baru langsung diarahkan ke folder tersebut;
  // IndexedDB hanya menyimpan metadata ringan sehingga kuota browser bukan batas utama.
  if(externalFolderReady) return true;
  const incoming=rows.reduce((sum,row)=>sum+(row.file.size||0),0);
  if(rows.length>1000||incoming>1.5*1024*1024*1024){
    alert(`Untuk menjaga aplikasi tetap stabil, unggahan ${rows.length} PDF (${formatBytes(incoming)}) harus menggunakan Folder Cadangan SIPEKA. Hubungkan folder cadangan terlebih dahulu, lalu unggah kembali berkas yang sama.`);
    return false;
  }
  if(!(navigator.storage&&navigator.storage.estimate)) return true;
  try{
    const estimate=await navigator.storage.estimate();
    if(!estimate.quota) return true;
    const remaining=Math.max(0,estimate.quota-(estimate.usage||0));
    const required=incoming*1.18+10485760;
    if(required>remaining){
      alert(`Ruang penyimpanan browser tidak cukup untuk menyimpan ${rows.length} PDF sekaligus. Kebutuhan perkiraan ${formatBytes(required)}, ruang tersedia ${formatBytes(remaining)}. Gunakan Sampling lalu kirim ke verifikasi dalam beberapa kelompok; hasil kelompok sebelumnya tetap tersimpan setelah PDF dihapus.`);
      return false;
    }
    if(required>remaining*0.65){
      return confirm(`Unggahan ini memerlukan sekitar ${formatBytes(required)} dari ${formatBytes(remaining)} ruang yang tersedia. Untuk kestabilan, disarankan memproses dan menyelesaikan PDF secara bertahap. Tetap lanjutkan?`);
    }
  }catch(err){ console.warn("Kapasitas penyimpanan tidak dapat diperkirakan:",err); }
  return true;
}

async function processFilesBatch(fileList){
  const incoming = Array.from(fileList).filter(f=>f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  if(incoming.length===0) return {added:0, skipped:0};
  UploadProgress.start(incoming.length, incoming.reduce((s,f)=>s+(f.size||0),0));
  try{ await ensurePdfEngine(); }
  catch(err){ UploadProgress.hide(); alert(err.message||"Mesin pembaca PDF tidak tersedia."); return {added:0,skipped:0,error:true}; }
  const batchFingerprints = new Set();
  const list = [];
  let skipped = 0;
  // Berkas "baca langsung" yang PDF-nya belum terpasang (mis. setelah browser dibuka ulang):
  // bila berkas yang sama dipilih lagi, pasangkan kembali alih-alih dianggap duplikat.
  const looseFileKey=row=>`${String(row.name||"").toLowerCase()}|${Number(row.size)||0}|${Number(row.lastModified)||0}`;
  const detachedByFingerprint = new Map();
  const detachedByLooseKey = new Map();
  files.forEach(entry=>{
    if(!entry.sourceOnly || entry.blob) return;
    if(entry.fingerprint) detachedByFingerprint.set(entry.fingerprint,entry);
    const key=looseFileKey(entry);
    detachedByLooseKey.set(key, detachedByLooseKey.has(key) ? null : entry); // null = ambigu, jangan dipakai
  });
  const reattached = [];
  incoming.forEach(f=>{
    const fingerprint = fileFingerprint(f);
    if(batchFingerprints.has(fingerprint)){ skipped++; return; }
    let waiting = detachedByFingerprint.get(fingerprint) || detachedByLooseKey.get(looseFileKey(f)) || null;
    if(waiting && waiting.blob) waiting=null; // sudah terpasang oleh berkas lain di unggahan ini
    if(waiting){
      batchFingerprints.add(fingerprint);
      waiting.blob=f;
      waiting.sourceMissing=false;
      reattached.push(waiting);
      return;
    }
    if(knownFingerprints.has(fingerprint)){ skipped++; return; }
    batchFingerprints.add(fingerprint);
    list.push({file:f, fingerprint});
  });
  const progress = document.getElementById("progressLine");
  // Berkas terpasang kembali yang analisisnya terputus / gagal karena PDF tidak tersedia dibaca ulang.
  const reanalyze = reattached.filter(entry=>entry.pending || (entry.error && entry.errorKind==="storage"));
  reanalyze.forEach(entry=>{ entry.pending=true; entry.error=null; entry.errorKind=null; });
  reattached.forEach(entry=>{ if(entry.ocr && entry.ocr.error) entry.ocr.error=null; });
  if(list.length===0 && reanalyze.length===0){
    UploadProgress.hide();
    if(reattached.length){
      renderResults();
      reattached.forEach(entry=>enqueueAutoOcr(entry));
      progress.textContent = `${reattached.length} berkas dipasangkan kembali dengan PDF asalnya` + (skipped?`; ${skipped} berkas lain sudah ada.`:".");
    }else{
      progress.textContent = `${skipped} berkas dilewati karena sudah ada di antrean atau sudah selesai diperiksa.`;
    }
    setTimeout(()=>{ progress.textContent=""; }, 5000);
    return {added:0, skipped, reattached:reattached.length};
  }
  const useWorkspaceStorage=!!workspaceDirHandle && await ensureWorkspacePermission(workspaceDirHandle,false);
  UploadProgress.start(list.length+reanalyze.length, list.reduce((s,r)=>s+(r.file.size||0),0));
  document.getElementById("emptyNote").style.display = "none";
  const newEntries = list.map(({file:f,fingerprint})=>{
    const order = fileCounter;
    const id = "f"+(fileCounter++);
    knownFingerprints.add(fingerprint);
    activeFingerprints.add(fingerprint);
    return {
      id, name:f.name, category:guessCategory(f.name,currentEditorCat), digitalText:"", ocrText:"",
      pending:true, itemsStatus:{}, objectUrl:"", blob:f, blobStored:false, open:false, pdfDoc:null,
      sourceOnly:true, // PDF dibaca langsung dari tempat asalnya; tidak disalin ke browser/folder cadangan
      pageTexts:[], ocrCandidates:[], _analysisLoaded:true, analysisStored:false,
      fingerprint, order, size:f.size||0, lastModified:f.lastModified||0,
      ocr:{running:false,done:false,error:null,progress:"",processedPages:[],automatic:false}
    };
  });
  files.push(...newEntries);
  activePage = Math.max(1, Math.ceil(files.length/ACTIVE_PAGE_SIZE));
  renderResults();
  UploadProgress.phase("store");

  // PDF TIDAK disalin, baik ke penyimpanan browser maupun ke Folder Cadangan. Berkas dibaca
  // langsung dari tempat asalnya lewat referensi File yang dipegang selama sesi ini; yang
  // disimpan hanya metadata dan hasil analisis (kecil). Karena itu tidak ada batas kuota dan
  // tidak perlu mencadangkan dulu untuk memeriksa ratusan/ribuan berkas. Setelah browser
  // ditutup hasil tetap ada; untuk pratinjau/OCR cukup pilih ulang berkas yang sama.
  const storageFailures=0;
  activeStorageBarrier=(async()=>{
    for(let i=0;i<newEntries.length;i+=200){
      const chunk=newEntries.slice(i,i+200);
      try{ await dbWriteActiveEntries(chunk,false); }
      catch(err){ chunk.forEach(entry=>dirtyActiveIds.add(entry.id)); updateSaveIndicator(false,err); }
      UploadProgress.store(Math.min(newEntries.length,i+chunk.length));
      await yieldToBrowser();
    }
    return 0;
  })();
  await activeStorageBarrier;

  UploadProgress.phase("read");
  let processed=0;
  const ANALYSIS_CHUNK=50;
  const toAnalyze=reanalyze.concat(newEntries);
  for(let start=0;start<toAnalyze.length;start+=ANALYSIS_CHUNK){
    const chunk=toAnalyze.slice(start,start+ANALYSIS_CHUNK);
    await processAnalysisChunk(chunk,()=>{
      processed++;
      UploadProgress.read(processed);
      progress.textContent=`Memproses file ${processed} dari ${toAnalyze.length}${skipped?` • ${skipped} duplikat dilewati`:""}...`;
    },(entry,i,total)=>{
      UploadProgress.note(`mencoba ulang berkas yang tersendat (${i+1}/${total})`);
      progress.textContent=`Mencoba ulang otomatis ${i+1} dari ${total} berkas yang tersendat...`;
    });
    try{
      await flushDirtyAnalysisEntries();
      await flushDirtyActiveEntries();
    }catch(err){ updateSaveIndicator(false,err); }
    chunk.forEach(releaseEntryHeavyData);
    renderResults();
    await yieldToBrowser();
  }
  await persistState();
  // Cadangan hasil ke folder berjalan di latar belakang; pengguna tidak perlu menunggunya.
  if(useWorkspaceStorage) scheduleWorkspaceBackup(1500);
  reattached.forEach(entry=>{ if(!entry.pending && !entry.error) enqueueAutoOcr(entry); });
  const failedAfterImport=toAnalyze.filter(entry=>entry.error).length;
  UploadProgress.finish(failedAfterImport, storageFailures);
  progress.textContent = `Selesai memproses ${toAnalyze.length} file` +
    (reattached.length ? `; ${reattached.length} berkas dipasangkan kembali dengan PDF asalnya` : "") +
    (failedAfterImport ? `; ${failedAfterImport} gagal dibaca (lihat kotak merah untuk memuat ulang sekaligus)` : "") +
    (skipped ? `; ${skipped} duplikat tidak dimasukkan` : "") +
    (storageFailures ? `; ${storageFailures} PDF tidak berhasil disimpan permanen karena keterbatasan penyimpanan.` : ".");
  setTimeout(()=>{ progress.textContent=""; }, 5000);
  return {added:newEntries.length, skipped};
}

async function resumeInterruptedFiles(){
  const pendingEntries = files.filter(entry=>entry.pending);
  if(!pendingEntries.length) return;
  const progress = document.getElementById("progressLine");
  let processed=0;
  for(let start=0;start<pendingEntries.length;start+=50){
    const chunk=pendingEntries.slice(start,start+50);
    await processAnalysisChunk(chunk,()=>{
      processed++;
      progress.textContent=`Melanjutkan pemrosesan ${processed} dari ${pendingEntries.length} berkas yang tertunda...`;
    });
    try{ await flushDirtyAnalysisEntries(); await flushDirtyActiveEntries(); }
    catch(err){ updateSaveIndicator(false,err); }
    chunk.forEach(releaseEntryHeavyData);
    renderResults();
    await yieldToBrowser();
  }
  await persistState();
  progress.textContent = `${pendingEntries.length} berkas tertunda selesai diproses.`;
  setTimeout(()=>{ progress.textContent=""; },5000);
}

/* ---------------- Sampling ukuran berkas (menu terpisah, tidak mengubah verifikasi lain) ---------------- */
let samplingFiles = []; // tetap utuh saat dikirim ke verifikasi/ketika PDF aktif dihapus
let samplingCounter = 0;
let samplingSortMode = "original"; // original | smallest | largest
let samplingPage = 1;
let samplingSearchQuery = ""; // pencarian nama berkas di menu Sampling
const SAMPLING_PAGE_SIZE = 200;

function fmtKB(bytes){
  const kb = bytes/1024;
  if(kb>=1024) return (kb/1024).toFixed(2)+" MB";
  return kb.toFixed(1)+" KB";
}

function samplingThresholdKB(){
  const el = document.getElementById("samplingThreshold");
  const v = parseFloat(el && el.value);
  return isNaN(v) || v<0 ? 0 : v;
}

let samplingBackupOwnsBar = false;
let samplingImportQueue = Promise.resolve();
let samplingBatchesWaiting = 0;
function handleSamplingFiles(fileList){
  const captured = Array.from(fileList||[]);
  samplingBatchesWaiting++;
  SamplingProgress.queue(samplingBatchesWaiting);
  const run = async ()=>{
    samplingBatchesWaiting = Math.max(0,samplingBatchesWaiting-1);
    SamplingProgress.queue(samplingBatchesWaiting);
    try{ return await processSamplingFiles(captured); }
    catch(err){ SamplingProgress.hide(); throw err; }
  };
  samplingImportQueue = samplingImportQueue.then(run,run);
  return samplingImportQueue;
}

async function processSamplingFiles(all){
  const pdfs = all.filter(f=>f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  const skipped = all.length - pdfs.length;
  const progress = document.getElementById("samplingProgressLine");
  if(pdfs.length===0){
    SamplingProgress.hide();
    if(progress){
      progress.textContent = "Tidak ada berkas PDF ditemukan di pilihan tersebut.";
      setTimeout(()=>{ progress.textContent=""; }, 4500);
    }
    return {added:0};
  }
  const hasFolder = !!workspaceDirHandle;
  SamplingProgress.start({
    total:pdfs.length,
    totalBytes:pdfs.reduce((s,f)=>s+(f.size||0),0),
    steps: ["prep","list"]
  });
  await yieldToBrowser();   // beri kesempatan browser menggambar bar sebelum loop panjang
  SamplingProgress.phase("list");
  const existing = new Map(samplingFiles.map(row=>[row.fingerprint,row]));
  let duplicateCount = 0;
  let reattachedCount = 0;
  let addedCount = 0;
  const CHUNK = 400;
  for(let i=0;i<pdfs.length;i++){
    const f = pdfs[i];
    const fingerprint = fileFingerprint(f);
    if(existing.has(fingerprint)){
      const old=existing.get(fingerprint);
      if(!old.file){ old.file=f; old.unavailable=false; reattachedCount++; }
      else duplicateCount++;
    }else{
      const id = "sf"+(samplingCounter++);
      const relPath = f.webkitRelativePath && f.webkitRelativePath.length ? f.webkitRelativePath : "";
      samplingFiles.push({
        id, name:f.name, relPath, size:f.size, lastModified:f.lastModified||0,
        file:f, checked:false, fingerprint, originalOrder:samplingCounter-1
      });
      existing.set(fingerprint,samplingFiles[samplingFiles.length-1]);
      addedCount++;
    }
    if((i+1)%CHUNK===0 || i===pdfs.length-1){
      SamplingProgress.progress("list", i+1);
      if(i<pdfs.length-1) await yieldToBrowser();
    }
  }
  samplingPage = 1;
  renderSamplingList();
  scheduleSave(100);

  const backupOk = true;
  // Hanya daftar sampling yang ikut dicadangkan (file sesi); PDF-nya tidak disalin.
  if(hasFolder) scheduleWorkspaceBackup(500);
  SamplingProgress.finish({
    text:`${addedCount} berkas ditambahkan`+(duplicateCount?`, ${duplicateCount} duplikat dilewati`:"")+(reattachedCount?`, ${reattachedCount} dipasangkan kembali`:"")+(skipped?`, ${skipped} non-PDF diabaikan`:""),
    warn: (!backupOk && hasFolder) ? "pencadangan ke folder belum selesai" : ""
  });
  if(!backupOk && hasFolder){
    if(progress) progress.textContent="Daftar berhasil dibuat, tetapi pencadangan ke folder belum selesai. Periksa status Folder Cadangan.";
  }else if(progress){
    progress.textContent = `Ditambahkan ${pdfs.length-duplicateCount} berkas PDF` +
      (duplicateCount>0 ? `; ${duplicateCount} duplikat dilewati` : "") +
      (reattachedCount>0 ? `; ${reattachedCount} berkas dipasangkan kembali` : "") +
      (skipped>0 ? `; ${skipped} berkas non-PDF diabaikan.` : ".");
    setTimeout(()=>{ progress.textContent=""; }, 4500);
  }
  return {added:addedCount};
}

function samplingState(item){
  if(archivedFingerprints.has(item.fingerprint)) return "Selesai diperiksa";
  if(activeFingerprints.has(item.fingerprint)) return "Di antrean verifikasi";
  return "";
}

function samplingFileAvailable(item){
  return !!item.file || (!!item.externalStored && !!workspaceDirHandle);
}

function renderPagination(container, page, totalPages, onChange, itemLabel){
  if(!container) return;
  if(totalPages<=1){ container.innerHTML=""; return; }
  container.innerHTML = `
    <button type="button" data-page="prev" ${page<=1?"disabled":""}>&larr; Sebelumnya</button>
    <span>Halaman ${page} dari ${totalPages} &bull; ${itemLabel||""}</span>
    <button type="button" data-page="next" ${page>=totalPages?"disabled":""}>Berikutnya &rarr;</button>`;
  container.querySelector('[data-page="prev"]').onclick = ()=>onChange(page-1);
  container.querySelector('[data-page="next"]').onclick = ()=>onChange(page+1);
}

function keepAnchorPosition(anchorId,updateFn){
  const beforeEl=document.getElementById(anchorId);
  const beforeTop=beforeEl ? beforeEl.getBoundingClientRect().top : null;
  updateFn();
  requestAnimationFrame(()=>{
    if(beforeTop===null) return;
    const afterEl=document.getElementById(anchorId);
    if(!afterEl) return;
    const delta=afterEl.getBoundingClientRect().top-beforeTop;
    if(Math.abs(delta)>0.5) window.scrollBy({top:delta,left:0,behavior:"auto"});
  });
}

function renderSamplingList(){
  const wrap = document.getElementById("samplingList");
  const toolbar = document.getElementById("samplingToolbar");
  const emptyNote = document.getElementById("samplingEmptyNote");
  const verifyBar = document.getElementById("samplingVerifyBar");
  if(!wrap) return;

  if(samplingFiles.length===0){
    wrap.innerHTML = "";
    toolbar.style.display = "none";
    emptyNote.style.display = "";
    verifyBar.style.display = "none";
    const pagination = document.getElementById("samplingPagination");
    if(pagination) pagination.innerHTML = "";
    return;
  }
  emptyNote.style.display = "none";
  toolbar.style.display = "flex";

  const threshold = samplingThresholdKB();
  const searchQuery = samplingSearchQuery.trim().toLowerCase();
  const sorted = [...samplingFiles].filter(item=>{
    if(!searchQuery) return true;
    return (item.name||"").toLowerCase().includes(searchQuery) || (item.relPath||"").toLowerCase().includes(searchQuery);
  }).sort((a,b)=>{
    if(samplingSortMode==="smallest") return a.size-b.size || a.originalOrder-b.originalOrder;
    if(samplingSortMode==="largest") return b.size-a.size || a.originalOrder-b.originalOrder;
    return a.originalOrder-b.originalOrder;
  });
  const suspiciousCount = samplingFiles.reduce((n,item)=>n+((item.size/1024)<threshold?1:0),0);
  const totalPages = Math.max(1,Math.ceil(sorted.length/SAMPLING_PAGE_SIZE));
  samplingPage = Math.min(Math.max(1,samplingPage),totalPages);
  const pageRows = sorted.slice((samplingPage-1)*SAMPLING_PAGE_SIZE,samplingPage*SAMPLING_PAGE_SIZE);

  wrap.innerHTML = "";
  if(searchQuery && sorted.length===0){
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "empty-note";
    emptyMsg.textContent = `Tidak ada berkas dengan nama mengandung \u201c${samplingSearchQuery.trim()}\u201d.`;
    wrap.appendChild(emptyMsg);
  }
  pageRows.forEach(item=>{
    const kb = item.size/1024;
    const suspicious = kb < threshold;
    const state = samplingState(item);
    const unavailable=!samplingFileAvailable(item);
    const row = document.createElement("div");
    row.className = "sampling-row" + (suspicious ? " suspicious" : "") + (state ? " processed" : "");
    row.innerHTML = `
      <input type="checkbox" ${item.checked?"checked":""} ${(state||unavailable)?"disabled":""}>
      <div class="sr-name">${escapeAttr(item.name)}${item.relPath ? `<span class="sr-path">${escapeAttr(item.relPath)}</span>` : ""}</div>
      ${suspicious ? `<span class="sr-badge">Dicurigai</span>` : `<span class="sr-badge-spacer"></span>`}
      ${state ? `<span class="sr-state">${state}</span>` : (unavailable?`<span class="sr-state" title="PDF tidak disalin ke folder cadangan. Pilih lagi folder asalnya di atas; berkas akan dipasangkan otomatis.">Pilih ulang folder asal</span>`:(item.externalStored&&!item.file?`<span class="sr-state">Tersedia di cadangan</span>`:""))}
      <span class="sr-size">${fmtKB(item.size)}</span>
    `;
    row.querySelector("input[type=checkbox]").addEventListener("change", e=>{
      item.checked = e.target.checked;
      updateSamplingSelectedCount();
    });
    wrap.appendChild(row);
  });

  const summaryEl = document.getElementById("samplingSummary");
  if(summaryEl){
    const done = samplingFiles.reduce((n,item)=>n+(archivedFingerprints.has(item.fingerprint)?1:0),0);
    const searchSuffix = searchQuery ? ` &bull; ${sorted.length} cocok dengan pencarian` : "";
    summaryEl.innerHTML = `${samplingFiles.length} berkas &bull; <strong>${suspiciousCount} dicurigai</strong> (&lt; ${threshold} KB) &bull; ${done} selesai${searchSuffix}`;
  }
  renderPagination(document.getElementById("samplingPagination"),samplingPage,totalPages,next=>{
    keepAnchorPosition("samplingPagination",()=>{ samplingPage=next; renderSamplingList(); });
  },`${SAMPLING_PAGE_SIZE} baris/halaman`);
  updateSamplingSelectedCount();
}

function updateSamplingSelectedCount(){
  const n = samplingFiles.filter(f=>f.checked).length;
  const verifyBar = document.getElementById("samplingVerifyBar");
  const countEl = document.getElementById("samplingSelectedCount");
  if(countEl) countEl.textContent = n + " berkas dipilih";
  if(verifyBar) verifyBar.style.display = n>0 ? "flex" : "none";
}

document.getElementById("samplingDropZone").addEventListener("click", ()=>document.getElementById("samplingFolderInput").click());
document.getElementById("samplingFilesDropZone").addEventListener("click", ()=>document.getElementById("samplingFilesInput").click());
document.getElementById("samplingFolderInput").addEventListener("change", e=>{ handleSamplingFiles(e.target.files); e.target.value=""; });
document.getElementById("samplingFilesInput").addEventListener("change", e=>{ handleSamplingFiles(e.target.files); e.target.value=""; });
document.getElementById("samplingThreshold").addEventListener("input", ()=>{ renderSamplingList(); scheduleSave(); });
document.getElementById("samplingSearchInput").addEventListener("input", e=>{
  samplingSearchQuery = e.target.value;
  document.getElementById("samplingSearchBox").classList.toggle("has-value", samplingSearchQuery.trim().length>0);
  samplingPage = 1;
  renderSamplingList();
});
document.getElementById("samplingSearchClear").addEventListener("click", ()=>{
  samplingSearchQuery = "";
  const input = document.getElementById("samplingSearchInput");
  input.value = "";
  document.getElementById("samplingSearchBox").classList.remove("has-value");
  samplingPage = 1;
  renderSamplingList();
  input.focus();
});

document.getElementById("samplingSelectSuspicious").addEventListener("click", ()=>{
  const threshold = samplingThresholdKB();
  samplingFiles.forEach(f=>{ if(samplingFileAvailable(f)&&(f.size/1024)<threshold && !samplingState(f)) f.checked = true; });
  renderSamplingList();
});
document.getElementById("samplingSelectAll").addEventListener("click", ()=>{
  samplingFiles.forEach(f=>f.checked=samplingFileAvailable(f)&&!samplingState(f));
  renderSamplingList();
});
document.getElementById("samplingSelectNone").addEventListener("click", ()=>{
  samplingFiles.forEach(f=>f.checked=false);
  renderSamplingList();
});
document.getElementById("samplingQuickCount").addEventListener("keydown", e=>{
  if(e.key==="Enter"){ e.preventDefault(); document.getElementById("samplingQuickPickBtn").click(); }
});
document.getElementById("samplingQuickPickBtn").addEventListener("click", ()=>{
  const input = document.getElementById("samplingQuickCount");
  const n = parseInt(input && input.value, 10);
  if(!n || n<=0){
    input && input.focus();
    return;
  }
  // Urutan yang sama persis dengan yang ditampilkan di daftar (mengikuti samplingSortMode)
  const sorted = [...samplingFiles].sort((a,b)=>{
    if(samplingSortMode==="smallest") return a.size-b.size || a.originalOrder-b.originalOrder;
    if(samplingSortMode==="largest") return b.size-a.size || a.originalOrder-b.originalOrder;
    return a.originalOrder-b.originalOrder;
  });
  samplingFiles.forEach(f=>{ f.checked=false; });
  let picked = 0;
  for(const item of sorted){
    if(picked>=n) break;
    if(samplingFileAvailable(item) && !samplingState(item)){
      item.checked = true;
      picked++;
    }
  }
  samplingPage = 1;
  renderSamplingList();
  const progress = document.getElementById("samplingProgressLine");
  if(progress){
    progress.textContent = picked<n
      ? `Hanya ${picked} berkas yang tersedia untuk dipilih (diminta ${n}).`
      : `${picked} berkas teratas telah dipilih. Silakan lanjut ke Verifikasi berkas terpilih di bawah.`;
    setTimeout(()=>{ progress.textContent=""; }, 4500);
  }
  document.getElementById("samplingVerifyBar")?.scrollIntoView({behavior:"smooth", block:"nearest"});
});
document.getElementById("samplingSortToggle").addEventListener("click", (e)=>{
  samplingSortMode = samplingSortMode==="original" ? "smallest" : (samplingSortMode==="smallest" ? "largest" : "original");
  e.target.textContent = "Urutkan: " + (samplingSortMode==="original" ? "Urutan unggah" : (samplingSortMode==="smallest" ? "Ukuran terkecil" : "Ukuran terbesar"));
  samplingPage = 1;
  renderSamplingList();
  scheduleSave();
});
document.getElementById("samplingClearBtn").addEventListener("click", async ()=>{
  if(samplingFiles.length && !confirm("Hapus seluruh daftar sampling ini? (Berkas yang sudah dikirim ke \u201cVerifikasi per Berkas\u201d tidak akan terpengaruh.)")) return;
  const removedItems=samplingFiles.slice();
  removedItems.forEach(item=>workspaceSyncedPdfIds.delete(`sampling:${item.id}`));
  samplingFiles = [];
  document.getElementById("samplingFolderInput").value = "";
  document.getElementById("samplingFilesInput").value = "";
  renderSamplingList();
  await persistState();
  if(workspaceDirHandle&&await ensureWorkspacePermission(workspaceDirHandle,false)){
    const manifestSaved=await saveWorkspaceBackup(true);
    if(manifestSaved){
      const samplingPdfDir=await getWorkspaceDirectory("sampling-pdfs",true);
      for(const item of removedItems){
        await deleteWorkspaceEntryIfPresent(samplingPdfDir,item.externalFileName||`${workspaceFileName(item.id)}.pdf`);
      }
    }
  }
});
document.getElementById("samplingVerifyBtn").addEventListener("click", async ()=>{
  const selected = samplingFiles.filter(f=>f.checked&&samplingFileAvailable(f));
  if(selected.length===0) return;
  const chosenFiles=[];
  try{
    for(const item of selected){
      if(item.file){ chosenFiles.push(item.file); continue; }
      const blob=await readWorkspaceBlob(item.externalPdfFolder||"sampling-pdfs",item.externalFileName||`${workspaceFileName(item.id)}.pdf`);
      const restoredFile=new File([blob],item.name,{type:"application/pdf",lastModified:item.lastModified||Date.now()});
      if(item.relPath){
        try{ Object.defineProperty(restoredFile,"webkitRelativePath",{value:item.relPath}); }catch(e){}
      }
      item.file=restoredFile;
      item.unavailable=false;
      chosenFiles.push(restoredFile);
    }
  }catch(err){
    alert(`Berkas sampling tidak dapat dibuka dari cadangan: ${err.message||err}. Hubungkan kembali folder cadangan lalu coba lagi.`);
    return;
  }
  selected.forEach(item=>{ item.checked=false; });
  document.querySelectorAll("#viewSwitch button").forEach(b=>b.classList.toggle("active", b.dataset.view==="perfile"));
  document.getElementById("perFileView").style.display = "";
  document.getElementById("batchView").style.display = "none";
  document.getElementById("samplingView").style.display = "none";
  activeView = "perfile";
  renderSamplingList();
  scheduleSave(100);
  await handleFiles(chosenFiles);
});

/* ---------------- OCR otomatis bertahap untuk halaman hasil scan ---------------- */
let tesseractWorkerPromise = null;
let tesseractRecognitionBarrier = Promise.resolve();
let autoOcrQueue = [];
const autoOcrQueuedIds = new Set();
const autoOcrJobsById = new Map();
let autoOcrLoopRunning = false;
let autoOcrActiveEntry = null;
let lastAutoOcrRenderAt = 0;
let autoOcrGeneration = 0;
function loadScriptOnce(src,integrity){
  return new Promise((resolve,reject)=>{
    if(window.Tesseract){ resolve(); return; }
    const existing=document.querySelector(`script[data-src="${src}"]`);
    if(existing){
      if(existing.dataset.loaded==="1") existing.remove();
      else{
        existing.addEventListener("load",()=>resolve(),{once:true});
        existing.addEventListener("error",()=>reject(new Error("Gagal memuat mesin OCR dari jaringan.")),{once:true});
        return;
      }
    }
    const s = document.createElement("script");
    s.src = src; s.dataset.src = src;
    if(integrity){ s.integrity = integrity; s.crossOrigin = "anonymous"; }
    s.onload = ()=>{ s.dataset.loaded="1"; resolve(); };
    s.onerror = ()=>{ s.remove(); reject(new Error("Gagal memuat mesin OCR dari jaringan.")); };
    document.head.appendChild(s);
  });
}
async function ensureTesseractWorker(){
  if(!tesseractWorkerPromise){
    tesseractWorkerPromise = (async ()=>{
      const TESS_SRC="https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js";
      const TESS_SRI="sha384-Ptw8HCYAWF6vIop6WuGxfSCiDCIzUWqjrHYfx8Vd0S4CMBaicAdBh2y+Ufle664A";
      try{
        await loadScriptOnce(TESS_SRC,TESS_SRI);
      }catch(primaryError){
        await loadScriptOnce(TESS_SRC,TESS_SRI);
      }
      if(!window.Tesseract) throw new Error("Mesin OCR gagal diinisialisasi.");
      return await window.Tesseract.createWorker("eng");
    })().catch(err=>{ tesseractWorkerPromise=null; throw err; });
  }
  return tesseractWorkerPromise;
}
async function recognizeCanvasWithTesseract(canvas){
  const worker=await ensureTesseractWorker();
  const job=tesseractRecognitionBarrier.then(()=>worker.recognize(canvas));
  tesseractRecognitionBarrier=job.catch(()=>{});
  return job;
}
function ocrCandidatePages(entry){
  if(Array.isArray(entry.ocrCandidates)) return entry.ocrCandidates.slice();
  return (entry.pageTexts||[]).map((t,idx)=>({idx,len:String(t||"").trim().length})).filter(x=>x.len<20).map(x=>x.idx);
}
function ocrProcessedPageSet(entry){
  entry.ocr=entry.ocr||{running:false,done:false,error:null,progress:"",processedPages:[]};
  entry.ocr.processedPages=Array.isArray(entry.ocr.processedPages)?entry.ocr.processedPages:[];
  return new Set(entry.ocr.processedPages.map(Number).filter(Number.isFinite));
}
function ocrRemainingPages(entry){
  const processed=ocrProcessedPageSet(entry);
  return ocrCandidatePages(entry).filter(pageIndex=>!processed.has(pageIndex));
}
function isAutoOcrQueued(entry){ return !!(entry&&autoOcrQueuedIds.has(entry.id)); }
function resetAutoOcrQueue(){
  autoOcrGeneration++;
  autoOcrQueue=[];
  autoOcrQueuedIds.clear();
  autoOcrJobsById.clear();
  updateAutoOcrStatus();
}
function dropAutomaticOcrQueue(){
  autoOcrQueue=autoOcrQueue.filter(job=>job.force);
  autoOcrQueuedIds.clear();
  autoOcrJobsById.clear();
  autoOcrQueue.forEach(job=>{ autoOcrQueuedIds.add(job.entry.id); autoOcrJobsById.set(job.entry.id,job); });
}

function updateAutoOcrStatus(){
  const el=document.getElementById("autoOcrStatus");
  if(!el) return;
  const waiting=autoOcrQueue.length;
  if(autoOcrActiveEntry){
    el.textContent=`${autoOcrActiveEntry.ocr.progress||"OCR sedang berjalan"}${waiting?` • ${waiting} berkas menunggu`:""}`;
  }else if(!autoOcrEnabled){
    el.textContent=`OCR otomatis dijeda${waiting?` • ${waiting} berkas menunggu`:""}.`;
  }else if(waiting){
    el.textContent=`${waiting} berkas menunggu OCR otomatis.`;
  }else{
    el.textContent="OCR otomatis siap.";
  }
}
function renderAutoOcrProgress(force){
  updateAutoOcrStatus();
  const now=Date.now();
  if(force || now-lastAutoOcrRenderAt>800){
    lastAutoOcrRenderAt=now;
    if(activeView==="batch") renderBatches(); else renderResults();
  }
}
function enqueueAutoOcr(entry,options){
  options=options||{};
  if(!autoOcrEnabled&&!options.force) return false;
  if(!entry||entry.pending||entry.error||(entry.ocr&&entry.ocr.done)||ocrCandidatePages(entry).length===0) return false;
  const job=autoOcrJobsById.get(entry.id);
  if(job){
    if(options.force) job.force=true;
    if(options.renderFn) job.renderFn=options.renderFn;
    if(options.evalFn) job.evalFn=options.evalFn;
    if(typeof options.persistActive==="boolean") job.persistActive=options.persistActive;
    if(options.front){
      const existingIndex=autoOcrQueue.indexOf(job);
      if(existingIndex>0){ autoOcrQueue.splice(existingIndex,1); autoOcrQueue.unshift(job); }
    }
  }else if(entry!==autoOcrActiveEntry){
    const newJob={entry,force:!!options.force,renderFn:options.renderFn||renderResults,evalFn:options.evalFn||evaluateFile,generation:autoOcrGeneration,persistActive:options.persistActive!==false};
    if(options.front) autoOcrQueue.unshift(newJob); else autoOcrQueue.push(newJob);
    autoOcrQueuedIds.add(entry.id);
    autoOcrJobsById.set(entry.id,newJob);
  }
  updateAutoOcrStatus();
  setTimeout(processAutoOcrQueue,40);
  return true;
}
function enqueueAllPendingOcr(){
  files.forEach(entry=>enqueueAutoOcr(entry));
  batches.forEach(batch=>{
    const cat=kolektifCategories[batch.service];
    batch.patientFiles.forEach(entry=>enqueueAutoOcr(entry,{renderFn:renderBatches,evalFn:(en)=>evaluateAgainstCat(en,cat),persistActive:false}));
  });
  updateAutoOcrStatus();
}
function syncAutoOcrControls(){
  const toggle=document.getElementById("autoOcrToggle");
  if(!toggle) return;
  toggle.checked=autoOcrEnabled;
  if(!toggle.dataset.bound){
    toggle.dataset.bound="1";
    toggle.addEventListener("change",()=>{
      autoOcrEnabled=toggle.checked;
      scheduleSave(100);
      if(autoOcrEnabled){ enqueueAllPendingOcr(); processAutoOcrQueue(); }
      else dropAutomaticOcrQueue();
      updateAutoOcrStatus();
      renderAutoOcrProgress(true);
    });
  }
  updateAutoOcrStatus();
}
async function releaseOcrResources(entry){
  if(entry.open) return;
  await destroyPdfDocument(entry.pdfDoc);
  entry.pdfDoc=null;
  if(entry.objectUrl){ try{ URL.revokeObjectURL(entry.objectUrl); }catch(e){} entry.objectUrl=""; }
  releaseEntryHeavyData(entry);
}
async function processAutoOcrQueue(){
  if(autoOcrLoopRunning) return;
  autoOcrLoopRunning=true;
  try{
    while(autoOcrQueue.length){
      const next=autoOcrQueue[0];
      if(!autoOcrEnabled&&!next.force) break;
      const job=autoOcrQueue.shift();
      autoOcrQueuedIds.delete(job.entry.id);
      autoOcrJobsById.delete(job.entry.id);
      if(job.entry.ocr&&job.entry.ocr.done) continue;
      autoOcrActiveEntry=job.entry;
      updateAutoOcrStatus();
      await runOcr(job.entry,()=>renderAutoOcrProgress(false),job.evalFn,{automatic:!job.force,generation:job.generation,persistActive:job.persistActive});
      await releaseOcrResources(job.entry);
      renderAutoOcrProgress(true);
      autoOcrActiveEntry=null;
      await yieldToBrowser();
    }
  }finally{
    autoOcrActiveEntry=null;
    autoOcrLoopRunning=false;
    updateAutoOcrStatus();
  }
}
async function persistOcrCheckpoint(entry,options){
  options=options||{};
  const persistActive=options.persistActive!==false;
  entry.analysisStored=false;
  dirtyAnalysisIds.delete(entry.id);
  dirtyActiveIds.delete(entry.id);
  try{
    await dbWriteAnalysisEntries([entry]);
    if(persistActive) await dbWriteActiveEntries([entry],false);
    else await dbPut(DB_STORE,DB_KEY,buildSnapshot());
    if(workspaceDirHandle){ workspaceDirtyAnalysisIds.add(entry.id); scheduleWorkspaceBackup(); }
    updateSaveIndicator(true);
  }catch(err){
    if(persistActive){ dirtyAnalysisIds.add(entry.id); dirtyActiveIds.add(entry.id); }
    else scheduleSave(50);
    updateSaveIndicator(false,err);
  }
}
async function runOcr(entry, renderFn, evalFn, options){
  renderFn = renderFn || renderResults;
  evalFn = evalFn || evaluateFile;
  options=options||{};
  const generation=Number.isFinite(options.generation)?options.generation:autoOcrGeneration;
  if(entry.ocr.running) return;
  try{ await ensureAnalysisData(entry); }
  catch(err){ entry.ocr.error="Data analisis berkas tidak dapat dimuat ulang."; renderFn(); return; }
  if(!entry.pdfDoc){
    try{
      await ensureEntryBlob(entry);
      entry.pdfDoc = await openPdfDocument(entry.blob,entry.name,120000);
    }catch(err){
      entry.ocr.error = "Gagal memuat ulang berkas untuk OCR.";
      renderFn();
      return;
    }
  }
  const targets = ocrRemainingPages(entry);
  if(targets.length===0){
    entry.ocr.done=true; entry.ocr.progress="";
    if(options.persistActive!==false) markEntryDirty(entry); else scheduleSave(50);
    return;
  }
  const processed=ocrProcessedPageSet(entry);
  entry.ocr.running = true;
  entry.ocr.automatic=!!options.automatic;
  entry.ocr.error=null;
  entry.ocr.progress = "Menyiapkan mesin OCR...";
  renderFn();
  try{
    await ensureTesseractWorker();
    for(let k=0;k<targets.length;k++){
      if(generation!==autoOcrGeneration) break;
      if(options.automatic&&!autoOcrEnabled) break;
      const pageIndex=targets[k];
      const pageNum = pageIndex+1;
      entry.ocr.progress = `OCR ${entry.name}: halaman ${pageNum} \u2014 ${processed.size+1}/${ocrCandidatePages(entry).length}`;
      renderFn();
      const page = await entry.pdfDoc.getPage(pageNum);
      const baseViewport=page.getViewport({scale:1});
      const ocrScale=boundedCanvasScale(baseViewport.width,baseViewport.height,2,3200,8*1024*1024);
      const viewport = page.getViewport({scale:ocrScale});
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context=canvas.getContext("2d",{alpha:false});
      context.fillStyle="#fff"; context.fillRect(0,0,canvas.width,canvas.height);
      let result;
      try{
        await page.render({canvasContext:context, viewport}).promise;
        result = await recognizeCanvasWithTesseract(canvas);
      }finally{
        try{ page.cleanup(); }catch(e){}
        canvas.width=1; canvas.height=1;
      }
      if(generation!==autoOcrGeneration) break;
      const readText=(result.data.text||"").toLowerCase();
      entry.ocrText += "\n" + readText;
      entry.ocrPageTexts = entry.ocrPageTexts || {};
      entry.ocrPageTexts[pageIndex] = readText.replace(/[\r\n]+/g," ");
      entry.pageTexts[pageIndex] = compactPageText(readText);
      processed.add(pageIndex);
      entry.ocr.processedPages=Array.from(processed).sort((a,b)=>a-b);
      evalFn(entry);
      if(options.persistActive!==false){ dirtyAnalysisIds.add(entry.id); dirtyActiveIds.add(entry.id); }
      workspaceDirtyAnalysisIds.add(entry.id);
      if((k+1)%3===0) await persistOcrCheckpoint(entry,options);
      await yieldToBrowser();
    }
    entry.ocr.running=false;
    if(generation!==autoOcrGeneration) return;
    entry.ocr.done=ocrRemainingPages(entry).length===0;
    entry.ocr.progress=entry.ocr.done?"":"OCR dijeda; progres sudah tersimpan.";
    evalFn(entry);
    await persistOcrCheckpoint(entry,options);
  }catch(err){
    entry.ocr.running=false;
    if(generation!==autoOcrGeneration) return;
    entry.ocr.error = err.message || "OCR gagal berjalan.";
    entry.ocr.progress="";
    await persistOcrCheckpoint(entry,options);
  }
  renderFn();
}

/* ---------------- Pratinjau PDF berbasis canvas (pdf.js) ---------------- */
async function ensureAnalysisData(entry){
  if(entry._analysisLoaded) return entry;
  // Berkas kolektif baru masih menyimpan analisis langsung di objeknya.
  if(!entry.analysisStored && entry.blob && (entry.digitalText || (entry.pageTexts&&entry.pageTexts.length))){
    entry._analysisLoaded=true;
    entry.ocrText=entry.ocrText||"";
    return entry;
  }
  let row=await dbGet(DB_ANALYSIS_STORE,entry.id);
  if(!row && entry.externalAnalysisStored && workspaceDirHandle){
    try{
      const blob=await readWorkspaceBlob("analysis",`${workspaceFileName(entry.id)}.json`);
      row=JSON.parse(await blob.text());
    }catch(err){ console.warn("Analisis cadangan tidak dapat dimuat:",err); }
  }
  entry.digitalText=(row&&row.digitalText)||"";
  entry.ocrText=(row&&row.ocrText)||"";
  entry.ocrPageTexts=(row&&row.ocrPageTexts&&typeof row.ocrPageTexts==="object")?row.ocrPageTexts:{};
  entry.pageTexts=((row&&row.pageTexts)||[]).map(compactPageText);
  entry._analysisLoaded=true;
  return entry;
}

async function ensureEntryBlob(entry){
  if(entry.blob){
    if(!entry.objectUrl){ try{ entry.objectUrl=URL.createObjectURL(entry.blob); }catch(e){ entry.objectUrl=""; } }
    return entry.blob;
  }
  let blob=null;
  if(entry.blobStored) blob=await dbGet(DB_BLOB_STORE,entry.id);
  if(!blob && entry.externalStored && workspaceDirHandle){
    blob=await readWorkspaceBlob(entry.externalPdfFolder||"active-pdfs",entry.externalFileName||`${workspaceFileName(entry.id)}.pdf`);
  }
  if(!blob){
    if(entry.sourceOnly) throw new Error(SOURCE_MISSING_MESSAGE);
    if(entry.externalStored) throw new Error("berkas ada di cadangan; hubungkan atau pulihkan folder cadangan terlebih dahulu");
    throw new Error("berkas asli tidak ditemukan di penyimpanan");
  }
  entry.blob = blob;
  if(!entry.objectUrl){
    try{ entry.objectUrl = URL.createObjectURL(blob); }catch(e){ entry.objectUrl=""; }
  }
  return blob;
}

async function ensurePdfDocForEntry(entry){
  if(entry.pdfDoc) return entry.pdfDoc;
  await ensureEntryBlob(entry);
  entry.pdfDoc = await openPdfDocument(entry.blob,entry.name,120000);
  return entry.pdfDoc;
}

function buildViewerPaneInnerHtml(entry){
  return `
    <div class="viewer-toolbar">
      <span class="viewer-page-info">Memuat pratinjau&hellip;</span>
      <div class="viewer-nav">
        <button class="viewer-nav-btn viewer-zoom-out" type="button" title="Perkecil" disabled>&minus;</button>
        <span class="viewer-zoom-level">100%</span>
        <button class="viewer-nav-btn viewer-zoom-in" type="button" title="Perbesar" disabled>&plus;</button>
        <button class="viewer-nav-btn viewer-zoom-reset" type="button" title="Muat ke lebar panel" disabled>&#8596;</button>
        <button class="viewer-nav-btn viewer-rotate-left" type="button" title="Putar ke kiri" disabled>&#8634;</button>
        <button class="viewer-nav-btn viewer-rotate-right" type="button" title="Putar ke kanan" disabled>&#8635;</button>
        <span class="viewer-nav-sep"></span>
        <button class="viewer-nav-btn viewer-prev" type="button" title="Halaman sebelumnya" disabled>&#8592;</button>
        <button class="viewer-nav-btn viewer-next" type="button" title="Halaman berikutnya" disabled>&#8594;</button>
        <a href="${entry.objectUrl||'#'}" target="_blank" rel="noopener noreferrer">Buka di tab baru &#8599;</a>
      </div>
    </div>
    <div class="viewer-canvas-wrap"><canvas class="viewer-canvas"></canvas></div>
  `;
}
function buildViewerPaneCollapsedHtml(entry, hint){
  return `
    <div class="viewer-toolbar">
      <span class="viewer-page-info">Pratinjau isi berkas</span>
      <a href="${entry.objectUrl||'#'}" target="_blank" rel="noopener noreferrer">Buka di tab baru &#8599;</a>
    </div>
    <div class="viewer-canvas-wrap viewer-collapsed-hint">${hint||"Klik untuk membuka pratinjau"}</div>
  `;
}

async function mountPdfViewer(paneEl, entry){
  if(!paneEl) return;
  if(entry._previewRenderTask){
    try{ entry._previewRenderTask.cancel(); }catch(e){}
    entry._previewRenderTask=null;
  }
  const canvas = paneEl.querySelector(".viewer-canvas");
  if(!canvas) return;
  const infoEl = paneEl.querySelector(".viewer-page-info");
  const prevBtn = paneEl.querySelector(".viewer-prev");
  const nextBtn = paneEl.querySelector(".viewer-next");
  const zoomInBtn = paneEl.querySelector(".viewer-zoom-in");
  const zoomOutBtn = paneEl.querySelector(".viewer-zoom-out");
  const zoomResetBtn = paneEl.querySelector(".viewer-zoom-reset");
  const rotateLeftBtn = paneEl.querySelector(".viewer-rotate-left");
  const rotateRightBtn = paneEl.querySelector(".viewer-rotate-right");
  const zoomLabel = paneEl.querySelector(".viewer-zoom-level");

  let pdfDoc;
  try{
    pdfDoc = await ensurePdfDocForEntry(entry);
  }catch(err){
    if(!paneEl.isConnected) return;
    if(infoEl) infoEl.textContent = "Pratinjau tidak tersedia (" + (err.message||"gagal memuat berkas") + ").";
    const wrapEl = paneEl.querySelector(".viewer-canvas-wrap");
    if(wrapEl){ wrapEl.classList.add("viewer-collapsed-hint"); wrapEl.textContent = "Tidak bisa menampilkan pratinjau. Coba \u201cBuka di tab baru\u201d."; }
    return;
  }
  if(!paneEl.isConnected) return; // render lain sudah menggantikan panel ini
  const openLink = paneEl.querySelector("a[target='_blank']");
  if(openLink && entry.objectUrl) openLink.href = entry.objectUrl;

  const numPages = pdfDoc.numPages;
  if(!entry._previewPage || entry._previewPage>numPages) entry._previewPage = 1;
  if(!entry._previewZoom) entry._previewZoom = 1; // 1 = muat ke lebar panel
  if(!Number.isFinite(entry._previewRotation)) entry._previewRotation = 0;

  const MIN_ZOOM = 0.5, MAX_ZOOM = 3, ZOOM_STEP = 0.25;
  let renderTask=null;
  let renderSequence=0;

  async function renderPage(n){
    const sequence=++renderSequence;
    entry._previewPage = Math.min(numPages,Math.max(1,n));
    if(renderTask){
      const previousTask=renderTask;
      try{ previousTask.cancel(); }catch(e){}
      try{ await previousTask.promise; }catch(e){}
      if(renderTask===previousTask) renderTask=null;
    }
    if(sequence!==renderSequence||!paneEl.isConnected) return;
    const page = await pdfDoc.getPage(entry._previewPage);
    if(sequence!==renderSequence||!paneEl.isConnected) return;
    const wrapEl = paneEl.querySelector(".viewer-canvas-wrap");
    const fitWidth = Math.max(220, (wrapEl?wrapEl.clientWidth:340) - 28);
    const rotation=((Number(page.rotate)||0)+entry._previewRotation+360)%360;
    const baseViewport = page.getViewport({scale:1,rotation});
    const fitScale = fitWidth / baseViewport.width;
    const zoom = entry._previewZoom || 1;
    const finalScale = (fitScale>0 ? fitScale : 1) * zoom;
    const viewport = page.getViewport({scale:finalScale,rotation});
    // Render pada resolusi piksel perangkat yang sebenarnya (devicePixelRatio),
    // lalu tampilkan pada ukuran CSS yang lebih kecil. Tanpa ini, teks tampak
    // buram/bergelombang di layar dengan kerapatan piksel tinggi (umum di
    // laptop/monitor modern).
    const desiredScale = Math.max(window.devicePixelRatio || 1, 1.5);
    const maxDimension=4096;
    const maxPixels=12*1024*1024;
    // Batas ini harus mutlak: pada monitor sangat lebar + zoom tinggi, memaksa
    // skala minimum dapat membuat canvas puluhan megapiksel dan menjatuhkan tab.
    const outputScale = boundedCanvasScale(viewport.width,viewport.height,desiredScale,maxDimension,maxPixels);
    canvas.width = Math.max(1,Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1,Math.floor(viewport.height * outputScale));
    canvas.style.width = Math.max(1,Math.floor(viewport.width)) + "px";
    canvas.style.height = Math.max(1,Math.floor(viewport.height)) + "px";
    canvas.style.imageRendering="auto";
    const ctx = canvas.getContext("2d",{alpha:false});
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle="#fff";
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="high";
    const transform = outputScale!==1 ? [outputScale,0,0,outputScale,0,0] : undefined;
    const task=page.render({canvasContext:ctx, viewport, transform});
    renderTask=task;
    entry._previewRenderTask=task;
    try{ await task.promise; }
    catch(err){ if(err&&err.name==="RenderingCancelledException") return; throw err; }
    finally{
      if(renderTask===task) renderTask=null;
      if(entry._previewRenderTask===task) entry._previewRenderTask=null;
    }
    if(sequence!==renderSequence||!paneEl.isConnected) return;
    if(infoEl) infoEl.textContent = `Halaman ${entry._previewPage} dari ${numPages}`;
    if(prevBtn) prevBtn.disabled = (entry._previewPage<=1);
    if(nextBtn) nextBtn.disabled = (entry._previewPage>=numPages);
    if(zoomLabel) zoomLabel.textContent = Math.round(zoom*100) + "%";
    if(zoomOutBtn) zoomOutBtn.disabled = (zoom<=MIN_ZOOM+1e-6);
    if(zoomInBtn) zoomInBtn.disabled = (zoom>=MAX_ZOOM-1e-6);
  }

  function requestRender(n){
    renderPage(n).catch(err=>{
      if(paneEl.isConnected&&infoEl) infoEl.textContent="Gagal menampilkan halaman pratinjau.";
      console.warn("Pratinjau PDF gagal dirender:",err);
    });
  }

  if(prevBtn){ prevBtn.disabled = false; prevBtn.onclick = (e)=>{ e.stopPropagation(); if(entry._previewPage>1) requestRender(entry._previewPage-1); }; }
  if(nextBtn){ nextBtn.disabled = false; nextBtn.onclick = (e)=>{ e.stopPropagation(); if(entry._previewPage<numPages) requestRender(entry._previewPage+1); }; }
  if(zoomInBtn){ zoomInBtn.disabled = false; zoomInBtn.onclick = (e)=>{ e.stopPropagation(); entry._previewZoom = Math.min(MAX_ZOOM, +(((entry._previewZoom||1)+ZOOM_STEP).toFixed(2))); requestRender(entry._previewPage); }; }
  if(zoomOutBtn){ zoomOutBtn.disabled = false; zoomOutBtn.onclick = (e)=>{ e.stopPropagation(); entry._previewZoom = Math.max(MIN_ZOOM, +(((entry._previewZoom||1)-ZOOM_STEP).toFixed(2))); requestRender(entry._previewPage); }; }
  if(zoomResetBtn){ zoomResetBtn.disabled = false; zoomResetBtn.onclick = (e)=>{ e.stopPropagation(); entry._previewZoom = 1; requestRender(entry._previewPage); }; }
  if(rotateLeftBtn){ rotateLeftBtn.disabled=false; rotateLeftBtn.onclick=(e)=>{ e.stopPropagation(); entry._previewRotation=(entry._previewRotation+270)%360; requestRender(entry._previewPage); }; }
  if(rotateRightBtn){ rotateRightBtn.disabled=false; rotateRightBtn.onclick=(e)=>{ e.stopPropagation(); entry._previewRotation=(entry._previewRotation+90)%360; requestRender(entry._previewPage); }; }

  try{
    await renderPage(entry._previewPage);
  }catch(err){
    if(paneEl.isConnected && infoEl) infoEl.textContent = "Gagal menampilkan halaman pratinjau.";
  }
}

function evaluateFile(entry){
  evaluateAgainstCat(entry, categories[entry.category]);
}
// Jenis perawatan tercetak jelas di Berkas Klaim Individual (e-klaim), mis.
// "Jenis Perawatan : 2 - Rawat Jalan". Lebih dapat dipercaya daripada nama file.
function detectCareTypeCategory(text){
  const match=/jenis\s+perawatan\s*:?\s*(?:\d\s*-\s*)?rawat\s+(jalan|inap)/.exec(String(text||"").toLowerCase());
  return match ? (match[1]==="inap" ? "rs_inap" : "rs_jalan") : "";
}
// Koreksi otomatis hanya antara Rawat Inap <-> Rawat Jalan, dan tidak pernah menimpa
// kategori yang sudah dipilih sendiri oleh pengguna pada berkas tersebut.
function applyDetectedCategory(entry){
  if(!entry || entry.error || entry.categoryManual) return false;
  if(entry.category!=="rs_inap" && entry.category!=="rs_jalan") return false;
  const detected=detectCareTypeCategory(entry.digitalText);
  if(!detected || detected===entry.category || !categories[detected]) return false;
  entry.category=detected;
  entry.categoryAuto=true;
  return true;
}
function normalizeDetectionText(value){
  return String(value||"").toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function detectionTextIncludes(normalizedText,keyword){
  const normalizedKeyword=normalizeDetectionText(keyword);
  return !!normalizedKeyword&&(` ${normalizedText} `).includes(` ${normalizedKeyword} `);
}
// ---------------- Lapisan tambahan: cek "isi kosong walau judul terdeteksi" ----------------
// Aktif hanya untuk item yang punya properti `contentCheck`.
// Tidak mengubah status.source/manual/na sama sekali -> logika ceklis lama tidak berubah;
// hasilnya cuma dipakai untuk menampilkan lencana peringatan tambahan di UI.
// (CONTENT_VALUE_PATTERNS & variannya didefinisikan lebih awal, sebelum `categories`.)
// Label formulir yang kebetulan memuat kata kunci dokumen lain. Contoh: baris
// "Hasil laboratorium yang positif :" pada Resume Medis BUKAN lembar hasil laboratorium.
// Frasa ini dibuang dari teks (yang sudah dinormalisasi) sebelum kata kunci dicocokkan.
const DETECTION_LABEL_PHRASES = [
  "hasil laboratorium yang positif",
  "pemeriksaan penunjang yang positif"
].map(normalizeDetectionText);
function stripFormLabels(normalizedText){
  let text=` ${normalizedText} `;
  DETECTION_LABEL_PHRASES.forEach(phrase=>{ if(phrase) text=text.split(` ${phrase} `).join(" "); });
  return text.trim();
}
const ICD10_CODE_PATTERN = /\b[a-z]\d{2}\b/; // kode dasar ICD-10 pada teks ternormalisasi, mis. "k76" dari "K76.0"

// Teks lengkap per halaman untuk pengecekan isi. `entry.pageTexts` sengaja hanya menyimpan
// penanda ringkas ("#") agar hemat memori, jadi teks halaman diturunkan dari digitalText
// (tiap halaman diakhiri "\n" saat analisis) ditambah hasil OCR per halaman bila ada.
// Mengembalikan null bila pemetaan halaman tidak dapat dipastikan -> tidak menilai.
function entryPageTextsForCheck(entry){
  const pageCount = Array.isArray(entry.pageTexts) ? entry.pageTexts.length : 0;
  if(!pageCount) return null;
  const segments = String(entry.digitalText||"").split("\n");
  if(segments.length && segments[segments.length-1]==="") segments.pop();
  if(segments.length!==pageCount) return null;
  const ocrPages = entry.ocrPageTexts || {};
  return segments.map((text,idx)=> ocrPages[idx] ? `${text} ${ocrPages[idx]}` : text);
}
// Hasil: false (tidak ada peringatan), "minim" (isi sangat sedikit), atau "icd" (kode diagnosis tidak ditemukan).
function evaluateContentWarning(entry, item){
  try{
    if(!item || !item.contentCheck) return false;
    const pages = entryPageTextsForCheck(entry);
    if(!pages) return false; // teks per halaman belum tersedia -> jangan menebak
    const cfg = item.contentCheck;
    const hitPages = [];
    pages.forEach((pageText,idx)=>{
      const norm = stripFormLabels(normalizeDetectionText(pageText||""));
      if(item.keywords.some(kw=>detectionTextIncludes(norm,kw))) hitPages.push(idx);
    });
    if(!hitPages.length) return false; // judul tidak bisa dilokalisasi ke halaman tertentu -> tidak menilai
    const span = Math.max(0, Number(cfg.spanPages)||0);
    const windowIdx = new Set();
    hitPages.forEach(idx=>{ for(let i=idx;i<=idx+span && i<pages.length;i++) windowIdx.add(i); });
    const windowText = Array.from(windowIdx).sort((a,b)=>a-b).map(i=>pages[i]||"").join(" ");
    const normalizedWindow = normalizeDetectionText(windowText);
    const longEnough = normalizedWindow.length >= (cfg.minChars||0);
    const patterns = (Array.isArray(cfg.valuePatterns) && cfg.valuePatterns.every(re=>re instanceof RegExp)) ? cfg.valuePatterns : CONTENT_VALUE_PATTERNS;
    const valueHits = patterns.reduce((count,re)=>count+(re.test(normalizedWindow)?1:0),0);
    const enoughValues = valueHits >= (cfg.minValueHits!=null?cfg.minValueHits:1);
    // Hanya diberi peringatan bila KEDUA sinyal lemah, supaya berkas yang sah tidak salah ditandai.
    if(!(longEnough || enoughValues)) return "minim";
    // Formulir resume punya banyak label tercetak, sehingga panjang teks saja tidak membuktikan
    // lembar itu terisi. Untuk item bertanda requireIcd, halaman tempat judul ditemukan harus
    // memuat setidaknya satu kode ICD-10. Hanya halaman judul yang dinilai (bukan halaman
    // berikutnya) karena kode tindakan/tarif di lembar lain berbentuk mirip kode ICD.
    if(cfg.requireIcd){
      const titlePages = normalizeDetectionText(hitPages.map(i=>pages[i]||"").join(" "));
      if(!ICD10_CODE_PATTERN.test(titlePages)) return "icd";
    }
    return false;
  }catch(err){
    console.warn("Pengecekan isi tambahan gagal, dilewati (tidak memengaruhi hasil utama):",err);
    return false;
  }
}
/* ================= PEMERIKSAAN IDENTITAS (anti berkas tertukar / dokumen pasien lain terselip) =================
   Tujuan: memastikan semua lembar dalam satu berkas memang milik pasien yang sama.
   Hanya membaca teks yang sudah diekstrak (digital + OCR), jadi tidak menambah beban berarti.
   Hasilnya PERINGATAN (lencana), tidak mengubah status Lengkap/Kurang.
   - Nomor RM: nilai yang paling banyak muncul dijadikan acuan (bukan INA-CBG, yang sering
     kosong/salah ketik). Halaman yang mencantumkan nomor RM lain ditandai.
   - Nomor SEP: dicocokkan dengan nama file, dan tidak boleh ada lebih dari satu di teks digital.
   - Nomor kartu: tidak boleh ada lebih dari satu di teks digital.
   Format RM antar faskes berbeda ("00-64-66-69", "00646669", "007111"), jadi dibandingkan
   setelah tanda hubung dan nol di depan dibuang. */
const RM_NUMBER_SRC = "(\\d{2}-\\d{2}-\\d{2}-\\d{2}|\\d{4,8})(?![\\d/:-])";
// Label diikuti langsung oleh nomornya, mis. "No.RM : 102089", "( MR : 102089 )", "MR. 007111".
const RM_DIRECT_PATTERN = new RegExp("\\b(?:no(?:mor)?\\.?\\s*(?:rekam\\s*medi[sk]|r\\.?\\s?m)|mr)\\b\\s*[.:]?\\s*"+RM_NUMBER_SRC,"g");
// Label dan nomor terpisah oleh label lain, mis. "No RM : Tgl Lahir : Jenis Kelamin : 00-64-23-84".
const RM_LABEL_PATTERN = /\bno(?:mor)?\.?\s*(?:rekam\s*medi[sk]|r\.?\s?m)\b/g;
const RM_LOOSE_NUMBER_PATTERN = new RegExp("(?<![\\d/:.,-])"+RM_NUMBER_SRC,"g");
const RM_LOOSE_WINDOW = 90;
// Angka yang didahului kata-kata ini bukan nomor RM (umur dalam hari, nomor registrasi, telepon, dst.).
const RM_NOT_RM_CONTEXT = /(umur|hari|reg(?:istrasi)?|tagihan|pendaftaran|nota|telp|telepon|hp|nip|sip|kode\s*pos|rawat)\s*[.:]?\s*$/;
function normalizeRmNumber(value){
  return String(value||"").replace(/[^0-9]/g,"").replace(/^0+/,"");
}
function extractRmCandidates(pageText){
  const text=String(pageText||"").toLowerCase();
  const found=new Map(); // nomor ternormalisasi -> tulisan asli
  const add=raw=>{
    const norm=normalizeRmNumber(raw);
    if(norm.length<3) return;
    if(/^(19|20)\d{2}$/.test(raw)) return; // tahun, bukan nomor RM
    if(!found.has(norm)) found.set(norm,raw);
  };
  let match;
  RM_DIRECT_PATTERN.lastIndex=0;
  while((match=RM_DIRECT_PATTERN.exec(text))) add(match[1]);
  RM_LABEL_PATTERN.lastIndex=0;
  while((match=RM_LABEL_PATTERN.exec(text))){
    const start=match.index+match[0].length;
    const windowText=text.slice(start,start+RM_LOOSE_WINDOW);
    RM_LOOSE_NUMBER_PATTERN.lastIndex=0;
    let numberMatch;
    while((numberMatch=RM_LOOSE_NUMBER_PATTERN.exec(windowText))){
      const before=windowText.slice(Math.max(0,numberMatch.index-24),numberMatch.index);
      if(RM_NOT_RM_CONTEXT.test(before)) continue;
      add(numberMatch[1]);
      break; // cukup angka pertama yang layak setelah label
    }
  }
  return found;
}
// Semua deret angka di halaman (tanda hubung dibuang, nol depan dibuang) untuk mengecek
// apakah nomor RM acuan muncul di halaman itu, apa pun labelnya.
function pageNumberTokens(pageText){
  const tokens=new Set();
  const matches=String(pageText||"").match(/\d+(?:-\d+)*/g)||[];
  matches.forEach(raw=>{ const norm=normalizeRmNumber(raw); if(norm) tokens.add(norm); });
  return tokens;
}
function extractAllSepNumbers(text){
  const result=new Set();
  const pattern=/(?:^|[^0-9a-z])((?:\d\s?){4}[a-z]\s?(?:\d\s?){7}v\s?(?:\d\s?){5}\d)(?![0-9])/gi;
  const source=String(text||"");
  let match;
  while((match=pattern.exec(source))){
    const sep=match[1].replace(/\s+/g,"").toUpperCase();
    if(/^\d{4}[A-Z]\d{7}V\d{6}$/.test(sep)) result.add(sep);
    pattern.lastIndex=match.index+match[0].length-1;
  }
  return result;
}
function extractCardNumbers(text){
  // Nomor kartu JKN: 13 digit, diawali "000".
  // Tidak boleh menempel pada huruf: kode barang seperti "B0000100001142" bukan nomor kartu.
  return new Set(String(text||"").match(/(?<![\da-z])000\d{10}(?![\da-z])/gi)||[]);
}
// Mengembalikan ringkasan kecil yang ikut disimpan bersama metadata berkas, atau null bila
// teks per halaman tidak tersedia (mis. sesi lama yang belum dianalisis ulang).
function computeIdentityCheck(entry){
  const pages=entryPageTextsForCheck(entry);
  if(!pages) return null;
  const ocrPages=entry.ocrPageTexts||{};
  const perPage=pages.map(text=>extractRmCandidates(text));
  // Pemungutan suara: nomor RM yang tercantum di paling banyak halaman menjadi acuan.
  const votes=new Map();
  perPage.forEach((candidates,idx)=>{
    candidates.forEach((raw,norm)=>{
      const row=votes.get(norm)||{norm,raw,count:0,onSep:false,first:idx};
      row.count++;
      if(/surat\s+el[ei]gibilitas\s+peserta/.test(pages[idx])) row.onSep=true;
      votes.set(norm,row);
    });
  });
  const ranked=Array.from(votes.values()).sort((a,b)=>(b.count-a.count)||((b.onSep?1:0)-(a.onSep?1:0))||(a.first-b.first));
  const reference=ranked[0]||null;
  const rmMismatch=[];
  let rmPages=0;
  if(reference){
    pages.forEach((text,idx)=>{
      if(pageNumberTokens(text).has(reference.norm)){ rmPages++; return; }
      // Ekstraksi PDF kadang memecah angka ("1 36748"); coba lagi dengan spasi antar digit dirapatkan.
      if(pageNumberTokens(String(text).replace(/(\d) (?=\d)/g,"$1")).has(reference.norm)){ rmPages++; return; }
      const others=Array.from(perPage[idx].values());
      if(others.length) rmMismatch.push({page:idx+1, rm:others[0], ocr:!!ocrPages[idx]});
    });
  }
  const digitalText=entry.digitalText||"";
  const sepInDigital=Array.from(extractAllSepNumbers(digitalText));
  const sepInAll=extractAllSepNumbers(digitalText+" "+(entry.ocrText||""));
  const sepFromName=extractSepNumber(entry.name);
  const cards=Array.from(extractCardNumbers(digitalText));
  return {
    rm: reference ? reference.raw : "",
    rmPages,
    rmMismatch: rmMismatch.slice(0,20),
    sepList: sepInDigital.slice(0,5),
    // Nama file memuat nomor SEP, tetapi SEP itu tidak ada di teks digital maupun hasil OCR.
    sepNameMismatch: !!(sepFromName && sepInDigital.length && !sepInAll.has(sepFromName)),
    sepFromName: sepFromName||"",
    cardList: cards.slice(0,5)
  };
}
// Daftar kalimat peringatan identitas untuk satu berkas (kosong = tidak ada temuan).
function identityWarnings(entry, duplicateSeps){
  const warnings=[];
  const info=entry&&entry.identity;
  if(info){
    (info.rmMismatch||[]).forEach(row=>{
      warnings.push(`Halaman ${row.page}: No. RM ${row.rm} berbeda dari No. RM berkas (${info.rm})${row.ocr?" - hasil OCR, periksa manual":""}`);
    });
    if(info.sepNameMismatch) warnings.push(`No. SEP pada nama file (${info.sepFromName}) tidak ditemukan di dalam berkas; isi berkas memuat ${(info.sepList||[]).join(", ")}`);
    else if((info.sepList||[]).length>1) warnings.push(`Berkas memuat lebih dari satu No. SEP: ${info.sepList.join(", ")}`);
    if((info.cardList||[]).length>1) warnings.push(`Berkas memuat lebih dari satu No. Kartu: ${info.cardList.join(", ")}`);
  }
  if(duplicateSeps && entry && entry.sep && duplicateSeps.has(entry.sep)) warnings.push(`No. SEP ${entry.sep} juga ada di berkas lain (kemungkinan berkas ganda)`);
  return warnings;
}
// Nomor SEP yang muncul di lebih dari satu berkas (antrean aktif + hasil tersimpan).
function findDuplicateSeps(){
  const counts=new Map();
  const add=sep=>{ if(sep) counts.set(sep,(counts.get(sep)||0)+1); };
  files.forEach(entry=>{ if(!entry.pending) add(entry.sep); });
  archivedFiles.forEach(row=>add(row.sep));
  const duplicates=new Set();
  counts.forEach((count,sep)=>{ if(count>1) duplicates.add(sep); });
  return duplicates;
}
let duplicateSepSet=new Set(); // diperbarui setiap renderResults
function identityBadgeHtml(warnings){
  if(!warnings||!warnings.length) return "";
  return ` <span class="content-warn-badge" title="${escapeAttr(warnings.join("\n"))}">&#9888; Cek identitas (${warnings.length})</span>`;
}

function contentWarnBadgeHtml(kind){
  if(kind==="icd"){
    return ` <span class="content-warn-badge" title="Dokumen terdeteksi, tetapi kode diagnosis (ICD-10) tidak ditemukan di halaman tersebut. Periksa manual apakah diagnosis dan kodenya benar-benar terisi.">&#9888; Cek kode ICD</span>`;
  }
  return ` <span class="content-warn-badge" title="Judul dokumen terdeteksi, tetapi isinya tampak sangat sedikit/minim data. Periksa manual apakah lembar ini benar-benar terisi.">&#9888; Cek isi</span>`;
}
function evaluateAgainstCat(entry, cat){
  const status = {};
  const digitalText = entry.digitalText || "";
  const fullText = digitalText + " " + (entry.ocrText||"");
  if(!entry.sep) entry.sep = extractSepNumber(fullText) || extractSepNumber(entry.name);
  const normalizedDigitalText=stripFormLabels(normalizeDetectionText(digitalText));
  const normalizedFullText=stripFormLabels(normalizeDetectionText(fullText));
  cat.items.forEach(item=>{
    const prev = entry.itemsStatus[item.id];
    const digitalHit = item.keywords.some(kw=>detectionTextIncludes(normalizedDigitalText,kw));
    const fullHit = item.keywords.some(kw=>detectionTextIncludes(normalizedFullText,kw));
    const source = digitalHit ? "digital" : (fullHit ? "ocr" : "none");
    let manual, userTouched;
    if(prev && prev.userTouched){
      manual = prev.manual; userTouched = true;
    }else if(source==="ocr"){
      manual = true; userTouched = false; // auto-tercentang, tetap bisa dibatalkan bila keliru
    }else{
      manual = prev ? prev.manual : false; userTouched = false;
    }
    const na = item.conditional ? (prev ? !!prev.na : false) : false;
    const contentWarning = (source!=="none") ? evaluateContentWarning(entry, item) : false;
    status[item.id] = { source, manual, userTouched, na, contentWarning };
  });
  entry.itemsStatus = status;
  try{
    const identity=computeIdentityCheck(entry);
    if(identity) entry.identity=identity; // bila teks halaman belum tersedia, hasil lama dipertahankan
  }catch(err){ console.warn("Pemeriksaan identitas gagal, dilewati:",err); }
}

let reprocessTimer=null;
let reprocessToken=0;
function reprocessAllFilesOfCategory(catKey){
  clearTimeout(reprocessTimer);
  const token=++reprocessToken;
  reprocessTimer=setTimeout(async ()=>{
    const targets=files.filter(entry=>entry.category===catKey&&!entry.pending);
    for(let start=0;start<targets.length;start+=50){
      if(token!==reprocessToken) return;
      const chunk=targets.slice(start,start+50);
      await Promise.all(chunk.map(ensureAnalysisData));
      chunk.forEach(entry=>{ evaluateFile(entry); dirtyActiveIds.add(entry.id); });
      try{ await flushDirtyActiveEntries(); }catch(err){ updateSaveIndicator(false,err); }
      chunk.forEach(releaseEntryHeavyData);
      await yieldToBrowser();
    }
    if(token===reprocessToken) renderResults();
  },500);
}

/* ---------------- Results rendering ---------------- */
function fileMissingItems(entry, catOverride){
  const cat = catOverride || categories[entry.category];
  // Hanya dokumen WAJIB yang menentukan status "Kurang". Dokumen kondisional yang tidak
  // ditemukan tidak menggagalkan berkas; ia dilaporkan sebagai catatan (lihat fileConditionalNotes).
  return cat.items.filter(item=>{
    if(item.conditional) return false;
    const s = entry.itemsStatus[item.id];
    if(!s) return true;
    return !(s.source==="digital" || s.manual);
  });
}
// Dokumen kondisional yang tidak ditemukan dan belum ditandai "Tidak berlaku (N/A)".
// Berkas tetap "Lengkap", tetapi daftar ini ditampilkan sebagai catatan untuk dicek verifikator.
function fileConditionalNotes(entry, catOverride){
  const cat = catOverride || categories[entry.category];
  return cat.items.filter(item=>{
    if(!item.conditional) return false;
    const s = entry.itemsStatus[item.id];
    if(!s) return true;
    if(s.na) return false;
    return !(s.source==="digital" || s.manual);
  });
}
function completeBadgeHtml(noteNames){
  const notes = noteNames||[];
  if(!notes.length) return `<span class="badge complete">Lengkap</span>`;
  return `<span class="badge complete" title="${escapeAttr("Dokumen kondisional tidak ditemukan: "+notes.join("; ")+". Tandai Tidak berlaku (N/A) bila memang tidak diperlukan.")}">Lengkap &bull; ${notes.length} catatan</span>`;
}

/* ---------------- Arsipkan berkas yang sudah diperiksa (lepas dari memori, ringkasan tetap ada) ---------------- */
function archivedSummaryFromEntry(entry){
  const cat = categories[entry.category];
  const missing = fileMissingItems(entry, cat);
  return {
    sep: entry.sep || extractSepNumber(entry.name) || "",
    id: entry.id,
    name: entry.name,
    category: entry.category,
    categoryLabel: cat ? cat.label : entry.category,
    isComplete: missing.length===0,
    missingNames: missing.map(item=>item.name),
    noteNames: cat ? fileConditionalNotes(entry, cat).map(item=>item.name) : [],
    // Peringatan identitas per berkas (tanpa SEP ganda, yang dihitung ulang saat laporan dibuat).
    identityNotes: entry.error ? [] : identityWarnings(entry, null),
    rm: (entry.identity && entry.identity.rm) || "",
    error: entry.error||null,
    fingerprint: entry.fingerprint||"",
    order:Number.isFinite(entry.order)?entry.order:0,
    size:Number.isFinite(entry.size)?entry.size:0,
    completedAt:Date.now()
  };
}

async function archiveFiles(entriesToArchive){
  const alreadyStored = new Set(archivedFiles.map(row=>row.id));
  const eligible = (entriesToArchive||[]).filter(entry=>entry && !entry.pending && !(entry.ocr&&entry.ocr.running) && !isAutoOcrQueued(entry) && !alreadyStored.has(entry.id));
  if(eligible.length===0) return false;
  const summaries = eligible.map(archivedSummaryFromEntry);
  const ids = eligible.map(entry=>entry.id);
  try{
    await dbArchiveEntries(summaries,ids);
  }catch(err){
    updateSaveIndicator(false,err);
    alert("Hasil belum dapat disimpan sehingga PDF tidak dihapus. Silakan periksa ruang penyimpanan browser lalu coba lagi.");
    return false;
  }
  archivedFiles.push(...summaries);
  const idsToRemove = new Set(ids);
  eligible.forEach(entry=>{
    dirtyActiveIds.delete(entry.id);
    dirtyAnalysisIds.delete(entry.id);
    workspaceDirtyAnalysisIds.delete(entry.id);
    workspaceSyncedAnalysisIds.delete(entry.id);
    workspaceSyncedPdfIds.delete(`active:${entry.id}`);
    workspaceDeletedIds.add(entry.id);
    activeFingerprints.delete(entry.fingerprint);
    if(entry.fingerprint){ archivedFingerprints.add(entry.fingerprint); knownFingerprints.add(entry.fingerprint); }
    if(entry.objectUrl){ try{ URL.revokeObjectURL(entry.objectUrl); }catch(e){} }
    if(entry.pdfDoc && typeof entry.pdfDoc.destroy==="function"){ try{ entry.pdfDoc.destroy(); }catch(e){} }
    entry.blob=null; entry.pdfDoc=null; entry.pageTexts=[]; entry.digitalText=""; entry.ocrText=""; entry.ocrCandidates=[]; entry._analysisLoaded=false;
  });
  files = files.filter(f=>!idsToRemove.has(f.id));
  activePage = Math.min(activePage,Math.max(1,Math.ceil(files.length/ACTIVE_PAGE_SIZE)));
  renderResults();
  renderSamplingList();
  scheduleSave(50);
  scheduleWorkspaceBackup(100);
  return true;
}

function renderArchivedPanel(){
  const panel = document.getElementById("archivedPanel");
  const body = document.getElementById("archivedPanelBody");
  const title = document.getElementById("archivedPanelTitle");
  if(!panel) return;
  if(archivedFiles.length===0){ panel.style.display = "none"; return; }
  panel.style.display = "";
  const nComplete = archivedFiles.filter(r=>r.isComplete).length;
  title.textContent = `${archivedFiles.length} hasil tersimpan (${nComplete} lengkap, ${archivedFiles.length-nComplete} kurang/gagal) \u2014 tetap ikut ke CSV`;
  body.innerHTML = "";
  const sorted = [...archivedFiles].sort((a,b)=>(a.order||0)-(b.order||0));
  const totalPages = Math.max(1,Math.ceil(sorted.length/ARCHIVE_PAGE_SIZE));
  archivedPage = Math.min(Math.max(1,archivedPage),totalPages);
  sorted.slice((archivedPage-1)*ARCHIVE_PAGE_SIZE,archivedPage*ARCHIVE_PAGE_SIZE).forEach(row=>{
    const catLabel = row.categoryLabel || (categories[row.category]||{}).label || row.category;
    const line = document.createElement("div");
    line.className = "archived-row";
    line.innerHTML = `
      <span class="archived-row-name">${escapeAttr(row.name)}</span>
      <span class="archived-row-cat">${escapeAttr(catLabel)}</span>
      ${row.error ? `<span class="badge incomplete">Gagal dibaca</span>` : (row.isComplete ? completeBadgeHtml(row.noteNames) : `<span class="badge incomplete">Kurang ${(row.missingNames||[]).length}</span>`)}
    `;
    body.appendChild(line);
  });
  renderPagination(document.getElementById("archivedPagination"),archivedPage,totalPages,next=>{
    keepAnchorPosition("archivedPagination",()=>{ archivedPage=next; renderArchivedPanel(); });
  },`${ARCHIVE_PAGE_SIZE} hasil/halaman`);
}

const RESULT_FILTER_LABELS={
  all:"Semua berkas", success:"Berhasil dibaca", complete:"Lengkap", incomplete:"Kurang",
  failed:"Gagal dibaca", processing:"Sedang diproses", identity:"Peringatan identitas"
};
function entryReadStatus(entry){
  if(entry.pending) return "processing";
  if(entry.error) return "failed";
  return fileMissingItems(entry).length===0 ? "complete" : "incomplete";
}
function statusMatchesFilter(entry,status){
  switch(resultFilter){
    case "success": return status==="complete"||status==="incomplete";
    case "failed": return status==="failed"||!!entry._retrying; // tetap terlihat selama dimuat ulang
    case "identity": return !entry.pending && !entry.error && identityWarnings(entry,duplicateSepSet).length>0;
    default: return status===resultFilter;
  }
}
function renderStatusFilterSelect(counts){
  const sel=document.getElementById("statusFilterSelect");
  if(!sel) return;
  const total=files.length;
  const n={all:total,success:counts.complete+counts.incomplete,complete:counts.complete,
    incomplete:counts.incomplete,failed:counts.failed,processing:counts.processing,identity:counts.identity||0};
  sel.innerHTML=Object.keys(RESULT_FILTER_LABELS).map(key=>
    `<option value="${key}">${RESULT_FILTER_LABELS[key]} (${n[key]})</option>`).join("");
  sel.value=resultFilter;
}

let retryAllState=null; // {total, done} saat "Muat ulang semua yang gagal" berjalan
function renderFailBar(counts){
  const bar=document.getElementById("failBar");
  if(!bar) return;
  if(retryAllState){
    bar.className="fail-bar show running";
    bar.innerHTML=`<span><strong>Memuat ulang berkas yang gagal&hellip;</strong> ${retryAllState.done} dari ${retryAllState.total} diproses. Berkas dibaca bertahap agar laptop tetap ringan; Anda tetap bisa memeriksa berkas lain.</span>`;
    return;
  }
  if(!counts.failed){ bar.className="fail-bar"; bar.innerHTML=""; return; }
  const failedEntries=files.filter(entry=>entry.error&&!entry.pending);
  const permanent=failedEntries.filter(entry=>entry.errorKind==="permanent").length;
  bar.className="fail-bar show";
  bar.innerHTML=`
    <span><strong>${counts.failed} berkas gagal dibaca.</strong>
      ${permanent?` ${permanent} di antaranya terkunci/rusak sehingga perlu diperbaiki dulu.`:" Biasanya cukup dimuat ulang."}</span>
    <span class="fail-actions">
      ${resultFilter!=="failed"?`<button type="button" data-fail-action="show">Tampilkan yang gagal</button>`:`<button type="button" data-fail-action="all">Tampilkan semua</button>`}
      <button type="button" data-fail-action="csv">Unduh daftar gagal (CSV)</button>
      <button type="button" class="primary" data-fail-action="retry">&#8635; Muat ulang semua yang gagal (${counts.failed})</button>
    </span>`;
}

function downloadFailedList(){
  const failed=files.filter(entry=>entry.error).sort((a,b)=>(a.order||0)-(b.order||0));
  if(!failed.length) return;
  const rows=[["No","Nama File","Kategori","Alasan Gagal","Bisa dimuat ulang?"]];
  failed.forEach((entry,idx)=>rows.push([
    idx+1, entry.name, (categories[entry.category]||{}).label||entry.category, entry.error,
    entry.errorKind==="permanent"?"Tidak - perbaiki/unggah ulang PDF":"Ya"
  ]));
  const csv=rows.map(r=>r.map(v=>{
    let t=String(v==null?"":v); if(/^[\s]*[=+@-]/.test(t)) t="'"+t;
    return `"${t.replace(/"/g,'""')}"`;
  }).join(",")).join("\r\n");
  const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url; a.download="daftar-berkas-gagal-dibaca.csv"; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

function retryAllFailedActive(){
  if(retryAllState) return fileImportQueue;
  const targets=files.filter(entry=>entry.error&&!entry.pending).sort((a,b)=>(a.order||0)-(b.order||0));
  if(!targets.length) return fileImportQueue;
  retryAllState={total:targets.length,done:0};
  targets.forEach(entry=>{ entry._retrying=true; });
  renderResults();
  const run=async()=>{
    const progress=document.getElementById("progressLine");
    try{
      try{ await ensurePdfEngine(); }
      catch(err){ alert(err.message||"Mesin pembaca PDF tidak tersedia."); return; }
      // Mulai dengan mesin baca yang segar agar sisa kemacetan sebelumnya tidak terbawa.
      retireSharedPdfWorker();
      analysisConcurrencyCap=Math.min(analysisConcurrencyCap,2);
      const CHUNK=25;
      for(let start=0;start<targets.length;start+=CHUNK){
        const chunk=targets.slice(start,start+CHUNK).filter(entry=>files.includes(entry)&&entry.error);
        if(!chunk.length) continue;
        chunk.forEach(entry=>{
          entry.pending=true; entry.error=null; entry.errorKind=null; entry.ocrText="";
          entry.ocr={running:false,done:false,error:null,progress:"",processedPages:[],automatic:false};
          dirtyActiveIds.add(entry.id);
        });
        renderResults();
        await processAnalysisChunk(chunk,()=>{
          retryAllState.done++;
          progress.textContent=`Memuat ulang ${retryAllState.done} dari ${retryAllState.total} berkas yang gagal...`;
        },(entry,i,total)=>{
          progress.textContent=`Mencoba sekali lagi ${i+1} dari ${total} berkas yang masih tersendat...`;
        });
        try{ await flushDirtyAnalysisEntries(); await flushDirtyActiveEntries(); }
        catch(err){ updateSaveIndicator(false,err); }
        chunk.forEach(entry=>{ entry._retrying=false; releaseEntryHeavyData(entry); });
        renderResults();
        await yieldToBrowser();
      }
      await persistState();
      if(workspaceDirHandle) scheduleWorkspaceBackup(500);
      const still=targets.filter(entry=>entry.error).length;
      progress.textContent=`Muat ulang selesai: ${targets.length-still} berhasil dibaca${still?`, ${still} masih gagal (lihat alasannya di tiap kartu)`:""}.`;
      setTimeout(()=>{ if(progress.textContent.startsWith("Muat ulang selesai")) progress.textContent=""; },8000);
    }finally{
      targets.forEach(entry=>{ entry._retrying=false; });
      retryAllState=null;
      renderResults();
    }
  };
  fileImportQueue=fileImportQueue.then(run,run);
  return fileImportQueue;
}

function renderResults(){
  const wrap = document.getElementById("results");
  wrap.innerHTML = "";

  // Status dihitung sekali per berkas per render, lalu dipakai untuk statistik & filter.
  const statusById=new Map();
  const counts={complete:0,incomplete:0,failed:0,processing:0,identity:0};
  duplicateSepSet=findDuplicateSeps();
  files.forEach(entry=>{
    const st=entryReadStatus(entry);
    statusById.set(entry.id,st);
    counts[st]++;
    if(!entry.pending && !entry.error && identityWarnings(entry,duplicateSepSet).length) counts.identity++;
  });
  const completeCount=counts.complete, incompleteCount=counts.incomplete;

  const searchQuery = resultSearchQuery.trim().toLowerCase();
  const filteredFiles = (resultFilter==="all" ? files : files.filter(entry=>statusMatchesFilter(entry,statusById.get(entry.id))))
    .filter(entry=>!searchQuery || (entry.name||"").toLowerCase().includes(searchQuery))
    .slice().sort((a,b)=>(a.order||0)-(b.order||0));
  const totalPages = Math.max(1,Math.ceil(filteredFiles.length/ACTIVE_PAGE_SIZE));
  activePage = Math.min(Math.max(1,activePage),totalPages);
  const visibleFiles = filteredFiles.slice((activePage-1)*ACTIVE_PAGE_SIZE,activePage*ACTIVE_PAGE_SIZE);

  const archivedSuffix = archivedFiles.length ? ` \u2022 ${archivedFiles.length} diarsipkan` : "";
  document.getElementById("emptyNote").style.display = (files.length || archivedFiles.length) ? "none":"block";
  if(files.length===0){
    document.getElementById("resultCount").textContent = archivedFiles.length ? `0 file di daftar aktif${archivedSuffix}` : "";
  }else if(resultFilter==="all" && !searchQuery){
    document.getElementById("resultCount").textContent = `${files.length} file aktif${archivedSuffix}`;
  }else{
    const bits=[];
    if(resultFilter!=="all") bits.push(`filter: ${(RESULT_FILTER_LABELS[resultFilter]||resultFilter).toLowerCase()}`);
    if(searchQuery) bits.push(`cari: \u201c${resultSearchQuery.trim()}\u201d`);
    document.getElementById("resultCount").textContent = `${filteredFiles.length} dari ${files.length} file aktif (${bits.join(", ")})${archivedSuffix}`;
  }

  ["statTotalBox","statCompleteBox","statIncompleteBox","statFailedBox"].forEach(id=>{
    const box = document.getElementById(id);
    if(box) box.classList.toggle("active", box.dataset.filter===resultFilter);
  });
  renderStatusFilterSelect(counts);
  renderFailBar(counts);

  if(files.length>0 && filteredFiles.length===0){
    const emptyFilterMsg = document.createElement("div");
    emptyFilterMsg.className = "empty-note";
    emptyFilterMsg.textContent = searchQuery
      ? `Tidak ada berkas aktif dengan nama mengandung \u201c${resultSearchQuery.trim()}\u201d.`
      : `Tidak ada file dengan status “${RESULT_FILTER_LABELS[resultFilter]||resultFilter}”.`;
    wrap.appendChild(emptyFilterMsg);
  }

  // Kelompokkan file per kategori (folder) supaya Rawat Jalan, Rawat Inap, dst. tidak tercampur
  const groups = new Map(); // catKey -> {label, body, total, complete, incomplete}
  const pendingMounts = []; // card+entry yang perlu mountPdfViewer setelah semua ter-append ke DOM

  visibleFiles.forEach(entry=>{
   try{
    const cat = categories[entry.category];
    const missing = entry.pending ? [] : fileMissingItems(entry);
    const isComplete = !entry.pending && !entry.error && missing.length===0;
    const queued=isAutoOcrQueued(entry);
    const ocrBusy=!!(entry.ocr&&entry.ocr.running)||queued;

    const card = document.createElement("div");
    card.className = "file-card" + (entry.open ? " open":"");
    card.id = "card_"+entry.id;

    const catOptions = Object.keys(categories).map(k=>`<option value="${k}" ${k===entry.category?"selected":""}>${categories[k].label}</option>`).join("");

    let badgeHtml;
    if(entry.pending) badgeHtml = `<span class="badge loading">Memproses...</span>`;
    else if(entry.error) badgeHtml = `<span class="badge incomplete" title="${escapeAttr(entry.error)}">Gagal membaca PDF</span>`;
    else badgeHtml = isComplete ? completeBadgeHtml(fileConditionalNotes(entry).map(item=>item.name)) : `<span class="badge incomplete" title="${escapeAttr("Dokumen WAJIB yang belum ditemukan: "+missing.map(item=>item.name).join("; "))}">Kurang ${missing.length} dokumen</span>`;
    if(!entry.pending && !entry.error) badgeHtml += identityBadgeHtml(identityWarnings(entry,duplicateSepSet));

    const retryBtnHtml = entry.error ? `<button class="mini-action-btn retry-file-btn" type="button" ${retryAllState?"disabled":""} title="Muat PDF yang sama dan ulangi proses pembacaan.">Coba baca ulang</button>` : "";
    const archiveBtnHtml = (!entry.pending) ? `<button class="finish-btn archive-file-btn" type="button" ${ocrBusy?"disabled":""} title="Simpan hasil pemeriksaan lalu lepaskan PDF dari antrean aktif. Data tetap ikut ke CSV dan Sampling tidak berubah.">${ocrBusy?"Menunggu OCR…":"Selesai &amp; hapus PDF"}</button>` : "";

    const scanPages = (!entry.pending && !entry.error) ? ocrCandidatePages(entry) : [];
    let ocrHtml = "";
    if(scanPages.length>0){
      let statusLine;
      if(entry.ocr.running) statusLine = `<span>${escapeAttr(entry.ocr.progress)}</span>`;
      else if(entry.ocr.error) statusLine = `<span class="ocr-error">${escapeAttr(entry.ocr.error)}</span>`;
      else if(entry.ocr.done) statusLine = `<span class="ocr-done">OCR otomatis selesai &mdash; komponen yang cocok sudah ditandai.</span>`;
      else if(queued) statusLine = `<span class="ocr-queued">Menunggu giliran OCR otomatis &mdash; ${entry.ocr.processedPages.length}/${scanPages.length} halaman sudah dibaca.</span>`;
      else statusLine = `<span>${scanPages.length} halaman scan ditemukan; OCR otomatis akan membacanya.</span>`;
      const buttonText=entry.ocr.running?"Membaca...":(entry.ocr.done?"Selesai":(queued?"Prioritaskan OCR":"Jalankan OCR sekarang"));
      ocrHtml = `
      <div class="ocr-box">
        <div class="ocr-row">
          ${statusLine}
          <button class="ocr-btn" data-ocr="${entry.id}" ${entry.ocr.running||entry.ocr.done ? "disabled":""}>${buttonText}</button>
        </div>
        <div class="ocr-note">OCR berjalan satu berkas pada satu waktu dan progres disimpan setiap tiga halaman. Teks cetak yang jelas ditandai otomatis; tulisan tangan atau hasil yang tidak terbaca tetap perlu ditinjau.</div>
      </div>`;
    }

    card.innerHTML = `
      <div class="file-head">
        <span class="file-name">${escapeAttr(entry.name)}</span>
        <select class="cat-select"${entry.categoryAuto?' title="Kategori disesuaikan otomatis dari Jenis Perawatan pada Berkas Klaim Individual. Ubah di sini bila keliru."':''}>${catOptions}</select>${entry.categoryAuto?'<span class="cond-tag" title="Kategori disesuaikan otomatis dari Jenis Perawatan pada Berkas Klaim Individual.">Kategori otomatis</span>':''}
        ${badgeHtml}
        ${retryBtnHtml}
        ${archiveBtnHtml}
        <span class="chevron">&#9656;</span>
      </div>
      <div class="checklist">
        <div class="viewer-pane">${entry.open ? buildViewerPaneInnerHtml(entry) : buildViewerPaneCollapsedHtml(entry)}</div>
        <div class="check-pane"></div>
      </div>
      ${ocrHtml}
      <div class="file-foot">${entry.error ? `<span class="fail-reason">&#9888; ${escapeAttr(entry.error)}</span> &middot; ` : ""}${(entry.sourceOnly && !entry.blob && !entry.error) ? `<span class="fail-reason" title="${escapeAttr(SOURCE_MISSING_MESSAGE)}">PDF asal belum terpasang &mdash; pilih ulang berkas yang sama untuk pratinjau/OCR</span> &middot; ` : ""}${cat.label} &middot; ${cat.items.length} jenis dokumen dicek</div>
    `;

    card.querySelector(".file-head").addEventListener("click", (e)=>{
      if(e.target.classList.contains("cat-select")) return;
      if(entry.open) closeEntryResources(entry);
      else{ closeAllActivePreviews(entry); entry.open=true; }
      markEntryDirty(entry);
      renderResults();
    });
    card.querySelector(".cat-select").addEventListener("change", async e=>{
      e.stopPropagation();
      const select=e.target;
      select.disabled=true;
      entry.category = e.target.value;
      entry.categoryManual = true;   // pilihan pengguna tidak akan ditimpa deteksi otomatis
      entry.categoryAuto = false;
      try{
        await ensureAnalysisData(entry);
        evaluateFile(entry);
        markEntryDirty(entry);
        releaseEntryHeavyData(entry);
      }catch(err){ updateSaveIndicator(false,err); }
      renderResults();
    });
    const ocrBtn = card.querySelector("[data-ocr]");
    if(ocrBtn){
      ocrBtn.addEventListener("click", (e)=>{
        e.stopPropagation();
        entry.open = true;
        enqueueAutoOcr(entry,{force:true,front:true});
        renderResults();
      });
    }
    const archiveBtn = card.querySelector(".archive-file-btn");
    if(archiveBtn){
      archiveBtn.addEventListener("click",async e=>{
        e.stopPropagation();
        archiveBtn.disabled = true;
        archiveBtn.textContent = "Menyimpan...";
        await archiveFiles([entry]);
      });
    }
    const retryBtn = card.querySelector(".retry-file-btn");
    if(retryBtn){
      retryBtn.addEventListener("click",async e=>{
        e.stopPropagation();
        retryBtn.disabled=true;
        retryBtn.textContent="Membaca ulang…";
        await retryActiveEntryAnalysis(entry);
      });
    }

    if(!entry.pending && !entry.error){
      const cl = card.querySelector(".check-pane");
      cat.items.forEach(item=>{
        const s = entry.itemsStatus[item.id];
        const row = document.createElement("div");
        row.className = "check-item";
        const naOn = item.conditional && s.na;

        let detectionHtml;
        if(naOn){
          detectionHtml = `<span class="na-badge">Tidak berlaku</span>`;
        }else if(s.source==="digital"){
          detectionHtml = `<span class="stamp">Terdeteksi</span>`;
        }else if(s.source==="ocr"){
          detectionHtml = `
            <label class="manual-toggle ocr-flag ${s.manual?'checked':''}">
              <input type="checkbox" class="detect-check" ${s.manual?"checked":""}> ${s.manual?"Terdeteksi otomatis (OCR)":"Temuan OCR dibatalkan"}
            </label>`;
        }else{
          detectionHtml = `
            <label class="manual-toggle ${s.manual?'checked':''}">
              <input type="checkbox" class="detect-check" ${s.manual?"checked":""}> Tandai ada (cek manual)
            </label>`;
        }
        const naToggleHtml = item.conditional ? `
          <label class="na-toggle">
            <input type="checkbox" class="na-check" ${s.na?"checked":""}> Tidak berlaku (N/A)
          </label>` : "";
        const contentWarnHtml = (!naOn && s.contentWarning) ? contentWarnBadgeHtml(s.contentWarning) : "";

        row.innerHTML = `
          <div class="item-name">${escapeAttr(item.name)}${item.conditional?'<span class="cond-tag">Kondisional</span>':''}
            <span class="item-kw">${escapeAttr(item.keywords.join(", "))||"(tanpa kata kunci)"}</span>
          </div>
          <div class="item-controls">${naToggleHtml}${contentWarnHtml}${detectionHtml}</div>
        `;
        const detectInput = row.querySelector(".detect-check");
        if(detectInput){
          detectInput.addEventListener("change", e=>{
            entry.itemsStatus[item.id].manual = e.target.checked;
            entry.itemsStatus[item.id].userTouched = true;
            entry.open = true;
            markEntryDirty(entry);
            renderResults();
          });
        }
        const naInput = row.querySelector(".na-check");
        if(naInput){
          naInput.addEventListener("change", e=>{
            entry.itemsStatus[item.id].na = e.target.checked;
            entry.open = true;
            markEntryDirty(entry);
            renderResults();
          });
        }
        cl.appendChild(row);
      });
    }

    if(!groups.has(entry.category)){
      groups.set(entry.category, {
        label: cat.label,
        body: document.createElement("div"),
        total: 0, complete: 0, incomplete: 0
      });
      groups.get(entry.category).body.className = "category-group-body";
    }
    const g = groups.get(entry.category);
    g.total++;
    if(!entry.pending){ if(entry.error) g.failed=(g.failed||0)+1; else if(isComplete) g.complete++; else g.incomplete++; }
    g.body.appendChild(card);

    if(entry.open && !entry.pending){ pendingMounts.push({card, entry}); }
   }catch(err){
    console.error("Gagal me-render kartu berkas:", entry&&entry.id, err);
    showGlobalErrorToast(`gagal menampilkan berkas "${(entry&&entry.name)||"?"}"`);
   }
  });

  // Render tiap folder sesuai urutan kategori didefinisikan, hanya yang punya file
  Object.keys(categories).forEach(catKey=>{
    if(!groups.has(catKey)) return;
    const g = groups.get(catKey);
    const isOpen = categoryGroupOpen[catKey] !== false; // default terbuka

    const groupWrap = document.createElement("div");
    groupWrap.className = "category-group" + (isOpen ? "" : " collapsed");

    const header = document.createElement("div");
    header.className = "category-group-header";
    header.dataset.cat = catKey;
    const countText = g.total===0 ? "" :
      `${g.total} file${(g.complete+g.incomplete+(g.failed||0))>0 ? ` &middot; ${g.complete} lengkap, ${g.incomplete} kurang${g.failed?`, ${g.failed} gagal`:""}` : ""}`;
    header.innerHTML = `
      <span class="category-group-toggle">&#9662;</span>
      <span class="category-group-icon">&#128193;</span>
      <span class="category-group-label">${escapeAttr(g.label)}</span>
      <span class="category-group-count">${countText}</span>
    `;
    groupWrap.appendChild(header);
    groupWrap.appendChild(g.body);
    wrap.appendChild(groupWrap);
  });

  pendingMounts.forEach(({card, entry})=>{
    mountPdfViewer(card.querySelector(".viewer-pane"), entry);
  });

  document.getElementById("statTotal").textContent = files.length;
  document.getElementById("statComplete").textContent = completeCount;
  document.getElementById("statIncomplete").textContent = incompleteCount;
  document.getElementById("statFailed").textContent = counts.failed;
  const archiveAllBtn = document.getElementById("archiveAllBtn");
  if(archiveAllBtn) archiveAllBtn.disabled = !!retryAllState || !files.some(entry=>!entry.pending&&!entry.error&&!(entry.ocr&&entry.ocr.running)&&!isAutoOcrQueued(entry));
  renderPagination(document.getElementById("activePagination"),activePage,totalPages,next=>{
    keepAnchorPosition("activePagination",()=>{ closeAllActivePreviews(); activePage=next; renderResults(); });
  },`${ACTIVE_PAGE_SIZE} berkas/halaman`);
  renderArchivedPanel();
  scheduleSave();
}

/* ---------------- Export CSV ---------------- */
function itemStatusLabel(item, s){
  if(item.conditional && s.na) return "Tidak berlaku (N/A)";
  if(s.source==="digital") return "Lengkap";
  if(s.manual) return "Lengkap";
  return item.conditional ? "Tidak ditemukan (kondisional)" : "KURANG";
}
function itemSourceLabel(item, s){
  if(item.conditional && s.na) return "-";
  if(s.source==="digital") return "Teks digital (otomatis)";
  if(s.source==="ocr" && s.manual) return s.userTouched ? "OCR (dikonfirmasi)" : "OCR otomatis";
  if(s.source==="ocr" && !s.manual) return "OCR (dibatalkan)";
  if(s.manual) return "Dicentang manual";
  return "Belum diperiksa";
}
document.getElementById("results").addEventListener("click", e=>{
  const header = e.target.closest(".category-group-header");
  if(!header) return;
  const catKey = header.dataset.cat;
  const isOpen = categoryGroupOpen[catKey] !== false;
  categoryGroupOpen[catKey] = !isOpen;
  renderResults();
});

document.getElementById("summaryStrip").addEventListener("click", e=>{
  const box = e.target.closest(".sum-box[data-filter]");
  if(!box) return;
  const f = box.dataset.filter;
  resultFilter = (resultFilter===f) ? "all" : f; // klik lagi pada filter aktif untuk kembali menampilkan semua
  activePage = 1;
  renderResults();
});

document.getElementById("statusFilterSelect").addEventListener("change", e=>{
  resultFilter = e.target.value;
  activePage = 1;
  renderResults();
});
document.getElementById("failBar").addEventListener("click", async e=>{
  const btn=e.target.closest("button[data-fail-action]");
  if(!btn) return;
  const action=btn.dataset.failAction;
  if(action==="show"){ resultFilter="failed"; activePage=1; renderResults(); }
  else if(action==="all"){ resultFilter="all"; activePage=1; renderResults(); }
  else if(action==="csv"){ downloadFailedList(); }
  else if(action==="retry"){
    btn.disabled=true;
    // Izin folder cadangan harus diminta langsung dari klik pengguna.
    if(workspaceDirHandle && files.some(entry=>entry.error&&entry.externalStored&&!entry.blobStored)){
      await ensureWorkspacePermission(workspaceDirHandle,true);
    }
    retryAllFailedActive();
  }
});

document.getElementById("resultSearchInput").addEventListener("input", e=>{
  resultSearchQuery = e.target.value;
  document.getElementById("resultSearchBox").classList.toggle("has-value", resultSearchQuery.trim().length>0);
  activePage = 1;
  renderResults();
});
document.getElementById("resultSearchClear").addEventListener("click", ()=>{
  resultSearchQuery = "";
  const input = document.getElementById("resultSearchInput");
  input.value = "";
  document.getElementById("resultSearchBox").classList.remove("has-value");
  activePage = 1;
  renderResults();
  input.focus();
});

document.getElementById("archiveAllBtn").addEventListener("click",async ()=>{
  const completed = files.filter(entry=>!entry.pending&&!entry.error&&!(entry.ocr&&entry.ocr.running)&&!isAutoOcrQueued(entry));
  if(completed.length===0) return;
  const failedKept=files.filter(entry=>entry.error).length;
  if(!confirm(`Simpan hasil dan hapus ${completed.length} PDF yang sudah berhasil diperiksa dari antrean aktif? Ringkasan tetap tersimpan dan tetap ikut ke CSV; daftar Sampling tidak berubah.${failedKept?`\n\n${failedKept} berkas yang gagal dibaca TIDAK ikut dihapus agar masih bisa dimuat ulang.`:""}`)) return;
  const btn = document.getElementById("archiveAllBtn");
  btn.disabled = true;
  btn.textContent = "Menyimpan hasil...";
  await archiveFiles(completed);
  btn.textContent = "Simpan hasil & hapus semua PDF selesai";
});

/* ---------------- Ekspor Excel rapi (No, SEP, Keterangan, Rincian Berkas Kurang) ---------------- */
async function fillMissingSepForActive(onProgress){
  // Berkas lama (sebelum fitur SEP) belum punya nomor SEP; baca sekali dari teks tersimpan.
  const targets=files.filter(entry=>!entry.pending&&!entry.sep&&!entry._sepChecked);
  for(let i=0;i<targets.length;i++){
    const entry=targets[i];
    entry._sepChecked=true;
    try{
      await ensureAnalysisData(entry);
      entry.sep=extractSepNumber((entry.digitalText||"")+" "+(entry.ocrText||""))||extractSepNumber(entry.name)||"";
      if(entry.sep) dirtyActiveIds.add(entry.id);
      releaseEntryHeavyData(entry);
    }catch(e){}
    if(i%25===0){ onProgress(i+1,targets.length); await yieldToBrowser(); }
  }
  if(targets.length) scheduleSave(200);
}

function verificationReportRows(){
  const rows=[
    ...archivedFiles.map(row=>Object.assign({},row)),
    ...files.filter(entry=>!entry.pending).map(archivedSummaryFromEntry)
  ].sort((a,b)=>(a.order||0)-(b.order||0));
  const duplicateSeps=findDuplicateSeps();
  return rows.map((row,idx)=>{
    const missing=row.missingNames||[];
    let keterangan, rincian;
    const notes=row.noteNames||[];
    const noteLines=notes.length?["Catatan - dokumen kondisional tidak ditemukan:",...notes.map((name,i)=>`${i+1}. ${name}`)]:[];
    // Peringatan identitas tidak mengubah Keterangan; ditulis di kolom Rincian agar ikut tercetak.
    const identity=(row.identityNotes||[]).slice();
    if(row.sep && duplicateSeps.has(row.sep)) identity.push(`No. SEP ${row.sep} juga ada di berkas lain (kemungkinan berkas ganda)`);
    // Kolom tersendiri (tidak dicampur dengan rincian berkas kurang).
    const identitas=(identity.length && !row.error) ? identity.map((text,i)=>`${i+1}. ${text}`).join("\n") : "-";
    const identityLines=(identity.length && !row.error) ? identity.length : 1;
    let lineCount=1;
    if(row.error){ keterangan="Gagal Baca"; rincian=row.error; }
    else if(row.isComplete){
      keterangan="Lengkap"; // kolom Keterangan tetap 3 nilai baku; catatan ditulis di kolom Rincian
      rincian=noteLines.length?noteLines.join("\n"):"-";
      lineCount=Math.max(1,noteLines.length);
    }else{
      const parts=missing.map((name,i)=>`${i+1}. ${name}`).concat(noteLines);
      keterangan="Kurang"; rincian=parts.join("\n"); lineCount=Math.max(1,parts.length);
    }
    return {
      no:idx+1, sep:row.sep||extractSepNumber(row.name)||"", keterangan, rincian,
      rm:row.rm||"", identitas,
      lines:Math.max(lineCount,identityLines),
      kategori:row.categoryLabel||(categories[row.category]||{}).label||row.category||"",
      name:row.name||""
    };
  });
}

async function buildVerificationWorkbook(rows,ZipEngine){
  const X=medicineXml;
  const ns="http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const counts={Lengkap:0,Kurang:0,"Gagal Baca":0};
  rows.forEach(r=>{ counts[r.keterangan]++; });
  const stamp=new Date().toLocaleString("id-ID",{dateStyle:"long",timeStyle:"short"});
  const cell=(ref,value,style,isNumber)=> isNumber
    ? `<c r="${ref}" s="${style}"><v>${Number(value)}</v></c>`
    : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${X(value)}</t></is></c>`;
  const ketStyle={Lengkap:6,Kurang:7,"Gagal Baca":8};

  // ---- Sheet 1: Hasil Verifikasi ----
  const last=rows.length+4;
  const sheet=[`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`,
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:G${last}"/>`,
    `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`,
    `<sheetFormatPr defaultRowHeight="15"/>`,
    `<cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="25" customWidth="1"/><col min="3" max="3" width="14" customWidth="1"/><col min="4" max="4" width="14" customWidth="1"/><col min="5" max="5" width="52" customWidth="1"/><col min="6" max="6" width="52" customWidth="1"/><col min="7" max="7" width="40" customWidth="1"/></cols><sheetData>`,
    `<row r="1" ht="24" customHeight="1">${cell("A1","Hasil Verifikasi Kelengkapan Berkas Klaim",1)}</row>`,
    `<row r="2">${cell("A2",`SIPEKA Klaim • BPJS Kesehatan • Diunduh ${stamp} • ${rows.length} berkas: ${counts.Lengkap} lengkap, ${counts.Kurang} kurang, ${counts["Gagal Baca"]} gagal baca`,2)}</row>`,
    `<row r="3" ht="6" customHeight="1"/>`,
    `<row r="4" ht="22" customHeight="1">${["No","SEP","No. RM","Keterangan","Rincian Berkas Kurang / Catatan","Peringatan Identitas (RM/SEP/Kartu)","Nama File"].map((h,i)=>cell(String.fromCharCode(65+i)+"4",h,3)).join("")}</row>`];
  for(let i=0;i<rows.length;i++){
    const r=rows[i], n=i+5;
    const wrapLines=Math.max(r.lines, Math.ceil(String(r.rincian).length/60), Math.ceil(String(r.identitas).length/60), Math.ceil(r.name.length/45));
    sheet.push(`<row r="${n}" ht="${Math.max(18,wrapLines*15+3)}" customHeight="1">`+
      cell(`A${n}`,r.no,5,true)+cell(`B${n}`,r.sep||"Tidak terbaca",r.sep?9:10)+cell(`C${n}`,r.rm||"Tidak terbaca",r.rm?9:10)+cell(`D${n}`,r.keterangan,ketStyle[r.keterangan])+
      cell(`E${n}`,r.rincian,4)+cell(`F${n}`,r.identitas,4)+cell(`G${n}`,r.name,11)+`</row>`);
    if(i%1000===999) await yieldToBrowser();
  }
  sheet.push(`</sheetData><autoFilter ref="A4:G${last}"/><mergeCells count="2"><mergeCell ref="A1:G1"/><mergeCell ref="A2:G2"/></mergeCells>`,
    `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>`,
    `<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>`,
    `<headerFooter><oddFooter>&amp;LSIPEKA Klaim&amp;RHalaman &amp;P dari &amp;N</oddFooter></headerFooter></worksheet>`);

  // ---- Sheet 2: Ringkasan per kategori ----
  const byCat=new Map();
  rows.forEach(r=>{
    if(!byCat.has(r.kategori)) byCat.set(r.kategori,{Lengkap:0,Kurang:0,"Gagal Baca":0});
    byCat.get(r.kategori)[r.keterangan]++;
  });
  const sum=[`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>`,
    `<cols><col min="1" max="1" width="30" customWidth="1"/><col min="2" max="5" width="14" customWidth="1"/></cols><sheetData>`,
    `<row r="1" ht="24" customHeight="1">${cell("A1","Ringkasan per Kategori",1)}</row>`,
    `<row r="2">${cell("A2",`Diunduh ${stamp}`,2)}</row>`,
    `<row r="4" ht="22" customHeight="1">${["Kategori","Lengkap","Kurang","Gagal Baca","Total"].map((h,i)=>cell(String.fromCharCode(65+i)+"4",h,3)).join("")}</row>`];
  let rn=5;
  byCat.forEach((c,label)=>{
    sum.push(`<row r="${rn}" ht="18" customHeight="1">${cell("A"+rn,label,4)}${cell("B"+rn,c.Lengkap,5,true)}${cell("C"+rn,c.Kurang,5,true)}${cell("D"+rn,c["Gagal Baca"],5,true)}<c r="E${rn}" s="12"><f>SUM(B${rn}:D${rn})</f><v>${c.Lengkap+c.Kurang+c["Gagal Baca"]}</v></c></row>`);
    rn++;
  });
  sum.push(`<row r="${rn}" ht="20" customHeight="1">${cell("A"+rn,"Total",12)}${["B","C","D","E"].map(col=>`<c r="${col}${rn}" s="12"><f>SUM(${col}5:${col}${rn-1})</f></c>`).join("")}</row>`);
  sum.push(`</sheetData><mergeCells count="2"><mergeCell ref="A1:E1"/><mergeCell ref="A2:E2"/></mergeCells></worksheet>`);

  const zip=new ZipEngine();
  zip.file("xl/worksheets/sheet1.xml",sheet.join(""));
  zip.file("xl/worksheets/sheet2.xml",sum.join(""));
  zip.file("[Content_Types].xml",`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  zip.file("_rels/.rels",`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml",`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hasil Verifikasi" sheetId="1" r:id="rId1"/><sheet name="Ringkasan" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Hasil Verifikasi'!$A$4:$G$${last}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">'Hasil Verifikasi'!$4:$4</definedName></definedNames></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels",`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  const B='<left style="thin"><color rgb="FFC5D3E0"/></left><right style="thin"><color rgb="FFC5D3E0"/></right><top style="thin"><color rgb="FFC5D3E0"/></top><bottom style="thin"><color rgb="FFC5D3E0"/></bottom><diagonal/>';
  const xf=(font,fill,border,h,v,wrap)=>`<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment${h?` horizontal="${h}"`:""} vertical="${v||"top"}"${wrap?' wrapText="1"':""}/></xf>`;
  zip.file("xl/styles.xml",`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${ns}">
<fonts count="9">
<font><sz val="11"/><color rgb="FF1F2D3D"/><name val="Calibri"/></font>
<font><b/><sz val="15"/><color rgb="FF0A3D7A"/><name val="Calibri"/></font>
<font><i/><sz val="9.5"/><color rgb="FF5B6B80"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF00773A"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF9A6A12"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFB0302A"/><name val="Calibri"/></font>
<font><sz val="11"/><color rgb="FF1F2D3D"/><name val="Consolas"/></font>
<font><i/><sz val="10"/><color rgb="FF8A97A8"/><name val="Calibri"/></font>
</fonts>
<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF00873F"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3F5EA"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFCF1D9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFBE3E0"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8F1FB"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${B}</border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
${xf(1,0,0,"left","center",false)}
${xf(2,0,0,"left","center",false)}
${xf(3,2,1,"center","center",true)}
${xf(0,0,1,"left","top",true)}
${xf(0,0,1,"center","top",false)}
${xf(4,3,1,"center","top",false)}
${xf(5,4,1,"center","top",false)}
${xf(6,5,1,"center","top",false)}
${xf(7,0,1,"left","top",false)}
${xf(8,0,1,"left","top",false)}
${xf(8,0,1,"left","top",true)}
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return zip.generateAsync({type:"blob",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",compression:"DEFLATE",compressionOptions:{level:6}});
}

document.getElementById("exportExcelBtn").addEventListener("click",async e=>{
  const btn=e.currentTarget;
  const pendingCount=files.filter(entry=>entry.pending).length;
  if(!files.some(entry=>!entry.pending)&&!archivedFiles.length){ alert("Belum ada hasil pemeriksaan yang dapat diekspor."); return; }
  if(pendingCount&&!confirm(`${pendingCount} berkas masih diproses dan belum ikut ke Excel. Tetap unduh sekarang?`)) return;
  const label=btn.textContent;
  btn.disabled=true;
  const progress=document.getElementById("progressLine");
  try{
    const ZipEngine=await ensureZipEngine();
    await fillMissingSepForActive((i,total)=>{ btn.textContent=`Membaca SEP ${i}/${total}…`; });
    btn.textContent="Menyusun Excel…";
    const rows=verificationReportRows();
    const blob=await buildVerificationWorkbook(rows,ZipEngine);
    const d=new Date(), pad=n=>String(n).padStart(2,"0");
    const url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url; a.download=`hasil-verifikasi-sipeka-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
    a.click(); setTimeout(()=>URL.revokeObjectURL(url),30000);
    const noSep=rows.filter(r=>!r.sep).length;
    if(noSep){
      progress.textContent=`Excel diunduh. ${noSep} berkas nomor SEP-nya tidak terbaca (ditandai “Tidak terbaca”; nama file tetap dicantumkan).`;
      setTimeout(()=>{ if(progress.textContent.startsWith("Excel diunduh")) progress.textContent=""; },8000);
    }
  }catch(err){
    alert("Excel gagal dibuat: "+(err.message||err)+". Data tidak berubah; coba lagi atau gunakan CSV.");
  }finally{
    btn.disabled=false; btn.textContent=label;
  }
});

document.getElementById("exportBtn").onclick = async ()=>{
  const activeRows = files.filter(f=>!f.pending).map(entry=>Object.assign(archivedSummaryFromEntry(entry),{stored:false}));
  const storedRows = archivedFiles.map(row=>Object.assign({},row,{stored:true}));
  const allRows = [...storedRows,...activeRows].sort((a,b)=>(a.order||0)-(b.order||0));
  if(allRows.length===0){ alert("Belum ada hasil pemeriksaan yang dapat diekspor."); return; }

  const byCategory = {};
  allRows.forEach(row=>{
    (byCategory[row.category] = byCategory[row.category] || []).push(row);
  });
  const catKeys = Object.keys(byCategory);

  const csvDuplicateSeps=findDuplicateSeps();
  function buildCsvForCategory(catKey, resultRows){
    const rows = [["No Urut","ID Hasil","Nama File","Kategori","Status Keseluruhan File","Jumlah Dokumen Kurang","Jenis Baris","Rincian Dokumen Kurang","Waktu Disimpan","Posisi Data","No. RM"]];
    resultRows.forEach((row,idx)=>{
      const catLabel = row.categoryLabel || (categories[catKey]||{}).label || catKey;
      const missing = row.missingNames||[];
      const notes = row.noteNames||[];
      const fileStatus = row.error ? `Gagal dibaca: ${row.error}` : (row.isComplete ? (notes.length?"Lengkap (dengan catatan)":"Lengkap") : `Belum Lengkap (kurang ${missing.length})`);
      const completedAt = row.completedAt ? new Date(row.completedAt).toLocaleString("id-ID") : "-";
      const noUrut = row.order||idx+1;
      // Baris ringkasan: satu baris per berkas, tetap memuat gabungan singkat semua dokumen yang kurang
      rows.push([
        noUrut, row.id, row.name, catLabel, fileStatus, missing.length,
        "Ringkasan Berkas",
        missing.length?missing.join("; "):"-",
        completedAt, row.stored?"Hasil tersimpan":"Antrean aktif", row.rm||""
      ]);
      // Baris rincian: satu baris tersendiri untuk SETIAP dokumen yang kurang, agar tidak pernah terpotong/tersembunyi
      missing.forEach((docName,mIdx)=>{
        rows.push([
          noUrut, row.id, row.name, catLabel, fileStatus, missing.length,
          `Dokumen Kurang ${mIdx+1} dari ${missing.length}`,
          docName,
          completedAt, row.stored?"Hasil tersimpan":"Antrean aktif", row.rm||""
        ]);
      });
      // Peringatan identitas (No. RM/SEP/kartu tidak konsisten, SEP ganda) - tidak mengubah status berkas
      const identityRows=(row.identityNotes||[]).slice();
      if(row.sep && csvDuplicateSeps.has(row.sep)) identityRows.push(`No. SEP ${row.sep} juga ada di berkas lain (kemungkinan berkas ganda)`);
      if(!row.error) identityRows.forEach((text,iIdx)=>{
        rows.push([
          noUrut, row.id, row.name, catLabel, fileStatus, missing.length,
          `Peringatan Identitas ${iIdx+1} dari ${identityRows.length}`,
          text,
          completedAt, row.stored?"Hasil tersimpan":"Antrean aktif", row.rm||""
        ]);
      });
      // Catatan: dokumen kondisional yang tidak ditemukan (tidak mengubah status berkas)
      notes.forEach((docName,nIdx)=>{
        rows.push([
          noUrut, row.id, row.name, catLabel, fileStatus, missing.length,
          `Catatan Kondisional ${nIdx+1} dari ${notes.length}`,
          docName,
          completedAt, row.stored?"Hasil tersimpan":"Antrean aktif", row.rm||""
        ]);
      });
    });
    return rows.map(r=>r.map(csvSafeCell).join(",")).join("\r\n");
  }

  if(catKeys.length===1){
    // hanya satu kategori: unduh langsung sebagai CSV tunggal, tidak perlu zip
    const csv = buildCsvForCategory(catKeys[0],byCategory[catKeys[0]]);
    const blob = new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `hasil-verifikasi-lengkap-${catKeys[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  let ZipClass;
  try{ ZipClass=await ensureZipEngine(); }
  catch(err){ alert(err.message||"Mesin ekspor ZIP tidak tersedia."); return; }
  const zip = new ZipClass();
  catKeys.forEach(catKey=>{
    const csv = buildCsvForCategory(catKey, byCategory[catKey]);
    zip.file(`ringkasan-${catKey}-${categories[catKey].label.replace(/[^a-z0-9]+/gi,"-")}.csv`, "\uFEFF"+csv);
  });
  const blob = await zip.generateAsync({type:"blob"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "hasil-verifikasi-lengkap-per-kategori.zip";
  a.click();
  URL.revokeObjectURL(url);
};

function initModeSelect(){
  const sel = document.getElementById("modeSelect");
  sel.innerHTML = Object.keys(categories).map(k=>`<option value="${k}">${categories[k].label}</option>`).join("");
  sel.value = currentEditorCat;
  sel.onchange = e=> setActiveCategory(e.target.value);
}

/* ---------------- View switch ---------------- */
document.getElementById("viewSwitch").addEventListener("click", e=>{
  const btn = e.target.closest("button[data-view]");
  if(!btn) return;
  const view = btn.dataset.view;
  applyVisibleView(view);
  scheduleSave();
});

/* ================= BATCH (Verifikasi Kolektif per Layanan Puskesmas) ================= */

function normalizeName(s){
  return String(s||"").toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^A-Z0-9 ]/g," ")
    .replace(/\s+/g," ").trim();
}

function parseRosterText(text){
  return String(text||"").split("\n").map(l=>l.trim()).filter(Boolean).map(line=>{
    const parts = line.split(/\t|,/).map(s=>s.trim());
    return {
      name: parts[0] || line,
      noKunjungan: parts[1] || "",
      tanggal: parts[2] || "",
      tindakan: parts[3] || "",
      hasil: parts[4] || "",
      tenagaMedis: parts[5] || "",
      biaya: parts[6] || ""
    };
  });
}
function rosterRowToLine(row){
  return [row.name, row.noKunjungan, row.tanggal, row.tindakan, row.hasil, row.tenagaMedis, row.biaya].join(", ");
}

function matchNameToRoster(filename, roster){
  const normFile = normalizeName(filename);
  if(!normFile) return -1;
  const candidates = roster
    .map((row, idx)=>({idx, norm: normalizeName(row.name)}))
    .filter(c=>c.norm && normFile.includes(c.norm))
    .sort((a,b)=> b.norm.length - a.norm.length);
  return candidates.length ? candidates[0].idx : -1;
}

/* ---------------- Pindai (OCR) berkas kolektif -> tarik baris tabel otomatis (eksperimental) ---------------- */
function extractKolektifRows(rawText){
  const lines = String(rawText||"").split(/\n+/).map(l=>l.trim()).filter(Boolean);
  const noKunjunganRe = /\b\d{9,}[A-Za-z]\d{3,}\b/;
  const tanggalRe = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/;
  const biayaRe = /Rp\.?\s?[\d.,]{3,}/gi;
  const tenagaRe = /\b(DR\.?|DRG\.?|BD\.?|BIDAN)\s?[A-Z.,' ]{3,}/i;
  const skipRe = /^(no\b|nama|no\.?kunjungan|no\.?kartu|tanggal|tindakan|hasil|tenaga|biaya|jumlah|total|formulir|lampiran|puskesmas|kota|bulan|jenis|penanggung|mengetahui|kepala)/i;
  const rows = [];
  lines.forEach(line=>{
    if(skipRe.test(line)) return;
    const tanggalM = line.match(tanggalRe);
    if(!tanggalM) return; // baris data minimal punya tanggal
    let rest = line;
    const noKunjunganM = line.match(noKunjunganRe);
    let noKunjungan = "";
    if(noKunjunganM){ noKunjungan = noKunjunganM[0]; rest = rest.replace(noKunjunganM[0]," "); }
    const tanggal = tanggalM[0].replace(/-/g,"/");
    rest = rest.replace(tanggalM[0]," ");
    const biayaMatches = rest.match(biayaRe) || [];
    const biaya = biayaMatches.length ? biayaMatches[biayaMatches.length-1].replace(/\s+/g," ").trim() : "";
    biayaMatches.forEach(b=>{ rest = rest.replace(b," "); });
    const tenagaM = rest.match(tenagaRe);
    let tenagaMedis = "";
    if(tenagaM){ tenagaMedis = tenagaM[0].trim(); rest = rest.replace(tenagaM[0]," "); }
    rest = rest.replace(/\s{2,}/g," | ").trim();
    const segs = rest.split("|").map(s=>s.trim()).filter(Boolean);
    if(segs.length===0) return;
    const name = segs[0].replace(/^\d+\s*/,"").replace(/[^A-Za-z .'-]/g,"").trim();
    if(!name || name.length<2) return;
    const tindakan = segs.slice(1).join(" | ");
    rows.push({ name, noKunjungan, tanggal, tindakan, hasil:"", tenagaMedis, biaya });
  });
  return rows;
}

async function scanKolektifFile(batch, file, statusEl){
  statusEl.textContent = "Membaca file...";
  let pdfDoc=null;
  try{
    pdfDoc = await openPdfDocument(file,file.name,120000);
    let fullText = "";
    await ensureTesseractWorker();
    for(let p=1;p<=pdfDoc.numPages;p++){
      statusEl.textContent = `Memindai halaman ${p} dari ${pdfDoc.numPages} (OCR)...`;
      const page = await pdfDoc.getPage(p);
      const baseViewport=page.getViewport({scale:1});
      const scanScale=boundedCanvasScale(baseViewport.width,baseViewport.height,2.2,3200,8*1024*1024);
      const viewport = page.getViewport({scale:scanScale});
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      let result;
      try{
        await page.render({canvasContext:canvas.getContext("2d"), viewport}).promise;
        result = await recognizeCanvasWithTesseract(canvas);
      }finally{
        try{ page.cleanup(); }catch(e){}
        canvas.width=1; canvas.height=1;
      }
      fullText += (result.data.text||"") + "\n";
    }
    const rows = extractKolektifRows(fullText);
    if(rows.length===0){
      statusEl.textContent = "Tidak ada baris yang berhasil dikenali secara otomatis. Coba tempel manual, atau periksa hasil scan.";
      return;
    }
    const existing = batch.rosterText.trim();
    const newLines = rows.map(rosterRowToLine).join("\n");
    batch.rosterText = existing ? (existing + "\n" + newLines) : newLines;
    batch.roster = parseRosterText(batch.rosterText);
    reconcileBatchMatches(batch);
    statusEl.textContent = `Berhasil menarik ${rows.length} baris (eksperimental) \u2014 periksa & koreksi hasilnya di daftar di bawah sebelum digunakan.`;
    renderBatches();
  }catch(err){
    statusEl.textContent = "Gagal memindai: " + (err.message || "kesalahan tidak diketahui.");
  }finally{
    await destroyPdfDocument(pdfDoc);
  }
}

function withFocusPreserved(renderFn){
  const active = document.activeElement;
  let key = null, start = null, end = null;
  if(active && active.dataset && active.dataset.focusKey){
    key = active.dataset.focusKey;
    if(typeof active.selectionStart === "number"){ start = active.selectionStart; end = active.selectionEnd; }
  }
  renderFn();
  if(key){
    const el = document.querySelector(`[data-focus-key="${key.replace(/"/g,'\\"')}"]`);
    if(el){
      el.focus();
      if(start!==null && typeof el.setSelectionRange === "function"){
        try{ el.setSelectionRange(start, end); }catch(e){}
      }
    }
  }
}

function addBatch(){
  const id = "b"+(batchCounter++);
  const serviceKeys = Object.keys(kolektifCategories);
  const service = serviceKeys[0];
  batches.push({
    id, service, label: kolektifCategories[service].label,
    rosterText: "", roster: [], patientFiles: [], open:true, checklistEditorOpen:false
  });
  renderBatches();
}
document.getElementById("addBatchBtn").addEventListener("click", addBatch);

async function removeBatchAndPayloads(batch){
  const entries=(batch.patientFiles||[]).slice();
  const ids=entries.map(entry=>entry.id);
  try{ await dbDeletePayloadEntries(ids); }
  catch(err){
    updateSaveIndicator(false,err);
    alert("Layanan belum dihapus karena penyimpanan berkasnya belum berhasil dibersihkan. Coba lagi setelah memeriksa ruang penyimpanan.");
    return false;
  }
  entries.forEach(closeEntryResources);
  entries.forEach(entry=>{
    workspaceDirtyAnalysisIds.delete(entry.id);
    workspaceSyncedAnalysisIds.delete(entry.id);
    workspaceSyncedPdfIds.delete(`batch:${batch.id}:${entry.id}`);
  });
  batches=batches.filter(item=>item.id!==batch.id);
  renderBatches();
  await persistState();
  if(workspaceDirHandle&&await ensureWorkspacePermission(workspaceDirHandle,false)){
    const manifestSaved=await saveWorkspaceBackup(true);
    if(manifestSaved){
      const batchPdfDir=await getWorkspaceDirectory("batch-pdfs",true);
      for(const entry of entries){
        const targetName=entry.externalFileName||`${workspaceFileName(batch.id)}--${workspaceFileName(entry.id)}.pdf`;
        await deleteWorkspaceEntryIfPresent(batchPdfDir,targetName);
      }
    }
  }
  return true;
}

function reconcileBatchMatches(batch){
  // re-match every patient file against current roster
  batch.patientFiles.forEach(pf=>{
    pf.rosterIndex = matchNameToRoster(pf.name, batch.roster);
  });
}

async function handleBatchFiles(batch, fileList){
  const list = Array.from(fileList).filter(f=>f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  if(list.length===0) return;
  try{ await ensurePdfEngine(); }
  catch(err){ alert(err.message||"Mesin pembaca PDF tidak tersedia."); return; }
  const useWorkspaceStorage=!!workspaceDirHandle && await ensureWorkspacePermission(workspaceDirHandle,false);
  if(!(await preflightStorageForFiles(list.map(file=>({file})),useWorkspaceStorage))) return;
  const batchPdfDir=useWorkspaceStorage ? await getWorkspaceDirectory("batch-pdfs",true) : null;
  const progress=document.getElementById("progressLine");
  for(let i=0;i<list.length;i++){
    const f = list[i];
    progress.textContent=`Memproses berkas kolektif ${i+1} dari ${list.length}: ${f.name}`;
    const id = "pf"+(fileCounter++);
    const entry = { id, name:f.name, size:f.size||0, lastModified:f.lastModified||0, digitalText:"", ocrText:"", pending:true, itemsStatus:{}, objectUrl:"", blob:f, blobStored:false, open:false, pdfDoc:null, pageTexts:[], ocrCandidates:[], _analysisLoaded:true, analysisStored:false, ocr:{running:false, done:false, error:null, progress:"",processedPages:[],automatic:false} };
    entry.rosterIndex = matchNameToRoster(entry.name, batch.roster);
    batch.patientFiles.push(entry);
    if(batchPdfDir){
      try{
        const targetName=`${workspaceFileName(batch.id)}--${workspaceFileName(entry.id)}.pdf`;
        await writeWorkspaceFile(batchPdfDir,targetName,f);
        entry.externalStored=true;
        entry.externalPdfFolder="batch-pdfs";
        entry.externalFileName=targetName;
        workspaceSyncedPdfIds.add(`batch:${batch.id}:${entry.id}`);
      }catch(err){ console.warn("PDF kolektif belum dapat ditulis ke folder cadangan:",err); }
    }
    if(!entry.externalStored){
      try{ await dbWritePayloadEntries([entry],true,false); }
      catch(err){
        updateSaveIndicator(false,err);
        console.warn("PDF kolektif belum tersimpan permanen:",err);
      }
    }
    renderBatches();
    await analyzeBatchPatientEntry(batch,entry);
    renderBatches();
    await yieldToBrowser();
  }
  if(useWorkspaceStorage){
    await waitForGuaranteedLocalSave();
    await saveWorkspaceBackup(true);
  }
  progress.textContent=`Selesai memproses ${list.length} berkas kolektif.`;
  setTimeout(()=>{ if(progress.textContent.startsWith("Selesai memproses")) progress.textContent=""; },5000);
}

async function analyzeBatchPatientEntry(batch,entry,isAutoRetry){
  entry.pageTexts=[];
  entry.digitalText="";
  entry.ocrText=entry.ocrText||"";
  entry.ocrCandidates=[];
  entry.error=null;
  entry.errorKind=null;
  try{
    const blob=await getEntryBlobForBackup(entry);
    entry.blob=blob;
    entry.pdfDoc=await openPdfDocument(blob,entry.name,120000);
    let full="";
    for(let p=1;p<=entry.pdfDoc.numPages;p++){
      const page=await withTimeout(entry.pdfDoc.getPage(p),45000,`Halaman ${p} tidak merespons.`);
      const content=await withTimeout(page.getTextContent(),45000,`Teks halaman ${p} tidak merespons.`);
      try{ page.cleanup(); }catch(e){}
      const t=content.items.map(it=>it.str).join(" ").replace(/[\r\n]+/g," ");
      if(t.trim().length<20) entry.ocrCandidates.push(p-1);
      entry.pageTexts.push(compactPageText(t));
      full+=t+"\n";
    }
    entry.digitalText=full.toLowerCase();
  }catch(err){
    const info=classifyPdfError(err);
    entry.error=info.message;
    entry.errorKind=info.kind;
    if(err&&err.code==="TIMEOUT") retireSharedPdfWorker();
  }
  await destroyPdfDocument(entry.pdfDoc);
  entry.pdfDoc=null;
  if(entry.error&&entry.errorKind==="transient"&&!isAutoRetry){
    // Satu kali coba ulang otomatis untuk kegagalan sementara.
    await delayMs(300);
    return analyzeBatchPatientEntry(batch,entry,true);
  }
  entry.pending=false;
  entry._analysisLoaded=true;
  evaluateAgainstCat(entry,kolektifCategories[batch.service]);
  if(!entry.error&&entry.ocrCandidates.length){
    enqueueAutoOcr(entry,{renderFn:renderBatches,evalFn:(en)=>evaluateAgainstCat(en,kolektifCategories[batch.service]),persistActive:false});
  }
  try{ await dbWritePayloadEntries([entry],false,true); }
  catch(err){ updateSaveIndicator(false,err); }
  releaseEntryHeavyData(entry);
  scheduleSave(100);
}

async function retryBatchPatientAnalysis(batch,entry){
  if(!entry||entry.pending) return;
  entry.pending=true;
  entry.error=null;
  entry.ocrText="";
  entry.ocrPageTexts={};
  entry.ocr={running:false,done:false,error:null,progress:"",processedPages:[],automatic:false};
  renderBatches();
  await analyzeBatchPatientEntry(batch,entry);
  renderBatches();
}

async function resumeInterruptedBatchFiles(){
  const pending=[];
  batches.forEach(batch=>batch.patientFiles.forEach(entry=>{ if(entry.pending) pending.push({batch,entry}); }));
  if(!pending.length) return;
  for(let i=0;i<pending.length;i++){
    await analyzeBatchPatientEntry(pending[i].batch,pending[i].entry);
    if(i%10===0){ renderBatches(); await yieldToBrowser(); }
  }
  renderBatches();
  await waitForGuaranteedLocalSave();
}

function batchStats(batch){
  let matched=0, complete=0;
  batch.roster.forEach((row, idx)=>{
    const pf = batch.patientFiles.find(p=>p.rosterIndex===idx);
    if(pf && !pf.pending && !pf.error){
      matched++;
      if(fileMissingItems(pf, kolektifCategories[batch.service]).length===0) complete++;
    }
  });
  return { total: batch.roster.length, matched, complete };
}

function renderBatches(){
  const wrap = document.getElementById("batchList");
  wrap.innerHTML = "";
  document.getElementById("batchEmptyNote").style.display = batches.length ? "none" : "block";
  document.getElementById("batchCount").textContent = batches.length ? `${batches.length} layanan` : "";

  batches.forEach(batch=>{
   try{
    const cat = kolektifCategories[batch.service];
    const stats = batchStats(batch);
    const card = document.createElement("div");
    card.className = "batch-card";

    const serviceOptions = Object.keys(kolektifCategories).map(k=>`<option value="${k}" ${k===batch.service?"selected":""}>${kolektifCategories[k].label}</option>`).join("");
    const pillWarn = stats.total>0 && stats.complete < stats.total;

    card.innerHTML = `
      <div class="batch-head">
        <select class="batch-service-select">${serviceOptions}</select>
        <input type="text" class="batch-label-input" value="${escapeAttr(batch.label)}">
        <span class="batch-summary-pill ${pillWarn?'warn':''}">${stats.complete}/${stats.total} pasien lengkap${stats.matched<stats.total ? ` &middot; ${stats.total-stats.matched} belum ada berkas` : ''}</span>
        ${batch.patientFiles.some(pf=>pf.error&&!pf.pending)?`<button class="mini-action-btn danger batch-retry-all" type="button" ${batch._retrying?"disabled":""}>${batch._retrying?"Memuat ulang…":`&#8635; Muat ulang yang gagal (${batch.patientFiles.filter(pf=>pf.error&&!pf.pending).length})`}</button>`:""}
        <button class="mini-btn batch-remove-btn">Hapus layanan</button>
      </div>
      <div class="batch-body">
        <details class="batch-editor-toggle" ${batch.checklistEditorOpen ? "open":""}><summary>Sesuaikan checklist dokumen (${cat.items.length} jenis)</summary></details>
        <div class="scan-box">
          <div class="scan-row">
            <label class="scan-btn-label">Pindai berkas kolektif (OCR)<input type="file" accept="application/pdf" class="scan-input"></label>
            <span class="scan-status">Unggah 1 file kolektif/FPK untuk coba menarik No Kunjungan, Nama, Tanggal, Tindakan, Hasil, Tenaga Medis &amp; Biaya otomatis.</span>
          </div>
          <div class="scan-note">Eksperimental &mdash; hasil scan/tulisan tangan bisa salah baca. Baris yang berhasil ditarik akan ditambahkan ke daftar di bawah; <strong>selalu periksa &amp; koreksi</strong> sebelum dipakai untuk verifikasi.</div>
        </div>
        <label class="roster-label">Atau tempel/koreksi daftar pasien manual &mdash; satu pasien per baris, format: <em>Nama, No Kunjungan, Tanggal, Tindakan, Hasil, Tenaga Medis, Biaya</em> (kolom selain Nama boleh dikosongkan).</label>
        <textarea class="roster-textarea" data-focus-key="roster-${batch.id}" placeholder="ELISA, 042101020626Y000128, 04/06/2026, Pelayanan ANC 1 dengan USG, , DR. SOFIAN CHRISTIAN, Rp 140.000">${escapeAttr(batch.rosterText)}</textarea>
        <div class="roster-count">Jumlah pasien pada daftar: ${batch.roster.length}</div>
        <div class="batch-upload-zone">Seret berkas per pasien ke sini, atau klik untuk pilih (bisa banyak sekaligus)<input type="file" accept="application/pdf" multiple></div>
        <div class="unmatched-wrap"></div>
        <div class="roster-list"></div>
      </div>
    `;

    // checklist editor (reuse item-row pattern)
    const editorDetails = card.querySelector(".batch-editor-toggle");
    editorDetails.addEventListener("toggle", ()=>{ batch.checklistEditorOpen = editorDetails.open; scheduleSave(); });
    const editorBody = document.createElement("div");
    editorBody.style.marginTop = "10px";
    cat.items.forEach((item, idx)=>{
      const row = document.createElement("div");
      row.className = "item-row";
      row.innerHTML = `
        <input type="text" value="${escapeAttr(item.name)}" class="name-input" data-focus-key="bname-${batch.id}-${idx}">
        <textarea class="kw-input" data-focus-key="bkw-${batch.id}-${idx}" placeholder="kata kunci, dipisah koma">${escapeAttr(item.keywords.join(", "))}</textarea>
        <label class="cond-check"><input type="checkbox" class="cond-input" ${item.conditional?"checked":""}> Kondisional (bisa ditandai "tidak berlaku")</label>
        <div class="row-foot"><button class="mini-btn">Hapus</button></div>
      `;
      row.querySelector(".name-input").addEventListener("input", e=>{ item.name = e.target.value; withFocusPreserved(renderBatches); });
      row.querySelector(".kw-input").addEventListener("input", e=>{ item.keywords = e.target.value.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean); reprocessBatchesOfService(batch.service); });
      row.querySelector(".cond-input").addEventListener("change", e=>{ item.conditional = e.target.checked; reprocessBatchesOfService(batch.service); });
      row.querySelector(".mini-btn").addEventListener("click", ()=>{ cat.items.splice(idx,1); reprocessBatchesOfService(batch.service); });
      editorBody.appendChild(row);
    });
    const addItemBtn = document.createElement("button");
    addItemBtn.className = "add-item-btn";
    addItemBtn.textContent = "+ Tambah jenis dokumen";
    addItemBtn.addEventListener("click", ()=>{
      cat.items.push({id:"item_"+Date.now(), name:"Jenis dokumen baru", keywords:[], conditional:false});
      renderBatches();
    });
    editorBody.appendChild(addItemBtn);
    editorDetails.appendChild(editorBody);

    card.querySelector(".batch-service-select").addEventListener("change", e=>{
      batch.service = e.target.value;
      batch.label = kolektifCategories[batch.service].label;
      renderBatches();
      reprocessBatchEntries(batch);
    });
    card.querySelector(".batch-label-input").addEventListener("input", e=>{ batch.label = e.target.value; scheduleSave(); });
    const batchRetryAllBtn=card.querySelector(".batch-retry-all");
    if(batchRetryAllBtn){
      batchRetryAllBtn.addEventListener("click",async ()=>{
        if(batch._retrying) return;
        batch._retrying=true;
        renderBatches();
        const run=async()=>{
          try{
            retireSharedPdfWorker();
            const failed=batch.patientFiles.filter(pf=>pf.error&&!pf.pending);
            for(let i=0;i<failed.length;i++){
              const pf=failed[i];
              pf.pending=true; pf.ocrText=""; pf.ocrPageTexts={};
              pf.ocr={running:false,done:false,error:null,progress:"",processedPages:[],automatic:false};
              document.getElementById("progressLine").textContent=`Memuat ulang berkas kolektif ${i+1} dari ${failed.length}...`;
              await analyzeBatchPatientEntry(batch,pf);
              if(i%5===4){ renderBatches(); await yieldToBrowser(); }
            }
            await persistState();
            const still=failed.filter(pf=>pf.error).length;
            document.getElementById("progressLine").textContent=`Muat ulang kolektif selesai: ${failed.length-still} berhasil${still?`, ${still} masih gagal`:""}.`;
          }finally{
            batch._retrying=false;
            renderBatches();
          }
        };
        fileImportQueue=fileImportQueue.then(run,run);
      });
    }
    card.querySelector(".batch-remove-btn").addEventListener("click", async e=>{
      if(confirm(`Hapus layanan "${batch.label}" beserta seluruh berkas yang sudah diunggah?`)){
        const button=e.currentTarget;
        button.disabled=true;
        button.textContent="Menghapus…";
        const removed=await removeBatchAndPayloads(batch);
        if(!removed){ button.disabled=false; button.textContent="Hapus layanan"; }
      }
    });

    const scanInput = card.querySelector(".scan-input");
    const scanStatus = card.querySelector(".scan-status");
    scanInput.addEventListener("change", e=>{
      const f = e.target.files[0];
      if(!f) return;
      scanKolektifFile(batch, f, scanStatus);
      e.target.value = "";
    });

    const rosterTA = card.querySelector(".roster-textarea");
    rosterTA.addEventListener("input", e=>{
      batch.rosterText = e.target.value;
      batch.roster = parseRosterText(batch.rosterText);
      reconcileBatchMatches(batch);
      withFocusPreserved(renderBatches);
    });

    const upZone = card.querySelector(".batch-upload-zone");
    const upInput = upZone.querySelector("input");
    upZone.addEventListener("click", ()=>upInput.click());
    upInput.addEventListener("change", e=> handleBatchFiles(batch, e.target.files));
    ["dragenter","dragover"].forEach(ev=>upZone.addEventListener(ev,e=>{e.preventDefault();upZone.classList.add("drag");}));
    ["dragleave","drop"].forEach(ev=>upZone.addEventListener(ev,e=>{e.preventDefault();upZone.classList.remove("drag");}));
    upZone.addEventListener("drop", e=> handleBatchFiles(batch, e.dataTransfer.files));

    // unmatched files (uploaded but no roster match)
    const unmatched = batch.patientFiles.filter(pf=>pf.rosterIndex===-1 && !pf.pending);
    const umWrap = card.querySelector(".unmatched-wrap");
    if(unmatched.length){
      const box = document.createElement("div");
      box.className = "unmatched-box";
      box.innerHTML = `<div class="um-title">${unmatched.length} berkas belum cocok otomatis dengan nama di daftar &mdash; pilih pasien secara manual:</div>`;
      unmatched.forEach(pf=>{
        const row = document.createElement("div");
        row.className = "unmatched-row";
        const opts = `<option value="-1">-- pilih pasien --</option>` + batch.roster.map((r,idx)=>`<option value="${idx}">${escapeAttr(r.name)}</option>`).join("");
        row.innerHTML = `<span class="fname">${escapeAttr(pf.name)}</span><select class="assign-select">${opts}</select>`;
        row.querySelector("select").addEventListener("change", e=>{
          pf.rosterIndex = parseInt(e.target.value,10);
          renderBatches();
        });
        box.appendChild(row);
      });
      umWrap.appendChild(box);
    }

    // roster list
    const rosterListEl = card.querySelector(".roster-list");
    batch.roster.forEach((row, idx)=>{
      const pf = batch.patientFiles.find(p=>p.rosterIndex===idx);
      const rrow = document.createElement("div");
      rrow.className = "roster-row" + (!pf ? " missing-file" : "");

      let statusBadge;
      if(!pf) statusBadge = `<span class="badge incomplete">Belum ada berkas</span>`;
      else if(pf.pending) statusBadge = `<span class="badge loading">Memproses...</span>`;
      else if(pf.error) statusBadge = `<span class="badge incomplete" title="${escapeAttr(pf.error)}">Gagal membaca PDF</span><button class="mini-action-btn batch-retry-file" type="button">Coba baca ulang</button>`;
      else{
        const missing = fileMissingItems(pf, cat);
        statusBadge = missing.length===0 ? completeBadgeHtml(fileConditionalNotes(pf, cat).map(item=>item.name)) : `<span class="badge incomplete">Kurang ${missing.length} dokumen</span>`;
      }

      rrow.innerHTML = `
        <div class="roster-row-head">
          <span class="rp-name">${idx+1}. ${escapeAttr(row.name)}</span>
          <span class="rp-meta">${[row.noKunjungan,row.tanggal,row.tindakan,row.tenagaMedis,row.biaya].filter(Boolean).map(escapeAttr).join(" &middot; ")}</span>
          ${statusBadge}
          <span class="chevron">&#9656;</span>
        </div>
      `;
      const detailWrap = document.createElement("div");
      if(pf){
        detailWrap.appendChild(buildFileDetailNode(pf, cat, ()=>renderBatches()));
      }
      detailWrap.style.display = "none";
      rrow.appendChild(detailWrap);
      rrow.querySelector(".roster-row-head").addEventListener("click", ()=>{
        if(!pf) return;
        if(pf.open) closeEntryResources(pf);
        else{ closeAllBatchPreviews(pf); pf.open=true; }
        renderBatches();
      });
      const batchRetryBtn=rrow.querySelector(".batch-retry-file");
      if(batchRetryBtn){
        batchRetryBtn.addEventListener("click",async e=>{
          e.stopPropagation();
          batchRetryBtn.disabled=true;
          batchRetryBtn.textContent="Membaca ulang…";
          await retryBatchPatientAnalysis(batch,pf);
        });
      }
      if(pf && pf.open){ detailWrap.style.display = ""; rrow.querySelector(".chevron").style.transform="rotate(90deg)"; }
      rosterListEl.appendChild(rrow);
    });

    wrap.appendChild(card);
   }catch(err){
    console.error("Gagal me-render kartu layanan kolektif:", batch&&batch.id, err);
    showGlobalErrorToast(`gagal menampilkan layanan "${(batch&&batch.label)||"?"}"`);
   }
  });
  scheduleSave();
}

async function reprocessBatchEntries(batch){
  const targets=(batch.patientFiles||[]).filter(entry=>!entry.pending&&!entry.error);
  for(let start=0;start<targets.length;start+=50){
    const chunk=targets.slice(start,start+50);
    try{ await Promise.all(chunk.map(ensureAnalysisData)); }
    catch(err){ updateSaveIndicator(false,err); }
    chunk.forEach(entry=>evaluateAgainstCat(entry,kolektifCategories[batch.service]));
    chunk.forEach(releaseEntryHeavyData);
    await yieldToBrowser();
  }
  renderBatches();
  scheduleSave(100);
}

const batchReprocessTimers=new Map();
function reprocessBatchesOfService(serviceKey){
  clearTimeout(batchReprocessTimers.get(serviceKey));
  batchReprocessTimers.set(serviceKey,setTimeout(()=>{
    batchReprocessTimers.delete(serviceKey);
    batches.filter(batch=>batch.service===serviceKey).forEach(batch=>reprocessBatchEntries(batch));
  },450));
}

/* Builds the checklist + preview node for a single patient file entry (shared look with per-file checklist) */
function buildFileDetailNode(entry, cat, onChange){
  const wrap = document.createElement("div");
  wrap.className = "checklist batch-checklist";

  const scanPages = (!entry.pending && !entry.error) ? ocrCandidatePages(entry) : [];
  let ocrHtml = "";
  if(scanPages.length>0){
    const queued=isAutoOcrQueued(entry);
    let statusLine;
    if(entry.ocr.running) statusLine = `<span>${escapeAttr(entry.ocr.progress)}</span>`;
    else if(entry.ocr.error) statusLine = `<span class="ocr-error">${escapeAttr(entry.ocr.error)}</span>`;
    else if(entry.ocr.done) statusLine = `<span class="ocr-done">OCR otomatis selesai &mdash; komponen yang cocok sudah ditandai.</span>`;
    else if(queued) statusLine = `<span class="ocr-queued">Menunggu giliran OCR otomatis &mdash; ${entry.ocr.processedPages.length}/${scanPages.length} halaman sudah dibaca.</span>`;
    else statusLine = `<span>${scanPages.length} halaman scan ditemukan; OCR otomatis akan membacanya.</span>`;
    const buttonText=entry.ocr.running?"Membaca...":(entry.ocr.done?"Selesai":(queued?"Prioritaskan OCR":"Jalankan OCR sekarang"));
    ocrHtml = `
    <div class="ocr-box" style="grid-column:1/-1;">
      <div class="ocr-row">
        ${statusLine}
        <button class="ocr-btn" ${entry.ocr.running||entry.ocr.done ? "disabled":""}>${buttonText}</button>
      </div>
      <div class="ocr-note">OCR berjalan satu berkas pada satu waktu dan menyimpan progres bertahap. Tulisan tangan atau hasil yang tidak terbaca tetap perlu ditinjau.</div>
    </div>`;
  }

  wrap.innerHTML = `
    <div class="viewer-pane">${entry.open ? buildViewerPaneInnerHtml(entry) : buildViewerPaneCollapsedHtml(entry, "Klik baris untuk membuka pratinjau")}</div>
    <div class="check-pane"></div>
    ${ocrHtml}
  `;

  const ocrBtn = wrap.querySelector(".ocr-btn");
  if(ocrBtn){
    ocrBtn.addEventListener("click", (e)=>{
      e.stopPropagation();
      enqueueAutoOcr(entry,{force:true,front:true,renderFn:renderBatches,evalFn:(en)=>evaluateAgainstCat(en,cat),persistActive:false});
      renderBatches();
    });
  }

  if(!entry.pending && !entry.error){
    const cl = wrap.querySelector(".check-pane");
    cat.items.forEach(item=>{
      const s = entry.itemsStatus[item.id];
      if(!s) return;
      const row = document.createElement("div");
      row.className = "check-item";
      const naOn = item.conditional && s.na;

      let detectionHtml;
      if(naOn){
        detectionHtml = `<span class="na-badge">Tidak berlaku</span>`;
      }else if(s.source==="digital"){
        detectionHtml = `<span class="stamp">Terdeteksi</span>`;
      }else if(s.source==="ocr"){
        detectionHtml = `
          <label class="manual-toggle ocr-flag ${s.manual?'checked':''}">
            <input type="checkbox" class="detect-check" ${s.manual?"checked":""}> ${s.manual?"Terdeteksi otomatis (OCR)":"Temuan OCR dibatalkan"}
          </label>`;
      }else{
        detectionHtml = `
          <label class="manual-toggle ${s.manual?'checked':''}">
            <input type="checkbox" class="detect-check" ${s.manual?"checked":""}> Tandai ada (cek manual)
          </label>`;
      }
      const naToggleHtml = item.conditional ? `
        <label class="na-toggle">
          <input type="checkbox" class="na-check" ${s.na?"checked":""}> Tidak berlaku (N/A)
        </label>` : "";
      const contentWarnHtml = (!naOn && s.contentWarning) ? contentWarnBadgeHtml(s.contentWarning) : "";

      row.innerHTML = `
        <div class="item-name">${escapeAttr(item.name)}${item.conditional?'<span class="cond-tag">Kondisional</span>':''}
          <span class="item-kw">${escapeAttr(item.keywords.join(", "))||"(tanpa kata kunci)"}</span>
        </div>
        <div class="item-controls">${naToggleHtml}${contentWarnHtml}${detectionHtml}</div>
      `;
      const detectInput = row.querySelector(".detect-check");
      if(detectInput){
        detectInput.addEventListener("change", e=>{
          entry.itemsStatus[item.id].manual = e.target.checked;
          entry.itemsStatus[item.id].userTouched = true;
          entry.open = true;
          onChange();
        });
      }
      const naInput = row.querySelector(".na-check");
      if(naInput){
        naInput.addEventListener("change", e=>{
          entry.itemsStatus[item.id].na = e.target.checked;
          entry.open = true;
          onChange();
        });
      }
      cl.appendChild(row);
    });
  }
  if(entry.open){
    mountPdfViewer(wrap.querySelector(".viewer-pane"), entry);
  }
  return wrap;
}

/* ---------------- Export batch kolektif CSV (zip) ---------------- */
document.getElementById("exportBatchBtn").addEventListener("click", async ()=>{
  const activeBatches = batches.filter(b=>b.roster.length>0);
  if(activeBatches.length===0){ alert("Belum ada layanan dengan daftar pasien."); return; }
  let ZipClass;
  try{ ZipClass=await ensureZipEngine(); }
  catch(err){ alert(err.message||"Mesin ekspor ZIP tidak tersedia."); return; }
  const zip = new ZipClass();
  activeBatches.forEach(batch=>{
    const cat = kolektifCategories[batch.service];
    const rows = [["No","Nama Pasien","No Kunjungan","Tanggal","Tindakan","Hasil","Tenaga Medis","Biaya","Status Berkas","Jenis Dokumen","Status Item","Sumber"]];
    batch.roster.forEach((row, idx)=>{
      const pf = batch.patientFiles.find(p=>p.rosterIndex===idx);
      const fileStatus = !pf ? "Belum ada berkas" : (pf.pending ? "Memproses" : (pf.error ? pf.error : (fileMissingItems(pf, cat).length===0 ? "Lengkap" : `Kurang ${fileMissingItems(pf, cat).length} dokumen`)));
      if(!pf || pf.pending || pf.error){
        rows.push([idx+1, row.name, row.noKunjungan, row.tanggal, row.tindakan, row.hasil, row.tenagaMedis, row.biaya, fileStatus, "-", "-", "-"]);
      }else{
        cat.items.forEach(item=>{
          const s = pf.itemsStatus[item.id];
          rows.push([idx+1, row.name, row.noKunjungan, row.tanggal, row.tindakan, row.hasil, row.tenagaMedis, row.biaya, fileStatus, item.name, itemStatusLabel(item,s), itemSourceLabel(item,s)]);
        });
      }
    });
    const csv = rows.map(r=>r.map(csvSafeCell).join(",")).join("\r\n");
    const safeLabel = batch.label.replace(/[^a-z0-9]+/gi,"-").replace(/^-+|-+$/g,"") || batch.service;
    zip.file(`kolektif-${safeLabel}.csv`, "\uFEFF"+csv);
  });
  const blob = await zip.generateAsync({type:"blob"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "ringkasan-verifikasi-kolektif-puskesmas.zip";
  a.click();
  URL.revokeObjectURL(url);
});

/* ---------------- Ekstraksi resep / obat ---------------- */
function medicineKnownFingerprints(){
  return new Set(medicineFiles.map(entry=>entry.fingerprint).filter(Boolean));
}

function medicineBusy(){
  return medicineQueuedTasks>0||medicineExporting||medicineFiles.some(entry=>entry._medicineProcessing);
}

function queueMedicineTask(task){
  medicineQueuedTasks++;
  renderMedicineTable();
  medicineImportQueue=medicineImportQueue.catch(()=>{}).then(task).catch(err=>{
    updateSaveIndicator(false,err);
    document.getElementById("medicineProgressLine").textContent=`Proses Obat terhenti: ${err.message||err}. Hasil sebelumnya tetap disimpan.`;
  }).finally(()=>{medicineQueuedTasks--;renderMedicineTable();});
  return medicineImportQueue;
}

function queueMedicineUpload(selected){
  if(!selected.length)return;
  medicineUploadPending++;
  let acknowledged=false;
  const uploaded=()=>{if(!acknowledged){acknowledged=true;medicineUploadPending--;}};
  queueMedicineTask(async()=>{
    try{await processMedicineFiles(selected,uploaded);}
    finally{uploaded();}
  });
}

function medicineNeedsReview(entry){
  if(entry.pending||entry.error||entry.reviewNote||!String(entry.participantName||"").trim()||!String(entry.sep||"").trim()) return true;
  if(!(entry.drugs||[]).length) return true;
  return entry.drugs.some(drug=>!String(drug.name||"").trim()||!String(drug.quantity||"").trim()||!String(drug.dose||"").trim());
}

async function flushDirtyMedicineRecords(){
  clearTimeout(medicineSaveTimer);
  if(!dirtyMedicineIds.size) return;
  const ids=Array.from(dirtyMedicineIds);
  dirtyMedicineIds.clear();
  const byId=new Map(medicineFiles.map(entry=>[entry.id,entry]));
  const rows=ids.map(id=>byId.get(id)).filter(Boolean);
  try{
    for(let i=0;i<rows.length;i+=200) await dbSaveMedicineRecords(rows.slice(i,i+200));
  }catch(err){ rows.forEach(entry=>dirtyMedicineIds.add(entry.id)); throw err; }
}

function markMedicineDirty(entry){
  if(entry&&entry.id) dirtyMedicineIds.add(entry.id);
  clearTimeout(medicineSaveTimer);
  medicineSaveTimer=setTimeout(()=>flushDirtyMedicineRecords().catch(err=>updateSaveIndicator(false,err)),700);
  scheduleSave(900);
}

async function getMedicineBlob(entry){
  if(entry.blob) return entry.blob;
  let blob=null;
  if(entry.blobStored) blob=await dbGet(DB_BLOB_STORE,entry.id);
  if(!blob&&entry.externalStored&&workspaceDirHandle){
    blob=await readWorkspaceBlob(entry.externalPdfFolder||"medicine-pdfs",entry.externalFileName||`${workspaceFileName(entry.id)}.pdf`);
  }
  if(!blob) throw new Error("PDF sumber Obat tidak ditemukan. Unggah ulang berkas ini.");
  entry.blob=blob;
  return blob;
}

function cleanMedicineLine(value){
  return String(value||"").replace(/\s+/g," ").trim();
}

function extractSepNumber(text){
  // Format SEP: 4 digit + huruf jenis faskes (umumnya R) + 7 digit + V + 6 digit, mis. 1704R0021126V004500.
  // Spasi di tengah nomor (akibat pemotongan teks PDF/OCR) tetap dikenali.
  const t=String(text||"");
  const pattern=/(?:^|[^0-9a-z])((?:\d\s?){4}[a-z]\s?(?:\d\s?){7}v\s?(?:\d\s?){5}\d)(?![0-9])/gi;
  let match;
  while((match=pattern.exec(t))){
    const sep=match[1].replace(/\s+/g,"").toUpperCase();
    if(/^\d{4}[A-Z]\d{7}V\d{6}$/.test(sep)) return sep;
  }
  return "";
}

function parseMedicineBody(rawBody){
  let body=cleanMedicineLine(rawBody).replace(/^[:\-\s]+/,"");
  const quantityMatch=body.match(/(\d+(?:[.,]\d+)?)\s*(tablet|tab(?:let)?|kaplet|kapsul|kaps?|botol|vial|ampul|tube|tub|sachet|strip|pcs|buah|ml|gram|gr|tetes|supp|unit)\s*$/i);
  let quantity="";
  if(quantityMatch){
    quantity=`${quantityMatch[1]} ${quantityMatch[2]}`;
    body=body.slice(0,quantityMatch.index).trim();
  }
  body=body.replace(/\s*\/\s*(?:APBD|HJ|BPJS(?:\s+NON\s+PBI)?|JKN|UMUM)\s*$/i,"").trim();
  return {name:body,quantity};
}

function parseMedicineDocument(lines,extraText){
  const cleanLines=(lines||[]).map(cleanMedicineLine).filter(Boolean);
  const joined=cleanLines.join("\n")+"\n"+String(extraText||"");
  let participantName="";
  for(const line of cleanLines){
    const match=line.match(/^nama\s*(?:pasien|peserta)\s*:?[\s-]*(.+)$/i);
    if(match){
      participantName=cleanMedicineLine(match[1].replace(/\d{4}\s*R\s*\d{3}\s*\d{4}\s*V\s*\d{6}.*/i,""));
      break;
    }
  }
  const sep=extractSepNumber(joined);
  const drugs=[];
  let current=null;
  function flushCurrent(){
    if(!current) return;
    const parsed=parseMedicineBody(current.parts.join(" "));
    if(parsed.name||parsed.quantity||current.dose){
      drugs.push({id:"",name:parsed.name,quantity:parsed.quantity,dose:cleanMedicineLine(current.dose)});
    }
    current=null;
  }
  for(const line of cleanLines){
    const recipe=line.match(/^R\s*\/\s*(.*)$/i);
    if(recipe){ flushCurrent();current={parts:[recipe[1]],dose:""};continue; }
    if(!current) continue;
    if(/^(?:S|Signa)(?:\s|:|\-|$)/i.test(line)){
      current.dose=cleanMedicineLine(line.replace(/^(?:S|Signa)\s*[:\-]*\s*/i,"").replace(/^-+\s*/,""));
      flushCurrent();
      continue;
    }
    if(!/^(?:RESEP|Nama\s|No\.|Jenis\s|Pemberi\s|Rumah\s|Jl\.|E-mail|Sumbawa\s)/i.test(line)) current.parts.push(line);
  }
  flushCurrent();
  return {participantName,sep,drugs};
}

async function extractMedicinePageData(page){
  const content=await page.getTextContent();
  const viewport=page.getViewport({scale:1});
  const rows=[];
  for(const item of content.items||[]){
    const str=cleanMedicineLine(item.str);
    if(!str) continue;
    let transformed;
    try{ transformed=window.pdfjsLib.Util.transform(viewport.transform,item.transform); }
    catch(err){ transformed=item.transform||[1,0,0,1,0,0]; }
    const x=Number(transformed[4])||0,y=Number(transformed[5])||0;
    let row=rows.find(candidate=>Math.abs(candidate.y-y)<=2.5);
    if(!row){ row={y,items:[]};rows.push(row); }
    row.items.push({x,str});
  }
  rows.sort((a,b)=>a.y-b.y);
  const lines=rows.map(row=>{
    row.items.sort((a,b)=>a.x-b.x);
    return cleanMedicineLine(row.items.map(item=>item.str).join(" "));
  }).filter(Boolean);
  const annotationText=[];
  try{
    const annotations=await page.getAnnotations({intent:"display"});
    (annotations||[]).forEach(annotation=>{
      const values=[annotation.contentsObj&&annotation.contentsObj.str,annotation.contents,annotation.fieldValue]
        .concat(Array.isArray(annotation.textContent)?annotation.textContent:[]);
      values.filter(Boolean).forEach(value=>annotationText.push(String(value)));
    });
  }catch(err){ console.warn("Anotasi PDF resep tidak dapat dibaca:",err); }
  return {lines,annotationText};
}

async function ocrMedicinePage(page){
  const baseViewport=page.getViewport({scale:1});
  const scale=boundedCanvasScale(baseViewport.width,baseViewport.height,2.1,3200,8*1024*1024);
  const viewport=page.getViewport({scale});
  const canvas=document.createElement("canvas");
  canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  const context=canvas.getContext("2d",{alpha:false});
  context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);
  try{
    await page.render({canvasContext:context,viewport}).promise;
    const result=await recognizeCanvasWithTesseract(canvas);
    return String(result&&result.data&&result.data.text||"");
  }finally{
    try{ page.cleanup(); }catch(e){}
    canvas.width=1;canvas.height=1;
  }
}

async function processMedicineEntry(entry){
  if(entry._medicineProcessing) return;
  entry._medicineProcessing=true;
  let pdfDoc=null;
  entry.pending=true;entry.error=null;entry.reviewNote="";
  markMedicineDirty(entry);
  renderMedicineTable();
  try{
    const blob=await getMedicineBlob(entry);
    pdfDoc=await openPdfDocument(blob,entry.name,120000);
    const allLines=[];
    const annotationText=[];
    const pages=[];
    for(let pageNumber=1;pageNumber<=pdfDoc.numPages;pageNumber++){
      const page=await pdfDoc.getPage(pageNumber);
      const extracted=await extractMedicinePageData(page);
      const pageDrugs=parseMedicineDocument(extracted.lines,"").drugs;
      pages.push({pageNumber,drugs:pageDrugs,hasDrugs:pageDrugs.length>0,scanCandidate:extracted.lines.join("").length<40});
      allLines.push(...extracted.lines);
      annotationText.push(...extracted.annotationText);
      try{page.cleanup();}catch(e){}
      if(pageNumber%10===0) await yieldToBrowser();
    }
    const digital=parseMedicineDocument(allLines,annotationText.join("\n"));
    let participantName=digital.participantName;
    let sep=digital.sep;
    let drugs=pages.flatMap(page=>page.drugs);
    let usedOcr=false;
    let ocrError="";
    if(!participantName||!sep||drugs.length===0||pages.some(page=>page.scanCandidate)){
      usedOcr=true;
      const pagesToRead=pages.filter((page,index)=>!drugs.length||page.scanCandidate||((!participantName||!sep)&&index===0));
      for(let index=0;index<pagesToRead.length;index++){
        document.getElementById("medicineProgressLine").textContent=`OCR ${entry.name}: halaman ${index+1} dari ${pagesToRead.length}…`;
        try{
          const page=await pdfDoc.getPage(pagesToRead[index].pageNumber);
          const ocrText=await ocrMedicinePage(page);
          const ocrParsed=parseMedicineDocument(ocrText.split(/\r?\n/),ocrText);
          participantName=participantName||ocrParsed.participantName;
          sep=sep||ocrParsed.sep;
          if(!pagesToRead[index].hasDrugs) pagesToRead[index].drugs=ocrParsed.drugs;
        }catch(err){
          ocrError=`OCR belum selesai: ${err.message||err}`;
          break;
        }
        await yieldToBrowser();
      }
    }
    drugs=pages.flatMap(page=>page.drugs);
    entry.participantName=participantName||"";
    entry.sep=sep||"";
    entry.drugs=(drugs.length?drugs:[{name:"",quantity:"",dose:""}]).map((drug,index)=>({
      id:drug.id||`${entry.id}_d${index}`,name:drug.name||"",quantity:drug.quantity||"",dose:drug.dose||""
    }));
    entry.source=usedOcr?"Teks/anotasi + OCR":"Teks + anotasi PDF";
    entry.reviewNote=usedOcr?"Periksa kembali hasil OCR dengan PDF asli; nama, jumlah dan dosis tidak ditebak atau dikoreksi otomatis.":"";
    entry.pending=false;
    if(ocrError){
      entry.error=ocrError;
      await dbSaveMedicineRecords([entry]);
      return;
    }
    const hadExternalSource=entry.externalStored;
    entry.externalStored=false;
    try{ await dbFinalizeMedicineEntry(entry); }
    catch(err){ entry.externalStored=hadExternalSource;throw err; }
    if(hadExternalSource) workspaceDeletedMedicineIds.add(entry.id);
    workspaceSyncedPdfIds.delete(`medicine:${entry.id}`);
    if(workspaceDirHandle) scheduleWorkspaceBackup(300);
  }catch(err){
    entry.pending=false;
    entry.error=err&&err.message?err.message:"PDF resep gagal dibaca.";
    if(!(entry.drugs||[]).length) entry.drugs=[{id:`${entry.id}_d0`,name:"",quantity:"",dose:""}];
    await dbSaveMedicineRecords([entry]).catch(saveErr=>updateSaveIndicator(false,saveErr));
  }finally{
    await destroyPdfDocument(pdfDoc);
    entry.blob=null;
    entry._medicineProcessing=false;
    renderMedicineTable();
  }
}

function medicineRowCount(){
  return medicineFiles.reduce((count,entry)=>count+Math.max(1,(entry.drugs||[]).length),0);
}

function medicineRowsForPage(page){
  const start=(page-1)*MEDICINE_PAGE_SIZE,end=start+MEDICINE_PAGE_SIZE;
  const visible=[];
  let cursor=0;
  const ordered=medicineFiles.slice().sort((a,b)=>(a.order||0)-(b.order||0));
  for(const entry of ordered){
    const drugs=(entry.drugs&&entry.drugs.length)?entry.drugs:[{id:`${entry.id}_d0`,name:"",quantity:"",dose:""}];
    for(let drugIndex=0;drugIndex<drugs.length;drugIndex++){
      if(cursor>=start&&cursor<end) visible.push({entry,drug:drugs[drugIndex],drugIndex});
      cursor++;
      if(cursor>=end) return visible;
    }
  }
  return visible;
}

function renderMedicineTable(){
  const body=document.getElementById("medicineTableBody");
  if(!body) return;
  const totalRows=medicineRowCount();
  const totalPages=Math.max(1,Math.ceil(totalRows/MEDICINE_PAGE_SIZE));
  medicinePage=Math.min(totalPages,Math.max(1,medicinePage));
  const visible=medicineRowsForPage(medicinePage);
  const busy=medicineBusy();
  const disabled=busy?" disabled":"";
  body.innerHTML=visible.map(({entry,drug,drugIndex})=>{
    const review=medicineNeedsReview(entry);
    const status=entry.pending?"Memproses…":(entry.error?"Gagal dibaca - koreksi atau coba ulang":(review?"Perlu diperiksa":"Siap diekspor"));
    return `<tr class="${review?"needs-review":""}" data-file-id="${escapeAttr(entry.id)}" data-drug-id="${escapeAttr(drug.id)}">
      <td><input class="medicine-input" data-field="participantName" value="${escapeAttr(entry.participantName)}"${disabled}><span class="medicine-status ${review?"":"ok"}">${escapeAttr(status)}</span></td>
      <td><input class="medicine-input med-sep" data-field="sep" value="${escapeAttr(entry.sep)}"${disabled}></td>
      <td><input class="medicine-input med-name" data-field="name" value="${escapeAttr(drug.name)}"${disabled}></td>
      <td><input class="medicine-input" data-field="quantity" value="${escapeAttr(drug.quantity)}"${disabled}></td>
      <td><input class="medicine-input" data-field="dose" value="${escapeAttr(drug.dose)}"${disabled}></td>
      <td><div class="medicine-file-name" title="${escapeAttr(entry.name)}">${escapeAttr(entry.name)}</div><span class="medicine-status">${escapeAttr(entry.source||"")}</span><span class="medicine-status">${escapeAttr(entry.error||entry.reviewNote||"")}</span>${entry.error?`<button class="mini-action-btn medicine-retry" type="button"${disabled}>Coba baca ulang</button>`:""}${entry.reviewNote&&!entry.error?`<button class="mini-action-btn medicine-reviewed" type="button"${disabled}>Sudah diperiksa</button>`:""}</td>
      <td><div class="medicine-row-actions"><button class="mini-action-btn medicine-add" type="button" title="Tambah baris obat"${disabled}>+</button><button class="mini-action-btn danger medicine-delete-drug" type="button" title="Hapus baris obat"${disabled}>−</button><button class="mini-action-btn danger medicine-delete-file" type="button" title="Hapus seluruh hasil file"${disabled}>Hapus file</button></div></td>
    </tr>`;
  }).join("");
  document.getElementById("medicineEmptyNote").style.display=medicineFiles.length?"none":"";
  document.getElementById("medicineTableWrap").style.display=medicineFiles.length?"":"none";
  const completed=medicineFiles.filter(entry=>!entry.pending).length;
  const reviewCount=medicineFiles.filter(medicineNeedsReview).length;
  document.getElementById("medicineSummary").textContent=medicineFiles.length ? `${medicineFiles.length} file • ${totalRows} baris obat • ${completed} selesai • ${reviewCount} perlu diperiksa` : "Belum ada hasil obat.";
  ["medicineClearBtn","medicineCsvBtn","medicineExcelBtn"].forEach(id=>{document.getElementById(id).disabled=busy||!medicineFiles.length;});
  renderPagination(document.getElementById("medicinePagination"),medicinePage,totalPages,next=>{
    keepAnchorPosition("medicinePagination",()=>{ medicinePage=next;renderMedicineTable();scheduleSave(100); });
  },`${totalRows} baris obat`);
}

async function deleteMedicineFile(entry){
  await dbDeleteMedicineEntries([entry.id]);
  medicineFiles=medicineFiles.filter(item=>item.id!==entry.id);
  dirtyMedicineIds.delete(entry.id);
  if(entry.externalStored) workspaceDeletedMedicineIds.add(entry.id);
  workspaceSyncedPdfIds.delete(`medicine:${entry.id}`);
  renderMedicineTable();
  await persistState();
  if(workspaceDirHandle) scheduleWorkspaceBackup(100);
}

async function preflightMedicineFiles(files,externalFolderReady){
  const totalBytes=files.reduce((sum,file)=>sum+(Number(file.size)||0),0);
  if(navigator.storage&&navigator.storage.estimate){
    try{
      const estimate=await navigator.storage.estimate();
      const remaining=Math.max(0,(estimate.quota||0)-(estimate.usage||0));
      const required=(externalFolderReady?0:totalBytes)*1.25+10*1024*1024;
      if(estimate.quota&&required>remaining){
        alert(`Ruang penyimpanan browser tidak cukup untuk menyimpan antrean PDF Obat (${formatBytes(totalBytes)}). Hubungkan Folder Cadangan atau unggah dalam kelompok lebih kecil.`);
        return false;
      }
    }catch(err){ console.warn("Kapasitas penyimpanan Obat tidak dapat diperkirakan:",err); }
  }
  if(files.length>2000&&!externalFolderReady){
    return confirm(`${files.length} PDF akan diproses satu per satu dan hasil yang selesai langsung disimpan. Agar sesi lebih aman bila laptop tertutup, disarankan menghubungkan Folder Cadangan. Tetap lanjutkan tanpa folder?`);
  }
  return true;
}

async function processMedicineFiles(fileList,onStaged=()=>{}){
  const incoming=Array.from(fileList||[]).filter(file=>file.type==="application/pdf"||file.name.toLowerCase().endsWith(".pdf"));
  if(!incoming.length) return;
  try{ await ensurePdfEngine(); }
  catch(err){ alert(err.message||"Mesin pembaca PDF tidak tersedia.");return; }
  const useWorkspaceStorage=!!workspaceDirHandle&&await ensureWorkspacePermission(workspaceDirHandle,false);
  if(!(await preflightMedicineFiles(incoming,useWorkspaceStorage))) return;
  const known=medicineKnownFingerprints();
  let skipped=0,processed=0,stagingError="";
  const staged=[];
  const medicinePdfDir=useWorkspaceStorage?await getWorkspaceDirectory("medicine-pdfs",true):null;
  const progress=document.getElementById("medicineProgressLine");
  for(const file of incoming){
    const fingerprint=fileFingerprint(file);
    if(known.has(fingerprint)){ skipped++;continue; }
    known.add(fingerprint);
    const entry={
      id:`med${medicineCounter++}`,name:file.name,order:medicineCounter,size:file.size||0,lastModified:file.lastModified||0,
      fingerprint,pending:true,error:null,participantName:"",sep:"",drugs:[],source:"",createdAt:Date.now(),
      blob:file,blobStored:false,externalStored:false,externalPdfFolder:"medicine-pdfs",externalFileName:""
    };
    progress.textContent=`Menyimpan antrean resep ${staged.length+1} dari ${incoming.length-skipped}: ${file.name}. Jangan tutup aplikasi sampai penyalinan selesai.`;
    try{
      if(useWorkspaceStorage){
        entry.externalFileName=`${workspaceFileName(entry.id)}.pdf`;
        await writeWorkspaceFile(medicinePdfDir,entry.externalFileName,file);
        entry.externalStored=true;
        await dbSaveMedicineRecords([entry]);
        workspaceSyncedPdfIds.add(`medicine:${entry.id}`);
      }else{
        await dbStageMedicineEntry(entry);
      }
      entry.blob=null;
      medicineFiles.push(entry);staged.push(entry);
      if(staged.length%25===0){renderMedicineTable();await persistState();}
    }catch(err){
      entry.blob=null;
      stagingError=`Unggahan berhenti pada ${file.name}: ${err.message||err}. ${staged.length} PDF sebelumnya sudah tersimpan; berkas setelahnya belum diunggah.`;
      break;
    }
    await yieldToBrowser();
  }
  onStaged();
  await persistState();
  if(workspaceDirHandle) await saveWorkspaceBackup(true);
  for(const entry of staged){
    progress.textContent=`Membaca resep ${processed+1} dari ${staged.length}: ${entry.name}. Antrean unggahan sudah tersimpan.`;
    await processMedicineEntry(entry);
    processed++;await yieldToBrowser();
  }
  await persistState();
  if(workspaceDirHandle) await saveWorkspaceBackup(true);
  if(stagingError)throw new Error(stagingError);
  progress.textContent=`Selesai: ${processed} file resep diproses${skipped?` • ${skipped} duplikat dilewati`:""}.`;
  setTimeout(()=>{ if(progress.textContent.startsWith("Selesai:")) progress.textContent=""; },6000);
}

async function resumeInterruptedMedicineFiles(){
  const pending=medicineFiles.filter(entry=>entry.pending);
  if(pending.some(entry=>entry.externalStored&&!entry.blobStored)&&(!workspaceDirHandle||!await ensureWorkspacePermission(workspaceDirHandle,false))){
    document.getElementById("medicineProgressLine").textContent="Ada resep tertunda di folder cadangan. Klik Hubungkan Folder Cadangan untuk mengizinkan akses dan melanjutkan.";
    return;
  }
  for(let index=0;index<pending.length;index++){
    document.getElementById("medicineProgressLine").textContent=`Melanjutkan resep tertunda ${index+1} dari ${pending.length}…`;
    await processMedicineEntry(pending[index]);
    await yieldToBrowser();
  }
  if(pending.length) await persistState();
}

function medicineExportRows(){
  return medicineFiles.slice().sort((a,b)=>(a.order||0)-(b.order||0)).flatMap(entry=>{
    const drugs=(entry.drugs&&entry.drugs.length)?entry.drugs:[{name:"",quantity:"",dose:""}];
    return drugs.map(drug=>({
      "Nama Peserta":entry.participantName||"","Nomor SEP":entry.sep||"","Nama Obat":drug.name||"",
      "Jumlah Obat":drug.quantity||"","Dosis":drug.dose||""
    }));
  });
}

function canExportMedicine(){
  if(medicineBusy()){alert("Tunggu proses Obat selesai sebelum ekspor.");return false;}
  if(!medicineFiles.length){alert("Belum ada data Obat untuk diekspor.");return false;}
  if(medicineFiles.some(entry=>entry.pending)){alert("Masih ada PDF Obat tertunda. Selesaikan pembacaan atau hapus baris tersebut sebelum ekspor.");return false;}
  const review=medicineFiles.filter(medicineNeedsReview).length;
  return !review||confirm(`${review} file masih ditandai perlu diperiksa. Ekspor tetap menyertakan data yang terbaca dan membiarkan kolom yang belum terbaca kosong. Lanjutkan?`);
}

function medicineCsvCell(value){
  let text=String(value==null?"":value);
  // Formula spreadsheet tidak boleh dieksekusi dari teks resep atau input pengguna.
  if(/^[\s]*[=+@-]/.test(text)) text="'"+text;
  return `"${text.replace(/"/g,'""')}"`;
}

function saveMedicineDownload(blob,filename){
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}

function downloadMedicineCsv(){
  if(!canExportMedicine())return;
  const rows=medicineExportRows();
  const headers=["Nama Peserta","Nomor SEP","Nama Obat","Jumlah Obat","Dosis"];
  const csv=[headers,...rows.map(row=>headers.map(header=>row[header]))]
    .map(row=>row.map(medicineCsvCell).join(",")).join("\r\n");
  const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
  saveMedicineDownload(blob,"hasil-pemeriksaan-obat.csv");
}

function medicineXml(value){
  return String(value==null?"":value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

async function buildMedicineWorkbook(rows,ZipEngine){
  const zip=new ZipEngine();
  const ns="http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const headers=["Nama Peserta","Nomor SEP","Nama Obat","Jumlah Obat","Dosis"];
  const parts=[`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}"><dimension ref="A1:E${rows.length+1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="24" customWidth="1"/><col min="3" max="3" width="45" customWidth="1"/><col min="4" max="5" width="18" customWidth="1"/></cols><sheetData>`];
  for(let index=0;index<=rows.length;index++){
    const values=index===0?headers:headers.map(header=>rows[index-1][header]);
    const cells=values.map((value,column)=>`<c r="${String.fromCharCode(65+column)}${index+1}" t="inlineStr"${index===0?' s="1"':""}><is><t xml:space="preserve">${medicineXml(value)}</t></is></c>`).join("");
    parts.push(`<row r="${index+1}">${cells}</row>`);
    if(index%1000===0)await yieldToBrowser();
  }
  parts.push(`</sheetData><autoFilter ref="A1:E${rows.length+1}"/></worksheet>`);
  zip.file("xl/worksheets/sheet1.xml",parts.join(""));
  zip.file("[Content_Types].xml",`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  zip.file("_rels/.rels",`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml",`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Obat" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels",`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("xl/styles.xml",`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return zip.generateAsync({type:"blob",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",compression:"DEFLATE",compressionOptions:{level:1}});
}

async function downloadMedicineExcel(){
  if(!canExportMedicine())return;
  if(medicineRowCount()>1048575){alert("Jumlah baris melebihi batas satu lembar Excel. Gunakan CSV.");return;}
  if(medicineRowCount()>50000&&!confirm("Ekspor Excel besar membutuhkan tambahan RAM. CSV lebih ringan. Tetap buat Excel?"))return;
  medicineExporting=true;renderMedicineTable();
  try{
    const ZipEngine=await ensureZipEngine();
    const blob=await buildMedicineWorkbook(medicineExportRows(),ZipEngine);
    saveMedicineDownload(blob,"hasil-pemeriksaan-obat.xlsx");
  }catch(err){alert((err.message||"Ekspor Excel gagal.")+" Data tidak dihapus. Gunakan CSV atau coba lagi.");}
  finally{medicineExporting=false;renderMedicineTable();}
}

const medicineDropZone=document.getElementById("medicineDropZone");
const medicineFileInput=document.getElementById("medicineFileInput");
medicineDropZone.addEventListener("click",()=>medicineFileInput.click());
medicineFileInput.addEventListener("click",event=>event.stopPropagation());
medicineFileInput.addEventListener("change",event=>{
  const selected=Array.from(event.target.files||[]);event.target.value="";
  queueMedicineUpload(selected);
});
["dragenter","dragover"].forEach(name=>medicineDropZone.addEventListener(name,event=>{event.preventDefault();medicineDropZone.classList.add("drag");}));
["dragleave","drop"].forEach(name=>medicineDropZone.addEventListener(name,event=>{event.preventDefault();medicineDropZone.classList.remove("drag");}));
medicineDropZone.addEventListener("drop",event=>{
  const selected=Array.from(event.dataTransfer.files||[]);
  queueMedicineUpload(selected);
});
document.getElementById("medicineTableBody").addEventListener("input",event=>{
  if(medicineBusy())return;
  const input=event.target.closest("input[data-field]");if(!input)return;
  const row=input.closest("tr"),entry=medicineFiles.find(item=>item.id===row.dataset.fileId);if(!entry)return;
  const field=input.dataset.field;
  if(field==="participantName"||field==="sep") entry[field]=input.value;
  else{
    const drug=entry.drugs.find(item=>item.id===row.dataset.drugId);
    if(drug) drug[field]=input.value;
  }
  markMedicineDirty(entry);
});
document.getElementById("medicineTableBody").addEventListener("change",event=>{
  if(!event.target.matches("input[data-field]"))return;
  // Jangan mengganti seluruh DOM pada blur: klik ke kolom/tombol berikutnya harus tetap diterima.
  const byId=new Map(medicineFiles.map(entry=>[entry.id,entry]));
  document.querySelectorAll("#medicineTableBody tr").forEach(row=>{
    const entry=byId.get(row.dataset.fileId);if(!entry)return;
    ["participantName","sep"].forEach(field=>{
      const input=row.querySelector(`input[data-field="${field}"]`);
      if(input&&input!==document.activeElement)input.value=entry[field]||"";
    });
    const review=medicineNeedsReview(entry),status=row.querySelector(".medicine-status");
    row.classList.toggle("needs-review",review);
    if(status){status.classList.toggle("ok",!review);status.textContent=entry.error?"Gagal dibaca - koreksi atau coba ulang":review?"Perlu diperiksa":"Siap diekspor";}
  });
  const completed=medicineFiles.filter(entry=>!entry.pending).length,review=medicineFiles.filter(medicineNeedsReview).length;
  document.getElementById("medicineSummary").textContent=`${medicineFiles.length} file • ${medicineRowCount()} baris obat • ${completed} selesai • ${review} perlu diperiksa`;
});
document.getElementById("medicineTableBody").addEventListener("click",async event=>{
  if(medicineBusy())return;
  const row=event.target.closest("tr");if(!row)return;
  const entry=medicineFiles.find(item=>item.id===row.dataset.fileId);if(!entry)return;
  if(event.target.closest(".medicine-add")){
    entry.drugs.push({id:`${entry.id}_d${Date.now()}`,name:"",quantity:"",dose:""});markMedicineDirty(entry);renderMedicineTable();
  }else if(event.target.closest(".medicine-delete-drug")){
    entry.drugs=entry.drugs.filter(item=>item.id!==row.dataset.drugId);
    if(!entry.drugs.length) entry.drugs=[{id:`${entry.id}_d${Date.now()}`,name:"",quantity:"",dose:""}];
    markMedicineDirty(entry);renderMedicineTable();
  }else if(event.target.closest(".medicine-delete-file")){
    if(confirm(`Hapus seluruh hasil dari ${entry.name}?`))queueMedicineTask(()=>deleteMedicineFile(entry));
  }else if(event.target.closest(".medicine-retry")){
    queueMedicineTask(()=>processMedicineEntry(entry));
  }else if(event.target.closest(".medicine-reviewed")){
    entry.reviewNote="";markMedicineDirty(entry);renderMedicineTable();
  }
});
document.getElementById("medicineClearBtn").addEventListener("click",async()=>{
  if(medicineBusy())return;
  if(!medicineFiles.length)return;
  if(!confirm("Hapus seluruh hasil pada menu Obat? Data pada menu lain tidak akan terpengaruh."))return;
  queueMedicineTask(async()=>{
    const removed=medicineFiles.slice(),ids=removed.map(entry=>entry.id);
    await dbDeleteMedicineEntries(ids);
    removed.forEach(entry=>{if(entry.externalStored)workspaceDeletedMedicineIds.add(entry.id);workspaceSyncedPdfIds.delete(`medicine:${entry.id}`);});
    medicineFiles=[];dirtyMedicineIds.clear();medicinePage=1;renderMedicineTable();await persistState();
    if(workspaceDirHandle)await saveWorkspaceBackup(true);
  });
});
document.getElementById("medicineCsvBtn").addEventListener("click",downloadMedicineCsv);
document.getElementById("medicineExcelBtn").addEventListener("click",downloadMedicineExcel);

async function initApp(){
  const snapshot = await loadSnapshot();
  if(snapshot){
    if(snapshot.categories) categories = snapshot.categories;
    if(snapshot.kolektifCategories) kolektifCategories = snapshot.kolektifCategories;
    if(snapshot.currentEditorCat && categories[snapshot.currentEditorCat]) currentEditorCat = snapshot.currentEditorCat;
    if(typeof snapshot.fileCounter === "number") fileCounter = snapshot.fileCounter;
    if(typeof snapshot.batchCounter === "number") batchCounter = snapshot.batchCounter;
    if(typeof snapshot.medicineCounter === "number") medicineCounter = snapshot.medicineCounter;
    if(typeof snapshot.medicinePage === "number") medicinePage = Math.max(1,snapshot.medicinePage);
    batches = (snapshot.batches||[]).map(b=>({
      id:b.id, service:b.service, label:b.label, rosterText:b.rosterText||"", roster:b.roster||[],
      open:!!b.open, checklistEditorOpen:!!b.checklistEditorOpen,
      patientFiles:(b.patientFiles||[]).map(rebuildEntry)
    }));
    activeView = ["perfile","batch","sampling"].includes(snapshot.activeView) ? snapshot.activeView : "perfile";
    if(typeof snapshot.autoOcrEnabled==="boolean") autoOcrEnabled=snapshot.autoOcrEnabled;
    samplingFiles = (snapshot.samplingFiles||[]).map(row=>Object.assign({},row,{file:null,checked:false,unavailable:!row.externalStored}));
    if(typeof snapshot.samplingCounter==="number") samplingCounter=snapshot.samplingCounter;
    if(["original","smallest","largest"].includes(snapshot.samplingSortMode)) samplingSortMode=snapshot.samplingSortMode;
    if(typeof snapshot.samplingPage==="number") samplingPage=Math.max(1,snapshot.samplingPage);
    if(Number.isFinite(Number(snapshot.samplingThreshold))) document.getElementById("samplingThreshold").value=Number(snapshot.samplingThreshold);
  }
  applyBuiltInKeywordAliases();
  applyBuiltInContentChecks();

  // Muat metadata antrean tanpa menarik seluruh PDF ke RAM. PDF baru diambil dari
  // IndexedDB saat pengguna membuka pratinjau/OCR untuk berkas tersebut.
  let storedActive = [];
  let storedResults = [];
  let storedMedicine = [];
  let migratedLegacy = false;
  try{
    storedActive = (await dbGetAll(DB_ACTIVE_STORE)) || [];
    storedResults = (await dbGetAll(DB_RESULTS_STORE)) || [];
    storedMedicine = (await dbGetAll(DB_MEDICINE_STORE)) || [];
  }catch(err){
    console.warn("Penyimpanan terpisah belum dapat dimuat:",err);
  }
  const embeddedBatchPayloads=[];
  batches.forEach(batch=>batch.patientFiles.forEach(entry=>{
    if(entry.blob||entry._analysisLoaded) embeddedBatchPayloads.push(entry);
  }));
  if(embeddedBatchPayloads.length){
    try{
      const payloadGroups=partitionEntriesBySize(embeddedBatchPayloads,20,64*1024*1024);
      for(const group of payloadGroups) await dbWritePayloadEntries(group,true,true);
      embeddedBatchPayloads.forEach(releaseEntryHeavyData);
      migratedLegacy=true;
    }catch(err){
      console.warn("Migrasi penyimpanan berkas kolektif belum selesai:",err);
    }
  }
  if(storedActive.length){
    files = storedActive.map(rebuildEntry);
    const embeddedAnalysis=files.filter(entry=>entry._analysisLoaded);
    if(embeddedAnalysis.length){
      try{
        for(let i=0;i<embeddedAnalysis.length;i+=100) await dbWriteAnalysisEntries(embeddedAnalysis.slice(i,i+100));
        for(let i=0;i<files.length;i+=200) await dbWriteActiveEntries(files.slice(i,i+200),false);
        embeddedAnalysis.forEach(releaseEntryHeavyData);
        migratedLegacy=true;
      }catch(err){ console.warn("Migrasi data analisis versi sebelumnya belum selesai:",err); }
    }
  }else if(snapshot && snapshot.storageVersion!==3 && snapshot.files && snapshot.files.length){
    // Migrasi otomatis dari versi lama yang menyimpan semua PDF dalam satu snapshot.
    files = snapshot.files.map((row,idx)=>{
      const entry = rebuildEntry(row);
      entry.order = Number.isFinite(entry.order) ? entry.order : idx+1;
      entry.size = entry.size || (entry.blob&&entry.blob.size)||0;
      entry.lastModified = entry.lastModified || (entry.blob&&entry.blob.lastModified)||0;
      entry.fingerprint = entry.fingerprint || fileFingerprint(entry);
      entry.blobStored = !!entry.blob;
      return entry;
    });
    try{
      for(let i=0;i<files.length;i+=100) await dbWriteAnalysisEntries(files.slice(i,i+100));
      for(let i=0;i<files.length;i+=100) await dbWriteActiveEntries(files.slice(i,i+100),true);
      files.forEach(releaseEntryHeavyData);
      migratedLegacy = true;
    }catch(err){ console.warn("Migrasi antrean lama belum selesai:",err); }
  }
  archivedFiles = storedResults.length ? storedResults : ((snapshot&&snapshot.archivedFiles)||[]);
  medicineFiles=storedMedicine.map(rebuildMedicineRecord);
  files.forEach((entry,idx)=>{
    entry.order = Number.isFinite(entry.order) ? entry.order : idx+1;
    entry.fingerprint = entry.fingerprint || fileFingerprint(entry);
    entry.blobStored = !!entry.blobStored || !!entry.blob;
    if(entry.open){ entry.open=false; dirtyActiveIds.add(entry.id); }
  });
  archivedFiles.forEach((row,idx)=>{
    row.order = Number.isFinite(row.order) ? row.order : idx+1;
    row.fingerprint = row.fingerprint || fileFingerprint(row);
    row.missingNames = row.missingNames||[];
  });
  medicineFiles.forEach((entry,index)=>{
    entry.order=Number.isFinite(entry.order)?entry.order:index+1;
    entry.fingerprint=entry.fingerprint||fileFingerprint(entry);
  });
  if(medicineFiles.length){
    const nextMedicineId=medicineFiles.reduce((max,entry)=>{
      const match=String(entry.id||"").match(/^med(\d+)$/);
      return Math.max(max,match?Number(match[1])+1:0);
    },0);
    medicineCounter=Math.max(medicineCounter,nextMedicineId);
  }
  refreshKnownFingerprints();
  if(files.length || archivedFiles.length){
    const maxOrder=[...files,...archivedFiles].reduce((max,row)=>Math.max(max,row.order||0),0);
    fileCounter = Math.max(fileCounter,maxOrder+1);
  }
  if(migratedLegacy){
    try{ await dbPut(DB_STORE,DB_KEY,buildSnapshot()); }
    catch(err){ console.warn("Penanda migrasi belum dapat disimpan:",err); }
  }

  renderTabs();
  renderEditor();
  initModeSelect();
  renderResults();
  renderBatches();
  renderSamplingList();
  renderMedicineTable();
  applyVisibleView(activeView);
  syncAutoOcrControls();
  ensurePdfEngine().catch(err=>{
    const progress=document.getElementById("progressLine");
    if(progress) progress.textContent=`Peringatan: ${err.message||"mesin pembaca PDF belum tersedia"}`;
    console.warn("Mesin pembaca PDF belum siap:",err);
  });

  if((snapshot && snapshot.batches&&snapshot.batches.length) || files.length || archivedFiles.length || medicineFiles.length){
    const nFiles = files.length;
    const nBatches = ((snapshot&&snapshot.batches)||[]).filter(b=>(b.roster||[]).length>0).length;
    const parts = [];
    if(nFiles) parts.push(`${nFiles} berkas aktif`);
    if(archivedFiles.length) parts.push(`${archivedFiles.length} hasil tersimpan`);
    if(nBatches) parts.push(`${nBatches} layanan kolektif`);
    if(medicineFiles.length) parts.push(`${medicineFiles.length} resep Obat`);
    const banner = document.getElementById("restoreBanner");
    document.getElementById("restoreBannerText").textContent =
      `Data dari sesi sebelumnya berhasil dimuat kembali (${parts.join(" & ")}). Semuanya tersimpan otomatis di perangkat ini.`;
    banner.style.display = "flex";
  }

  if(!snapshot){ updateSaveIndicator(true); }
  await restoreStoredWorkspaceHandle();
  enqueueAllPendingOcr();
  scheduleSave(100);
  if(files.some(entry=>entry.pending)){
    fileImportQueue = fileImportQueue.then(()=>resumeInterruptedFiles());
  }
  if(batches.some(batch=>batch.patientFiles.some(entry=>entry.pending))){
    fileImportQueue = fileImportQueue.then(()=>resumeInterruptedBatchFiles());
  }
  if(medicineFiles.some(entry=>entry.pending)){
    queueMedicineTask(()=>resumeInterruptedMedicineFiles());
  }
}
initApp();
