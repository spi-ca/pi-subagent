import * as fs from "node:fs/promises";
import * as net from "node:net";

export interface FakeCmuxRequest { id: number; method: string; params: Record<string, unknown>; capability?: string; line: string; socket: net.Socket; }
export interface FakeCmuxServer { path: string; requests: FakeCmuxRequest[]; send(socket: net.Socket, value: unknown): void; close(): Promise<void>; }

/** Test-only UDS server that records the actual physical upstream request line. */
export async function fakeCmuxControlServer(socketPath: string, onRequest?: (request: FakeCmuxRequest, server: FakeCmuxServer) => void, onConnection?: (socket: net.Socket, server: FakeCmuxServer) => void): Promise<FakeCmuxServer> {
	await fs.mkdir((await import("node:path")).dirname(socketPath), { recursive: true, mode: 0o700 });
	await fs.rm(socketPath, { force: true });
	const requests: FakeCmuxRequest[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer();
	const api: FakeCmuxServer = {
		path: socketPath, requests,
		send(socket, value) { socket.write(`${JSON.stringify(value)}\n`); },
		async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(socketPath, { force: true }); },
	};
	server.on("connection", (socket) => {
		sockets.add(socket); socket.once("close", () => sockets.delete(socket));
		onConnection?.(socket, api);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
				try {
					const capabilityMatch = line.match(/^_cmux_capability_v1 ([^\s\0]+) (\{.*\})$/);
					const capability = capabilityMatch?.[1];
					const request = JSON.parse(capabilityMatch?.[2] ?? line) as Record<string, unknown>;
					if (typeof request.id !== "number" || typeof request.method !== "string" || !request.params || typeof request.params !== "object" || Array.isArray(request.params)) continue;
					const received: FakeCmuxRequest = { id: request.id, method: request.method, params: request.params as Record<string, unknown>, ...(capability === undefined ? {} : { capability }), line, socket };
					requests.push(received); onRequest?.(received, api);
				} catch { socket.destroy(); }
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });
	await fs.chmod(socketPath, 0o600);
	return api;
}
