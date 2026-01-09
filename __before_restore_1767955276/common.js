function $(sel){ return document.querySelector(sel); }


function playScanBeep(){
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    const ctx = new AC();
    const o1 = ctx.createOscillator();
    const g = ctx.createGain();
    o1.type = 'square';
    o1.frequency.value = 880;
    g.gain.value = 0.001;
    o1.connect(g);
    g.connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    o1.start(t);
    o1.stop(t + 0.12);
    o1.onended = ()=>{ try{ctx.close();}catch(e){} };
  }catch(e){}
}

function ensureSecureContext(){
  // �������� ����� ���� ���: HTTPS �� localhost.
  // ������ ����: ��������� ����� http://localhost ������ ����� � ���� �� ���� �������.
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if(isLocal) return true;
  if(location.protocol !== 'https:'){
    // �������� �������: ����� ������� �������� ������ ������ ��� ���� ��������.
    // ��� ���� ������� ��� ������ ����� ����� ����� ����� �������� ������.
    const httpsUrl = suggestedHttpsUrl();
    if(httpsUrl){
      try{ location.replace(httpsUrl); }catch(e){}
    }
    return false;
  }
  return true;
}

// ���� ������ ������ (������� ��� ������ ��� IP)
// ������: ������� ����� HTTPS ������ ��� 3443 (���� server.js)
function suggestedHttpsUrl(){
  try{
    if(location.protocol === 'https:') return null;
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if(isLocal) return null;
    const port = (location.port || '').toString();
    const httpsPort = (port === '3000') ? '3443' : (port && port !== '80' ? port : '');
    const host = location.hostname + (httpsPort ? (':' + httpsPort) : '');
    return `https://${host}${location.pathname}${location.search}${location.hash}`;
  }catch(e){
    return null;
  }
}

function $all(sel){ return Array.from(document.querySelectorAll(sel)); }

function showNotice(msg, type=""){
  const box = $("#notice");
  if(!box) return;
  box.textContent = msg;
  box.className = "notice " + type;
  box.style.display = "block";
}

// ��� showNotice ��� ���� HTML (�� ������� �� ������ ��������)
function showNoticeHtml(html, type=""){
  const box = $("#notice");
  if(!box) return;
  box.innerHTML = html;
  box.className = "notice " + type;
  box.style.display = "block";
}

function hideNotice(){
  const box = $("#notice");
  if(!box) return;
  box.style.display = "none";
}

function openModal(){
  $("#modalBack").style.display = "grid";
}
function closeModal(){
  $("#modalBack").style.display = "none";

  // ����� �������: ��� ����� ����� �������� ���� �������� ��������
  const mb = document.querySelector("#modalBack");
  if(mb && mb.dataset && mb.dataset.goHome === "1"){
    window.location.href = "/";
  }
}


