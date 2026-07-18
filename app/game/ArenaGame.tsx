"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";

type GameMode = "cpu" | "online";

type MatchConfig = {
  mode: GameMode;
  localPlayer: 0 | 1;
  tutorial?: boolean;
  roomCode?: string;
  socket?: WebSocket;
};

type PilotHud = {
  hp: number;
  maxHp: number;
  shield: number;
  level: number;
  exp: number;
  nextExp: number;
  weapon: number;
  status: string;
  progress: number;
};

type HudState = {
  pilots: [PilotHud, PilotHud];
  scores: [number, number];
  seconds: number;
  phase: string;
  announcement: string;
  coreOwner: number | null;
  matchWinner: number | null;
};

const EMPTY_PILOT: PilotHud = {
  hp: 100,
  maxHp: 100,
  shield: 100,
  level: 1,
  exp: 0,
  nextExp: 60,
  weapon: 0,
  status: "STANDARD",
  progress: 0,
};

const INITIAL_HUD: HudState = {
  pilots: [{ ...EMPTY_PILOT }, { ...EMPTY_PILOT }],
  scores: [0, 0],
  seconds: 90,
  phase: "SURGE IN 45",
  announcement: "",
  coreOwner: null,
  matchWinner: null,
};

const PILOTS = [
  { name: "ASTRA", color: "#16e1ff", image: "/assets/characters/astra.png" },
  { name: "VANTA", color: "#ff2f9d", image: "/assets/characters/vanta.png" },
] as const;

type GameSurfaceProps = {
  config: MatchConfig;
  session: number;
  onHud: (hud: HudState) => void;
  onDisconnect: () => void;
};

