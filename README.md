# Drive Timer

A lap timer and drive logger for your iPhone. It times laps at Sepang (and any circuit you mark yourself), times road stages, and records free drives. It runs in Safari and sits on the Home Screen like an app. Once it is installed it works with no signal. Recordings stay on the phone until you export them.

Its address, once it is published, will be **https://ec-drives.github.io/drive-timer/**. It has not been published yet.

---

## What it does

| | While you drive | Afterwards |
|---|---|---|
| **Circuit** (Sepang, or a car park loop you mark) | Very large running lap time. Live gain or loss against your best lap, shown as a sign (+/-), an arrow (▲/▼), a word (FASTER/SLOWER) and a colour (green/red). Last lap, best lap, lap number. Each finished lap flashes up for six seconds. | Lap table with sector times; ideal lap (your best sectors added together); speed, and time gained or lost, plotted against distance; a map coloured by speed or by where you gained and lost time; G-forces (G-G chart). Comparison with any other lap or session. |
| **Road stage** (for example "Genting climb") | Only that it is recording, GPS quality and distance. **No timer while the car moves.** The result appears once you have crossed the finish and stopped. | Every run of that stage, from every recording, fastest first; splits, speed, gain or loss, map, G-G. |
| **Free drive** | Only that it is recording, GPS quality and distance. | Route map coloured by speed, speed against distance, G-G, distance, duration, moving time, top speed. |

Recording always works the same way, whatever you choose. You can time a recording against a circuit or stage later, even one you define afterwards.

Every GPS row in a session file carries the exact UTC time, so heart rate from the Garmin can be merged with it later on the laptop.

---

## Before the track day: the car-park test

1. Open **Drive Timer** and tap **Drive**.
2. Drive to the spot you want as the start/finish line, facing the way you will drive, and **stop**.
3. Tap **Mark a line here** and choose **Start/finish of a new circuit**. Hold still for about five seconds while it averages the GPS.
4. Drive away. The line takes its direction from the first 15 metres you drive.
5. Tap **START**. Drive a few loops. Lap 1 starts the first time you come back across the line.
6. To finish, **press and hold** the stop button for about a second. This stops an accidental tap from ending the session.
7. The analysis opens on its own. Tap **Export** and AirDrop the file to the laptop so the motion-sensor data can be checked (see the limits section below).

The circuit you marked is saved under **Tracks**, where you can rename it. Its shortest allowed lap is 10 seconds, so short car-park loops count.

## At Sepang

1. On the **Drive** tab, check that it says **Timing with: Sepang International Circuit**.
2. Choose what the live gain or loss is measured against: **Best lap this session**, or **Best ever**, which is your fastest lap in any session on the phone.
3. Mount the phone where it can see the sky, out of direct sun. Tap **START** while still in the pits.
4. Hold the stop button when you are back in the pits.

The Sepang lines are already set. Start/finish is on the main straight. There are three sectors: Turns 1 to 4, Turns 5 to 11, and Turns 12 to 15. These sectors are this app's own, not the official ones.

## Road stages

There are three ways to set a stage's lines:

- **On the spot:** stop at the start, then **Mark a line here**, then **Start of a new road stage**. Drive the stage, stop just past the finish, then **Mark a line here** and **Finish of ...**.
- **On an earlier recording:** open any session, tap **Define a stage here**, tap the start on the map, then the finish, then optional split points in driving order. Then name it.
- **By coordinates:** go to **Tracks**, then **New road stage**, then **Coordinates**. For each line, enter latitude, longitude and the direction of travel in degrees (90 means east).

When a stage is saved, the app searches every saved recording and times every run of it. This is the **Tracks** page for that stage.

On public roads the screen shows no timer while you drive. Results appear only after you stop.

## Getting files to and from the laptop

- **Export:** open a session and tap **Export**. Once the file is ready, tap **Share or save**. The iPhone share sheet offers **Save to Files** and **AirDrop**. The file is a plain CSV named like `session_20261013_095638.csv`, in the same format as your friend's Android logger, so the two can swap files.
- **Import:** tap **Sessions**, then **Import file**. The app recognises Sepang on its own and times the laps. Files from the Android logger import the same way.
- **Your circuits and stages:** **Tracks**, then **Export my circuits and stages** saves them as one file. Stages can start near home, so they leave the phone only when you export them.

---

## Trying it on the laptop

