'use strict';
// Image work for registration:
//  - processUpload: check real image type (magic bytes), then re-encode with sharp (auto-rotate, max 1600px, JPEG).
//    Re-encoding also strips EXIF/GPS data and anything hidden in the file.
//  - renderThankYou: the 1080x1350 celebration card (PNG), drawn with @napi-rs/canvas and bundled fonts (no network).
const path = require('path');
const sharp = require('sharp');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { sniffImage } = require('./validate.js');

sharp.cache(false);
sharp.concurrency(1); // small server (512 MB); one image at a time is plenty

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

class UploadError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

async function processUpload(buf, opts = {}) {
  if (!buf || !buf.length) throw new UploadError('Please choose an image');
  if (buf.length > MAX_INPUT_BYTES) throw new UploadError('Image is too big (max 8 MB)', 413);
  const kind = sniffImage(buf);
  if (kind === 'heic') throw new UploadError('HEIC photos are not supported. Please upload a screenshot (JPG or PNG)');
  if (!kind) throw new UploadError('Only image files (JPG, PNG, WEBP) are allowed');
  let img;
  try {
    img = sharp(buf, { limitInputPixels: 50e6, failOn: 'error', animated: false });
    const meta = await img.metadata();
    if (!['jpeg', 'png', 'webp', 'gif'].includes(meta.format) || meta.format !== kind) throw new Error('format mismatch');
  } catch (e) { throw new UploadError('This image could not be read. Please try another screenshot'); }
  const max = opts.max || 1600;
  try {
    const pipe = sharp(buf, { limitInputPixels: 50e6, animated: false }).rotate()
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
    if (opts.png) {
      const data = await pipe.png({ compressionLevel: 9, palette: true, quality: 95 }).toBuffer();
      return { data, mime: 'image/png' };
    }
    const data = await pipe.flatten({ background: '#ffffff' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    return { data, mime: 'image/jpeg' };
  } catch (e) { throw new UploadError('This image could not be processed. Please try another screenshot'); }
}

// ---------- thank-you card ----------
const ASSETS = path.join(__dirname, '..', 'assets');
let fontsReady = false, logoP = null;
function ensureFonts() {
  if (fontsReady) return;
  const F = (f) => path.join(ASSETS, 'fonts', f);
  GlobalFonts.registerFromPath(F('Anton-Regular.ttf'), 'RPL Anton');
  GlobalFonts.registerFromPath(F('Poppins-Bold.ttf'), 'RPL Poppins Bold');
  GlobalFonts.registerFromPath(F('Poppins-SemiBold.ttf'), 'RPL Poppins SemiBold');
  GlobalFonts.registerFromPath(F('Poppins-Medium.ttf'), 'RPL Poppins Medium');
  GlobalFonts.registerFromPath(F('Poppins-ExtraBoldItalic.ttf'), 'RPL Poppins XBI');
  fontsReady = true;
}
const getLogo = () => (logoP = logoP || loadImage(path.join(ASSETS, 'logo-full.png')));

const NAVY = '#0b1640', NAVY2 = '#16224e', ORANGE = '#ff8c14', GOLD = '#ffb828', WHITE = '#ffffff';

// small deterministic PRNG so the same team always gets the same confetti
function rng(seedStr) {
  let h = 2166136261;
  for (const c of String(seedStr)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
}
function fitFont(ctx, text, family, maxW, start, min) {
  let size = start;
  for (; size > min; size -= 2) { ctx.font = size + 'px "' + family + '"'; if (ctx.measureText(text).width <= maxW) break; }
  ctx.font = size + 'px "' + family + '"';
  return size;
}
// split into max 2 lines that fit
function wrap2(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return [text];
  const words = text.split(' ');
  if (words.length < 2) return [text];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
    if (!best || w < best.w) best = { w, lines: [a, b] };
  }
  return best.lines;
}
function spaced(ctx, text, x, y, spacing, align = 'center') {
  // letter-spaced text, centered at x
  const chars = [...text];
  const widths = chars.map(c => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = align === 'center' ? x - total / 2 : x;
  const prev = ctx.textAlign; ctx.textAlign = 'left';
  chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += widths[i] + spacing; });
  ctx.textAlign = prev;
  return total;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawBall(ctx, x, y, r, rot) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r);
  g.addColorStop(0, '#ff6b6b'); g.addColorStop(0.55, '#d7192a'); g.addColorStop(1, '#7a0c16');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = r * 0.06;
  for (const o of [-0.12, 0.12]) { ctx.beginPath(); ctx.ellipse(0, 0, r * (0.25 + o), r * 0.98, 0, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([r * 0.08, r * 0.1]); ctx.lineWidth = r * 0.05;
  for (const o of [-0.25, 0.25]) { ctx.beginPath(); ctx.ellipse(0, 0, r * (0.25 + o * 0.5 + (o > 0 ? 0.12 : -0.12)), r * 0.9, 0, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}
function drawBat(ctx, x, y, len, rot) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  const w = len * 0.16, handle = len * 0.3;
  // handle
  ctx.fillStyle = '#1f2937'; roundRect(ctx, -w * 0.18, -len / 2, w * 0.36, handle, w * 0.15); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
  for (let i = 1; i < 7; i++) { ctx.beginPath(); ctx.moveTo(-w * 0.18, -len / 2 + i * handle / 7); ctx.lineTo(w * 0.18, -len / 2 + i * handle / 7 + 6); ctx.stroke(); }
  // blade
  const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  g.addColorStop(0, '#d9a55b'); g.addColorStop(0.5, '#f6d79b'); g.addColorStop(1, '#c48a3f');
  ctx.fillStyle = g; roundRect(ctx, -w / 2, -len / 2 + handle - 4, w, len - handle + 4, w * 0.35); ctx.fill();
  ctx.fillStyle = ORANGE; ctx.fillRect(-w / 2, -len / 2 + handle + len * 0.08, w, len * 0.05);
  ctx.fillStyle = NAVY; ctx.fillRect(-w / 2, -len / 2 + handle + len * 0.13, w, len * 0.02);
  ctx.restore();
}
function drawStumps(ctx, x, y, h) {
  ctx.save(); ctx.translate(x, y);
  const gap = h * 0.16, sw = h * 0.07;
  for (let i = -1; i <= 1; i++) {
    const g = ctx.createLinearGradient(i * gap - sw / 2, 0, i * gap + sw / 2, 0);
    g.addColorStop(0, '#e9d3a8'); g.addColorStop(1, '#b98d4e');
    ctx.fillStyle = g; roundRect(ctx, i * gap - sw / 2, -h, sw, h, sw / 2); ctx.fill();
  }
  ctx.fillStyle = GOLD; roundRect(ctx, -gap - sw / 2, -h - sw * 0.7, gap * 1.05, sw * 0.5, sw * 0.25); ctx.fill();
  roundRect(ctx, sw * 0.1, -h - sw * 0.7, gap * 1.05, sw * 0.5, sw * 0.25); ctx.fill();
  ctx.restore();
}

async function renderThankYou(info) {
  ensureFonts();
  const W = 1080, H = 1350;
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  const rand = rng(info.regNo + '|' + info.teamName);
  const logo = await getLogo();

  // background: navy radial glow
  const bg = ctx.createRadialGradient(W / 2, 430, 60, W / 2, 560, 980);
  bg.addColorStop(0, '#24357a'); bg.addColorStop(0.45, NAVY2); bg.addColorStop(1, '#03050e');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // light rays from the logo
  ctx.save(); ctx.translate(W / 2, 330);
  for (let i = 0; i < 24; i++) {
    ctx.rotate(Math.PI * 2 / 24);
    ctx.fillStyle = i % 2 ? 'rgba(255,184,40,0.055)' : 'rgba(255,140,20,0.035)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-70, -1300); ctx.lineTo(70, -1300); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // diagonal sport stripes
  ctx.save();
  ctx.fillStyle = 'rgba(255,140,20,0.9)'; ctx.beginPath(); ctx.moveTo(0, 1090); ctx.lineTo(W, 930); ctx.lineTo(W, 965); ctx.lineTo(0, 1125); ctx.fill();
  ctx.fillStyle = 'rgba(255,184,40,0.85)'; ctx.beginPath(); ctx.moveTo(0, 1140); ctx.lineTo(W, 980); ctx.lineTo(W, 992); ctx.lineTo(0, 1152); ctx.fill();
  ctx.restore();
  // logo watermark (big, faint)
  ctx.save(); ctx.globalAlpha = 0.06; ctx.drawImage(logo, W / 2 - 430, 560, 860, 860); ctx.restore();
  // confetti
  const colors = [ORANGE, GOLD, WHITE, '#ff4d6d', '#38bdf8'];
  for (let i = 0; i < 90; i++) {
    // confetti only around the edges, never over the logo or the text
    const top = rand() < 0.55;
    const x = top ? rand() * W : (rand() < 0.5 ? rand() * 62 : W - rand() * 62), y = top ? 22 + rand() * 470 : 500 + rand() * 820;
    if (top && y > 100 && Math.abs(x - W / 2) < 260) continue;
    if (top && y < 100 && Math.abs(x - W / 2) < 330 && y > 40) continue; // league name strip
    ctx.save(); ctx.translate(x, y); ctx.rotate(rand() * Math.PI);
    ctx.globalAlpha = 0.5 + rand() * 0.5; ctx.fillStyle = colors[i % colors.length];
    if (i % 3 === 0) { ctx.beginPath(); ctx.arc(0, 0, 4 + rand() * 6, 0, Math.PI * 2); ctx.fill(); }
    else ctx.fillRect(-9, -3.5, 14 + rand() * 10, 7);
    ctx.restore();
  }
  // top & bottom bars
  ctx.fillStyle = ORANGE; ctx.fillRect(0, 0, W, 14); ctx.fillRect(0, H - 14, W, 14);
  ctx.fillStyle = GOLD; ctx.fillRect(0, 14, W, 4); ctx.fillRect(0, H - 18, W, 4);

  // header strip
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = GOLD; ctx.font = '30px "RPL Poppins SemiBold"';
  spaced(ctx, 'ROHIDAS PREMIER LEAGUE', W / 2, 78, 6);

  // measure the team name first: a 2-line name makes the logo smaller and moves things up
  const teamTxt = String(info.teamName || '').toUpperCase();
  ctx.font = '96px "RPL Anton"';
  let size = 96, lines = [teamTxt];
  if (ctx.measureText(teamTxt).width > 900) {
    lines = wrap2(ctx, teamTxt, 900);
    size = 84;
    for (; size > 46; size -= 2) { ctx.font = size + 'px "RPL Anton"'; if (lines.every(l => ctx.measureText(l).width <= 900)) break; }
  }
  const lineH = size * 1.1, panelH = 70 + lineH * lines.length;
  const shift = Math.max(0, Math.min(90, panelH - 176));

  // logo with glow ring
  const LX = W / 2, LR = 180 - shift / 2, LY = 290 - shift / 2;
  ctx.save(); ctx.shadowColor = 'rgba(255,170,40,0.85)'; ctx.shadowBlur = 70;
  ctx.fillStyle = 'rgba(255,184,40,0.25)'; ctx.beginPath(); ctx.arc(LX, LY, LR + 14, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.lineWidth = 6; ctx.strokeStyle = GOLD; ctx.beginPath(); ctx.arc(LX, LY, LR + 14, 0, Math.PI * 2); ctx.stroke();
  ctx.drawImage(logo, LX - LR, LY - LR, LR * 2, LR * 2);

  // cricket props
  drawBat(ctx, 120, 320, 320, -0.5);
  drawBall(ctx, 190, 455, 40, 0.6);
  drawStumps(ctx, W - 140, 455, 220);
  drawBall(ctx, W - 230, 185, 30, -0.3);

  // WELCOME TO
  ctx.fillStyle = WHITE; ctx.font = '44px "RPL Poppins Bold"';
  spaced(ctx, 'WELCOME TO', W / 2, 575 - shift, 10);
  // season title (gold gradient)
  const season = String(info.season || 'RPL Season 7').toUpperCase();
  fitFont(ctx, season, 'RPL Anton', 940, 108, 60);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowOffsetY = 6; ctx.shadowBlur = 12;
  const sg = ctx.createLinearGradient(0, 590 - shift, 0, 695 - shift); sg.addColorStop(0, '#fff3c4'); sg.addColorStop(0.5, GOLD); sg.addColorStop(1, ORANGE);
  ctx.fillStyle = sg; ctx.fillText(season, W / 2, 692 - shift); ctx.restore();

  // team name panel
  const PY = 728 - shift;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
  const pg = ctx.createLinearGradient(80, 0, W - 80, 0); pg.addColorStop(0, '#ff7a00'); pg.addColorStop(1, '#ffae1a');
  ctx.fillStyle = pg; roundRect(ctx, 70, PY, W - 140, panelH, 28); ctx.fill(); ctx.restore();
  ctx.fillStyle = NAVY; ctx.font = '26px "RPL Poppins Bold"';
  spaced(ctx, 'TEAM', W / 2, PY + 40, 8);
  ctx.font = size + 'px "RPL Anton"'; ctx.fillStyle = WHITE;
  ctx.save(); ctx.shadowColor = 'rgba(11,22,64,0.7)'; ctx.shadowOffsetY = 4; ctx.shadowBlur = 0;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, PY + 50 + lineH * (i + 1) - size * 0.12));
  ctx.restore();

  // captain / vice-captain cards
  let y = PY + panelH + 30;
  const colW = 440;
  for (const [i, label, name] of [[0, 'CAPTAIN', info.captain], [1, 'VICE-CAPTAIN', info.vc]]) {
    const x = i === 0 ? W / 2 - colW - 10 : W / 2 + 10;
    ctx.fillStyle = 'rgba(14,26,72,0.94)'; roundRect(ctx, x, y, colW, 112, 20); ctx.fill();
    ctx.strokeStyle = 'rgba(255,184,40,0.75)'; ctx.lineWidth = 2; roundRect(ctx, x, y, colW, 112, 20); ctx.stroke();
    ctx.fillStyle = GOLD; ctx.font = '22px "RPL Poppins SemiBold"'; spaced(ctx, label, x + colW / 2, y + 38, 4);
    ctx.fillStyle = WHITE; fitFont(ctx, String(name || ''), 'RPL Poppins Bold', colW - 40, 38, 20);
    ctx.fillText(String(name || ''), x + colW / 2, y + 88);
  }
  y += 112 + 24;
  // registration number badge
  ctx.font = '30px "RPL Poppins Bold"';
  const regTxt = 'REG. NO.  ' + info.regNo;
  const bw = ctx.measureText(regTxt).width + 120;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 14;
  ctx.fillStyle = WHITE; roundRect(ctx, W / 2 - bw / 2, y, bw, 62, 31); ctx.fill(); ctx.restore();
  ctx.fillStyle = NAVY; ctx.fillText(regTxt, W / 2, y + 42);

  // Hinglish message (fixed at the bottom)
  const msg1 = info.message || 'Taiyaar ho jao maidan mein dhamaal machane ke liye!';
  ctx.fillStyle = WHITE; fitFont(ctx, msg1, 'RPL Poppins XBI', 960, 40, 24);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 10;
  ctx.fillText(msg1, W / 2, 1220); ctx.restore();
  ctx.fillStyle = GOLD; ctx.font = '30px "RPL Poppins SemiBold"';
  ctx.fillText('Thank you for registering! Milte hain ground pe.', W / 2, 1266);
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '21px "RPL Poppins Medium"';
  spaced(ctx, 'BOX CRICKET TOURNAMENT  \u2022  MUMBAI', W / 2, 1314, 5);

  return cv.encode('png');
}

module.exports = { processUpload, renderThankYou, UploadError, MAX_INPUT_BYTES };
