# StepCam — webcam math solver for the Moto G Power

StepCam turns a Moto G Power + a Logitech USB webcam into a standalone problem solver. The webcam looks at a problem (on a monitor, a textbook or paper), you tap the shutter, and the phone shows:

- **The question and the answer together** at the top — plus the exact text to type into an online answer box, with a Copy button.
- **How to solve it** — the problem type, the method, and why that method fits.
- **Step-by-step explanation** — every step written out with rendered math and a plain-English "why".
- **Graphs** you can tap and pinch (parabolas, rational functions with asymptotes, trig, circles, shaded regions, number lines for inequalities).
- **How we know it's right** — the verification.
- **Ask about this problem** — follow-up questions ("why did you divide by 2?", "give me a similar problem") answered like a live tutor.

The phone does everything on its own over **its own Wi-Fi/data**; the computer is not involved.

**Choose your AI by pasting its key** — StepCam detects which one it is:

| Key | Starts with | Cost |
|---|---|---|
| **Google Gemini** (recommended to start) | `AIza` | **Free** — no credit card, daily limit. Get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |
| OpenAI / ChatGPT API | `sk-` | Billed per use by OpenAI ([platform.openai.com](https://platform.openai.com/api-keys)). A ChatGPT Plus subscription does *not* include API use. |
| Anthropic Claude API | `sk-ant-` | Billed per use by Anthropic ([console.anthropic.com](https://console.anthropic.com)). |

### Accuracy safeguards (on by default)

1. **Method identification first** — the AI classifies the problem (algebra, trig, calculus, statistics, linear algebra, word problems, physics/chemistry …) and picks the method a teacher expects.
2. **Math verified with code** — every computation is checked in the AI's Python code-execution sandbox (exact algebra, calculus, statistics).
3. **Double-check** — the problem is solved twice independently. Matching answers are marked **Double-checked ✓**. If they differ, a third, more careful pass re-reads the picture, finds the mistake and shows **Corrected after double-check** with an explanation.
4. **Sharpest-frame capture** — when you tap the shutter, the app picks the sharpest of the last ~1.5 s of webcam frames and sends it at full resolution.

No AI is right 100% of the time. The double-check badge tells you how confident to be, and "Re-solve (max)" or the chat ("Double-check it") gives a second opinion.

---

## Part 1 — Hardware: connecting the Logitech webcam

### What you need

| Item | Notes |
|---|---|
| Moto G Power (USB-C) | Supports USB OTG (USB host), Android 8+ |
| Logitech USB webcam | Any UVC model: C270, C310, C505, C615, C920, C922, C925e, Brio, StreamCam |
| **USB-C OTG adapter** | USB-C (male) → USB-A (female), labelled "OTG" or "data". *Charging-only adapters will not work.* |
| *Recommended:* USB-C hub with **PD charging** | Webcam + charger plugged into the hub, hub into the phone, so the phone charges while it runs |
| Small tripod or stand for the webcam | Logitech webcams have a clip; most have a ¼" tripod thread |
| A stand for the phone | So you can read the solution hands-free |

### Connect it

1. Plug the webcam's USB plug into the OTG adapter (or hub).
2. Plug the adapter into the phone's USB-C port.
3. If StepCam isn't installed yet, nothing happens — that's fine. Once it is, Android asks **"Allow StepCam to access HD Pro Webcam C920?"** → tick **Always open StepCam when this device is connected** → **OK**.

### Position it

- Put the webcam **30–60 cm (1–2 ft) from the screen**, pointing straight at the problem. A mini tripod in front of the monitor, or the webcam clipped onto a stack of books, both work.
- On the computer, **zoom the page to 125–150 %** (Ctrl + `+`, or Cmd + `+` on a Mac) so the problem fills the screen.
- **Avoid glare:** medium monitor brightness, no lamp reflecting in the screen, and tilt the webcam a few degrees off straight-on if you see a bright spot.
- C270 / C310 are fixed-focus: keep them at least 40 cm away. C920 / C922 / Brio autofocus.

---

## Part 2 — Get the app (APK)

### Option A — GitHub builds it for you (no software to install)

1. Create a free account at github.com and make a **new repository** (Private is fine).
2. Unzip `StepCam.zip` on your computer and upload **everything inside the `StepCam` folder** (*Add file → Upload files*, drag everything in, *Commit*). Include the hidden `.github` folder — on a Mac press `Cmd + Shift + .` in Finder to show it; on Windows enable *View → Hidden items*.
3. Open the **Actions** tab. *Build StepCam APK* runs by itself (≈5 minutes). If Actions asks to be enabled, enable it and click *Run workflow*.
4. On the phone, open the repository's **Releases → latest** page and tap **StepCam.apk**.

### Option B — Android Studio

Open the `StepCam` folder in Android Studio, let Gradle sync, connect the phone with USB debugging on, press **Run**.

### Install

Tap `StepCam.apk` → if Android blocks it, tap **Settings → Allow from this source** → back → **Install**. If Play Protect warns, choose **Install anyway** (it's your own build).

---

## Part 3 — First run (2 minutes)

1. Open **StepCam** → allow **Camera** (Android requires it before any app can use a USB webcam).
2. **Free API key:** Settings opens by itself. Tap **Get a free Gemini key** → sign in with your Google account → **Create API key** → copy it → back in StepCam, paste it. It shows *✓ Google Gemini key — free tier*. (An OpenAI or Anthropic key works too, but those charge per question.)
3. Tap **Check setup**. You want three green ticks: *key works* · *USB webcam: … 1920×1080* · *Everything is ready*.
4. Close Settings. The live webcam picture shows under **USB webcam** with a green dot.

## Part 4 — Solving

1. Aim, then tap the green **shutter**.
2. On *Check the shot*: drag a box around the problem you want (recommended when the page has several), add a note if useful (`only #4`, `answer in degrees`, `round to 3 decimals`), tap **Solve with steps**.
3. Wait ~20–90 s (the screen shows what it's doing: reading → figuring out the method → checking the math with code → writing the steps).
4. Read the **Question + Answer** at the top, then **How to solve it**, the **steps**, the **graph**, and the check. Ask follow-ups at the bottom.

**Out of free API questions?** On *Check the shot*, tap **ChatGPT**, **Gemini** or **Claude** to send the picture plus a ready-made step-by-step prompt straight into that chat app (or its website if the app isn't installed).

Tips: **Answers only** hides the work · **Re-solve (max)** reruns with maximum effort · the clock icon shows past solutions · **Phone camera** and **Photo** tabs also work · **Flip** rotates the picture if the webcam is upside down.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Model | Depends on key | Gemini: 3.8 Flash (free). OpenAI: GPT-5.6 Sol (or GPT-6 Astra, Terra, Luna). Claude: Opus 5.5 (or Sonnet/Haiku 5.5). |
| Thinking effort | Thorough | *Maximum* for hard multi-part problems; *Standard* for quick algebra. |
| Work shown | Every step | *Key steps only* for shorter solutions. |
| Double-check every answer | On | Two independent solves + tie-break. ~2× cost. |
| Verify math with code | On | Python/SymPy/SciPy checks of all computations. |
| USB webcam resolution | 1080p | 720p if the preview stutters, 480p for very old webcams. |
| Skip crop step | Off | Solve right after the shutter. |

Cost: **free with a Gemini key** (within Google's free daily limit; Google may use free-tier requests to improve its products). With OpenAI or Anthropic keys, roughly a few cents to ~25¢ per problem with double-check on.

## Troubleshooting

| Problem | Fix |
|---|---|
| "No USB webcam" | Re-seat both ends; flip the adapter; make sure it's an **OTG/data** adapter; try the webcam straight into the adapter (no extension cable). Tap **Connect webcam**. |
| "USB permission denied" | Tap **Connect webcam** → OK. To reset: Settings → Apps → StepCam → Open by default → Clear defaults, then replug. |
| Picture freezes / "Restarting the webcam…" | The app restarts the webcam itself and steps down to a safer video mode. If it keeps happening: Settings → USB webcam resolution → 720p, and use a hub with PD charging (low battery can starve the webcam of power). |
| Blurry text / "hard to read" | Move closer, zoom the web page, crop to one problem, reduce glare. |
| "API key was rejected" / "out of credits" | Paste the whole key again (Gemini keys start with `AIza`). For OpenAI/Anthropic add credit on their site, or switch to a free Gemini key. |
| "Free Gemini limit for today is used up" | StepCam already rotates through all four free Gemini models (about 40 Flash + 1,000 Flash-Lite requests a day). It resets at midnight Pacific time. Meanwhile tap **ChatGPT / Gemini / Claude** under the message (or on the *Check the shot* screen) to send the picture and a step-by-step prompt to that chat app — it uses the app's own free limits. |
| "Connection kept dropping" | The app already retried several times; check the phone's Wi-Fi and tap **Try again** (your photo is kept). |
| "Solutions disagreed" (yellow) | Tap **Re-solve (max)**, or crop tighter so the problem is read cleanly. |

## How it's built

```
app/src/main/java/com/stepcam/app/
  MainActivity.kt   WebView host, permissions, file picker, back button, JS bridge
  UsbCam.kt         UVC webcam driver (UVCAndroid/libuvc over USB OTG): best MJPEG mode, 1.5 s frame
                    ring buffer, sharpest-frame stills (variance of Laplacian), stall watchdog with
                    automatic restart and video-mode fallback
app/src/main/assets/web/
  index.html, styles.css, app.js   UI: capture, crop, solve, question+answer layout, chat, history, setup check
  providers.js     Google Gemini (free tier) + OpenAI Responses API adapters, key auto-detection, feature fallbacks
  solver.js        Claude Messages API: streaming, adaptive thinking, code-execution tool (SymPy/SciPy),
                   pause_turn continuation, double-check + adjudication, retries (network/429/5xx/stalls)
  render.js        Markdown + LaTeX → HTML (KaTeX bundled offline, incl. mhchem for chemistry)
  graph.js         Canvas grapher: functions, piecewise, asymptotes, parametric, points, shading,
                   number lines, π-axis ticks, trace, pan/zoom
  expr.js          Safe math-expression compiler for graphs and answer comparison (no eval)
.github/workflows/build.yml        Cloud build → GitHub Release "latest" with StepCam.apk
```

- Webcam driver: [UVCAndroid](https://github.com/shiyinghan/UVCAndroid) (Apache-2.0). Math rendering: [KaTeX](https://katex.org) (MIT).
- Your API key and history stay in the app's private storage on the phone. Captured images go only to `api.anthropic.com`.
