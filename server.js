require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { GoogleGenAI, createUserContent, createPartFromUri } = require('@google/genai');

// Optional: used to scan pages whose video address yt-dlp cannot find by itself.
// Install with:  npm install playwright   then:  npx playwright install chromium
let chromium = null;
try { ({ chromium } = require('playwright')); }
catch { console.log('Playwright is not installed: page scanning is disabled (yt-dlp-supported sites still work).'); }

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';

const NOTES_LANGUAGE = 'English';   // notes are written in this language, whatever the video's language
const MAX_AUDIO_MB = 150;           // safety limit for the audio fallback
const RESOLVED_TTL_MS = 30 * 60 * 1000;

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
const cookiesPath = path.join(__dirname, 'cookies.txt');

// One browser identity, used by the page scanner, yt-dlp and the built-in HLS downloader,
// so the video server sees the same client everywhere.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Flags shared by every yt-dlp call
const COMMON_ARGS = [
    '-4',
    '--js-runtimes', 'node',
    '--no-playlist',
    '--retries', '3',
    '--socket-timeout', '30',
    ...(fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [])
];

app.use(express.static('public'));

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- URL safety: any public website is allowed, but never your own computer or network -----
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168);
    }
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
        v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

async function isAllowedUrl(url) {
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return false;
        const host = u.hostname.replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
        const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
        return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
    } catch {
        return false;
    }
}

const BAD_URL_MESSAGE = 'Please paste a valid public http(s) video or page link.';

// ----- yt-dlp -----

// Run yt-dlp and return { code, stdout, stderr }
function runYtDlp(args, onProc) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ytDlpPath, args);
        if (onProc) onProc(proc);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); console.log(`yt-dlp: ${d}`); });
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

function explainYtDlpError(stderr) {
    const s = String(stderr);
    if (/DRM/i.test(s)) return 'This video is DRM-protected and cannot be downloaded.';
    if (/Sign in to confirm|not a bot/i.test(s)) return 'The site asked for a login or bot check. Try a different video or network.';
    if (/HTTP Error 403|403: Forbidden/i.test(s)) return 'The site refused the download (error 403).';
    if (/Cloudflare|anti-bot/i.test(s)) return 'This site blocks automated downloads with a bot-protection check, so the video could not be read.';
    if (/Unsupported URL/i.test(s)) return 'No downloadable video was found at this link.';
    return 'Could not read the video: ' + s.slice(-300);
}

// ----- remembered "page link -> real video stream" results from the page scanner -----
const resolved = new Map();   // pageUrl -> { url, referer, origin, title, image, at }

function getResolved(pageUrl) {
    const r = resolved.get(pageUrl);
    if (!r) return null;
    if (Date.now() - r.at > RESOLVED_TTL_MS) { resolved.delete(pageUrl); return null; }
    return r;
}

const isManifest = (u) => /\.m3u8(\?|$)/i.test(u);

// The headers the real player sent with the stream request (this is what avoids the 403)
function headersFor(r) {
    const h = { 'User-Agent': USER_AGENT };
    if (r && r.referer) h.Referer = r.referer;
    if (r && r.origin) h.Origin = r.origin;
    return h;
}

function ytDlpHeaderArgs(r) {
    const args = ['--user-agent', USER_AGENT];
    if (r && r.referer) args.push('--referer', r.referer);
    if (r && r.origin) args.push('--add-header', `Origin:${r.origin}`);
    return args;
}

// The URL and extra flags yt-dlp should really use for this link
function targetFor(videoUrl) {
    const r = getResolved(videoUrl);
    if (r) return { url: r.url, extra: ytDlpHeaderArgs(r) };
    return { url: videoUrl, extra: [] };
}

// Source for the built-in HLS downloader: a scanned stream, or a pasted .m3u8 link
function hlsSourceFor(videoUrl) {
    const r = getResolved(videoUrl);
    if (r && isManifest(r.url)) return { url: r.url, headers: headersFor(r) };
    if (isManifest(videoUrl)) return { url: videoUrl, headers: { 'User-Agent': USER_AGENT } };
    return null;
}

