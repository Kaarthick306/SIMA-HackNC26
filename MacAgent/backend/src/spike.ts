// Feasibility check: connect as the agent user and save what the VNC server shows.
// Usage: npm run build && npm run spike [-- --spotlight]
import { writeFileSync } from "node:fs";
import * as screen from "./screen.js";

const out = process.argv.find((a) => a.endsWith(".png")) ?? "spike.png";

const c = await screen.getClient();
console.log(`Connected: "${c.name}" ${c.width}x${c.height}`);

if (process.argv.includes("--spotlight")) {
  await screen.pressKey("cmd+space");
  await new Promise((r) => setTimeout(r, 1000));
}

const shot = await screen.screenshot();
writeFileSync(out, shot.png);
console.log(`Saved ${out} (${shot.width}x${shot.height}). Check that it shows the AGENT user's desktop, not yours.`);
screen.disconnect();