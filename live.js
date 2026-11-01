/*!
 * live.js — 나만의 실시간 수업 엔진 v1.6.1
 * Copyright 2026 엘레나
 *
 * 처음부터 새로 작성한 코드입니다.
 *
 * ■ 이 엔진이 하는 일
 *   - 6자리 수업 코드 + QR로 학생 입장
 *   - 객관식 투표(막대 결과), 서술형 답(카드 숨기기·크게 보기)
 *   - CSV 저장(선생님 컴퓨터로 내려받기)
 *   - 이름은 받지 않음. 반·번호는 학생이 원하면 적는 선택 항목
 *
 * ■ 서버 원칙
 *   - 선생님마다 자기 Supabase 주소 + "공개 키"(anon / sb_publishable_)만 사용
 *   - 비밀 키(service_role / sb_secret_)는 넣으면 거부합니다
 *   - Supabase Realtime Broadcast로 "주고받기만" 합니다. 테이블을 만들지 않으며
 *     학생 답·사진은 서버 데이터베이스에 저장되지 않습니다.
 *   - 선생님 화면의 신호에는 전자서명(ECDSA)을 붙여, 학생이 F12로 가짜 문제를
 *     뿌려도 다른 학생 화면이 바뀌지 않게 합니다.
 *
 * 사용법 1 — 문항만 있는 수업:
 *   <script src="live.js"></script>
 *   <script> Live.start({ id:'수업이름', title:'제목', items:[ ... ] }) </script>
 *
 * 사용법 2 — 시뮬레이션 같은 기존 수업 페이지에 얹기:
 *   Live.start({ embed:true, mountBefore:'#fs', pageOf:function(){…}, items:[{page:0, …}] })
 *   선생님: 페이지에 [● 👥 코드] [📡 질문] 단추가 생기고, 누르면 실시간 창이 열려요.
 *   학생  : QR로 들어오면 원래 페이지는 숨기고 문항 화면만 보여요.
 */