function formatDuration(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ----- page scanner (like the media detection in download managers) -----
let scanning = false;

// Opens the page in a real browser, plays the video and records every stream request.
// For each stream it also remembers WHO asked for it (the player iframe) - sites like
// the anime/embed hosts only serve the stream when the Referer/Origin match that player,
// and answer 403 to anything else.
async function sniffMedia(pageUrl) {
    if (!chromium) {
        throw new Error('Page scanning is not installed. Run "npm install playwright" and then "npx playwright install chromium", and restart the server.');
    }
    if (scanning) throw new Error('Another page is being scanned right now. Please try again in a minute.');
    scanning = true;

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: USER_AGENT,
            locale: 'en-US',
            viewport: { width: 1280, height: 720 }
        });
        const page = await context.newPage();

        const found = new Map();   // stream url -> { priority (2 = playlist, 1 = plain file), referer, origin }
        const noiseRe = /doubleclick|googlesyndication|adservice|\/ads?\/|analytics|\.(ts|m4s|aac)(\?|$)/i;
        const manifestRe = /\.(m3u8|mpd)(\?|$)/i;
        const fileRe = /\.(mp4|webm|mkv|mov|m4v)(\?|$)/i;

        const record = (u, ctype = '', req = null) => {
            if (!u || u.startsWith('blob:') || u.startsWith('data:') || noiseRe.test(u)) return;
            let priority = 0;
            if (manifestRe.test(u) || /mpegurl|dash\+xml/i.test(ctype)) priority = 2;
            else if (fileRe.test(u) || /^video\//i.test(ctype)) priority = 1;
            if (!priority) return;

            const prev = found.get(u);
            if (prev && prev.priority >= priority) return;

            // the page that really asked for this stream
            let referer = '';
            if (req) {
                try { referer = req.headers().referer || ''; } catch (e) { /* ignore */ }
                if (!referer) { try { referer = req.frame().url(); } catch (e) { /* ignore */ } }
            }
            if (!/^https?:/i.test(referer)) referer = pageUrl;
            let origin = '';
            try { origin = new URL(referer).origin; } catch (e) { /* ignore */ }

            found.set(u, { priority, referer, origin });
        };
        page.on('request', (req) => record(req.url(), '', req));
        page.on('response', (resp) => record(resp.url(), resp.headers()['content-type'] || '', resp.request()));

        const nav = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const pageStatus = nav ? nav.status() : 0;
        await page.waitForTimeout(4000);

        // If nothing was loaded yet, press play on any video player on the page
        for (let round = 0; round < 2 && found.size === 0; round++) {
            for (const frame of page.frames()) {
                await frame.evaluate(() => {
                    document.querySelectorAll('video').forEach((v) => { v.muted = true; v.playbackRate = 16; v.play().catch(() => {}); });
                    document.querySelectorAll('[class*="play" i], [aria-label*="play" i], .vjs-big-play-button, .jw-icon-display')
                        .forEach((el) => { try { el.click(); } catch (e) { /* ignore */ } });
                }).catch(() => {});
            }
            await page.waitForTimeout(5000);
        }

        const meta = await page.evaluate(() => ({
            title: document.title || '',
            image: (document.querySelector('meta[property="og:image"]') || {}).content || ''
        })).catch(() => ({ title: '', image: '' }));

        const media = [...found.entries()]
            .sort((a, b) => b[1].priority - a[1].priority)
            .map(([url, v]) => ({ url, referer: v.referer, origin: v.origin }));
        return { media, title: meta.title, image: meta.image, pageStatus };
    } finally {
        scanning = false;
        if (browser) await browser.close().catch(() => {});
    }
}

// Fetch the thumbnail on the server and embed it as a data URI,
// so it displays even if the site blocks hotlinking.
async function thumbnailToDataUri(url) {
    if (!url) return null;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return url;
        const type = r.headers.get('content-type') || 'image/jpeg';
        if (!type.startsWith('image/')) return url;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 3 * 1024 * 1024) return url;
        return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
        return url;
    }
}

function shapeInfo(info, titleOverride, imageOverride) {
    const thumbUrl = imageOverride || info.thumbnail ||
        (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : null);
    return {
        title: titleOverride || info.title || 'Untitled video',
        uploader: info.uploader || info.channel || '',
        duration: info.duration_string || '',
        thumbUrl
    };
}

