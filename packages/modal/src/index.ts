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

import type { Runtime, CommandResult, SandboxInfo, CreateSandboxOptions, FileEntry, RunCommandOptions } from '@computesdk/provider';

import { ModalClient } from 'modal';
import type { Sandbox, App, Image, SandboxCreateParams } from 'modal';

type ModalNativeSandbox = Sandbox;

/**
 * Modal-specific configuration options
 */
export interface ModalConfig {
  /** Modal API token ID - if not provided, will fallback to MODAL_TOKEN_ID environment variable */
  tokenId?: string;
  /** Modal API token secret - if not provided, will fallback to MODAL_TOKEN_SECRET environment variable */
  tokenSecret?: string;
  /** Default runtime environment - determines the base image used for sandboxes */
  runtime?: Runtime;
  /** Execution timeout in milliseconds */
  timeout?: number;
  /** Modal environment (sandbox or main) */
  environment?: string;
  /** Ports to expose */
  ports?: number[];
  /** Modal app name to use for sandboxes - defaults to 'computesdk-modal' */
  appName?: string;
}


/**
 * Modal sandbox interface - wraps Modal's Sandbox class
 */
interface ModalSandbox {
  sandbox: ModalNativeSandbox;
  sandboxId: string;
}

const DEFAULT_RUNTIME: Runtime = 'node';
const DEFAULT_APP_NAME = 'computesdk-modal';

const RUNTIME_IMAGES: Record<string, string> = {
  node: 'node:20',
  python: 'python:3.13-slim',
  deno: 'denoland/deno:latest',
  bun: 'oven/bun:latest',
};

/**
 * Resolves the registry image to use for a sandbox.
 * Per-call runtime (CreateSandboxOptions) takes precedence over the
 * provider-level default (ModalConfig.runtime).
 */
function resolveImage(client: ModalClient, callRuntime?: Runtime, configRuntime?: Runtime): Image {
  const runtime = callRuntime ?? configRuntime ?? DEFAULT_RUNTIME;
  const tag = RUNTIME_IMAGES[runtime];
  return client.images.fromRegistry(tag);
}

/**
 * Internal config — extends ModalConfig with resources initialised once at
 * factory time so they are not recreated on every sandbox operation.
 *
 * _client is stateless and safe to share across all calls.
 * _appPromise is a Promise created synchronously in modal() so the factory
 * stays sync. Subsequent awaits on the same Promise return the cached resolved
 * value — the Promise acts as the cache.
 * The default image is intentionally NOT cached here: it depends on the
 * per-call runtime option, so it is resolved inside create() instead.
 */
interface ModalInternalConfig extends ModalConfig {
  _client: ModalClient;
  _appPromise: Promise<App>;
}

const _modal = defineProvider<ModalSandbox, ModalInternalConfig>({
  name: 'modal',
  methods: {
    sandbox: {
      // Collection operations (map to compute.sandbox.*)
      create: async (config: ModalInternalConfig, options?: CreateSandboxOptions) => {
        try {
          const client = config._client;

          let sandbox: ModalNativeSandbox;
          let sandboxId: string;

          const app = await config._appPromise;

            // Destructure known ComputeSDK fields, collect the rest for passthrough
            const {
              runtime: _runtime,
              timeout: optTimeout,
              envs,
              name,
              metadata: _metadata,
              templateId,
              snapshotId,
              imageId,
              sandboxId: _sandboxId,
              namespace: _namespace,
              directory: _directory,
              ports: optPorts,
              ...providerOptions
            } = options || {};

            let image: Image;
            // imageId is the Modal-native field; templateId and snapshotId are ComputeSDK aliases
            const sourceId = imageId ?? snapshotId ?? templateId;
            if (sourceId) {
              image = await client.images.fromId(sourceId);
            } else {
              image = resolveImage(client, _runtime, config.runtime);
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

          const modalSandbox: ModalSandbox = {
            sandbox,
            sandboxId,
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

      runCommand: async (modalSandbox: ModalSandbox, command: string, options?: RunCommandOptions): Promise<CommandResult> => {
        const startTime = Date.now();

        try {
          // Build command with options
          let fullCommand = command;
          
          // Handle environment variables
          if (options?.env && Object.keys(options.env).length > 0) {
            const envPrefix = Object.entries(options.env)
              .map(([k, v]) => `${k}="${escapeShellArg(String(v))}"`)
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

          // Use working stream reading pattern from debug
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

export type ModalProvider = ReturnType<typeof _modal> & {
  buildImage(tag: string): Promise<string>;
};

/**
 * Create a Modal provider instance.
 */
export function modal(config: ModalConfig = {}): ModalProvider {
  const runtime = config.runtime ?? DEFAULT_RUNTIME;
  const appName = config.appName ?? DEFAULT_APP_NAME;
  const client = new ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret, environment: config.environment });
  const appPromise = client.apps.fromName(appName, { createIfMissing: true });  // avoids recreating every method call

  const provider = _modal({
    ...config,
    runtime,
    appName,
    _client: client,
    _appPromise: appPromise,
  });

  return {
    ...provider,
    /** Build a Docker registry image on Modal and return its imageId.
     *  Pass the returned id as `imageId` in `sandbox.create()` to reuse the image without rebuilding. */
    buildImage: async (tag: string): Promise<string> => {
      const app = await appPromise;
      const image = client.images.fromRegistry(tag);
      const built = await image.build(app);
      return built.imageId;
    },
  };
}
