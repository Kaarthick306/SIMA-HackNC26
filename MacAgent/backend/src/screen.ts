//decined to sit on top of rfb thay gives screen functionality

import { execFileSync } from "node:child_process";
import { PNG } from "pngjs";
import { RfbClient } from "./rfb.js";
import { SHIFT, parseCombo, textKeys } from "./keysyms.js";

//why the check? incase I implement a new host location module in the future;)
const HOST = process.env.MAC_AGENT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MAC_AGENT_PORT ?? 5900);
export const USER = process.env.MAC_AGENT_USER ?? "agent";
const KEYCHAIN_SERVICE = "mac-agent-vnc";
export const MAX_WIDTH = Number(process.env.MAC_AGENT_MAX_WIDTH ?? 1280); 

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

//timestamp for, guess what.
let lastInput = 0;

function password(): string {
  if (process.env.MAC_AGENT_PASSWORD) return process.env.MAC_AGENT_PASSWORD;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", USER, "-w"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      `No password for "${USER}" in the Keychain. Run: security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${USER} -w`,
    );
  }
}

let client: RfbClient | null = null;
let connecting: Promise<RfbClient> | null = null;

// reconnect automatically if connection drops
export async function getClient(): Promise<RfbClient> {
  if (client && !client.closed) return client;
  if (!connecting) {
    connecting = RfbClient.connect({ host: HOST, port: PORT, username: USER, password: password() })
      .then(async (c) => {
        try {
          await c.waitForFullFrame();
        } catch (e) {
          c.close();
          throw e;
        }
        client = c;
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

//screenshot scale
function scale(c: RfbClient): number {
  return c.width > MAX_WIDTH ? c.width / MAX_WIDTH : 1;
}


type Png = { png: Buffer; width: number; height: number };


//render framebuffer pixels to png. 
//Math clings to me like a koala on bamboo
function render(c: RfbClient, fx: number, fy: number, fw: number, fh: number, w: number, h: number): Png {
  const png = new PNG({ width: w, height: h });
  const src = c.fb;
  const sx = fw / w;
  const sy = fh / h;
  for (let y = 0; y < h; y++) {
    const y0 = fy + Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(fy + fh, fy + Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = fx + Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(fx + fw, fx + Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * c.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          b += src[i];
          g += src[i + 1];
          r += src[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      png.data[o] = r / n;
      png.data[o + 1] = g / n;
      png.data[o + 2] = b / n;
      png.data[o + 3] = 255;
    }
  }
  return { png: PNG.sync.write(png), width: w, height: h }; 
}

//waiting time after input to actually showup
// I had a brain fog here. Thanks chatgpt for telling me where to continue from.
const SETTLE_MS = 350;

// wait till settling period and refresh for a fresh energized client. Not energized maybe.
async function freshClient(): Promise<RfbClient> {
  const c = await getClient();
  const since = Date.now() - lastInput;
  if (since < SETTLE_MS) await sleep(SETTLE_MS - since);
  await c.fullRefresh();
  return c;
}

// Pichkaw!! screenshot acquired
export async function screenshot(): Promise<Png> {
  const c = await freshClient();
  const s = scale(c);
  return render(c ,0, 0, c.width, c.height, Math.round(c.width / s),Math.round(c.height / s));
}

/** Full-resolution crop of a screenshot-space region, at most ZOOM_MAX px on its long edge. */
const ZOOM_MAX = 1568;
export async function zoom(x0: number, y0: number, x1: number, y1: number): Promise<Png> {
  const c = await freshClient();
  const s = scale(c);
  const fx = Math.max(0, Math.min(c.width - 1, Math.round(Math.min(x0, x1) * s)));
  const fy = Math.max(0, Math.min(c.height - 1, Math.round(Math.min(y0, y1) * s)));
  const fw = Math.max(1, Math.min(c.width - fx, Math.round(Math.abs(x1 - x0) * s)));
  const fh = Math.max(1 , Math.min(c.height - fy, Math.round(Math.abs(y1 - y0) * s)));
  const k = Math.max(1, Math.max(fw, fh) /ZOOM_MAX);
  return render(c, fx, fy, fw, fh, Math.max(1, Math.round(fw / k)), Math.max(1, Math.round(fh / k)));
}

const BUTTON = { left: 1, middle: 2, right: 4 } as const;
export type Button = keyof typeof BUTTON;

// last pointer pos
let px = 0;
let py = 0;

//Cause mouse buttons and keys need to be held down
let heldButtons = 0;
const heldKeys = new Set<number>();

export function cursor(): [number, number] {
  return [Math.round(px), Math.round(py)];
}

async function toFb(x: number, y: number): Promise<[RfbClient, number, number]> {
  const c = await getClient();
  const s = scale(c);
  lastInput = Date.now();
  px = x;
  py = y;
  return [c, x * s, y * s];
}

function keyDown(c: RfbClient, sym: number) {
  heldKeys.add(sym);
  c.key(sym, true);
}

function keyUp(c: RfbClient, sym: number) {
  c.key(sym, false);
  heldKeys.delete(sym);
}

export async function move(x: number, y: number) {
  const [c, fx, fy] = await toFb(x, y);
  c.pointer(fx, fy, heldButtons);
}

export async function click(x: number, y: number, button: Button, count: number) {
  const [c, fx, fy] = await toFb(x, y);
  c.pointer(fx, fy, 0);
  await sleep(30);
  for (let i = 0; i < count; i++) {
    c.pointer(fx, fy, BUTTON[button]);
    await sleep(40);
    c.pointer(fx, fy, 0);
    await sleep(60);
  }
}

export async function drag(x1: number, y1: number, x2: number, y2: number) {
  const [c, fx1, fy1] = await toFb(x1, y1);
  const [, fx2, fy2] = await toFb(x2, y2);
  c.pointer(fx1, fy1, 0);
  await sleep(50);
  c.pointer(fx1, fy1, 1);
  await sleep(100);
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    c.pointer(fx1 + ((fx2 - fx1) * i) / steps, fy1 + ((fy2 - fy1) * i) / steps, 1);
    await sleep(15);
  }
  await sleep(100);
  c.pointer(fx2, fy2, 0);
}

export async function scroll(x: number, y: number, direction: "up" | "down" | "left" | "right", amount: number) {
  const [c, fx, fy] = await toFb(x, y);
  const mask = { up: 8, down: 16, left: 32, right: 64 }[direction];
  c.pointer(fx, fy, 0);
  for (let i = 0; i < amount; i++) {
    c.pointer(fx, fy, mask);
    c.pointer(fx, fy, 0);
    await sleep(30);
  }
}

export async function typeText(text: string) {
  const c = await getClient();
  for (const [sym, shift] of textKeys(text)) {
    if (shift) keyDown(c, SHIFT);
    keyDown(c, sym);
    keyUp(c, sym);
    if (shift) keyUp(c, SHIFT);
    await sleep(12);
  }
  lastInput = Date.now();
}

export async function pressKey(combo: string) {
  const keys = parseCombo(combo);
  const c = await getClient();
  for (const k of keys) {
    keyDown(c, k);
    await sleep(20);
  }
  for (const k of [...keys].reverse()) {
    keyUp(c, k);
    await sleep(20);
  }
  lastInput = Date.now();
}

export async function withModifiers<T>(combo: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!combo) return fn();
  const keys = parseCombo(combo);
  const c =await getClient();
  for (const k of keys) keyDown(c, k);
  await sleep(30);
  try {
    return await fn();
  } finally {
    for (const k of [...keys].reverse()) keyUp(c, k) ;
    lastInput = Date.now();
  }
}

export async function holdKey(combo: string, seconds: number) {
  const keys = parseCombo(combo);
  const c = await getClient();
  for (const k of keys) keyDown(c, k);
  try {
    await sleep(seconds * 1000);
  } finally {
    for (const k of [...keys].reverse()) keyUp(c, k);
    lastInput = Date.now();
  }
}

export async function mouseDown() {
  const [c, fx, fy] = await toFb(px, py);
  heldButtons |= BUTTON.left;
  c.pointer(fx, fy, heldButtons);
}

export async function mouseUp() {
  const [c, fx, fy] = await toFb(px, py);
  heldButtons &= ~BUTTON.left;
  c.pointer(fx, fy, heldButtons);
}

export function releaseAll() {
  if (!client || client.closed) return;
  const s = scale(client);
  if (heldButtons) client.pointer(px * s, py * s, 0);
  heldButtons = 0;
  for (const k of heldKeys) client.key(k, false);
  heldKeys.clear();
}

export function disconnect() {
  client?.close();
  client = null;
}
