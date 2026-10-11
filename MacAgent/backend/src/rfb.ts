//Planning documentation
//Setting up VNC client for interaction
//need a way to read and write to client
//need to wait for chunks till desired length is achieved


import net from "node:net";
import { EventEmitter } from "node:events";
import { ARD_Response } from "./ARD_Auth.js";

const SEC_NONE = 1; //for no auth
const SEC_VNC = 2; //for VNC auth
const SEC_ARD = 30;

const ENC_RAW = 0; //for raw encoding
const ENC_COPYRECT = 1; //for copy rectangle encoding
const ENC_DESKTOPSIZE = -223; //for desktop size encoding

export interface RfbOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs?: number; //optional timeout in ms
}
interface Waiter {
  n: number;
  resolve: (buffer: Buffer) => void;
  reject: (error: Error) => void;
}


class Reader {
  private chunks: Buffer[] = [];// we set up chunks, now we need a buffer to feed in
  private length = 0;
  private waiter: Waiter | null = null;
  private error: Error | null = null;

  //pushing buffer to chunks.
  push(data: Buffer) {
    this.chunks.push(data); 
    this.length += data.length; 
    this.flush();
  }

  
  fail(err: Error) {
    this.error = err;
    if (this.waiter) {
      this.waiter.reject(err); //causes Promise from wait() to reject
      this.waiter = null; //clears waiter after notifying the pending request.
    }
  }
  //read function that takes number of bytes as input
  read(n: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    // create new promise with two functions and save it to waiter
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.flush();
    });
  }

  //buffer manager that fulfills read requests when enough bytes arrive and pushes the data. 
  private flush() {
    
    if (!this.waiter || this.length < this.waiter.n) return;// checks if no one is waiting for data and if there is enough data yet

    const n = this.waiter.n;
    const resolve = this.waiter.resolve;
    this.waiter = null; //as we are fulfilling the waiting request
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length); //if more than 1 chunk, ell chunks are concantenated and the second argument tells the length of total
    const out = Buffer.from(all.subarray(0, n)); //thankfully takes byte offset
    const rest = all.subarray(n);// the rest of string
    this.chunks = rest.length ? [rest] : [];//If rest has something in it, put rest inside an array. Otherwise, use an empty array.
    this.length = rest.length;
    resolve(out);// marks promise as successfully completed with value
  }
}


export class RfbClient extends EventEmitter {
  width = 0;
  height = 0;
  name = "";
  /** BGRX, 4 bytes per pixel, row-major. */
  fb: Buffer = Buffer.alloc(0); //initializing empty buffer
  closed = false;
  /** Pixel area received since connect/resize; the framebuffer is trustworthy once it covers the screen. */
  private received = 0;
  
  private socket!: net.Socket; //net.Socket is Node.js's TCP socket type.
  private reader = new Reader(); //creating reader object

  static async connect(opts: RfbOptions): Promise<RfbClient> {
    const c = new RfbClient();
    await c.open(opts);
    return c;
  }
// opens vnc. Async allows await and return Promise
  private async open(opts: RfbOptions) {
    const timeoutMs = opts.timeoutMs ?? 10000; 
    this.socket = net.connect({ host:opts.host, port:opts.port }); //thanks GPT
    this.socket.setNoDelay(true); 
    this.socket.on("data", (d: Buffer) => this.reader.push(d)) ;//registers listener for socket's 'data' event
    this.socket.on("error", (e) => this.shutdown(e));// handles error handler
    this.socket.on("close", () => this.shutdown(new Error("VNC connection closed")));

    const timer = setTimeout(() => this.shutdown(new Error("VNC handshake timed out")), timeoutMs); //timeout if handshake takes too long
    try {
      await this.handshake(opts); //begin handshake
    } finally {
      clearTimeout(timer);// clears timeout to stop incorrect firing
    }
    this.messageLoop().catch((e) => this.shutdown(e));//After the handshake completes successfully, the code starts processing ongoing VNC protocol messages.
    this.requestUpdate(false);//his requests a framebuffer update from the VNC server.The argument false is likely a flag controlling whether the request is incremental.
  }

