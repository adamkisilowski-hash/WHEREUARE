# Whereabouts

A location app that runs entirely in the browser. It shows where you are, tracks
where you go, and remembers the places you save — with no server and no build
step. An account is entirely optional (see **Accounts** below) and off by
default; nothing about it is required to use the app.

## Running it

Geolocation requires a secure context, so `file://` won't work. Serve the folder
over `localhost` (which counts as secure) or over HTTPS:

```sh
python3 -m http.server 8080
# or: npx http-server -p 8080
```

Then open <http://localhost:8080>. The browser will ask for location permission
on its own as soon as the page loads — there's no button to find first.

## What it does

The map fills the whole screen at every size. Everything else — coordinates,
trip stats, saved places — lives in a translucent glass sheet anchored to the
bottom, collapsed by default to a slim bar showing where you are. Tap it (or
the grip once it's open) to expand or collapse; tapping the map itself while
it's open collapses it back out of the way, the same as Apple/Google Maps.
Which tab was open and whether the sheet was left expanded both survive a
reload.

The map itself carries a single control: a settings gear in the top corner.
Tapping it spins the gear a half turn and cascades the rest out beneath it —
the map controls (zoom, recenter, heading-up, full screen) and, in a small
glass card, the app's own settings: its accent **colour** and the **transit
mode** toggle. Tapping again winds the same rotation back the other way and
folds them away. The rotation is a plain transition between two angles rather
than a keyframe animation, which is what makes the closing spin run backwards
through the same arc for free and lets an interrupted tap reverse from
wherever it had got to instead of snapping. While they're folded away the
controls are `visibility: hidden`, not merely transparent, so they leave the
tab order too — a button you can't see should never be the next thing
keyboard focus lands on. The keyboard shortcuts work regardless of whether
the panel is open.

**Now** — your current latitude and longitude, plus accuracy, altitude, speed and
heading when the device reports them. The readout updates by itself as you
move, and the map follows — the **Live** pill shows that it's running and
pauses it when you want the battery back. Panning the map by hand stops it
recentring on you, without stopping the updates; the target control (behind
the settings gear, or `l`) forces a fresh fix and recenters on demand. Toggle between decimal degrees and
degrees/minutes/seconds, copy the coordinates, share them as an OpenStreetMap
link, or jump the map to coordinates you paste in.

When it can, the app names the street you're on — shown above the coordinates
and, once known, in place of raw numbers in the collapsed sheet's summary
line. This comes from OSM's free Nominatim reverse-geocoding service, called
sparingly on purpose: at most once every 12 seconds and only once you've
actually moved far enough that the street plausibly changed, since it's a
shared public resource and this stays well inside its usage policy rather
than hammering it on every 1-second poll. A sudden large jump — jumping to
pasted coordinates, say — looks up immediately instead of waiting, since a
stale name right after that would just be wrong rather than merely behind. If
the lookup fails or the spot has no named road, the coordinates are the
fallback either way.

Current conditions — temperature and a short description — come from
[Open-Meteo](https://open-meteo.com), which needs no API key. Refreshed at
most every 10 minutes, or immediately after travelling far enough (20 km)
that the weather might actually be different; switching units just reformats
the reading already in hand rather than asking again.

Between real fixes, the dot doesn't just sit still and jump — while moving at
walking pace or faster, it's nudged forward using the last fix's own reported
speed and heading (dead reckoning), so it glides rather than stutters. This is
purely a rendering effect: the numeric readout, the saved-place coordinates,
and the trip track only ever see real fixes, never an estimate. A fresh real
fix always corrects it immediately, and pausing snaps straight back to the
last real position rather than leaving the dot wherever the estimate drifted.

A precision line under the coordinates grades the current fix — Precise (±20 m
or better), Good, Approximate, or Coarse — so you can tell a satellite fix from
a network one. If a fix is coarser than 500 m the app says so once and points at
the OS setting that causes it, since that's a device permission rather than
something the page can fix. A fix that is both much vaguer than the last one and
somewhere else is held briefly rather than shown, so a GPS dropping to Wi-Fi
positioning doesn't fling the marker across town; a vaguer reading of the *same*
spot is still accepted, so the precision shown never goes stale.

**Full screen** — the ⛶ control (behind the settings gear, or `f`) hides the panel and fills the screen
with the map, leaving a compact readout of coordinates, accuracy and speed in
the corner. It requests real browser fullscreen where that exists and falls back
to the immersive layout where it doesn't, so it still does something useful on
iOS Safari. `Esc` or the same button returns.

**Trip** — start recording and the app draws your path on the map and totals
distance, duration, average and top speed, pace, point count and cumulative
climb. Pace (minutes per km or mile, the way walkers and runners actually
think about effort) answers a different question than a speed figure does,
so both are shown rather than picking one.
Export the track as GPX for any mapping tool. Live updates and trip recording
share a single `watchPosition` watch rather than opening two, and the watch is
released while the page is hidden unless a trip is recording.
Standing-still GPS jitter is filtered out (hops smaller than half the reported
accuracy are ignored) so distance doesn't creep upward while you're stationary.
A trip survives a reload — an accidental refresh, a crashed tab, a phone that
needed a restart — mid-walk: the track, its stats, and whether it was still
recording all come back, and recording resumes on its own rather than leaving
a paused trip you have to notice and restart by hand. A finished-but-unexported
trip sticks around the same way until you export it or tap **Clear trip**.

**Places** — save the spot you're standing on with a name. Saved places are
listed nearest-first with distance and compass bearing from your current
position — each one with a small waypoint arrow pointing straight at it,
alongside the same bearing written out as a compass letter — and marked on
the map as a proper pin (the classic rounded-teardrop shape, tapering to a
point exactly on the coordinate) rather than a plain dot, so a saved place
reads differently from your own live position at a glance. It stays upright
through heading-up rotation the same way every other marker does, and is
exportable as JSON. With no current fix to point from, the list arrow is
left off rather than drawn pointing nowhere, and the row falls back to the
date the place was saved.

A place doesn't have to be where you're standing — **Add place by address**
(in the Places tab) turns a typed address into coordinates via the same
Nominatim service the street name uses, the other direction: forward
geocoding instead of reverse. Submitting searches for the best match, then
asks for a name the same way saving your own location does — pre-filled
with what you typed, so accepting the default is a single tap — and drops a
pin exactly where the search landed. A search with no matches or a failed
request says so rather than silently doing nothing; unlike the automatic
street lookup, this only ever runs from an explicit submit, so it needs no
rate-limiting of its own.

**Transit** — a mode for riding rail *or* the bus, off by default and toggled
from the settings gear. Switching it on paints every railway on the map
(OpenRailwayMap's overlay, drawn over whichever basemap you're using) and adds
a **Transit** tab that works out what you're travelling on:

- **The track under you.** A small Overpass query finds the railways within
  80 m and picks the one you're plausibly running on — sidings, yards and
  crossovers score *down* precisely because every station is full of them,
  so a named main line wins over the spur beside it.
- **Or the stop beside you.** Buses run on ordinary roads, so there's no
  equivalent of "on the rails" — the closest honest signal is standing right
  by a stop. If no track is under you but a mapped bus stop is within 150 m,
  the app switches to bus mode and reads that stop's `route_ref` tag for the
  routes it actually knows serve it: **Routes near you: 100, 200** — never a
  guess at which one you're on, and it says so plainly when a stop has no
  route numbers tagged at all. Rails always take priority when both are
  found: being physically on tracks is close to unambiguous, while a bus stop
  nearby just means a stop is nearby.
- **The kind of service.** For rail, track class settles most of it (a subway
  tunnel is never an intercity), with your speed breaking the remaining tie
  between long-distance and regional on shared main line.
- **Where you're going.** For rail, stations within 15 km; for buses, stops
  within 3 km — filtered to those ahead of you and sorted nearest-first, with
  distance and an ETA from your current speed. Heading comes from the GPS
  when it reports one and from consecutive fixes when it doesn't.
- **A filter that asks, when it can't tell.** Deriving a heading needs you to
  be moving, so the rest of the time — sitting on a platform, or a train that
  hasn't pulled away yet — the app can't know which way you'll go. Rather than
  guess, it asks: **Which way are you heading?**, offering the two ends of the
  line or route (each labelled by its furthest station or stop) as buttons.
  Picking one fixes the direction, and the whole question turns into a
  confirmation — *Is this your train? Heading towards X — check the stops
  below match* — so you narrow it down by reading the real stops against the
  real vehicle rather than trusting a silent guess. On rail, a second toggle,
  **All stops** vs **Fast**, drops the minor halts an express skips, which is
  often the difference between two services on the same line; it stays hidden
  for buses, since OSM has no equivalent tag for "this route skips stops."

**What it deliberately does not do is name your train or bus.** OpenStreetMap
describes infrastructure — where rails run, what a line is called, which
stations and stops sit where. It says nothing about which service is running
right now. Identifying a specific numbered service needs a live timetable
feed, which needs a backend and an operator's API key; guessing a
plausible-looking number instead would be worse than saying so. The estimate
is labelled with its own confidence — up to **confident** on rail, when a
named line, train-like speed and stations lining up ahead all agree, down to
**rough guess** when they don't. A bus guess is capped lower on purpose: it
can reach **likely**, never **confident**, because standing near a stop never
rules out just standing there.

Overpass is a small, donation-funded, heavily-loaded shared service, so the
queries are frugal on purpose: only while transit mode is on, at most once a
minute, and only once you've moved 500 m — comfortably inside its usage
policy rather than polling it on every fix.

**Heading up** — the compass control turns the map so it points the way your
device is pointing, with the needle staying true to north and every marker
counter-rotated to stay upright. It uses `webkitCompassHeading` on iOS (behind
the permission prompt that platform requires, which is why it's a button press)
and absolute `deviceorientation` elsewhere, corrects for the screen's own
rotation, and low-pass filters the reading — raw magnetometer output is far too
jittery to drive a map. Devices without a magnetometer say so rather than
leaving a toggle that does nothing.

**Refreshing** — `watchPosition` only reports when the device decides you've
moved, which on a stationary phone can mean silence for a minute. A poll runs
alongside it for a genuinely current readout, at a rate you choose from the
footer: every 1s, 2s, 5s or 15s, defaulting to 1s. Consumer GNSS chips fix at
about 1 Hz, so 1s is the practical ceiling — polling faster returns the same
fix twice and only costs battery. This is the expensive part of the battery
bill, so it's a control rather than a fixed choice, and the Live pill pauses it
outright.

**App colour** — the settings gear's card carries a swatch strip that
recolours the whole app's accent — the location dot, the track line, the
active tab, the primary buttons — from a small curated palette, plus a
**custom** swatch that opens the OS colour picker (on iOS, the full system
colour sheet). A chosen colour
applies identically in both light and dark rather than being theme-shifted,
and the **default** swatch — split light/dark to signal it follows the theme
— hands the accent back to the theme-aware stylesheet value. Button text on
the accent flips between black and white by the colour's own luminance, so a
pale amber doesn't leave a primary button labelled in near-invisible white.
Deriving that, and the translucent "soft" fill, from a single chosen hex
means the whole family stays in step from one setting.

Preferences (metric/imperial, coordinate format, theme, refresh rate,
language, accent colour) and saved places persist in `localStorage`.

## Language

English, German and Polish are built in. A small pill in the top corner of
the sign-in screen and another next to the theme toggle in the app's own
header — the two places you'd look for it, signed out or in — cycle through
the three; the choice is remembered in `localStorage` and applies everywhere
at once, including error messages, toasts, the weather description, and
banners, not just the static labels. It defaults to the browser's own
language when that's one of the three, English otherwise. Adding a fourth
language means adding one more object to the dictionary in `i18n.js` — no
other file needs to change, since every other file asks for text by key
rather than holding any of its own.

## How it's built

Five source files plus a small set of icon assets, no dependencies, no toolchain:

- `index.html` — structure
- `styles.css` — light/dark theming via CSS custom properties. The map is
  always full-bleed; a single Liquid-Glass bottom sheet overlays it at every
  screen size, rather than a side panel on desktop and a different bottom
  sheet on mobile. Map controls follow the same minimal, native-map-app
  language: related controls — recenter and heading-up — share one grouped
  pill instead of each floating as its own separate circle. Zoom buttons sit
  apart in a smaller, dimmer pill of their own — present for anyone who
  wants them, without competing for attention with the primary controls or
  with scroll/pinch/`+`/`-`, all of which zoom just as well.
- `map.js` — `MiniMap`, a small slippy map: Web Mercator projection, pointer
  panning, wheel and pinch zoom, marker layer, swappable basemaps plus an
  optional second raster layer over the top (the railway overlay in train
  mode, with its own tile cache so toggling it never disturbs a basemap tile
  already on screen), map rotation (one transform over a padded layer, since
  a rotated square needs to be bigger than its viewport), and an SVG overlay
  for the accuracy circle and the recorded track (drawn twice, casing under
  line, so it stays legible over any background)
- `app.js` — geolocation, formatting, trip maths, storage, and UI wiring
- `auth.js` — the sign-in gate; see **Accounts** below
- `i18n.js` — the English/German/Polish dictionary and the `t(key, vars)`
  lookup every other file calls for user-facing text; also walks the
  `data-i18n*` attributes in `index.html` to translate static markup, and
  re-applies on the fly when the language changes
- `firebase-config.js` — your own Firebase project's config, if you set one up

`MiniMap` exists so the app has no mapping-library dependency. It covers what
this app needs — pan, integer zoom, markers, one circle, one polyline — and
deliberately not much else.

## Icon

`favicon.svg` is the source of truth — a white bullseye on the app's own accent
blue, echoing the "you are here" marker drawn on the map itself, so the tab
icon and the home-screen icon are recognizably the same app. Every raster size
(`favicon-16/32/48.png`, `apple-touch-icon.png`, `icon-192/512.png`, and a
maskable 512 for Android's adaptive-icon safe zone) is rendered from that one
SVG rather than hand-edited, so a redesign only ever touches one file.
`manifest.webmanifest` wires the icons up for "Add to Home Screen" as a
standalone app (no browser chrome), and the page's `theme-color` meta tag
tracks the app's own light/dark choice — OS auto or an explicit override —
rather than only the OS scheme, so the browser/status bar always matches the
background actually on screen.

## The basemap

Tiles come from CARTO's Positron (light) and Dark Matter (dark) styles at `@2x`,
which are minimal enough that your position and track stay the loudest things on
screen. Having a real dark basemap beats inverting a light one: inversion gets
the ground right but turns every label into a photographic negative.

Transit mode adds a second raster layer on top: [OpenRailwayMap](https://www.openrailwaymap.org)'s
standard style, which draws the rails themselves (bus routes have no equivalent
free tile overlay, so buses are detected and listed but not drawn). It's
designed for a light background, so on the dark basemap it's brightened
rather than left to sink into it.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
tiles © [CARTO](https://carto.com/attributions) and © [OpenRailwayMap](https://www.openrailwaymap.org).
All are free for personal use and none is meant to carry production traffic —
point `BASEMAP` and `RAILWAY_TILES` at your own tile source or a paid provider
before deploying this anywhere busy.

## Accounts

Sign-in is optional and off by default — the app works exactly as it always
did, with no gate at all, until you set one up.

To turn it on, you need a free [Firebase](https://firebase.google.com)
project:

1. [Create a Firebase project](https://console.firebase.google.com) (no credit
   card required for the free Spark plan).
2. In the project, go to **Build → Authentication → Get started**, and enable
   the **Email/Password** sign-in provider.
3. Go to **Project settings → General → Your apps**, add a **Web app**, and
   copy the `firebaseConfig` object it shows you.
4. Paste those four values into `firebase-config.js` in place of the
   `PLACEHOLDER`s, and deploy.

That's the whole setup — no server, no database schema, nothing else to
host. The app loads the Firebase Authentication SDK directly from Google's
CDN, and only once a real config is present; with the placeholder left in
place, `auth.js` removes the gate and starts the app exactly as before,
rather than showing a login screen nobody can get past.

The config values in `firebase-config.js` (`apiKey`, `authDomain`,
`projectId`, `appId`) are not secret — Firebase's own documentation is
explicit that these identify your project rather than protect it, and are
safe to commit to a public repo. What actually protects your project is
Firebase's own security rules, layered on separately.

Once signed in, a small circular avatar appears in the header — showing the
first letter of the account's email — next to the theme toggle. It opens a
menu with the full email, **Change password** (sends a password reset
email; there's no in-app change-password form, since that keeps this app
from ever needing to touch the current password itself), and **Sign out**.
Signing out reloads the page rather than trying to individually stop every
running watch, poll, and timer — simpler, and just as immediate.

**Scope, deliberately kept narrow:** signing in only gates access to the app
itself. Saved places, trip history, and every preference still live only in
`localStorage` on the device you're using, exactly as before — nothing about
them is synced to Firebase or any server. A second device, or signing in as a
different user on the same device, sees its own separate local data, not a
shared account library. Syncing that data across devices would need a real
database and security rules behind it — a meaningfully bigger project than
authentication alone, and not something to take on silently as a side effect
of adding a login screen.

## Privacy

Trip tracking, saved places, and every preference stay in `localStorage` on
the device you're using — never sent anywhere, synced anywhere, or seen by
anyone but you. There is no analytics and no telemetry.

Your coordinates do leave the device for specific, visible purposes, each of
them a plain HTTPS request to the free service that does the actual work,
never to a server of this app's own (there isn't one): map tile images (see
below), naming the street you're on and finding current weather (both to
OpenStreetMap's Nominatim and Open-Meteo respectively, and only for where
you currently are), searching an address you typed (also Nominatim, sent
only when you submit that search), and the rail/bus-stop lookup while
**transit mode** is on (to Overpass, at most once a minute). None of these run in the
background beyond what's needed to keep the readout current; nothing about
your history or habits accumulates anywhere but your own device. If you've
set up sign-in, the one other thing that leaves the device is the
email/password you register or sign in with, sent to Firebase to
authenticate you. If tiles can't load, the app says so and everything except
the map imagery keeps working.
