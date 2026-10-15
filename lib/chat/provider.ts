import type { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ChatMessage, Persona } from "@/lib/db/schema";
import { SYSTEM_PROMPTS } from "./prompts";
import { scriptedReply, simulateTokenStream } from "./scripted";
import {
  GetProductInput,
  getProduct,
  SearchCatalogInput,
  searchCatalog,
  SummarizeStoreSalesInput,
  summarizeStoreSales,
  TOOL_DESCRIPTIONS,
  type ToolContext,
} from "./tools";

export interface ChatRequest {
  persona: Persona;
  messages: Pick<ChatMessage, "role" | "content">[];
  context: ToolContext;
  /** Called when the model stops without a usable answer: a refusal or a truncated tool call. */
  onIncomplete?: (reason: "refusal" | "truncated") => void;
  /** Called with the tool's name each time the model runs one of its tools. */
  onToolUse?: (toolName: string) => void;
}

export interface ChatProvider {
  readonly name: "claude" | "scripted";
  readonly model: string;
  stream(request: ChatRequest): AsyncIterable<string>;
}

const MODEL = "claude-opus-5-5";

/** Runs a tool and tells the caller it was used, whether or not the run succeeds. */
function reporting<Input>(
  name: string,
  onToolUse: ChatRequest["onToolUse"],
  run: (input: Input) => Promise<unknown>,
): (input: Input) => Promise<string> {
  return async (input) => {
    onToolUse?.(name);
    return JSON.stringify(await run(input));
  };
}

function buildTools(persona: Persona, context: ToolContext, onToolUse: ChatRequest["onToolUse"]) {
  const shopperTools = [
    {
      ...betaZodTool({
        name: "search_catalog",
        description: TOOL_DESCRIPTIONS.search_catalog,
        inputSchema: SearchCatalogInput,
        run: reporting("search_catalog", onToolUse, searchCatalog),
      }),
      eager_input_streaming: true,
    },
    {
      ...betaZodTool({
        name: "get_product",
        description: TOOL_DESCRIPTIONS.get_product,
        inputSchema: GetProductInput,
        run: reporting("get_product", onToolUse, getProduct),
      }),
      eager_input_streaming: true,
    },
  ];
  if (persona === "shopper") return shopperTools;
  return [
    ...shopperTools,
    {
      ...betaZodTool({
        name: "summarize_store_sales",
        description: TOOL_DESCRIPTIONS.summarize_store_sales,
        inputSchema: SummarizeStoreSalesInput,
        run: reporting(
          "summarize_store_sales",
          onToolUse,
          (input: z.infer<typeof SummarizeStoreSalesInput>) => summarizeStoreSales(input, context),
        ),
      }),
      eager_input_streaming: true,
    },
  ];
}

/**
 * An API key that is not scoped to a workspace must name the workspace on every request; set
 * ANTHROPIC_WORKSPACE_ID for those keys. Workspace-scoped keys need nothing extra.
 */
export function createAnthropicClient(workspaceId = process.env.ANTHROPIC_WORKSPACE_ID): Anthropic {
  return new Anthropic(
    workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {},
  );
}

export function createClaudeProvider(client: Anthropic = createAnthropicClient()): ChatProvider {
  return {
    name: "claude",
    model: MODEL,
    async *stream({ persona, messages, context, onIncomplete, onToolUse }) {
      const runner = client.beta.messages.toolRunner({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPTS[persona],
        output_config: { effort: "low" },
        tools: buildTools(persona, context, onToolUse),
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
      });

      for await (const messageStream of runner) {
        for await (const event of messageStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield event.delta.text;
          }
        }
        const message = await messageStream.finalMessage();
        if (message.stop_reason === "refusal") {
          onIncomplete?.("refusal");
          yield "\n\nI can't help with that one, but I'm glad to talk plants or sales.";
          return;
        }
        if (
          message.stop_reason === "max_tokens" &&
          message.content.some((block) => block.type === "tool_use")
        ) {
          onIncomplete?.("truncated");
          yield "\n\nThat answer ran long; try asking a narrower question.";
          return;
        }
      }
    },
  };
}

export function createScriptedProvider(delayMs = 18): ChatProvider {
  return {
    name: "scripted",
    model: "scripted",
    async *stream({ persona, messages, context }) {
      const last = [...messages].reverse().find((message) => message.role === "user");
      const reply = await scriptedReply(persona, last?.content ?? "", context);
      yield* simulateTokenStream(reply, delayMs);
    },
  };
}

/** Claude when a key is configured, scripted replies otherwise so the demo costs nothing. */
export function getChatProvider(): ChatProvider {
  return process.env.ANTHROPIC_API_KEY ? createClaudeProvider() : createScriptedProvider();
}
