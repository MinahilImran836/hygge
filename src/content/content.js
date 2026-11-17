(() => {
    "use strict";

    const ENV_ID = "cozytube-environment";
    const ACTIVE_CLASS = "cozytube-active";
    const THEATER_CLASS = "cozytube-theater";

    const MINUTE = 60 * 1000;
    const DAY = 24 * 60 * MINUTE;
    const TWILIGHT = 40 * MINUTE;         // dawn / dusk length either side of sunrise / sunset
    const GOLDEN_HOUR = 60 * MINUTE;      // "evening" starts this long before sunset
    const WEATHER_TTL = 15 * MINUTE;

    const state = {
        enabled: true,
        weather: "clear",         // clear | partly | cloudy | fog | rain | storm | snow
        weatherFetchedAt: 0,
        coords: null,             // { lat, lon } once we know where the user is
        flexy: null,
        flexyObserver: null,
        ready: false              // settings loaded from storage
    };

    const asset = (name) => chrome.runtime.getURL(`assets/${name}`);

    /* =====================================================
       SUN & MOON MATHS
       Standard low-precision solar position (as used by
       SunCalc / NOAA). Accurate to a minute or two, which is
       plenty for a window.
       ===================================================== */
    const RAD = Math.PI / 180;
    const J1970 = 2440588;
    const J2000 = 2451545;
    const toJulian = (ms) => ms / DAY - 0.5 + J1970;
    const fromJulian = (j) => (j + 0.5 - J1970) * DAY;

    function solarTimes(ms, lat, lon) {
        const lw = -lon * RAD;
        const phi = lat * RAD;
        const d = toJulian(ms) - J2000;
        const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
        const ds = 0.0009 + lw / (2 * Math.PI) + n;
        const M = RAD * (357.5291 + 0.98560028 * ds);
        const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
        const L = M + C + RAD * 102.9372 + Math.PI;
        const dec = Math.asin(Math.sin(RAD * 23.4397) * Math.sin(L));
        const noon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

        const cosW = (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
        const noonMs = fromJulian(noon);
        if (cosW < -1) return { polar: "day", noon: noonMs };
        if (cosW > 1) return { polar: "night", noon: noonMs };

        const w = Math.acos(cosW);
        const set = J2000 + 0.0009 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
        const rise = noon - (set - noon);
        return { rise: fromJulian(rise), set: fromJulian(set), noon: noonMs };
    }

    // 0 = new moon, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter
    function moonPhase(ms) {
        const SYNODIC = 29.530588853;
        const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
        const days = (ms - KNOWN_NEW_MOON) / DAY;
        return ((days % SYNODIC) + SYNODIC) % SYNODIC / SYNODIC;
    }

    // SVG path of the lit part of a unit-radius moon
    function moonPath(phase) {
        const rx = Math.abs(Math.cos(phase * 2 * Math.PI)).toFixed(3);
        if (phase < 0.5) {
            const sweep = phase < 0.25 ? 0 : 1;
            return `M0,-1 A1,1 0 0 1 0,1 A${rx},1 0 0 ${sweep} 0,-1 Z`;
        }
        const sweep = phase < 0.75 ? 0 : 1;
        return `M0,-1 A1,1 0 0 0 0,1 A${rx},1 0 0 ${sweep} 0,-1 Z`;
    }

    // Without a location, guess from the time zone so day/night is still right.
    function fallbackCoords() {
        const lon = (-new Date().getTimezoneOffset() / 60) * 15;
        let tz = "";
        try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* ignore */ }
        const southern = /^(Australia|Antarctica)\/|Pacific\/(Auckland|Fiji|Chatham)|America\/(Sao_Paulo|Argentina|Santiago|Montevideo|Asuncion)|Africa\/(Johannesburg|Maputo|Harare|Windhoek)/.test(tz);
        return { lat: southern ? -30 : 35, lon };
    }

    const localNoon = (ms) => {
        const d = new Date(ms);
        d.setHours(12, 0, 0, 0);
        return d.getTime();
    };

    function skyModel(now) {
        const { lat, lon } = state.coords || fallbackCoords();
        const today = solarTimes(localNoon(now), lat, lon);

        if (today.polar) {
            const p = 0.5 + (now - today.noon) / DAY;
            return today.polar === "day"
                ? { phase: "day", sun: p, moon: null }
                : { phase: "night", sun: null, moon: p };
        }

        const { rise, set } = today;
        let phase;
        if (now < rise - TWILIGHT || now > set + TWILIGHT) phase = "night";
        else if (now < rise + TWILIGHT) phase = "dawn";
        else if (now > set - GOLDEN_HOUR) phase = "evening";
        else phase = "day";

        // Moon crosses the sky between one sunset and the next sunrise
        let nightStart, nightEnd;
        if (now >= set) {
            nightStart = set;
            const tomorrow = solarTimes(localNoon(now + DAY), lat, lon);
            nightEnd = tomorrow.rise || set + 12 * 60 * MINUTE;
        } else {
            const yesterday = solarTimes(localNoon(now - DAY), lat, lon);
            nightStart = yesterday.set || rise - 12 * 60 * MINUTE;
            nightEnd = rise;
        }

        return {
            phase,
            sun: (now - rise) / (set - rise),
            moon: now < rise || now > set ? (now - nightStart) / (nightEnd - nightStart) : null
        };
    }

    // Progress 0..1 across the sky -> position inside the window (percent)
    function arcPosition(p) {
        return {
            x: 6 + p * 88,
            y: 90 - Math.sin(p * Math.PI) * 76,
            height: Math.sin(Math.min(Math.max(p, 0), 1) * Math.PI)
        };
    }

    function placeBody(el, progress) {
        if (!el) return;
        const visible = progress !== null && progress > -0.06 && progress < 1.06;
        el.classList.toggle("is-up", visible);
        if (progress === null) return;
        const pos = arcPosition(progress);
        el.style.setProperty("--x", `${pos.x.toFixed(2)}%`);
        el.style.setProperty("--y", `${pos.y.toFixed(2)}%`);
        el.classList.toggle("is-low", pos.height < 0.3);
    }

    function applySky() {
        const env = document.getElementById(ENV_ID);
        if (!env) return;

        const now = Date.now();
        const sky = skyModel(now);

        env.dataset.phase = sky.phase;
        env.dataset.weather = state.weather;

        placeBody(env.querySelector(".cozy-sun"), sky.sun);
        placeBody(env.querySelector(".cozy-moon"), sky.moon);

        const lit = env.querySelector(".cozy-moon .moon-lit");
        if (lit) lit.setAttribute("d", moonPath(moonPhase(now)));
    }

    /* =====================================================
       WEATHER (Open-Meteo, no key needed)
       ===================================================== */
    function weatherFromCode(code) {
        if (code === 0 || code === 1) return "clear";
        if (code === 2) return "partly";
        if (code === 3) return "cloudy";
        if (code === 45 || code === 48) return "fog";
        if (code >= 95) return "storm";
        if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
        if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
        return "clear";
    }

    function locate() {
        return new Promise((resolve) => {
            if (!navigator.geolocation) return resolve(state.coords);
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    state.coords = {
                        lat: Math.round(pos.coords.latitude * 100) / 100,
                        lon: Math.round(pos.coords.longitude * 100) / 100
                    };
                    chrome.storage.local.set({ cozyCoords: state.coords });
                    resolve(state.coords);
                },
                () => resolve(state.coords),
                { maximumAge: 60 * MINUTE, timeout: 20000 }
            );
        });
    }

    async function refreshWeather() {
        if (Date.now() - state.weatherFetchedAt < WEATHER_TTL) return;
        state.weatherFetchedAt = Date.now(); // stops overlapping requests

        const coords = await locate();
        applySky(); // the location may have changed sunrise / sunset
        if (!coords) return;

        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current_weather=true`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            state.weather = weatherFromCode(Number(data.current_weather.weathercode));
            chrome.storage.local.set({ cozyWeather: { condition: state.weather, at: state.weatherFetchedAt } });
        } catch (e) {
            state.weatherFetchedAt = Date.now() - WEATHER_TTL + 2 * MINUTE; // try again soon
        }
        applySky();
    }

    /* =====================================================
       BUILD THE ROOM
       ===================================================== */
    function buildEnvironment() {
        const env = document.createElement("div");
        env.id = ENV_ID;
        env.setAttribute("aria-hidden", "true");
        env.innerHTML = `
            <div class="cozy-wall"></div>

            <div class="cozy-floor"><div class="cozy-baseboard"></div></div>

            <div class="cozy-window">
                <div class="cozy-sky">
                    <div class="cozy-fill sky-layer sky-dawn"></div>
                    <div class="cozy-fill sky-layer sky-day"></div>
                    <div class="cozy-fill sky-layer sky-evening"></div>
                    <div class="cozy-fill sky-layer sky-night"></div>
                    <div class="cozy-fill cozy-stars"></div>
                    <div class="cozy-fill cozy-stars twinkle"></div>
                    <div class="cozy-sun"></div>
                    <div class="cozy-moon">
                        <svg viewBox="-1 -1 2 2" aria-hidden="true">
                            <circle class="moon-dark" r="1"></circle>
                            <path class="moon-lit" d=""></path>
                        </svg>
                    </div>
                    <div class="cozy-fill cozy-clouds clouds-back"></div>
                    <div class="cozy-fill cozy-clouds clouds-heavy"></div>
                    <div class="cozy-fill cozy-clouds clouds-front"></div>
                    <div class="cozy-fill cozy-overcast"></div>
                    <div class="cozy-fill cozy-precip"></div>
                    <div class="cozy-fill cozy-flash"></div>
                    <div class="cozy-fill cozy-glass"></div>
                </div>

                <div class="cozy-sill"></div>
                <div class="cozy-rod"></div>
                <img class="cozy-curtain cozy-curtain-left" src="${asset("curtain-left.png")}" alt="" />
                <img class="cozy-curtain cozy-curtain-right" src="${asset("curtain-right.png")}" alt="" />
                <img class="cozy-sill-plant cozy-sill-left" src="${asset("plant.png")}" alt="" />
                <img class="cozy-sill-plant cozy-sill-right" src="${asset("plant.png")}" alt="" />
            </div>

            <div class="cozy-shade"></div>

            <div class="cozy-floor-plant"><img src="${asset("plant-2.png")}" alt="" /></div>
            <div class="cozy-lamp"><img src="${asset("light.png")}" alt="" /></div>
        `;
        return env;
    }

    function ensureEnvironment(flexy) {
        let env = document.getElementById(ENV_ID);
        if (env && env.parentElement === flexy) return;
        if (!env) env = buildEnvironment();
        flexy.prepend(env);
        applySky();
    }

    function removeEnvironment() {
        const env = document.getElementById(ENV_ID);
        if (env) env.remove();
    }

    /* =====================================================
       WHEN TO SHOW THE ROOM
       Only on /watch, only when enabled, and never while the
       video is fullscreen (then YouTube shows it normally).
       ===================================================== */
    function watchFlexy(flexy) {
        if (state.flexy === flexy) return;
        if (state.flexyObserver) state.flexyObserver.disconnect();
        state.flexy = flexy;
        state.flexyObserver = new MutationObserver(sync);
        state.flexyObserver.observe(flexy, { attributes: true, attributeFilter: ["theater", "fullscreen", "hidden"] });
    }

    let nudgeTimer = 0;
    function nudgePlayer() {
        // YouTube sizes its controls from window resizes; tell it the player box changed.
        const fire = () => window.dispatchEvent(new Event("resize"));
        requestAnimationFrame(fire);
        clearTimeout(nudgeTimer);
        nudgeTimer = setTimeout(fire, 400);
    }

    function sync() {
        if (!state.ready) return;
        const root = document.documentElement;
        const flexy = document.querySelector("ytd-watch-flexy");
        if (flexy) watchFlexy(flexy);

        const onWatchPage = location.pathname === "/watch";
        const fullscreen = Boolean(document.fullscreenElement) || Boolean(flexy && flexy.hasAttribute("fullscreen"));
        const active = state.enabled && onWatchPage && Boolean(flexy) && !fullscreen;
        const theater = Boolean(flexy && flexy.hasAttribute("theater"));

        if (active) ensureEnvironment(flexy);
        else if (!state.enabled) removeEnvironment();

        const changed = root.classList.contains(ACTIVE_CLASS) !== active
            || root.classList.contains(THEATER_CLASS) !== theater;
        root.classList.toggle(ACTIVE_CLASS, active);
        root.classList.toggle(THEATER_CLASS, theater);
        if (changed) {
            nudgePlayer();
            if (active) applySky();
        }
        if (active) refreshWeather();
    }

    // Cheap, throttled check while YouTube builds the page
    let syncQueued = false;
    function queueSync() {
        if (syncQueued) return;
        syncQueued = true;
        // setTimeout rather than requestAnimationFrame: rAF is paused in
        // background tabs, which would leave the room stuck in the wrong state.
        setTimeout(() => {
            syncQueued = false;
            sync();
        }, 50);
    }

    /* =====================================================
       START
       ===================================================== */
    chrome.storage.local.get({ cozyEnabled: true, cozyCoords: null, cozyWeather: null }, (data) => {
        state.enabled = data.cozyEnabled;
        if (data.cozyCoords) state.coords = data.cozyCoords;
        if (data.cozyWeather && Date.now() - data.cozyWeather.at < WEATHER_TTL) {
            state.weather = data.cozyWeather.condition;
            state.weatherFetchedAt = data.cozyWeather.at;
        }
        state.ready = true;
        sync();
    });

    // The popup writes to storage; every open YouTube tab follows along.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.cozyEnabled) {
            state.enabled = changes.cozyEnabled.newValue !== false;
            sync();
        }
    });

    const pageObserver = new MutationObserver(queueSync);
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener("yt-navigate-finish", queueSync);
    document.addEventListener("fullscreenchange", sync);
    window.addEventListener("popstate", queueSync);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) sync();
    });

    setInterval(applySky, MINUTE);
    setInterval(() => {
        if (document.documentElement.classList.contains(ACTIVE_CLASS)) refreshWeather();
    }, WEATHER_TTL);
})();
