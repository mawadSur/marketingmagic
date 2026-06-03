// Build the app icon set from a square source PNG using sharp (already a dep).
//
// Usage: node scripts/build-icons.mjs <source.png>
//
// The Gemini source is 1024² with the "mm" mark centered with wide margins.
// We crop to a centered square that tightens onto the mark (keeps the dark
// background as the icon field, since theme_color is #0a0a0a), then emit:
//   public/icon.png        512²  (manifest + Next metadata icon)
//   public/apple-icon.png  180²  (iOS home-screen)
//   public/favicon-32.png   32²
//   public/favicon-16.png   16²
// favicon.ico is generated separately (sharp can't write multi-res .ico).

import sharp from "sharp";

const src = process.argv[2] || "public/logo-source.png";
const BG = { r: 10, g: 10, b: 10, alpha: 1 }; // #0a0a0a

const meta = await sharp(src).metadata();
const side = Math.min(meta.width, meta.height);
// Tighten the frame: take the centered 78% box so the mark fills more of the
// icon than the generous source padding, without clipping the letterforms.
const crop = Math.round(side * 0.78);
const left = Math.round((meta.width - crop) / 2);
const top = Math.round((meta.height - crop) / 2);

const base = sharp(src)
  .extract({ left, top, width: crop, height: crop })
  .flatten({ background: BG });

const targets = [
  { out: "public/icon.png", size: 512 },
  { out: "public/apple-icon.png", size: 180 },
  { out: "public/favicon-32.png", size: 32 },
  { out: "public/favicon-16.png", size: 16 },
];

for (const t of targets) {
  await base
    .clone()
    .resize(t.size, t.size, { fit: "cover", background: BG })
    .png()
    .toFile(t.out);
  console.log(`✓ ${t.out} (${t.size}²)`);
}
