// Discord embed + interactive-component builders.
//
// Two shapes here:
//   1. buildDigestMessage — one summary embed for the daily digest, with
//      a button row that links back to the queue. Channel stays quiet.
//   2. buildPostEmbed — per-post embed with approve / edit / reject buttons.
//      Used both inside digest threads and for realtime fan-out.
//
// Discord limits worth remembering (we trim defensively, never assume):
//   - embed.title: 256 chars
//   - embed.description: 4096 chars
//   - embed.field.value: 1024 chars
//   - button.label: 80 chars
//   - components per action row: 5
//   - total length across all embeds in a message: 6000 chars

import type {
  DiscordActionRow,
  DiscordEmbed,
  DiscordMessagePayload,
} from "@/lib/integrations/discord";
import { signCustomId } from "@/lib/integrations/sign";

// Channel-specific accent colors. Use the same hue family the email digest
// uses so the brand reads as one product across transports.
const CHANNEL_COLORS: Record<string, number> = {
  x: 0x0f172a,
  instagram: 0xdb2777,
  facebook: 0x1d4ed8,
  threads: 0x111827,
  bluesky: 0x0284c7,
  linkedin: 0x0a66c2,
};
const PENDING_COLOR = 0x2563eb; // blue, same as digest CTA
const NEUTRAL_COLOR = 0x64748b; // slate-500

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

export interface DigestPostSummary {
  id: string;
  channel: string;
  theme: string | null;
  text: string;
  scheduledAt: string | null;
}

export interface BuildDigestArgs {
  workspaceName: string;
  posts: DigestPostSummary[];
  totalPending: number;
  queueUrl: string;
}

export function buildDigestMessage(args: BuildDigestArgs): DiscordMessagePayload {
  const { workspaceName, posts, totalPending, queueUrl } = args;
  // Up to 5 lines in the description — anything more is just noise; the
  // "view all" CTA covers the long tail.
  const PREVIEW_LINES = 5;
  const lines = posts.slice(0, PREVIEW_LINES).map((p) => {
    const snippet = truncate(p.text.replace(/\s+/g, " "), 80);
    const channel = p.channel.toUpperCase();
    return `• \`${channel}\` ${snippet}`;
  });
  const overflow =
    totalPending > posts.length
      ? `\n\n_+${totalPending - posts.length} more in the queue._`
      : posts.length > PREVIEW_LINES
        ? `\n\n_+${posts.length - PREVIEW_LINES} more above._`
        : "";

  const embed: DiscordEmbed = {
    title: `${totalPending} post${totalPending === 1 ? "" : "s"} awaiting approval`,
    description: truncate(lines.join("\n") + overflow, 4000),
    color: PENDING_COLOR,
    footer: { text: `marketingmagic · ${workspaceName}` },
    timestamp: new Date().toISOString(),
  };

  const row: DiscordActionRow = {
    type: 1,
    components: [
      {
        type: 2,
        style: 5, // link
        label: "Open queue",
        url: queueUrl,
      },
    ],
  };

  return { embeds: [embed], components: [row] };
}

export interface BuildPostEmbedArgs {
  post: DigestPostSummary;
  workspaceName: string;
  linkSecret: string;
}

// Build a per-post embed + 3-button row (Approve / Edit / Reject). Used by
// the realtime path and the digest "drill in" thread. Custom IDs are signed
// with EMAIL_LINK_SECRET so the action handler can verify without a DB
// round-trip for the auth itself.
export function buildPostEmbed(args: BuildPostEmbedArgs): DiscordMessagePayload {
  const { post, workspaceName, linkSecret } = args;

  const embed: DiscordEmbed = {
    title: truncate(`${post.channel.toUpperCase()} · pending approval`, 256),
    description: truncate(post.text, 3900),
    color: CHANNEL_COLORS[post.channel] ?? PENDING_COLOR,
    footer: { text: `marketingmagic · ${workspaceName}` },
    timestamp: new Date().toISOString(),
    fields: [],
  };

  if (post.theme) {
    embed.fields!.push({ name: "Theme", value: truncate(post.theme, 256), inline: true });
  }
  if (post.scheduledAt) {
    const d = new Date(post.scheduledAt);
    if (!Number.isNaN(d.getTime())) {
      // Discord renders ISO-like dates poorly; use unix-relative timestamp.
      const unix = Math.floor(d.getTime() / 1000);
      embed.fields!.push({ name: "Scheduled", value: `<t:${unix}:F>`, inline: true });
    }
  }
  if (embed.fields!.length === 0) delete embed.fields;

  const row: DiscordActionRow = {
    type: 1,
    components: [
      {
        type: 2,
        style: 3, // success / green
        label: "Approve",
        custom_id: signCustomId("approve", post.id, linkSecret),
      },
      {
        type: 2,
        style: 2, // secondary
        label: "Edit",
        custom_id: signCustomId("edit", post.id, linkSecret),
      },
      {
        type: 2,
        style: 4, // danger / red
        label: "Reject",
        custom_id: signCustomId("reject", post.id, linkSecret),
      },
    ],
  };

  return { embeds: [embed], components: [row] };
}

// Used by the action handler to render the "after action" state of the
// message: drop the buttons, add a status field. Reusable for approve/reject
// — the caller passes the verb.
export interface BuildActionedEmbedArgs {
  original: DigestPostSummary;
  workspaceName: string;
  verb: "Approved" | "Rejected" | "Updated";
  actor: string; // Discord username/display
}

export function buildActionedEmbed(args: BuildActionedEmbedArgs): DiscordMessagePayload {
  const { original, workspaceName, verb, actor } = args;
  const color = verb === "Approved" ? 0x16a34a : verb === "Rejected" ? 0xdc2626 : NEUTRAL_COLOR;
  const embed: DiscordEmbed = {
    title: truncate(`${original.channel.toUpperCase()} · ${verb.toLowerCase()}`, 256),
    description: truncate(original.text, 3900),
    color,
    footer: { text: `marketingmagic · ${workspaceName}` },
    timestamp: new Date().toISOString(),
    fields: [
      {
        name: verb === "Updated" ? "Edited by" : verb === "Approved" ? "Approved by" : "Rejected by",
        value: truncate(actor, 256),
        inline: true,
      },
    ],
  };
  // No components — clears the buttons.
  return { embeds: [embed], components: [] };
}