function GameSurface({ config, session, onHud, onDisconnect }: GameSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let game: import("phaser").Game | null = null;
    let disposed = false;
    let socketMessageHandler: ((event: MessageEvent) => void) | null = null;
    let tutorialStartHandler: (() => void) | null = null;

    void (async () => {
      const PhaserModule = await import("phaser");
      const Phaser = PhaserModule.default;

      type ArcadeSprite = import("phaser").Physics.Arcade.Sprite;
      type ArcBody = import("phaser").Physics.Arcade.Body;
      type ShieldFx = import("phaser").GameObjects.Ellipse;

      type Pilot = {
        id: number;
        sprite: ArcadeSprite;
        shieldFx: ShieldFx;
        hp: number;
        maxHp: number;
        shield: number;
        level: number;
        exp: number;
        weapon: number;
        nextShot: number;
        nextDash: number;
        invulnerableUntil: number;
        cloakUntil: number;
        overdriveUntil: number;
        lastHazardHit: number;
        facing: number;
        respawning: boolean;
      };

      const WORLD_WIDTH = 6400;
      const FLOOR_Y = 790;
      const CENTER_X = WORLD_WIDTH / 2;
      const LEVEL_EXP = [0, 60, 145, 270, 440];
      const STARTS = [420, WORLD_WIDTH - 420];
      const MINION_TYPES = ["sentinel", "drone", "bulwark", "siphon", "juggernaut"];

      type ControlIntent = { move: number; jump: boolean; fire: boolean; shield: boolean; dash: boolean };
      type NetPilot = {
        x: number; y: number; vx: number; vy: number; flip: boolean; active: boolean;
        hp: number; maxHp: number; shield: number; level: number; exp: number; weapon: number;
        cloakUntil: number; overdriveUntil: number; facing: number; respawning: boolean;
      };
      type NetMinion = { serial: number; x: number; y: number; flip: boolean; hp: number; tier: number; kind: string };
      type NetPickup = { serial: number; x: number; y: number; kind: string };
      type NetShot = { serial: number; x: number; y: number; owner?: number; damage: number; hostile: boolean };
      type NetworkSnapshot = {
        pilots: [NetPilot, NetPilot]; minions: NetMinion[]; pickups: NetPickup[]; shots: NetShot[];
        coreOwner: number | null; leftStormWidth: number; rightStormWidth: number;
        announcement: string; announceUntil: number; hud: HudState;
      };
      type NetworkPayload = { kind: "input"; controls: ControlIntent } | { kind: "snapshot"; snapshot: NetworkSnapshot };
      let receiveNetworkPayload: ((payload: NetworkPayload) => void) | null = null;
      let beginTutorialRun: (() => void) | null = null;

      class ArenaScene extends Phaser.Scene {
        private pilots: Pilot[] = [];
        private platforms!: import("phaser").Physics.Arcade.StaticGroup;
        private minions!: import("phaser").Physics.Arcade.Group;
        private shots!: import("phaser").Physics.Arcade.Group;
        private hostileShots!: import("phaser").Physics.Arcade.Group;
        private pickups!: import("phaser").Physics.Arcade.Group;
        private keys!: Record<string, import("phaser").Input.Keyboard.Key>;
        private score: [number, number] = [0, 0];
        private roundNumber = 1;
        private roundStartedAt = 0;
        private roundActive = false;
        private coreOwner: number | null = null;
        private core!: import("phaser").GameObjects.Arc;
        private coreHalo!: import("phaser").GameObjects.Arc;
        private leftStorm!: import("phaser").GameObjects.Rectangle;
        private rightStorm!: import("phaser").GameObjects.Rectangle;
        private announcement = "";
        private announceUntil = 0;
        private nextHud = 0;
        private aiTick = 0;
        private aiIntent = { move: -1, jump: false, fire: false, shield: false, dash: false };
        private remoteIntent: ControlIntent = { move: -1, jump: false, fire: false, shield: false, dash: false };
        private minionSerial = 0;
        private pickupSerial = 0;
        private shotSerial = 0;
        private nextNetworkFrame = 0;
        private matchWinner: number | null = null;
        private tutorialLocked = config.tutorial === true;
        private readonly replica = config.mode === "online" && config.localPlayer === 1;

        constructor() {
          super("riftbound-arena");
        }

        preload() {
          this.load.image("astra", "/assets/characters/astra.png");
          this.load.image("vanta", "/assets/characters/vanta.png");
        }

        create() {
          this.physics.world.setBounds(0, 0, WORLD_WIDTH, 900);
          this.makeTextures();
          this.buildWorld();
          this.createPilots();

          this.shots = this.physics.add.group({ allowGravity: false });
          this.hostileShots = this.physics.add.group({ allowGravity: false });
          this.minions = this.physics.add.group();
          this.pickups = this.physics.add.group();

          this.physics.add.collider(this.pilots[0].sprite, this.platforms);
          this.physics.add.collider(this.pilots[1].sprite, this.platforms);
          this.physics.add.collider(this.minions, this.platforms);
          this.physics.add.collider(this.pickups, this.platforms);
          this.physics.add.overlap(this.shots, this.minions, (shot, minion) => this.hitMinion(shot as ArcadeSprite, minion as ArcadeSprite));
          this.physics.add.overlap(this.shots, this.pilots[0].sprite, (pilot, shot) => this.hitPilotWithShot(pilot as ArcadeSprite, shot as ArcadeSprite));
          this.physics.add.overlap(this.shots, this.pilots[1].sprite, (pilot, shot) => this.hitPilotWithShot(pilot as ArcadeSprite, shot as ArcadeSprite));
          this.physics.add.overlap(this.hostileShots, this.pilots[0].sprite, (pilot, shot) => this.hitPilotWithHazard(pilot as ArcadeSprite, shot as ArcadeSprite));
          this.physics.add.overlap(this.hostileShots, this.pilots[1].sprite, (pilot, shot) => this.hitPilotWithHazard(pilot as ArcadeSprite, shot as ArcadeSprite));
          this.physics.add.overlap(this.minions, this.pilots[0].sprite, (minion, pilot) => this.touchMinion(minion as ArcadeSprite, pilot as ArcadeSprite));
          this.physics.add.overlap(this.minions, this.pilots[1].sprite, (minion, pilot) => this.touchMinion(minion as ArcadeSprite, pilot as ArcadeSprite));
          this.physics.add.overlap(this.pickups, this.pilots[0].sprite, (pickup, pilot) => this.collectPickup(pickup as ArcadeSprite, pilot as ArcadeSprite));
          this.physics.add.overlap(this.pickups, this.pilots[1].sprite, (pickup, pilot) => this.collectPickup(pickup as ArcadeSprite, pilot as ArcadeSprite));

          this.keys = this.input.keyboard!.addKeys({
            a: "A", d: "D", w: "W", f: "F", g: "G", h: "H",
            left: "LEFT", right: "RIGHT", up: "UP", k: "K", l: "L", semi: "SEMICOLON",
          }) as Record<string, import("phaser").Input.Keyboard.Key>;

          this.configureCameras();
          this.startRound();
          receiveNetworkPayload = (payload) => this.receiveNetwork(payload);
          beginTutorialRun = () => this.beginTutorial();
        }

        private makeTextures() {
          const make = (name: string, draw: (g: import("phaser").GameObjects.Graphics) => void, size = 96) => {
            const g = this.make.graphics({ x: 0, y: 0 });
            draw(g);
            g.generateTexture(name, size, size);
            g.destroy();
          };

          make("sentinel", (g) => {
            g.fillStyle(0x121b35).fillRoundedRect(18, 26, 60, 42, 13);
            g.lineStyle(4, 0xffb12b).strokeRoundedRect(18, 26, 60, 42, 13);
            g.fillStyle(0xffd36b).fillRect(29, 38, 38, 7);
            g.fillStyle(0x080d1d).fillCircle(29, 74, 9).fillCircle(67, 74, 9);
          });
          make("drone", (g) => {
            g.fillStyle(0x182141).fillEllipse(48, 48, 66, 34);
            g.lineStyle(4, 0xb97aff).strokeEllipse(48, 48, 66, 34);
            g.fillStyle(0xe0b7ff).fillCircle(48, 48, 9);
            g.lineStyle(3, 0x8755d8).lineBetween(9, 35, 27, 46).lineBetween(87, 35, 69, 46);
          });
          make("bulwark", (g) => {
            g.fillStyle(0x1b2338).fillRoundedRect(17, 16, 62, 65, 10);
            g.lineStyle(5, 0x48e0bc).strokeRoundedRect(17, 16, 62, 65, 10);
            g.fillStyle(0x8fffe6).fillRect(30, 31, 36, 9);
            g.fillStyle(0x48e0bc).fillTriangle(48, 49, 62, 67, 34, 67);
          });
          make("siphon", (g) => {
            g.fillStyle(0x321334).fillCircle(48, 48, 31);
            g.lineStyle(5, 0xff5277).strokeCircle(48, 48, 31);
            g.lineStyle(4, 0xff9aad).strokeCircle(48, 48, 14);
            g.lineStyle(5, 0x7c263c).lineBetween(7, 77, 28, 63).lineBetween(89, 77, 68, 63);
          });
          make("juggernaut", (g) => {
            g.fillStyle(0x231a18).fillRoundedRect(11, 11, 74, 74, 15);
            g.lineStyle(6, 0xff6c28).strokeRoundedRect(11, 11, 74, 74, 15);
            g.fillStyle(0xffb077).fillRect(26, 31, 44, 11);
            g.fillStyle(0x5c2418).fillTriangle(48, 53, 68, 75, 28, 75);
          });
          make("player-shot-0", (g) => {
            g.fillStyle(0x73efff).fillCircle(48, 48, 15);
            g.fillStyle(0xffffff).fillCircle(48, 48, 7);
          });
          make("player-shot-1", (g) => {
            g.fillStyle(0xff74be).fillCircle(48, 48, 15);
            g.fillStyle(0xffffff).fillCircle(48, 48, 7);
          });
          make("hostile-shot", (g) => {
            g.fillStyle(0xff8a32).fillCircle(48, 48, 13);
            g.lineStyle(3, 0xffd3a1).strokeCircle(48, 48, 18);
          });
          make("pickup", (g) => {
            g.fillStyle(0x131a31).fillCircle(48, 48, 27);
            g.lineStyle(4, 0xffffff).strokeCircle(48, 48, 27);
            g.fillStyle(0xffffff).fillTriangle(48, 25, 68, 58, 28, 58);
          });
        }

        private buildWorld() {
          this.add.rectangle(CENTER_X, 450, WORLD_WIDTH, 900, 0x050817);
          this.add.rectangle(CENTER_X, 675, WORLD_WIDTH, 430, 0x090e21);

          for (let x = 70; x < WORLD_WIDTH; x += 170) {
            const y = 80 + ((x * 37) % 390);
            const radius = x % 4 === 0 ? 2.2 : 1.2;
            this.add.circle(x, y, radius, x % 5 === 0 ? 0xa66cff : 0x5cb9ff, 0.55);
          }
          for (let x = 0; x < WORLD_WIDTH; x += 800) {
            this.add.triangle(x + 400, 500, 0, 210, 400, 0, 800, 210, 0x0d1733, 0.82);
            this.add.triangle(x + 460, 550, 0, 170, 350, 0, 700, 170, 0x10122d, 0.88);
          }

          const rail = this.add.graphics();
          rail.lineStyle(2, 0x1f3765, 0.7);
          for (let x = 0; x <= WORLD_WIDTH; x += 160) rail.lineBetween(x, 650, x + 80, 585);
          rail.lineStyle(4, 0x0f4f6c, 0.8).lineBetween(0, 676, WORLD_WIDTH, 676);

          this.add.rectangle(CENTER_X, FLOOR_Y + 55, WORLD_WIDTH, 170, 0x080c17).setStrokeStyle(3, 0x153255, 0.8);
          const floorGlow = this.add.graphics();
          floorGlow.lineStyle(5, 0x14d6ea, 0.38).lineBetween(0, FLOOR_Y - 18, WORLD_WIDTH, FLOOR_Y - 18);
          for (let x = 0; x < WORLD_WIDTH; x += 125) {
            floorGlow.lineStyle(2, x < CENTER_X ? 0x14d6ea : 0xff278f, 0.33).lineBetween(x, FLOOR_Y - 14, x + 58, FLOOR_Y + 22);
          }

          this.platforms = this.physics.add.staticGroup();
          const ground = this.add.rectangle(CENTER_X, FLOOR_Y + 48, WORLD_WIDTH, 100, 0x000000, 0);
          this.physics.add.existing(ground, true);
          this.platforms.add(ground);

          const platformXs = [900, 1450, 2050, 2580, 2940, 3460, 3820, 4350, 4950, 5500];
          platformXs.forEach((x, i) => {
            const y = i % 3 === 1 ? 600 : 655;
            const width = i % 2 === 0 ? 280 : 220;
            const plate = this.add.rectangle(x, y, width, 24, 0x14213c, 1).setStrokeStyle(3, i < 5 ? 0x1b93a9 : 0xb52673, 0.75);
            this.add.rectangle(x, y + 7, width - 20, 4, i < 5 ? 0x20e4f4 : 0xff329c, 0.5);
            this.physics.add.existing(plate, true);
            this.platforms.add(plate);
          });

          this.add.rectangle(CENTER_X, 490, 10, 600, 0xffffff, 0.045);
          this.add.circle(CENTER_X, 572, 96, 0x955cff, 0.05).setStrokeStyle(2, 0xb98cff, 0.28);
          this.coreHalo = this.add.circle(CENTER_X, 572, 52, 0x7d48ff, 0.08).setStrokeStyle(4, 0xad8bff, 0.38);
          this.core = this.add.circle(CENTER_X, 572, 23, 0xc9b9ff, 0.95).setStrokeStyle(5, 0xffffff, 0.8);
          this.add.text(CENTER_X, 510, "RELAY CORE", { fontFamily: "Arial Black, Arial", fontSize: "20px", color: "#cabaff", letterSpacing: 5 }).setOrigin(0.5);

          this.leftStorm = this.add.rectangle(0, 450, 1, 900, 0xff2c65, 0.14).setOrigin(0, 0.5).setDepth(9);
          this.rightStorm = this.add.rectangle(WORLD_WIDTH, 450, 1, 900, 0xff2c65, 0.14).setOrigin(1, 0.5).setDepth(9);
        }

        private createPilots() {
          const createPilot = (id: number, key: string): Pilot => {
            const sprite = this.physics.add.sprite(STARTS[id], 650, key).setDisplaySize(152, 152).setDepth(5);
            const body = sprite.body as ArcBody;
            body.setSize(310, 680).setOffset(355, 185);
            body.setMaxVelocity(420, 900);
            body.setDragX(1200);
            body.setCollideWorldBounds(true);
            sprite.setFlipX(id === 1);
            sprite.setData("pilotId", id);
            const color = id === 0 ? 0x16e1ff : 0xff2f9d;
            const shieldFx = this.add.ellipse(sprite.x, sprite.y, 170, 180, color, 0.07).setStrokeStyle(5, color, 0.72).setDepth(4).setVisible(false);
            return {
              id, sprite, shieldFx, hp: 100, maxHp: 100, shield: 100, level: 1, exp: 0, weapon: 0,
              nextShot: 0, nextDash: 0, invulnerableUntil: 0, cloakUntil: 0, overdriveUntil: 0,
              lastHazardHit: 0, facing: id === 0 ? 1 : -1, respawning: false,
            };
          };
          this.pilots = [createPilot(0, "astra"), createPilot(1, "vanta")];
        }

        private configureCameras() {
          const focusPilot = this.pilots[config.localPlayer];
          this.cameras.main.setViewport(0, 0, 1600, 900).setBounds(0, 0, WORLD_WIDTH, 900).setBackgroundColor(0x050817);
          this.cameras.main.startFollow(focusPilot.sprite, true, 0.1, 0.1, 0, 34);
          this.cameras.main.setZoom(1.10);
        }

        private startRound() {
          this.roundActive = false;
          this.physics.resume();
          this.coreOwner = null;
          this.core.setFillStyle(0xc9b9ff, 0.95);
          this.coreHalo.setFillStyle(0x7d48ff, 0.08);
          this.shots?.clear(true, true);
          this.hostileShots?.clear(true, true);
          this.minions?.clear(true, true);
          this.pickups?.clear(true, true);
          this.minionSerial = 0;
          this.pickupSerial = 0;
          this.shotSerial = 0;
          this.matchWinner = null;

          this.pilots.forEach((pilot, id) => {
            pilot.hp = 100;
            pilot.maxHp = 100;
            pilot.shield = 100;
            pilot.level = 1;
            pilot.exp = 0;
            pilot.weapon = 0;
            pilot.cloakUntil = 0;
            pilot.overdriveUntil = 0;
            pilot.invulnerableUntil = this.time.now + 1700;
            pilot.respawning = false;
            pilot.sprite.enableBody(true, STARTS[id], 650, true, true);
            pilot.sprite.setVelocity(0, 0).setAlpha(1).setTint(0xffffff);
            pilot.sprite.setFlipX(id === 1);
            pilot.facing = id === 0 ? 1 : -1;
          });

          const leftSpawns = [
            [850, 0], [1320, 0], [1760, 1], [2180, 2], [2580, 3], [2920, 4],
          ];
          leftSpawns.forEach(([x, tier]) => {
            this.spawnMinion(x, tier);
            this.spawnMinion(WORLD_WIDTH - x, tier);
          });
          [1120, 1940, 2460, 2790, WORLD_WIDTH - 1120, WORLD_WIDTH - 1940, WORLD_WIDTH - 2460, WORLD_WIDTH - 2790]
            .forEach((x, i) => this.spawnPickup(x, i % 5));

          this.roundStartedAt = this.time.now + 1200;
          if (this.replica) {
            this.physics.pause();
          } else if (this.tutorialLocked) {
            this.physics.pause();
            this.announcement = "TRAINING LINK READY // REVIEW THE FIELD BRIEF";
          } else {
            this.say(`ROUND ${this.roundNumber} // ENGAGE`, 1500);
            this.time.delayedCall(1200, () => { this.roundActive = true; });
          }
          this.emitHud(true);
        }

        private beginTutorial() {
          if (!this.tutorialLocked) return;
          this.tutorialLocked = false;
          this.physics.resume();
          this.roundStartedAt = this.time.now + 900;
          this.say("TRAINING LIVE // MOVE RIGHT AND HUNT", 1700);
          this.time.delayedCall(900, () => { this.roundActive = true; });
        }

        private spawnMinion(x: number, tier: number, serialOverride?: number) {
          const kind = MINION_TYPES[tier];
          const y = kind === "drone" ? 575 : 700;
          const sprite = this.physics.add.sprite(x, y, kind).setDisplaySize(58 + tier * 5, 58 + tier * 5).setDepth(3);
          const body = sprite.body as ArcBody;
          body.setSize(62, 64).setOffset(17, 16);
          body.setCollideWorldBounds(true);
          if (kind === "drone") body.setAllowGravity(false);
          const serial = serialOverride ?? this.minionSerial++;
          this.minionSerial = Math.max(this.minionSerial, serial + 1);
          sprite.setData({
            kind, tier, hp: 34 + tier * 34, maxHp: 34 + tier * 34, homeX: x, nextAttack: this.time.now + 900 + serial * 85,
            touchAt: 0, respawnX: x, serial,
          });
          this.minions.add(sprite);
        }

        private spawnPickup(x: number, kindIndex: number, y = 530, serialOverride?: number) {
          const kinds = ["weapon", "shield", "heal", "cloak", "overdrive"];
          const colors = [0xffd55d, 0x44e6ff, 0x62ff9a, 0xba8cff, 0xff5d9e];
          const pickup = this.physics.add.sprite(x, y, "pickup").setDisplaySize(44, 44).setTint(colors[kindIndex]).setDepth(4);
          const serial = serialOverride ?? this.pickupSerial++;
          this.pickupSerial = Math.max(this.pickupSerial, serial + 1);
          pickup.setBounce(0.62).setData({ kind: kinds[kindIndex], serial });
          this.pickups.add(pickup);
        }

        update(time: number, delta: number) {
          this.core.rotation += delta * 0.0015;
          this.coreHalo.setScale(1 + Math.sin(time * 0.003) * 0.12);

          if (this.replica) {
            if (time > this.nextNetworkFrame) {
              this.nextNetworkFrame = time + 45;
              this.sendNetwork({ kind: "input", controls: this.readHumanControls(0) });
            }
          } else if (this.roundActive) {
            const controls0 = this.readHumanControls(0);
            const controls1 = config.mode === "cpu" ? this.readBotControls(time) : this.remoteIntent;
            this.updatePilot(this.pilots[0], controls0, time, delta);
            this.updatePilot(this.pilots[1], controls1, time, delta);
            this.updateMinions(time);
            this.updateShots();
            this.updateCore(time);
            this.updateStorm(time);
          }

          if (config.mode === "online" && !this.replica && time > this.nextNetworkFrame) {
            this.nextNetworkFrame = time + 50;
            this.sendNetwork({ kind: "snapshot", snapshot: this.buildSnapshot() });
          }

          this.pilots.forEach((pilot) => {
            pilot.shieldFx.setPosition(pilot.sprite.x, pilot.sprite.y + 2);
            if (pilot.cloakUntil > time) pilot.sprite.setAlpha(0.22 + Math.sin(time * 0.02) * 0.06);
            else if (!pilot.respawning) pilot.sprite.setAlpha(1);
          });

          if (this.announceUntil < time) this.announcement = "";
          this.emitHud();
        }

        private readHumanControls(id: number) {
          if (id === 0) {
            return {
              move: (this.keys.d.isDown ? 1 : 0) - (this.keys.a.isDown ? 1 : 0),
              jump: Phaser.Input.Keyboard.JustDown(this.keys.w),
              fire: this.keys.f.isDown,
              shield: this.keys.g.isDown,
              dash: Phaser.Input.Keyboard.JustDown(this.keys.h),
            };
          }
          return {
            move: (this.keys.right.isDown ? 1 : 0) - (this.keys.left.isDown ? 1 : 0),
            jump: Phaser.Input.Keyboard.JustDown(this.keys.up),
            fire: this.keys.k.isDown,
            shield: this.keys.l.isDown,
            dash: Phaser.Input.Keyboard.JustDown(this.keys.semi),
          };
        }

        private readBotControls(time: number) {
          if (time > this.aiTick) {
            this.aiTick = time + 130;
            const bot = this.pilots[1];
            const human = this.pilots[0];
            const targetMinion = this.nearestMinion(bot.sprite.x, 540);
            const targetX = Math.abs(bot.sprite.x - human.sprite.x) < 850 ? human.sprite.x : (targetMinion?.x ?? CENTER_X);
            const dx = targetX - bot.sprite.x;
            const enemyNear = Math.abs(bot.sprite.x - human.sprite.x) < 720;
            const shotThreat = this.shots.getChildren().some((child) => {
              const shot = child as ArcadeSprite;
              return shot.active && shot.getData("owner") === 0 && Phaser.Math.Distance.Between(shot.x, shot.y, bot.sprite.x, bot.sprite.y) < 180;
            });
            this.aiIntent = {
              move: Math.abs(dx) < 105 && enemyNear ? 0 : Math.sign(dx),
              jump: (bot.sprite.body as ArcBody).blocked.down && (Math.random() < 0.09 || (enemyNear && Math.abs(human.sprite.y - bot.sprite.y) > 70)),
              fire: Boolean(targetMinion) || enemyNear,
              shield: shotThreat || (enemyNear && Math.random() < 0.12),
              dash: Math.abs(dx) > 500 && Math.random() < 0.06,
            };
          }
          const intent = { ...this.aiIntent };
          this.aiIntent.jump = false;
          this.aiIntent.dash = false;
          return intent;
        }

        private updatePilot(pilot: Pilot, controls: { move: number; jump: boolean; fire: boolean; shield: boolean; dash: boolean }, time: number, delta: number) {
          if (pilot.respawning || !pilot.sprite.active) return;
          const body = pilot.sprite.body as ArcBody;
          const shielding = controls.shield && pilot.shield > 0;
          const speed = shielding ? 125 : 265;

          if (controls.move !== 0) {
            pilot.sprite.setVelocityX(controls.move * speed);
            pilot.facing = controls.move;
            pilot.sprite.setFlipX(controls.move < 0);
          } else {
            pilot.sprite.setVelocityX(0);
          }
          if (controls.jump && (body.blocked.down || body.touching.down)) pilot.sprite.setVelocityY(-530);

          if (controls.dash && time > pilot.nextDash && !shielding) {
            pilot.nextDash = time + 2600;
            pilot.invulnerableUntil = time + 260;
            pilot.sprite.setVelocityX(pilot.facing * 650);
            this.trailBurst(pilot.sprite.x, pilot.sprite.y, pilot.id);
          }

          if (shielding) {
            pilot.shield = Math.max(0, pilot.shield - delta * 0.032);
            pilot.shieldFx.setVisible(true).setAlpha(0.65 + Math.sin(time * 0.02) * 0.15);
          } else {
            pilot.shield = Math.min(100, pilot.shield + delta * 0.014);
            pilot.shieldFx.setVisible(false);
          }

          if (controls.fire && time > pilot.nextShot && !shielding) this.firePilotShot(pilot, time);
        }

        private firePilotShot(pilot: Pilot, time: number) {
          const overdrive = pilot.overdriveUntil > time;
          pilot.nextShot = time + (overdrive ? 125 : Math.max(260, 420 - pilot.weapon * 35));
          const shot = this.physics.add.sprite(pilot.sprite.x + pilot.facing * 48, pilot.sprite.y - 6, `player-shot-${pilot.id}`)
            .setDisplaySize(24 + pilot.weapon * 3, 24 + pilot.weapon * 3).setDepth(6);
          shot.setVelocityX(pilot.facing * (560 + pilot.weapon * 25));
          shot.setData({ owner: pilot.id, damage: 13 + (pilot.level - 1) * 4 + pilot.weapon * 4, born: time, serial: this.shotSerial++ });
          this.shots.add(shot);
        }

        private updateShots() {
          [...this.shots.getChildren(), ...this.hostileShots.getChildren()].forEach((child) => {
            const shot = child as ArcadeSprite;
            if (!shot.active) return;
            if (shot.x < 0 || shot.x > WORLD_WIDTH || shot.y < 250 || shot.y > 880 || this.time.now - (shot.getData("born") ?? this.time.now) > 3800) shot.destroy();
          });
        }

        private hitPilotWithShot(first: ArcadeSprite, second: ArcadeSprite) {
          const pilotSprite = first.getData("pilotId") !== undefined ? first : second;
          const shot = pilotSprite === first ? second : first;
          if (!shot.active || !pilotSprite.active) return;
          const targetId = pilotSprite.getData("pilotId") as number;
          const owner = shot.getData("owner") as number;
          if (owner === targetId) return;
          shot.destroy();
          this.damagePilot(targetId, shot.getData("damage") ?? 12, owner);
        }

        private hitPilotWithHazard(first: ArcadeSprite, second: ArcadeSprite) {
          const pilotSprite = first.getData("pilotId") !== undefined ? first : second;
          const shot = pilotSprite === first ? second : first;
          if (!shot.active || !pilotSprite.active) return;
          shot.destroy();
          this.damagePilot(pilotSprite.getData("pilotId"), shot.getData("damage") ?? 10, "minion");
        }

        private hitMinion(first: ArcadeSprite, second: ArcadeSprite) {
          const shot = first.getData("owner") !== undefined ? first : second;
          const minion = shot === first ? second : first;
          if (!shot.active || !minion.active) return;
          const owner = shot.getData("owner") as number;
          const hp = (minion.getData("hp") as number) - (shot.getData("damage") as number);
          minion.setData("hp", hp).setTint(0xffffff);
          this.time.delayedCall(70, () => minion.active && minion.clearTint());
          shot.destroy();
          if (hp <= 0) this.killMinion(minion, owner);
        }

        private killMinion(minion: ArcadeSprite, owner: number) {
          const tier = minion.getData("tier") as number;
          const x = minion.getData("respawnX") as number;
          const color = owner === 0 ? 0x16e1ff : 0xff2f9d;
          this.burst(minion.x, minion.y, color, 16);
          minion.destroy();
          this.grantExp(this.pilots[owner], 28 + tier * 24);
          if (Math.random() < 0.38 + tier * 0.08) this.spawnPickup(x + Phaser.Math.Between(-35, 35), Phaser.Math.Between(0, 4), 650);
          this.time.delayedCall(10500 + tier * 1800, () => this.roundActive && this.spawnMinion(x, tier));
        }

        private grantExp(pilot: Pilot, amount: number) {
          pilot.exp += amount;
          while (pilot.level < 5 && pilot.exp >= LEVEL_EXP[pilot.level]) {
            pilot.level += 1;
            pilot.maxHp += 18;
            pilot.hp = Math.min(pilot.maxHp, pilot.hp + 24);
            this.say(`${PILOTS[pilot.id].name} // LEVEL ${pilot.level}`, 1300);
            this.burst(pilot.sprite.x, pilot.sprite.y, pilot.id === 0 ? 0x16e1ff : 0xff2f9d, 24);
          }
        }

        private updateMinions(time: number) {
          this.minions.getChildren().forEach((child) => {
            const minion = child as ArcadeSprite;
            if (!minion.active) return;
            const tier = minion.getData("tier") as number;
            const kind = minion.getData("kind") as string;
            const target = this.nearestVisiblePilot(minion.x, minion.y, 720);
            const homeX = minion.getData("homeX") as number;
            const body = minion.body as ArcBody;

            if (kind === "drone") {
              minion.y = 555 + Math.sin((time + homeX) * 0.002) * 36;
              body.setVelocity(0, 0);
            }

            if (target) {
              const direction = Math.sign(target.sprite.x - minion.x);
              minion.setFlipX(direction < 0);
              if (kind !== "drone" && Math.abs(target.sprite.x - minion.x) > 80) minion.setVelocityX(direction * (55 + tier * 15));
              else if (kind !== "drone") minion.setVelocityX(0);
              if ((kind === "drone" || kind === "bulwark" || kind === "juggernaut") && time > (minion.getData("nextAttack") as number)) {
                minion.setData("nextAttack", time + (kind === "juggernaut" ? 950 : 1350 - tier * 70));
                this.fireMinionShot(minion, target, 8 + tier * 4);
              }
            } else if (kind !== "drone") {
              const patrol = Math.sin((time + homeX * 4) * 0.001) > 0 ? 1 : -1;
              if (Math.abs(minion.x - homeX) > 155) minion.setVelocityX(Math.sign(homeX - minion.x) * 42);
              else minion.setVelocityX(patrol * 34);
            }
          });
        }

        private fireMinionShot(minion: ArcadeSprite, target: Pilot, damage: number) {
          const shot = this.physics.add.sprite(minion.x, minion.y, "hostile-shot").setDisplaySize(25, 25).setDepth(6);
          const angle = Phaser.Math.Angle.Between(minion.x, minion.y, target.sprite.x, target.sprite.y);
          this.physics.velocityFromRotation(angle, 300, shot.body!.velocity);
          shot.setData({ damage, born: this.time.now, serial: this.shotSerial++ });
          this.hostileShots.add(shot);
        }

        private touchMinion(first: ArcadeSprite, second: ArcadeSprite) {
          const pilotSprite = first.getData("pilotId") !== undefined ? first : second;
          const minion = pilotSprite === first ? second : first;
          const now = this.time.now;
          if (now < (minion.getData("touchAt") as number)) return;
          minion.setData("touchAt", now + 650);
          const id = pilotSprite.getData("pilotId") as number;
          const tier = minion.getData("tier") as number;
          this.damagePilot(id, 8 + tier * 4, "minion");
          pilotSprite.setVelocityX(Math.sign(pilotSprite.x - minion.x) * 340).setVelocityY(-190);
        }

        private damagePilot(id: number, rawDamage: number, source: number | "minion" | "storm") {
          const pilot = this.pilots[id];
          const now = this.time.now;
          if (!pilot.sprite.active || pilot.respawning || now < pilot.invulnerableUntil) return;
          const shielding = pilot.shieldFx.visible && pilot.shield > 0;
          const damage = shielding ? rawDamage * 0.28 : rawDamage;
          if (shielding) pilot.shield = Math.max(0, pilot.shield - rawDamage * 1.35);
          pilot.hp -= damage;
          pilot.invulnerableUntil = now + 170;
          pilot.sprite.setTint(0xff7a92);
          this.time.delayedCall(100, () => pilot.sprite.active && pilot.sprite.clearTint());
          this.burst(pilot.sprite.x, pilot.sprite.y, shielding ? 0x68ebff : 0xff4d6e, shielding ? 5 : 9);
          if (pilot.hp <= 0) {
            if (typeof source === "number") this.endRound(source);
            else this.resetDefeatedPilot(pilot, source);
          }
        }

        private resetDefeatedPilot(pilot: Pilot, source: "minion" | "storm") {
          pilot.respawning = true;
          pilot.sprite.disableBody(true, true);
          pilot.shieldFx.setVisible(false);
          this.say(`${PILOTS[pilot.id].name} BREACHED BY ${source === "storm" ? "THE COLLAPSE" : "A MINION"} // RUN RESET`, 1800);
          this.time.delayedCall(1550, () => {
            if (!this.roundActive) return;
            pilot.hp = 100;
            pilot.maxHp = 100;
            pilot.shield = 100;
            pilot.level = 1;
            pilot.exp = 0;
            pilot.weapon = 0;
            pilot.cloakUntil = 0;
            pilot.overdriveUntil = 0;
            pilot.invulnerableUntil = this.time.now + 1600;
            pilot.respawning = false;
            pilot.sprite.enableBody(true, STARTS[pilot.id], 650, true, true).setAlpha(1);
          });
        }

        private collectPickup(first: ArcadeSprite, second: ArcadeSprite) {
          const pilotSprite = first.getData("pilotId") !== undefined ? first : second;
          const pickup = pilotSprite === first ? second : first;
          if (!pickup.active) return;
          const pilot = this.pilots[pilotSprite.getData("pilotId") as number];
          const kind = pickup.getData("kind") as string;
          const x = pickup.x;
          const kindIndex = ["weapon", "shield", "heal", "cloak", "overdrive"].indexOf(kind);
          pickup.destroy();
          if (kind === "weapon") pilot.weapon = Math.min(4, pilot.weapon + 1);
          if (kind === "shield") pilot.shield = Math.min(100, pilot.shield + 55);
          if (kind === "heal") pilot.hp = Math.min(pilot.maxHp, pilot.hp + 42);
          if (kind === "cloak") pilot.cloakUntil = this.time.now + 7000;
          if (kind === "overdrive") pilot.overdriveUntil = this.time.now + 7500;
          this.say(`${PILOTS[pilot.id].name} // ${kind.toUpperCase()} ACQUIRED`, 950);
          this.burst(pilot.sprite.x, pilot.sprite.y, pilot.id === 0 ? 0x16e1ff : 0xff2f9d, 12);
          this.time.delayedCall(14500, () => this.roundActive && this.spawnPickup(x, kindIndex));
        }

        private updateCore(time: number) {
          if (this.coreOwner !== null) return;
          for (const pilot of this.pilots) {
            if (!pilot.sprite.active) continue;
            if (Phaser.Math.Distance.Between(pilot.sprite.x, pilot.sprite.y, CENTER_X, 572) < 105) {
              this.coreOwner = pilot.id;
              pilot.shield = 100;
              pilot.hp = Math.min(pilot.maxHp, pilot.hp + 32);
              pilot.overdriveUntil = time + 9000;
              this.grantExp(pilot, 92);
              const color = pilot.id === 0 ? 0x16e1ff : 0xff2f9d;
              this.core.setFillStyle(color, 1);
              this.coreHalo.setFillStyle(color, 0.15);
              this.say(`${PILOTS[pilot.id].name} CLAIMS FIRST CONTACT // OVERDRIVE`, 2100);
              this.burst(CENTER_X, 572, color, 38);
              break;
            }
          }
        }

        private updateStorm(time: number) {
          const elapsed = Math.max(0, (time - this.roundStartedAt) / 1000);
          const collapse = Math.max(0, elapsed - 45);
          const edge = Math.min(CENTER_X - 80, collapse * 76);
          this.leftStorm.displayWidth = Math.max(1, edge);
          this.rightStorm.displayWidth = Math.max(1, edge);
          if (collapse <= 0) return;
          this.pilots.forEach((pilot) => {
            if (!pilot.sprite.active || time < pilot.lastHazardHit) return;
            if (pilot.sprite.x < edge || pilot.sprite.x > WORLD_WIDTH - edge) {
              pilot.lastHazardHit = time + 520;
              this.damagePilot(pilot.id, 9 + collapse * 0.12, "storm");
            }
          });
        }

        private endRound(winner: number) {
          if (!this.roundActive) return;
          this.roundActive = false;
          this.score[winner] += 1;
          this.shots.clear(true, true);
          this.hostileShots.clear(true, true);
          this.pilots.forEach((p) => p.sprite.setVelocity(0, 0));
          this.say(`${PILOTS[winner].name} TAKES ROUND ${this.roundNumber}`, 2600);
          if (this.score[winner] >= 2) {
            this.matchWinner = winner;
            this.physics.pause();
            this.time.delayedCall(1900, () => {
              onHud({ ...this.buildHud(), matchWinner: winner });
            });
          } else {
            this.roundNumber += 1;
            this.time.delayedCall(2700, () => this.startRound());
          }
        }

        private sendNetwork(payload: NetworkPayload) {
          const socket = config.socket;
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "relay", payload }));
        }

        private receiveNetwork(payload: NetworkPayload) {
          if (payload.kind === "input" && !this.replica) {
            this.remoteIntent = payload.controls;
            return;
          }
          if (payload.kind === "snapshot" && this.replica) this.applySnapshot(payload.snapshot);
        }

        private buildSnapshot(): NetworkSnapshot {
          const pilots = this.pilots.map((pilot) => {
            const body = pilot.sprite.body as ArcBody;
            return {
              x: pilot.sprite.x, y: pilot.sprite.y, vx: body.velocity.x, vy: body.velocity.y, flip: pilot.sprite.flipX,
              active: pilot.sprite.active, hp: pilot.hp, maxHp: pilot.maxHp, shield: pilot.shield, level: pilot.level,
              exp: pilot.exp, weapon: pilot.weapon, cloakUntil: pilot.cloakUntil, overdriveUntil: pilot.overdriveUntil,
              facing: pilot.facing, respawning: pilot.respawning,
            };
          }) as [NetPilot, NetPilot];
          const minions = this.minions.getChildren().filter((child) => (child as ArcadeSprite).active).map((child) => {
            const minion = child as ArcadeSprite;
            return {
              serial: minion.getData("serial"), x: minion.x, y: minion.y, flip: minion.flipX,
              hp: minion.getData("hp"), tier: minion.getData("tier"), kind: minion.getData("kind"),
            };
          });
          const pickups = this.pickups.getChildren().filter((child) => (child as ArcadeSprite).active).map((child) => {
            const pickup = child as ArcadeSprite;
            return { serial: pickup.getData("serial"), x: pickup.x, y: pickup.y, kind: pickup.getData("kind") };
          });
          const playerShots = this.shots.getChildren().filter((child) => (child as ArcadeSprite).active).map((child) => {
            const shot = child as ArcadeSprite;
            return { serial: shot.getData("serial"), x: shot.x, y: shot.y, owner: shot.getData("owner"), damage: shot.getData("damage"), hostile: false };
          });
          const hazards = this.hostileShots.getChildren().filter((child) => (child as ArcadeSprite).active).map((child) => {
            const shot = child as ArcadeSprite;
            return { serial: shot.getData("serial"), x: shot.x, y: shot.y, damage: shot.getData("damage"), hostile: true };
          });
          return {
            pilots, minions, pickups, shots: [...playerShots, ...hazards], coreOwner: this.coreOwner,
            leftStormWidth: this.leftStorm.displayWidth, rightStormWidth: this.rightStorm.displayWidth,
            announcement: this.announcement, announceUntil: this.announceUntil, hud: this.buildHud(),
          };
        }

        private applySnapshot(snapshot: NetworkSnapshot) {
          snapshot.pilots.forEach((data, id) => {
            const pilot = this.pilots[id];
            pilot.hp = data.hp; pilot.maxHp = data.maxHp; pilot.shield = data.shield; pilot.level = data.level;
            pilot.exp = data.exp; pilot.weapon = data.weapon; pilot.cloakUntil = data.cloakUntil;
            pilot.overdriveUntil = data.overdriveUntil; pilot.facing = data.facing; pilot.respawning = data.respawning;
            pilot.sprite.setPosition(data.x, data.y).setFlipX(data.flip).setVisible(data.active);
            (pilot.sprite.body as ArcBody).setVelocity(data.vx, data.vy);
          });

          const minionMap = new Map<number, ArcadeSprite>();
          this.minions.getChildren().forEach((child) => minionMap.set((child as ArcadeSprite).getData("serial"), child as ArcadeSprite));
          const liveMinions = new Set(snapshot.minions.map((item) => item.serial));
          minionMap.forEach((minion, serial) => { if (!liveMinions.has(serial)) minion.destroy(); });
          snapshot.minions.forEach((data) => {
            let minion = minionMap.get(data.serial);
            if (!minion?.active) {
              this.spawnMinion(data.x, data.tier, data.serial);
              minion = this.minions.getChildren().find((child) => (child as ArcadeSprite).getData("serial") === data.serial) as ArcadeSprite;
            }
            minion?.setPosition(data.x, data.y).setFlipX(data.flip).setData("hp", data.hp);
          });

          const pickupMap = new Map<number, ArcadeSprite>();
          this.pickups.getChildren().forEach((child) => pickupMap.set((child as ArcadeSprite).getData("serial"), child as ArcadeSprite));
          const livePickups = new Set(snapshot.pickups.map((item) => item.serial));
          pickupMap.forEach((pickup, serial) => { if (!livePickups.has(serial)) pickup.destroy(); });
          const kinds = ["weapon", "shield", "heal", "cloak", "overdrive"];
          snapshot.pickups.forEach((data) => {
            let pickup = pickupMap.get(data.serial);
            if (!pickup?.active) {
              this.spawnPickup(data.x, Math.max(0, kinds.indexOf(data.kind)), data.y, data.serial);
              pickup = this.pickups.getChildren().find((child) => (child as ArcadeSprite).getData("serial") === data.serial) as ArcadeSprite;
            }
            pickup?.setPosition(data.x, data.y);
          });

          this.syncShots(this.shots, snapshot.shots.filter((shot) => !shot.hostile), false);
          this.syncShots(this.hostileShots, snapshot.shots.filter((shot) => shot.hostile), true);
          this.coreOwner = snapshot.coreOwner;
          const coreColor = snapshot.coreOwner === 0 ? 0x16e1ff : snapshot.coreOwner === 1 ? 0xff2f9d : 0xc9b9ff;
          this.core.setFillStyle(coreColor, 1);
          this.leftStorm.displayWidth = snapshot.leftStormWidth;
          this.rightStorm.displayWidth = snapshot.rightStormWidth;
          this.announcement = snapshot.announcement;
          this.announceUntil = snapshot.announceUntil;
          if (!disposed) onHud(snapshot.hud);
        }

        private syncShots(group: import("phaser").Physics.Arcade.Group, data: NetShot[], hostile: boolean) {
          const current = new Map<number, ArcadeSprite>();
          group.getChildren().forEach((child) => current.set((child as ArcadeSprite).getData("serial"), child as ArcadeSprite));
          const live = new Set(data.map((shot) => shot.serial));
          current.forEach((shot, serial) => { if (!live.has(serial)) shot.destroy(); });
          data.forEach((netShot) => {
            let shot = current.get(netShot.serial);
            if (!shot?.active) {
              const texture = hostile ? "hostile-shot" : `player-shot-${netShot.owner ?? 0}`;
              shot = this.physics.add.sprite(netShot.x, netShot.y, texture).setDisplaySize(hostile ? 25 : 24, hostile ? 25 : 24).setDepth(6);
              shot.setData({ serial: netShot.serial, owner: netShot.owner, damage: netShot.damage });
              group.add(shot);
            }
            shot.setPosition(netShot.x, netShot.y);
          });
        }

        private nearestVisiblePilot(x: number, y: number, range: number): Pilot | null {
          let best: Pilot | null = null;
          let bestDistance = range;
          for (const pilot of this.pilots) {
            if (!pilot.sprite.active || pilot.cloakUntil > this.time.now) continue;
            const distance = Phaser.Math.Distance.Between(x, y, pilot.sprite.x, pilot.sprite.y);
            if (distance < bestDistance) { best = pilot; bestDistance = distance; }
          }
          return best;
        }

        private nearestMinion(x: number, range: number): ArcadeSprite | null {
          let result: ArcadeSprite | null = null;
          let distance = range;
          for (const child of this.minions?.getChildren() ?? []) {
            const minion = child as ArcadeSprite;
            if (!minion.active) continue;
            const dx = Math.abs(minion.x - x);
            if (dx < distance) { distance = dx; result = minion; }
          }
          return result;
        }

        private burst(x: number, y: number, color: number, count: number) {
          for (let i = 0; i < count; i += 1) {
            const particle = this.add.circle(x, y, Phaser.Math.Between(2, 5), color, 0.9).setDepth(8);
            const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
            const distance = Phaser.Math.Between(35, 125);
            this.tweens.add({
              targets: particle, x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance,
              alpha: 0, scale: 0.2, duration: Phaser.Math.Between(260, 620), ease: "Cubic.Out", onComplete: () => particle.destroy(),
            });
          }
        }

        private trailBurst(x: number, y: number, id: number) {
          const color = id === 0 ? 0x16e1ff : 0xff2f9d;
          for (let i = 0; i < 7; i += 1) {
            const line = this.add.rectangle(x - this.pilots[id].facing * (i * 16), y + Phaser.Math.Between(-34, 34), 44, 3, color, 0.75).setDepth(4);
            this.tweens.add({ targets: line, alpha: 0, scaleX: 0.2, duration: 260, onComplete: () => line.destroy() });
          }
        }

        private say(message: string, duration: number) {
          this.announcement = message;
          this.announceUntil = this.time.now + duration;
          this.emitHud(true);
        }

        private buildHud(): HudState {
          const elapsed = this.tutorialLocked ? 0 : Math.max(0, (this.time.now - this.roundStartedAt) / 1000);
          const seconds = Math.max(0, Math.ceil(90 - elapsed));
          const pilots = this.pilots.map((pilot) => {
            const statuses: string[] = [];
            if (pilot.cloakUntil > this.time.now) statuses.push("CLOAK");
            if (pilot.overdriveUntil > this.time.now) statuses.push("OVERDRIVE");
            if (pilot.respawning) statuses.push("REBOOT");
            return {
              hp: Math.max(0, Math.round(pilot.hp)), maxHp: pilot.maxHp, shield: Math.round(pilot.shield), level: pilot.level,
              exp: pilot.exp, nextExp: pilot.level >= 5 ? pilot.exp : LEVEL_EXP[pilot.level], weapon: pilot.weapon,
              status: statuses.join(" + ") || "STANDARD",
              progress: Math.round((1 - Math.min(1, Math.abs(pilot.sprite.x - CENTER_X) / (CENTER_X - STARTS[0]))) * 100),
            };
          }) as [PilotHud, PilotHud];
          return {
            pilots, scores: [...this.score] as [number, number], seconds,
            phase: this.tutorialLocked
              ? "TRAINING PAUSED"
              : elapsed < 45
                ? `COLLAPSE IN ${Math.max(0, Math.ceil(45 - elapsed))}`
                : "COLLAPSE ACTIVE",
            announcement: this.announcement, coreOwner: this.coreOwner, matchWinner: this.matchWinner,
          };
        }

        private emitHud(force = false) {
          if (!force && this.time.now < this.nextHud) return;
          this.nextHud = this.time.now + 110;
          if (!disposed) onHud(this.buildHud());
        }
      }

      if (config.socket) {
        socketMessageHandler = (event: MessageEvent) => {
          let message: { type?: string; payload?: NetworkPayload };
          try { message = JSON.parse(String(event.data)); } catch { return; }
          if (message.type === "relay" && message.payload) receiveNetworkPayload?.(message.payload);
          if (message.type === "opponent-left") onDisconnect();
        };
        config.socket.addEventListener("message", socketMessageHandler);
      }
      if (config.tutorial) {
        tutorialStartHandler = () => beginTutorialRun?.();
        window.addEventListener("rift:tutorial-start", tutorialStartHandler);
      }

      if (disposed || !hostRef.current) return;
      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: hostRef.current,
        width: 1600,
        height: 900,
        backgroundColor: "#050817",
        physics: { default: "arcade", arcade: { gravity: { x: 0, y: 1150 }, debug: false } },
        input: { keyboard: true, gamepad: true },
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        render: { antialias: true, pixelArt: false, roundPixels: true },
        scene: ArenaScene,
      });
    })();

    return () => {
      disposed = true;
      if (config.socket && socketMessageHandler) config.socket.removeEventListener("message", socketMessageHandler);
      if (tutorialStartHandler) window.removeEventListener("rift:tutorial-start", tutorialStartHandler);
      game?.destroy(true);
    };
  }, [config, onDisconnect, onHud, session]);

  return <div ref={hostRef} className="game-surface" aria-label="Riftbound Arena game canvas" />;
}

