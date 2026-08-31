# Undercall — Beta Test Build

Node/Express multiplayer social deception game for 2–5 players.

## Render
- Environment: Node
- Root Directory: leave empty
- Build Command: `npm install`
- Start Command: `npm start`
- Optional environment variable: `ADMIN_PASSWORD`

## Beta admin
Join a room first, then click **BETA ADMIN** in the top bar.
Default beta password: `slaapzuinig`.

The server validates the password and gives the browser a temporary admin session token. Admin controls are intended for private beta testing only and can:
- start/reset a room
- manually trigger every challenge type
- force the one-time eavesdrop challenge
- force the 10-second eavesdrop window when a third player is outside an active call
- trigger the secret frequency
- reveal a single code digit or all four
- block a code digit
- set the main timer, force 10 seconds, or force timer expiry
- assign the saboteur role for testing
- clear the active challenge

For a public deployment, set a strong `ADMIN_PASSWORD` environment variable instead of relying on the default.