(function () {
  'use strict';

  var VERSION = '1.6.1';
  var COPY = 'Copyright 2026 엘레나';
  var SB_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  var QR_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  var MAX_TEXT = 400;
  var COLORS = ['#4cc2ff', '#ffb547', '#7ee081', '#ff7a90', '#b58cff', '#5eead4', '#f9e26b', '#fb923c'];
  var MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];

  /* ───────────── 작은 도구들 ───────────── */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  // 탭마다 따로 기억 (학생 익명 번호·내 답) — 새로 고쳐도 유지, 탭을 닫으면 사라짐
  var SS = {
    get: function (k, d) { try { var v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  function rand(n) {
    var a = new Uint8Array(n), s = '', abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    crypto.getRandomValues(a);
    for (var i = 0; i < n; i++) s += abc[a[i] % abc.length];
    return s;
  }
  function code6() {
    var a = new Uint32Array(1); crypto.getRandomValues(a);
    return String(100000 + (a[0] % 900000));
  }
  function loadScript(src) {
    return new Promise(function (ok, no) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { no(new Error('불러오기 실패: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function toast(msg, ms) {
    var t = $('#lv-toast');
    if (!t) { t = h('div', { id: 'lv-toast' }); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._tm); t._tm = setTimeout(function () { t.classList.remove('on'); }, ms || 2200);
  }
  function fit(el, max, min) {
    var s = max; el.style.fontSize = s + 'px';
    // 글꼴에 따라 글자 아래가 몇 px 삐져나오는 건 넘침으로 치지 않아요
    function over() { var tol = Math.max(3, s * 0.3); return el.scrollHeight > el.clientHeight + tol || el.scrollWidth > el.clientWidth + 2; }
    for (var g = 0; g < 40 && s > min && over(); g++) {
      s = Math.max(min, s * 0.9); el.style.fontSize = s + 'px';
    }
  }
  // 그림을 화면 가득 크게 보기 (누르거나 Esc로 닫기)
  function zoomImg(src) {
    var ov = h('div', { class: 'lv-ov on lv-zoom', title: '누르면 닫혀요' }, [h('img', { src: src, alt: '' })]);
    function close() { ov.remove(); document.removeEventListener('keydown', esc, true); }
    function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } }
    ov.addEventListener('click', close); document.addEventListener('keydown', esc, true);
    document.body.appendChild(ov);
  }
  /* ───────────── 수업 음악 (선생님 컴퓨터에서만 소리 나요) ─────────────
   * 잔잔하게 / 경쾌하게: 브라우저가 그 자리에서 직접 만드는 음악 (저작권 걱정 없음)
   * 내 음악 파일: 선생님 컴퓨터의 파일을 골라 틀어요. 어디에도 올리거나 저장하지 않아요. */
  var Music = (function () {
    var P = LS.get('lv-music', null) || {};
    if (!P.style) P.style = 'calm'; if (P.vol == null) P.vol = 0.5; if (P.auto == null) P.auto = true; if (P.tada == null) P.tada = true;
    var ac = null, master = null, noise = null, timer = null, on = false, next = 0, step = 0, audio = null, fileName = '', listeners = [];
    var PROG = [[0, 4, 7], [-3, 0, 4], [-7, -3, 0], [-5, -1, 2]];    // 도-라단조-파-솔 (I–vi–IV–V)
    function hz(m) { return 261.63 * Math.pow(2, m / 12); }
    function ctx() {
      if (!ac) {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        master = ac.createGain(); master.gain.value = 0.0001;
        var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
        master.connect(lp); lp.connect(ac.destination);
        var len = ac.sampleRate * 0.05; noise = ac.createBuffer(1, len, ac.sampleRate);
        var d = noise.getChannelData(0); for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }
    function tone(t, f, dur, type, g) {
      var o = ac.createOscillator(), e = ac.createGain();
      o.type = type; o.frequency.value = f;
      e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(g, t + 0.02); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(e); e.connect(master); o.start(t); o.stop(t + dur + 0.05);
    }
    function pad(t, ch, dur) {
      ch.forEach(function (m) {
        var o = ac.createOscillator(), e = ac.createGain();
        o.type = 'sine'; o.frequency.value = hz(m - 12);
        e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(0.045, t + 1); e.gain.linearRampToValueAtTime(0.0001, t + dur);
        o.connect(e); e.connect(master); o.start(t); o.stop(t + dur + 0.1);
      });
    }
    function hat(t) { var s = ac.createBufferSource(), g = ac.createGain(), hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000; g.gain.value = 0.05; s.buffer = noise; s.connect(hp); hp.connect(g); g.connect(master); s.start(t); }
    function tick() {
      var calm = P.style === 'calm', spb = 60 / (calm ? 70 : 104) / 2;      // 8분음표 길이(초)
      while (next < ac.currentTime + 0.35) {
        var ch = PROG[Math.floor(step / 8) % 4], i = step % 8;
        if (i === 0) pad(next, ch, spb * 8 + 0.6);
        if (calm) {
          if (i % 2 === 0 || Math.random() < 0.2) tone(next, hz(ch[Math.floor(Math.random() * 3)] + 12 * (1 + (Math.random() < 0.35 ? 1 : 0))), spb * 3.2, 'sine', 0.06);
        } else {
          tone(next, hz(ch[[0, 1, 2, 1][i % 4]] + 12), spb * 1.4, 'triangle', 0.055);
          if (i % 4 === 0) tone(next, hz(ch[0] - 12), spb * 2, 'triangle', 0.09);
          if (i % 2 === 1) hat(next);
        }
        next += spb; step++;
      }
    }
    function fade(to, sec) { var t = ac.currentTime; master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), t); master.gain.exponentialRampToValueAtTime(Math.max(0.0001, to), t + sec); }
    function emit() { listeners.forEach(function (f) { try { f(on); } catch (e) {} }); }
    function startSynth() { ctx(); next = ac.currentTime + 0.1; step = 0; clearInterval(timer); timer = setInterval(tick, 100); tick(); fade(P.vol * 0.9, 1.2); }
    function stopSynth(now) { if (!ac) return; fade(0.0001, now ? 0.05 : 0.8); var tm = timer; setTimeout(function () { if (!on || P.style === 'file') clearInterval(tm); }, now ? 60 : 900); timer = on && P.style !== 'file' ? timer : null; }
    var M = {
      prefs: P,
      isOn: function () { return on; },
      hasFile: function () { return !!audio; },
      fileName: function () { return fileName; },
      onChange: function (f) { listeners.push(f); },
      start: function () {
        if (on) return; if (P.style === 'file' && !audio) return;
        on = true;
        if (P.style === 'file') { audio.volume = P.vol; audio.play().catch(function () {}); } else startSynth();
        emit();
      },
      stop: function () {
        if (!on) return; on = false;
        if (audio) audio.pause();
        clearInterval(timer); timer = null; if (ac) fade(0.0001, 0.6);
        emit();
      },
      toggle: function () { on ? M.stop() : M.start(); },
      setStyle: function (st) {
        var was = on; if (was) M.stop();
        P.style = st; LS.set('lv-music', P);
        if (was) setTimeout(M.start, 80);
      },
      setVol: function (v) { P.vol = v; LS.set('lv-music', P); if (audio) audio.volume = v; if (on && ac && P.style !== 'file') fade(v * 0.9, 0.15); },
      setAuto: function (a) { P.auto = !!a; LS.set('lv-music', P); },
      setTada: function (a) { P.tada = !!a; LS.set('lv-music', P); },
      // 결과가 나올 때 짧은 「짜잔」 (1초쯤) — 음악은 멈추고 이것만
      tada: function () {
        if (!P.tada) return;
        try {
          ctx(); var t = ac.currentTime + 0.05, g = Math.max(0.25, P.vol);
          master.gain.cancelScheduledValues(ac.currentTime); master.gain.setValueAtTime(g * 0.9, ac.currentTime);
          [[0, 0], [4, 0.09], [7, 0.18]].forEach(function (x) { tone(t + x[1], hz(x[0] + 12), 0.22, 'triangle', 0.16); });
          [0, 4, 7, 12].forEach(function (m) { tone(t + 0.3, hz(m + 12), 1.1, 'triangle', 0.11); tone(t + 0.3, hz(m + 24), 0.9, 'sine', 0.04); });
          master.gain.setValueAtTime(g * 0.9, t + 1.4); master.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
        } catch (e) {}
      },
      setFile: function (f) {
        if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); }
        audio = new Audio(URL.createObjectURL(f)); audio.loop = true; audio.volume = P.vol; fileName = f.name;
        var was = on; on = false; clearInterval(timer); timer = null; if (ac) fade(0.0001, 0.3);
        P.style = 'file'; LS.set('lv-music', P);
        if (was) M.start(); else emit();
      }
    };
    if (P.style === 'file') P.style = 'calm';              // 파일은 새로 고치면 다시 골라야 해요
    return M;
  })();

  function fsToggle() {
    var d = document;
    if (!d.fullscreenElement && !d.webkitFullscreenElement) {
      var r = d.documentElement;
      (r.requestFullscreen || r.webkitRequestFullscreen || function () {}).call(r);
    } else {
      (d.exitFullscreen || d.webkitExitFullscreen || function () {}).call(d);
    }
  }
  function fsButton() {
    return h('button', { class: 'lv-btn lv-icon', title: '전체화면', 'aria-label': '전체화면', onclick: fsToggle, text: '⛶' });
  }

  /* ───────────── 키 검사: 비밀 키 거부 ───────────── */
  function b64uDec(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var bin = atob(str), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function b64uEnc(buf) {
    var s = '', a = new Uint8Array(buf);
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function keyProblem(url, key) {
    url = (url || '').trim(); key = (key || '').trim();
    if (!url || !key) return 'Supabase 주소와 공개 키를 모두 넣어 주세요.';
    if (!/^https:\/\/[^\s/]+\/?$/i.test(url)) return '주소는 https://로 시작하는 프로젝트 주소여야 해요. (예: https://abcd.supabase.co)';
    if (/^sb_secret_/i.test(key) || /service_role/i.test(key)) return '이건 비밀 키예요! 절대 넣으면 안 돼요. 공개 키(anon 또는 sb_publishable_…)를 넣어 주세요.';
    var parts = key.split('.');
    if (parts.length === 3) {
      try {
        var p = JSON.parse(new TextDecoder().decode(b64uDec(parts[1])));
        if (p.role === 'service_role') return '이건 비밀 키(service_role)예요! 절대 넣으면 안 돼요. anon 공개 키를 넣어 주세요.';
        if (p.role !== 'anon') return '공개 키(anon)가 아닌 것 같아요. Supabase 설정의 API 키 화면에서 anon 또는 publishable 키를 복사해 주세요.';
      } catch (e) { return '키 모양이 이상해요. 다시 복사해 주세요.'; }
    } else if (!/^sb_publishable_/i.test(key)) {
      return '공개 키 모양이 아니에요. anon 키(eyJ…로 시작) 또는 sb_publishable_…로 시작하는 키를 넣어 주세요.';
    }
    return '';
  }
  // 주소 줄이기: https://REF.supabase.co → REF
  function packUrl(url) { var m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec(url.trim()); return m ? { r: m[1] } : { u: url.trim() }; }
  function unpackUrl(q) { return q.get('r') ? 'https://' + q.get('r') + '.supabase.co' : (q.get('u') || ''); }

  /* ───────────── 전자서명 (선생님만 문제를 바꿀 수 있게) ───────────── */
  var HAS_CRYPTO = !!(window.crypto && crypto.subtle);
  var ALG = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
  var enc = new TextEncoder();
  function makeKeys() {
    return crypto.subtle.generateKey(ALG, true, ['sign', 'verify']).then(function (kp) {
      return Promise.all([crypto.subtle.exportKey('raw', kp.publicKey), crypto.subtle.exportKey('jwk', kp.privateKey)]);
    }).then(function (r) { return { pub: b64uEnc(r[0]), priv: r[1] }; });
  }
  function signer(jwk) {
    return crypto.subtle.importKey('jwk', jwk, ALG, false, ['sign']).then(function (k) {
      return function (str) { return crypto.subtle.sign(SIG, k, enc.encode(str)).then(b64uEnc); };
    });
  }
  function verifier(pub) {
    return crypto.subtle.importKey('raw', b64uDec(pub), ALG, false, ['verify']).then(function (k) {
      return function (str, sig) {
        try { return crypto.subtle.verify(SIG, k, b64uDec(sig), enc.encode(str)).catch(function () { return false; }); }
        catch (e) { return Promise.resolve(false); }
      };
    });
  }

  /* ───────────── 주고받기 통로 ─────────────
   * Supabase Realtime Broadcast(저장 없음) 또는
   * 연습 모드(같은 컴퓨터 브라우저 탭끼리만, 인터넷 안 씀)                */
  function connect(cfg, code, onMsg, onStatus) {
    if (cfg.demo) {
      var bc = new BroadcastChannel('lv-demo-' + code);
      bc.onmessage = function (e) { onMsg(e.data); };
      setTimeout(function () { onStatus('ok'); }, 30);
      return Promise.resolve({ send: function (m) { bc.postMessage(m); }, close: function () { bc.close(); } });
    }
    var p = window.supabase ? Promise.resolve() : loadScript(SB_CDN);
    return p.then(function () {
      var client = window.supabase.createClient(cfg.url, cfg.key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 40 } }
      });
      var ch = client.channel('lv-' + code, { config: { broadcast: { self: false, ack: false } } });
      ch.on('broadcast', { event: 'm' }, function (e) { onMsg(e.payload); });
      onStatus('wait');
      ch.subscribe(function (st) {
        if (st === 'SUBSCRIBED') onStatus('ok');
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') onStatus('err');
        else if (st === 'CLOSED') onStatus('off');
      });
      return {
        send: function (m) { try { var r = ch.send({ type: 'broadcast', event: 'm', payload: m }); if (r && r.catch) r.catch(function () {}); } catch (e) {} },
        close: function () { try { client.removeChannel(ch); } catch (e) {} }
      };
    });
  }

  /* ───────────── 공통 스타일 ───────────── */
  var CSS = [
    ':root{--lv-bg:#0d1117;--lv-p1:#161b23;--lv-p2:#1f2630;--lv-line:#2c3542;--lv-fg:#eef3f8;--lv-sub:#9aa7b6;--lv-ac:#4cc2ff;--lv-ok:#5ee08a;--lv-warn:#ffc24b;--lv-bad:#ff6b7d;}',
    'html.lv-full,html.lv-full body{margin:0;height:100%;background:var(--lv-bg);color:var(--lv-fg);overflow:hidden}',
    'html.lv-full body{font-family:Pretendard,"Pretendard Variable","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif;-webkit-font-smoothing:antialiased}',
    '#lv,#lv *,.lv-ov,.lv-ov *,.lv-fab,.lv-fab *{box-sizing:border-box}',
    '#lv{position:fixed;inset:0;display:flex;flex-direction:column;height:100dvh;z-index:40;background:var(--lv-bg);color:var(--lv-fg);font-family:inherit}',
    '#lv.lv-hide{display:none}',
    '.lv-fab{display:inline-flex;align-items:center;gap:.4em;font-size:clamp(15px,1.4vw,21px);white-space:nowrap;flex:0 0 auto}',
    '.lv-fab.float{position:fixed;right:12px;bottom:12px;z-index:30;background:var(--lv-p1);border:1px solid var(--lv-line);border-radius:999px;padding:.3em .4em;box-shadow:0 4px 18px #0008}',
    '.lv-fab .lv-btn{font-size:1em}',
    '.lv-fab .lv-ping{animation:lvping 1s infinite}',
    '@keyframes lvping{0%,100%{box-shadow:0 0 0 0 var(--lv-ac)}50%{box-shadow:0 0 0 .35em transparent}}',
    '.lv-bar{display:flex;align-items:center;gap:.5em;padding:.45em .7em;border-bottom:1px solid var(--lv-line);background:var(--lv-p1);font-size:clamp(14px,1.3vmin + 8px,24px);white-space:nowrap;min-width:0}',
    '.lv-title{font-weight:700;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}',
    '.lv-btn{font:inherit;font-weight:600;color:var(--lv-fg);background:var(--lv-p2);border:1px solid var(--lv-line);border-radius:.6em;padding:.35em .8em;cursor:pointer;white-space:nowrap;line-height:1.2}',
    '.lv-btn:hover{border-color:var(--lv-ac)}',
    '.lv-btn:disabled{opacity:.4;cursor:default}',
    '.lv-btn.pri{background:var(--lv-ac);color:#04131c;border-color:var(--lv-ac);font-weight:700}',
    '.lv-btn.red{background:var(--lv-bad);color:#1b0408;border-color:var(--lv-bad);font-weight:700}',
    '.lv-btn.on{outline:2px solid var(--lv-ac)}',
    '.lv-icon{padding:.35em .55em;min-width:2.2em}',
    '.lv-mus.on{background:#3a2a5a;border-color:#b58cff}',
    '.lv-mus.on span{display:inline-block;animation:lvbob 1s ease-in-out infinite}',
    '@keyframes lvbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-.15em)}}',
    '.lv-pop{position:fixed;z-index:60;background:var(--lv-p1);border:1px solid var(--lv-line);border-radius:.9em;padding:.9em;display:flex;flex-direction:column;gap:.7em;box-shadow:0 10px 30px #000c;font-size:clamp(14px,1.1vmin + 8px,20px);width:min(380px,92vw);white-space:normal}',
    '.lv-pop .seg{display:flex;border:1px solid var(--lv-line);border-radius:.6em;overflow:hidden}',
    '.lv-pop .seg button{flex:1;font:inherit;font-weight:600;background:transparent;color:var(--lv-sub);border:0;padding:.4em .3em;cursor:pointer;white-space:nowrap}',
    '.lv-pop .seg button.on{background:#b58cff;color:#170b2b}',
    '.lv-pop label{display:flex;align-items:center;gap:.5em}',
    '.lv-pop input[type=range]{flex:1;accent-color:#b58cff}',
    '.lv-pop .hint{color:var(--lv-sub);font-size:.8em;line-height:1.5}',
    '.lv-chip{display:inline-flex;align-items:center;gap:.35em;background:var(--lv-p2);border:1px solid var(--lv-line);border-radius:999px;padding:.25em .75em;cursor:default}',
    '.lv-code{font-variant-numeric:tabular-nums;letter-spacing:.08em;font-weight:800;color:var(--lv-ac);cursor:pointer}',
    '.lv-dot{width:.6em;height:.6em;border-radius:50%;background:var(--lv-sub);display:inline-block}',
    '.lv-dot.ok{background:var(--lv-ok)}.lv-dot.wait{background:var(--lv-warn)}.lv-dot.err,.lv-dot.off{background:var(--lv-bad)}',
    '.lv-copy{font-size:11px;color:#5d6876;text-align:right;padding:2px 10px;white-space:nowrap}',
    '#lv-toast{position:fixed;left:50%;bottom:6vh;transform:translateX(-50%) translateY(20px);background:#000c;border:1px solid var(--lv-line);color:var(--lv-fg);padding:.7em 1.2em;border-radius:.8em;font-size:clamp(15px,2.4vmin,26px);opacity:0;pointer-events:none;transition:.25s;z-index:99;white-space:nowrap}',
    '#lv-toast.on{opacity:1;transform:translateX(-50%)}',
    '.lv-ov{position:fixed;inset:0;background:var(--lv-bg);color:var(--lv-fg);z-index:50;display:none;flex-direction:column}',
    '.lv-ov.on{display:flex}',
    '.lv-ovbar{display:flex;justify-content:flex-end;gap:.5em;padding:.6em;font-size:clamp(14px,1.3vmin + 8px,24px)}',
    'input.lv-in,textarea.lv-in{font:inherit;color:var(--lv-fg);background:var(--lv-p2);border:1px solid var(--lv-line);border-radius:.6em;padding:.55em .7em;width:100%}',
    'input.lv-in:focus,textarea.lv-in:focus{outline:2px solid var(--lv-ac);border-color:transparent}',

    /* 선생님 화면 */
    '.lv-main{flex:1;display:flex;min-height:0}',
    '.lv-list{width:clamp(190px,19vw,320px);overflow:auto;border-right:1px solid var(--lv-line);padding:.5em;display:flex;flex-direction:column;gap:.4em;font-size:clamp(13px,1.1vmin + 7px,20px)}',
    '.lv-list.hide{display:none}',
    '.lv-li{white-space:normal;display:grid;grid-template-columns:auto 1fr auto;gap:.5em;align-items:center;text-align:left;font:inherit;color:var(--lv-fg);background:var(--lv-p1);border:1px solid var(--lv-line);border-radius:.6em;padding:.5em .6em;cursor:pointer}',
    '.lv-li.cur{border-color:var(--lv-ac);background:#11293a}',
    '.lv-li .n{font-weight:800;color:var(--lv-sub)}',
    '.lv-li .q{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.lv-li .c{font-size:.85em;color:var(--lv-sub);font-variant-numeric:tabular-nums}',
    '.lv-li.open .n{color:var(--lv-ok)}',
    '.lv-stage{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;padding:clamp(8px,1.6vmin,22px);gap:clamp(6px,1.2vmin,16px)}',
    '.lv-qhead{display:flex;gap:1em;align-items:flex-start;min-height:0}',
    '.lv-qnum{font-weight:800;color:var(--lv-ac);font-size:clamp(16px,2.6vmin,40px);white-space:nowrap;padding-top:.15em}',
    '.lv-qtext{flex:1;min-width:0;font-weight:700;line-height:1.3;font-size:clamp(20px,4.4vmin,72px);word-break:keep-all;overflow-wrap:anywhere;white-space:pre-wrap;max-height:44vh;overflow:hidden}',
    '.lv-qimg{max-height:40vh;max-width:36vw;border-radius:.6em;object-fit:contain;background:#000}',
    '.lv-ctl{display:flex;flex-wrap:wrap;gap:.45em;align-items:center;font-size:clamp(14px,1.2vmin + 8px,24px)}',
    '.lv-ctl .sp{flex:1}',
    '.lv-state{font-weight:700;padding:.3em .8em;border-radius:999px;background:var(--lv-p2);white-space:nowrap}',
    '.lv-state.open{background:#123a24;color:var(--lv-ok)}',
    '.lv-res{flex:1;min-height:0;position:relative}',
    '.lv-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--lv-sub);font-size:clamp(18px,3.4vmin,48px);text-align:center;padding:1em}',
    '.lv-veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--lv-p1);border-radius:1em;font-size:clamp(22px,5vmin,80px);font-weight:800;color:var(--lv-sub);z-index:2}',
    '.lv-bars{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:clamp(6px,1.4vmin,18px)}',
    '.lv-row{flex:1;max-height:16vh;display:grid;grid-template-columns:minmax(0,34%) 1fr 4.2em;align-items:center;gap:.7em;font-size:clamp(16px,3.4vmin,56px)}',
    '.lv-row .lv-lb{overflow:hidden;line-height:1.2;word-break:keep-all}',
    '.lv-row .trk{height:72%;background:var(--lv-p1);border-radius:.4em;overflow:hidden;position:relative}',
    '.lv-row .fil{position:absolute;left:0;top:0;bottom:0;width:0;transition:width .45s;border-radius:.4em}',
    '.lv-row .num{text-align:right;font-variant-numeric:tabular-nums;font-weight:800}',
    '.lv-row .num small{display:block;font-size:.45em;color:var(--lv-sub);font-weight:600}',
    '.lv-row.right .lv-lb{color:var(--lv-ok);font-weight:800}',
    '.lv-row.right .lv-lb::after{content:" ✔"}',
    '.lv-row.dim{opacity:.38}',
    '.lv-cards{position:absolute;inset:0;display:grid;gap:clamp(6px,1.2vmin,14px);overflow:auto;align-content:start}',
    '.lv-card{position:relative;background:var(--lv-p1);border:1px solid var(--lv-line);border-radius:.9em;padding:.6em .8em;cursor:zoom-in;overflow:hidden;line-height:1.35;word-break:keep-all;overflow-wrap:anywhere;white-space:pre-wrap;display:flex;flex-direction:column}',
    '.lv-card:hover{border-color:var(--lv-ac)}',
    '.lv-card .tx{flex:1;overflow:hidden}',
    '.lv-card .mt{font-size:12px;color:var(--lv-sub);margin-top:.3em}',
    '.lv-card .x{position:absolute;top:.25em;right:.25em;font-size:14px;background:#000a;border:1px solid var(--lv-line);color:var(--lv-fg);border-radius:.5em;padding:.15em .45em;cursor:pointer;opacity:.6}',
    '.lv-card .x:hover{opacity:1;border-color:var(--lv-bad)}',
    '.lv-card.new{animation:lvpop .5s}',
    '@keyframes lvpop{from{transform:scale(.9)}to{transform:none}}',

    /* QR 화면 */
    '.lv-qrwrap{flex:1;display:flex;align-items:center;justify-content:center;gap:5vmin;padding:2vmin 4vmin 4vmin;min-height:0}',
    '.lv-qrbox{background:#fff;border-radius:2vmin;padding:2vmin;line-height:0}',
    '.lv-qrbox canvas{width:min(70vh,46vw);height:min(70vh,46vw);image-rendering:pixelated}',
    '.lv-qrside{display:flex;flex-direction:column;gap:2vmin;align-items:flex-start;min-width:0}',
    '.lv-big{font-size:clamp(48px,15vmin,220px);font-weight:900;letter-spacing:.08em;color:var(--lv-ac);font-variant-numeric:tabular-nums;line-height:1}',
    '.lv-lab{white-space:nowrap;font-size:clamp(18px,3.4vmin,48px);color:var(--lv-sub);font-weight:700}',
    '.lv-qrside .lv-btn{font-size:clamp(16px,2.6vmin,34px)}',
    '@media (orientation:portrait){.lv-qrwrap{flex-direction:column}.lv-qrbox canvas{width:min(80vw,52vh);height:min(80vw,52vh)}.lv-qrside{align-items:center}}',

    /* 크게 보기 */
    '.lv-bigcard{flex:1;display:flex;align-items:stretch;gap:2vmin;padding:0 2vmin 3vmin;min-height:0}',
    '.lv-bigtx{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;font-weight:700;line-height:1.35;word-break:keep-all;overflow-wrap:anywhere;white-space:pre-wrap;overflow:hidden;padding:2vmin}',
    '.lv-arrow{font-size:clamp(24px,6vmin,80px);background:none;border:none;color:var(--lv-sub);cursor:pointer;padding:0 1vmin}',
    '.lv-arrow:hover{color:var(--lv-fg)}',
    '.lv-pic{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;gap:.5em}',
    '.lv-pre{position:absolute;inset:0;display:flex;flex-direction:column;gap:.6em}',
    '.lv-pre .body{flex:1;min-height:0;display:flex;gap:clamp(8px,1.6vmin,20px)}',
    '.lv-pre .pimg{flex:1.25;min-width:0;min-height:0;display:flex}',
    '.lv-pre .pimg img{width:100%;height:100%;object-fit:contain;cursor:zoom-in;border-radius:.6em}',
    '.lv-tiles{flex:1;min-width:0;min-height:0;display:grid;gap:clamp(8px,1.6vmin,18px);grid-auto-rows:1fr}',
    '.lv-tile{background:var(--lv-p1);border:3px solid var(--lv-line);border-radius:1em;display:flex;align-items:center;gap:.5em;padding:.2em .7em;font-weight:700;line-height:1.25;word-break:keep-all;overflow:hidden;min-height:0}',
    '.lv-tile .mk{font-size:1.15em}',
    '.lv-mock{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:clamp(8px,1.4vmin,16px)}',
    '.lv-mock .box{flex:1;min-height:0;border:3px dashed var(--lv-line);border-radius:1em;background:var(--lv-p1);color:var(--lv-sub);display:flex;align-items:center;justify-content:center;text-align:center;padding:.6em;font-weight:700;line-height:1.4;overflow:hidden;word-break:keep-all}',
    '.lv-mock .send{flex:0 0 auto;border-radius:.7em;background:var(--lv-ac);color:#04131c;text-align:center;font-weight:800;padding:.35em;opacity:.55}',
    '.lv-pre .cap{color:var(--lv-sub);font-size:clamp(14px,2vmin,24px);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.lv-pic img{flex:1;min-height:0;width:100%;object-fit:contain;cursor:zoom-in;border-radius:.6em}',
    '.lv-pic .cap{color:var(--lv-sub);font-size:clamp(14px,2vmin,26px);white-space:nowrap}',
    '.lv-zoom{padding:1.5vmin;cursor:zoom-out;background:#000}',
    '.lv-zoom img{width:100%;height:100%;object-fit:contain}',
    '.lv-qimg,.lv-s .qimg{cursor:zoom-in}',

    /* 설정 */
    '.lv-form{margin:auto;width:min(760px,94vw);display:flex;flex-direction:column;gap:1em;font-size:clamp(15px,1.4vmin + 8px,24px);padding:1em;overflow:auto;max-height:100%}',
    '.lv-form h2{margin:0;font-size:1.5em}',
    '.lv-form p{margin:0;color:var(--lv-sub);line-height:1.5}',
    '.lv-form label{display:flex;flex-direction:column;gap:.35em;font-weight:700}',
    '.lv-form .row{display:flex;gap:.6em;flex-wrap:wrap}',
    '.lv-err{color:var(--lv-bad);font-weight:700;min-height:1.4em}',
    '.lv-check{flex-direction:row!important;align-items:center;gap:.5em!important;font-weight:600!important}',

    /* 학생 화면 */
    '.lv-s{flex:1;display:flex;flex-direction:column;min-height:0;padding:clamp(10px,2.4vmin,28px);gap:clamp(8px,1.8vmin,20px)}',
    '.lv-s .center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.4vmin;text-align:center}',
    '.lv-s .lv-msg{font-size:clamp(22px,5vmin,64px);font-weight:800;line-height:1.3;word-break:keep-all}',
    '.lv-s .lv-sb{font-size:clamp(15px,2.6vmin,30px);color:var(--lv-sub);line-height:1.5;word-break:keep-all}',
    '.lv-s .pulse{width:clamp(40px,10vmin,110px);height:clamp(40px,10vmin,110px);border-radius:50%;background:var(--lv-ac);animation:lvpulse 1.6s infinite}',
    '@keyframes lvpulse{0%{transform:scale(.7);opacity:.9}100%{transform:scale(1.3);opacity:0}}',
    '.lv-s .lv-q{font-size:clamp(20px,4.6vmin,60px);font-weight:800;line-height:1.3;word-break:keep-all;overflow-wrap:anywhere;white-space:pre-wrap}',
    '.lv-qwrap{display:flex;flex-direction:column;gap:clamp(6px,1.4vmin,16px);max-height:46vh;min-height:0;flex:0 0 auto}',
    '.lv-qwrap.land{flex-direction:row;align-items:stretch}',
    '.lv-qwrap .lv-q{flex:1 1 auto;min-height:0;min-width:0;overflow:hidden}',
    '.lv-qwrap .qimg{flex:0 1 auto;min-height:0;max-height:22vh}',
    '.lv-qwrap.land .qimg{max-height:44vh;max-width:46%;align-self:center}',
    '.lv-s .lv-q small{display:block;color:var(--lv-ac);font-size:.55em;margin-bottom:.2em}',
    '.lv-s .qimg{max-height:28vh;max-width:100%;object-fit:contain;border-radius:.6em;align-self:center;background:#000}',
    '.lv-opts{flex:1;display:grid;gap:clamp(8px,1.8vmin,18px);min-height:0;grid-auto-rows:1fr}',
    '.lv-opt{white-space:normal;font:inherit;color:var(--lv-fg);background:var(--lv-p1);border:3px solid var(--lv-line);border-radius:1em;font-size:clamp(18px,4.2vmin,52px);font-weight:700;display:flex;align-items:center;gap:.5em;padding:.3em .7em;text-align:left;cursor:pointer;word-break:keep-all;overflow:hidden;min-height:2.4em}',
    '.lv-opt span{min-width:0}',
    '.lv-opt .mk{font-size:1.2em}',
    '.lv-opt.sel{border-color:var(--lv-ac);background:#11293a}',
    '.lv-opt.right{border-color:var(--lv-ok);background:#123a24}',
    '.lv-opt.wrong{border-color:var(--lv-bad)}',
    '.lv-opt:disabled{cursor:default}',
    '.lv-s textarea.lv-in{flex:1;min-height:6em;font-size:clamp(18px,3.8vmin,44px);resize:none;line-height:1.4}',
    '.lv-send{font-size:clamp(20px,4.4vmin,52px)!important;padding:.4em!important}',
    '.lv-stat{font-size:clamp(15px,2.8vmin,32px);text-align:center;color:var(--lv-sub);min-height:1.4em;font-weight:700}',
    '.lv-stat.ok{color:var(--lv-ok)}.lv-stat.bad{color:var(--lv-bad)}',
    '.lv-ex{flex:0 0 auto;max-height:26vh;overflow:hidden;border:2px solid var(--lv-ok);background:#0f2a1c;border-radius:.8em;padding:.5em .8em;line-height:1.4;white-space:pre-wrap;word-break:keep-all;overflow-wrap:anywhere;font-weight:700;cursor:zoom-in}',
    '.lv-ex b{display:block;color:var(--lv-ok);font-size:.6em;margin-bottom:.15em}',
    '.lv-s .lv-ex{max-height:30vh;overflow:auto;cursor:default;font-size:clamp(16px,3.2vmin,36px)}',
    '.lv-join{margin:auto;width:min(620px,92vw);display:flex;flex-direction:column;gap:2.2vmin;font-size:clamp(17px,3.2vmin,36px);text-align:center}',
    '.lv-join .two{display:grid;grid-template-columns:1fr 1fr;gap:1em}',
    '.lv-join input.lv-in{text-align:center;font-size:1.3em}',
    '.lv-join .lv-btn{font-size:1.15em;padding:.55em}',
    '.lv-codein{font-size:clamp(36px,10vmin,110px)!important;letter-spacing:.15em;font-weight:900}'
  ].join('\n');

  // embed: 이미 있는 수업 페이지(시뮬레이션 등) 위에 얹기
  // full : 이 엔진이 화면 전체를 씀 (학생 화면, 문항만 있는 수업)
  function boot(title, opt) {
    opt = opt || {};
    if (!$('#lv-css')) {
      var f = document.createElement('link');
      f.rel = 'stylesheet';
      f.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css';
      document.head.appendChild(f);
      document.head.appendChild(h('style', { id: 'lv-css', text: CSS }));
    }
    if (!document.querySelector('meta[name=viewport]')) document.head.appendChild(h('meta', { name: 'viewport', content: 'width=device-width,initial-scale=1,viewport-fit=cover' }));
    if (opt.colors) for (var k in opt.colors) document.documentElement.style.setProperty('--lv-' + k, opt.colors[k]);
    if (opt.full) {
      document.documentElement.classList.add('lv-full');
      if (title) document.title = title;
      if (opt.hideHost) Array.prototype.forEach.call(document.body.children, function (c) { if (c.tagName !== 'SCRIPT') c.style.display = 'none'; });
    }
    var old = $('#lv'); if (old) old.remove();
    var root = h('div', { id: 'lv' });
    document.body.appendChild(root);
    return root;
  }

  /* ───────────── 문항 정리 ───────────── */
  function normItems(items) {
    return (items || []).map(function (it, i) {
      var type = it.type === 'text' ? 'text' : 'choice';
      var o = { qid: String(it.id || ('q' + (i + 1))), type: type, q: String(it.q || it.question || ''), img: it.img || null, page: typeof it.page === 'number' ? it.page : null };
      if (type === 'choice') {
        o.options = (it.options || []).slice(0, 8).map(String);
        o.answer = (typeof it.answer === 'number' && it.answer >= 0 && it.answer < o.options.length) ? it.answer : null;
      } else {
        o.example = it.example ? String(it.example).slice(0, 1000) : null;   // 서술형 예시 답
      }
      return o;
    });
  }

  /* ══════════════════════════════════════════
   *  선생님 화면
   * ══════════════════════════════════════════ */
  function Teacher(lesson, PV) {      // PV: 퀴즈 만들기의 미리보기일 때 문항 번호
    var items = normItems(lesson.items);
    var KEY = 'lv-t:' + (lesson.id || location.pathname);
    var CFGKEY = 'lv-cfg';
    var cfg = LS.get(CFGKEY, null);
    if (!cfg && window.LIVE_CONFIG && window.LIVE_CONFIG.url && window.LIVE_CONFIG.key) cfg = { url: LIVE_CONFIG.url, key: LIVE_CONFIG.key, fromFile: true };
    var S = LS.get(KEY, null);
    var net = null, sign = null, status = 'off', seen = {}, stagger = 0;

    function fresh() {
      return { go: { p: 0, s: 0 }, code: code6(), keys: null, cur: 0, open: false, reveal: {}, veil: false, showMeta: false, answers: {}, seq: Date.now(), started: Date.now() };
    }
    if (!S || !S.code || PV != null) S = fresh();
    if (PV != null) { S.cur = Math.min(PV, Math.max(0, items.length - 1)); S.open = true; }
    function save() { if (PV == null) LS.set(KEY, S); }
    // 퀴즈 만들기로 만든 파일이면 ✏️ 고치기 단추
    var myFile = decodeURIComponent(location.pathname.split('/').pop() || '');
    var editable = PV == null && !!document.getElementById('quiz-data') && /\.html?$/i.test(myFile);

    var embed = !!lesson.embed;
    var root = boot(lesson.title, { full: !embed, colors: lesson.colors });
    if (embed) root.classList.add('lv-hide');
    function panel(on) {
      if (on && !cfg) { showCfg(true); return; }
      if (on && !S.open && lesson.pageOf) {           // 지금 보고 있는 쪽의 문항으로 바로 가기
        var pg = lesson.pageOf();
        for (var i = 0; i < items.length; i++) if (items[i].page === pg) { if (i !== S.cur) go(i); break; }
      }
      root.classList.toggle('lv-hide', !on);
      if (on) renderAll();
      if (follow) sendState();                         // 학생 화면도 질문 창 ↔ 수업 화면을 같이 바꿔요
    }
    function panelOn() { return !root.classList.contains('lv-hide'); }
    // 학생들 시뮬레이션을 선생님이 보고 있는 쪽으로 옮기기 (그 뒤엔 학생이 자유롭게 넘겨 볼 수 있음)
    function pushPage(silent) {
      if (!net) { if (!silent) toast('먼저 서버에 연결해 주세요'); return; }
      var pg = lesson.pageOf ? lesson.pageOf() : 0, st = lesson.stepOf ? lesson.stepOf() : 0;
      if (silent && S.go && S.go.p === pg && S.go.k === st) return;
      S.go = { p: pg, k: st, s: ((S.go && S.go.s) || 0) + 1 }; save(); sendState();
      if (!silent) toast('학생 화면을 ' + (pg + 1) + '쪽으로 옮겼어요');
    }
    /* 함께 넘기기: 선생님이 쪽(또는 클릭 단계)을 넘기면 학생 화면도 따라와요 (lesson.follow 일 때) */
    var canFollow = embed && !!lesson.studentSim && !!lesson.follow;
    var follow = canFollow && LS.get('lv-follow', true) !== false;
    var followTm = 0;
    Live.pageChanged = function () { if (follow) { clearTimeout(followTm); followTm = setTimeout(function () { pushPage(true); }, 120); } };
    var followBtns = [];
    function followBtn() {
      var b = h('button', { class: 'lv-btn', title: '켜 두면 선생님이 넘기는 대로 학생 화면도 같이 넘어가요', onclick: function () {
        follow = !follow; LS.set('lv-follow', follow); syncFollow();
        if (follow) { pushPage(true); sendState(); toast('함께 넘기기 켬 · 학생 화면이 선생님을 따라와요'); }
        else toast('함께 넘기기 끔 · 학생이 자유롭게 넘겨 봐요');
      } });
      followBtns.push(b); return b;
    }
    function syncFollow() { followBtns.forEach(function (b) { b.textContent = follow ? '🔗 함께 넘기기' : '🔓 따로 보기'; b.classList.toggle('on', follow); }); }
    // 수업 페이지(시뮬레이션)의 키보드 단축키가 실시간 창에서 눌린 키에 반응하지 않게
    root.addEventListener('keydown', function (e) { e.stopPropagation(); });

    /* 음악 단추와 설정 창 */
    var musBtn = h('button', { class: 'lv-btn lv-icon lv-mus', title: '수업 음악 (M)', onclick: function (e) { e.stopPropagation(); musicPop(this); } }, [h('span', { text: '🎵' })]);
    var musPop = null;
    Music.onChange(function (on) { musBtn.classList.toggle('on', on); if (musPop) musPop._sync(); });
    function musicPop(anchor) {
      if (musPop) { musPop.remove(); musPop = null; return; }
      var P = Music.prefs;
      var big = h('button', { class: 'lv-btn pri', style: 'font-size:1.15em;padding:.5em', onclick: function () {
        if (P.style === 'file' && !Music.hasFile()) { fileIn.click(); return; } Music.toggle(); } });
      var segs = [['calm', '잔잔하게'], ['lively', '경쾌하게'], ['file', '내 음악 파일']].map(function (x) {
        return h('button', { 'data-s': x[0], text: x[1], onclick: function () {
          if (x[0] === 'file' && !Music.hasFile()) { fileIn.click(); return; }
          Music.setStyle(x[0]); sync(); } });
      });
      var fileIn = h('input', { type: 'file', accept: 'audio/*', style: 'display:none', onchange: function () { if (this.files[0]) { Music.setFile(this.files[0]); Music.start(); sync(); } } });
      var fileLab = h('div', { class: 'hint' });
      var vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(P.vol), oninput: function () { Music.setVol(+this.value); } });
      var auto = h('input', { type: 'checkbox', checked: !!P.auto, onchange: function () { Music.setAuto(this.checked); } });
      var tada = h('input', { type: 'checkbox', checked: !!P.tada, onchange: function () { Music.setTada(this.checked); if (this.checked) Music.tada(); } });
      function sync() {
        big.textContent = Music.isOn() ? '■ 음악 끄기' : '▶ 음악 켜기';
        big.className = 'lv-btn ' + (Music.isOn() ? 'red' : 'pri');
        segs.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-s') === P.style); });
        fileLab.textContent = Music.hasFile() ? '🎧 ' + Music.fileName() + ' (다른 파일은 「내 음악 파일」을 한 번 더)' : '';
        fileLab.style.display = Music.hasFile() ? '' : 'none';
      }
      segs[2].addEventListener('dblclick', function () { fileIn.click(); });
      musPop = h('div', { class: 'lv-pop', onclick: function (e) { e.stopPropagation(); } }, [
        h('b', { text: '🎵 수업 음악' }), big,
        h('div', { class: 'seg' }, segs), fileLab, fileIn,
        h('label', null, ['🔈', vol, '🔊']),
        h('label', null, [auto, '문항을 열면 음악, 마감하면 조용히']),
        h('label', null, [tada, '결과가 나올 때 「짜잔」 (마감·정답 공개·결과 보이기)']),
        h('div', { class: 'hint', text: '음악은 이 컴퓨터(교실 스피커)에서만 나와요. 학생 기기에서는 소리가 나지 않아요. 잔잔하게·경쾌하게는 브라우저가 그 자리에서 만드는 음악이라 저작권 걱정이 없어요. 내 음악 파일은 이 컴퓨터 밖으로 나가지 않고, 새로 고치면 다시 골라야 해요. 단축키 M' })
      ]);
      musPop._sync = sync;
      document.body.appendChild(musPop); sync();
      var r = anchor.getBoundingClientRect();
      musPop.style.top = Math.round(r.bottom + 6) + 'px';
      musPop.style.left = Math.max(8, Math.min(innerWidth - musPop.offsetWidth - 8, r.right - musPop.offsetWidth)) + 'px';
      setTimeout(function () { document.addEventListener('click', function off() { if (musPop) { musPop.remove(); musPop = null; } document.removeEventListener('click', off); }); }, 0);
    }
    // 「내 음악 파일」을 이미 골랐을 때 다른 파일로 바꾸기

    /* 위쪽 막대 */
    var dot = h('span', { class: 'lv-dot' });
    var cnt = h('span', { text: '0' });
    var codeEl = h('span', { class: 'lv-code', title: 'QR 크게 보기', onclick: function () { showQR(true); } });
    var listBtn = h('button', { class: 'lv-btn lv-icon', title: '문항 목록', text: '☰', onclick: function () { list.classList.toggle('hide'); renderRes(); } });
    var bar = h('div', { class: 'lv-bar' }, [
      listBtn,
      h('div', { class: 'lv-title', text: lesson.title || '실시간 수업' }),
      h('span', { class: 'lv-chip', title: '연결 상태 · 들어온 학생 수' }, [dot, '👥 ', cnt]),
      h('span', { class: 'lv-chip' }, ['코드 ', codeEl]),
      h('button', { class: 'lv-btn', text: 'QR', onclick: function () { showQR(true); } }),
      h('button', { class: 'lv-btn', text: 'CSV 저장', onclick: csv }),
      PV == null ? musBtn : null,
      editable ? h('button', { class: 'lv-btn lv-icon', title: '이 퀴즈 고치기 (퀴즈 만들기에서 열기)', text: '✏️', onclick: function () { window.open('maker.html#edit=' + encodeURIComponent(myFile), '_blank'); } }) : null,
      h('button', { class: 'lv-btn lv-icon', title: '설정', text: '⚙', onclick: function () { showCfg(true); } }),
      fsButton(),
      embed && lesson.studentSim ? (canFollow ? followBtn() : h('button', { class: 'lv-btn', text: '👀 학생도 이 쪽', title: '학생들 시뮬레이션을 지금 쪽으로 옮기기', onclick: function () { pushPage(); } })) : null,
      embed ? h('button', { class: 'lv-btn pri', text: (lesson.backLabel || '수업 화면') + ' ✕', title: '실시간 창 닫기', onclick: function () { panel(false); } }) : null
    ]);

    /* 끼워 넣기 모드: 수업 페이지에 붙는 작은 단추 */
    var fabDot = h('span', { class: 'lv-dot' }), fabCnt = h('span', { text: '0' }), fabCode = h('span', { class: 'lv-code', text: '------' });
    if (embed) {
      var fab = h('span', { class: 'lv-fab' }, [
        h('button', { class: 'lv-btn', title: 'QR 크게 보기', onclick: function () { if (!cfg) showCfg(true); else showQR(true); } }, [fabDot, ' 👥', fabCnt, ' · ', fabCode]),
        lesson.studentSim ? (canFollow ? followBtn() : h('button', { class: 'lv-btn', text: '👀 학생도 이 쪽', title: '학생들 시뮬레이션을 지금 쪽으로 옮기기', onclick: function () { pushPage(); } })) : null,
        h('button', { class: 'lv-btn pri', text: '📡 질문', title: '실시간 질문 창 열기', onclick: function () { panel(true); } })
      ]);
      var host = lesson.mountBefore && $(lesson.mountBefore);   // 이 요소 바로 앞에 단추를 넣어요
      if (host) host.parentNode.insertBefore(fab, host);
      else { fab.classList.add('float'); document.body.appendChild(fab); }
    }

    syncFollow();
    var list = h('div', { class: 'lv-list' });
    var qnum = h('div', { class: 'lv-qnum' });
    var qtext = h('div', { class: 'lv-qtext' });
    var qimg = h('img', { class: 'lv-qimg', alt: '', title: '누르면 화면 가득 크게', onclick: function () { zoomImg(this.src); } });
    var stateEl = h('span', { class: 'lv-state' });
    var btnPrev = h('button', { class: 'lv-btn', text: '◀ 이전', onclick: function () { go(S.cur - 1); } });
    var btnOpen = h('button', { class: 'lv-btn pri', onclick: toggleOpen });
    var btnNext = h('button', { class: 'lv-btn', text: '다음 ▶', onclick: function () { go(S.cur + 1); } });
    var btnVeil = h('button', { class: 'lv-btn', text: '결과 가리기', onclick: function () { S.veil = !S.veil; save(); renderStage(); if (!S.veil && PV == null) { Music.stop(); setTimeout(Music.tada, 150); } } });
    var btnReveal = h('button', { class: 'lv-btn', text: '정답 공개', onclick: toggleReveal });
    var btnShowHidden = h('button', { class: 'lv-btn', onclick: unhideAll });
    var btnClear = h('button', { class: 'lv-btn', text: '이 문항 답 지우기', onclick: clearCur });
    var btnPic = h('button', { class: 'lv-btn', onclick: function () { S.pic = !S.pic; save(); renderStage(); } });
    var tally = h('span', { class: 'lv-chip' });
    var res = h('div', { class: 'lv-res' });
    var exEl = h('div', { class: 'lv-ex', title: '누르면 크게', onclick: function () {
      var it = curItem(); if (!it || !it.example) return;
      var tx = h('div', { class: 'lv-bigtx', text: it.example });
      var ov = h('div', { class: 'lv-ov on', title: '누르면 닫혀요', style: 'cursor:zoom-out' }, [h('div', { class: 'lv-ovbar' }, [h('span', { class: 'lv-chip', text: '💡 예시 답' })]), h('div', { class: 'lv-bigcard' }, [tx])]);
      function close() { ov.remove(); document.removeEventListener('keydown', esc, true); }
      function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } }
      ov.addEventListener('click', close); document.addEventListener('keydown', esc, true);
      document.body.appendChild(ov);
      fit(tx, Math.min(innerHeight * 0.14, innerWidth * 0.08), 18);
    } });
    var stage = h('div', { class: 'lv-stage' }, [
      h('div', { class: 'lv-qhead' }, [qnum, qtext, qimg]),
      h('div', { class: 'lv-ctl' }, [btnPrev, btnOpen, btnNext, stateEl, tally, h('span', { class: 'sp' }), btnPic, btnVeil, btnReveal, btnShowHidden, btnClear]),
      exEl,
      res
    ]);
    root.appendChild(bar);
    root.appendChild(h('div', { class: 'lv-main' }, [list, stage]));
    root.appendChild(h('div', { class: 'lv-copy', text: COPY + ' · live.js v' + VERSION }));

    /* QR 화면 */
    var qrCanvas = h('canvas');
    var qrBig = h('div', { class: 'lv-big' });
    var qrCnt = h('div', { class: 'lv-lab' });
    var qrOv = h('div', { class: 'lv-ov' }, [
      h('div', { class: 'lv-ovbar' }, [
        h('button', { class: 'lv-btn', text: '새 수업 코드', onclick: newSession }),
        fsButton(),
        h('button', { class: 'lv-btn pri', text: '수업 시작 ▶', onclick: function () { showQR(false); } })
      ]),
      h('div', { class: 'lv-qrwrap' }, [
        h('div', { class: 'lv-qrbox' }, [qrCanvas]),
        h('div', { class: 'lv-qrside' }, [
          h('div', { class: 'lv-lab', text: '카메라로 QR을 찍어 들어오세요' }),
          h('div', { class: 'lv-lab', text: '수업 코드' }),
          qrBig,
          qrCnt,
          h('button', { class: 'lv-btn', text: '학생 링크 복사', onclick: copyLink }),
          h('button', { class: 'lv-btn', text: '학생 화면 새 탭으로 열기', onclick: function () { window.open(studentLink(), '_blank'); } })
        ])
      ])
    ]);
    document.body.appendChild(qrOv);

    /* 크게 보기 */
    var bigTx = h('div', { class: 'lv-bigtx' });
    var bigInfo = h('span', { class: 'lv-chip' });
    var bigIdx = -1;
    var bigOv = h('div', { class: 'lv-ov' }, [
      h('div', { class: 'lv-ovbar' }, [
        bigInfo, h('span', { style: 'flex:1' }),
        h('button', { class: 'lv-btn red', text: '이 카드 숨기기', onclick: function () { var v = visibleCards(); if (v[bigIdx]) { hideCard(v[bigIdx].sid); if (!visibleCards().length) closeBig(); else showBig(Math.min(bigIdx, visibleCards().length - 1)); } } }),
        fsButton(),
        h('button', { class: 'lv-btn pri', text: '닫기 ✕', onclick: closeBig })
      ]),
      h('div', { class: 'lv-bigcard' }, [
        h('button', { class: 'lv-arrow', text: '‹', onclick: function () { showBig(bigIdx - 1); } }),
        bigTx,
        h('button', { class: 'lv-arrow', text: '›', onclick: function () { showBig(bigIdx + 1); } })
      ])
    ]);
    document.body.appendChild(bigOv);

    /* 설정 화면 */
    var inUrl = h('input', { class: 'lv-in', placeholder: 'https://abcdefgh.supabase.co', autocomplete: 'off', spellcheck: 'false' });
    var inKey = h('input', { class: 'lv-in', placeholder: 'eyJ… 또는 sb_publishable_…', autocomplete: 'off', spellcheck: 'false' });
    var inMeta = h('input', { type: 'checkbox' });
    var cfgErr = h('div', { class: 'lv-err' });
    var cfgClose = h('button', { class: 'lv-btn', text: '닫기', onclick: function () { showCfg(false); } });
    var cfgOv = h('div', { class: 'lv-ov' }, [
      h('div', { class: 'lv-form' }, [
        h('h2', { text: '⚙ 서버 설정' }),
        h('p', { text: '내 Supabase 프로젝트의 주소와 "공개 키"를 넣어요. 이 정보는 이 컴퓨터에만 기억되고, 학생 QR·링크에 함께 담겨요. 비밀 키(service_role, sb_secret_)는 절대 넣지 마세요 — 넣으면 거부돼요.' }),
        h('label', null, ['Supabase 주소 (Project URL)', inUrl]),
        h('label', null, ['공개 키 (anon 또는 publishable)', inKey]),
        h('label', { class: 'lv-check' }, [inMeta, '서술형 카드에 반·번호 보이기 (기본: 숨김)']),
        cfgErr,
        h('div', { class: 'row' }, [
          h('button', { class: 'lv-btn pri', text: '저장하고 연결', onclick: saveCfg }),
          h('button', { class: 'lv-btn', text: '연습 모드 (이 컴퓨터 탭끼리만)', onclick: function () { cfg = { demo: true }; LS.set(CFGKEY, cfg); S.showMeta = inMeta.checked; save(); showCfg(false); start(); showQR(true); } }),
          h('button', { class: 'lv-btn', text: '설정 지우기', onclick: function () { LS.del(CFGKEY); cfg = null; inUrl.value = ''; inKey.value = ''; cfgErr.textContent = '지웠어요.'; } }),
          cfgClose
        ]),
        h('p', { text: '학생 답은 서버에 저장되지 않고 주고받기만 해요. 선생님 화면을 새로 고쳐도 이 컴퓨터에 남아 있고, "새 수업 코드"를 누르면 지워져요.' }),
        h('p', { text: COPY })
      ])
    ]);
    document.body.appendChild(cfgOv);

    function showCfg(on) {
      if (on) {
        inUrl.value = cfg && !cfg.demo ? cfg.url : '';
        inKey.value = cfg && !cfg.demo ? cfg.key : '';
        inMeta.checked = !!S.showMeta;
        cfgErr.textContent = cfg && cfg.demo ? '지금은 연습 모드예요.' : '';
        cfgClose.style.display = cfg || embed ? '' : 'none';
      }
      cfgOv.classList.toggle('on', on);
    }
    function saveCfg() {
      var p = keyProblem(inUrl.value, inKey.value);
      if (p) { cfgErr.textContent = p; return; }
      cfg = { url: inUrl.value.trim().replace(/\/$/, ''), key: inKey.value.trim() };
      LS.set(CFGKEY, cfg);
      S.showMeta = inMeta.checked; save();
      showCfg(false); start(); showQR(true);
    }

    /* 학생 링크 */
    function studentLink() {
      var q = new URLSearchParams();
      q.set('join', S.code);
      if (cfg.demo) q.set('demo', '1');
      else { var pu = packUrl(cfg.url); for (var k in pu) q.set(k, pu[k]); q.set('k', cfg.key); }
      if (S.keys) q.set('p', S.keys.pub);
      // # 뒤에 담으면 주소창 정보가 GitHub 서버로 전송되지 않아요
      return location.origin + location.pathname + '#' + q.toString();
    }
    function copyLink() {
      var t = studentLink();
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('학생 링크를 복사했어요'); }, function () { prompt('이 링크를 복사하세요', t); });
    }
    function drawQR() {
      qrBig.textContent = S.code;
      codeEl.textContent = fabCode.textContent = S.code;
      var text = studentLink();
      var ctx = qrCanvas.getContext('2d');
      var go = function () {
        try {
          var qr = window.qrcode(0, 'L'); qr.addData(text); qr.make();
          var n = qr.getModuleCount(), q = 4, sc = Math.max(4, Math.floor(1024 / (n + q * 2)));
          qrCanvas.width = qrCanvas.height = (n + q * 2) * sc;
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, qrCanvas.width, qrCanvas.height);
          ctx.fillStyle = '#000';
          for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + q) * sc, (r + q) * sc, sc, sc);
        } catch (e) { toast('QR을 못 만들었어요. 링크 복사를 써 주세요.'); }
      };
      if (window.qrcode) go(); else loadScript(QR_CDN).then(go, function () { toast('QR 도구를 못 불러왔어요. 링크 복사를 써 주세요.'); });
    }
    function showQR(on) { if (on) drawQR(); qrOv.classList.toggle('on', on); }

    function newSession() {
      if (!confirm('새 수업 코드를 만들까요?\n지금까지 모은 답은 이 컴퓨터에서 지워져요. (먼저 CSV 저장을 권해요)')) return;
      var showMeta = S.showMeta;
      S = fresh(); S.showMeta = showMeta; seen = {}; save();
      start();
      drawQR();
    }

    /* 연결 */
    function setStatus(st) {
      status = st; dot.className = fabDot.className = 'lv-dot ' + st;
      dot.title = { ok: '연결됨', wait: '연결 중…', err: '연결 오류 — 주소·키·Realtime 설정을 확인하세요', off: '끊김' }[st] || '';
      if (st === 'ok') sendState();
      if (st === 'err') toast('서버 연결 오류: 설정의 주소·공개 키를 확인해 주세요', 4000);
    }
    function start() {
      if (net) { net.close(); net = null; }
      var p = Promise.resolve();
      if (HAS_CRYPTO && !S.keys) p = makeKeys().then(function (k) { S.keys = k; save(); });
      p = p.then(function () { return HAS_CRYPTO && S.keys ? signer(S.keys.priv).then(function (f) { sign = f; }) : null; })
        .catch(function () { sign = null; });
      p.then(function () {
        codeEl.textContent = fabCode.textContent = S.code;
        return connect(cfg, S.code, onMsg, setStatus);
      }).then(function (n) { net = n; sendState(); }, function (e) { setStatus('err'); toast(e.message, 4000); });
      renderAll();
    }

    function curItem() { return items[S.cur]; }
    function sendState() {
      if (!net) return;
      var it = curItem();
      S.seq = Math.max(S.seq + 1, Date.now()); save();
      var d = {
        seq: S.seq, title: lesson.title || '', total: items.length, go: S.go || null, view: follow ? (panelOn() ? 'q' : 'sim') : null,
        cur: it ? { qid: it.qid, n: S.cur + 1, type: it.type, q: it.q, img: it.img && it.img.length < 2000 ? it.img : null, options: it.options || null, open: !!S.open, ans: S.reveal[it.qid] ? it.answer : null, ex: it.type === 'text' && S.reveal[it.qid] ? it.example : null } : null
      };
      var str = JSON.stringify(d);
      (sign ? sign(str) : Promise.resolve(null)).then(function (sig) { net && net.send({ t: 'state', d: str, sig: sig }); });
    }

    function onMsg(m) {
      if (!m || typeof m !== 'object' || typeof m.sid !== 'string' || m.sid.length > 20) return;
      var now = Date.now();
      var first = !seen[m.sid] || now - seen[m.sid] > 40000;
      seen[m.sid] = now;
      if (m.t === 'hi') { if (m.need || first) sendState(); updCount(); return; }
      if (m.t !== 'ans') return;
      var it = curItem();
      if (!it || m.qid !== it.qid || !S.open) { net.send({ t: 'nack', sid: m.sid, qid: m.qid }); return; }
      var v = m.v;
      if (it.type === 'choice') { v = Number(v); if (!(v >= 0 && v < it.options.length && v === Math.floor(v))) return; }
      else { v = String(v == null ? '' : v).replace(/\s+$/, '').slice(0, MAX_TEXT); if (!v.trim()) return; }
      var cls = String(m.c || '').replace(/\D/g, '').slice(0, 2), num = String(m.n || '').replace(/\D/g, '').slice(0, 3);
      var A = S.answers[it.qid] || (S.answers[it.qid] = {});
      var prev = A[m.sid];
      A[m.sid] = { v: v, c: cls, n: num, t: now, h: prev && prev.v === v ? prev.h : false, isNew: !prev };
      save();
      net.send({ t: 'ack', sid: m.sid, qid: it.qid });
      updCount(); renderList();
      scheduleRes();
    }
    var resTimer = null;
    function scheduleRes() { if (resTimer) return; resTimer = setTimeout(function () { resTimer = null; renderStage(); }, 250); }
    function updCount() {
      var now = Date.now(), n = 0;
      for (var k in seen) if (now - seen[k] < 45000) n++;
      cnt.textContent = fabCnt.textContent = n;
      qrCnt.textContent = '들어온 학생 ' + n + '명';
    }
    setInterval(updCount, 5000);

    /* 문항 이동·열기 */
    function go(i) {
      if (i < 0 || i >= items.length || i === S.cur) return;
      if (S.open && Music.prefs.auto) Music.stop();
      S.cur = i; S.open = false; S.veil = false; S.pic = false; save();
      sendState(); renderAll();
    }
    function toggleOpen() {
      S.open = !S.open; save(); sendState(); renderAll();
      if (PV != null) return;
      if (Music.prefs.auto) { if (S.open) Music.start(); else Music.stop(); }
      if (!S.open && !S.veil) setTimeout(Music.tada, Music.prefs.auto ? 350 : 0);   // 마감 = 결과가 나와요
    }
    function toggleReveal() {
      var it = curItem(); if (!it || (it.answer == null && !it.example)) return;
      S.reveal[it.qid] = !S.reveal[it.qid]; if (S.reveal[it.qid]) S.veil = false; save(); sendState(); renderStage();
      if (S.reveal[it.qid] && PV == null) { Music.stop(); setTimeout(Music.tada, 150); }
    }
    function clearCur() {
      var it = curItem(); if (!it) return;
      if (!confirm('이 문항에 모인 답을 지울까요?')) return;
      delete S.answers[it.qid]; save(); renderAll();
    }
    function hideCard(sid) { var A = S.answers[curItem().qid]; if (A && A[sid]) { A[sid].h = true; save(); renderStage(); } }
    function unhideAll() { var A = S.answers[curItem().qid] || {}; for (var k in A) A[k].h = false; save(); renderStage(); }

    /* 그리기 */
    function renderAll() { renderList(); renderStage(); }
    function renderList() {
      list.innerHTML = '';
      items.forEach(function (it, i) {
        var n = Object.keys(S.answers[it.qid] || {}).length;
        list.appendChild(h('button', { class: 'lv-li' + (i === S.cur ? ' cur' : '') + (i === S.cur && S.open ? ' open' : ''), onclick: function () { go(i); } }, [
          h('span', { class: 'n', text: (i + 1) + (it.type === 'text' ? ' ✎' : ' ●') }),
          h('span', { class: 'q', text: it.q }),
          h('span', { class: 'c', text: n ? n + '명' : '' })
        ]));
      });
    }
    var picMode = false;
    function fitQ() { fit(qtext, Math.min(84, innerHeight * 0.08, innerWidth * 0.05), 14); }
    function renderStage() {
      var it = curItem();
      if (!it) { qtext.textContent = '문항이 없어요. 수업 HTML의 items에 문항을 넣어 주세요.'; return; }
      qnum.textContent = 'Q' + (S.cur + 1) + '/' + items.length;
      qtext.textContent = it.q;
      var nAns = Object.keys(S.answers[it.qid] || {}).length;
      picMode = !!it.img && (!nAns || !!S.pic);       // 답이 오기 전에는 그림을 크게
      if (it.img && !picMode) { if (qimg.getAttribute('src') !== it.img) qimg.src = it.img; qimg.style.display = ''; } else qimg.style.display = 'none';
      btnPic.style.display = it.img && nAns ? '' : 'none';
      btnPic.textContent = S.pic ? '📊 결과 보기' : '🖼 그림 크게';
      fitQ();
      qimg.onload = fitQ;                              // 그림이 늦게 뜨면 글자 크기를 다시 맞춰요
      btnPrev.disabled = S.cur === 0; btnNext.disabled = S.cur === items.length - 1;
      btnOpen.textContent = S.open ? '■ 마감하기' : '▶ 학생에게 열기';
      btnOpen.className = 'lv-btn ' + (S.open ? 'red' : 'pri');
      stateEl.textContent = S.open ? '받는 중' : '닫힘';
      stateEl.className = 'lv-state' + (S.open ? ' open' : '');
      var A = S.answers[it.qid] || {};
      var all = Object.keys(A);
      tally.textContent = '답 ' + all.length + '개';
      btnVeil.textContent = S.veil ? '결과 보이기' : '결과 가리기';
      btnVeil.classList.toggle('on', !!S.veil);
      var isText = it.type === 'text';
      btnReveal.style.display = (!isText && it.answer != null) || (isText && it.example) ? '' : 'none';
      btnReveal.textContent = isText ? (S.reveal[it.qid] ? '예시 답 감추기' : '💡 예시 답 공개') : (S.reveal[it.qid] ? '정답 감추기' : '정답 공개');
      var showEx = isText && it.example && S.reveal[it.qid];
      exEl.style.display = showEx ? '' : 'none';
      if (showEx) {
        exEl.innerHTML = ''; exEl.appendChild(h('b', { text: '💡 예시 답 (누르면 크게)' })); exEl.appendChild(document.createTextNode(it.example));
        fit(exEl, Math.min(48, innerHeight * 0.045), 14);
      }
      var hid = all.filter(function (k) { return A[k].h; }).length;
      btnShowHidden.style.display = it.type === 'text' && hid ? '' : 'none';
      btnShowHidden.textContent = '숨긴 카드 ' + hid + '개 다시 보기';
      btnClear.style.display = all.length ? '' : 'none';
      renderRes();
    }
    function renderRes() {
      var it = curItem(); if (!it) return;
      var A = S.answers[it.qid] || {};
      res.innerHTML = '';
      var keys = Object.keys(A);
      var waitCap = keys.length ? '답 ' + keys.length + '개 · 📊 결과 보기를 누르면 결과가 나와요' : (S.open ? '학생들의 답을 기다리고 있어요…' + (it.img ? ' (그림을 누르면 화면 가득)' : '') : '"▶ 학생에게 열기"를 누르면 학생 화면에 이 문항이 나타나요');
      // 고르기 문항은 답이 오기 전(또는 그림 크게 보기)에 보기를 크게 보여 줘요
      if (it.type === 'choice' && (!keys.length || (picMode && it.img))) {
        var land = res.clientWidth > res.clientHeight * 1.15;
        var tiles = h('div', { class: 'lv-tiles' });
        var cols = it.img ? (land ? 1 : 2) : (land && it.options.length > 2 ? 2 : 1);
        if (it.img && land && it.options.length > 4) cols = 2;
        tiles.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)';
        it.options.forEach(function (o, i) {
          var cls = 'lv-tile', st = 'border-left:.45em solid ' + COLORS[i % COLORS.length];
          if (S.reveal[it.qid]) { if (i === it.answer) { cls += ''; st += ';border-color:var(--lv-ok);background:#123a24'; } else st += ';opacity:.4'; }
          tiles.appendChild(h('div', { class: cls, style: st }, [h('span', { class: 'mk', text: MARKS[i] }), h('span', { text: o })]));
        });
        var bodyKids = it.img ? [h('div', { class: 'pimg' }, [h('img', { src: it.img, alt: '', title: '누르면 화면 가득 크게', onclick: function () { zoomImg(it.img); } })]), tiles] : [tiles];
        var bodyEl = h('div', { class: 'body' }, bodyKids);
        if (it.img && !land) bodyEl.style.flexDirection = 'column';
        res.appendChild(h('div', { class: 'lv-pre' }, [bodyEl, h('div', { class: 'cap', text: waitCap })]));
        var tf = Math.min(60, innerHeight * 0.06, innerWidth * 0.04);
        Array.prototype.forEach.call(tiles.children, function (t) { fit(t, tf, 12); });
        return;
      }
      // 서술형도 답이 오기 전에는 학생이 보는 답란을 보여 줘요 (그림은 왼쪽에 작게, 누르면 크게)
      if (it.type === 'text' && (!keys.length || (picMode && it.img))) {
        var landT = res.clientWidth > res.clientHeight * 1.15;
        var mbox = h('div', { class: 'box', text: '✎ 학생들은 여기에 생각을 적어 보내요\n(400자까지)' });
        mbox.style.whiteSpace = 'pre-line';
        var mock = h('div', { class: 'lv-mock' }, [mbox, h('div', { class: 'send', text: '보내기' })]);
        var kidsT = it.img ? [h('div', { class: 'pimg' }, [h('img', { src: it.img, alt: '', title: '누르면 화면 가득 크게', onclick: function () { zoomImg(it.img); } })]), mock] : [mock];
        var bodyT = h('div', { class: 'body' }, kidsT);
        if (it.img && !landT) bodyT.style.flexDirection = 'column';
        res.appendChild(h('div', { class: 'lv-pre' }, [bodyT, h('div', { class: 'cap', text: waitCap + (it.example ? ' · 💡 예시 답이 준비돼 있어요' : '') })]));
        var mf = Math.min(46, innerHeight * 0.05, innerWidth * 0.032);
        fit(mbox, mf, 12); mock.lastChild.style.fontSize = Math.max(16, mf * 0.8) + 'px';
        return;
      }
      if (picMode && it.img) {
        res.appendChild(h('div', { class: 'lv-pic' }, [
          h('img', { src: it.img, alt: '', title: '누르면 화면 가득 크게', onclick: function () { zoomImg(it.img); } }),
          h('div', { class: 'cap', text: waitCap })
        ]));
        return;
      }
      if (!keys.length) {
        res.appendChild(h('div', { class: 'lv-empty', text: S.open ? '학생들의 답을 기다리고 있어요…' : '"▶ 학생에게 열기"를 누르면 학생 화면에 이 문항이 나타나요' }));
        return;
      }
      if (S.veil) res.appendChild(h('div', { class: 'lv-veil', text: '🙈 결과를 가렸어요 · 답 ' + keys.length + '개' }));
      if (it.type === 'choice') drawBars(it, A, keys); else drawCards(it, A);
    }
    function drawBars(it, A, keys) {
      var counts = it.options.map(function () { return 0; });
      keys.forEach(function (k) { counts[A[k].v]++; });
      var max = Math.max.apply(null, counts.concat([1]));
      var rev = S.reveal[it.qid];
      var wrap = h('div', { class: 'lv-bars' }), fils = [];
      it.options.forEach(function (o, i) {
        var pct = Math.round(counts[i] * 100 / keys.length);
        var fil = h('div', { class: 'fil', style: 'background:' + COLORS[i % COLORS.length] });
        wrap.appendChild(h('div', { class: 'lv-row' + (rev ? (i === it.answer ? ' right' : ' dim') : '') }, [
          h('div', { class: 'lv-lb', text: MARKS[i] + ' ' + o }),
          h('div', { class: 'trk' }, [fil]),
          h('div', { class: 'num' }, [String(counts[i]), h('small', { text: pct + '%' })])
        ]));
        fils.push([fil, counts[i] / max * 100]);
      });
      res.appendChild(wrap);
      void wrap.offsetWidth; // 자리 잡은 뒤 막대가 자라도록
      fils.forEach(function (f) { f[0].style.width = f[1] + '%'; });
    }
    function visibleCards() {
      var it = curItem(), A = S.answers[it.qid] || {};
      return Object.keys(A).filter(function (k) { return !A[k].h; })
        .map(function (k) { return { sid: k, a: A[k] }; })
        .sort(function (x, y) { return x.a.t - y.a.t; });
    }
    function meta(a) { return S.showMeta && (a.c || a.n) ? (a.c ? a.c + '반 ' : '') + (a.n ? a.n + '번' : '') : ''; }
    function drawCards() {
      var v = visibleCards();
      if (!v.length) { res.appendChild(h('div', { class: 'lv-empty', text: '모든 카드를 숨겼어요' })); return; }
      var W = res.clientWidth, H = res.clientHeight, n = v.length, gap = 10;
      var best = { s: -1, c: 1 };
      for (var c = 1; c <= n; c++) {
        var r = Math.ceil(n / c), cw = (W - gap * (c - 1)) / c, ch = (H - gap * (r - 1)) / r;
        var s = Math.min(cw / 1.7, ch);
        if (s > best.s) best = { s: s, c: c, ch: ch, cw: cw };
      }
      var minH = 110, scroll = best.ch < minH;
      var grid = h('div', { class: 'lv-cards' });
      if (scroll) {
        grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + Math.max(170, Math.min(320, W / 5)) + 'px,1fr))';
        grid.style.gridAutoRows = minH + 'px';
      } else {
        grid.style.gridTemplateColumns = 'repeat(' + best.c + ',1fr)';
        grid.style.gridAutoRows = Math.floor(best.ch) + 'px';
      }
      var cards = [];
      v.forEach(function (x, i) {
        var tx = h('div', { class: 'tx', text: x.a.v });
        var m = meta(x.a);
        var card = h('div', { class: 'lv-card' + (x.a.isNew ? ' new' : ''), title: '클릭하면 크게 보여요', onclick: function () { showBig(i); } }, [
          tx, m ? h('div', { class: 'mt', text: m }) : null,
          h('button', { class: 'x', title: '이 카드 숨기기', text: '✕', onclick: function (e) { e.stopPropagation(); hideCard(x.sid); } })
        ]);
        x.a.isNew = false;
        grid.appendChild(card); cards.push(tx);
      });
      res.appendChild(grid);
      var maxF = scroll ? 22 : Math.min(64, best.ch * 0.3, best.cw * 0.12);
      cards.forEach(function (tx) { fit(tx, Math.max(14, maxF), 12); });
    }
    function showBig(i) {
      var v = visibleCards(); if (!v.length) return;
      bigIdx = (i + v.length) % v.length;
      var a = v[bigIdx].a;
      bigTx.textContent = a.v;
      bigInfo.textContent = (bigIdx + 1) + ' / ' + v.length + (meta(a) ? ' · ' + meta(a) : '');
      bigOv.classList.add('on');
      fit(bigTx, Math.min(innerHeight * 0.16, innerWidth * 0.09), 18);
    }
    function closeBig() { bigOv.classList.remove('on'); bigIdx = -1; }

    /* CSV */
    function csv() {
      var rows = [['문항번호', '유형', '질문', '반', '번호', '답', '정답여부', '보낸시각', '학생구분(익명)']];
      items.forEach(function (it, i) {
        var A = S.answers[it.qid] || {};
        Object.keys(A).sort(function (x, y) { return A[x].t - A[y].t; }).forEach(function (k) {
          var a = A[k], ans = it.type === 'choice' ? MARKS[a.v] + ' ' + it.options[a.v] : a.v;
          var ok = it.type === 'choice' && it.answer != null ? (a.v === it.answer ? 'O' : 'X') : '';
          var d = new Date(a.t);
          var ts = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
          rows.push([i + 1, it.type === 'choice' ? '객관식' : '서술형', it.q, a.c, a.n, ans, ok, ts, k.slice(0, 6)]);
        });
      });
      if (rows.length === 1) { toast('아직 모인 답이 없어요'); return; }
      var text = '﻿' + rows.map(function (r) { return r.map(cell).join(','); }).join('\r\n');
      var a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })), download: fname() });
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('CSV를 내려받았어요');
    }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function cell(v) {
      v = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; // 엑셀 수식 끼워넣기 방지
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    function fname() {
      var d = new Date();
      return (lesson.title || '수업').replace(/[\\/:*?"<>|]/g, '').slice(0, 30) + '_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + S.code + '.csv';
    }

    /* 키보드 */
    document.addEventListener('keydown', function (e) {
      if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (bigOv.classList.contains('on')) {
        if (e.key === 'ArrowLeft') showBig(bigIdx - 1);
        else if (e.key === 'ArrowRight') showBig(bigIdx + 1);
        else if (e.key === 'Escape') closeBig();
        return;
      }
      if (qrOv.classList.contains('on') || cfgOv.classList.contains('on')) { if (e.key === 'Escape' && cfg) { showQR(false); showCfg(false); } return; }
      if (embed && !panelOn()) return;                 // 수업 페이지의 키보드는 건드리지 않아요
      if (embed && e.key === 'Escape') { panel(false); return; }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(S.cur + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(S.cur - 1);
      else if (e.key === ' ') { e.preventDefault(); toggleOpen(); }
      else if (e.key === 'f' || e.key === 'F') fsToggle();
      else if ((e.key === 'm' || e.key === 'M') && PV == null) Music.toggle();
    });
    window.addEventListener('resize', function () { clearTimeout(stagger); stagger = setTimeout(renderStage, 150); });

    if (PV != null) { renderAll(); return; }
    if (embed) { renderAll(); if (cfg) start(); }
    else if (!cfg) { renderAll(); showCfg(true); }
    else { start(); showQR(true); }
  }

  /* ══════════════════════════════════════════
   *  학생 화면
   * ══════════════════════════════════════════ */
  function Student(lesson, q, PV) {   // PV: 퀴즈 만들기의 미리보기일 때 문항 번호
    lesson = lesson || {};
    // 그림은 서버로 보내지 않고, 학생 기기가 받은 수업 파일 안에서 꺼내 써요
    var localItems = normItems(lesson.items);
    function localImg(qid) { for (var i = 0; i < localItems.length; i++) if (localItems[i].qid === qid) return localItems[i].img; return null; }
    var sim = PV == null && !!lesson.studentSim;   // 학생도 수업 페이지(시뮬레이션)를 직접 조작
    var root = boot(lesson.title, { full: !sim, hideHost: !sim, colors: lesson.colors });
    root.addEventListener('keydown', function (e) { e.stopPropagation(); });
    function overlay(on) { if (sim) { root.classList.toggle('lv-hide', !on); fabQ && fabQ.classList.remove('lv-ping'); if (!on) ping(); } }
    function overlayOn() { return !root.classList.contains('lv-hide'); }
    var sid = SS.get('lv-sid', null);
    if (!sid) { sid = rand(10); SS.set('lv-sid', sid); }
    var me = LS.get('lv-me', { c: '', n: '' });
    var code = (q.get('join') || '').replace(/\D/g, '').slice(0, 6);
    var cfg = null, pub = q.get('p') || null;
    if (q.get('demo') === '1') cfg = { demo: true };
    else if (q.get('k')) cfg = { url: unpackUrl(q), key: q.get('k') };
    else if (window.LIVE_CONFIG && LIVE_CONFIG.url && LIVE_CONFIG.key) cfg = { url: LIVE_CONFIG.url, key: LIVE_CONFIG.key };

    var titleEl = h('div', { class: 'lv-title', text: (lesson && lesson.title) || '실시간 수업' });
    var dot = h('span', { class: 'lv-dot' });
    var codeChip = h('span', { class: 'lv-chip' }, [dot, ' ', h('span', { class: 'lv-code', text: code || '------' })]);
    root.appendChild(h('div', { class: 'lv-bar' }, [titleEl, codeChip, fsButton(),
      sim ? h('button', { class: 'lv-btn pri', text: (lesson.backLabel || '수업 화면') + ' ✕', onclick: function () { overlay(false); } }) : null]));
    var fabQ = null, fabDot = h('span', { class: 'lv-dot' });
    if (sim) {
      fabQ = h('button', { class: 'lv-btn pri', text: '📡 질문', title: '선생님 질문 보기', onclick: function () { overlay(true); } });
      var fab = h('span', { class: 'lv-fab' }, [h('span', { class: 'lv-chip' }, [fabDot, ' ', code || '------']), fabQ]);
      var host = lesson.mountBefore && $(lesson.mountBefore);
      if (host) host.parentNode.insertBefore(fab, host); else { fab.classList.add('float'); document.body.appendChild(fab); }
    }
    // 답해야 할 질문이 열려 있는데 시뮬레이션을 보고 있으면 단추를 깜빡이기
    function ping() {
      if (!fabQ) return;
      var c = state && state.cur;
      fabQ.classList.toggle('lv-ping', !!(c && c.open && !myAns[c.qid] && !overlayOn()));
    }
    var body = h('div', { class: 'lv-s' });
    root.appendChild(body);
    root.appendChild(h('div', { class: 'lv-copy', text: COPY }));

    var lastView = null;
    var net = null, verify = null, lastSeq = 0, lastGo = 0, popped = '', state = null, gotState = false, myAns = SS.get('lv-my:' + code, {}), pending = null, hiTimer = null;

    function screen(kids) { body.innerHTML = ''; kids.forEach(function (k) { if (k) body.appendChild(k); }); }

    if (PV != null) {                                  // 미리보기: 서버 없이 문항 화면만
      var pit = localItems[Math.min(PV, localItems.length - 1)];
      if (pit) { state = { cur: { qid: pit.qid, n: PV + 1, type: pit.type, q: pit.q, options: pit.options || null, open: true, ans: null } }; render(); }
      return;
    }
    if (cfg && !cfg.demo) {
      var p = keyProblem(cfg.url, cfg.key);
      if (p) { screen([h('div', { class: 'center' }, [h('div', { class: 'lv-msg', text: '이 링크로는 들어갈 수 없어요' }), h('div', { class: 'lv-sb', text: p })])]); return; }
    }

    if (!code) return askCode();
    if (!cfg) return screen([h('div', { class: 'center' }, [h('div', { class: 'lv-msg', text: '선생님 QR로 들어와 주세요' }), h('div', { class: 'lv-sb', text: '이 링크에는 서버 정보가 없어요. 선생님 화면의 QR을 찍거나 선생님이 보내 준 링크를 눌러 주세요.' })])]);
    askMe();

    function askCode() {
      var inp = h('input', { class: 'lv-in lv-codein', inputmode: 'numeric', maxlength: '6', placeholder: '000000', autocomplete: 'off' });
      var err = h('div', { class: 'lv-err' });
      screen([h('div', { class: 'lv-join' }, [
        h('div', { class: 'lv-msg', text: '수업 코드 6자리' }), inp, err,
        h('button', { class: 'lv-btn pri', text: '들어가기', onclick: function () {
          var c = inp.value.replace(/\D/g, '');
          if (c.length !== 6) { err.textContent = '숫자 6자리를 넣어 주세요'; return; }
          if (!cfg) { err.textContent = '선생님 QR로 들어와 주세요 (이 페이지에 서버 정보가 없어요)'; return; }
          var nq = new URLSearchParams(location.hash.slice(1)); nq.set('join', c);
          location.hash = nq.toString(); location.reload();
        } })
      ])]);
      inp.focus();
    }

    function askMe() {
      var c = h('input', { class: 'lv-in', inputmode: 'numeric', maxlength: '2', placeholder: '반', value: me.c || '' });
      var n = h('input', { class: 'lv-in', inputmode: 'numeric', maxlength: '3', placeholder: '번호', value: me.n || '' });
      function go(useIt) {
        me = useIt ? { c: c.value.replace(/\D/g, ''), n: n.value.replace(/\D/g, '') } : { c: '', n: '' };
        LS.set('lv-me', me);
        join();
      }
      screen([h('div', { class: 'lv-join' }, [
        h('div', { class: 'lv-msg', text: '이름은 적지 않아요' }),
        h('div', { class: 'lv-sb', text: '반·번호는 적고 싶을 때만 적어요. 비워 두고 들어가도 돼요.' }),
        h('div', { class: 'two' }, [c, n]),
        h('button', { class: 'lv-btn pri', text: '들어가기', onclick: function () { go(true); } }),
        h('button', { class: 'lv-btn', text: '반·번호 없이 들어가기', onclick: function () { go(false); } })
      ])]);
    }

    function join() {
      waiting('연결하는 중…', '잠깐만 기다려 주세요');
      var p = (pub && HAS_CRYPTO) ? verifier(pub).then(function (f) { verify = f; }).catch(function () { verify = null; }) : Promise.resolve();
      p.then(function () { return connect(cfg, code, onMsg, setStatus); })
        .then(function (n) { net = n; hello(); }, function () { setStatus('err'); waiting('연결이 안 돼요', '인터넷 연결을 확인하고 새로 고침 해 주세요'); });
    }
    function hello() {
      clearTimeout(hiTimer);
      if (net) net.send({ t: 'hi', sid: sid, c: me.c, n: me.n, need: !gotState });
      hiTimer = setTimeout(hello, gotState ? 15000 : 2000);
    }
    function setStatus(st) {
      dot.className = fabDot.className = 'lv-dot ' + st;
      if (st === 'ok') { gotState = false; hello(); if (!state) waiting('선생님을 기다리는 중', '선생님 화면과 연결하고 있어요'); }
    }
    function onMsg(m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'state' && typeof m.d === 'string') {
        var ok = verify ? (m.sig ? verify(m.d, m.sig) : Promise.resolve(false)) : Promise.resolve(true);
        ok.then(function (good) {
          if (!good) return;
          var d; try { d = JSON.parse(m.d); } catch (e) { return; }
          if (!(d.seq > lastSeq)) return;
          lastSeq = d.seq; gotState = true;
          if (d.title) { titleEl.textContent = d.title; document.title = d.title; }
          var changed = !state || !state.cur || !d.cur || state.cur.qid !== d.cur.qid || state.cur.open !== d.cur.open || state.cur.ans !== d.cur.ans || state.cur.ex !== d.cur.ex;
          state = d;
          if (changed) render();
          if (sim && d.go && d.go.s > lastGo) {            // 선생님이 "학생도 이 쪽"을 눌렀어요
            lastGo = d.go.s;
            try { lesson.goPage && lesson.goPage(d.go.p, d.go.k || 0); } catch (e) {}
            if (!d.view && !(d.cur && d.cur.open && !myAns[d.cur.qid])) overlay(false);
          }
          // 함께 넘기기: 선생님 화면이 질문 창이면 학생도 질문 창, 수업 화면이면 학생도 수업 화면
          if (sim && d.view && d.view !== lastView) {
            overlay(d.view === 'q');
            lastView = d.view;
          }
          ping();
        });
      } else if ((m.t === 'ack' || m.t === 'nack') && m.sid === sid) {
        if (!pending || pending.qid !== m.qid) return;
        clearTimeout(pending.tm); pending = null;
        if (m.t === 'ack') { myAns[m.qid] = myAns[m.qid] || {}; myAns[m.qid].ok = true; SS.set('lv-my:' + code, myAns); stat('선생님께 도착했어요 ✓  (다시 고쳐 보낼 수 있어요)', 'ok'); }
        else stat('지금은 답을 받지 않아요', 'bad');
      }
    }

    function waiting(msg, sub, idle) {
      if (idle && sim && !(state && state.view)) overlay(false);   // 기다리는 동안엔 시뮬레이션을 하도록 (함께 넘기기 중엔 선생님 화면을 따름)
      screen([h('div', { class: 'center' }, [h('div', { class: 'pulse' }), h('div', { class: 'lv-msg', text: msg }), sub ? h('div', { class: 'lv-sb', text: sub }) : null])]);
    }
    var statEl = null;
    function stat(t, cls) { if (statEl) { statEl.textContent = t; statEl.className = 'lv-stat' + (cls ? ' ' + cls : ''); } }

    function send(c, v) {
      if (!net) return;
      if (pending) clearTimeout(pending.tm);
      myAns[c.qid] = { v: v, ok: false }; SS.set('lv-my:' + code, myAns);
      var tries = 0;
      pending = { qid: c.qid };
      (function shoot() {
        net.send({ t: 'ans', sid: sid, c: me.c, n: me.n, qid: c.qid, v: v });
        stat(tries ? '다시 보내는 중… (' + tries + ')' : '보내는 중…');
        pending.tm = setTimeout(function () {
          if (++tries <= 3) shoot(); else { pending = null; stat('도착 확인이 안 돼요. 한 번 더 눌러 주세요', 'bad'); }
        }, 3500);
      })();
    }

    function render() {
      var c = state && state.cur;
      var idleSub = sim ? '선생님이 질문을 열면 위로 떠올라요' : '선생님이 문항을 열면 여기에 나타나요';
      if (!c) return waiting('선생님을 기다리는 중', idleSub, true);
      var mine = myAns[c.qid];
      if (!c.open && !mine && c.ans == null && !c.ex) return waiting('선생님을 기다리는 중', idleSub, true);
      var key = c.qid + (c.open ? ':open' : ':closed') + (c.ans != null || c.ex ? ':ans' : '');
      if (sim && key !== popped && (c.open || c.ans != null || c.ex)) { popped = key; if (state.view !== 'sim') overlay(true); }
      statEl = h('div', { class: 'lv-stat' });
      var head = h('div', { class: 'lv-q' }, [h('small', { text: c.n + '번 문항' + (c.open ? '' : ' · 마감') }), c.q]);
      var src = localImg(c.qid) || c.img;
      var img = src ? h('img', { class: 'qimg', src: src, alt: '', title: '누르면 크게', onclick: function () { zoomImg(src); } }) : null;
      var land = innerWidth > innerHeight * 1.1;
      var qwrap = h('div', { class: 'lv-qwrap' + (land && img ? ' land' : '') }, [head, img]);
      function fitAll(btns) {
        fit(head, Math.min(60, Math.min(innerWidth, innerHeight) * 0.058), 14);
        if (img && !img.complete) img.onload = function () { fit(head, Math.min(60, Math.min(innerWidth, innerHeight) * 0.058), 14); };
        (btns || []).forEach(function (b) { fit(b, Math.min(52, Math.min(innerWidth, innerHeight) * 0.052), 12); });
      }
      if (c.type === 'choice') {
        var box = h('div', { class: 'lv-opts' });
        box.style.gridTemplateColumns = land && c.options.length > 2 ? '1fr 1fr' : '1fr';
        c.options.forEach(function (o, i) {
          var cls = 'lv-opt';
          if (mine && mine.v === i) cls += ' sel';
          if (c.ans != null) { if (i === c.ans) cls += ' right'; else if (mine && mine.v === i) cls += ' wrong'; }
          box.appendChild(h('button', {
            class: cls, disabled: !c.open, style: 'border-left:.5em solid ' + COLORS[i % COLORS.length],
            onclick: function () {
              Array.prototype.forEach.call(box.children, function (b) { b.classList.remove('sel'); });
              this.classList.add('sel'); send(c, i);
            }
          }, [h('span', { class: 'mk', text: MARKS[i] }), h('span', { text: o })]));
        });
        screen([qwrap, box, statEl]);
        fitAll(Array.prototype.slice.call(box.children));
      } else {
        var ta = h('textarea', { class: 'lv-in', maxlength: String(MAX_TEXT), placeholder: '여기에 생각을 적어요', disabled: !c.open });
        ta.value = mine ? mine.v : (SS.get('lv-draft:' + code + ':' + c.qid, '') || '');
        ta.addEventListener('input', function () { SS.set('lv-draft:' + code + ':' + c.qid, ta.value); });
        var btn = h('button', { class: 'lv-btn pri lv-send', text: '보내기', disabled: !c.open, onclick: function () {
          var v = ta.value.trim(); if (!v) { stat('내용을 적어 주세요', 'bad'); return; } send(c, v);
        } });
        var exBox = c.ex ? h('div', { class: 'lv-ex' }, [h('b', { text: '💡 선생님 예시 답' }), String(c.ex).slice(0, 1000)]) : null;
        screen([qwrap, ta, btn, exBox, statEl]);
        fitAll();
      }
      if (c.ans != null && mine) stat(mine.v === c.ans ? '정답이에요! 🎉' : '정답은 ' + MARKS[c.ans] + ' 이에요', mine.v === c.ans ? 'ok' : 'bad');
      else if (mine && mine.ok) stat(c.open ? '선생님께 도착했어요 ✓  (다시 고쳐 보낼 수 있어요)' : '선생님께 도착했어요 ✓', 'ok');
      else if (!c.open) stat('마감됐어요');
    }
    var rzS; window.addEventListener('resize', function () { clearTimeout(rzS); rzS = setTimeout(function () { if (state && state.cur && state.cur.type === 'choice') render(); }, 150); });
  }

  /* ───────────── 시작 ───────────── */
  var Live = {
    version: VERSION,
    // 학생 화면인지 (수업 페이지가 무거운 일을 건너뛸 때 쓰기)
    isStudent: function () { var q = new URLSearchParams(location.hash.slice(1)); return q.has('join') || q.has('s'); },
    start: function (lesson) {
      lesson = lesson || {};
      var go = function () {
        var q = new URLSearchParams(location.hash.slice(1));
        if (q.has('pv')) {                           // 퀴즈 만들기 미리보기
          var n = Math.max(0, parseInt(q.get('pv'), 10) || 0);
          if (q.get('who') === 't') Teacher(lesson, n); else Student(lesson, q, n);
        } else if (Live.isStudent()) Student(lesson, q); else Teacher(lesson);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    },
    _test: { keyProblem: keyProblem, packUrl: packUrl }
  };
  window.Live = Live;
})();
