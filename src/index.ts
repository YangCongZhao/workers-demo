import { createSchema, createYoga } from "graphql-yoga";

export interface Env {
	DEEPSEEK_API_KEY: 'sk-b786a32011e942eaab323966dbb29d47';
}

// DeepSeek API 请求体的接口定义
interface DeepSeekMessage {
	role: "user" | "assistant";
	content: string;
}

interface DeepSeekRequest {
	model: string;
	messages: DeepSeekMessage[];
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
}

interface DeepSeekResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: {
		index: number;
		message: DeepSeekMessage;
		finish_reason: string;
	}[];
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

// 验证输入参数
function validateInput(data: {
	prompt: string;
	systemPrompt?: string;
	model?: string;
	temperature?: number;
	max_tokens?: number;
}): { isValid: boolean; error?: string } {
	if (!data.prompt || typeof data.prompt !== "string" || data.prompt.trim().length === 0) {
		return { isValid: false, error: "Prompt 是必填项，且不能为空字符串" };
	}
	if (data.systemPrompt && typeof data.systemPrompt !== "string") {
		return { isValid: false, error: "SystemPrompt 必须是字符串" };
	}
	if (data.model && typeof data.model !== "string") {
		return { isValid: false, error: "Model 必须是字符串" };
	}
	if (data.temperature && (typeof data.temperature !== "number" || data.temperature < 0 || data.temperature > 2)) {
		return { isValid: false, error: "Temperature 必须在 0 到 2 之间" };
	}
	if (data.max_tokens && (typeof data.max_tokens !== "number" || data.max_tokens < 1 || data.max_tokens > 4000)) {
		return { isValid: false, error: "Max_tokens 必须在 1 到 4000 之间" };
	}
	return { isValid: true };
}

// 构建 DeepSeek 请求消息
function buildMessages(prompt: string, systemPrompt?: string): DeepSeekMessage[] {
	const messages: DeepSeekMessage[] = [];
	if (systemPrompt) {
		messages.push({ role: "user", content: systemPrompt });
		messages.push({ role: "assistant", content: "我明白了，我会按照你的要求进行回答。" });
	}
	messages.push({ role: "user", content: prompt });
	return messages;
}

// 调用 DeepSeek API 的核心逻辑
async function callDeepSeekApi(
	requestBody: DeepSeekRequest,
	apiKey: string
): Promise<Response> {
	try {
		const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`DeepSeek API 请求失败: ${response.status} ${response.statusText} - ${errorText}`);
		}

		return response;
	} catch (error) {
		console.error("调用 DeepSeek API 时出错:", error);
		throw error;
	}
}

// GraphQL 类型定义和解析器
const yoga = createYoga<Env>({
	schema: createSchema({
		typeDefs: /* GraphQL */ `
      type DeepSeekCompletion {
        id: String!
        text: String!
        promptTokens: Int!
        completionTokens: Int!
        totalTokens: Int!
      }
      type Query {
        chatCompletion(prompt: String!, systemPrompt: String): DeepSeekCompletion
      }
    `,
		resolvers: {
			Query: {
				chatCompletion: async (_parent, { prompt, systemPrompt }, context) => {
					const apiKey = context.env.DEEPSEEK_API_KEY;
					if (!apiKey) {
						throw new Error("缺少 DeepSeek API 密钥");
					}

					const validation = validateInput({ prompt, systemPrompt });
					if (!validation.isValid) {
						throw new Error(validation.error);
					}

					const requestBody: DeepSeekRequest = {
						model: "deepseek-chat",
						messages: buildMessages(prompt, systemPrompt),
						temperature: 0.7,
						max_tokens: 2000,
					};

					const response = await callDeepSeekApi(requestBody, apiKey);
					const data = (await response.json()) as DeepSeekResponse;

					return {
						id: data.id,
						text: data.choices[0].message.content,
						promptTokens: data.usage.prompt_tokens,
						completionTokens: data.usage.completion_tokens,
						totalTokens: data.usage.total_tokens,
					};
				},
			},
		},
	}),
});

// 处理 DeepSeek 请求（非流式和流式共用逻辑）
async function handleDeepSeekRequest(
	request: Request,
	env: Env,
	isStream: boolean
): Promise<Response> {
	try {
		const data = (await request.json()) as {
			prompt: string;
			systemPrompt?: string;
			model?: string;
			temperature?: number;
			max_tokens?: number;
		};

		const {
			prompt,
			systemPrompt,
			model = "deepseek-chat",
			temperature = 0.7,
			max_tokens = 2000,
		} = data;

		const validation = validateInput({ prompt, systemPrompt, model, temperature, max_tokens });
		if (!validation.isValid) {
			return new Response(JSON.stringify({ error: validation.error }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		const apiKey = env.DEEPSEEK_API_KEY;
		if (!apiKey) {
			return new Response(JSON.stringify({ error: "缺少 DeepSeek API 密钥" }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}

		const requestBody: DeepSeekRequest = {
			model,
			messages: buildMessages(prompt, systemPrompt),
			temperature,
			max_tokens,
			stream: isStream,
		};

		const deepseekResponse = await callDeepSeekApi(requestBody, apiKey);

		if (isStream) {
			return new Response(deepseekResponse.body, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
				},
			});
		}

		const responseData = await deepseekResponse.json();
		return new Response(JSON.stringify(responseData), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (error) {
		console.error(`处理${isStream ? "流式" : "非流式"}请求时出错:`, error);
		return new Response(
			JSON.stringify({ error: `处理请求时出错: ${(error as Error).message}` }),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			}
		);
	}
}

// 处理 CORS
function handleCors(request: Request): Response | null {
	if (request.method === "OPTIONS") {
		return new Response(null, {
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
				"Access-Control-Max-Age": "86400",
			},
		});
	}
	return null;
}

// 添加 CORS 头
function addCorsHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// 主函数，处理所有请求
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const corsResponse = handleCors(request);
		if (corsResponse) {
			return corsResponse;
		}

		const url = new URL(request.url);
		const path = url.pathname;

		if (path === "/ai/chat") {
			return addCorsHeaders(await handleDeepSeekRequest(request, env, false));
		}

		if (path === "/ai/chat/stream") {
			return addCorsHeaders(await handleDeepSeekRequest(request, env, true));
		}

		return addCorsHeaders(await yoga.fetch(request, env));
	},
};
