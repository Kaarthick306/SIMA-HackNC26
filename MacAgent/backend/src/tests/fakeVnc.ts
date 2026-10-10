// A fake Screen Sharing server, for the tests and for trying the tools without an agent account.
// It speaks just enough RFB 3.8 for our client: Apple (ARD) sign-in, Raw frames, CopyRect and
// DesktopSize. It keeps a small picture as its "screen" and records every mouse and key event.
//
// Run it on its own with `npm run fake-vnc`, then in another Terminal:
//   MAC_AGENT_PORT=5999 MAC_AGENT_PASSWORD=fake npm run spike
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { pathToFileURL } from "node:url";

export type InputEvent =
  | { type: "pointer"; x: number; y: number; buttons: number }
  | { type: "key"; keysym: number; down: boolean };

export type Rgb = [number, number, number];

export interface FakeVncOptions {
  width?: number;
  height?: number;
  username?: string;
  password?: string;
  name?: string;
  /** RFB security types to offer. 30 = Apple, 1 = none, 2 = legacy VNC password (offered but never accepted). */
  securityTypes?: number[];
  /** 0 picks any free port. */
  port?: number;
  /** Draw a yellow square wherever the left button is pressed, so clicks show up in screenshots. */
  paintClicks?: boolean;
}

function leftPad(buf: Buffer, len: number): Buffer {
  if (buf.length >= len) return buf.subarray(buf.length - len);
  return Buffer.concat([Buffer.alloc(len - buf.length), buf]);
}

/** The server's half of Apple sign-in: recover the username and password from a client's reply. */
export function ardDecrypt(
  dh: { computeSecret(otherPublicKey: Buffer): Buffer },
  keyLen: number,
  response: Buffer,
): { username: string; password: string } {
  const shared = leftPad(dh.computeSecret(response.subarray(128, 128 + keyLen)), keyLen);
  const aesKey = crypto.createHash("md5").update(shared).digest();
  const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
  decipher.setAutoPadding(false);
  const creds = Buffer.concat([decipher.update(response.subarray(0, 128)), decipher.final()]);
  const text = (b: Buffer) => b.subarray(0, Math.max(0, b.indexOf(0))).toString("utf8");
  return { username: text(creds.subarray(0, 64)), password: text(creds.subarray(64, 128)) };
}

// Hands out exact-length reads from a socket, in order.
class SocketReader {
  private buffer = Buffer.alloc(0);
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private closed = false;

  constructor(socket: net.Socket) {
    socket.on("data", (d: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, d]);
      this.flush();
    });
    const end = () => {
      this.closed = true;
      this.waiter?.reject(new Error("client disconnected"));
      this.waiter = null;
    };
    socket.on("close", end);
    socket.on("error", end);
  }

  read(n: number): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error("client disconnected"));
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.flush();
    });
  }

  private flush() {
    if (!this.waiter || this.buffer.length < this.waiter.n) return;
    const { n, resolve } = this.waiter;
    this.waiter = null;
    const out = Buffer.from(this.buffer.subarray(0, n));
    this.buffer = this.buffer.subarray(n);
    resolve(out);
  }
}

interface Connection {
  socket: net.Socket;
  /** The screen changed size and this client hasn't been told yet. */
  needsResize: boolean;
}

export class FakeVnc extends EventEmitter {
  width: number;
  height: number;
  port = 0;
  /** The screen: BGRX, 4 bytes per pixel, row by row, the same layout our client keeps. */
  fb: Buffer;
  /** Every mouse and key event received, oldest first. */
  events: InputEvent[] = [];
  /** The username and password of every sign-in attempt. */
  logins: { username: string; password: string }[] = [];

  private server = net.createServer((socket) => {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    this.serve(socket).catch(() => socket.destroy());
  });
  /** Every open socket, including clients that haven't finished signing in. */
  private sockets = new Set<net.Socket>();
  /** Signed-in clients, which receive screen updates. */
  private connections = new Set<Connection>();
  private opts: Required<Omit<FakeVncOptions, "width" | "height" | "port">>;

  private constructor(opts: FakeVncOptions) {
    super();
    this.width = opts.width ?? 64;
    this.height = opts.height ?? 40;
    this.fb = Buffer.alloc(this.width * this.height * 4);
    this.opts = {
      username: opts.username ?? "agent",
      password: opts.password ?? "fake",
      name: opts.name ?? "Fake Mac",
      securityTypes: opts.securityTypes ?? [30],
      paintClicks: opts.paintClicks ?? false,
    };
  }

