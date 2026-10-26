import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCompletionRequest,
  normalizeCompletionResponse,
} from "../../src/proxy/normalizer.js";
import type { ChatCompletionRequest } from "../../src/types/openai.js";

describe("normalizer", () => {
  it("normalizes OpenAI request with model alias and reasoning effort", () => {
    const rawReq: ChatCompletionRequest = {
      model: "astra",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello world" },
      ],
      stream: true,
      reasoning_effort: "high",
    };

    const normalized = normalizeCompletionRequest(rawReq);
    assert.equal(normalized.model, "gpt-6-astra");
    assert.equal(normalized.stream, true);
    assert.equal(normalized.input.length, 2);
    assert.deepEqual(normalized.input[1], {
      role: "user",
      content: [{ type: "input_text", text: "Hello world" }],
    });
    assert.equal(normalized.store, false);
    assert.deepEqual(normalized.reasoning, { effort: "high", summary: "auto" });
    assert.deepEqual(normalized.include, ["reasoning.encrypted_content"]);
  });

  it("assigns default medium reasoning effort to reasoning models if not specified", () => {
    const rawReq: ChatCompletionRequest = {
      model: "gpt-6-astra",
      messages: [{ role: "user", content: "Explain relativity." }],
    };

    const normalized = normalizeCompletionRequest(rawReq);
    assert.equal(normalized.reasoning?.effort, "medium");
  });

  it("normalizes upstream response into standard OpenAI ChatCompletionResponse", () => {
    const upstream = {
      id: "resp_12345",
      model: "gpt-6-astra",
      created: 1728000000,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! How can I help you?",
            reasoning_content: "Thought process...",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 25,
        total_tokens: 40,
      },
    };

    const normalized = normalizeCompletionResponse(upstream, "gpt-6-astra");
    assert.equal(normalized.id, "resp_12345");
    assert.equal(normalized.object, "chat.completion");
    assert.equal(normalized.choices[0]?.message.content, "Hello! How can I help you?");
    assert.equal(normalized.choices[0]?.message.reasoning_content, "Thought process...");
    assert.equal(normalized.usage?.total_tokens, 40);
  });
});
