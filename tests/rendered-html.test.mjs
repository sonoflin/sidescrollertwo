import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Riftbound lobby", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Riftbound Arena/);
  assert.match(html, /CREATE ONLINE ROOM/);
  assert.match(html, /LEARN TO PLAY/);
  assert.match(html, /SOLO PRACTICE/);
  assert.match(html, /BEST OF 3/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("ships editable pilot sources and online relay", async () => {
  await Promise.all([
    access(new URL("public/assets/characters/astra.blend", root)),
    access(new URL("public/assets/characters/vanta.blend", root)),
    access(new URL("public/assets/characters/astra.glb", root)),
    access(new URL("public/assets/characters/vanta.glb", root)),
    access(new URL("public/assets/characters/astra-spritesheet.png", root)),
    access(new URL("public/assets/characters/vanta-spritesheet.png", root)),
    access(new URL("public/assets/characters/astra-animations.json", root)),
    access(new URL("public/assets/characters/vanta-animations.json", root)),
    access(new URL("public/og.png", root)),
    access(new URL("server/relay.mjs", root)),
  ]);
  const source = await readFile(new URL("app/game/ArenaGame.tsx", root), "utf8");
  assert.match(source, /NEXT_PUBLIC_RELAY_URL/);
  assert.match(source, /CREATE ONLINE ROOM/);
  assert.match(source, /TRAINING_STEPS/);
  assert.match(source, /TRAINING PAUSED/);
  assert.match(source, /COLLAPSE ACTIVE/);
  assert.match(source, /PILOT_ANIMATION_CLIPS/);
  assert.match(source, /astra-animated/);

  const expectedClips = ["idle", "run", "jump", "fire", "shield", "dash", "hit", "defeat"];
  for (const pilot of ["astra", "vanta"]) {
    const manifest = JSON.parse(await readFile(new URL(`public/assets/characters/${pilot}-animations.json`, root), "utf8"));
    assert.deepEqual(Object.keys(manifest.clips), expectedClips);
    assert.equal(manifest.frameWidth, 256);
    assert.equal(manifest.frameHeight, 256);
  }
});
