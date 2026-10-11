// Live view for the menu bar app: streams the agent's screen as PNG frames on stdout, each
// prefixed with its length as a 4-byte big-endian integer. View only; it sends no input.
// Exits when stdin closes, so it never outlives the app that started it.
import * as screen from "./screen.js";

const FRAME_MS = 330;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = true;
const quit = () => {
  running = false;
  screen.disconnect();
  process.exit(0);
};
process.stdin.on("end", quit);
process.stdin.on("close", quit);
process.stdin.resume();
process.stdout.on("error", quit); // reader went away (EPIPE)

while (running) {
  const start = Date.now();
  try {
    const { png } = await screen.screenshot();
    const head = Buffer.alloc(4);
    head.writeUInt32BE(png.length, 0);
    process.stdout.write(Buffer.concat([head, png]));
    await sleep(Math.max(0, FRAME_MS - (Date.now() - start)));
  } catch (e) {
    process.stderr.write(`viewer: ${(e as Error).message}\n`);
    screen.disconnect();
    await sleep(1000);
  }
}
