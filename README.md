# Video Downloader

A simple web tool that takes a video link from YouTube, Instagram or Facebook and downloads it as an MP4 file. It uses an **Express (Node.js)** backend that runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) and **ffmpeg**, with a small HTML frontend.

> **Educational use only.** Only download content you own or have permission to save. These platforms' terms of service restrict downloading, and you are responsible for how you use this tool.

---

## How it works

1. You paste a video link into the web page and press **Download**.
2. The page calls the server at `/download?url=...`.
3. The server runs `yt-dlp.exe`, which downloads the video to a temporary `downloads/` folder (merging video and audio with ffmpeg).
4. The server sends the finished MP4 to your browser, which saves it to your normal Downloads folder.

---

## Requirements

| Tool | Why it is needed |
|------|------------------|
| [Node.js](https://nodejs.org/) (v18 or newer) | Runs the server |
| [yt-dlp.exe](https://github.com/yt-dlp/yt-dlp/releases) | Does the actual downloading |
| [ffmpeg](https://ffmpeg.org/) | Merges video and audio into one MP4 |
| A system-wide VPN (only if YouTube is blocked on your network) | Browser VPN extensions do **not** cover yt-dlp |

> This guide is for **Windows**. On Linux or macOS, install `yt-dlp` with your package manager and see the "Running on Linux / macOS" section below.

---

## Setup

### 1. Get the project

```bash
git clone https://github.com/YOUR-USERNAME/YOUR-REPO.git
cd YOUR-REPO
```

### 2. Install dependencies

```bash
npm install
```

If there is no `package.json` yet, run `npm init -y` and then `npm install express`.

### 3. Download yt-dlp

1. Go to the [yt-dlp releases page](https://github.com/yt-dlp/yt-dlp/releases).
2. Download **`yt-dlp.exe`**.
3. Put it in the project folder, next to `server.js`.

Keep it up to date, because sites change often:

```powershell
.\yt-dlp.exe -U
```

### 4. Install ffmpeg

Open a terminal and run:

```powershell
winget install Gyan.FFmpeg
```

Close and reopen your terminal (and VS Code), then check that it works:

```powershell
ffmpeg -version
```

If `winget` is not available, download a "release essentials" build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), extract it, and add its `bin` folder to your Windows PATH.

### 5. Project structure

```
your-project/
├── server.js
├── yt-dlp.exe
├── package.json
├── public/
│   └── index.html      (frontend)
├── downloads/          (created automatically, temporary files)
└── cookies.txt         (optional, YouTube only, never share or commit)
```

---

## Running the app

```bash
node server.js
```

You should see:

```
Server running on http://localhost:3000
```

Open **http://localhost:3000** in your browser, paste a video link, and press **Download**.

- Wait after pressing the button. The file is downloaded to the server first, so the browser only starts saving when the download is finished. Long videos can look frozen for a while.
- Press the button **once** per video.
- Watch the terminal. Lines starting with `progress:` show the download percentage.

To stop the server, press `Ctrl + C`. Restart it after any change to `server.js`.

---

## Testing yt-dlp by hand

If something fails, test yt-dlp directly in the terminal first. In PowerShell, programs in the current folder need `.\` in front:

```powershell
.\yt-dlp.exe -4 --js-runtimes node "https://www.youtube.com/watch?v=VIDEO_ID"
```

If this works, the server will work too. If it fails, the problem is the network, yt-dlp, or ffmpeg, not the Node code.

---

## YouTube setup (cookies)

YouTube often asks "Sign in to confirm you're not a bot", especially on VPN or shared networks. To fix it, give yt-dlp your own logged-in session.

1. In Chrome, install the **"Get cookies.txt LOCALLY"** extension and allow it in Incognito.
2. Open an **Incognito window** and log in to YouTube (a spare account is best).
3. In that same tab, open `https://www.youtube.com/robots.txt`, click the extension, and export.
4. Save the file as **`cookies.txt`** in the project folder.
5. Close the incognito window.
6. Make sure `server.js` has this line in its `args`:

```javascript
'--cookies', path.join(__dirname, 'cookies.txt'),
```

> **Warning:** `cookies.txt` works like a password. Never commit it to GitHub, share it, or submit it with your project. Delete it when you are done.

Instagram and Facebook usually work for public videos without cookies. Private posts need login cookies.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `yt-dlp.exe is not recognized` (PowerShell) | Use `.\yt-dlp.exe` |
| Browser tab keeps spinning | Check the terminal output. Make sure the server reads yt-dlp's stdout (it does in this code), and wait for the download to finish |
| `Requested format is not available` | Install ffmpeg, update yt-dlp (`.\yt-dlp.exe -U`), and use the format string in `server.js` |
| `No supported JavaScript runtime` warning | Keep `'--js-runtimes', 'node'` in the `args` |
| `Sign in to confirm you're not a bot` | Switch to another VPN server, or use `cookies.txt` (see above) |
| `ConnectionResetError (10054)` or DNS errors | Your network is blocking YouTube. Use a **system-wide** VPN app (not a browser extension), or try your phone's hotspot |
| `Could not copy Chrome cookie database` | Don't use `--cookies-from-browser`. Use an exported `cookies.txt` |
| Merging fails or `ffmpeg not found` | Install ffmpeg and restart VS Code so PATH updates |
| Connection issues with `-4` | Remove `'-4'` from `args` and try again |

---

## Running on Linux / macOS

The code uses `yt-dlp.exe`, which is Windows only. To run elsewhere:

1. Install `yt-dlp` and `ffmpeg` with your package manager.
2. In `server.js`, replace the yt-dlp path with:

```javascript
const ytDlpPath = process.platform === 'win32'
    ? path.join(__dirname, 'yt-dlp.exe')
    : 'yt-dlp';
```

3. Run `node server.js` as usual.

---

## Note about GitHub

GitHub only stores the code. **GitHub Pages cannot run this project**, because it needs a Node server and yt-dlp. Run it locally, or use a host that supports Node servers. Be aware that YouTube blocks most hosting providers' IP addresses, so downloads often fail on public hosting.

The `.gitignore` for this project should include:

```
cookies.txt
node_modules/
downloads/
*.mp4
*.webm
*.mkv
*.m4a
*.part
yt-dlp.exe
ffmpeg.exe
.env
```

---

## Tech stack

- Node.js and Express
- yt-dlp
- ffmpeg
- HTML, CSS and JavaScript (frontend)

---

## Author

Your Name, Roll No., Course, University