Double-click **`Start Drive Timer on this laptop.bat`** in this folder. It opens the app in your browser at http://localhost:8765/ and only this laptop can see it. Close the black window to stop it.

The laptop has no GPS, but you can still:

- import a session file and look at the analysis;
- go to **More**, then **Replay demo**, to watch a recorded session play through the live screen at 5, 10 or 30 times speed;
- open **More**, then **Run the test suite**, to run the self-checks. They currently show 55 of 55 passing.

## Putting it on the iPhone (once it is published)

1. On the iPhone, open **Safari** and go to https://ec-drives.github.io/drive-timer/
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open **Drive Timer** from the Home Screen **once while you have signal**. After that it works offline.
4. On the first **START**, allow **Location** and **Motion & Orientation**.
5. On the iPhone, check **Settings > Privacy & Security > Location Services > Safari Websites**. It should say **While Using the App**, with **Precise Location** on. Without Precise Location, timing is impossible.

To update after a new version is published, open the app with signal, close it, and open it again.

---

## Known limits (please read)

- **Accuracy.** Phone GPS updates about once a second. Lap and sector times are good to roughly 0.1 to 0.3 seconds, and the analysis screen says so. Treat smaller differences as a tie. The timer works out the moment you crossed the line between two GPS readings, so this is the honest limit, not a bug.
- **Keep it on screen.** iPhone web apps cannot use GPS in the background. The app keeps the screen awake, but if you lock the phone or switch apps the recording pauses. It saves every second, so nothing before that point is lost.
- **Screen awake.** The app uses the iPhone's screen-lock control. If the phone refuses, the live screen shows **Keep screen on**; tap it to use the silent-video method instead. As a backstop, set **Settings > Display & Brightness > Auto-Lock** to **Never** for the day. The silent-video method has been checked on the laptop but not yet on an iPhone.
- **Heat.** An iPhone in direct sun on a Malaysian dashboard can overheat, dim the screen and stop GPS. Use a vent or windscreen mount in the shade.
- **Motion sensors.** iPhone Safari is known to report acceleration with the opposite sign to Android. The app checks this against the phone's orientation at the start of every recording and writes what it found into the file. This has only been tested with simulated data, so the first real iPhone file from the car-park test should be checked on the laptop. The G-forces in the analysis come from GPS, not from these sensors, so they do not depend on how the phone is mounted.
- **Large imports.** Importing a full Android file with all its motion data (about 28 MB) has not been tried on the iPhone yet. The GPS part of such a file imports and is timed correctly on the laptop.
- **Storage.** The app asks iOS to protect its data, but export sessions you care about. Deleting the app from the Home Screen deletes its recordings.
- **Maps** show only the GPS path, with no map background. That is deliberate: it keeps the app offline and private.
- **Turn numbers** on the Sepang map are placed approximately.

## Privacy

There are no accounts, no analytics and no map services. After the app has loaded, it makes no network requests at all; the page itself forbids them. Everything stays on the phone until you export a file.

---

## For the record (technical)

- **App files:** `index.html`, `css/`, `js/`, `builtin/library.json` (Sepang as data), `assets/keepawake.mp4` (the silent video), `icons/`, `manifest.webmanifest`, `sw.js` (offline cache). Paths are relative, so it runs from any folder, including `/drive-timer/` on GitHub Pages. No build step.
- **Tests:** `test/index.html`. These are synthetic courses with known lap times, file-format checks, and a replay of a real recorded session. The replay runs only on a computer that holds the session file and its expected results in `data/`; elsewhere those checks show as skipped.
- **Tools** (Python, run from this folder):
  - `tools/serve.py`: local server.
  - `tools/lap_check.py`: independent lap checker. Example: `python tools/lap_check.py data\sepang-2026-10-13\session_20261013_095638.csv --line 2.760752,101.73806,265,40`.
  - `tools/make_icons.py` and `tools/make_keepawake_mp4.py`: these regenerate the icons and the video.
- **Session file format:** CSV rows `A` (acceleration, m/s²), `G` (rotation, rad/s), `L` (GPS with `utc_ms`), and `E` (events START, CAL, LAP, STOP), with a `#` header. `L` rows use the time each GPS fix was taken. The iPhone's raw motion values are stored, and converted only when a file is exported.
- **Not in git:** `data/` (recordings), `screenshots/`, and any `session_*.csv`.