function ScorePips({ wins, side }: { wins: number; side: 0 | 1 }) {
  return (
    <div className={`score-pips side-${side}`} aria-label={`${wins} round wins`}>
      {[0, 1].map((pip) => <span key={pip} className={pip < wins ? "won" : ""} />)}
    </div>
  );
}

function PilotHudPanel({ pilot, id }: { pilot: PilotHud; id: 0 | 1 }) {
  const hpPct = Math.max(0, Math.min(100, (pilot.hp / pilot.maxHp) * 100));
  const expBase = pilot.level > 1 ? [0, 60, 145, 270, 440][pilot.level - 1] : 0;
  const expPct = pilot.level >= 5 ? 100 : Math.max(0, Math.min(100, ((pilot.exp - expBase) / (pilot.nextExp - expBase)) * 100));
  return (
    <div className={`pilot-hud pilot-${id}`}>
      <div className="pilot-identity">
        <Image src={PILOTS[id].image} alt="" width={46} height={46} unoptimized />
        <div>
          <span className="pilot-label">{`P${id + 1} // LVL ${pilot.level}`}</span>
          <strong>{PILOTS[id].name}</strong>
        </div>
      </div>
      <div className="meter-stack">
        <div className="meter health"><i style={{ width: `${hpPct}%` }} /><span>{pilot.hp} / {pilot.maxHp}</span></div>
        <div className="submeters">
          <div className="meter shield"><i style={{ width: `${pilot.shield}%` }} /></div>
          <div className="meter exp"><i style={{ width: `${expPct}%` }} /></div>
        </div>
      </div>
      <div className="pilot-readout">
        <span>BLASTER <b>+{pilot.weapon}</b></span>
        <span className={pilot.status !== "STANDARD" ? "hot" : ""}>{pilot.status}</span>
      </div>
    </div>
  );
}