  private async handshake(opts: RfbOptions) {
    const version = (await this.reader.read(12)).toString("latin1");

    //checks for VNC server. Eg starting with http fails
    if (!version.startsWith("RFB ")) throw new Error(`Not a VNC server: ${JSON.stringify(version)}`);

    //sends client's protocol version
    this.socket.write("RFB 003.008\n");

    //security negotiation. Reads number of security types. 
    const count = (await this.reader.read(1))[0];// await waits for byte, this.reader.read(1) reads one byte. [0] extracts the first byte from the returned buffer because server's security-type count is represented by a single byte.

    //check for refused connection
    if (count === 0) throw new Error(`Server refused connection: ${await this.readString()}`); 

    //Reads available security types
    const types = [...(await this.reader.read(count))];

    //setting up auth type
    if (types.includes(SEC_ARD)) {
      this.socket.write(Buffer.from([SEC_ARD]));
      const head = await this.reader.read(4);
      const generator = head.subarray(0, 2);
      const keyLen = head.readUInt16BE(2);
      const prime = await this.reader.read(keyLen);
      const serverPublic = await this.reader.read(keyLen);
      this.socket.write(ARD_Response(generator, prime, serverPublic, opts.username, opts.password));
    } else if (types.includes(SEC_NONE)) {
      this.socket.write(Buffer.from([SEC_NONE]));
    } else {
      throw new Error(
        `No supported auth type (server offers ${types.join(", ")}; need ${SEC_ARD} = Apple). ` +
          (types.includes(SEC_VNC) ? "Legacy VNC-password auth is offered but not supported." : ""),
      );
    }

    //4 bytes auth verification number
    const result = (await this.reader.read(4)).readUInt32BE(0);
    if (result !== 0) {
      let reason = "authentication failed";
      try {
        reason = await this.readString();
      } catch {}
      throw new Error(`VNC auth failed: ${reason}`);
    }
    //Buffer.from([1]) converts that array into a Node.js Buffer containing one byte.
    this.socket.write(Buffer.from([1])); // ClientInit, shared = true
    const init = await this.reader.read(24);//The RFB/VNC protocol's ServerInit message begins with a fixed-size section of 24 bytes.

    this.resize(init.readUInt16BE(0), init.readUInt16BE(2));//readUInt16BE(byte offset) reads an unsigned 16-bit integer (2 bytes)

    //read desktop name
    this.name = (await this.reader.read(init.readUInt32BE(20))).toString("utf8");

    // SetPixelFormat: 32bpp, depth 24, little-endian? , true colour, R<<16 G<<8 B → bytes B,G,R,X.
    const pf = Buffer.alloc(20);
    pf[0] = 0;
    pf[4] = 32;
    pf[5] = 24;
    pf[6] = 0;
    pf[7] = 1;
    pf.writeUInt16BE(255, 8);
    pf.writeUInt16BE(255, 10);
    pf.writeUInt16BE(255, 12);
    pf[14] = 16;
    pf[15] = 8;
    pf[16] = 0;
    this.socket.write(pf);

  //define supported encodings
    const encs = [ENC_COPYRECT, ENC_RAW, ENC_DESKTOPSIZE];

    //allocate message buffer
    const se = Buffer.alloc(4 + 4 * encs.length);

    //set first byte to 2. In the RFB/VNC protocol, message type 2 identifies a client SetEncodings message
    se[0] = 2;

    //writeUInt16BE writes an unsigned 16-bit integer in big-endian order. his writes the number of encodings into the buffer, starting at byte offset 2.
    se.writeUInt16BE(encs.length, 2);

    //e is the current encoding value.
    //i is its index, starting at 0
    //4 + 4 * i calculates the byte offset for each encoding.
    //This line loops through every encoding in the array and writes its numeric value into the buffer.
    encs.forEach((e, i) => se.writeInt32BE(e, 4 + 4 * i));
    this.socket.write(se);//This writes the completed 16-byte buffer to the network socket.
    //the VNC server can then read the message and determine which encodings your client supports.
  }

  private async readString(): Promise<string> {

    //read 4 bytes
    const len = (await this.reader.read(4)).
    readUInt32BE(0);
    return (await this.reader.read(len)).toString("utf8");//reads remaining string and returns
  }

