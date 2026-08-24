import type { TokenStore } from "./token-store.js";
import { parseCloudCodeError } from "./errors.js";
import { StreamTransport } from "../common/stream-transport.js";

export class CloudCodeTransport {
	private streamTransport: StreamTransport;

	constructor(
		private host: string,
		private userAgent: string,
		private clientMetadata: string,
		private tokenStore: TokenStore,
	) {
		this.streamTransport = new StreamTransport({
			host: this.host,
			inactivityTimeoutMs: 45_000,
			requestTimeoutMs: 25_000,
			maxRetries: 2,
		});
		void this.streamTransport.warmConnection();
	}

	public headers(accessToken: string): Record<string, string> {
		return {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": this.userAgent,
			"Client-Metadata": this.clientMetadata,
			Connection: "keep-alive",
		};
	}

	public async loadProjectId(accessToken: string, parentSignal?: AbortSignal): Promise<string> {
		const cached = this.tokenStore.getCachedProjectId();
		if (cached) return cached;

		const { signal, cleanup } = this.streamTransport.createTimeoutSignal(15_000, parentSignal);
		try {
			const response = await fetch(`${this.host}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: this.headers(accessToken),
				body: "{}",
				signal,
			});

			if (!response.ok) {
				throw new Error(`loadCodeAssist failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
			}

			const payload = (await response.json()) as {
				cloudaicompanionProject?: string | { id?: string; name?: string; projectNumber?: string };
			};

			const project = typeof payload.cloudaicompanionProject === "string"
				? payload.cloudaicompanionProject
				: (payload.cloudaicompanionProject?.id || payload.cloudaicompanionProject?.name || payload.cloudaicompanionProject?.projectNumber);

			if (!project) {
				throw new Error("loadCodeAssist did not return a Cloud Code project id.");
			}

			this.tokenStore.setCachedProjectId(project);
			return project;
		} finally {
			cleanup();
		}
	}

	public async postWithRetry(
		path: string,
		accessToken: string,
		body: unknown,
		signal?: AbortSignal,
		attempt = 0,
	): Promise<Response> {
		const targetPath = `/v1internal:${path}`;
		const reqHeaders = this.headers(accessToken);

		const response = await this.streamTransport.postWithRetry(targetPath, reqHeaders, body, {
			signal,
			attempt,
			on401Retry: async () => {
				this.tokenStore.invalidateProjectId();
				this.tokenStore.invalidateToken();
				const freshToken = await this.tokenStore.getAccessToken();
				return this.headers(freshToken);
			},
		});

		if (response.status === 429) {
			const quotaBody = await response.text();
			const quota = parseCloudCodeError(quotaBody);
			if (quota.exhausted || !quota.retryable) {
				return new Response(quotaBody, { status: 429, headers: response.headers });
			}
			if (attempt < 2) {
				const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 5000);
				await new Promise((resolve) => setTimeout(resolve, delay));
				return this.postWithRetry(path, accessToken, body, signal, attempt + 1);
			}
			return new Response(quotaBody, { status: 429, headers: response.headers });
		}

		return response;
	}

	public async *readSse(response: Response, signal?: AbortSignal, inactivityTimeoutMs = 45_000): AsyncGenerator<unknown> {
		yield* this.streamTransport.readSse(response, signal, inactivityTimeoutMs);
	}
}
