# Mac notch app

The whole Canvas Agent in a panel that hangs from the MacBook notch: Talk, Text, Live vision, Photo, the canvas,
pinned screens and tasks. It is the same web app as the phone, inside a small native shell (`mac/`), talking to
the same runner. Pin a widget on the phone and it appears on the Mac; new app deploys reach both.

## Build and run

Requirements: macOS 14 or newer and the Command Line Tools (`xcode-select --install`). No Xcode, no Homebrew.

```bash
bash scripts/mac-run.sh            # build, then launch paired to the laptop's dev stack (run scripts/dev.sh first)
bash scripts/mac-run.sh --matrix   # build, then launch paired to the Matrix instance
bash scripts/mac-run.sh <link>     # any pairing link (https://…/#token=…)
bash mac/build.sh                  # only build → "mac/dist/Canvas Agent.app"
```

Launched without a link (double-click the .app), it asks for the pairing link: paste what `scripts/matrix-pair.sh`
or `scripts/dev.sh` printed. The field is prefilled when the link is on the clipboard. Later: menu bar icon → **Pair…**.

## Using it

- **Folded**: a black pill around the notch with a dot. Green: connected. Red: runner unreachable. Pulsing: a call is live.
- **Hover** opens the panel; moving away folds it. **Click** the pill to keep it open. **Esc**, a click on the notch
  strip, or a click anywhere else folds it. It stays open while you type or while a file chooser is up.
- **Menu bar icon**: Open / Fold, Reload, Open in Browser, Pair…, Quit.
- **Talk / Live vision**: macOS asks for the microphone and camera the first time. The app is signed ad hoc, so it
  asks again after each rebuild.
- **Photo** opens the standard file chooser.
- **Trackpad**: swipe left and right between Tasks, Canvas and the Screens, or click the dots.
- Links the agent opens go to your default browser.

## Limits

- No notifications on the Mac: a WKWebView has no service worker. They keep arriving on the phone.
- After a deploy the panel reloads itself when the runner is back (never during a call).
- The pairing link is kept in UserDefaults (`defaults delete dev.canvas-agent.mac` forgets it).
- On a Mac without a notch the pill sits at the top centre of the menu bar.

## Debugging

Run the binary directly to see its log (page loaded, connection, open/fold); `--pair <link>` pairs, `--snapshot <dir>`
writes `panel.png` and `pill.png` rendered in-process (screen capture from a terminal needs a permission it usually lacks):

```bash
"mac/dist/Canvas Agent.app/Contents/MacOS/CanvasAgent" --snapshot /tmp
```

Right-click inside the panel → Inspect Element opens Web Inspector for the page.

## Code

| File | Does |
|---|---|
| `mac/Sources/CanvasAgent/NotchController.swift` | the panel: where it sits, hover / click / Esc, open and fold animation |
| `mac/Sources/CanvasAgent/NotchView.swift` | the notch shape (flared top, rounded bottom) and the status dot |
| `mac/Sources/CanvasAgent/WebPane.swift` | the WKWebView: persistent storage, mic/camera grant, file chooser, outside links, `shell` bridge |
| `mac/Sources/CanvasAgent/Pairing.swift` | parse / store / check the pairing link |
| `mac/Sources/CanvasAgent/AppDelegate.swift` | menu bar item and the pairing dialog |
| `app/src/lib/shell.ts` | the page side: detects the shell, reports connected / live / typing, reloads after a deploy |
| `mac/build.sh` | `swift build` + assembles and signs the .app (icon from `app/public/icons`) |