  private resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.fb = Buffer.alloc(w * h * 4);
    this.received = 0;
  }

  //checks whether the received count is at least the total number of pixels
  get hasFullFrame(): boolean {
    return this.width > 0 && this.received >= this.width * this.height;
  }

  /** Wait until pixels covering the whole screen have arrived since connecting. */
  async waitForFullFrame(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.hasFullFrame) {
      if (this.closed) throw new Error("VNC connection closed");
      if (Date.now() > deadline) throw new Error("Timed out waiting for the screen image");
      await this.refresh(1000, false);
    }
  }

  private async messageLoop() {
    while (!this.closed) {
      const type = (await this.reader.read(1))[0];
      switch (type) {
        case 0: {
          const head = await this.reader.read(3);
          const rects = head.readUInt16BE(1);
          for (let i = 0; i < rects; i++) await this.readRect();
          this.emit("update");
          break;
        }
        case 1: {
          const head = await this.reader.read(5);
          await this.reader.read(head.readUInt16BE(3) * 6);
          break;
        }
        case 2:
          break;
        case 3: {
          await this.reader.read(3);
          await this.readString();
          break;
        }
        default:
          throw new Error(`Unsupported server message type ${type}`);
      }
    }
  }

  private async readRect() {
    const r = await this.reader.read(12);
    const x = r.readUInt16BE(0);
    const y = r.readUInt16BE(2);
    const w = r.readUInt16BE(4);
    const h = r.readUInt16BE(6);
    const enc = r.readInt32BE(8);

    if (enc === ENC_RAW) {
      const data = await this.reader.read(w * h * 4);
      this.received += w * h;
      for (let row = 0; row < h; row++) {
        if (y + row >= this.height) break;
        const cols = Math.min(w, this.width - x);
        data.copy(this.fb, ((y + row) * this.width + x) * 4, row * w * 4, (row * w + cols) * 4);
      }
    } else if (enc === ENC_COPYRECT) {
      const src = await this.reader.read(4);
      const sx = src.readUInt16BE(0);
      const sy = src.readUInt16BE(2);
      const tmp = Buffer.alloc(w * h * 4);
      for (let row = 0; row < h; row++) {
        this.fb.copy(tmp, row * w * 4, ((sy + row) * this.width + sx) * 4, ((sy + row) * this.width + sx + w) * 4);
      }
      for (let row = 0; row < h; row++) {
        tmp.copy(this.fb, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4);
      }
    } else if (enc === ENC_DESKTOPSIZE) {
      this.resize(w, h);
      this.requestUpdate(false);
    } else {
      throw new Error(`Unsupported rect encoding ${enc}`);
    }
  }

  requestUpdate(incremental: boolean) {
    if (this.closed) return;
    const b = Buffer.alloc(10);
    b[0] = 3;
    b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(this.width, 6);
    b.writeUInt16BE(this.height, 8);
    this.socket.write(b);
  }

  /** Ask for fresh pixels and wait for the next update (or the timeout, if nothing changed). */
  refresh(timeoutMs = 1500, incremental = true): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off("update", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.on("update", done);
      this.requestUpdate(incremental);
    });
  }

  /**
   * Re-fetch the whole screen. Incremental updates can leave stale or mis-drawn regions in the
   * local copy, and the first update after a request may answer an older one, so screenshots
   * wait until pixels covering the full screen have arrived after this request.
   */
  fullRefresh(timeoutMs = 5000): Promise<void> {
    const start = this.received;
    const target = start + this.width * this.height;
    return new Promise((resolve, reject) => {
      const finish = (err?: Error) => {
        clearTimeout(timer);
        this.off("update", check);
        this.off("closed", finish);
        err ? reject(err) : resolve();
      };
      const check = () => {
        // A resize resets the counter; then a full frame at the new size is enough.
        if (this.received >= target || (this.received < start && this.hasFullFrame)) finish();
      };
      const timer = setTimeout(() => finish(new Error("Timed out waiting for the screen image")), timeoutMs);
      this.on("update", check);
      this.on("closed", finish);
      this.requestUpdate(false);
    });
  }

  pointer(x: number, y: number, buttonMask: number) {
    if (this.closed) throw new Error("VNC connection is closed");
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = buttonMask;
    b.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
    b.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
    this.socket.write(b);
  }

  key(keysym: number, down: boolean) {
    if (this.closed) throw new Error("VNC connection is closed");
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.socket.write(b);
  }

  close() {
    this.shutdown(new Error("closed by client"));
  }

  private shutdown(err: Error) {
    if (this.closed) return;
    this.closed = true;
    this.reader.fail(err);
    this.socket?.destroy();
    this.emit("closed", err);
  }
}