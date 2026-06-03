// One-shot logo generator via the Gemini image API (REST, no SDK).
//
// Usage:
//   GEMINI_API_KEY=... node scripts/gen-logo.mjs "<prompt>" <out.png>
//   (key is also read from .env.local GEMINI_API_KEY= if not in the env)
//
// Gemini's image model returns a base64 PNG in inlineData. We decode and write
// it. Model is overridable via GEMINI_IMAGE_MODEL for when Google rotates names.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  // Fall back to .env.local (gitignored) so the key never has to touch argv.
  if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  }
  return null;
}

const prompt = process.argv[2];
const outPath = process.argv[3] || "public/logo-source.png";
const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image-preview";

if (!prompt) {
  console.error("Missing prompt. Usage: node scripts/gen-logo.mjs \"<prompt>\" <out.png>");
  process.exit(2);
}
const key = loadKey();
if (!key) {
  console.error("No GEMINI_API_KEY in env or .env.local. Add it and re-run.");
  process.exit(2);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
const body = {
  contents: [{ parts: [{ text: prompt }] }],
  generationConfig: { responseModalities: ["IMAGE"] },
};

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

if (!res.ok) {
  const text = await res.text();
  console.error(`Gemini API error (${res.status}) on model "${model}":`);
  console.error(text.slice(0, 800));
  console.error("\nIf it's a 404/model error, retry with e.g. GEMINI_IMAGE_MODEL=gemini-2.0-flash-preview-image-generation");
  process.exit(1);
}

const json = await res.json();
const parts = json?.candidates?.[0]?.content?.parts ?? [];
const imgPart = parts.find((p) => p.inlineData?.data);
if (!imgPart) {
  console.error("No image returned. Full response head:");
  console.error(JSON.stringify(json).slice(0, 800));
  process.exit(1);
}
writeFileSync(outPath, Buffer.from(imgPart.inlineData.data, "base64"));
console.log(`Saved ${outPath} (${Math.round(Buffer.from(imgPart.inlineData.data, "base64").length / 1024)} KB, model ${model})`);