// Read the video details. If yt-dlp does not know the site (or the site blocks yt-dlp
// with a 403), scan the page for the real stream and read that instead.
async function getVideoInfo(videoUrl) {
    const t = targetFor(videoUrl);
    const first = await runYtDlp([...COMMON_ARGS, ...t.extra, '--skip-download', '--dump-single-json', '--', t.url]);

    if (first.code === 0 && first.stdout.trim()) {
        const cached = getResolved(videoUrl);
        return shapeInfo(JSON.parse(first.stdout), cached && cached.title, cached && cached.image);
    }

    // A pasted .m3u8 link that yt-dlp cannot read: try the built-in HLS reader
    const direct = !getResolved(videoUrl) && isManifest(videoUrl) ? hlsSourceFor(videoUrl) : null;
    if (direct) {
        try {
            const p = await probeHls(direct.url, { headers: direct.headers, isAllowed: isAllowedUrl });
            return { title: 'HLS video', uploader: '', duration: formatDuration(p.duration), thumbUrl: null };
        } catch (e) { throw new Error('Could not read this HLS playlist: ' + e.message); }
    }

    // Includes 403/Cloudflare: those are exactly the sites where yt-dlp is refused but a real browser works
    const canScan = !getResolved(videoUrl) &&
        /Unsupported URL|No video formats|Unable to extract|no video|HTTP Error 403|HTTP Error 503|403: Forbidden|Cloudflare|anti-bot/i.test(first.stderr);
    if (!canScan) throw new Error(explainYtDlpError(first.stderr));

    console.log('yt-dlp could not read this page directly. Scanning the page for a video stream...');
    const { media, title, image, pageStatus } = await sniffMedia(videoUrl);
    if (!media.length) {
        if (pageStatus === 403 || pageStatus === 503) {
            throw new Error(`The website itself refused the page scanner (HTTP ${pageStatus}). It uses a bot-protection check, so the video address could not be read.`);
        }
        throw new Error('No video stream was found on this page. The video may be protected, need a login, or load only after you interact with it.');
    }

    console.log(`Found ${media.length} candidate stream(s):`);
    media.slice(0, 10).forEach((m) => console.log(`  - ${m.url.slice(0, 140)}\n    (referer: ${m.referer})`));

    let lastErr = '';

    // 1) HLS playlists: read them ourselves and keep the LONGEST one (skips ads and short previews)
    let best = null;
    for (const m of media.filter((x) => isManifest(x.url)).slice(0, 8)) {
        try {
            const p = await probeHls(m.url, { headers: headersFor(m), isAllowed: isAllowedUrl });
            console.log(`  playlist OK: ${p.segments} chunks, ${formatDuration(p.duration)}`);
            if (!best || p.duration > best.p.duration) best = { m, p };
        } catch (e) {
            lastErr = e.message;
            console.log(`  playlist failed: ${e.message}`);
        }
    }
    if (best) {
        resolved.set(videoUrl, { ...best.m, title, image, at: Date.now() });
        return shapeInfo({ duration_string: formatDuration(best.p.duration) }, title, image);
    }

    // 2) other stream types (mp4 files, DASH): let yt-dlp read them with the player's headers
    for (const m of media.filter((x) => !isManifest(x.url)).slice(0, 5)) {
        const rr = await runYtDlp([...COMMON_ARGS, ...ytDlpHeaderArgs(m), '--skip-download', '--dump-single-json', '--', m.url]);
        if (rr.code === 0 && rr.stdout.trim()) {
            resolved.set(videoUrl, { ...m, title, image, at: Date.now() });
            return shapeInfo(JSON.parse(rr.stdout), title, image);
        }
        lastErr = rr.stderr || lastErr;
    }
    throw new Error(/Cloudflare|anti-bot|DRM|403/i.test(lastErr)
        ? explainYtDlpError(lastErr)
        : 'A video stream was found but could not be read (it may be protected).');
}

// ---------- captions path ----------

// Convert a .vtt caption file into plain text
function vttToText(vtt) {
    const out = [];
    let last = '';
    for (let line of vtt.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line === 'WEBVTT' || /^(Kind|Language|NOTE)/.test(line)) continue;
        if (line.includes('-->') || /^\d+$/.test(line)) continue;
        line = line.replace(/<[^>]+>/g, '').trim();
        if (line && line !== last) { out.push(line); last = line; }
    }
    return out.join(' ');
}

