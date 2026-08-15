import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildGenerationInput, describeProviderError, generatePost, normalizeGeneratedPost } from "../src/llm.js";

test("normalizeGeneratedPost cleans title and tags", () => {
  const result = normalizeGeneratedPost({
    title: "一".repeat(25),
    content: "真实正文",
    tags: ["#收纳", "收纳", " 租房 "],
    imageQueries: ["organized desk", "workspace", "small apartment"]
  });
  assert.equal([...result.title].length, 20);
  assert.deepEqual(result.tags, ["收纳", "租房"]);
});

test("buildGenerationInput rejects an empty topic", () => {
  assert.throws(() => buildGenerationInput({ topic: " " }), /填写选题/);
});

test("generatePost reports a missing API key before calling the network", async () => {
  await assert.rejects(() => generatePost({ topic: "桌面收纳" }, {}), /OPENAI_API_KEY/);
});

test("generatePost preserves an empty-topic validation error", async () => {
  await assert.rejects(
    () => generatePost({ topic: " " }, { OPENAI_API_KEY: "test-key" }),
    (error) => error.name === "ValidationError" && /填写选题/.test(error.message)
  );
});

test("describeProviderError turns provider statuses into actionable messages", () => {
  assert.match(describeProviderError({ status: 401 }), /密钥无效/);
  assert.match(describeProviderError({ status: 429 }), /额度不足/);
  assert.match(describeProviderError({ status: 404 }), /OPENAI_MODEL/);
  assert.match(describeProviderError({ status: 502 }), /中转站暂时异常/);
});

test("generatePost sends a Responses API JSON schema request", async () => {
  let requestBody;
  const fakeApi = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const generated = JSON.stringify({ title: "低预算桌面收纳", content: "先根据桌面尺寸划分常用区和低频区，再选择尺寸匹配的收纳件。购买前量好宽度和高度，避免只看图片判断。最后保留一块空白区域，日常整理会更轻松。", tags: ["桌面收纳", "租房", "低预算"], imageQueries: ["organized desk", "workspace", "small apartment"] });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_test", object: "response", status: "completed", model: "test-model",
      output: [{ id: "msg_test", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: generated, annotations: [], logprobs: [] }] }]
    }));
  });
  await new Promise((resolve) => fakeApi.listen(0, "127.0.0.1", resolve));
  try {
    const address = fakeApi.address();
    const result = await generatePost({ topic: "桌面收纳" }, {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "test-model",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`
    });
    assert.equal(result.title, "低预算桌面收纳");
    assert.equal(requestBody.model, "test-model");
    assert.equal(requestBody.text.format.type, "json_schema");
    assert.ok(requestBody.text.format.schema.required.includes("imageQueries"));
    assert.equal(requestBody.store, false);
  } finally {
    await new Promise((resolve) => fakeApi.close(resolve));
  }
});