type LobbyState = { status: "idle" | "connecting" | "waiting" | "error"; code?: string; message?: string };

const TRAINING_STEPS = [
  {
    tag: "MOVEMENT // 01",
    title: "PUSH TOWARD CENTER",
    body: "You begin at the far edge of the world. Hold D to advance, A to retreat, and tap W to jump onto raised routes. Your core-proximity readout climbs as you close on center.",
    keys: ["A", "D", "W"],
    tip: "Your camera follows only your pilot. Your rival has their own view from the opposite side.",
  },
  {
    tag: "COMBAT // 02",
    title: "HUNT THE MINIONS",
    body: "Hold F to fire your blaster. Defeated minions award EXP and may drop tech. Enemies become tougher toward center, but their EXP and drop chances rise sharply.",
    keys: ["F"],
    tip: "Reach 60 EXP for level 2. Every level increases maximum health and blaster damage.",
  },
  {
    tag: "DEFENSE // 03",
    title: "SHIELD. DASH. SURVIVE.",
    body: "Hold G to project your shield and reduce incoming damage. Shield energy recharges when released. Tap H to burst through danger with a short invulnerable dash.",
    keys: ["G", "H"],
    tip: "Shielding slows you and prevents firing. Dash has a short cooldown—use it deliberately.",
  },
  {
    tag: "POWER // 04",
    title: "BUILD THIS RUN",
    body: "Glowing drops grant weapon cores, shield charge, repair, cloak, or overdrive. Levels and tech last only for the current run. A minion or collapse defeat sends you home and wipes them all.",
    keys: [],
    tip: "GOLD: weapon  •  CYAN: shield  •  GREEN: repair  •  VIOLET: cloak  •  PINK: overdrive",
  },
  {
    tag: "OBJECTIVE // 05",
    title: "CLAIM. CONVERGE. BREAK.",
    body: "Touch the relay core first for EXP, repair, a full shield, and nine seconds of overdrive. At 45 seconds the arena collapses inward. Bring your rival to zero twice to win the match.",
    keys: [],
    tip: "Do not over-farm. First contact is powerful, and the safe arena is always shrinking.",
  },
] as const;