// ���� QR / ������
// ������: Html5Qrcode (���� ���� ���������) � ������ �� /vendor/html5-qrcode.min.js
// ����: BarcodeDetector (��� ��� �������)
function createQrScanner(mountEl, onDecode, onError){
  let running = false;

  // Html5Qrcode state
  let h5 = null;
  let mountId = null;

  // BarcodeDetector fallback state
  let stream = null;
  let detector = null;
  let video = null;
  let canvas = null;
  let ctx = null;
  let raf = null;

  let lastText = "";
  let lastAt = 0;

  function shouldEmit(text){
    const now = Date.now();
    if(text === lastText && (now - lastAt) < 1500) return false;
    lastText = text; lastAt = now;
    return true;
  }

  async function start(){
    if(running) return;
    if(!ensureSecureContext()){
      const err = new Error('NOT_SECURE');
      err.name = 'NOT_SECURE';
      err.code = 'NOT_SECURE';
      if(onError) onError(err);
      throw err;
    }

    running = true;

    // 1) Html5Qrcode (���� ���)
    if(window.Html5Qrcode){
      try{
        if(!mountEl) throw new Error('NO_MOUNT');
        mountId = 'qr_mount_' + Math.random().toString(16).slice(2);
        mountEl.innerHTML = `<div id="${mountId}"></div>`;
        h5 = new Html5Qrcode(mountId);

        const config = { fps: 10, qrbox: 250, aspectRatio: 1.0 };

        await h5.start(
          { facingMode: 'environment' },
          config,
          (decodedText)=>{
            try{
              if(decodedText && shouldEmit(decodedText)){
                if(onDecode) onDecode(decodedText);
              }
            }catch(e){}
          },
          (_errMsg)=>{ /* ����� ����� ������� �������� */ }
        );

        return;
      }catch(e){
        // ��� ��� Html5Qrcode ��� ��ȡ ���� ������ BarcodeDetector (��� �����)
        try{
          if(h5){
            try{ await h5.stop(); }catch(_e){}
            try{ h5.clear(); }catch(_e){}
          }
        }catch(_e){}
        h5 = null;
        if(mountEl) mountEl.innerHTML = '';
        // �� ���� ��� ������ � ���� ������
      }
    }

    // 2) ���� BarcodeDetector
    if(!('BarcodeDetector' in window)){
      running = false;
      const err = new Error('NO_SCANNER_SUPPORT');
      err.name = 'NO_SCANNER_SUPPORT';
      err.code = 'NO_SCANNER_SUPPORT';
      if(onError) onError(err);
      throw err;
    }

    try{
      detector = new BarcodeDetector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });

      video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.srcObject = stream;

      if(mountEl){
        mountEl.innerHTML = '';
        mountEl.appendChild(video);
      }

      await video.play();

      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });

      const loop = async ()=>{
        if(!running) return;
        try{
          if(video && video.readyState >= 2){
            const w = video.videoWidth || 640;
            const h = video.videoHeight || 480;
            if(canvas.width != w){ canvas.width = w; canvas.height = h; }
            ctx.drawImage(video, 0, 0, w, h);
            const bitmap = await createImageBitmap(canvas);
            const codes = await detector.detect(bitmap);
            if(codes && codes[0] && codes[0].rawValue){
              const v = codes[0].rawValue;
              if(v && shouldEmit(v)){
                if(onDecode) onDecode(v);
              }
            }
          }
        }catch(e){}
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }catch(e){
      running = false;
      if(onError) onError(e);
      throw e;
    }
  }

  async function stop(){
    running = false;

    // stop Html5Qrcode
    if(h5){
      try{ await h5.stop(); }catch(e){}
      try{ h5.clear(); }catch(e){}
      h5 = null;
    }
    mountId = null;

    // stop BarcodeDetector fallback
    if(raf){ cancelAnimationFrame(raf); raf = null; }
    if(stream){
      try{ stream.getTracks().forEach(t=>t.stop()); }catch(e){}
      stream = null;
    }
    if(video){
      try{ video.pause(); }catch(e){}
      try{ video.srcObject = null; }catch(e){}
      try{ video.remove(); }catch(e){}
      video = null;
    }
    detector = null;
    canvas = null; ctx = null;

    if(mountEl) mountEl.innerHTML = '';
  }

  return { start, stop };
}

function setStars(containerSel, hiddenInputSel){
  const stars = $all(containerSel + " .star");
  const hidden = $(hiddenInputSel);
  stars.forEach(s=>{
    s.addEventListener("click", ()=>{
      const v = Number(s.dataset.v);
      hidden.value = String(v);
      stars.forEach(x=> x.classList.toggle("active", Number(x.dataset.v) <= v));
    });
  });
}

