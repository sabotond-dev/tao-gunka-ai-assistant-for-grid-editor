// Converts the user's greyscale Tao Gunka trace into a theme-aware
// icon: white tonal ramp by default (dark UIs), black ramp under
// prefers-color-scheme: light. Depth layering is preserved by mapping
// each grey to its own class.
const fs = require("fs");

const SRC = "C:\\Users\\sabot\\Downloads\\taogunka.svg";
const OUT = "C:\\Users\\sabot\\Documents\\Claude\\grid-agent-package\\";

let svg = fs.readFileSync(SRC, "utf8");

const fills = [...new Set(svg.match(/fill="#[0-9a-fA-F]{6}"/g))].map((f) =>
  f.slice(6, 13),
);
// Sort dark to light for stable class order.
fills.sort((a, b) => parseInt(a.slice(1), 16) - parseInt(b.slice(1), 16));

const toHex = (v) =>
  "#" + Math.round(v).toString(16).padStart(2, "0").repeat(3);
const lum = (hex) => parseInt(hex.slice(1, 3), 16);

// The editor shows icons via <img>, which can see neither
// currentColor nor the editor's theme attribute, and the OS
// prefers-color-scheme disagrees with the editor whenever the user
// mixes themes (hardware-verified: light Windows + dark editor chose
// the black ramp). So: hard white ramp with a soft dark drop shadow,
// legible on any background, no theme detection.
let style = "";
fills.forEach((hex, i) => {
  const L = lum(hex);
  const white = toHex(255 - (255 - L) * 0.45);
  style += `.c${i}{fill:${white}}`;
  svg = svg.split(`fill="${hex}"`).join(`class="c${i}"`);
});

svg = svg
  .replace(/<title[\s\S]*?<\/title>/, "<title>Tao Gunka</title>")
  .replace(/<desc[\s\S]*?<\/desc>/, "")
  .replace(/aria-labelledby="title desc"/, 'aria-labelledby="title"')
  .replace(/<svg /, `<svg width="100%" height="100%" `)
  .replace(
    /(<title>Tao Gunka<\/title>)/,
    `$1<style>${style}</style>` +
      `<defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%">` +
      `<feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="#000" flood-opacity="0.55"/>` +
      `</filter></defs>`,
  )
  .replace(/<g fill-rule/, `<g filter="url(#sh)" fill-rule`);

fs.writeFileSync(OUT + "tao-gunka-logo.svg", svg);
fs.writeFileSync(OUT + "tao-gunka-menu.svg", svg);
console.log(
  "fills:",
  fills.join(" "),
  "| out bytes:",
  svg.length,
);
