/**
 * Modal Provider - Factory-based Implementation
 * 
 * Full-featured provider with serverless sandbox execution using the factory pattern.
 * Leverages Modal's JavaScript SDK for real sandbox management.
 * 
 * Note: Modal's JavaScript SDK is in alpha. This implementation provides a working
 * foundation but may need updates as the Modal API evolves.
 */

import { defineProvider, escapeShellArg } from '@computesdk/provider';

import type { Runtime, CodeResult, CommandResult, SandboxInfo, CreateSandboxOptions, FileEntry, RunCommandOptions } from '@computesdk/provider';

import { ModalClient } from 'modal';
import type { Sandbox, App, Image, SandboxCreateParams, ModalClientParams } from 'modal';

/**
 * Modal-specific configuration options
 */
export interface ModalConfig {
  /** Modal API token ID - if not provided, will fallback to MODAL_TOKEN_ID environment variable */
  tokenId?: string;
  /** Modal API token secret - if not provided, will fallback to MODAL_TOKEN_SECRET environment variable */
  tokenSecret?: string;
  /** Default runtime environment */
  runtime?: Runtime;
  /** Execution timeout in milliseconds */
  timeout?: number;
  /** Modal environment (sandbox or main) */
  environment?: string;
  /** Ports to expose */
  ports?: number[];
  /** When true, app lookup and image resolution happen on each sandbox.create() call instead of once at factory time */
  lazyInit?: boolean;
  /** When true, logs a warning to stderr for every gRPC request made to Modal */
  logRequests?: boolean;
}

/**
 * Modal sandbox interface - wraps Modal's Sandbox class
 */
interface ModalSandbox {
  sandbox: Sandbox;
  sandboxId: string;
  client: ModalClient;
  app: App;
}

/**
 * Internal config — extends ModalConfig with resources initialised once at
 * factory time so they are not recreated on every sandbox operation.
 */
interface ModalInternalConfig extends ModalConfig {
  _client: ModalClient;
  _appPromise: Promise<App>;
  _defaultImage: Image;
  _grpcMiddleware: NonNullable<ModalClientParams['grpcMiddleware']>;
}

/**
 * Detect runtime from code content
 */
function detectRuntime(code: string): Runtime {
  // Strong Node.js indicators
  if (code.includes('console.log') || 
      code.includes('process.') ||
      code.includes('require(') ||
      code.includes('module.exports') ||
      code.includes('__dirname') ||
      code.includes('__filename') ||
      code.includes('throw new Error') ||  // JavaScript error throwing
      code.includes('new Error(')) {
    return 'node';
  }

  // Strong Python indicators
  if (code.includes('print(') ||
      code.includes('import ') ||
      code.includes('def ') ||
      code.includes('sys.') ||
      code.includes('json.') ||
      code.includes('f"') ||
      code.includes("f'") ||
      code.includes('raise ')) {
    return 'python';
  }

  // Default to Node.js for Modal (now using Node.js base image)
  return 'node';
}

/**
 * Create a Modal provider instance using the factory pattern
 */
