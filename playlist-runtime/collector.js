/*
 * collectPlaylist(listId)
 *
 * Injected into the active www.youtube.com tab with chrome.scripting.executeScript,
 * so it must be fully self-contained (no references to anything outside this function).
 * Running inside the YouTube tab means requests are same-origin and carry your
 * login cookies, which is what makes private playlists and Watch Later work.
 *
 * Strategy:
 *   1. Fetch the playlist page and parse ytInitialData (first ~100 videos).
 *   2. Follow YouTube's continuation tokens through /youtubei/v1/browse
 *      (100 more videos per request) until the list ends.
 *   3. If YouTube's data format can't be read, fall back to the durations
 *      visible on the page itself (playlist pages only).
 *
 * Returns { ok, title, videos: [[position, seconds|null], ...], partial, note }
 *      or { ok: false, error }.
 */
async function collectPlaylist(listId) {
  const ORIGIN = 'https://www.youtube.com';
  const MAX_PAGES = 200; // 200 x 100 videos; YouTube caps playlists at 5,000

  const progress = (text) => {
    try {
      const p = chrome.runtime.sendMessage({ type: 'plr-progress', listId, text });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* popup closed */ }
  };

  const textOf = (t) => {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('');
    if (typeof t.content === 'string') return t.content;
    return '';
  };

  // "10:13" or "1:02:03" anywhere in a string
  const CLOCK = /(?:^|[^\d:])((?:\d{1,3}:)?\d{1,2}:\d{2})(?![\d:])/;
  const CLOCK_EXACT = /^(?:\d{1,3}:)?\d{1,2}:\d{2}$/;
  const clockToSeconds = (str) => {
    const m = CLOCK.exec(String(str || ''));
    if (!m) return null;
    const secs = m[1].split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
    return secs > 0 ? secs : null;
  };

  // Return the substring of a balanced {...} starting at `start`, respecting JSON strings.
  const sliceBalanced = (src, start) => {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return null;
  };

  const extractJsonAfter = (src, marker) => {
    let from = 0;
    for (;;) {
      const at = src.indexOf(marker, from);
      if (at === -1) return null;
      let start = at + marker.length;
      while (start < src.length && /\s/.test(src[start])) start++;
      if (src[start] === '{') {
        const json = sliceBalanced(src, start);
        if (json) {
          try { return JSON.parse(json); } catch (_) { /* try next occurrence */ }
        }
      }
      from = at + marker.length;
    }
  };

  const findToken = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.continuationCommand && typeof node.continuationCommand.token === 'string') {
      return node.continuationCommand.token;
    }
    if (node.nextContinuationData && typeof node.nextContinuationData.continuation === 'string') {
      return node.nextContinuationData.continuation;
    }
    for (const key of Object.keys(node)) {
      const t = findToken(node[key]);
      if (t) return t;
    }
    return null;
  };

  const readPlaylistVideo = (r, fallbackPos) => {
    let secs = parseInt(r.lengthSeconds, 10);
    if (!(secs > 0)) secs = clockToSeconds(textOf(r.lengthText));
    const pos = parseInt(textOf(r.index).replace(/[^\d]/g, ''), 10);
    return [pos > 0 ? pos : fallbackPos, secs > 0 ? secs : null];
  };

  // Newer "lockup" layout: duration lives in a thumbnail badge as text like "12:34".
  const readLockup = (l, fallbackPos) => {
    if (l.contentType && !/VIDEO/i.test(l.contentType)) return null;
    let secs = null;
    const walk = (n) => {
      if (secs || !n || typeof n !== 'object') return;
      for (const key of Object.keys(n)) {
        const v = n[key];
        if (key === 'text' && typeof v === 'string' && CLOCK_EXACT.test(v.trim())) {
          secs = clockToSeconds(v);
        } else if (v && typeof v === 'object') {
          walk(v);
        }
        if (secs) return;
      }
    };
    walk(l);
    return [fallbackPos, secs];
  };

  const isVideoItem = (x) => x && (x.playlistVideoRenderer || x.lockupViewModel);

  // Walk YouTube's JSON. Only trust continuation tokens that sit in the same
  // array as the videos, so unrelated "load more" tokens elsewhere are ignored.
  const collect = (node, acc) => {
    if (Array.isArray(node)) {
      const hasVideos = node.some(isVideoItem);
      for (const x of node) {
        if (x && x.continuationItemRenderer) {
          if (hasVideos) {
            const t = findToken(x.continuationItemRenderer);
            if (t) acc.tokens.push(t);
          }
          continue;
        }
        collect(x, acc);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.playlistVideoRenderer) {
      acc.pvr.push(readPlaylistVideo(node.playlistVideoRenderer, acc.pvr.length + 1));
      return;
    }
    if (node.lockupViewModel) {
      const v = readLockup(node.lockupViewModel, acc.lockups.length + 1);
      if (v) acc.lockups.push(v);
      return;
    }
    for (const key of Object.keys(node)) collect(node[key], acc);
  };

  const sha1Hex = async (str) => {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Same auth header YouTube's own page sends; needed for private playlists / Watch Later.
  const authHeaders = async (sessionIndex) => {
    const cookie = document.cookie || '';
    const m = /(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie) || /(?:^|;\s*)__Secure-3PAPISID=([^;]+)/.exec(cookie);
    if (!m || !(globalThis.crypto && crypto.subtle)) return null;
    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${ts} ${m[1]} ${ORIGIN}`);
    return {
      Authorization: `SAPISIDHASH ${ts}_${hash}`,
      'X-Origin': ORIGIN,
      'X-Goog-AuthUser': String(sessionIndex || '0'),
    };
  };

  // Fallback: read durations shown on the playlist page itself.
  const fromPage = () => {
    const params = new URLSearchParams(location.search);
    if (location.pathname !== '/playlist' || params.get('list') !== listId) return null;
    const els = document.querySelectorAll('ytd-playlist-video-renderer');
    if (!els.length) return null;
    const badgeSel = 'ytd-thumbnail-overlay-time-status-renderer, badge-shape, #time-status, .badge-shape-wiz__text';
    const videos = Array.from(els, (el, i) => {
      let secs = null;
      for (const b of el.querySelectorAll(badgeSel)) {
        secs = clockToSeconds(b.textContent);
        if (secs) break;
      }
      const pos = parseInt((el.querySelector('#index') || {}).textContent, 10);
      return [pos > 0 ? pos : i + 1, secs];
    });
    const titleEl = document.querySelector(
      'yt-page-header-view-model h1, ytd-playlist-header-renderer #title, ytd-playlist-header-renderer yt-formatted-string'
    );
    return {
      ok: true,
      title: (titleEl && titleEl.textContent.trim()) || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
      videos,
      partial: true,
      note: `Counted the ${videos.length} videos loaded on this page. If the playlist is longer, scroll to the end of it and press refresh.`,
    };
  };

  try {
    progress('Reading the playlist from YouTube…');
    const pageRes = await fetch(`${ORIGIN}/playlist?list=${encodeURIComponent(listId)}`, { credentials: 'include' });
    if (!pageRes.ok) throw new Error(`YouTube answered with HTTP ${pageRes.status}.`);
    const html = await pageRes.text();

    const initial =
      extractJsonAfter(html, 'var ytInitialData =') ||
      extractJsonAfter(html, 'window["ytInitialData"] =') ||
      extractJsonAfter(html, 'ytInitialData =');
    if (!initial) throw new Error('YouTube’s page format wasn’t recognized. Open the playlist page itself (youtube.com/playlist?list=…) and try again.');

    const meta = initial.metadata && initial.metadata.playlistMetadataRenderer;
    const title = (meta && meta.title) || '';

    const acc = { pvr: [], lockups: [], tokens: [] };
    collect(initial, acc);

    if (!acc.pvr.length && !acc.lockups.length) {
      const page = fromPage();
      if (page) return page;
      const alertText = (initial.alerts || [])
        .map((a) => textOf((a.alertRenderer || a.alertWithButtonRenderer || {}).text))
        .filter(Boolean)
        .join(' ');
      return {
        ok: false,
        error: alertText || 'No videos found. The playlist may be private, empty, or not visible to the account you’re signed in with.',
      };
    }

    const apiKey = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1];
    const clientVersion = (/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1] || '2.20250101.00.00';
    const sessionIndex = (/"SESSION_INDEX":"?(\d+)/.exec(html) || [])[1] || '0';
    const context = extractJsonAfter(html, '"INNERTUBE_CONTEXT":') || {
      client: { clientName: 'WEB', clientVersion },
    };
    const visitorData =
      (context.client && context.client.visitorData) || (/"VISITOR_DATA":"([^"]+)"/.exec(html) || [])[1];

    const browse = async (token, withAuth) => {
      const headers = {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': clientVersion,
      };
      if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
      if (withAuth) {
        const auth = await authHeaders(sessionIndex);
        if (!auth) return null; // signed out: caller retries without auth
        Object.assign(headers, auth);
      }
      const url = `${ORIGIN}/youtubei/v1/browse?prettyPrint=false${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ context, continuation: token }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };

    let useAuth = true;
    let token = acc.tokens[0];
    const seen = new Set();
    let stopReason = '';
    let pages = 0;

    while (token && !seen.has(token) && pages < MAX_PAGES) {
      seen.add(token);
      pages++;
      progress(`Loaded ${(acc.pvr.length || acc.lockups.length).toLocaleString()} videos…`);

      let json = null;
      try {
        if (useAuth) json = await browse(token, true);
      } catch (_) {
        json = null;
      }
      if (!json) {
        useAuth = false;
        try {
          json = await browse(token, false);
        } catch (err) {
          stopReason = err.message || 'request failed';
          break;
        }
      }

      acc.tokens = [];
      collect(json, acc);
      token = acc.tokens[0];
    }

    const videos = acc.pvr.length ? acc.pvr : acc.lockups;
    return {
      ok: true,
      title,
      videos,
      partial: Boolean(stopReason),
      note: stopReason
        ? `YouTube stopped answering after ${videos.length.toLocaleString()} videos, so this total is incomplete. Press refresh to try again.`
        : '',
    };
  } catch (err) {
    const page = fromPage();
    if (page) return page;
    return { ok: false, error: (err && err.message) || String(err) };
  }
}
