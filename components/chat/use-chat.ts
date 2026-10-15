"use client";

import { useCallback, useRef, useState } from "react";
import {
  CONVERSATION_HEADER,
  MESSAGE_HEADER,
  MODEL_HEADER,
  PROVIDER_HEADER,
  splitStreamMeta,
} from "@/lib/chat/conversation";
import { SUGGESTED_PROMPTS } from "@/lib/chat/prompts";
import type { Persona } from "@/lib/db/schema";
import { pendo } from "@/lib/pendo";

export type ChatStatus = "idle" | "streaming" | "error";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  rating?: "up" | "down";
  failed?: boolean;
}

/** How a message reached the assistant. */
interface SendOrigin {
  inputMethod: "typed" | "suggestion" | "retry";
  suggestionIndex?: number;
}

/** Product links in a reply: the bare `/products/{slug}` paths the panel turns into links. */
const PRODUCT_LINK = /\/products\/[a-z0-9-]+/g;

/** Agent id each persona's assistant is reported under in conversation analytics. */
const AGENT_IDS: Record<Persona, string> = {
  shopper: "qYoUvIRmEpbwmljGvkMkCEPrbDw",
  merchant: "bgDRE-DIBkzhrYlalmQHO9L7Uqg",
};

function localId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** How many user messages a history holds, i.e. which turn of the conversation it is. */
function turnNumber(history: UiMessage[]): number {
  return history.filter((message) => message.role === "user").length;
}

function retriedAfter(message: UiMessage): string {
  if (message.failed) return "failed";
  return message.rating ? `rated_${message.rating}` : "unrated";
}

export function useChat(persona: Persona) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ChatStatus>("idle");
  const conversationId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);

  const send = useCallback(
    async (history: UiMessage[], origin: SendOrigin) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setStatus("streaming");
      const pendingId = localId("pending");
      setMessages([...history, { id: pendingId, role: "assistant", content: "" }]);
      const startedAt = Date.now();
      const isNewConversation = !conversationId.current;
      const question = [...history].reverse().find((message) => message.role === "user");
      let response: Response | undefined;

      try {
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationId.current,
            persona,
            messages: history.map(({ id, role, content }) => ({ id, role, content })),
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(`Chat request failed (${response.status})`);

        conversationId.current =
          response.headers.get(CONVERSATION_HEADER) ?? conversationId.current;
        const assistantId = response.headers.get(MESSAGE_HEADER) ?? pendingId;
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingId ? { ...message, id: assistantId } : message,
          ),
        );

        if (question && conversationId.current && origin.inputMethod !== "retry") {
          pendo.trackAgent("prompt", {
            agentId: AGENT_IDS[persona],
            conversationId: conversationId.current,
            messageId: question.id,
            content: question.content,
            suggestedPrompt: origin.inputMethod === "suggestion",
          });
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          const snapshot = splitStreamMeta(text).content;
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId ? { ...message, content: snapshot } : message,
            ),
          );
        }
        setStatus("idle");
        const { content: replyText, meta } = splitStreamMeta(text);
        if (conversationId.current) {
          pendo.trackAgent("agent_response", {
            agentId: AGENT_IDS[persona],
            conversationId: conversationId.current,
            messageId: assistantId,
            content: replyText,
            modelUsed: response.headers.get(MODEL_HEADER) ?? undefined,
            toolsUsed: meta?.toolsUsed,
          });
        }
        pendo.track("Assistant Message Sent", {
          persona,
          conversationId: conversationId.current,
          isNewConversation,
          turnNumber: turnNumber(history),
          inputMethod: origin.inputMethod,
          suggestionIndex: origin.suggestionIndex,
          messageLength: question?.content.length,
          provider: response.headers.get(PROVIDER_HEADER) ?? undefined,
          responseTimeMs: Date.now() - startedAt,
          responseLength: replyText.length,
          productLinkCount: replyText.match(PRODUCT_LINK)?.length ?? 0,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error(error);
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingId || (message.role === "assistant" && message.content === "")
              ? { ...message, content: "Something went wrong. Try again?", failed: true }
              : message,
          ),
        );
        setStatus("error");
        pendo.track("Assistant Response Failed", {
          persona,
          conversationId: conversationId.current,
          httpStatus: response?.status,
          errorType: !response
            ? "network_error"
            : response.ok
              ? "stream_interrupted"
              : "http_error",
          provider: response?.headers.get(PROVIDER_HEADER) ?? undefined,
          inputMethod: origin.inputMethod,
        });
      }
    },
    [persona],
  );

  const submit = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim();
      if (!content || status === "streaming") return;
      setInput("");
      const history = [...messages, { id: localId("msg"), role: "user" as const, content }];
      const suggestionIndex = text === undefined ? -1 : SUGGESTED_PROMPTS[persona].indexOf(text);
      await send(history, {
        inputMethod: text === undefined ? "typed" : "suggestion",
        suggestionIndex: suggestionIndex === -1 ? undefined : suggestionIndex,
      });
    },
    [input, messages, persona, send, status],
  );

  const retry = useCallback(
    async (messageId: string) => {
      const index = messages.findIndex((message) => message.id === messageId);
      if (index === -1) return;
      const history = messages.slice(0, index).filter((message) => !message.failed);
      if (!history.some((message) => message.role === "user")) return;
      if (conversationId.current && !messages[index].failed) {
        pendo.trackAgent("user_reaction", {
          agentId: AGENT_IDS[persona],
          conversationId: conversationId.current,
          messageId,
          content: "retry",
        });
      }
      pendo.track("Assistant Response Retried", {
        persona,
        conversationId: conversationId.current,
        messageId,
        retriedAfter: retriedAfter(messages[index]),
        turnNumber: turnNumber(history),
      });
      await send(history, { inputMethod: "retry" });
    },
    [messages, persona, send],
  );

  const rate = useCallback(
    async (messageId: string, value: "up" | "down") => {
      if (!conversationId.current) return;
      const index = messages.findIndex((message) => message.id === messageId);
      const previousRating = messages[index]?.rating;
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, rating: value } : message,
        ),
      );
      // Clicking the rating a reply already has changes nothing, so it isn't reported again.
      if (index !== -1 && previousRating !== value) {
        if (!messages[index].failed) {
          pendo.trackAgent("user_reaction", {
            agentId: AGENT_IDS[persona],
            conversationId: conversationId.current,
            messageId,
            content: value === "up" ? "positive" : "negative",
          });
        }
        pendo.track("Assistant Response Rated", {
          persona,
          conversationId: conversationId.current,
          messageId,
          rating: value,
          previousRating: previousRating ?? "none",
          turnNumber: turnNumber(messages.slice(0, index)),
        });
      }
      await fetch("/api/chat/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conversationId.current, messageId, value }),
      }).catch((error) => console.error(error));
    },
    [messages, persona],
  );

  return { messages, input, setInput, status, submit, rate, retry };
}
