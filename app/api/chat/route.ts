import { auth } from "@/auth";
import { isMerchant } from "@/lib/auth/callbacks";
import {
  CONVERSATION_HEADER,
  ChatRequestSchema,
  encodeStreamMeta,
  MESSAGE_HEADER,
  MODEL_HEADER,
  PROVIDER_HEADER,
} from "@/lib/chat/conversation";
import { getChatProvider } from "@/lib/chat/provider";
import { db } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import type { ChatMessage, Conversation } from "@/lib/db/schema";
import { sessionIdentity, trackServerEvent } from "@/lib/pendo.server";
import { getRecordSource } from "@/lib/request-source";

export async function POST(request: Request): Promise<Response> {
  const parsed = ChatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid chat request." }, { status: 400 });
  const { conversationId, persona, messages } = parsed.data;

  const session = await auth();
  const storeId =
    persona === "merchant" && isMerchant(session?.user?.role) ? session?.store?.id : undefined;
  if (persona === "merchant" && !storeId) {
    return Response.json(
      { error: "Sign in to a store to use the merchant assistant." },
      { status: 403 },
    );
  }

  const now = new Date().toISOString();
  const existing = conversationId ? await db.conversations.getById(conversationId) : undefined;
  const ownsExisting =
    existing &&
    existing.persona === persona &&
    (existing.userId ? existing.userId === session?.user?.id : true);

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return Response.json({ error: "Send a message first." }, { status: 400 });

  const userMessage: ChatMessage = {
    id: lastUser.id ?? newId("msg"),
    role: "user",
    content: lastUser.content,
    createdAt: now,
  };
  const assistantId = newId("msg");

  const conversation: Conversation =
    ownsExisting && existing
      ? { ...existing, messages: [...existing.messages, userMessage] }
      : {
          id: newId("conv"),
          persona,
          userId: session?.user?.id,
          storeId,
          messages: messages
            .slice(0, -1)
            .map((message) => ({
              id: message.id ?? newId("msg"),
              role: message.role,
              content: message.content,
              createdAt: now,
            }))
            .concat(userMessage),
          ratings: [],
          source: await getRecordSource(),
          createdAt: now,
        };
  await db.conversations.save(conversation);

  const provider = getChatProvider();
  const encoder = new TextEncoder();
  let reply = "";
  const toolsUsed = new Set<string>();
  // Failures below reach the shopper as an ordinary apology, so they are reported from here.
  const reportFailure = (errorType: "provider_error" | "refusal" | "truncated") =>
    trackServerEvent("Assistant Response Failed", sessionIdentity(session), {
      persona,
      conversationId: conversation.id,
      errorType,
      provider: provider.name,
    });

  // The client may navigate away mid-reply; keep streaming state so the full reply is still stored.
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (chunk: string) => {
        reply += chunk;
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      try {
        for await (const chunk of provider.stream({
          persona,
          messages: conversation.messages.map(({ role, content }) => ({ role, content })),
          context: { storeId },
          onIncomplete: reportFailure,
          onToolUse: (toolName) => toolsUsed.add(toolName),
        })) {
          push(chunk);
        }
      } catch (error) {
        console.error("chat provider failed", error);
        reportFailure("provider_error");
        push("Sorry, I lost my train of thought. Try that again in a moment.");
      } finally {
        const latest = (await db.conversations.getById(conversation.id)) ?? conversation;
        await db.conversations.save({
          ...latest,
          messages: [
            ...latest.messages,
            {
              id: assistantId,
              role: "assistant",
              content: reply,
              createdAt: new Date().toISOString(),
            },
          ],
        });
        if (!closed) {
          closed = true;
          // Not part of the stored reply; the client reads it to report which tools were used.
          if (toolsUsed.size > 0) {
            controller.enqueue(encoder.encode(encodeStreamMeta({ toolsUsed: [...toolsUsed] })));
          }
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      [CONVERSATION_HEADER]: conversation.id,
      [MESSAGE_HEADER]: assistantId,
      [MODEL_HEADER]: provider.model,
      [PROVIDER_HEADER]: provider.name,
    },
  });
}