// Download captions only (no video) and return them as text
async function getTranscript(videoUrl) {
    const id = crypto.randomUUID();
    const t = targetFor(videoUrl);
    const args = [
        ...COMMON_ARGS,
        ...t.extra,
        '--skip-download',
        '--write-subs', '--write-auto-subs',
        '--sub-langs', 'en.*,en',
        '--sub-format', 'vtt',
        '-o', path.join(DOWNLOAD_DIR, `${id}.%(ext)s`),
        '--', t.url
    ];

    const { code, stderr } = await runYtDlp(args);
    const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.startsWith(id) && f.endsWith('.vtt'));

    if (files.length === 0) {
        throw new Error(code !== 0
            ? 'Could not read captions: ' + stderr.slice(-200)
            : 'This video has no captions available.');
    }

    const text = vttToText(fs.readFileSync(path.join(DOWNLOAD_DIR, files[0]), 'utf8'));
    files.forEach((f) => fs.unlink(path.join(DOWNLOAD_DIR, f), () => {}));
    return text;
}

// ---------- Gemini ----------

const NOTES_PROMPT =
    'You turn videos into study notes. Use only what is said in the video. ' +
    `Write all notes in ${NOTES_LANGUAGE}, even if the video is in another language. ` +
    'Respond with ONLY valid JSON in exactly this shape: ' +
    '{"title": string, "summary": string (3-5 sentences), ' +
    '"headings": [{"heading": string, "points": [string]}], ' +
    '"key_points": [string], ' +
    '"definitions": [{"term": string, "meaning": string}]}. ' +
    'Use an empty array for definitions if none are explained in the video. ' +
    'If there is no spoken content, set "summary" to "No spoken content was found in this video." and use empty arrays for the rest.';

// True for temporary errors: overloaded (503), rate limit (429), timeout (504)
function isOverloaded(err) {
    const text = `${err.status || ''} ${err.code || ''} ${err.message || ''}`;
    return /\b(503|429|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(text);
}

// Short, readable message for the web page
function friendlyError(err) {
    const msg = String(err.message || err);
    if (isOverloaded(err)) {
        return 'The AI service is busy or its free limit was reached. Please wait a minute and try again.';
    }
    if (/API key/i.test(msg)) {
        return 'The Gemini API key is missing or invalid. Check GEMINI_API_KEY in .env.';
    }
    return msg;
}

async function callGemini(model, contents) {
    const response = await ai.models.generateContent({
        model,
        contents,
        config: {
            systemInstruction: NOTES_PROMPT,
            responseMimeType: 'application/json',
            maxOutputTokens: 8192
        }
    });
    return JSON.parse(response.text.replace(/```json|```/g, '').trim());
}

// Try the main model 3 times, then the backup model 3 times
async function generateNotes(contents) {
    const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL];
    const waits = [0, 3000, 8000];   // milliseconds to wait before each attempt
    let lastErr;

    for (const model of models) {
        for (let i = 0; i < waits.length; i++) {
            if (waits[i]) await sleep(waits[i]);
            try {
                return await callGemini(model, contents);
            } catch (err) {
                lastErr = err;
                console.log(`Gemini (${model}) attempt ${i + 1} failed: ${String(err.message).slice(0, 120)}`);
                // Only retry temporary problems. A bad key or similar stops immediately.
                if (!(isOverloaded(err) || err instanceof SyntaxError)) throw err;
            }
        }
    }
    throw lastErr;
}

// Notes from a text transcript
function summarizeTranscript(transcript) {
    return generateNotes(`Transcript:\n\n${transcript.slice(0, 400000)}`);
}

// ---------- audio fallback path ----------

