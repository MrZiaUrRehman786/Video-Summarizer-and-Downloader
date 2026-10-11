require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { GoogleGenAI, createUserContent, createPartFromUri } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';

const NOTES_LANGUAGE = 'English';   // notes are written in this language, whatever the video's language
const MAX_AUDIO_MB = 150;           // safety limit for the audio fallback

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

function isValidUrl(url) {
    return url && /^https?:\/\//i.test(url);
}

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

// Fetch the thumbnail on the server and embed it as a data URI,
// so it displays even if the platform blocks hotlinking.
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
    const args = [
        ...COMMON_ARGS,
        '--skip-download',
        '--write-subs', '--write-auto-subs',
        '--sub-langs', 'en.*,en',
        '--sub-format', 'vtt',
        '-o', path.join(DOWNLOAD_DIR, `${id}.%(ext)s`),
        '--', videoUrl
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
    const args = [
        ...COMMON_ARGS,
        '-f', 'ba/b',
        '-x', '--audio-format', 'mp3',
        '--postprocessor-args', 'ffmpeg:-ac 1 -b:a 48k',   // mono, small file, fine for speech
        '-o', path.join(DOWNLOAD_DIR, `${id}.%(ext)s`),
        '--', videoUrl
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
    if (!isValidUrl(videoUrl)) {
        return res.status(400).json({ error: 'Please provide a valid http(s) video URL.' });
    }

    try {
        const { code, stdout, stderr } = await runYtDlp([
            ...COMMON_ARGS,
            '--skip-download',
            '--dump-single-json',
            '--', videoUrl
        ]);

        if (code !== 0 || !stdout.trim()) {
            return res.status(500).json({ error: 'Could not read the video: ' + stderr.slice(-300) });
        }

        const info = JSON.parse(stdout);
        const thumbUrl = info.thumbnail ||
            (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : null);

        res.json({
            title: info.title || 'Untitled video',
            uploader: info.uploader || info.channel || '',
            duration: info.duration_string || '',
            thumbnail: await thumbnailToDataUri(thumbUrl)
        });
    } catch (err) {
        console.error('Info error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Summarize without downloading the video: captions first, audio as a fallback
app.get('/summarize', async (req, res) => {
    const videoUrl = req.query.url;
    if (!isValidUrl(videoUrl)) {
        return res.status(400).json({ error: 'Please provide a valid http(s) video URL.' });
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
app.get('/download', (req, res) => {
    const videoUrl = req.query.url;
    if (!isValidUrl(videoUrl)) {
        return res.status(400).send('Please provide a valid http(s) video URL.');
    }

    const id = crypto.randomUUID();
    const args = [
        ...COMMON_ARGS,
        '--newline',
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', path.join(DOWNLOAD_DIR, `${id}.%(ext)s`),
        '--', videoUrl
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
            if (!res.headersSent) res.status(500).send('Download failed:\n' + errorLog.slice(-500));
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