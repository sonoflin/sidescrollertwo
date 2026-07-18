# Riftbound Arena — Vertical Slice Design

## Match objective

Each pilot begins at an opposite edge of a mirrored 6,400-unit map with a baseline blaster, rechargeable shield, jump, and dash. Bringing the rival to zero wins the round. The first pilot to win two rounds takes the match.

Minion or collapse deaths do not award a round to the rival. They return that pilot to their start and remove every level and pickup earned during the current run.

## The convergence clock

The map is intentionally a race rather than an invitation to farm forever.

- The relay core sits at exact center.
- First contact grants 92 EXP, repairs 32 health, restores shield energy, and gives nine seconds of overdrive.
- At 45 seconds, lethal collapse zones advance from both outer edges at 76 world units per second.
- The best rewards and strongest minions sit closest to center.

This creates a useful tension: detouring for one more upgrade may help in the duel, but it risks conceding the core and losing safe space.

## Progression

Levels are earned at 60, 145, 270, and 440 total EXP. Each level adds 18 maximum health, repairs 24 health, and increases blaster damage by four.

Minion rewards scale by tier:

| Tier | Minion | Role | Base EXP |
| --- | --- | --- | --- |
| 1 | Sentinel | Simple ground patrol | 28 |
| 2 | Drone | Hovering ranged pressure | 52 |
| 3 | Bulwark | Durable ranged blocker | 76 |
| 4 | Siphon | Fast contact threat | 100 |
| 5 | Juggernaut | Center-lane elite | 124 |

## Pickups

- **Weapon core:** up to four permanent-on-run blaster upgrades
- **Shield cell:** restores 55 shield energy
- **Repair:** restores 42 health
- **Cloak:** hides the pilot from minion targeting for seven seconds
- **Overdrive:** raises fire rate for 7.5 seconds

## Networking direction

The vertical slice uses a lightweight WebSocket relay. Player one simulates the match, receives player-two inputs, and broadcasts state snapshots. Player two renders those snapshots while sending local input. This is enough for room-code testing across tabs and networked PCs.

For production, migrate the simulation to an authoritative server and keep this client protocol shape: input messages upstream, compressed snapshots downstream. Add client prediction for the local pilot, reconciliation, interpolation buffers for remote actors, server-side hit validation, reconnect windows, and region-aware matchmaking.