// Download only the audio track as a small mono MP3 (needs ffmpeg)
async function downloadAudio(videoUrl) {
    const id = crypto.randomUUID();

    // HLS streams found by the page scanner: yt-dlp's native downloader rejects playlists that
    // have no end marker, so fetch the chunks ourselves and extract the audio with ffmpeg.
    const hls = hlsSourceFor(videoUrl);
    if (hls) {
        let videoFile = null;
        try {
            console.log('Downloading the stream to extract its audio...');
            videoFile = await downloadHls(hls.url, path.join(DOWNLOAD_DIR, id), {
                headers: hls.headers,
                isAllowed: isAllowedUrl,
                concurrency: DEFAULT_THREADS
            });
            const mp3 = path.join(DOWNLOAD_DIR, `${id}.mp3`);
            await runFfmpeg(['-y', '-loglevel', 'error', '-i', videoFile, '-vn', '-ac', '1', '-b:a', '48k', mp3]);
            return mp3;
        } catch (e) {
            console.log('Built-in audio extraction failed: ' + String(e.message).slice(0, 150) + ' - trying yt-dlp...');
        } finally {
            if (videoFile) fs.unlink(videoFile, () => {});
        }
    }

    const t = targetFor(videoUrl);
    const args = [
        ...COMMON_ARGS,
        ...t.extra,
        '-f', 'ba/b',
        '-x', '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -b:a 48k',   // mono, small file, fine for speech
        '-o', path.join(DOWNLOAD_DIR, `${id}.%(ext)s`),
        '--', t.url
    ];

    const { stderr } = await runYtDlp(args);
    const file = fs.readdirSync(DOWNLOAD_DIR).find((f) => f.startsWith(id) && f.endsWith('.mp3'));

    if (!file) {
        throw new Error('Could not extract audio (is ffmpeg installed?): ' + stderr.slice(-300));
    }
    return path.join(DOWNLOAD_DIR, file);
}

// Upload the audio to Gemini and ask it to listen and write the notes
async function summarizeFromAudio(videoUrl) {
    const audioPath = await downloadAudio(videoUrl);
    let uploaded = null;

    try {
        const sizeMB = fs.statSync(audioPath).size / (1024 * 1024);
        if (sizeMB > MAX_AUDIO_MB) {
            throw new Error(`The audio is too large (${sizeMB.toFixed(0)} MB). Try a shorter video.`);
        }

        uploaded = await ai.files.upload({ file: audioPath, config: { mimeType: 'audio/mpeg' } });

        // Wait until Gemini has finished processing the file
        let file = uploaded;
        for (let i = 0; i < 45 && file.state === 'PROCESSING'; i++) {
            await sleep(2000);
            file = await ai.files.get({ name: uploaded.name });
        }
        if (file.state === 'FAILED') throw new Error('Gemini could not process the audio file.');
        if (file.state === 'PROCESSING') throw new Error('Gemini took too long to process the audio.');

        return await generateNotes(createUserContent([
            createPartFromUri(file.uri, file.mimeType || 'audio/mpeg'),
            'Listen to the speech in this audio from a video and write the study notes.'
        ]));
    } finally {
        fs.unlink(audioPath, () => {});                                   // delete local audio
        if (uploaded && uploaded.name) {
            ai.files.delete({ name: uploaded.name }).catch(() => {});     // delete the copy on Gemini
        }
    }
}

// ---------- built-in HLS (m3u8) downloader ----------
// Used when yt-dlp cannot read a stream: fetches the playlist and every chunk with the
// player's own headers, decrypts AES-128 if needed, joins the chunks and remuxes to MP4.
// Not supported: DRM / SAMPLE-AES, live streams, separate audio-only renditions.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// How many video chunks are downloaded at the same time (1-32). More = faster on a fast
// connection, but some sites block or rate-limit very high values. Override per download
// with  /download?url=...&threads=16   or globally with HLS_CONCURRENCY in .env
const clampThreads = (n, fallback) => Math.min(32, Math.max(1, parseInt(n, 10) || fallback));
const DEFAULT_THREADS = clampThreads(process.env.HLS_CONCURRENCY, 12);

class HlsError extends Error {}

const abs = (base, rel) => new URL(rel, base).href;

// ---------- network ----------

function withTimeout(signal, ms) {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), ms);
    const onAbort = () => c.abort();
    if (signal) {
        if (signal.aborted) c.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
        signal: c.signal,
        done: () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
    };
}

