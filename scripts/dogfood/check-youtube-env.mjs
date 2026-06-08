// Check if YouTube OAuth env vars are configured
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const youtubeClientId = process.env.YOUTUBE_CLIENT_ID;
const youtubeClientSecret = process.env.YOUTUBE_CLIENT_SECRET;

console.log("YouTube OAuth Configuration Check:");
console.log("==================================");
console.log(`YOUTUBE_CLIENT_ID: ${youtubeClientId ? "SET (" + youtubeClientId.substring(0, 10) + "...)" : "NOT SET"}`);
console.log(`YOUTUBE_CLIENT_SECRET: ${youtubeClientSecret ? "SET (" + youtubeClientSecret.substring(0, 10) + "...)" : "NOT SET"}`);
console.log("");
console.log(`YouTube tile visible: ${Boolean(youtubeClientId && youtubeClientSecret)}`);
