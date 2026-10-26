import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSSELine,
  createChunkDelta,
  transformUpstreamChunk,
  formatSSEChunk,
  SSE_DONE_MESSAGE,
  aggregateResponsesSSE,
} from "../../src/proxy/stream-transformer.js";

describe("stream-transformer", () => {
  it("parses data lines and DONE marker correctly", () => {
    assert.equal(parseSSELine("data: [DONE]"), "[DONE]");
    assert.equal(parseSSELine(": ping"), null);
    assert.equal(parseSSELine(""), null);

    const parsed = parseSSELine('data: {"id":"chk_1","choices":[{"delta":{"content":"Hi"}}]}');
    assert.ok(parsed && typeof parsed === "object");
    assert.equal(parsed["id"], "chk_1");
  });

  it("creates compliant OpenAI chunk delta with reasoning content", () => {
    const chunk = createChunkDelta({
      id: "cmpl_1",
      model: "gpt-6-astra",
      content: "Hello",
      reasoningContent: "Thinking deeply",
    });

    assert.equal(chunk.id, "cmpl_1");
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.equal(chunk.model, "gpt-6-astra");
    assert.equal(chunk.choices[0]?.delta.content, "Hello");
    assert.equal(chunk.choices[0]?.delta.reasoning_content, "Thinking deeply");
  });

  it("transforms upstream chunk extracting both content and reasoning", () => {
    const upstream = {
      id: "raw_1",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "Response word",
            reasoning_content: "Internal chain of thought",
          },
          finish_reason: null,
        },
      ],
    };

    const transformed = transformUpstreamChunk(upstream, "gpt-6-astra");
    assert.ok(transformed);
    assert.equal(transformed.choices[0]?.delta.content, "Response word");
    assert.equal(transformed.choices[0]?.delta.reasoning_content, "Internal chain of thought");
  });

  it("formats SSE string according to spec", () => {
    const chunk = createChunkDelta({
      id: "cmpl_2",
      model: "gpt-6-astra",
      content: "World",
    });

    const sse = formatSSEChunk(chunk);
    assert.ok(sse.startsWith("data: {"));
    assert.ok(sse.endsWith("\n\n"));
    assert.equal(SSE_DONE_MESSAGE, "data: [DONE]\n\n");
  });

  it("aggregates the current OmniRush Responses SSE format", () => {
    const raw = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-6-astra"}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":" world"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-6-astra","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
    ].join("\n");

    const result = aggregateResponsesSSE(raw, "gpt-6-astra");
    assert.equal(result.id, "resp_1");
    assert.equal(result.content, "Hello world");
    assert.deepEqual(result.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  });
});