// GET a URL as a Buffer. Redirects are followed by hand so every hop can be safety-checked.
async function fetchBuffer(url, { headers = {}, signal, isAllowed, timeoutMs = 30000 } = {}) {
    const t = withTimeout(signal, timeoutMs);
    try {
        let current = url;
        for (let hop = 0; hop < 6; hop++) {
            if (isAllowed && !(await isAllowed(current))) throw new HlsError('Blocked address: ' + new URL(current).hostname);
            const r = await fetch(current, { headers, signal: t.signal, redirect: 'manual' });
            const loc = r.headers.get('location');
            if (r.status >= 300 && r.status < 400 && loc) { current = abs(current, loc); continue; }
            if (!r.ok) {
                const e = new HlsError(`HTTP ${r.status} while fetching ${new URL(current).hostname}`);
                e.status = r.status;
                throw e;
            }
            return Buffer.from(await r.arrayBuffer());
        }
        throw new HlsError('Too many redirects.');
    } finally {
        t.done();
    }
}

// ---------- playlist parsing ----------

function parseAttrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
}

const afterColon = (line) => line.slice(line.indexOf(':') + 1);

function parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const a = parseAttrs(afterColon(lines[i]));
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
        if (!lines[j]) continue;
        const res = /(\d+)x(\d+)/.exec(a.RESOLUTION || '');
        variants.push({
            url: abs(baseUrl, lines[j]),
            bandwidth: Number(a.BANDWIDTH) || 0,
            height: res ? Number(res[2]) : 0
        });
    }
    return variants;
}

function parseMedia(text, baseUrl) {
    let seq = 0;
    let key = null;
    let map = null;
    let pending = 0;
    let total = 0;
    const segments = [];

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            seq = parseInt(afterColon(line), 10) || 0;
        } else if (line.startsWith('#EXT-X-KEY:')) {
            const a = parseAttrs(afterColon(line));
            if (a.METHOD === 'NONE') key = null;
            else if (a.METHOD === 'AES-128' && a.URI) key = { uri: abs(baseUrl, a.URI), iv: a.IV || null };
            else throw new HlsError(`Unsupported or protected stream (${a.METHOD || 'unknown encryption'}).`);
        } else if (line.startsWith('#EXT-X-MAP:')) {
            const a = parseAttrs(afterColon(line));
            if (a.URI) map = abs(baseUrl, a.URI);
        } else if (line.startsWith('#EXTINF:')) {
            pending = parseFloat(afterColon(line)) || 0;
        } else if (!line.startsWith('#')) {
            segments.push({ url: abs(baseUrl, line), duration: pending, key, seq: seq++ });
            total += pending;
            pending = 0;
        }
    }

    if (!segments.length) throw new HlsError('The playlist contains no video chunks.');
    return { segments, map, duration: total, live: !text.includes('#EXT-X-ENDLIST') };
}

// Load a playlist; if it is a master playlist, follow the best-quality variant
async function loadMediaPlaylist(url, opts, depth = 0) {
    const text = (await fetchBuffer(url, opts)).toString('utf8');
    if (!text.trimStart().startsWith('#EXTM3U')) throw new HlsError('That address did not return an HLS playlist.');

    if (text.includes('#EXT-X-STREAM-INF')) {
        if (depth > 2) throw new HlsError('Playlist nesting is too deep.');
        const variants = parseMaster(text, url);
        if (!variants.length) throw new HlsError('The master playlist has no video variants.');
        variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
        return loadMediaPlaylist(variants[0].url, opts, depth + 1);
    }
    return parseMedia(text, url);
}

// Quick check used for the info card: is this a readable stream, and how long is it?
async function probeHls(url, opts = {}) {
    const pl = await loadMediaPlaylist(url, opts);
    return { duration: pl.duration, segments: pl.segments.length, live: pl.live };
}

// ---------- decrypt + download ----------

function ivFor(seg) {
    if (seg.key.iv) {
        const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
        return Buffer.from(hex, 'hex');
    }
    const iv = Buffer.alloc(16);              // default IV = segment sequence number, big-endian
    iv.writeUInt32BE(seg.seq >>> 0, 12);
    return iv;
}

function decrypt(buf, keyBuf, iv) {
    const d = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
    return Buffer.concat([d.update(buf), d.final()]);
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const p = spawn(FFMPEG, args);
        let err = '';
        p.stderr.on('data', (d) => { err += d.toString(); });
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
    });
}

