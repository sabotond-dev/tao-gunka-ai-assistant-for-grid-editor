// Generates the Tao Gunka pixel-art icons: a 16x16 stone-idol sprite
// (winged head, glowing eyes) rendered as real pixel rects.
const fs = require("fs");
const OUT = "C:\\Users\\sabot\\Documents\\Claude\\grid-agent-package\\";

// Drawn from the actual sprite reference: egg-shaped bone head, pink
// coral bumps on the crown, two ring eyes, and the signature wide
// grin - dark green mouth with blocky teeth, sitting low and a touch
// left.
const SPRITE = [
  "................",
  ".....OPRRO......",
  "...ORPRPRPRO....",
  "..ORPRORPRPRRO..",
  "..OPRPBSBBPRPO..",
  ".KBBKKKBBKKKBBK.",
  ".KBBKEKBBKEKBBK.",
  ".KBBKKKBBKKKBBK.",
  ".KSBBBBSSBBBBSK.",
  ".KSKGGGGGGGKSBK.",
  ".KSKTTMTTMTKSBK.",
  ".KSKMMMMMMMKSBK.",
  "..KSKGGGGGKSBK..",
  "..KSSBBBBBBSSK..",
  "...KKSSSSSSKK...",
  "................",
];

const COLORS = {
  K: "#3A332C", // outline, dark warm stone
  B: "#E9E2CE", // bone
  S: "#C2B8A0", // bone shade
  R: "#D96C63", // coral bump
  P: "#F0A79B", // coral highlight
  O: "#8A4A42", // coral outline
  G: "#4E7D52", // mouth rim green
  M: "#22392B", // mouth interior
  T: "#F5F1E4", // teeth
  E: "#17130F", // eye socket
};

// Menu icon: theme-tracking. Solid currentColor silhouette (white in
// dark mode, black in light mode); eyes, mouth interior and outlines
// are punched-out holes, teeth stay solid so the grin reads.
const MONO = {
  K: null,
  O: null,
  E: null,
  M: null,
  B: "currentColor",
  S: "currentColor",
  R: "currentColor",
  P: "currentColor",
  G: "currentColor",
  T: "currentColor",
};

function rects(cell, mono) {
  const out = [];
  SPRITE.forEach((row, y) => {
    // Merge horizontal runs of the same color into single rects.
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      if (c === ".") {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w] === c) w++;
      if (mono) {
        if (MONO[c]) {
          out.push(
            `<rect x="${x * cell}" y="${y * cell}" width="${w * cell}" height="${cell}" fill="${MONO[c]}"/>`,
          );
        }
      } else {
        out.push(
          `<rect x="${x * cell}" y="${y * cell}" width="${w * cell}" height="${cell}" fill="${COLORS[c]}"/>`,
        );
      }
      x += w;
    }
  });
  return out.join("\n  ");
}

const logo = `<svg width="100%" height="100%" viewBox="0 0 48 48" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="1" width="46" height="46" rx="8" fill="#0E1F1A"/>
  ${rects(3, false)}
</svg>
`;

const menu = `<svg width="100%" height="100%" viewBox="0 0 16 16" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
  ${rects(1, true)}
</svg>
`;

fs.writeFileSync(OUT + "tao-gunka-logo.svg", logo);
fs.writeFileSync(OUT + "tao-gunka-menu.svg", menu);
console.log("logo bytes:", logo.length, "| menu bytes:", menu.length);