type TrainingSession = { step: number; launchesRun: boolean };

function TrainingOverlay({ session, onNext, onClose }: {
  session: TrainingSession;
  onNext: () => void;
  onClose: () => void;
}) {
  const step = TRAINING_STEPS[session.step];
  const finalStep = session.step === TRAINING_STEPS.length - 1;
  return (
    <div className="training-overlay" role="dialog" aria-modal="true" aria-labelledby="training-title">
      <div className="training-card">
        <div className="training-art" aria-hidden="true">
          <Image src="/assets/characters/astra.png" alt="" width={430} height={430} unoptimized priority />
          <span>{String(session.step + 1).padStart(2, "0")}</span>
        </div>
        <div className="training-copy">
          <div className="training-progress">
            {TRAINING_STEPS.map((item, index) => <i key={item.tag} className={index <= session.step ? "active" : ""} />)}
          </div>
          <span className="training-tag">{step.tag}</span>
          <h2 id="training-title">{step.title}</h2>
          <p>{step.body}</p>
          {step.keys.length > 0 && <div className="training-keys">{step.keys.map((key) => <kbd key={key}>{key}</kbd>)}</div>}
          <div className="training-tip"><b>FIELD NOTE</b><span>{step.tip}</span></div>
          <div className="training-actions">
            <button className="training-next" onClick={onNext}>{finalStep ? (session.launchesRun ? "START TRAINING RUN" : "RETURN TO MATCH") : "NEXT BRIEF"}<b>→</b></button>
            <button className="training-close" onClick={onClose}>{session.launchesRun ? "SKIP BRIEF" : "CLOSE"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveCoach({ hud }: { hud: HudState }) {
  const pilot = hud.pilots[0];
  let label = "MOVE";
  let message = "Hold D to advance toward the relay. Tap W to jump.";
  let keys = ["D", "W"];
  if (pilot.progress >= 8 && pilot.level === 1) {
    label = "HUNT";
    message = `Hold F to blast minions. ${Math.max(0, 60 - pilot.exp)} EXP to level 2.`;
    keys = ["F"];
  } else if (pilot.level > 1 && pilot.progress < 72) {
    label = "BUILD";
    message = "Collect glowing tech. Hold G to shield; tap H to dash.";
    keys = ["G", "H"];
  } else if (pilot.progress >= 72 && hud.coreOwner === null) {
    label = "CONVERGE";
    message = "The relay is close. Reach it first to trigger overdrive.";
    keys = ["D"];
  } else if (hud.coreOwner !== null) {
    label = "BREAK";
    message = "Find Vanta and bring their health to zero. Two rounds wins.";
    keys = ["F", "G", "H"];
  }
  return (
    <div className="live-coach">
      <span>LIVE COACH // {label}</span>
      <p>{message}</p>
      <div>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</div>
    </div>
  );
}

function ModeSelect({ lobby, onSolo, onLearn, onCreate, onJoin }: {
  lobby: LobbyState;
  onSolo: () => void;
  onLearn: () => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
}) {
  const [joinCode, setJoinCode] = useState("");

  if (lobby.status === "waiting") {
    return (
      <div className="mode-select waiting-room">
        <span className="eyebrow">SECURE RELAY // ROOM CREATED</span>
        <h2>CALLSIGN<br /><em>{lobby.code}</em></h2>
        <p>Send this code to your rival. Leave this screen open—the match launches when they connect.</p>
        <div className="waiting-pulse"><i /><span>WAITING FOR PLAYER TWO</span><i /></div>
        <button className="copy-code" onClick={() => void navigator.clipboard?.writeText(lobby.code ?? "")}>COPY ROOM CODE</button>
      </div>
    );
  }

  return (
    <div className="mode-select">
      <div className="mode-pilots" aria-hidden="true">
        <Image className="mode-pilot astra" src="/assets/characters/astra.png" alt="" width={720} height={720} unoptimized priority />
        <Image className="mode-pilot vanta" src="/assets/characters/vanta.png" alt="" width={720} height={720} unoptimized priority />
      </div>
      <div className="mode-copy">
        <span className="eyebrow">ONLINE COMBAT PROTOCOL // BUILD 01</span>
        <h1>RIFTBOUND<br /><em>ARENA</em></h1>
        <p>Enter from opposite ends of a hostile world. Build power. Claim the core. Break your rival twice.</p>
      </div>
      <div className="mode-actions">
        <button className="primary-action" onClick={onCreate} disabled={lobby.status === "connecting"}>
          <span>01</span><b>CREATE ONLINE ROOM</b><small>Get a five-character room code</small>
        </button>
        <div className="join-action">
          <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))} placeholder="ROOM CODE" aria-label="Room code" />
          <button onClick={() => joinCode.length === 5 && onJoin(joinCode)} disabled={joinCode.length !== 5 || lobby.status === "connecting"}>JOIN <b>↗</b></button>
        </div>
        <button className="secondary-action learn-action" onClick={onLearn}>
          <span>02</span><b>LEARN TO PLAY</b><small>Five-step field brief + guided run</small>
        </button>
        <button className="practice-action" onClick={onSolo}>ALREADY BRIEFED? <b>START SOLO PRACTICE →</b></button>
        {lobby.status === "connecting" && <p className="lobby-message">CONNECTING TO RELAY…</p>}
        {lobby.status === "error" && <p className="lobby-error">{lobby.message}</p>}
      </div>
      <div className="mode-rule"><span /> FIRST TO THE CORE EARNS OVERDRIVE <span /></div>
    </div>
  );
}

