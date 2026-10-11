//X11 keysms

const CMD = Number(process.env.MAC_AGENT_CMD_KEYSYM ?? 0xffeb);

export const SHIFT = 0xffe1;

const NAMED: Record<string, number> = {
  cmd: CMD, command: CMD, meta: CMD, super: CMD,
  shift: SHIFT,
  ctrl: 0xffe3, control: 0xffe3,
  alt: 0xffe9, option: 0xffe9, opt: 0xffe9,
  return: 0xff0d, enter: 0xff0d,
  tab: 0xff09,
  esc: 0xff1b, escape: 0xff1b,
  space: 0x0020,
  backspace: 0xff08, delete: 0xff08,
  forwarddelete: 0xffff, del: 0xffff,
  up: 0xff52, down: 0xff54, left: 0xff51, right: 0xff53,
  home: 0xff50, end: 0xff57,
  pageup: 0xff55, pagedown: 0xff56,
  capslock: 0xffe5,
  f1: 0xffbe, f2: 0xffbf, f3: 0xffc0, f4: 0xffc1, f5: 0xffc2, f6: 0xffc3,
  f7: 0xffc4, f8: 0xffc5, f9: 0xffc6, f10: 0xffc7, f11: 0xffc8, f12: 0xffc9,
  plus: 0x2b, minus: 0x2d, comma: 0x2c, period: 0x2e, slash: 0x2f,
  // xdotool-style names used by Anthropic's computer-use tools. Optimized by Claude
  super_l: CMD, super_r: CMD, meta_l: CMD, cmd_l: CMD,
  page_up: 0xff55, page_down: 0xff56, prior: 0xff55, next: 0xff56,
  kp_enter: 0xff0d, insert: 0xff63,
  equal: 0x3d, semicolon: 0x3b, apostrophe: 0x27, grave: 0x60, backslash: 0x5c,
  bracketleft: 0x5b, bracketright: 0x5d,
};

// shifted keys mapped to their unshifted key.
const SHIFTED: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
  "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\",
  ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};

function charKeysym(ch: string): number {
  const cp = ch.codePointAt(0)!;
  return cp < 0x100 ? cp : 0x01000000 + cp;
}

export function parseCombo(combo: string): number[] {
  return combo
    .toLowerCase()
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      if (part in NAMED) return NAMED[part];
      if ([...part].length === 1) return charKeysym(part);
      throw new Error(`Unknown key "${part}"`);
    });
}

/** Keystrokes for literal text: [keysym, needsShift][]. */
export function textKeys(text: string): Array<[number, boolean]> {
  const out: Array<[number, boolean]> = [];
  for (const ch of text) {
    if (ch === "\n") {
      out.push([NAMED.return, false]);
    }else if (ch === "\t") {
      out.push([NAMED.tab, false]);
    }
    else if (ch >= "A" && ch <= "Z") {
      out.push([charKeysym(ch.toLowerCase()), true]);
    } else if (ch in SHIFTED) {
      out.push([charKeysym(SHIFTED[ch]), true]);
    } else {
      out.push([charKeysym(ch), false]);
    }
  }
  return out;
}

