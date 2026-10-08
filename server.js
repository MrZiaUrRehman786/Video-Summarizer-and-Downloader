const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.use(express.static('public'));

app.get('/download', (req, res) => {
    const videoUrl = req.query.url;

    if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
        return res.status(400).send('Please provide a valid http(s) video URL.');
    }

    const id = crypto.randomUUID();
    const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');

    const args = [
    '-4',
    '--js-runtimes', 'node',
    '--no-playlist',
    '--newline',
    '--retries', '3',
    '--socket-timeout', '30',
    '--cookies', path.join(__dirname, 'cookies.txt'),
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',   // best video + audio, merged by ffmpeg
    '--merge-output-format', 'mp4',
    '-o', path.join(DOWNLOAD_DIR, `${id}.%(ext)s`),
    '--',
    videoUrl
];

    const ytDlp = spawn(ytDlpPath, args);
    let errorLog = '';

    // IMPORTANT: read stdout too, otherwise yt-dlp can freeze
    ytDlp.stdout.on('data', (data) => {
        console.log(`progress: ${data.toString().trim()}`);
    });

    ytDlp.stderr.on('data', (data) => {
        errorLog += data.toString();
        console.log(`yt-dlp: ${data}`);
    });

    res.on('close', () => {
        if (ytDlp.exitCode === null) ytDlp.kill();
    });

    ytDlp.on('error', (err) => {
        console.error('Could not start yt-dlp:', err.message);
        if (!res.headersSent) res.status(500).send('Could not start yt-dlp.');
    });

    ytDlp.on('close', (code) => {
        if (code !== 0) {
            console.error(`yt-dlp exited with code ${code}`);
            if (!res.headersSent) {
                return res.status(500).send('Download failed:\n' + errorLog.slice(-500));
            }
            return;
        }

        const file = fs.readdirSync(DOWNLOAD_DIR)
            .find(f => f.startsWith(id) && !f.endsWith('.part'));

        if (!file) return res.status(500).send('File not found after download.');

        const filePath = path.join(DOWNLOAD_DIR, file);
        res.download(filePath, 'video.mp4', () => {
            fs.unlink(filePath, () => {});
        });
    });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));