// Phase 6.10 — server-side helper that fetches per-post hashtag
// suggestions in a single batched query and hands them to the client
// HashtagPillRow component.
//
// Why server-side: the recommender hits hashtag_usage; doing one fetch
// per post would explode round-trips on a queue with N posts. We batch
// by collecting the unique channels in view, fetching once per channel,
// and passing the per-channel slice into each pill row.

import type { ChannelId } from "@/lib/channels/registry";
import { recommendHashtags } from "@/lib/hashtags/recommend";
import { extractHashtags } from "@/lib/hashtags/extract";
import { getChannelHashtagPolicy } from "@/lib/hashtags/rules";
import { HashtagPillRow } from "@/components/hashtag-pill-row";

interface Props {
  workspaceId: string;
  postId: string;
  channel: string;
  text: string;
}

// Render-time entry — keeps the client surface minimal. Bluesky drops
// straight to "no chips" rendering (see HashtagPillRow), and channels
// without a connected suggestion-fetch path render an empty chip row
// so the user can still hand-add tags.
export async function HashtagSuggestionsServer({ workspaceId, postId, channel, text }: Props) {
  // Channel-narrowing: anything outside the registry just falls back to
  // showing no chips — better than throwing on a stale legacy row.
  const validChannels: ReadonlyArray<ChannelId> = [
    "x",
    "linkedin",
    "threads",
    "instagram",
    "bluesky",
  ];
  if (!validChannels.includes(channel as ChannelId)) return null;
  const ch = channel as ChannelId;
  const policy = getChannelHashtagPolicy(ch);
  if (!policy.showChips && policy.recommendedCount[1] === 0) {
    return (
      <HashtagPillRow
        postId={postId}
        channel={ch}
        suggestions={[]}
        initialTags={[]}
      />
    );
  }

  const initialTags = extractHashtags(text);
  const suggestions = await recommendHashtags(workspaceId, ch, { draftText: text });
  return (
    <HashtagPillRow
      postId={postId}
      channel={ch}
      suggestions={suggestions}
      initialTags={initialTags}
    />
  );
}
