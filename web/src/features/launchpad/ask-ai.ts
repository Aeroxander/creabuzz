/**
 * One question to the server's AI service (`/llm/chat/completions`, `api/llm_gateway.rs`): signed as the person asking,
 * so only members can use it and its cost lands on their metered budget. The model is the operator's (or a build's
 * `VITE_AGENT_MODEL`). Returns the reply's text, or throws a sentence saying what went wrong.
 */

import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

export async function askAi(system: string, user: string): Promise<string> {
  const url = `${relayHttpBaseUrl()}/llm/chat/completions`;
  const model = import.meta.env.VITE_AGENT_MODEL;
  const body = JSON.stringify({
    ...(model ? { model } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 2048,
  });
  const auth = await makeNip98AuthHeader(url, "POST", { body });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body,
  });
  if (response.status === 429)
    throw new Error(
      "The AI service is busy or your allowance is used up. Try again later, or write it yourself.",
    );
  if (!response.ok)
    throw new Error(
      "The AI service didn't answer. Write it yourself, or try again later.",
    );
  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content)
    throw new Error(
      "The AI service sent back nothing. Try again, or write it yourself.",
    );
  return content;
}