export default function ArenaGame() {
  const [config, setConfig] = useState<MatchConfig | null>(null);
  const [session, setSession] = useState(0);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [lobby, setLobby] = useState<LobbyState>({ status: "idle" });
  const [training, setTraining] = useState<TrainingSession | null>(null);
  const [liveTraining, setLiveTraining] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const handleHud = useCallback((next: HudState) => setHud(next), []);

  const closeSocket = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  const startSolo = (tutorial = false) => {
    closeSocket();
    setHud(INITIAL_HUD);
    setSession((value) => value + 1);
    setConfig({ mode: "cpu", localPlayer: 0, tutorial });
    setLobby({ status: "idle" });
    setLiveTraining(false);
    setTraining(tutorial ? { step: 0, launchesRun: true } : null);
  };

  const rematch = () => {
    setHud(INITIAL_HUD);
    setSession((value) => value + 1);
  };

  const leaveMatch = useCallback(() => {
    closeSocket();
    setConfig(null);
    setHud(INITIAL_HUD);
    setLobby({ status: "idle" });
    setTraining(null);
    setLiveTraining(false);
  }, [closeSocket]);

  const handleDisconnect = useCallback(() => {
    closeSocket();
    setConfig(null);
    setHud(INITIAL_HUD);
    setLobby({ status: "error", message: "Your rival left the room. Create a new room to run it back." });
    setTraining(null);
    setLiveTraining(false);
  }, [closeSocket]);

  const connectOnline = (action: "create" | "join", code?: string) => {
    closeSocket();
    setLobby({ status: "connecting" });
    const configured = process.env.NEXT_PUBLIC_RELAY_URL;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = configured || `${protocol}//${window.location.hostname}:8788`;
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.addEventListener("open", () => socket.send(JSON.stringify(action === "create" ? { type: "create" } : { type: "join", code })));
    socket.addEventListener("message", (event) => {
      let message: { type?: string; code?: string; playerId?: 0 | 1; message?: string };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === "waiting") setLobby({ status: "waiting", code: message.code });
      if (message.type === "start" && message.playerId !== undefined) {
        setHud(INITIAL_HUD);
        setSession((value) => value + 1);
        setConfig({ mode: "online", localPlayer: message.playerId, roomCode: message.code, socket });
        setLobby({ status: "idle" });
        setTraining(null);
        setLiveTraining(false);
      }
      if (message.type === "error") setLobby({ status: "error", message: message.message });
    });
    socket.addEventListener("error", () => setLobby({ status: "error", message: "The match relay is offline. Start the local relay or try again." }));
  };

  useEffect(() => () => socketRef.current?.close(), []);

  useEffect(() => {
    document.body.classList.toggle("match-active", Boolean(config));
    if (config) window.scrollTo({ top: 0, behavior: "auto" });
    return () => document.body.classList.remove("match-active");
  }, [config]);

  const localId = config?.localPlayer ?? 0;
  const rivalId = (localId === 0 ? 1 : 0) as 0 | 1;

  const signalTutorialStart = () => {
    window.dispatchEvent(new Event("rift:tutorial-start"));
    window.setTimeout(() => window.dispatchEvent(new Event("rift:tutorial-start")), 350);
  };

  const advanceTraining = () => {
    if (!training) return;
    if (training.step < TRAINING_STEPS.length - 1) {
      setTraining({ ...training, step: training.step + 1 });
      return;
    }
    const launchesRun = training.launchesRun;
    setTraining(null);
    if (launchesRun) {
      setLiveTraining(true);
      signalTutorialStart();
    }
  };

  const closeTraining = () => {
    const launchesRun = training?.launchesRun;
    setTraining(null);
    if (launchesRun) {
      setLiveTraining(true);
      signalTutorialStart();
    }
  };

  return (
    <main className="arena-page">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Riftbound Arena home"><i>R</i><span>RIFTBOUND<small>ARENA</small></span></a>
        <div className="match-format"><span>{config?.mode === "online" ? `ROOM ${config.roomCode}` : "ONLINE PROTOCOL"}</span><b>BEST OF 3</b></div>
        <div className="signal"><i /> SYSTEM ONLINE <span>v0.2</span></div>
      </header>

      <section className="arena-shell" id="top">
        {!config && <ModeSelect lobby={lobby} onSolo={() => startSolo(false)} onLearn={() => startSolo(true)} onCreate={() => connectOnline("create")} onJoin={(code) => connectOnline("join", code)} />}
        {config && (
          <>
            <GameSurface key={`${config.mode}-${config.localPlayer}-${session}`} config={config} session={session} onHud={handleHud} onDisconnect={handleDisconnect} />
            <div className="scanlines" />
            <div className="arena-hud top-hud">
              <div className="hud-side local-hud"><PilotHudPanel pilot={hud.pilots[localId]} id={localId} /><ScorePips wins={hud.scores[localId]} side={localId} /></div>
              <div className="center-clock"><span>ROUND {hud.scores[0] + hud.scores[1] + 1}</span><b>{String(hud.seconds).padStart(2, "0")}</b><small>{hud.coreOwner === null ? "CORE UNCLAIMED" : `${PILOTS[hud.coreOwner].name} HOLDS CORE`}</small></div>
              <div className="hud-side rival-hud"><PilotHudPanel pilot={hud.pilots[rivalId]} id={rivalId} /><ScorePips wins={hud.scores[rivalId]} side={rivalId} /></div>
            </div>
            <div className="match-phase"><span>{config.mode === "online" ? `YOU ARE ${PILOTS[localId].name}` : "SOLO PRACTICE"}</span><i /><b>{hud.phase}</b><i /><span>CORE {hud.pilots[localId].progress}%</span></div>
            {liveTraining && config.tutorial && <LiveCoach hud={hud} />}
            {hud.announcement && <div className="announcement"><span>{hud.announcement}</span></div>}
            <button className="help-match" onClick={() => setTraining({ step: 0, launchesRun: false })}>? // HOW TO PLAY</button>
            <button className="exit-match" onClick={leaveMatch} aria-label="Exit match">ESC // EXIT</button>
            {hud.matchWinner !== null && (
              <div className="match-over">
                <span>MATCH COMPLETE</span>
                <Image src={PILOTS[hud.matchWinner].image} alt={`${PILOTS[hud.matchWinner].name} portrait`} width={180} height={180} unoptimized />
                <h2>{PILOTS[hud.matchWinner].name}<em>DOMINATES</em></h2>
                <p>{hud.scores[0]} — {hud.scores[1]}</p>
                {config.mode === "cpu" ? <button onClick={rematch}>RUN IT BACK <b>↗</b></button> : <button onClick={leaveMatch}>RETURN TO LOBBY <b>↗</b></button>}
                <button className="text-button" onClick={leaveMatch}>CHANGE PROTOCOL</button>
              </div>
            )}
            {training && <TrainingOverlay session={training} onNext={advanceTraining} onClose={closeTraining} />}
          </>
        )}
      </section>

      <section className="field-guide" id="guide">
        <div className="section-heading"><span>FIELD MANUAL // 01</span><h2>THE FASTEST ROUTE<br />IS THROUGH.</h2></div>
        <div className="guide-grid">
          <article><b>01</b><h3>HUNT</h3><p>Five minion classes guard each route. Enemies near the relay hit harder—but drop more EXP and better tech.</p></article>
          <article><b>02</b><h3>AMPLIFY</h3><p>Level-ups raise health and blaster output. Stack weapon cores, recharge shields, cloak, heal, and trigger overdrive.</p></article>
          <article><b>03</b><h3>CONVERGE</h3><p>Each pilot sees their own full-screen route. The first to touch center gets a level burst, repair, and nine seconds of overdrive.</p></article>
          <article><b>04</b><h3>BREAK</h3><p>Take your rival to zero twice. Minion deaths reset your entire run; rival takedowns win the round.</p></article>
        </div>
      </section>

      <section className="controls-section">
        <div className="control-card cyan">
          <div><span>EVERY PILOT</span><h3>KEYBOARD</h3></div>
          <dl><dt>MOVE</dt><dd><kbd>A</kbd><kbd>D</kbd></dd><dt>JUMP</dt><dd><kbd>W</kbd></dd><dt>FIRE</dt><dd><kbd>F</kbd></dd><dt>SHIELD</dt><dd><kbd>G</kbd></dd><dt>DASH</dt><dd><kbd>H</kbd></dd></dl>
        </div>
        <div className="versus-mark">VS</div>
        <div className="control-card magenta">
          <div><span>ONLINE DUEL</span><h3>ROOM CODE</h3></div>
          <p className="control-copy">Create a room, send the five-character code, and both pilots launch into their own full-screen view. For one-PC testing, join from a second tab.</p>
        </div>
      </section>

      <footer><span>RIFTBOUND ARENA // LOCAL ALPHA</span><p>BUILT FOR THE MOMENT BOTH PATHS COLLIDE.</p><span>PHASER + BLENDER</span></footer>
    </main>
  );
}
