/*
 * Bandcamp Cast — Chromecast support for Bandcamp.
 *
 * Runs in the page's MAIN world (see manifest `world: "MAIN"`) so it can read
 * Bandcamp's track data and inject the Google Cast SDK.
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
  const CAST_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 ' +
    '18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0' +
    '-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h' +
    '2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>';

  // Cast receiver: a Styled Media Receiver ("Bandcamp Cast") registered in the
  // Google Cast SDK Developer Console. Casting through a registered app is what
  // makes the Chromecast and phones show the app name and track metadata.
  const RECEIVER_APP_ID = '629302D0';

  // ---------------------------------------------------------------- page data
  function getTralbum() {
    const el = document.querySelector('script[data-tralbum]');
    if (el) {
      try { return JSON.parse(el.getAttribute('data-tralbum')); } catch (e) { /* noop */ }
    }
    return window.TralbumData || null;
  }

  const tralbum = getTralbum();

  // Nothing to cast on this page — don't load the SDK or show a button.
  if (!tralbum && !document.querySelector('audio')) {
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

  // Pick a streamable URL from a trackinfo `file` object. `mp3-128` is the
  // usual streaming format, but fall back to whatever else is offered.
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
  let castContext = null;
  let remotePlayer = null;
  let remoteController = null;
  let casting = false;
  let audioEl = null;
  let ui = null;

  // Build the button right away, so it shows even while the Cast SDK is still
  // loading — and so a missing button unambiguously means the content script
  // did not run on this page.
  buildUI();

  // --------------------------------------------------------- Cast SDK loading
  window.__onGCastApiAvailable = (available) => {
    if (available) initCast();
    else console.warn(LOG, 'Cast is not available in this browser.');
  };

  (function loadSdk() {
    // Inserted via createElement → not "parser-inserted", so it is permitted
    // even under Bandcamp's `strict-dynamic` Content-Security-Policy.
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.onerror = () => console.warn(LOG, 'Failed to load the Cast SDK.');
    (document.head || document.documentElement).appendChild(s);
  })();

  function initCast() {
    const fw = window.cast && window.cast.framework;
    const cc = window.chrome && window.chrome.cast;
    if (!fw || !cc) { console.warn(LOG, 'Cast framework unavailable.'); return; }

    castContext = fw.CastContext.getInstance();
    castContext.setOptions({
      receiverApplicationId: RECEIVER_APP_ID,
      autoJoinPolicy: cc.AutoJoinPolicy.ORIGIN_SCOPED,
    });

    castContext.addEventListener(
      fw.CastContextEventType.SESSION_STATE_CHANGED,
      (e) => {
        const S = fw.SessionState;
        if (e.sessionState === S.SESSION_STARTED) onConnected(true);
        else if (e.sessionState === S.SESSION_RESUMED) onConnected(false);
        else if (e.sessionState === S.SESSION_ENDED) onDisconnected();
      },
    );

    // RemotePlayer reflects the receiver's live state; we mirror it onto
    // Bandcamp's player.
    remotePlayer = new fw.RemotePlayer();
    remoteController = new fw.RemotePlayerController(remotePlayer);
    const RPE = fw.RemotePlayerEventType;
    remoteController.addEventListener(RPE.CURRENT_TIME_CHANGED, syncClock);
    remoteController.addEventListener(RPE.DURATION_CHANGED, syncClock);
    remoteController.addEventListener(RPE.IS_PAUSED_CHANGED, syncClock);
    remoteController.addEventListener(RPE.PLAYER_STATE_CHANGED, syncClock);
    remoteController.addEventListener(RPE.MEDIA_INFO_CHANGED, evaluateMirror);
    remoteController.addEventListener(RPE.IS_MEDIA_LOADED_CHANGED, evaluateMirror);

    findAudio();
    setupPlayerMirror();

    // Re-attach to a session that outlived a page navigation (don't reload
    // the queue — just reflect that we're connected).
    if (castContext.getCurrentSession()) onConnected(false);
    else updateUI();
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
    if (casting) silenceLocal();
  }

  // The user pressed play on Bandcamp's own player.
  function onLocalPlay() {
    if (!casting) return;
    // Pressing play is an explicit "play this": if it isn't the track already
    // casting, switch the cast to this page's album, starting at that track.
    const wantId = currentLocalTrackId();
    const info = remotePlayer && remotePlayer.mediaInfo;
    const castId = info ? urlTrackId(info.contentId) : '';
    if (wantId && wantId !== castId) loadQueue(wantId);
    silenceLocal();   // keep Bandcamp's own player from competing with the cast
  }

  // The numeric track ID Bandcamp's <audio> is currently on, or '' if unknown.
  function currentLocalTrackId() {
    return audioEl ? urlTrackId(audioEl.currentSrc) : '';
  }

  function silenceLocal() {
    if (!audioEl) return;
    audioEl.muted = true;
    audioEl.pause();
  }

  // -------------------------------------------------------- session lifecycle
  function session() { return castContext && castContext.getCurrentSession(); }

  function onConnected(freshStart) {
    casting = true;
    silenceLocal();
    if (freshStart) loadQueue(currentLocalTrackId());   // only on a fresh cast
    evaluateMirror();
    // On a resumed session (e.g. after a page reload) the RemotePlayer has not
    // synced with the receiver yet, so the evaluateMirror above sees no media.
    // Keep checking until the receiver's current track arrives.
    syncMirrorFromReceiver();
    updateUI();
  }

  // Poll until the RemotePlayer reflects the receiver's current track, then
  // mirror it — the MEDIA_INFO_CHANGED event can fire before this page's
  // listeners exist, so a resumed session needs this active catch-up.
  function syncMirrorFromReceiver(tries = 40) {
    if (!casting || !remotePlayer) return;
    if (remotePlayer.mediaInfo) { evaluateMirror(); return; }
    if (tries > 0) setTimeout(() => syncMirrorFromReceiver(tries - 1), 250);
  }

  function onDisconnected() {
    casting = false;
    if (audioEl) audioEl.muted = false;
    stopMirror();
    updateUI();
  }

  // A single Cast message can't carry an arbitrarily large queue, so the
  // queue is loaded in chunks of this many tracks.
  const QUEUE_CHUNK = 20;

  function buildQueueItem(t) {
    const cc = window.chrome.cast;
    const info = new cc.media.MediaInfo(t.url, 'audio/mpeg');
    info.streamType = cc.media.StreamType.BUFFERED;
    if (t.duration) info.duration = t.duration;
    const meta = new cc.media.MusicTrackMediaMetadata();
    meta.title = t.title || '';
    meta.artist = t.artist || albumArtist;
    meta.albumName = albumTitle;
    if (t.num) meta.trackNumber = t.num;
    if (artUrl) meta.images = [new cc.Image(artUrl)];
    info.metadata = meta;
    return new cc.media.QueueItem(info);
  }

  // Casting is serialised through loadQueue(). Two things make that necessary:
  // Bandcamp fires 'play' twice on a track switch, and two overlapping
  // loadMedia calls make the receiver reject one with `session_error`. While a
  // load runs, queueLoadingId is the track it starts at and queuePendingId
  // holds a *different* track requested mid-load — applied once the load
  // finishes, so the latest click wins and duplicate fires are dropped.
  let queueLoading = false;
  let queueLoadingId = '';
  let queuePendingId = null;

  // Hand the album to the receiver as a queue, starting at track `startId`
  // (or the first track when startId is empty/unknown). The receiver then
  // plays and auto-advances on its own, independent of this tab.
  async function loadQueue(startId) {
    if (queueLoading) {
      if (startId !== queueLoadingId) queuePendingId = startId;
      return;
    }
    queueLoading = true;
    try {
      let id = startId;
      while (id !== null) {
        queueLoadingId = id;
        queuePendingId = null;
        await loadQueueFrom(id);
        id = queuePendingId;   // a different track clicked during the load?
      }
    } catch (err) {
      console.warn(LOG, 'Queue load failed:', err);
    } finally {
      queueLoading = false;
      queueLoadingId = '';
    }
  }

  async function loadQueueFrom(startId) {
    const ses = session();
    if (!ses) return;
    const cc = window.chrome.cast;

    const castable = tracks.filter((t) => t.url);
    if (!castable.length) { loadSingle(ses); return; }

    // Start at the requested track; fall back to the album's first track.
    let startIndex = castable.findIndex((t) => t.id === startId);
    if (startIndex < 0) startIndex = 0;
    // Resume mid-track only when Bandcamp's player is actually on that track.
    const onStartTrack = audioEl && urlTrackId(audioEl.currentSrc) === startId;
    const startTime = onStartTrack ? audioEl.currentTime || 0 : 0;

    // Queue the album from the chosen track onward; send the first chunk now.
    const items = castable.slice(startIndex).map(buildQueueItem);
    const first = items.slice(0, QUEUE_CHUNK);

    const queueData = new cc.media.QueueData();
    queueData.items = first;
    queueData.startIndex = 0;
    queueData.name = albumTitle;
    queueData.repeatMode = cc.media.RepeatMode.OFF;

    const request = new cc.media.LoadRequest(first[0].media);
    request.queueData = queueData;
    request.currentTime = startTime;
    request.autoplay = true;

    try {
      await ses.loadMedia(request);
    } catch (err) {
      console.warn(LOG, 'Failed to start the cast queue:', err);
      return;
    }
    console.log(LOG, `casting "${albumTitle}" — ${items.length} tracks.`);
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
    const cc = window.chrome.cast;
    for (let rest = remaining; rest.length; rest = rest.slice(QUEUE_CHUNK)) {
      if (queuePendingId !== null) return;   // a reload is queued — stop here
      const req = new cc.media.QueueInsertItemsRequest(rest.slice(0, QUEUE_CHUNK));
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
        const media = ses.getMediaSession();
        if (media || n <= 0) { resolve(media || null); return; }
        setTimeout(() => tick(n - 1), 250);
      };
      tick(tries);
    });
  }

  // Fallback for pages with no track list: cast whatever is playing now.
  function loadSingle(ses) {
    const src = audioEl && (audioEl.currentSrc || audioEl.src);
    if (!src) {
      console.warn(LOG, 'Nothing to cast yet — play a track first, then cast.');
      return;
    }
    const cc = window.chrome.cast;
    const info = new cc.media.MediaInfo(src, 'audio/mpeg');
    info.streamType = cc.media.StreamType.BUFFERED;
    const meta = new cc.media.MusicTrackMediaMetadata();
    meta.title = document.title;
    meta.albumName = albumTitle;
    if (artUrl) meta.images = [new cc.Image(artUrl)];
    info.metadata = meta;
    const request = new cc.media.LoadRequest(info);
    request.autoplay = true;
    request.currentTime = (audioEl && audioEl.currentTime) || 0;
    ses.loadMedia(request).catch(
      (err) => console.warn(LOG, 'loadMedia failed:', err));
  }

  // ----------------------------------------------- mirror onto Bandcamp's player
  // `els` are Bandcamp's own player elements; `mirroring` is true only while
  // the cast is playing a track that belongs to this page.
  let els = null;
  let mirroring = false;
  let scrubbing = false;
  let highlightedRow = null;
  // Local clock: the receiver reports currentTime only occasionally, so we
  // interpolate between its updates to move the progress bar smoothly.
  let clockBase = 0;     // remotePlayer.currentTime at the last receiver update
  let clockWall = 0;     // Date.now() at that moment
  let tickTimer = null;

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
    if (!mirroring) return;                 // not ours — let Bandcamp handle it
    e.preventDefault();
    e.stopImmediatePropagation();
    remoteController.playOrPause();
  }

  function swallowWhenMirroring(e) {
    if (!mirroring) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onScrubStart(e) {
    if (!mirroring || !remotePlayer.duration) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    scrubbing = true;
    applyFraction(fractionFromEvent(e));    // immediate visual feedback

    const move = (ev) => applyFraction(fractionFromEvent(ev));
    const up = (ev) => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      scrubbing = false;
      const t = fractionFromEvent(ev) * remotePlayer.duration;
      remotePlayer.currentTime = t;
      remoteController.seek();
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
    const info = remotePlayer && remotePlayer.mediaInfo;
    const idx = casting && info ? trackIndexForUrl(info.contentId) : -1;
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
    clockBase = remotePlayer.currentTime || 0;
    clockWall = Date.now();
    renderMirror();
  }

  // The current playback position, interpolated since the last receiver update.
  function estimatedTime() {
    if (remotePlayer.isPaused) return clockBase;
    const dur = remotePlayer.duration || 0;
    const est = clockBase + (Date.now() - clockWall) / 1000;
    return dur ? Math.min(est, dur) : est;
  }

  // Run a 500ms ticker only while playback is actually advancing.
  function ensureTicker() {
    const run = mirroring && !remotePlayer.isPaused && !scrubbing;
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
    const dur = remotePlayer.duration || 0;
    const cur = estimatedTime();
    if (!scrubbing) applyFraction(dur ? cur / dur : 0, cur);
    if (els.total) els.total.textContent = formatTime(dur);
    if (els.timeWrap) els.timeWrap.classList.remove('hiddenelem');
    if (els.playbutton) {
      els.playbutton.classList.toggle('playing', !remotePlayer.isPaused);
    }
    ensureTicker();
  }

  // Move the progress bar / thumb / elapsed time to a 0–1 fraction.
  function applyFraction(fraction, time) {
    const pct = (fraction * 100).toFixed(3) + '%';
    if (els.progFill) els.progFill.style.width = pct;
    if (els.thumb) els.thumb.style.left = pct;
    if (els.elapsed) {
      const t = time != null ? time : fraction * (remotePlayer.duration || 0);
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
    btn.addEventListener('click', onCastClick);

    // Preferred: pinned to the top-right corner of the album/track heading.
    const panel = document.querySelector('#name-section');
    if (panel) {
      btn.classList.add('bcast-corner');
      panel.appendChild(btn);
      ui = { btn };
    } else {
      // Fallback: a floating pill for pages without that panel.
      const bar = document.createElement('div');
      bar.className = 'bcast-bar';
      const label = document.createElement('span');
      label.className = 'bcast-label';
      label.textContent = 'Cast';
      bar.append(btn, label);
      bar.addEventListener('click', (e) => {
        if (!btn.contains(e.target)) onCastClick();
      });
      document.body.appendChild(bar);
      ui = { btn, label, bar };
    }
    console.log(LOG, ui.bar
      ? 'Cast button added as a floating control (no heading found).'
      : 'Cast button added to the page heading.');
    updateUI();
  }

  function onCastClick() {
    if (!castContext) {
      console.warn(LOG, 'Cast SDK is still loading — try again in a moment.');
      return;
    }
    if (casting) {
      castContext.endCurrentSession(true);
    } else {
      // Opens Chrome's device-picker dialog.
      castContext.requestSession().catch((err) => {
        const code = (err && err.code) || err;
        if (code && code !== 'cancel') {
          console.warn(LOG, 'Could not start casting:', code,
            '—', (err && err.description) || '', (err && err.details) || '');
        }
      });
    }
  }

  function updateUI() {
    if (!ui) return;
    const ses = session();
    const dev = ses && ses.getCastDevice && ses.getCastDevice();
    const name = (dev && dev.friendlyName) || '';

    ui.btn.classList.toggle('bcast-on', casting);
    ui.btn.title = casting
      ? (name ? `Casting to ${name} — click to stop` : 'Casting — click to stop')
      : 'Cast this album to a device';

    if (ui.bar) ui.bar.classList.toggle('connected', casting);
    if (ui.label) ui.label.textContent = casting ? (name || 'Casting') : 'Cast';
  }
})();
