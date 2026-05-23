/*
 * Bandcamp Cast — Chromecast support for Bandcamp.
 *
 * Runs in the page's MAIN world (see manifest `world: "MAIN"`). The Cast SDK
 * lives in a hidden iframe loaded on `bandcamp.com`, so cast sessions auto-
 * rejoin across artist subdomains. The outer (per-tab) script handles the UI,
 * page data, and audio mirroring and talks to the inner frame via postMessage.
 *
 * When casting starts, the whole album is handed to the Chromecast as a
 * queue. The receiver plays and auto-advances on its own, so playback survives
 * switching tabs, navigating away, or closing the page.
 *
 * While the Chromecast is playing a track that belongs to this page, the
 * extension mirrors it onto Bandcamp's own player: the progress bar, times and
 * play button track the cast, and clicking play/pause or scrubbing the bar is
 * routed to the cast. The Chromecast always remains the source of truth.
 */
(() => {
  'use strict';
  if (window.__bandcampCastInit) return;
  window.__bandcampCastInit = true;

  const LOG = '[Bandcamp Cast]';

  // Cast receiver: a Styled Media Receiver ("Bandcamp Cast") registered in the
  // Google Cast SDK Developer Console.
  const RECEIVER_APP_ID = '629302D0';

  // The hidden iframe we inject on every Bandcamp page (see injectInnerFrame)
  // hosts the Cast SDK on a shared `bandcamp.com` origin, so cast sessions
  // auto-rejoin across artist subdomains. Inside it this same content script
  // runs in a different role: it owns the Cast SDK, the session, and queue
  // loading, and exposes them to the outer page over postMessage.
  const inBcastFrame = window !== window.top
    && location.search.indexOf('bcast=1') >= 0;
  if (inBcastFrame) {
    console.log(LOG, 'inner frame loaded — Cast SDK host.');
    initInner();
    return;
  }

  // ============== OUTER (per-tab UI, page data, audio mirror) ===============

  const CAST_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 ' +
    '18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0' +
    '-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h' +
    '2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>';

  // ---------------------------------------------------------------- page data
  function getTralbum() {
    const el = document.querySelector('script[data-tralbum]');
    if (el) {
      try { return JSON.parse(el.getAttribute('data-tralbum')); } catch (e) { /* noop */ }
    }
    return window.TralbumData || null;
  }

  const tralbum = getTralbum();
  // Bandcamp fan pages (a user's collection) carry no tralbum data — they
  // play tracks through the #carousel-player bar at the bottom of the page.
  const carousel = document.getElementById('carousel-player');

  // Nothing to cast on this page — don't load the SDK or show a button.
  if (!tralbum && !carousel && !document.querySelector('audio')) {
    console.log(LOG, 'no Bandcamp player found on this page — inactive.');
    return;
  }
  console.log(LOG, 'active — loading Cast SDK…');

  const albumTitle =
    (tralbum && tralbum.current && tralbum.current.title) || document.title;
  const albumArtist =
    (tralbum && (tralbum.artist || (tralbum.current && tralbum.current.artist))) || '';
  const artUrl = (() => {
    if (tralbum && tralbum.art_id) {
      return `https://f4.bcbits.com/img/a${tralbum.art_id}_16.jpg`;
    }
    const img = document.querySelector('#tralbumArt img, .popupImage img');
    return img ? img.src : '';
  })();

  const httpify = (u) => (u && u.startsWith('//') ? 'https:' + u : u);

  // Pick a streamable URL from a trackinfo `file` object.
  const streamUrl = (file) => {
    if (!file) return null;
    const u = file['mp3-128'] || file['mp3-v0'] || Object.values(file)[0];
    return u ? httpify(u) : null;
  };

  // The album's tracks. `id` is Bandcamp's stable numeric track ID — used to
  // match tracks across page reloads and re-tokenized URLs; `url` is the
  // stream sent to the Chromecast.
  const tracks = ((tralbum && tralbum.trackinfo) || []).map((t) => ({
    title: t.title,
    artist: t.artist || albumArtist,
    num: t.track_num || 0,
    id: String(t.track_id || t.id || ''),
    duration: t.duration || 0,
    url: streamUrl(t.file),
  }));

  // Extract Bandcamp's stable numeric track ID from a stream URL. Two shapes
  // occur: `bandcamp.com/stream_redirect?…&track_id=<id>` (ID in a query
  // param) and `.../stream/<hash>/<format>/<id>` (ID as the last path
  // segment). The ID is stable across page loads and token rotation.
  const urlTrackId = (u) => {
    if (!u) return '';
    try {
      const url = new URL(u, location.href);
      const param = url.searchParams.get('track_id');
      if (param && /^\d+$/.test(param)) return param;
      const m = url.pathname.match(/(\d+)\/?$/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  };
  const trackIndexForUrl = (u) => {
    const id = urlTrackId(u);
    return id ? tracks.findIndex((t) => t.id === id) : -1;
  };

  // -------------------------------------------------------------------- state
  let audioEl = null;
  let ui = null;
  let casting = false;
  let frameWin = null;   // the inner iframe's contentWindow

  // Player-mirror state. `els` are Bandcamp's own player elements; `mirroring`
  // is true only while the cast is playing a track that belongs to this page.
  // Local clock: the receiver reports currentTime only occasionally, so we
  // interpolate between updates (clockBase/clockWall + a 500ms ticker) to move
  // the progress bar smoothly.
  let els = null;
  let mirroring = false;
  let scrubbing = false;
  let highlightedRow = null;
  let clockBase = 0;
  let clockWall = 0;
  let tickTimer = null;

  // Mirror of the inner frame's Cast state — kept in sync via 'state' messages
  // and used as the source of truth for the local UI, controls, and mirror.
  const cast = {
    isCasting: false,
    deviceName: null,
    contentId: null,
    duration: 0,
    currentTime: 0,
    isPaused: true,
  };

  // Build the button right away, so it shows even while the inner frame is
  // still loading — and so a missing button unambiguously means the content
  // script did not run on this page.
  buildUI();
  findAudio();
  setupPlayerMirror();

  function sendCmd(cmd, data) {
    if (!frameWin) return;
    try { frameWin.postMessage({ src: 'bcast-outer', cmd, data: data || {} }, '*'); }
    catch (e) { /* noop */ }
  }

  // Transparent iframe overlay on top of the Cast button. Chrome does not
  // propagate user activation cross-origin via `postMessage`, so the
  // activation `requestSession()` requires has to register on a frame the
  // user actually clicked — this is that frame.
  function injectInnerFrame(parent) {
    const f = document.createElement('iframe');
    f.src = 'https://bandcamp.com/?bcast=1';
    f.style.cssText = 'position:absolute;inset:0;border:0;opacity:0;background:transparent';
    f.setAttribute('aria-hidden', 'true');
    f.setAttribute('tabindex', '-1');
    parent.appendChild(f);
    frameWin = f.contentWindow;
    window.addEventListener('message', (e) => {
      if (e.source !== f.contentWindow) return;
      const m = e.data;
      if (!m || m.src !== 'bcast-inner') return;
      if (m.type === 'state') onInnerState(m.state);
      else if (m.type === 'session') {
        if (m.event === 'started') onConnected(true);
        else if (m.event === 'resumed') onConnected(false);
        else if (m.event === 'ended') onDisconnected();
      } else if (m.type === 'ready') {
        console.log(LOG, 'inner frame ready.');
      }
    });
  }

  function onInnerState(state) {
    const prevContent = cast.contentId;
    Object.assign(cast, state);
    if (cast.contentId !== prevContent) evaluateMirror();
    syncClock();
    updateUI();
  }

  // -------------------------------------------------- local <audio> reference
  // We only need a handle on Bandcamp's audio element so we can silence it
  // while casting, and read where playback is to start the queue there.
  function findAudio() {
    const existing = document.querySelector('audio');
    if (existing) { attachAudio(existing); return; }

    // Bandcamp builds its <audio> element in JavaScript at playback time and
    // may never attach it to the DOM — so catch it the first time any media
    // element plays.
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!audioEl && this instanceof HTMLAudioElement) attachAudio(this);
      return origPlay.apply(this, arguments);
    };

    const mo = new MutationObserver(() => {
      const a = document.querySelector('audio');
      if (a) { mo.disconnect(); attachAudio(a); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function attachAudio(el) {
    if (audioEl) return;
    audioEl = el;
    el.addEventListener('play', onLocalPlay);
    el.addEventListener('pause', onLocalPause);
    el.addEventListener('seeked', onLocalSeek);
    if (casting) silenceLocal();
  }

  // The user pressed play on Bandcamp's own player.
  function onLocalPlay() {
    if (!casting) return;
    // Pressing play is an explicit "play this": if it isn't the track already
    // casting, switch the cast to this page's album, starting at that track.
    const wantId = currentLocalTrackId();
    const castId = cast.contentId ? urlTrackId(cast.contentId) : '';
    if (wantId && wantId !== castId) castWhatThePageWants();
    else if (carouselCasting() && cast.isPaused) sendCmd('playPause');
    silenceLocal();
  }

  // True while the fan-collection player is the user's remote: its muted
  // local <audio> stays live and its play / pause / seek drive the cast.
  function carouselCasting() {
    return casting && !!carousel;
  }

  // Mirror the fan-collection player's pause and seek onto the cast.
  function onLocalPause() {
    // Chrome pauses background-tab audio; ignore — only user-initiated
    // pauses (which require the tab to be visible) should stop the cast.
    if (document.hidden) return;
    if (!carouselCasting() || cast.isPaused) return;
    sendCmd('playPause');
  }

  function onLocalSeek() {
    if (!carouselCasting() || !cast.duration) return;
    if (!cast.contentId || currentLocalTrackId() !== urlTrackId(cast.contentId)) return;
    const t = audioEl.currentTime;
    if (Math.abs(t - (cast.currentTime || 0)) < 1) return;
    sendCmd('seek', { time: t });
  }

  // The numeric track ID Bandcamp's <audio> is currently on, or '' if unknown.
  function currentLocalTrackId() {
    return audioEl ? urlTrackId(audioEl.currentSrc) : '';
  }

  function silenceLocal() {
    if (!audioEl) return;
    audioEl.muted = true;
    // Bandcamp's fan-collection player retries play() whenever its <audio> is
    // paused, which fights us into a re-cast loop — so there, mute only.
    if (!carousel) audioEl.pause();
  }

  // -------------------------------------------------------- session lifecycle
  function onConnected(freshStart) {
    casting = true;
    silenceLocal();
    if (freshStart) castWhatThePageWants();
    evaluateMirror();
    updateUI();
  }

  function onDisconnected() {
    casting = false;
    if (audioEl) audioEl.muted = false;
    stopMirror();
    updateUI();
  }

  // Tell the inner to cast whatever this page can cast right now.
  function castWhatThePageWants() {
    const startTime = (audioEl && audioEl.currentTime) || 0;
    const castable = tracks.filter((t) => t.url);
    if (castable.length) {
      sendCmd('castAlbum', {
        tracks: castable,
        startId: currentLocalTrackId(),
        startTime,
        albumTitle,
        albumArtist,
        artUrl,
      });
      return;
    }
    const src = audioEl && (audioEl.currentSrc || audioEl.src);
    if (!src) {
      console.warn(LOG, 'Nothing to cast yet — play a track first, then cast.');
      return;
    }
    if (carousel) {
      const np = carouselNowPlaying();
      sendCmd('castSingle', {
        src,
        trackId: urlTrackId(src),
        title: (np && np.title) || document.title,
        artist: (np && np.artist) || '',
        art: (np && np.art) || artUrl,
        albumName: tralbum ? albumTitle : '',
        currentTime: startTime,
        fetchCastable: true,
      });
      return;
    }
    sendCmd('castSingle', {
      src,
      title: document.title,
      art: artUrl,
      albumName: tralbum ? albumTitle : '',
      currentTime: startTime,
    });
  }

  // The track shown in the fan-collection player bar, for cast metadata.
  function carouselNowPlaying() {
    if (!carousel) return null;
    const text = (sel) => {
      const el = carousel.querySelector(sel);
      return el ? el.textContent.trim() : '';
    };
    const img = carousel.querySelector('.now-playing img');
    return {
      title: text('.now-playing .info .title'),
      artist: text('.now-playing .info .artist'),
      art: img ? img.src : '',
    };
  }

  // ------------------------------------------- mirror onto Bandcamp's player
  function setupPlayerMirror() {
    const player = document.querySelector('.inline_player');
    if (!player) return;
    els = {
      player,
      playLink: player.querySelector('.play_cell a')
        || player.querySelector('.playbutton'),
      playbutton: player.querySelector('.playbutton'),
      progbar: player.querySelector('.progbar'),
      progEmpty: player.querySelector('.progbar_empty'),
      progFill: player.querySelector('.progbar_fill'),
      thumb: player.querySelector('.thumb'),
      timeWrap: player.querySelector('.time'),
      elapsed: player.querySelector('.time_elapsed'),
      total: player.querySelector('.time_total'),
      titleWrap: player.querySelector('.title-section'),
      titleText: player.querySelector('.title-section .title'),
    };

    // Intercept Bandcamp's own controls in the capture phase: when we're
    // mirroring, stop Bandcamp's handlers and drive the cast instead.
    if (els.playLink) els.playLink.addEventListener('click', onPlayClick, true);
    if (els.progbar) {
      els.progbar.addEventListener('mousedown', onScrubStart, true);
      els.progbar.addEventListener('click', swallowWhenMirroring, true);
    }
  }

  function onPlayClick(e) {
    if (!mirroring) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    sendCmd('playPause');
  }

  function swallowWhenMirroring(e) {
    if (!mirroring) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onScrubStart(e) {
    if (!mirroring || !cast.duration) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    scrubbing = true;
    applyFraction(fractionFromEvent(e));    // immediate visual feedback

    const move = (ev) => applyFraction(fractionFromEvent(ev));
    const up = (ev) => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      scrubbing = false;
      const t = fractionFromEvent(ev) * cast.duration;
      sendCmd('seek', { time: t });
      clockBase = t;             // optimistic — keeps the bar from flicking back
      clockWall = Date.now();
      renderMirror();
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }

  function fractionFromEvent(e) {
    const r = els.progEmpty.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  // Decide whether the cast's current track belongs to this page, and update
  // which track Bandcamp's player is showing.
  function evaluateMirror() {
    if (!els) return;
    const wasMirroring = mirroring;
    const idx = casting && cast.contentId ? trackIndexForUrl(cast.contentId) : -1;
    mirroring = idx >= 0;

    if (mirroring) {
      highlightTrack(idx);
      if (els.titleText && tracks[idx].title) {
        els.titleText.textContent = tracks[idx].title;
        if (els.titleWrap) els.titleWrap.classList.remove('hiddenelem');
      }
      syncClock();
    } else if (wasMirroring) {
      ensureTicker();   // mirroring is now false → stops the ticker
      resetPlayer();
    }
  }

  // Snapshot the receiver's reported position; the ticker interpolates from it.
  function syncClock() {
    clockBase = cast.currentTime || 0;
    clockWall = Date.now();
    renderMirror();
  }

  // The current playback position, interpolated since the last receiver update.
  function estimatedTime() {
    if (cast.isPaused) return clockBase;
    const dur = cast.duration || 0;
    const est = clockBase + (Date.now() - clockWall) / 1000;
    return dur ? Math.min(est, dur) : est;
  }

  // Run a 500ms ticker only while playback is actually advancing.
  function ensureTicker() {
    const run = mirroring && !cast.isPaused && !scrubbing;
    if (run && !tickTimer) {
      tickTimer = setInterval(renderMirror, 500);
    } else if (!run && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  // Push the (interpolated) position / play state onto Bandcamp's player.
  function renderMirror() {
    if (!mirroring || !els) return;
    const dur = cast.duration || 0;
    const cur = estimatedTime();
    if (!scrubbing) applyFraction(dur ? cur / dur : 0, cur);
    if (els.total) els.total.textContent = formatTime(dur);
    if (els.timeWrap) els.timeWrap.classList.remove('hiddenelem');
    if (els.playbutton) {
      els.playbutton.classList.toggle('playing', !cast.isPaused);
    }
    ensureTicker();
  }

  function applyFraction(fraction, time) {
    const pct = (fraction * 100).toFixed(3) + '%';
    if (els.progFill) els.progFill.style.width = pct;
    if (els.thumb) els.thumb.style.left = pct;
    if (els.elapsed) {
      const t = time != null ? time : fraction * (cast.duration || 0);
      els.elapsed.textContent = formatTime(t);
    }
  }

  function highlightTrack(idx) {
    if (highlightedRow) highlightedRow.classList.remove('currenttrack');
    highlightedRow = null;
    const num = tracks[idx] && tracks[idx].num;
    if (!num) return;
    const row = document.querySelector(`.track_row_view[rel="tracknum=${num}"]`);
    if (row) { row.classList.add('currenttrack'); highlightedRow = row; }
  }

  function resetPlayer() {
    if (!els) return;
    if (els.progFill) els.progFill.style.width = '';
    if (els.thumb) els.thumb.style.left = '';
    if (els.playbutton) els.playbutton.classList.remove('playing');
    if (highlightedRow) {
      highlightedRow.classList.remove('currenttrack');
      highlightedRow = null;
    }
  }

  function stopMirror() {
    mirroring = false;
    scrubbing = false;
    ensureTicker();   // stops the ticker
    resetPlayer();
  }

  function formatTime(seconds) {
    let s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    s %= 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  // -------------------------------------------------------------------- UI
  function buildUI() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bcast-btn';
    btn.setAttribute('aria-label', 'Cast to a device');
    btn.innerHTML = CAST_SVG;
    // No click handler — see injectInnerFrame: the user's click is absorbed
    // by the inner iframe overlay so it registers user activation there.

    // Preferred placements: the album/track inline player, or the fan-
    // collection player bar. Fall back to a floating pill on any other page.
    const inlinePlayer = document.querySelector('#trackInfoInner > .inline_player');
    const controlsExtra = carousel && carousel.querySelector('.controls-extra');
    if (inlinePlayer) {
      btn.classList.add('bcast-corner');
      inlinePlayer.appendChild(btn);
      ui = { btn, where: 'the inline player' };
    } else if (controlsExtra) {
      btn.classList.add('bcast-incarousel');
      controlsExtra.insertBefore(btn, controlsExtra.firstChild);
      ui = { btn, where: 'the collection player' };
    } else {
      const bar = document.createElement('div');
      bar.className = 'bcast-bar';
      const label = document.createElement('span');
      label.className = 'bcast-label';
      label.textContent = 'Cast';
      bar.append(btn, label);
      document.body.appendChild(bar);
      ui = { btn, label, bar, where: 'a floating control' };
    }
    injectInnerFrame(ui.bar || btn);
    console.log(LOG, `Cast button added to ${ui.where}.`);
    updateUI();
  }

  function updateUI() {
    if (!ui) return;
    const name = cast.deviceName || '';
    ui.btn.classList.toggle('bcast-on', cast.isCasting);
    ui.btn.title = cast.isCasting
      ? (name ? `Casting to ${name} — click to stop` : 'Casting — click to stop')
      : 'Cast this album to a device';

    if (ui.bar) ui.bar.classList.toggle('connected', cast.isCasting);
    if (ui.label) ui.label.textContent = cast.isCasting ? (name || 'Casting') : 'Cast';
  }

  // ============== INNER (Cast SDK host, runs inside the iframe) =============

  function initInner() {
    let castContext = null;
    let remotePlayer = null;
    let remoteController = null;
    let fw = null;
    let cc = null;

    function send(msg) {
      try { window.parent.postMessage(Object.assign({ src: 'bcast-inner' }, msg), '*'); }
      catch (e) { /* noop */ }
    }

    function snapshot() {
      const ses = castContext && castContext.getCurrentSession();
      const dev = ses && ses.getCastDevice && ses.getCastDevice();
      const info = remotePlayer && remotePlayer.mediaInfo;
      return {
        isCasting: !!ses,
        deviceName: (dev && dev.friendlyName) || null,
        contentId: (info && info.contentId) || null,
        duration: (remotePlayer && remotePlayer.duration) || 0,
        currentTime: (remotePlayer && remotePlayer.currentTime) || 0,
        isPaused: !remotePlayer || remotePlayer.isPaused,
      };
    }

    const broadcast = () => send({ type: 'state', state: snapshot() });

    window.addEventListener('message', (e) => {
      if (e.source !== window.parent) return;
      const m = e.data;
      if (!m || m.src !== 'bcast-outer') return;
      handleCommand(m).catch((err) => console.warn(LOG, '(inner) cmd error:', err));
    });

    async function handleCommand(m) {
      if (!castContext) return;
      const ses = castContext.getCurrentSession();
      if (m.cmd === 'playPause') {
        if (remoteController) remoteController.playOrPause();
      } else if (m.cmd === 'seek') {
        if (remotePlayer && remoteController) {
          remotePlayer.currentTime = m.data.time;
          remoteController.seek();
        }
      } else if (m.cmd === 'castAlbum') {
        if (ses) await dispatchLoad(ses, 'album', m.data);
      } else if (m.cmd === 'castSingle') {
        if (ses) await dispatchLoad(ses, 'single', m.data);
      }
    }

    // User-trusted clicks reach us through the outer's transparent iframe
    // overlay on the Cast button — see injectInnerFrame in the outer.
    function onCastClick(e) {
      if (!e.isTrusted) return;     // ignore programmatic clicks from the
      e.preventDefault();           // bandcamp.com homepage running in here
      e.stopPropagation();
      if (!castContext) {
        console.warn(LOG, 'Cast SDK is still loading — try again in a moment.');
        return;
      }
      const ses = castContext.getCurrentSession();
      if (ses) { castContext.endCurrentSession(true); return; }
      castContext.requestSession().catch((err) => {
        const code = (err && err.code) || err;
        if (code && code !== 'cancel') {
          console.warn(LOG, 'Could not start casting:', code,
            '—', (err && err.description) || '', (err && err.details) || '');
        }
      });
    }
    document.addEventListener('click', onCastClick, true);
    // The iframe is opacity:0 over a button; show its host's pointer cursor
    // when the user hovers the area.
    (document.body || document.documentElement).style.cursor = 'pointer';

    // ----- Loading / queueing on the receiver ---------------------------
    // Serialised: outer can re-issue castAlbum/castSingle rapidly (Bandcamp
    // fires 'play' twice on a track switch), and two overlapping loadMedia
    // calls make the receiver reject one with `session_error`.
    const QUEUE_CHUNK = 20;
    let castLoading = false;
    let castLoadingKey = '';
    let castPending = null;   // { type, data } when a different load is queued

    function keyOf(type, data) {
      return type === 'album'
        ? 'album:' + (data.startId || '')
        : 'single:' + (data.trackId || data.src);
    }

    async function dispatchLoad(ses, type, data) {
      const key = keyOf(type, data);
      if (castLoading) {
        if (key !== castLoadingKey) castPending = { type, data };
        return;
      }
      castLoading = true;
      try {
        let job = { type, data };
        while (job) {
          castLoadingKey = keyOf(job.type, job.data);
          castPending = null;
          if (job.type === 'album') await loadAlbumQueueFrom(ses, job.data);
          else await loadSingleTrack(ses, job.data);
          job = castPending;
        }
      } catch (err) { console.warn(LOG, 'Cast load failed:', err); }
      finally { castLoading = false; castLoadingKey = ''; }
    }

    function buildQueueItem(t, ctx) {
      const info = new cc.media.MediaInfo(t.url, 'audio/mpeg');
      info.streamType = cc.media.StreamType.BUFFERED;
      if (t.duration) info.duration = t.duration;
      const meta = new cc.media.MusicTrackMediaMetadata();
      meta.title = t.title || '';
      meta.artist = t.artist || ctx.albumArtist || '';
      if (ctx.albumTitle) meta.albumName = ctx.albumTitle;
      if (t.num) meta.trackNumber = t.num;
      const art = t.art || ctx.artUrl;
      if (art) meta.images = [new cc.Image(art)];
      info.metadata = meta;
      return new cc.media.QueueItem(info);
    }

    // Wrap queue items in a LoadRequest — used by both album queues and the
    // single fan-collection track.
    function buildLoadRequest(items, startTime, name) {
      const queueData = new cc.media.QueueData();
      queueData.items = items;
      queueData.startIndex = 0;
      if (name) queueData.name = name;
      queueData.repeatMode = cc.media.RepeatMode.OFF;
      const request = new cc.media.LoadRequest(items[0].media);
      request.queueData = queueData;
      request.currentTime = startTime;
      request.autoplay = true;
      return request;
    }

    async function loadAlbumQueueFrom(ses, data) {
      const castable = (data.tracks || []).filter((t) => t.url);
      if (!castable.length) return;
      let startIndex = castable.findIndex((t) => t.id === data.startId);
      if (startIndex < 0) startIndex = 0;
      const ctx = {
        albumArtist: data.albumArtist,
        albumTitle: data.albumTitle,
        artUrl: data.artUrl,
      };
      const items = castable.slice(startIndex).map((t) => buildQueueItem(t, ctx));
      const first = items.slice(0, QUEUE_CHUNK);
      try {
        await ses.loadMedia(buildLoadRequest(
          first, data.startTime || 0, data.albumTitle));
      } catch (err) {
        console.warn(LOG, 'Failed to start the cast queue:', err);
        return;
      }
      console.log(LOG, `casting "${data.albumTitle}" — ${items.length} tracks.`);
      await appendToQueue(ses, items.slice(QUEUE_CHUNK));
    }

    // Append the remaining queue items, one chunk at a time.
    async function appendToQueue(ses, remaining) {
      if (!remaining.length) return;
      // loadMedia resolves slightly before the session's media object is
      // populated, so wait for it rather than dropping the rest of the queue.
      const media = await waitForMediaSession(ses);
      if (!media) {
        console.warn(LOG, 'No media session — cannot extend queue.');
        return;
      }
      for (let i = 0; i < remaining.length; i += QUEUE_CHUNK) {
        if (castPending !== null) return;   // a reload is queued — stop here
        const req = new cc.media.QueueInsertItemsRequest(
          remaining.slice(i, i + QUEUE_CHUNK));
        try {
          await new Promise((resolve, reject) => {
            media.queueInsertItems(req, resolve, reject);
          });
        } catch (err) {
          console.warn(LOG, 'Failed to extend the cast queue:', err);
          return;
        }
      }
    }

    // loadMedia resolves before getMediaSession() is populated; poll briefly.
    function waitForMediaSession(ses, tries = 20) {
      return new Promise((resolve) => {
        const tick = (n) => {
          if (!castContext.getCurrentSession()) { resolve(null); return; }
          const media = ses.getMediaSession();
          if (media || n <= 0) { resolve(media || null); return; }
          setTimeout(() => tick(n - 1), 250);
        };
        tick(tries);
      });
    }

    // Fan-collection pages (and any other page with no track list): cast
    // whatever the page is playing right now, as a single track.
    async function loadSingleTrack(ses, data) {
      let src = data.src;
      // Collection pages stream owner-only mp3-v0 which the receiver can't
      // play; fetch a public mp3-128 stream via the embed player.
      if (data.fetchCastable && data.trackId) {
        const better = await castableUrlForTrack(data.trackId);
        if (better) src = better;
      }
      if (!src) return;
      const info = new cc.media.MediaInfo(src, 'audio/mpeg');
      info.streamType = cc.media.StreamType.BUFFERED;
      const meta = new cc.media.MusicTrackMediaMetadata();
      meta.title = data.title || '';
      if (data.artist) meta.artist = data.artist;
      if (data.albumName) meta.albumName = data.albumName;
      if (data.art) meta.images = [new cc.Image(data.art)];
      info.metadata = meta;
      try {
        await ses.loadMedia(buildLoadRequest(
          [new cc.media.QueueItem(info)], data.currentTime || 0));
      } catch (err) { console.warn(LOG, 'loadMedia failed:', err); }
    }

    // A castable mp3-128 stream URL for a track via Bandcamp's embed player.
    // The inner is on `bandcamp.com`, so this fetch is same-origin from
    // anywhere the iframe is loaded.
    async function castableUrlForTrack(trackId) {
      if (!trackId) return null;
      try {
        const res = await fetch(`https://bandcamp.com/EmbeddedPlayer/track=${trackId}/`);
        const html = await res.text();
        const m = html.match(/data-player-data="([^"]+)"/);
        if (!m) return null;
        const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        const file = ((data.tracks || [])[0] || {}).file;
        const u = file && (file['mp3-128'] || Object.values(file)[0]);
        return u && u.startsWith('//') ? 'https:' + u : (u || null);
      } catch (e) { return null; }
    }

    // ----- Cast SDK loading -----
    window.__onGCastApiAvailable = (available) => {
      if (available) startCast();
      else console.warn(LOG, '(inner) Cast is not available in this browser.');
    };

    function startCast() {
      fw = window.cast && window.cast.framework;
      cc = window.chrome && window.chrome.cast;
      if (!fw || !cc) {
        console.warn(LOG, '(inner) Cast framework unavailable.');
        return;
      }
      castContext = fw.CastContext.getInstance();
      castContext.setOptions({
        receiverApplicationId: RECEIVER_APP_ID,
        autoJoinPolicy: cc.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      castContext.addEventListener(
        fw.CastContextEventType.SESSION_STATE_CHANGED,
        (e) => {
          const S = fw.SessionState;
          if (e.sessionState === S.SESSION_STARTED) send({ type: 'session', event: 'started' });
          else if (e.sessionState === S.SESSION_RESUMED) send({ type: 'session', event: 'resumed' });
          else if (e.sessionState === S.SESSION_ENDED) send({ type: 'session', event: 'ended' });
          broadcast();
        },
      );
      remotePlayer = new fw.RemotePlayer();
      remoteController = new fw.RemotePlayerController(remotePlayer);
      const RPE = fw.RemotePlayerEventType;
      [RPE.CURRENT_TIME_CHANGED, RPE.DURATION_CHANGED, RPE.IS_PAUSED_CHANGED,
       RPE.PLAYER_STATE_CHANGED, RPE.MEDIA_INFO_CHANGED, RPE.IS_MEDIA_LOADED_CHANGED]
        .forEach((evt) => remoteController.addEventListener(evt, broadcast));
      // Re-attach to a session that outlived a navigation.
      if (castContext.getCurrentSession()) send({ type: 'session', event: 'resumed' });
      broadcast();
      send({ type: 'ready' });
    }

    // Load the Cast SDK in the iframe.
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.onerror = () => console.warn(LOG, '(inner) Failed to load Cast SDK.');
    (document.head || document.documentElement).appendChild(s);
  }
})();
