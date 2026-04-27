import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from './logger.js';

export const HAIKU_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export function makeClient(apiKey) {
  return new Anthropic({
    apiKey,
    maxRetries: 3
  });
}

const RankClipsSchema = z.object({
  clips: z.array(z.object({
    startCueId: z.number().int(),
    endCueId: z.number().int(),
    title: z.string().min(1).max(120),
    draftCaption: z.string().min(1).max(800),
    reason: z.string().min(1).max(400)
  })).min(0).max(20)
});

const SegmentTool = {
  name: 'submit_picks',
  description: 'Return the ranked clip selections from the candidates.',
  input_schema: {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            startCueId:    { type: 'integer' },
            endCueId:      { type: 'integer' },
            title:         { type: 'string', description: 'Short hook-y title for the clip (≤80 chars).' },
            draftCaption:  { type: 'string', description: 'A first-draft social caption (one short paragraph).' },
            reason:        { type: 'string', description: 'One sentence explaining why this segment was picked.' }
          },
          required: ['startCueId', 'endCueId', 'title', 'draftCaption', 'reason']
        }
      }
    },
    required: ['clips']
  }
};

export async function rankSegments(client, { systemPrompt, candidates, targetCount }) {
  const userMessage =
    `Pick the best ${targetCount} clips from these candidates. ` +
    `Each entry below is "[startCueId-endCueId] (start_ms-end_ms): text".\n\n` +
    candidates.map((c) =>
      `[${c.startCueId}-${c.endCueId}] (${c.start_ms}-${c.end_ms}ms): ${c.text}`
    ).join('\n');

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 2048,
    system: [{
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' }
    }],
    tools: [SegmentTool],
    tool_choice: { type: 'tool', name: 'submit_picks' },
    messages: [{ role: 'user', content: userMessage }]
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) {
    logger.warn({ stop_reason: response.stop_reason }, 'Claude did not call the segment tool');
    throw new Error('Claude did not return a tool_use block; cannot extract clip picks');
  }

  const parsed = RankClipsSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(`Claude tool output failed validation: ${parsed.error.message}`);
  }

  return {
    clips: parsed.data.clips,
    usage: response.usage
  };
}

const CaptionTool = {
  name: 'submit_caption',
  description: 'Return final caption variants and hashtags for a published clip.',
  input_schema: {
    type: 'object',
    properties: {
      ig:       { type: 'string', description: 'Instagram caption (≤2200 chars). One short paragraph, hook first.' },
      li:       { type: 'string', description: 'LinkedIn caption (≤1300 chars). Slightly more professional tone.' },
      hashtags: {
        type: 'array',
        items: { type: 'string', pattern: '^#?[A-Za-z0-9_]+$' },
        minItems: 5,
        maxItems: 8,
        description: '5-8 hashtags, with or without the leading #.'
      }
    },
    required: ['ig', 'li', 'hashtags']
  }
};

const FinalCaptionSchema = z.object({
  ig: z.string().min(1).max(2200),
  li: z.string().min(1).max(1300),
  hashtags: z.array(z.string()).min(5).max(8)
});

export async function draftFinalCaption(client, { systemPrompt, title, transcript }) {
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    system: [{
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' }
    }],
    tools: [CaptionTool],
    tool_choice: { type: 'tool', name: 'submit_caption' },
    messages: [{
      role: 'user',
      content:
        `Title: ${title || '(no title)'}\n\nTranscript:\n${transcript}\n\n` +
        `Write IG + LinkedIn caption variants and 5–8 hashtags for this clip.`
    }]
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a caption tool_use block');

  const parsed = FinalCaptionSchema.safeParse(toolUse.input);
  if (!parsed.success) throw new Error(`caption output failed validation: ${parsed.error.message}`);

  const hashtags = parsed.data.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`));

  return {
    ig: parsed.data.ig,
    li: parsed.data.li,
    hashtags,
    usage: response.usage
  };
}