async function api(path, method="GET", body=null){
  const opts = { method, headers: {} };
  // Always include cookies for same-origin & cross-origin (when allowed)
  opts.credentials = "include";
  if(body){
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  // Always return JSON and never throw here.
  // Many pages rely on reading {ok:false, error, message} to show the right UX.
  const data = await res.json().catch(()=>({ ok:false, error:"BAD_JSON", message:"������� ��� ����� �� ������" }));
  if(typeof data.ok === "undefined") data.ok = res.ok;
  if(!res.ok && !data.ok) data.status = res.status;
  return data;
}

// Helper: explicit GET wrapper (used in admin dashboard)
async function apiGet(path){
  return api(path, "GET");
}


function iconAdmin(){
  return `
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm7 10a7 7 0 0 0-14 0" stroke="white" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function iconWhats(){
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
  <path d="M20.5 11.9a8.6 8.6 0 0 1-12.6 7.5L3 21l1.7-4.7A8.6 8.6 0 1 1 20.5 11.9Z" stroke="white" stroke-width="2" stroke-linejoin="round"/>
  <path d="M8.7 8.8c.2-.6.6-.7 1.1-.7h.9c.3 0 .6.1.7.5l.6 1.6c.1.3 0 .7-.2.9l-.5.5c.8 1.4 1.8 2.4 3.2 3.2l.5-.5c.2-.2.6-.3.9-.2l1.6.6c.4.1.5.4.5.7v.9c0 .5-.1.9-.7 1.1-.7.2-2 .5-4.3-.8-2.2-1.2-3.8-2.8-5-5-1.3-2.3-1-3.6-.8-4.3Z" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}
function iconSnap(){
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
  <path d="M12 3c3 0 4 2 4 4.5 0 1.4-.2 2.1.6 2.7.7.6 2 .6 2.1 1.5.1.7-1.2 1.2-1.9 1.4-.7.2-.9 1.2-.3 1.7.5.4 1.6 1 1.5 1.6-.1.8-1.7.7-2.3.6-.9-.2-1.2.5-1.4 1.2-.3.9-1 1.3-2 1.3-.7 0-1.4-.2-2-.5-.6.3-1.3.5-2 .5-1 0-1.7-.4-2-1.3-.2-.7-.5-1.4-1.4-1.2-.6.1-2.2.2-2.3-.6-.1-.6 1-1.2 1.5-1.6.6-.5.4-1.5-.3-1.7-.7-.2-2-.7-1.9-1.4.1-.9 1.4-.9 2.1-1.5.8-.6.6-1.3.6-2.7C8 5 9 3 12 3Z" stroke="white" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;
}
function iconTiktok(){
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
  <path d="M14 3v12.2a3.3 3.3 0 1 1-3-3.3" stroke="white" stroke-width="2" stroke-linecap="round"/>
  <path d="M14 6c1.1 2.4 3 4 6 4" stroke="white" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function iconMaps(){
  // Simple map pin
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 22s7-4.5 7-11a7 7 0 1 0-14 0c0 6.5 7 11 7 11Z" stroke="currentColor" stroke-width="1.8"/>
    <circle cx="12" cy="11" r="2.5" stroke="currentColor" stroke-width="1.8"/>
  </svg>`;
}

// ���� ������ ���� ���� ������: ���� ��� ���� �����
function enableHiddenAdmin(logoSelector, url="/admin-login.html", taps=7, windowMs=1800){
  const el = document.querySelector(logoSelector);
  if(!el) return;
  let count = 0;
  let timer = null;
  el.style.cursor = "pointer";
  el.addEventListener("click", ()=>{
    count += 1;
    if(timer) clearTimeout(timer);
    timer = setTimeout(()=>{ count = 0; }, windowMs);
    if(count >= taps){
      count = 0;
      window.location.href = url;
    }
  });
}

// ��� ���� (��� ���� �������) ��� ����� QR
function playBeep(){
  try{
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx) return;
    const ctx = new AudioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = "square";
    o.frequency.value = 950;
    g.gain.value = 0.07;

    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{
      try{ o.stop(); }catch(_){ }
      try{ ctx.close(); }catch(_){ }
    }, 90);
  }catch(_){ }
}

// ������� (SVG) ���� �� ������ ������
function iconSettings(){
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="white" stroke-width="2"/><path d="M19.4 15a7.9 7.9 0 0 0 .1-2l2-1.3-2-3.4-2.3.7a7.8 7.8 0 0 0-1.7-1l-.3-2.4H9.8L9.5 8a7.8 7.8 0 0 0-1.7 1L5.5 8.3 3.5 11.7l2 1.3a7.9 7.9 0 0 0 .1 2l-2 1.3 2 3.4 2.3-.7a7.8 7.8 0 0 0 1.7 1l.3 2.4h4.4l.3-2.4a7.8 7.8 0 0 0 1.7-1l2.3.7 2-3.4-2-1.3Z" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

function iconBell(){
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7Z" stroke="white" stroke-width="2" stroke-linejoin="round"/><path d="M13.7 21a2 2 0 0 1-3.4 0" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function iconExcel(){
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6V3Z" stroke="white" stroke-width="2"/><path d="M14 3v5h5" stroke="white" stroke-width="2"/><path d="M8 11l4 6M12 11l-4 6" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function iconWord(){
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6V3Z" stroke="white" stroke-width="2"/><path d="M14 3v5h5" stroke="white" stroke-width="2"/><path d="M8 11l1.2 6 1.3-4 1.3 4 1.2-6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function iconLogout(){
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M10 17l-1 3h-5V4h5l1 3" stroke="white" stroke-width="2" stroke-linejoin="round"/><path d="M13 7l4 5-4 5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 12H9" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function iconAdmin(){
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="white" stroke-width="2" stroke-linecap="round"/><path d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="white" stroke-width="2"/></svg>`;
}