/**
 * Download an HLS stream to `<outBase>.mp4` (or `<outBase>.ts` if ffmpeg is unavailable).
 * options: { headers, signal, isAllowed, onProgress(done,total), concurrency }
 * Returns the final file path.
 */
async function downloadHls(url, outBase, options = {}) {
    const { signal, onProgress, concurrency = 6 } = options;
    const netOpts = { headers: options.headers || {}, signal, isAllowed: options.isAllowed };

    const pl = await loadMediaPlaylist(url, netOpts);
    // Many sites leave out the end marker even for normal episodes, so a missing one is not an error.
    // (A true live stream will simply give the few chunks currently listed.)
    if (pl.live) console.log('Note: the playlist has no end marker; downloading every chunk it lists.');

    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hls-'));
    const ext = pl.map ? 'mp4' : 'ts';
    const rawPath = `${outBase}.raw.${ext}`;
    const total = pl.segments.length;

    const keyCache = new Map();
    const getKey = (uri) => {
        if (!keyCache.has(uri)) {
            keyCache.set(uri, fetchBuffer(uri, netOpts).then((b) => {
                if (b.length !== 16) throw new HlsError('The decryption key has an unexpected size.');
                return b;
            }));
        }
        return keyCache.get(uri);
    };

    async function fetchOne(seg, file) {
        let lastErr;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (signal && signal.aborted) throw new HlsError('Cancelled.');
            try {
                let buf = await fetchBuffer(seg.url, netOpts);
                if (seg.key) buf = decrypt(buf, await getKey(seg.key.uri), ivFor(seg));
                await fsp.writeFile(file, buf);
                return;
            } catch (e) {
                lastErr = e;
                // 403/404 will not fix themselves; temporary errors are worth retrying
                if (e.status && e.status < 500 && e.status !== 429) throw e;
                await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
        }
        throw lastErr;
    }

    try {
        const partFile = (i) => path.join(workDir, `${String(i).padStart(6, '0')}.part`);
        if (pl.map) await fsp.writeFile(path.join(workDir, 'init.part'), await fetchBuffer(pl.map, netOpts));

        let next = 0;
        let done = 0;
        let failed = null;
        const worker = async () => {
            while (!failed) {
                const i = next++;
                if (i >= total) return;
                try {
                    await fetchOne(pl.segments[i], partFile(i));
                } catch (e) { failed = failed || e; return; }
                done++;
                if (onProgress) onProgress(done, total);
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
        if (failed) throw failed;

        // join the chunks in order
        const fh = await fsp.open(rawPath, 'w');
        try {
            if (pl.map) await fh.write(await fsp.readFile(path.join(workDir, 'init.part')));
            for (let i = 0; i < total; i++) await fh.write(await fsp.readFile(partFile(i)));
        } finally {
            await fh.close();
        }

        // remux to a clean MP4 (stream copy, no re-encoding)
        const mp4 = `${outBase}.mp4`;
        try {
            await runFfmpeg(['-y', '-loglevel', 'error', '-i', rawPath, '-c', 'copy', '-movflags', '+faststart', mp4]);
            await fsp.rm(rawPath, { force: true });
            return mp4;
        } catch (e) {
            // no ffmpeg (or it failed): hand back the joined file as it is
            const fallback = `${outBase}.${ext}`;
            await fsp.rename(rawPath, fallback);
            return fallback;
        }
    } catch (e) {
        await fsp.rm(rawPath, { force: true }).catch(() => {});
        throw e;
    } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

// ---------- routes ----------

// Video info for the card: title, uploader, duration, thumbnail
app.get('/info', async (req, res) => {
    const videoUrl = req.query.url;
    if (!(await isAllowedUrl(videoUrl))) {
        return res.status(400).json({ error: BAD_URL_MESSAGE });
    }

    try {
        const info = await getVideoInfo(videoUrl);
        res.json({
            title: info.title,
            uploader: info.uploader,
            duration: info.duration,
            thumbnail: await thumbnailToDataUri(info.thumbUrl)
        });
    } catch (err) {
        console.error('Info error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Summarize without downloading the video: captions first, audio as a fallback
app.get('/summarize', async (req, res) => {
    const videoUrl = req.query.url;
    if (!(await isAllowedUrl(videoUrl))) {
        return res.status(400).json({ error: BAD_URL_MESSAGE });
    }

    try {
        let notes;
        let source = 'captions';

        try {
            const transcript = await getTranscript(videoUrl);
            if (transcript.length < 50) throw new Error('The captions are too short to use.');
            notes = await summarizeTranscript(transcript);
        } catch (captionErr) {
            // If Gemini itself failed (busy, bad key), do not start the slower audio path
            if (isOverloaded(captionErr) || /API key/i.test(String(captionErr.message))) throw captionErr;

            console.log('Captions path failed (' + String(captionErr.message).slice(0, 120) + '). Using audio instead...');
            source = 'audio';
            notes = await summarizeFromAudio(videoUrl);
        }

        res.json({ ...notes, source });
    } catch (err) {
        console.error('Summarize error:', err.message);
        res.status(500).json({ error: friendlyError(err) });
    }
});

// Download the video file
app.get('/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!(await isAllowedUrl(videoUrl))) {
        return res.status(400).send(BAD_URL_MESSAGE);
    }

    const id = crypto.randomUUID();
    const t = targetFor(videoUrl);
    const threads = clampThreads(req.query.threads, DEFAULT_THREADS);
    const args = [
        ...COMMON_ARGS,
        ...t.extra,
        '--newline',
        '-N', String(Math.min(threads, 16)),   // parallel fragments for HLS/DASH
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', path.join(DOWNLOAD_DIR, `${id}.%(ext)s`),
        '--', t.url
    ];

    // Stop everything if the browser cancels the download
    const abort = new AbortController();
    let child = null;
    res.on('close', () => {
        abort.abort();
        if (child && child.exitCode === null) child.kill();
    });

    const findOutput = () => fs.readdirSync(DOWNLOAD_DIR)
        .find((f) => f.startsWith(id) && !/\.(part|ytdl|raw\.\w+)$/.test(f));
    const cleanup = () => fs.readdirSync(DOWNLOAD_DIR)
        .filter((f) => f.startsWith(id))
        .forEach((f) => fs.unlink(path.join(DOWNLOAD_DIR, f), () => {}));

    try {
        let filePath = null;
        let hlsErr = '';
        let ytErr = '';

        // 1) HLS streams found by the page scanner: fetch the chunks ourselves, with the player's headers
        const hls = hlsSourceFor(videoUrl);
        if (hls) {
            console.log(`Downloading the HLS chunks directly (${threads} at a time)...`);
            let lastPct = -1;
            try {
                filePath = await downloadHls(hls.url, path.join(DOWNLOAD_DIR, id), {
                    headers: hls.headers,
                    signal: abort.signal,
                    isAllowed: isAllowedUrl,
                    concurrency: threads,
                    onProgress: (done, total) => {
                        const pct = Math.floor((done / total) * 10) * 10;
                        if (pct !== lastPct) { lastPct = pct; console.log(`progress: ${done}/${total} chunks`); }
                    }
                });
            } catch (err) {
                hlsErr = err.message;
                console.error('Built-in HLS download failed:', err.message, '- trying yt-dlp...');
            }
        }

        // 2) yt-dlp (YouTube, Facebook, other sites, and the fallback for HLS)
        if (!filePath && !abort.signal.aborted) {
            try {
                const r = await runYtDlp(args, (p) => { child = p; });
                ytErr = r.stderr;
                if (r.code !== 0) console.error(`yt-dlp exited with code ${r.code}`);
            } catch (err) {
                console.error('Could not start yt-dlp:', err.message);
                ytErr = err.message;
            }
            const file = findOutput();
            if (file) filePath = path.join(DOWNLOAD_DIR, file);
        }

        if (!filePath) {
            cleanup();
            if (!res.headersSent && !abort.signal.aborted) {
                res.status(500).send(hlsErr ? 'Could not download the video stream: ' + hlsErr
                    : ytErr ? explainYtDlpError(ytErr) : 'File not found after download.');
            }
            return;
        }

        const ext = path.extname(filePath) || '.mp4';
        res.download(filePath, `video${ext}`, () => cleanup());
    } catch (err) {
        console.error('Download error:', err.message);
        cleanup();
        if (!res.headersSent) res.status(500).send('Download failed: ' + err.message);
    }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));