# 🕯️ Hygge

A Chrome extension that turns the YouTube watch page into a cozy little room — your video sits on the wall next to a window, with curtains, plants, and a warm lamp. The view outside follows **your real sky**: sunrise, sunset, the actual moon phase, and the current local weather.

## ✨ Features

- **Cozy room** around the YouTube player — wall, floor, curtains, window-sill plants, a floor plant, and a lamp.
- **Live sky** — dawn, day, golden hour, and night are calculated from your location's real sunrise and sunset times.
- **Real moon phase** — the moon in the window matches tonight's moon, with twinkling stars.
- **Live weather** — clear, partly cloudy, cloudy, fog, rain, storms (with lightning), and snow, pulled from [Open-Meteo](https://open-meteo.com/) and refreshed every 15 minutes.
- **Works without location** — if you deny location access, it guesses from your time zone so day/night is still right.
- **Theater mode aware** — the room adapts when you switch player modes.
- **One-click toggle** — turn the room on/off from the popup; all open YouTube tabs update instantly.

## 📦 Installation

1. Clone or download this repository:
   ```bash
   git clone https://github.com/MinahilImran836/hygge.git
   ```
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Open any YouTube video and get cozy ☕

## 🎛️ Usage

Click the extension icon to toggle the room on or off. The first time it runs, the browser may ask for your location — this is only used to work out your sunrise/sunset times and local weather.

## 🔒 Permissions

| Permission | Why |
| --- | --- |
| `storage` | Remembers whether the room is on, and caches the last weather reading |
| `geolocation` | Gets your approximate location for the sky and weather |
| `api.open-meteo.com` | Free, key-less weather API |

No data is collected or sent anywhere else.

## 🗂️ Project structure

```
├── manifest.json          # Extension manifest (MV3)
├── assets/                # Curtains, plants, lamp, video border
└── src/
    ├── content/           # Builds the room, sky, and weather on YouTube
    │   ├── content.js
    │   └── content.css
    └── popup/             # On/off toggle
        ├── popup.html
        └── popup.js
```

## 🛠️ Built with

Plain JavaScript, HTML, and CSS — no frameworks, no build step.
