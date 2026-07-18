# Riftbound Arena

An online-first, best-of-three side-scrolling action duel. Two pilots enter a shared map from opposite ends, defeat increasingly dangerous minions, build a run-specific loadout, and converge on the relay core before the arena collapses inward.

![Riftbound Arena](public/og.png)

## Play the vertical slice

Requirements: Node.js 22.13+ and npm.

```bash
npm install
npm run dev
```

Open the web URL printed by the dev server. The same command starts the match relay on port `8788`.

### Test online play on one PC

1. Choose **Create Online Room** in the first browser tab.
2. Open the game in a second tab.
3. Enter the five-character room code and choose **Join**.
4. Each tab launches into its own pilot-centered camera.

For another computer on the same network, open the first computer's LAN URL and use the same room-code flow. A hosted relay can be configured with `NEXT_PUBLIC_RELAY_URL` (see `.env.example`).

Choose **Solo Practice** to test immediately against the synth pilot.

## Controls

| Action | Key |
| --- | --- |
| Move | `A` / `D` |
| Jump | `W` |
| Fire | `F` |
| Shield | `G` |
| Dash | `H` |

## Current systems

- Online room creation and joining with separate per-player cameras
- Host-authoritative prototype simulation relayed to the second client at 20 Hz
- Five minion classes with difficulty and reward scaling toward center
- EXP levels that increase maximum health and blaster damage
- Weapon, shield, repair, cloak, and overdrive pickups
- First-contact relay reward: EXP burst, repair, shield recharge, and timed overdrive
- Arena collapse after 45 seconds to prevent indefinite farming
- Minion/storm defeat resets the run; rival defeat wins the round
- Best-of-three match flow and a solo combat bot

The relay is intentionally lightweight for the vertical slice. A production competitive release should move the complete simulation into an authoritative regional game server, add input prediction/reconciliation, persistence, authentication, matchmaking, and abuse protection.

## Blender characters

Editable sources, game-ready GLB exports, and transparent renders live in `public/assets/characters/`.

Regenerate both pilots with Blender 5.x:

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" --background --python tools\blender\create_characters.py -- public\assets\characters
```

## Checks

```bash
npm run build
npx tsc --noEmit
npm test
```

The web client uses React, Phaser, vinext, and Cloudflare-compatible output. The room relay uses the `ws` WebSocket library.
