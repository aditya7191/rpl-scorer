/* Shared helpers for registration pages */
window.RC = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);
  const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 3500);
  }
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Error ' + r.status); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  async function postForm(url, fd, headers) {
    const r = await fetch(url, { method: 'POST', body: fd, headers: headers || {} });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || (r.status === 413 ? 'File too big' : 'Error ' + r.status)); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  // Make phone photos/screenshots small before upload (max 1600px JPEG). Works on Android Chrome and
  // iPhone Safari (Safari also turns HEIC photos into JPEG here). Falls back to the original file.
  function shrinkImage(file, max) {
    max = max || 1600;
    return new Promise((resolve) => {
      if (!file || !/^image\//.test(file.type || 'image/')) return resolve(file);
      const url = URL.createObjectURL(file);
      const img = new Image();
      const done = (f) => { URL.revokeObjectURL(url); resolve(f); };
      img.onload = () => {
        try {
          const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
          cv.toBlob((b) => {
            if (!b || (b.size > file.size && /jpe?g|png/.test(file.type))) return done(file);
            done(new File([b], 'screenshot.jpg', { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.85);
        } catch (e) { done(file); }
      };
      img.onerror = () => done(file);
      img.src = url;
    });
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied!'); return; } catch (e) { /* fall back */ }
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    try { document.execCommand('copy'); toast('Copied!'); } catch (_) { prompt('Copy this:', text); }
    ta.remove();
  }
  // remember registrations on this phone so the team can open them again
  function remember(entry) {
    try {
      const list = JSON.parse(localStorage.getItem('rpl_regs') || '[]').filter(x => x.token !== entry.token);
      list.unshift(entry); localStorage.setItem('rpl_regs', JSON.stringify(list.slice(0, 10)));
    } catch (e) { /* private mode */ }
  }
  function remembered() { try { return JSON.parse(localStorage.getItem('rpl_regs') || '[]'); } catch (e) { return []; } }
  return { esc, $, rupees, toast, getJSON, postForm, shrinkImage, copy, remember, remembered };
})();
