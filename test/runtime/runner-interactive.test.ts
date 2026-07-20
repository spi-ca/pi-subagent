import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildBrokerEnvironment,
	buildTmuxSourcePaneProbeArgs,
	parseTmuxSourcePaneProbe,
	buildChildProcessEnv,
	buildInteractivePaneWrapperScript,
	buildInteractiveChildSessionJsonl,
	buildPrivateChildEnvironmentScript,
	buildInteractivePiArgs,
	buildInteractiveExtensionArgs,
	resolveCurrentPackageExtensionEntrypoint,
	applyChildProjectIsolation,
	closeInteractiveTarget,
	listActiveInteractiveRunIds,
	registerCommittedInteractiveRun,
	unregisterCommittedInteractiveRun,
	recoverInteractiveTarget,
	allocationMatchesInteractiveBackend,
	hasCommittedInteractiveLaunchAuthority,
	isPiVersionAtLeast,
	shouldRetainBrokerRecoveryMetadata,
	resolveBrokerRuntime,
	resolveBackendExecutable,
	resolveBackendPath,
	resolveRegularFile,
	resolveRuntimeInterpreter,
	beginInteractiveShutdownForSession,
	canStartInteractiveRun,
	getInteractiveShutdownGenerationForTest,
	resetInteractiveShutdownForSession,
	publishInteractiveLaunchGate,
	shutdownActiveInteractiveRuns,
} from "../../src/runtime/runner";
import { resolveInteractivePaneLayout } from "../../src/runtime/interactive-layout";
import {
	SUBAGENT_CHILD_SESSION_PATH_ENV,
	SUBAGENT_EXPECTED_PARENT_PID_ENV,
	SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
	SUBAGENT_PARENT_LEASE_PATH_ENV,
	SUBAGENT_RUN_COMPLETION_PATH_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_RUN_OWNERSHIP_ENV,
	SUBAGENT_RUN_STATE_PATH_ENV,
	prepareRunArtifactPaths,
	removeRunArtifacts,
} from "../../src/runtime/run-protocol";

const agent = {
	name: "reviewer",
	description: "Review code",
	tools: ["read", "grep"],
	model: "provider/model",
	thinking: "high",
	systemPrompt: "Review carefully",
	source: "user" as const,
	filePath: "/tmp/reviewer.md",
};