const _modal = defineProvider<ModalSandbox, ModalInternalConfig>({
  name: 'modal',
  methods: {
    sandbox: {
      // Collection operations (map to compute.sandbox.*)
      create: async (config: ModalInternalConfig, options?: CreateSandboxOptions) => {
        try {
          const client = config.lazyInit
            ? new ModalClient({ tokenId: config.tokenId!, tokenSecret: config.tokenSecret!, environment: config.environment, grpcMiddleware: config._grpcMiddleware })
            : config._client;

          let sandbox: Sandbox;
          let sandboxId: string;

          const app = config.lazyInit
            ? await client.apps.fromName('computesdk-modal', { createIfMissing: true })
            : await config._appPromise;

            // Destructure known ComputeSDK fields, collect the rest for passthrough
            const {
              runtime: _runtime,
              timeout: optTimeout,
              envs,
              name,
              metadata: _metadata,
              templateId,
              snapshotId,
              sandboxId: _sandboxId,
              namespace: _namespace,
              directory: _directory,
              overlays: _overlays,
              servers: _servers,
              ports: optPorts,
              ...providerOptions
            } = options || {};

            let image;
            // Modal supports snapshotId and templateId (both map to image)
            const sourceId = snapshotId || templateId;
            if (sourceId) {
              // Create from snapshot/template
              try {
                image = await client.images.fromId(sourceId);
              } catch (e) {
                // Fallback: try to treat it as a registry image
                image = client.images.fromRegistry(sourceId);
              }
            } else {
              image = config.lazyInit
                ? client.images.fromRegistry('node:20')
                : config._defaultImage;
            }
            
            // Configure sandbox options
            // Modal SDK uses: env, timeoutMs, name, workdir, unencryptedPorts, gpu, cpu, etc.
            const sandboxOptions: SandboxCreateParams = {
              ...(providerOptions as Partial<SandboxCreateParams>),
            };
            
            // Configure ports if provided (using unencrypted ports by default)
            // options.ports takes precedence over config.ports
            const ports = optPorts ?? config.ports;
            if (ports && ports.length > 0) {
              sandboxOptions.unencryptedPorts = ports;
            }
            
            // options.timeout takes precedence over config.timeout
            const timeout = optTimeout ?? config.timeout;
            if (timeout) {
              sandboxOptions.timeoutMs = timeout;
            }

            // Remap envs to env (Modal uses 'env')
            if (envs && Object.keys(envs).length > 0) {
              sandboxOptions.env = envs;
            }

            // Pass sandbox name
            if (name) {
              sandboxOptions.name = name;
            }
            
          sandbox = await client.sandboxes.create(app, image, sandboxOptions);
          sandboxId = sandbox.sandboxId;

          const modalSandbox: ModalSandbox = {
            sandbox,
            sandboxId,
            client,
            app,
          };

          return {
            sandbox: modalSandbox,
            sandboxId
          };
        } catch (error) {
          if (error instanceof Error) {
            if (error.message.includes('unauthorized') || error.message.includes('credentials')) {
              throw new Error(
                `Modal authentication failed. Please check your MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables. Get your credentials from https://modal.com/`
              );
            }
            if (error.message.includes('quota') || error.message.includes('limit')) {
              throw new Error(
                `Modal quota exceeded. Please check your usage at https://modal.com/`
              );
            }
          }
          throw new Error(
            `Failed to create Modal sandbox: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },

      getById: async (config: ModalInternalConfig, sandboxId: string) => {
        try {
          const client = config._client;
          const sandbox = await client.sandboxes.fromId(sandboxId);
          const app = await config._appPromise;

          const modalSandbox: ModalSandbox = {
            sandbox,
            sandboxId,
            client,
            app,
          };

          return {
            sandbox: modalSandbox,
            sandboxId
          };
        } catch (error) {
          // Sandbox doesn't exist or can't be accessed
          return null;
        }
      },

      list: async (_config: ModalConfig) => {
        throw new Error(
          `Modal provider does not support listing sandboxes. Modal sandboxes are managed individually through the Modal console. Use getById to reconnect to specific sandboxes by ID.`
        );
      },

      destroy: async (config: ModalInternalConfig, sandboxId: string) => {
        try {
          const client = config._client;
          const sandbox = await client.sandboxes.fromId(sandboxId);
          if (sandbox && typeof sandbox.terminate === 'function') {
            await sandbox.terminate();
          }
        } catch (error) {
          // Sandbox might already be terminated or doesn't exist
          // This is acceptable for destroy operations
        }
      },

      // Instance operations (map to individual Sandbox methods)
      runCode: async (modalSandbox: ModalSandbox, code: string, runtime?: Runtime): Promise<CodeResult> => {
        const startTime = Date.now();

        try {
          // Auto-detect runtime from code if not specified
          const detectedRuntime = runtime || detectRuntime(code);

          // Create appropriate sandbox and command for the runtime
          let executionSandbox = modalSandbox.sandbox;
          let command: string[];
          let shouldCleanupSandbox = false;

          if (detectedRuntime === 'node') {
            // Use existing Node.js sandbox (now the default)
            command = ['node', '-e', code];
          } else {
            // For Python execution, create a Python sandbox dynamically
            const pythonImage = modalSandbox.client.images.fromRegistry('python:3.13-slim');
            executionSandbox = await modalSandbox.client.sandboxes.create(modalSandbox.app, pythonImage);
            command = ['python3', '-c', code];
            shouldCleanupSandbox = true; // Clean up temporary Python sandbox
          }

          const process = await executionSandbox.exec(command, {
            stdout: 'pipe',
            stderr: 'pipe'
          });

          // Use working stream reading pattern from debug
          const [stdout, stderr] = await Promise.all([
            process.stdout.readText(),
            process.stderr.readText()
          ]);

          const exitCode = await process.wait();

          // Clean up temporary Python sandbox if created
          if (shouldCleanupSandbox && executionSandbox !== modalSandbox.sandbox) {
            try {
              await executionSandbox.terminate();
            } catch (e) {
              // Ignore cleanup errors
            }
          }

          // Check for syntax errors in stderr
          if (exitCode !== 0 && stderr && (
            stderr.includes('SyntaxError') ||
            stderr.includes('invalid syntax')
          )) {
            throw new Error(`Syntax error: ${stderr.trim()}`);
          }

          return {
            output: (stdout || '') + (stderr || ''),
            exitCode: exitCode || 0,
            language: detectedRuntime,
          };
        } catch (error) {
          // Handle syntax errors and runtime errors
          if (error instanceof Error && error.message.includes('Syntax error')) {
            throw error; // Re-throw syntax errors
          }

          throw new Error(
            `Modal execution failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },

      runCommand: async (modalSandbox: ModalSandbox, command: string, options?: RunCommandOptions): Promise<CommandResult> => {
        const startTime = Date.now();

        try {
          // Build command with options
          let fullCommand = command;
          
          // Handle environment variables
          if (options?.env && Object.keys(options.env).length > 0) {
            const envPrefix = Object.entries(options.env)
              .map(([k, v]) => `${k}="${escapeShellArg(v)}"`)
              .join(' ');
            fullCommand = `${envPrefix} ${fullCommand}`;
          }
          
          // Handle working directory
          if (options?.cwd) {
            fullCommand = `cd "${escapeShellArg(options.cwd)}" && ${fullCommand}`;
          }
          
          // Handle background execution
          if (options?.background) {
            fullCommand = `nohup ${fullCommand} > /dev/null 2>&1 &`;
          }
          
          // Execute using shell to handle complex commands
          const process = await modalSandbox.sandbox.exec(['sh', '-c', fullCommand], {
            stdout: 'pipe',
            stderr: 'pipe'
          });

          const [stdout, stderr] = await Promise.all([
            process.stdout.readText(),
            process.stderr.readText()
          ]);

          const exitCode = await process.wait();

          return {
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: exitCode || 0,
            durationMs: Date.now() - startTime,
          };
        } catch (error) {
          return {
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 127,
            durationMs: Date.now() - startTime,
          };
        }
      },

      getInfo: async (modalSandbox: ModalSandbox): Promise<SandboxInfo> => {
        // Get actual sandbox status using Modal's poll method
        let status: 'running' | 'stopped' | 'error' = 'running';
        try {
          const pollResult = await modalSandbox.sandbox.poll();
          if (pollResult !== null) {
            // Sandbox has finished
            status = pollResult === 0 ? 'stopped' : 'error';
          }
        } catch (error) {
          // If polling fails, assume running
          status = 'running';
        }

        return {
          id: modalSandbox.sandboxId,
          provider: 'modal',
          runtime: 'node', // Modal default (now using Node.js)
          status,
          createdAt: new Date(),
          timeout: 300000,
          metadata: {
            modalSandboxId: modalSandbox.sandboxId,
            realModalImplementation: true
          }
        };
      },

      getUrl: async (modalSandbox: ModalSandbox, options: { port: number; protocol?: string }): Promise<string> => {
        try {
          // Use Modal's built-in tunnels method to get tunnel information
          const tunnels = await modalSandbox.sandbox.tunnels();
          const tunnel = tunnels[options.port];
          
          if (!tunnel) {
            throw new Error(`No tunnel found for port ${options.port}. Available ports: ${Object.keys(tunnels).join(', ')}`);
          }
          
          let url = tunnel.url;
          
          // If a specific protocol is requested, replace the URL's protocol
          if (options.protocol) {
            const urlObj = new URL(url);
            urlObj.protocol = options.protocol + ':';
            url = urlObj.toString();
          }
          
          return url;
        } catch (error) {
          throw new Error(
            `Failed to get Modal tunnel URL for port ${options.port}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },

      // Optional filesystem methods - Modal supports filesystem operations
      filesystem: {
        readFile: async (modalSandbox: ModalSandbox, path: string): Promise<string> => {
          try {
            const file = await modalSandbox.sandbox.open(path);
            const data = await file.read();
            const content = new TextDecoder().decode(data);
            await file.close();
            return content;
          } catch (error) {
            // Fallback to using cat command with working stream pattern
            try {
              const process = await modalSandbox.sandbox.exec(['cat', path], {
                stdout: 'pipe',
                stderr: 'pipe'
              });

              const [content, stderr] = await Promise.all([
                process.stdout.readText(),
                process.stderr.readText()
              ]);

              const exitCode = await process.wait();

              if (exitCode !== 0) {
                throw new Error(`cat failed: ${stderr}`);
              }

              return content.trim(); // Remove extra newlines
            } catch (fallbackError) {
              throw new Error(`Failed to read file ${path}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        },

        writeFile: async (modalSandbox: ModalSandbox, path: string, content: string): Promise<void> => {
          const file = await modalSandbox.sandbox.open(path, 'w');
          try {
            await file.write(new TextEncoder().encode(content));
          } finally {
            await file.close();
          }
        },

        mkdir: async (modalSandbox: ModalSandbox, path: string): Promise<void> => {
          try {
            const process = await modalSandbox.sandbox.exec(['mkdir', '-p', path], {
              stdout: 'pipe',
              stderr: 'pipe'
            });

            const [, stderr] = await Promise.all([
              process.stdout.readText(),
              process.stderr.readText()
            ]);

            const exitCode = await process.wait();

            if (exitCode !== 0) {
              throw new Error(`mkdir failed: ${stderr}`);
            }
          } catch (error) {
            throw new Error(`Failed to create directory ${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        },

        readdir: async (modalSandbox: ModalSandbox, path: string): Promise<FileEntry[]> => {
          try {
            // Use simple -l flag for BusyBox compatibility (Alpine/node:20-alpine uses BusyBox ls)
            const process = await modalSandbox.sandbox.exec(['ls', '-la', path], {
              stdout: 'pipe',
              stderr: 'pipe'
            });

            const [output, stderr] = await Promise.all([
              process.stdout.readText(),
              process.stderr.readText()
            ]);

            const exitCode = await process.wait();

            if (exitCode !== 0) {
              throw new Error(`ls failed: ${stderr}`);
            }

            const lines = output.split('\n').slice(1); // Skip header

            return lines
              .filter((line: string) => line.trim())
              .map((line: string) => {
                const parts = line.trim().split(/\s+/);
                const permissions = parts[0] || '';
                const size = parseInt(parts[4]) || 0;
                const dateStr = (parts[5] || '') + ' ' + (parts[6] || '');
                const date = dateStr.trim() ? new Date(dateStr) : new Date();
                const name = parts.slice(8).join(' ') || parts[parts.length - 1] || 'unknown';

                return {
                  name,
                  type: permissions.startsWith('d') ? 'directory' as const : 'file' as const,
                  size,
                  modified: isNaN(date.getTime()) ? new Date() : date
                };
              });
          } catch (error) {
            throw new Error(`Failed to read directory ${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        },

        exists: async (modalSandbox: ModalSandbox, path: string): Promise<boolean> => {
          try {
            const process = await modalSandbox.sandbox.exec(['test', '-e', path]);
            const exitCode = await process.wait();
            return exitCode === 0;
          } catch (error) {
            return false;
          }
        },

        remove: async (modalSandbox: ModalSandbox, path: string): Promise<void> => {
          try {
            const process = await modalSandbox.sandbox.exec(['rm', '-rf', path], {
              stdout: 'pipe',
              stderr: 'pipe'
            });

            const [, stderr] = await Promise.all([
              process.stdout.readText(),
              process.stderr.readText()
            ]);

            const exitCode = await process.wait();

            if (exitCode !== 0) {
              throw new Error(`rm failed: ${stderr}`);
            }
          } catch (error) {
            throw new Error(`Failed to remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },

      // Provider-specific typed getInstance method
      getInstance: (sandbox: ModalSandbox): ModalSandbox => {
        return sandbox;
      },

    },

    snapshot: {
      create: async (config: ModalInternalConfig, sandboxId: string, options?: { name?: string }) => {
        try {
          const client = config._client;
          // We need to reconnect to the sandbox to snapshot it
          // Note: sandbox.snapshotFilesystem() is an instance method on the Sandbox object
          // But we only have the ID here.
          // We need to re-instantiate the sandbox object from the ID.

          const sandbox = await client.sandboxes.fromId(sandboxId);
          const image = await sandbox.snapshotFilesystem();

          return {
            id: image.imageId,
            image: image,
            provider: 'modal',
            createdAt: new Date()
          };
        } catch (error) {
          throw new Error(`Failed to create Modal snapshot: ${error instanceof Error ? error.message : String(error)}`);
        }
      },

      list: async (_config: ModalConfig) => {
        // Modal doesn't have a simple "list snapshots" API yet that maps 1:1
        return [];
      },

      delete: async (_config: ModalConfig, snapshotId: string) => {
        // No-op for now
      }
    }
  }
});

/**
 * Create a Modal provider instance.
 *
 * Validates credentials and initialises the Modal client, app, and default
 * image once at call time rather than on every sandbox operation.
 */
export function modal(config: ModalConfig = {}): ReturnType<typeof _modal> {
  const grpcMiddleware = config.logRequests ? [
    async function* requestLogger(call: any, options: any) {
      const t0 = Date.now();
      try {
        return yield* call.next(call.request, options);
      } finally {
        process.stderr.write(`[modal] ${call.method.path.split('/').pop()} ${Date.now() - t0}ms\n`);
      }
    }
  ] : [];

  const client = new ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret, environment: config.environment, grpcMiddleware });

  return _modal({
    ...config,
    _client: client,
    _appPromise: client.apps.fromName('computesdk-modal', { createIfMissing: true }),
    _defaultImage: client.images.fromRegistry('node:20'),
    _grpcMiddleware: grpcMiddleware,
  });
}
