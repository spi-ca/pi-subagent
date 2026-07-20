import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  PROVIDER_API_KEY_ENV_VAR_MAP,
  getProviderApiKeyEnvVar,
  resolveInheritedCliApiKeyEnvBinding,
} from "../../src/core/provider-auth";

describe("documented provider API-key environment mapping", () => {
  test("covers every Pi 0.80.10 built-in API-key provider", () => {
    assert.deepEqual(PROVIDER_API_KEY_ENV_VAR_MAP, {
      "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
      "ant-ling": "ANT_LING_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      "azure-openai-responses": "AZURE_OPENAI_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
      "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      fireworks: "FIREWORKS_API_KEY",
      google: "GEMINI_API_KEY",
      groq: "GROQ_API_KEY",
      huggingface: "HF_TOKEN",
      "kimi-coding": "KIMI_API_KEY",
      minimax: "MINIMAX_API_KEY",
      "minimax-cn": "MINIMAX_CN_API_KEY",
      mistral: "MISTRAL_API_KEY",
      nvidia: "NVIDIA_API_KEY",
      opencode: "OPENCODE_API_KEY",
      "opencode-go": "OPENCODE_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      radius: "RADIUS_API_KEY",
      together: "TOGETHER_API_KEY",
      "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
      xai: "XAI_API_KEY",
      xiaomi: "XIAOMI_API_KEY",
      "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
      "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
      "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
      zai: "ZAI_API_KEY",
      "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
    });
  });

  test("maps Bedrock and Radius inherited CLI keys without placing them on argv", () => {
    assert.equal(getProviderApiKeyEnvVar("Amazon-Bedrock"), "AWS_BEARER_TOKEN_BEDROCK");
    assert.equal(getProviderApiKeyEnvVar("radius"), "RADIUS_API_KEY");
    assert.deepEqual(resolveInheritedCliApiKeyEnvBinding({
      apiKey: "bedrock-secret",
      provider: "amazon-bedrock",
    }), {
      state: "resolved",
      binding: { name: "AWS_BEARER_TOKEN_BEDROCK", value: "bedrock-secret", provider: "amazon-bedrock" },
    });
  });
});
