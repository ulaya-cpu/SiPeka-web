// Dimuat SEBELUM app.js: menangkap galat halaman dan menjawab dialog secara otomatis.
window.__errs = [];
window.addEventListener("error", function (e) { window.__errs.push(String(e.message) + " @" + e.lineno); });
window.addEventListener("unhandledrejection", function (e) { window.__errs.push("rejection: " + String(e.reason && e.reason.message || e.reason)); });
window.confirm = function () { return true; };
window.alert = function (m) { (window.__alerts = window.__alerts || []).push(String(m)); };
(function () {
  var warn = console.warn;
  console.warn = function () {
    try { (window.__warns = window.__warns || []).push(Array.prototype.slice.call(arguments).map(String).join(" ").slice(0, 200)); } catch (e) { }
    return warn.apply(console, arguments);
  };
})();
