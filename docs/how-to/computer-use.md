# Computer Use

Screen capture and input injection, gated by an approval-aware permission
model. Implemented for X11 (works under XWayland); macOS/Windows backends are
future work.

## Permission model

`computerUseSetup/check` reports three permissions plus a setup phase:

| Field | Meaning | How prricode decides |
|---|---|---|
| `accessibility` | UI tree access / AT-SPI | `unknown` on Linux (AT-SPI not required for the X11 backend) |
| `inputMonitoring` | Synthetic input | `granted` when `DISPLAY` is set and the XTEST extension is present |
| `screenRecording` | Screen capture | `granted` when `DISPLAY` is set |
| `setup` | Flow phase | `dormant` (no display), `restartRequired` (display without XTEST), `readyForTarget` (usable), `inProgress`, `stopped` |

`computerUseSetup/start` re-probes and moves a ready host to `inProgress`.

## Settings

`computerUseSettings/update` persists:

```json
{
  "computerControl": "ask" | "alwaysAllow",
  "screenshots": "ask" | "alwaysAllow",
  "blockApps": ["bundle-id", "…"],
  "unblockApps": ["…"]
}
```

`ask` routes every computer action through the approval engine (the client sees
an `approval/requested` notification and answers with `approval/decide`);
`alwaysAllow` executes immediately. Blocked apps are matched against the active
window identity.

## The `computer` tool

| Action | Effect |
|---|---|
| `screenshot` | PNG of the root window, returned as an image part the model can see |
| `mouse_move` `{x, y}` | Move the pointer |
| `left_click` `right_click` `middle_click` `double_click` | Click |
| `type` `{text}` | Type a string (paced at ~80 cps) |
| `key` `{key}` | Key or combo, xdotool syntax (`Return`, `ctrl+c`, …) |
| `scroll` `{x, y, direction, amount}` | Scroll wheel in a direction |
| `drag` `{x, y}` | Press, move, release |
| `wait` `{ms}` | Sleep |
| `cursor_position` | Report the pointer location |

Screenshots prefer `scrot`, then ImageMagick `import`, then `xwd` + `convert`.
Input uses `xdotool`. Install whichever are missing (`apt install
x11-apps scrot xdotool`).

## Testing under Xvfb

```bash
xvfb-run -a -s "-screen 0 1280x800x24" bash -c '
  export DISPLAY=:99
  ./target/debug/prricode serve --provider echo' &
# then over stdio:
#   computerUseSetup/check      -> setup should report readyForTarget
#   turn/start with a prompt that calls the computer tool
```

The agent runtime test suite exercises the tool against `DISPLAY` when present.

## Wayland

Screenshots under Wayland use `grim` (screencopy) and need no special
permission. Input is different — Wayland has no portable injection API and each
compositor exposes its own — so the input method is picked from what is
genuinely installed, in portability order:

| Method | Needs |
|---|---|
| X11 XTEST (`xdotool`) | `DISPLAY` + `xdotool` — the tested path, also covers XWayland |
| `wlrctl` | `WAYLAND_DISPLAY` + a wlroots compositor (sway, Hyprland, river) |
| `ydotool` | `WAYLAND_DISPLAY` + `ydotoold` (uinput, compositor-agnostic) |
| portal RemoteDesktop | `WAYLAND_DISPLAY` + `xdg-desktop-portal` (consent handshake not implemented) |

`computerUseSetup/check` reports which method is in play (`inputMethod`) and,
when none is, the exact reason (`inputUnavailableReason`) — so a client reads
the truth instead of assuming X11.

## Limitations

- X11 is the tested path. On a Wayland-only session without XWayland the input
  method falls through to the selection above, and returns a clear error naming
  what to install when nothing matches.
- The wlrctl/ydotool execution paths have not been exercised against a live
  compositor, and the portal consent handshake is not implemented; both degrade
  to a named reason.
- AT-SPI tree reads are declared `unknown`, not implemented; the X11 backend
  works from pixels and XTEST.
- Multi-monitor capture covers the root window (all monitors).