  static start(opts: FakeVncOptions = {}): Promise<FakeVnc> {
    const fake = new FakeVnc(opts);
    return new Promise((resolve, reject) => {
      fake.server.once("error", reject);
      fake.server.listen(opts.port ?? 0, "127.0.0.1", () => {
        fake.port = (fake.server.address() as net.AddressInfo).port;
        resolve(fake);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // ---- The picture

  fill(x: number, y: number, w: number, h: number, [r, g, b]: Rgb) {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        const i = (yy * this.width + xx) * 4;
        this.fb[i] = b;
        this.fb[i + 1] = g;
        this.fb[i + 2] = r;
      }
    }
  }

  pixel(x: number, y: number): Rgb {
    const i = (y * this.width + x) * 4;
    return [this.fb[i + 2], this.fb[i + 1], this.fb[i]];
  }

  /** Change the screen size. Each client is told with its next update, as a real server does. */
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.fb = Buffer.alloc(width * height * 4);
    for (const c of this.connections) c.needsResize = true;
  }

  /** Move a block of the picture and tell every client with a CopyRect, the way a scroll is sent. */
  copyRect(srcX: number, srcY: number, x: number, y: number, w: number, h: number) {
    const block = Buffer.alloc(w * h * 4);
    for (let row = 0; row < h; row++) {
      this.fb.copy(block, row * w * 4, ((srcY + row) * this.width + srcX) * 4, ((srcY + row) * this.width + srcX + w) * 4);
    }
    for (let row = 0; row < h; row++) block.copy(this.fb, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4);

    const msg = Buffer.alloc(4 + 12 + 4);
    msg.writeUInt16BE(1, 2); // one rectangle
    msg.writeUInt16BE(x, 4);
    msg.writeUInt16BE(y, 6);
    msg.writeUInt16BE(w, 8);
    msg.writeUInt16BE(h, 10);
    msg.writeInt32BE(1, 12); // CopyRect
    msg.writeUInt16BE(srcX, 16);
    msg.writeUInt16BE(srcY, 18);
    for (const c of this.connections) c.socket.write(msg);
  }

  // ---- Recorded input

  clearEvents() {
    this.events = [];
  }

  /** Wait until at least `count` events have been recorded. */
  waitForEvents(count: number, timeoutMs = 3000): Promise<InputEvent[]> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.events.length < count) return;
        clearTimeout(timer);
        this.off("input", check);
        resolve(this.events);
      };
      const timer = setTimeout(() => {
        this.off("input", check);
        reject(new Error(`Expected ${count} input events, got ${this.events.length}`));
      }, timeoutMs);
      this.on("input", check);
      check();
    });
  }

  private record(e: InputEvent) {
    this.events.push(e);
    this.emit("input", e);
  }

  // ---- The protocol

  private async serve(socket: net.Socket) {
    socket.setNoDelay(true);
    const reader = new SocketReader(socket);
    const conn: Connection = { socket, needsResize: false };

    // 1. Versions.
    socket.write("RFB 003.008\n");
    await reader.read(12);

    // 2. Security: offer our types, then check whichever the client picked.
    const types = this.opts.securityTypes;
    socket.write(Buffer.from([types.length, ...types]));
    const chosen = (await reader.read(1))[0];
    let ok = false;
    if (chosen === 30 && types.includes(30)) {
      const dh = crypto.getDiffieHellman("modp2"); // a standard 1024-bit group, so there's no slow prime search
      dh.generateKeys();
      const prime = dh.getPrime();
      const head = Buffer.alloc(4);
      leftPad(dh.getGenerator(), 2).copy(head, 0);
      head.writeUInt16BE(prime.length, 2);
      socket.write(Buffer.concat([head, prime, leftPad(dh.getPublicKey(), prime.length)]));
      const login = ardDecrypt(dh, prime.length, await reader.read(128 + prime.length));
      this.logins.push(login);
      ok = login.username === this.opts.username && login.password === this.opts.password;
    } else if (chosen === 1 && types.includes(1)) {
      ok = true;
    }
    const result = Buffer.alloc(4);
    if (!ok) {
      const reason = Buffer.from("Authentication failed");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(reason.length, 0);
      result.writeUInt32BE(1, 0);
      socket.end(Buffer.concat([result, len, reason]));
      return;
    }
    socket.write(result);

    // 3. ClientInit, then ServerInit: size, pixel format and name.
    await reader.read(1);
    const name = Buffer.from(this.opts.name);
    const init = Buffer.alloc(24);
    init.writeUInt16BE(this.width, 0);
    init.writeUInt16BE(this.height, 2);
    init[4] = 32; // bits per pixel
    init[5] = 24; // depth
    init[7] = 1; // true colour
    init.writeUInt16BE(255, 8);
    init.writeUInt16BE(255, 10);
    init.writeUInt16BE(255, 12);
    init[14] = 16;
    init[15] = 8;
    init.writeUInt32BE(name.length, 20);
    socket.write(Buffer.concat([init, name]));

    this.connections.add(conn);
    socket.on("close", () => this.connections.delete(conn));

    // 4. Client messages until it disconnects.
    for (;;) {
      const type = (await reader.read(1))[0];
      switch (type) {
        case 0: // SetPixelFormat
          await reader.read(19);
          break;
        case 2: { // SetEncodings
          const head = await reader.read(3);
          await reader.read(4 * head.readUInt16BE(1));
          break;
        }
        case 3: { // FramebufferUpdateRequest
          const req = await reader.read(9);
          this.sendUpdate(conn, req[0] === 1);
          break;
        }
        case 4: { // KeyEvent
          const k = await reader.read(7);
          this.record({ type: "key", keysym: k.readUInt32BE(3), down: k[0] === 1 });
          break;
        }
        case 5: { // PointerEvent
          const p = await reader.read(5);
          const e = { type: "pointer" as const, x: p.readUInt16BE(1), y: p.readUInt16BE(3), buttons: p[0] };
          if (this.opts.paintClicks && e.buttons & 1) this.fill(e.x - 3, e.y - 3, 6, 6, [255, 220, 0]);
          this.record(e);
          break;
        }
        case 6: { // ClientCutText
          const head = await reader.read(7);
          await reader.read(head.readUInt32BE(3));
          break;
        }
        default:
          throw new Error(`Unknown client message ${type}`);
      }
    }
  }

  private sendUpdate(conn: Connection, incremental: boolean) {
    const rect = (x: number, y: number, w: number, h: number, encoding: number) => {
      const b = Buffer.alloc(12);
      b.writeUInt16BE(x, 0);
      b.writeUInt16BE(y, 2);
      b.writeUInt16BE(w, 4);
      b.writeUInt16BE(h, 6);
      b.writeInt32BE(encoding, 8);
      return b;
    };
    const header = (rects: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt16BE(rects, 2);
      return b;
    };

    if (conn.needsResize) {
      conn.needsResize = false;
      conn.socket.write(Buffer.concat([header(1), rect(0, 0, this.width, this.height, -223)]));
      return;
    }
    if (incremental) {
      conn.socket.write(header(0)); // nothing changed
      return;
    }
    // The whole screen as two Raw rectangles (top and bottom), since real servers send several.
    const top = Math.max(1, Math.floor(this.height / 2));
    const bottom = this.height - top;
    const parts = [header(bottom ? 2 : 1), rect(0, 0, this.width, top, 0), this.fb.subarray(0, top * this.width * 4)];
    if (bottom) parts.push(rect(0, top, this.width, bottom, 0), this.fb.subarray(top * this.width * 4));
    conn.socket.write(Buffer.concat(parts));
  }
}

// Run directly: a desktop-sized fake that logs what it receives and marks clicks in yellow.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_VNC_PORT ?? 5999);
  const fake = await FakeVnc.start({ width: 1280, height: 800, port, paintClicks: true });
  fake.fill(0, 0, 1280, 800, [70, 130, 200]); // desktop
  fake.fill(0, 0, 1280, 24, [235, 235, 235]); // menu bar
  fake.fill(440, 730, 400, 60, [200, 200, 210]); // dock
  fake.on("input", (e: InputEvent) => {
    if (e.type === "pointer") console.log(`pointer  ${e.x}, ${e.y}  buttons=${e.buttons}`);
    else console.log(`key ${e.down ? "down" : "up  "}  0x${e.keysym.toString(16)}`);
  });
  console.log(`Fake VNC server on 127.0.0.1:${port} (user "agent", password "fake"). Ctrl+C to stop.`);
  console.log(`Try it:  MAC_AGENT_PORT=${port} MAC_AGENT_PASSWORD=fake npm run spike`);
}
