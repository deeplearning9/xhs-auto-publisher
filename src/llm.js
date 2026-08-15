import OpenAI from "openai";
import { ExternalServiceError, ValidationError } from "./errors.js";

const POST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 20 },
    content: { type: "string", minLength: 80, maxLength: 1000 },
    tags: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 12 }
    },
    imageQueries: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string", minLength: 2, maxLength: 60 }
    }
  },
  required: ["title", "content", "tags", "imageQueries"]
};

function clean(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function normalizeGeneratedPost(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("模型返回的内容不是对象");
  }
  const title = [...String(value.title ?? "").trim()].slice(0, 20).join("");
  const content = String(value.content ?? "").trim();
  const tags = Array.isArray(value.tags)
    ? [...new Set(value.tags.map((tag) => clean(tag, 12).replace(/^#+/, "")).filter(Boolean))].slice(0, 6)
    : [];
  const imageQueries = Array.isArray(value.imageQueries)
    ? [...new Set(value.imageQueries.map((query) => clean(query, 60)).filter(Boolean))].slice(0, 3)
    : [];
  if (!title || !content || tags.length < 1 || imageQueries.length < 1) {
    throw new ValidationError("模型返回缺少标题、正文、标签或图片搜索词");
  }
  return { title, content: content.slice(0, 1000), tags, imageQueries };
}

export function buildGenerationInput(input) {
  const topic = clean(input.topic, 300);
  if (!topic) throw new ValidationError("请先填写选题或产品信息");
  return [
    `选题：${topic}`,
    `目标读者：${clean(input.audience || "普通小红书用户", 120)}`,
    `表达风格：${clean(input.tone || "自然、真诚、有信息量", 120)}`,
    `必须包含的事实：${clean(input.keyPoints || "无额外信息", 800)}`,
    `是否允许少量表情：${input.useEmoji === false ? "否" : "是"}`
  ].join("\n");
}

export function describeProviderError(error) {
  const status = Number(error?.status);
  if (status === 401) return "LLM API 密钥无效（401）。请在 .env 中填写中转站生成的有效密钥，然后重启程序";
  if (status === 403) return "LLM API 拒绝访问（403）。请检查密钥权限、账户状态和模型授权";
  if (status === 404) return "LLM 接口或模型不存在（404）。请检查 OPENAI_BASE_URL 和 OPENAI_MODEL";
  if (status === 429) return "LLM API 额度不足或请求过于频繁（429）。请检查中转站余额和限额";
  if (status === 400) return "LLM 请求不兼容（400）。当前功能需要中转站支持 OpenAI Responses API 和 JSON Schema";
  if (status >= 500) return `LLM 中转站暂时异常（${status}）。配置本身正常，请稍后点击按钮重试`;
  if (error?.name === "APIConnectionTimeoutError" || error?.code === "ETIMEDOUT") {
    return "LLM 请求超时。请检查中转站网络状态后重试";
  }
  if (error?.name === "APIConnectionError") return "无法连接 LLM 服务。请检查 OPENAI_BASE_URL 和网络连接";
  return `LLM 服务连接意外中断${status ? `（${status}）` : ""}。请稍后点击按钮重试`;
}

export async function generatePost(input, env = process.env) {
  if (!env.OPENAI_API_KEY) {
    throw new ValidationError("尚未配置 OPENAI_API_KEY，请复制 .env.example 为 .env 并填写密钥");
  }
  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL || undefined,
    timeout: 60_000,
    maxRetries: 2
  });
  const model = env.OPENAI_MODEL || "gpt-5.6-luna";
  const generationInput = buildGenerationInput(input);
  let response;
  try {
    response = await client.responses.create({
      model,
      max_output_tokens: 1200,
      store: false,
      reasoning: { effort: "low" },
      instructions: [
        "你是中文小红书内容编辑。生成可由用户继续修改的图文笔记草稿。",
        "只使用用户明确提供的事实，不得编造亲身体验、销量、功效、测评数据或权威背书。",
        "标题不超过20个字符；正文自然分段，避免夸张营销和违禁承诺；标签不要带#号。",
        "同时给出3个适合开放图库检索的英文关键词；每个关键词只写1个具体、宽泛的英文名词，例如 desk、workspace、apartment，避免形容词和品牌名。",
        "如果信息不足，用中性表达，不要补造具体事实。"
      ].join("\n"),
      input: generationInput,
      text: {
        format: {
          type: "json_schema",
          name: "xiaohongshu_post",
          description: "A Chinese Xiaohongshu image-note draft",
          strict: true,
          schema: POST_SCHEMA
        }
      }
    });
  } catch (error) {
    throw new ExternalServiceError(describeProviderError(error), { cause: error });
  }
  if (!response.output_text) throw new ValidationError("模型没有返回可用内容");
  let parsed;
  try {
    parsed = JSON.parse(response.output_text);
  } catch (error) {
    throw new ValidationError("模型返回的 JSON 无法解析", { cause: error });
  }
  return { ...normalizeGeneratedPost(parsed), model };
}