describe("interactive pane runner preparation", () => {
	test("resolves pane layout with CLI precedence and rejects invalid values", () => {
		assert.equal(resolveInteractivePaneLayout(undefined, {}), "auto");
		assert.equal(resolveInteractivePaneLayout(undefined, { PI_SUBAGENT_PANE_LAYOUT: "split" }), "split");
		assert.equal(resolveInteractivePaneLayout("auto", { PI_SUBAGENT_PANE_LAYOUT: "split" }), "auto");
		assert.throws(() => resolveInteractivePaneLayout("AUTO", {}), /--subagent-pane-layout/);
	});

	test("requires Pi 0.80.10 or newer for agent_settled", () => {
		assert.equal(isPiVersionAtLeast("0.80.9"), false);
		assert.equal(isPiVersionAtLeast("0.80.10"), true);
		assert.equal(isPiVersionAtLeast("0.81.0-beta.1"), true);
		assert.equal(isPiVersionAtLeast("unknown"), false);
	});

	test("builds interactive Pi args without JSON, print, or no-session flags", () => {
		const args = buildInteractivePiArgs(
			agent,
			"/tmp/run/system-prompt.md",
			"/tmp/run/task.md",
			"/tmp/run/child-session.jsonl",
		);
		assert.equal(args.includes("--mode"), false);
		assert.equal(args.includes("-p"), false);
		assert.equal(args.includes("--print"), false);
		assert.equal(args.includes("--no-session"), false);
		assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), [
			"--session", "/tmp/run/child-session.jsonl",
		]);
		assert.equal(args.filter((value) => value === resolveCurrentPackageExtensionEntrypoint()).length, 1);
		assert.equal(args.filter((value) => value === buildInteractiveExtensionArgs([]).at(-1)).length, 1);
		assert.equal(args.at(-1), "@/tmp/run/task.md");
	});

	test("adds the self extension when inheritance omits it", () => {
		const self = resolveCurrentPackageExtensionEntrypoint();
		const args = buildInteractiveExtensionArgs(["--extension", "/trusted/inherited.ts"]);
		assert.deepEqual(args.slice(0, 4), [
			"--extension", "/trusted/inherited.ts",
			"--extension", self,
		]);
		assert.equal(args[4], "--extension");
		assert.equal(args.filter((value) => value === self).length, 1);
		assert.equal(args.filter((value) => value.endsWith("child-bridge.ts")).length, 1);
	});

	test("deduplicates inherited self and child bridge extensions", () => {
		const self = resolveCurrentPackageExtensionEntrypoint();
		const bridge = buildInteractiveExtensionArgs([]).at(-1)!;
		const args = buildInteractiveExtensionArgs([
			"-e", pathToFileURL(self).href,
			"--extension", pathToFileURL(bridge).href,
			"--extension", self,
			"-e", bridge,
			"--extension", "/trusted/inherited.ts",
		]);
		assert.deepEqual(args, [
			"--extension", "/trusted/inherited.ts",
			"--extension", self,
			"--extension", bridge,
		]);
	});

	test("derives the package extension entrypoint from an installed-style runtime path", () => {
		const runtimeUrl = pathToFileURL("/opt/node_modules/@mjakl/pi-subagent/src/runtime/runner.ts").href;
		assert.equal(
			resolveCurrentPackageExtensionEntrypoint(runtimeUrl),
			"/opt/node_modules/@mjakl/pi-subagent/index.ts",
		);
	});

	test("strips child project controls even without a .pi directory or with .agents skills", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-no-pi-"));
		try {
			await fs.promises.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
			for (const cwd of [root, path.join(root, ".agents", "skills")]) {
				const args = ["--approve", "--context-file", "/tmp/foreign.md", "-nc"];
				applyChildProjectIsolation(args, cwd);
				assert.deepEqual(args, ["--no-context-files", "--no-approve"]);
			}
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("keeps child Pi project-unapproved even when an approved agent lives beside a malicious extension", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-project-"));
		try {
			await fs.promises.mkdir(path.join(root, ".pi", "agents"), { recursive: true });
			await fs.promises.mkdir(path.join(root, ".pi", "extensions"));
			await fs.promises.writeFile(path.join(root, ".pi", "extensions", "malicious.ts"), "throw new Error('must not load');\n");
			const args = ["--approve", "--context-files", "/tmp/foreign-context.md", "-nc", ...buildInteractivePiArgs(agent, null, "/tmp/task.md", "/tmp/child.jsonl")];
			applyChildProjectIsolation(args, root);
			assert.equal(args.includes("--approve"), false);
			assert.equal(args.includes("--context-files"), false);
			assert.equal(args.includes("-nc"), false);
			assert.equal(args.filter((arg) => arg === "--no-context-files").length, 1);
			assert.equal(args.filter((arg) => arg === "--no-approve").length, 1);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("creates a new child session header and retains fork branch entries", () => {
		const parent = [
			JSON.stringify({ type: "session", version: 3, id: "parent", cwd: "/old" }),
			JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "context" } }),
		].join("\n");
		const jsonl = buildInteractiveChildSessionJsonl({
			cwd: "/new",
			parentSessionFile: "/sessions/parent.jsonl",
			forkSessionSnapshotJsonl: parent,
			sessionId: "child",
		});
		const lines = jsonl.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(lines[0], {
			type: "session",
			version: 3,
			id: "child",
			timestamp: lines[0].timestamp,
			cwd: "/new",
			parentSession: "/sessions/parent.jsonl",
		});
		assert.equal(lines[1].id, "m1");
	});

	test("keeps the child TUI attached directly to the terminal", () => {
		const script = buildInteractivePaneWrapperScript({
			effectiveCwd: "/tmp/project",
			childCommand: ["pi", "--session", "/tmp/run/child-session.jsonl", "@/tmp/run/task.md"],
			exportedEnv: { [SUBAGENT_RUN_ID_ENV]: "run-id" },
			wrapperStatusPath: "/tmp/run/wrapper-status",
		});
		assert.match(script, /pi.*--session/);
		assert.equal(script.includes("pane-renderer"), false);
		assert.equal(script.includes(" | "), false);
		assert.equal(script.includes("Task: "), false);
		assert.match(script, /cd '\/tmp\/project' \|\| exit 1/);
		assert.match(script, /^#!\/bin\/bash/m);
		assert.match(script, /unset NODE_OPTIONS NODE_PATH BUN_OPTIONS/);
		assert.match(script, /trap finish_subagent_runtime EXIT/);
	});

	test("records wrapper failure and does not run the child when cwd is invalid", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wrapper-"));
		try {
			const envPath = path.join(root, "env.sh");
			const statusPath = path.join(root, "status");
			const markerPath = path.join(root, "child-ran");
			const wrapperPath = path.join(root, "wrapper.sh");
			await fs.promises.writeFile(envPath, "export PATH='/usr/bin:/bin'\nexport WRAPPER_TEST='ok'\n", { mode: 0o600 });
			await fs.promises.writeFile(wrapperPath, buildInteractivePaneWrapperScript({
				effectiveCwd: path.join(root, "missing"),
				childCommand: ["sh", "-c", `touch '${markerPath}'`],
				exportedEnv: {},
				secretEnvPath: envPath,
				wrapperStatusPath: statusPath,
			}), { mode: 0o700 });
			const exitCode = await new Promise<number>((resolve, reject) => {
				const child = spawn("bash", [wrapperPath], { stdio: "ignore" });
				child.once("error", reject);
				child.once("close", (code) => resolve(code ?? 1));
			});
			assert.notEqual(exitCode, 0);
			assert.equal(fs.existsSync(markerPath), false);
			assert.equal(fs.existsSync(envPath), false);
			assert.equal((await fs.promises.readFile(statusPath, "utf-8")).trim(), "1");
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("restores cmux, documented provider, and proxy authorities only from the private child environment script", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wrapper-"));
		try {
			const envPath = path.join(root, "env.sh"), statusPath = path.join(root, "status"), markerPath = path.join(root, "child-env"), wrapperPath = path.join(root, "wrapper.sh");
			await fs.promises.writeFile(envPath, buildPrivateChildEnvironmentScript({
				CMUX_SOCKET_PATH: "/private/socket", CMUX_SOCKET_CAPABILITY: "private-capability",
				CMUX_BUNDLED_CLI_PATH: "/private/cmux", OPENAI_API_KEY: "openai-secret", ANTHROPIC_API_KEY: "anthropic-secret",
				HTTPS_PROXY: "http://proxy", NO_PROXY: "localhost", ARBITRARY_CMUX_ENV: "blocked", UNRELATED_SECRET: "blocked",
			}), { mode: 0o600 });
			await fs.promises.writeFile(wrapperPath, buildInteractivePaneWrapperScript({
				effectiveCwd: root,
				childCommand: ["/bin/sh", "-c", `printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' "$CMUX_SOCKET_PATH" "$CMUX_SOCKET_CAPABILITY" "$CMUX_BUNDLED_CLI_PATH" "$CMUX_WORKSPACE_ID" "$CMUX_SURFACE_ID" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$HTTPS_PROXY" "$NO_PROXY" "\${UNRELATED_SECRET-unset}" > '${markerPath}'`],
				exportedEnv: {}, secretEnvPath: envPath, wrapperStatusPath: statusPath,
			}), { mode: 0o700 });
			const exitCode = await new Promise<number>((resolve, reject) => {
				const child = spawn("bash", [wrapperPath], { stdio: "ignore", env: { ...process.env, CMUX_WORKSPACE_ID: "dynamic-workspace", CMUX_SURFACE_ID: "dynamic-surface", ARBITRARY_CMUX_ENV: "inherited", UNRELATED_SECRET: "inherited" } });
				child.once("error", reject); child.once("close", (code) => resolve(code ?? 1));
			});
			assert.equal(exitCode, 0);
			assert.equal(await fs.promises.readFile(markerPath, "utf8"), "/private/socket|private-capability|/private/cmux|dynamic-workspace|dynamic-surface|openai-secret|anthropic-secret|http://proxy|localhost|unset");
			assert.equal(fs.existsSync(envPath), false);
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("resolves symlinked shebang runtimes from a user-controlled PATH", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-runtime-"));
		try {
			const bin = path.join(root, "bin"); await fs.promises.mkdir(bin, { mode: 0o700 });
			const target = path.join(bin, "runtime-target");
			const runtime = path.join(bin, "node");
			await fs.promises.writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			await fs.promises.symlink(target, runtime);
			assert.equal(resolveRegularFile(bin, true), null);
			assert.equal(resolveBrokerRuntime({ PATH: bin }), fs.realpathSync(target));
			assert.equal(resolveBrokerRuntime({ PATH: bin, PI_SUBAGENT_BROKER_RUNTIME: runtime }), fs.realpathSync(target));
			assert.equal(resolveBrokerRuntime({ PATH: bin, PI_SUBAGENT_BROKER_RUNTIME: "" }), fs.realpathSync(target));
			assert.equal(resolveRuntimeInterpreter(target, { PATH: bin }), fs.realpathSync("/bin/sh"));
			assert.equal(resolveRuntimeInterpreter(process.execPath, { PATH: bin }), fs.realpathSync(process.execPath));
			const envRuntime = path.join(bin, "env-runtime");
			await fs.promises.writeFile(envRuntime, "#!/usr/bin/env bun\n", { mode: 0o700 });
			const bunShim = path.join(bin, "bun");
			await fs.promises.symlink(process.execPath, bunShim);
			assert.equal(resolveRuntimeInterpreter(envRuntime, { PATH: bin }), fs.realpathSync(process.execPath));
			await fs.promises.unlink(bunShim);
			if (process.platform !== "win32") {
				await fs.promises.chmod(bin, 0o777);
				assert.equal(resolveBrokerRuntime({ PATH: bin }), fs.realpathSync(target));
			}
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("accepts project-local shebang and symlink backend shims selected by PATH", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-backend-"));
		try {
			const bin = path.join(root, "bin"); await fs.promises.mkdir(bin, { mode: 0o700 });
			const script = path.join(bin, "cmux-script");
			const backend = path.join(bin, "cmux");
			await fs.promises.writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			await fs.promises.symlink(script, backend);
			assert.equal(resolveBackendExecutable("cmux-pane", { PATH: bin }), fs.realpathSync(script));
			assert.equal(resolveBackendExecutable("cmux-pane", { PATH: bin, CMUX_BUNDLED_CLI_PATH: "" }), fs.realpathSync(script));
			assert.equal(resolveBackendExecutable("cmux-pane", { PATH: bin, CMUX_BUNDLED_CLI_PATH: backend }), fs.realpathSync(script));
			assert.equal(resolveBackendPath("cmux-pane", backend), fs.realpathSync(script));
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("spawns brokers with resolver PATH and only explicit backend identity environment", () => {
		const env = buildBrokerEnvironment({
			PATH: "/safe/bin", HOME: "/safe/home", TMPDIR: "/safe/tmp",
			CMUX_SOCKET_PATH: "/safe/cmux.sock", CMUX_SOCKET_CAPABILITY: "capability", CMUX_BUNDLED_CLI_PATH: "/safe/cmux",
			CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "surface",
			OPENAI_API_KEY: "secret", AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret", RADIUS_API_KEY: "radius-secret",
			AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com", CLOUDFLARE_ACCOUNT_ID: "account-id",
			GOOGLE_APPLICATION_CREDENTIALS: "/private/vertex.json", HTTPS_PROXY: "proxy", BASH_ENV: "/hook", ENV: "/hook",
		}, "cmux-pane");
		assert.deepEqual(env, { PATH: "/safe/bin", HOME: "/safe/home", TMPDIR: "/safe/tmp", TERM: "xterm-256color", CMUX_SOCKET_PATH: "/safe/cmux.sock", CMUX_SOCKET_CAPABILITY: "capability", CMUX_BUNDLED_CLI_PATH: "/safe/cmux", CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "surface" });
	});

	test("rejects opposite-mode committed launch authority before gate publication", () => {
		const tmuxAllocation = {
			version: 2 as const, runId: "run", terminalMode: "tmux-pane" as const,
			target: { paneId: "%1", serverPid: 1, panePid: 2 }, allocatedAt: 1,
		};
		assert.equal(allocationMatchesInteractiveBackend(tmuxAllocation, "cmux-pane"), false);
		assert.equal(allocationMatchesInteractiveBackend(tmuxAllocation, "tmux-pane"), true);
		const intent = {
			version: 2 as const, runId: "run", parentSessionId: "parent", parentPid: process.pid, parentStartedAt: 1, terminalMode: "cmux-pane" as const,
			source: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" },
			childSessionFile: "/tmp/run/child-session.jsonl", createdAt: 1, brokerNonce: "a".repeat(43),
			runtimePath: "/usr/bin/node", runtimeInterpreterPath: "/usr/bin/node", backendPath: "/usr/bin/cmux", brokerEntrypoint: "/tmp/broker.mjs",
		};
		const allocation = {
			version: 2 as const, runId: "run", terminalMode: "cmux-pane" as const,
			target: { workspaceId: intent.source.workspaceId, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1,
		};
		const decision = { version: 2 as const, runId: "run", kind: "commit" as const, decidedAt: 1, allocationPath: "/tmp/run/allocation.json", launchPath: "/tmp/run/launch.json" };
		const launch = { version: 2 as const, runId: "run", terminalMode: "tmux-pane" as const, allocationPath: decision.allocationPath, childSessionFile: intent.childSessionFile, committedAt: 1, ownership: "parent-owned" as const };
		assert.equal(hasCommittedInteractiveLaunchAuthority({ intent, allocation, decision, launch, gate: null, mode: "cmux-pane" }), false);
		assert.equal(hasCommittedInteractiveLaunchAuthority({ intent, allocation, decision, launch: { ...launch, terminalMode: "cmux-pane" }, gate: null, mode: "cmux-pane" }), true);
	});

	test("uses a runtime tab delimiter when probing the parent tmux pane", () => {
		assert.deepEqual(buildTmuxSourcePaneProbeArgs("/tmp/tmux"), ["-S", "/tmp/tmux", "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]);
		assert.equal(buildTmuxSourcePaneProbeArgs().at(-1)?.includes("\\t"), false);
		assert.equal(parseTmuxSourcePaneProbe("%2\t123\n%3\t456\n", "%3"), 456);
		for (const output of ["%3\\t456\n", "%2\t123\n%2\t124\n", "%2\tbad\n%3\t456\n", "%2\t123\textra\n"]) {
			assert.equal(parseTmuxSourcePaneProbe(output, "%3"), null);
		}
	});

	test("retains recovery metadata for tri-state authority uncertainty and unconfirmed allocations", () => {
		const missing = { outcome: "missing" } as const;
		const validAllocation = { outcome: "valid", value: { version: 2, runId: "r", terminalMode: "tmux-pane", target: { paneId: "%1", serverPid: 1, panePid: 2 }, allocatedAt: 1 } } as const;
		assert.equal(shouldRetainBrokerRecoveryMetadata({ runId: "r", runDir: "/tmp/r", targetConfirmedAbsent: false, status: missing, decision: missing, allocation: validAllocation }), true);
		assert.equal(shouldRetainBrokerRecoveryMetadata({ runId: "r", runDir: "/tmp/r", targetConfirmedAbsent: true, status: missing, decision: missing, allocation: validAllocation }), false);
		assert.equal(shouldRetainBrokerRecoveryMetadata({ runId: "r", runDir: "/tmp/r", targetConfirmedAbsent: true, status: { outcome: "valid", value: { version: 2, runId: "r", writer: "broker", pid: 1, phase: "failed", updatedAt: 1, errorCode: "possible-unrecorded-allocation" } }, decision: missing, allocation: missing }), true);
		assert.equal(shouldRetainBrokerRecoveryMetadata({ runId: "r", runDir: "/tmp/r", targetConfirmedAbsent: true, status: { outcome: "invalid" }, decision: missing, allocation: missing }), true);
	});

	test("serializes documented provider auth and configuration privately without overriding pane identity", () => {
		const script = buildPrivateChildEnvironmentScript({
			OPENAI_API_KEY: "secret'key",
			ANTHROPIC_API_KEY: "anthropic-secret",
			AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
			RADIUS_API_KEY: "radius-secret",
			AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com",
			AZURE_OPENAI_RESOURCE_NAME: "resource",
			AZURE_OPENAI_API_VERSION: "2024-02-01",
			AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4=deployment",
			CLOUDFLARE_ACCOUNT_ID: "account-id",
			CLOUDFLARE_GATEWAY_ID: "gateway-id",
			AWS_PROFILE: "bedrock-profile",
			AWS_ACCESS_KEY_ID: "access-key",
			AWS_SECRET_ACCESS_KEY: "secret-key",
			AWS_SESSION_TOKEN: "session-token",
			AWS_REGION: "us-west-2",
			AWS_DEFAULT_REGION: "us-east-1",
			AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/credentials",
			AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/token",
			AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/irsa-token",
			AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/irsa",
			AWS_BEDROCK_FORCE_CACHE: "1",
			AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://bedrock-proxy.example",
			AWS_BEDROCK_SKIP_AUTH: "1",
			AWS_BEDROCK_FORCE_HTTP1: "1",
			GOOGLE_CLOUD_PROJECT: "vertex-project",
			GOOGLE_CLOUD_LOCATION: "us-central1",
			GOOGLE_APPLICATION_CREDENTIALS: "/private/vertex.json",
			PI_CACHE_RETENTION: "long",
			HTTPS_PROXY: "http://proxy",
			no_proxy: "localhost,127.0.0.1",
			SSL_CERT_DIR: "/private/certs",
			PI_CODING_AGENT_DIR: "/tmp/agent",
			TMUX: "/tmp/tmux/default,1,0",
			TMUX_PANE: "%1",
			CMUX_SURFACE_ID: "surface",
			CMUX_SOCKET_PATH: "/private/cmux.sock",
			CMUX_SOCKET_CAPABILITY: "private-capability",
			CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
			[SUBAGENT_EXPECTED_PARENT_PID_ENV]: "123",
			[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV]: "456",
			ARBITRARY_CMUX_ENV: "must-not-pass",
			UNRELATED_SECRET: "must-not-pass",
			PWD: "/wrong",
		});
		assert.match(script, /export OPENAI_API_KEY='secret'"'"'key'/);
		assert.match(script, /export ANTHROPIC_API_KEY='anthropic-secret'/);
		assert.match(script, /export AWS_BEARER_TOKEN_BEDROCK='bedrock-secret'/);
		assert.match(script, /export RADIUS_API_KEY='radius-secret'/);
		for (const [name, value] of Object.entries({
			AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com", AZURE_OPENAI_RESOURCE_NAME: "resource",
			AZURE_OPENAI_API_VERSION: "2024-02-01", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4=deployment",
			CLOUDFLARE_ACCOUNT_ID: "account-id", CLOUDFLARE_GATEWAY_ID: "gateway-id",
			AWS_PROFILE: "bedrock-profile", AWS_ACCESS_KEY_ID: "access-key", AWS_SECRET_ACCESS_KEY: "secret-key", AWS_SESSION_TOKEN: "session-token",
			AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-east-1", AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/credentials",
			AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/token", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/irsa-token",
			AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/irsa", AWS_BEDROCK_FORCE_CACHE: "1",
			AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://bedrock-proxy.example", AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1",
			GOOGLE_CLOUD_PROJECT: "vertex-project", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: "/private/vertex.json", PI_CACHE_RETENTION: "long",
		})) assert.ok(script.includes(`export ${name}='${value}'`));
		assert.match(script, /export HTTPS_PROXY='http:\/\/proxy'/);
		assert.match(script, /export no_proxy='localhost,127\.0\.0\.1'/);
		assert.match(script, /export SSL_CERT_DIR='\/private\/certs'/);
		assert.match(script, /export PI_CODING_AGENT_DIR='\/tmp\/agent'/);
		assert.equal(script.includes("TMUX="), false);
		assert.equal(script.includes("TMUX_PANE="), false);
		assert.equal(script.includes("CMUX_SURFACE_ID="), false);
		assert.match(script, /export CMUX_SOCKET_PATH='\/private\/cmux\.sock'/);
		assert.match(script, /export CMUX_SOCKET_CAPABILITY='private-capability'/);
		assert.match(script, /export CMUX_BUNDLED_CLI_PATH='\/Applications\/cmux\.app\/Contents\/Resources\/bin\/cmux'/);
		assert.match(script, new RegExp(`export ${SUBAGENT_EXPECTED_PARENT_PID_ENV}='123'`));
		assert.match(script, new RegExp(`export ${SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV}='456'`));
		assert.equal(script.includes("ARBITRARY_CMUX_ENV="), false);
		assert.equal(script.includes("PWD="), false);
		assert.equal(script.includes("UNRELATED_SECRET="), false);
	});

	test("preserves recovery state when a pane cannot be closed or confirmed gone", async () => {
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		const backend = {
			mode: "cmux-pane" as const,
			availabilityError: () => null,
			launch: async () => handle,
			interrupt: async () => true,
			close: async () => true,
			inspect: async () => ({ exists: true }),
		};
		// A successful close acknowledgement cannot replace an exact absence probe.
		assert.equal(await closeInteractiveTarget(backend, handle), false);
		backend.inspect = async () => ({ exists: true, exited: true });
		assert.equal(await closeInteractiveTarget(backend, handle), false);
		backend.inspect = async () => ({ exists: false });
		assert.equal(await closeInteractiveTarget(backend, handle), true);
	});

	test("registers committed ownership before a post-commit gate failure and exact cleanup", async () => {
		const runId = "commit-before-launch-failure";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: false }),
		};
		registerCommittedInteractiveRun({ runId, backend, handle, generation: getInteractiveShutdownGenerationForTest() });
		try {
			// This is the precise window between commit adoption and gate publish:
			// gate failure must still leave the exact allocation actively owned.
			await assert.rejects(async () => { throw new Error("injected gate publication failure"); });
			assert.equal(listActiveInteractiveRunIds().includes(runId), true);
			assert.equal(await recoverInteractiveTarget(backend, handle), true);
		} finally { unregisterCommittedInteractiveRun(runId); }
	});

	test("increments generations across resets and fences old captures", async () => {
		await resetInteractiveShutdownForSession();
		const captured = getInteractiveShutdownGenerationForTest();
		assert.equal(canStartInteractiveRun(captured), true);
		await beginInteractiveShutdownForSession();
		const fenced = getInteractiveShutdownGenerationForTest();
		await beginInteractiveShutdownForSession();
		assert.equal(getInteractiveShutdownGenerationForTest(), fenced);
		assert.equal(canStartInteractiveRun(captured), false);
		await resetInteractiveShutdownForSession();
		assert.equal(canStartInteractiveRun(captured), false);
		assert.equal(canStartInteractiveRun(getInteractiveShutdownGenerationForTest()), true);
	});

	test("retains a fenced late commit for shutdown retry when its first exact release fails", async () => {
		await resetInteractiveShutdownForSession();
		await shutdownActiveInteractiveRuns();
		const runId = "late-commit-during-shutdown";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "exact-surface", paneId: "p" } };
		const calls: string[] = [];
		let releases = 0;
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async (target: typeof handle) => { calls.push(`interrupt:${target.native.surfaceId}`); return true; },
			close: async (target: typeof handle) => { calls.push(`close:${target.native.surfaceId}`); return true; },
			inspect: async () => ({ exists: false }),
		};
		assert.equal(registerCommittedInteractiveRun({
			runId, backend, handle, generation: getInteractiveShutdownGenerationForTest(),
			release: async () => ++releases >= 2,
		}), false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(releases, 1);
		assert.equal(listActiveInteractiveRunIds().includes(runId), true);
		await shutdownActiveInteractiveRuns();
		assert.equal(releases, 2);
		assert.equal(listActiveInteractiveRunIds().includes(runId), false);
		assert.deepEqual(calls, ["interrupt:exact-surface", "interrupt:exact-surface"]);
		await resetInteractiveShutdownForSession();
	});

	test("serializes a paused gate publication with the shutdown fence", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-gate-fence-"));
		const paths = await prepareRunArtifactPaths({ rootDir, runId: "gate-fence-race" });
		const runId = "gate-fence-race";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		let releases = 0;
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: false }),
		};
		try {
			registerCommittedInteractiveRun({
				runId, backend, handle, generation: getInteractiveShutdownGenerationForTest(),
				release: async () => { releases += 1; return true; },
			});
			let publicationLocked!: () => void;
			const publicationEntered = new Promise<void>((resolve) => { publicationLocked = resolve; });
			let releasePublication!: () => void;
			const publicationPaused = new Promise<void>((resolve) => { releasePublication = resolve; });
			const publishing = publishInteractiveLaunchGate({
				paths, runId, terminalMode: "cmux-pane", generation: getInteractiveShutdownGenerationForTest(),
				beforePublishForTest: async () => { publicationLocked(); await publicationPaused; },
			});
			await publicationEntered;
			const fence = beginInteractiveShutdownForSession();
			releasePublication();
			await publishing;
			await fence;
			assert.equal(fs.existsSync(paths.launchGatePath), true);
			assert.equal(listActiveInteractiveRunIds().includes(runId), true);
			await shutdownActiveInteractiveRuns();
			assert.equal(releases, 1);
			assert.equal(listActiveInteractiveRunIds().includes(runId), false);

			const fencedPaths = await prepareRunArtifactPaths({ rootDir, runId: "gate-fence-wins" });
			await resetInteractiveShutdownForSession();
			const fencedGeneration = getInteractiveShutdownGenerationForTest();
			await beginInteractiveShutdownForSession();
			await assert.rejects(
				publishInteractiveLaunchGate({ paths: fencedPaths, runId: "gate-fence-wins", terminalMode: "cmux-pane", generation: fencedGeneration }),
				/fenced this committed run before gate publication/,
			);
			assert.equal(fs.existsSync(fencedPaths.launchGatePath), false);
			await removeRunArtifacts(fencedPaths);
		} finally {
			unregisterCommittedInteractiveRun(runId);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("retries failed active releases and retains unresolved ownership", async () => {
		await resetInteractiveShutdownForSession();
		const retryRunId = "retry-release";
		const failedRunId = "failed-release";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: false }),
		};
		let retries = 0;
		registerCommittedInteractiveRun({
			runId: retryRunId, backend, handle,
			generation: getInteractiveShutdownGenerationForTest(),
			release: async () => ++retries >= 2,
		});
		registerCommittedInteractiveRun({
			runId: failedRunId, backend, handle,
			generation: getInteractiveShutdownGenerationForTest(), release: async () => false,
		});
		await shutdownActiveInteractiveRuns();
		assert.equal(retries, 2);
		assert.equal(listActiveInteractiveRunIds().includes(retryRunId), false);
		assert.equal(listActiveInteractiveRunIds().includes(failedRunId), true);
		unregisterCommittedInteractiveRun(failedRunId);
		await resetInteractiveShutdownForSession();
	});

	test("interrupts and confirms exact absence during inspect-exhaustion recovery", async () => {
		const handle = { mode: "tmux-pane" as const, native: { paneId: "%4", serverPid: 11, panePid: 12 } };
		const calls: string[] = [];
		const backend = {
			mode: "tmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => { calls.push("interrupt"); return true; },
			close: async () => { calls.push("close"); return true; },
			inspect: async () => { calls.push("inspect"); return { exists: false }; },
		};
		assert.equal(await recoverInteractiveTarget(backend, handle), true);
		assert.deepEqual(calls, ["interrupt", "close", "inspect"]);
	});

	test("clears inherited run protocol unless a new run explicitly replaces it", () => {
		const inherited = {
			[SUBAGENT_RUN_ID_ENV]: "parent-run",
			[SUBAGENT_RUN_STATE_PATH_ENV]: "/parent/state.json",
			[SUBAGENT_RUN_COMPLETION_PATH_ENV]: "/parent/complete.json",
			[SUBAGENT_PARENT_LEASE_PATH_ENV]: "/parent/lease.json",
			[SUBAGENT_CHILD_SESSION_PATH_ENV]: "/parent/session.jsonl",
			[SUBAGENT_RUN_OWNERSHIP_ENV]: "parent-owned",
			[SUBAGENT_EXPECTED_PARENT_PID_ENV]: "1",
			[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV]: "2",
		};
		const cleared = buildChildProcessEnv({
			agentName: "reviewer",
			parentDepth: 0,
			parentAgentStack: [],
			maxDepth: 3,
			preventCycles: true,
			baseEnv: inherited,
		});
		assert.equal(cleared[SUBAGENT_RUN_ID_ENV], undefined);
		assert.equal(cleared[SUBAGENT_EXPECTED_PARENT_PID_ENV], undefined);
		assert.equal(cleared[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV], undefined);

		const replaced = buildChildProcessEnv({
			agentName: "reviewer",
			parentDepth: 0,
			parentAgentStack: [],
			maxDepth: 3,
			preventCycles: true,
			baseEnv: inherited,
			runProtocolEnv: { [SUBAGENT_RUN_ID_ENV]: "child-run" },
		});
		assert.equal(replaced[SUBAGENT_RUN_ID_ENV], "child-run");
	});
});
