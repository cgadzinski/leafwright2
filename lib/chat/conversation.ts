import { z } from "zod";
import { ChatRoleSchema, PersonaSchema } from "@/lib/db/schema";

export const ChatRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
  persona: PersonaSchema,
  messages: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        role: ChatRoleSchema,
        content: z.string().trim().min(1).max(4000),
      }),
    )
    .min(1)
    .max(40),
});
export type ChatRequestBody = z.infer<typeof ChatRequestSchema>;

export const FeedbackSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  value: z.enum(["up", "down"]),
});
export type FeedbackBody = z.infer<typeof FeedbackSchema>;

/** Response headers the client reads to map the streamed reply back to stored records. */
export const CONVERSATION_HEADER = "x-conversation-id";
export const MESSAGE_HEADER = "x-message-id";
/** Which provider answered: "claude" or "scripted". */
export const PROVIDER_HEADER = "x-assistant-provider";
/** Response header naming the model that wrote the reply. */
export const MODEL_HEADER = "x-assistant-model";

/**
 * The reply is plain text, so facts only known once it finishes (the tools that were used) follow
 * it after this record-separator character as a small JSON object. Readers split on it first.
 */
export const STREAM_META_MARKER = "\u001e";

export const StreamMetaSchema = z.object({ toolsUsed: z.array(z.string()) });
export type StreamMeta = z.infer<typeof StreamMetaSchema>;

export function encodeStreamMeta(meta: StreamMeta): string {
  return `${STREAM_META_MARKER}${JSON.stringify(meta)}`;
}

/** Separates the reply text from the trailing metadata, when the stream has delivered it yet. */
export function splitStreamMeta(raw: string): { content: string; meta?: StreamMeta } {
  const at = raw.indexOf(STREAM_META_MARKER);
  if (at === -1) return { content: raw };
  const content = raw.slice(0, at);
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(at + STREAM_META_MARKER.length));
  } catch {
    return { content };
  }
  const meta = StreamMetaSchema.safeParse(json);
  return meta.success ? { content, meta: meta.data } : { content };
}
