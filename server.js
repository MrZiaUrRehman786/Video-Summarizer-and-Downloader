require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
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
function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ytDlpPath, args);
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
    if (/Unsupported URL/i.test(s)) return 'No downloadable video was found at this link.';
    return 'Could not read the video: ' + s.slice(-300);
}

// ----- remembered "page link -> real video stream" results from the page scanner -----
const resolved = new Map();   // pageUrl -> { url, referer, title, image, at }

function getResolved(pageUrl) {
    const r = resolved.get(pageUrl);
    if (!r) return null;
    if (Date.now() - r.at > RESOLVED_TTL_MS) { resolved.delete(pageUrl); return null; }
    return r;
}

// The URL and extra flags yt-dlp should really use for this link
function targetFor(videoUrl) {
    const r = getResolved(videoUrl);
    if (r) return { url: r.url, extra: ['--referer', r.referer] };
    return { url: videoUrl, extra: [] };
}

// ----- page scanner (like the media detection in download managers) -----
let scanning = false;

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
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            viewport: { width: 1280, height: 720 }
        });
        const page = await context.newPage();

        const found = new Map();   // stream url -> priority (2 = playlist/manifest, 1 = plain file)
        const noiseRe = /doubleclick|googlesyndication|adservice|\/ads?\/|analytics|\.(ts|m4s|aac)(\?|$)/i;
        const manifestRe = /\.(m3u8|mpd)(\?|$)/i;
        const fileRe = /\.(mp4|webm|mkv|mov|m4v)(\?|$)/i;

        const record = (u, ctype = '') => {
            if (!u || u.startsWith('blob:') || u.startsWith('data:') || noiseRe.test(u)) return;
            if (manifestRe.test(u) || /mpegurl|dash\+xml/i.test(ctype)) found.set(u, 2);
            else if (fileRe.test(u) || /^video\//i.test(ctype)) found.set(u, found.get(u) || 1);
        };
        page.on('request', (req) => record(req.url()));
        page.on('response', (resp) => record(resp.url(), resp.headers()['content-type'] || ''));

        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);

        // If nothing was loaded yet, press play on any video player on the page
        for (let round = 0; round < 2 && found.size === 0; round++) {
            for (const frame of page.frames()) {
                await frame.evaluate(() => {
                    document.querySelectorAll('video').forEach((v) => { v.muted = true; v.play().catch(() => {}); });
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

        const media = [...found.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
        return { media, title: meta.title, image: meta.image };
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

// Read the video details. If yt-dlp does not know the site, scan the page for the real stream.
async function getVideoInfo(videoUrl) {
    const t = targetFor(videoUrl);
    const first = await runYtDlp([...COMMON_ARGS, ...t.extra, '--skip-download', '--dump-single-json', '--', t.url]);

    if (first.code === 0 && first.stdout.trim()) {
        const cached = getResolved(videoUrl);
        return shapeInfo(JSON.parse(first.stdout), cached && cached.title, cached && cached.image);
    }

    const canScan = !getResolved(videoUrl) && /Unsupported URL|No video formats|Unable to extract|no video/i.test(first.stderr);
    if (!canScan) throw new Error(explainYtDlpError(first.stderr));

    console.log('Site not supported by yt-dlp. Scanning the page for a video stream...');
    const { media, title, image } = await sniffMedia(videoUrl);
    if (!media.length) {
        throw new Error('No video stream was found on this page. The video may be protected, need a login, or load only after you interact with it.');
    }

    for (const m of media.slice(0, 5)) {
        const rr = await runYtDlp([...COMMON_ARGS, '--referer', videoUrl, '--skip-download', '--dump-single-json', '--', m]);
        if (rr.code === 0 && rr.stdout.trim()) {
            resolved.set(videoUrl, { url: m, referer: videoUrl, title, image, at: Date.now() });
            return shapeInfo(JSON.parse(rr.stdout), title, image);
        }
    }
    throw new Error('A video stream was found but could not be read (it may be protected).');
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
    const args = [
        ...COMMON_ARGS,
        ...t.extra,
        '--newline',
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', path.join(DOWNLOAD_DIR, `${id}.%(ext)s`),
        '--', t.url
    ];

    const ytDlp = spawn(ytDlpPath, args);
    let errorLog = '';

    ytDlp.stdout.on('data', (d) => console.log(`progress: ${d.toString().trim()}`));
    ytDlp.stderr.on('data', (d) => { errorLog += d.toString(); console.log(`yt-dlp: ${d}`); });

    res.on('close', () => { if (ytDlp.exitCode === null) ytDlp.kill(); });

    ytDlp.on('error', (err) => {
        console.error('Could not start yt-dlp:', err.message);
        if (!res.headersSent) res.status(500).send('Could not start yt-dlp.');
    });

    ytDlp.on('close', (code) => {
        if (code !== 0) {
            console.error(`yt-dlp exited with code ${code}`);
            if (!res.headersSent) res.status(500).send(explainYtDlpError(errorLog));
            return;
        }
        const file = fs.readdirSync(DOWNLOAD_DIR)
            .find((f) => f.startsWith(id) && !f.endsWith('.part'));
        if (!file) return res.status(500).send('File not found after download.');

        const filePath = path.join(DOWNLOAD_DIR, file);
        res.download(filePath, 'video.mp4', () => fs.unlink(filePath, () => {}));
    });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));