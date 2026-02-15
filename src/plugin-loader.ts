import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import type {
  ChannelPluginConfig,
  InboundMessage,
  LoadedPlugin,
  PluginContext,
  PluginHooks,
  PluginManifest,
} from './plugin-types.js';
import type { Channel } from './types.js';

const CORE_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ASSISTANT_NAME',
  'CLAUDE_MODEL',
];

/** Validate and normalize a raw plugin.json object */
export function parseManifest(raw: Record<string, unknown>): PluginManifest {
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error('Plugin manifest must have a "name" field');
  }
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    containerEnvVars: Array.isArray(raw.containerEnvVars)
      ? raw.containerEnvVars.filter((v): v is string => typeof v === 'string')
      : [],
    hooks: Array.isArray(raw.hooks)
      ? raw.hooks.filter((v): v is string => typeof v === 'string')
      : [],
    containerHooks: Array.isArray(raw.containerHooks)
      ? raw.containerHooks.filter((v): v is string => typeof v === 'string')
      : [],
    containerMounts: Array.isArray(raw.containerMounts)
      ? raw.containerMounts.filter(
          (v): v is { hostPath: string; containerPath: string } =>
            typeof v === 'object' && v !== null &&
            typeof (v as any).hostPath === 'string' &&
            typeof (v as any).containerPath === 'string',
        )
      : [],
    dependencies: raw.dependencies === true,
    channelPlugin: raw.channelPlugin === true,
    authSkill: typeof raw.authSkill === 'string' ? raw.authSkill : undefined,
    channels: Array.isArray(raw.channels)
      ? raw.channels.filter((v): v is string => typeof v === 'string')
      : undefined,
    groups: Array.isArray(raw.groups)
      ? raw.groups.filter((v): v is string => typeof v === 'string')
      : undefined,
  };
}

/** Merge core env vars with all plugin-declared vars (deduplicated) */
export function collectContainerEnvVars(plugins: LoadedPlugin[]): string[] {
  const vars = new Set(CORE_ENV_VARS);
  for (const plugin of plugins) {
    for (const v of plugin.manifest.containerEnvVars || []) {
      vars.add(v);
    }
  }
  return [...vars];
}

/** Collect skill directories from plugins that have a container-skills/ subdirectory */
export function collectSkillPaths(
  plugins: LoadedPlugin[],
): Array<{ hostPath: string; name: string }> {
  const paths: Array<{ hostPath: string; name: string }> = [];
  for (const plugin of plugins) {
    const skillsDir = path.join(plugin.dir, 'container-skills');
    if (fs.existsSync(skillsDir)) {
      paths.push({ hostPath: skillsDir, name: plugin.manifest.name });
    }
  }
  return paths;
}

/** Collect container hook files from plugins that declare containerHooks */
export function collectContainerHookPaths(
  plugins: LoadedPlugin[],
): Array<{ hostPath: string; name: string }> {
  const paths: Array<{ hostPath: string; name: string }> = [];
  for (const plugin of plugins) {
    for (const hookFile of plugin.manifest.containerHooks || []) {
      const hostPath = path.join(plugin.dir, hookFile);
      if (fs.existsSync(hostPath)) {
        // Use plugin name + filename as unique identifier
        const filename = path.basename(hookFile);
        paths.push({ hostPath, name: `${plugin.manifest.name}--${filename}` });
      } else {
        logger.warn(
          { plugin: plugin.manifest.name, hookFile },
          'Declared container hook file not found',
        );
      }
    }
  }
  return paths;
}

/** Collect additional container mounts from plugins */
export function collectContainerMounts(
  plugins: LoadedPlugin[],
): Array<{ hostPath: string; containerPath: string }> {
  const mounts: Array<{ hostPath: string; containerPath: string }> = [];
  for (const plugin of plugins) {
    for (const mount of plugin.manifest.containerMounts || []) {
      if (fs.existsSync(mount.hostPath)) {
        mounts.push(mount);
      } else {
        logger.warn(
          { plugin: plugin.manifest.name, hostPath: mount.hostPath },
          'Declared container mount path does not exist',
        );
      }
    }
  }
  return mounts;
}

/** Merge all plugins' mcp.json fragments into one config */
export function mergeMcpConfigs(
  fragments: Array<Record<string, any>>,
): { mcpServers: Record<string, any> } {
  const merged: Record<string, any> = {};
  for (const fragment of fragments) {
    if (fragment.mcpServers && typeof fragment.mcpServers === 'object') {
      Object.assign(merged, fragment.mcpServers);
    }
  }
  return { mcpServers: merged };
}

/** Loaded plugin registry with hook execution */
export class PluginRegistry {
  private plugins: LoadedPlugin[] = [];
  private _channels: Channel[] = [];

  get loaded(): LoadedPlugin[] {
    return this.plugins;
  }

  get channels(): Channel[] {
    return this._channels;
  }

  add(plugin: LoadedPlugin): void {
    this.plugins.push(plugin);
    logger.info({ plugin: plugin.manifest.name }, 'Plugin loaded');
  }

  /** Run all onInboundMessage hooks in sequence */
  async runInboundHooks(msg: InboundMessage, channel: string): Promise<InboundMessage> {
    let current = msg;
    for (const plugin of this.plugins) {
      if (plugin.hooks.onInboundMessage) {
        current = await plugin.hooks.onInboundMessage(current, channel);
      }
    }
    return current;
  }

  /** Get plugins that declare channelPlugin: true */
  getChannelPlugins(): LoadedPlugin[] {
    return this.plugins.filter(p => p.manifest.channelPlugin);
  }

  /** Initialize a single channel plugin — call before startup() */
  async initChannel(plugin: LoadedPlugin, ctx: PluginContext, config: ChannelPluginConfig): Promise<Channel> {
    if (!plugin.hooks.onChannel) {
      throw new Error(`Plugin ${plugin.manifest.name} does not export onChannel`);
    }
    const channel = await plugin.hooks.onChannel(ctx, config);
    this._channels.push(channel);
    logger.info({ plugin: plugin.manifest.name, channel: channel.name }, 'Plugin channel registered');
    return channel;
  }

  /** Call onStartup on all non-channel plugins */
  async startup(ctx: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.hooks.onStartup) {
        await plugin.hooks.onStartup(ctx);
        logger.info({ plugin: plugin.manifest.name }, 'Plugin started');
      }
    }
  }

  /** Call onShutdown on all plugins */
  async shutdown(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.hooks.onShutdown) {
        try {
          await plugin.hooks.onShutdown();
        } catch (err) {
          logger.error({ plugin: plugin.manifest.name, err }, 'Plugin shutdown error');
        }
      }
    }
  }

  /** Filter plugins by channel and group scope */
  getPluginsForGroup(channel?: string, groupFolder?: string): LoadedPlugin[] {
    return this.plugins.filter(p => {
      // Channel filter: undefined or ["*"] means all channels
      const ch = p.manifest.channels;
      if (ch && !ch.includes('*') && channel && !ch.includes(channel)) return false;
      // Group filter: undefined or ["*"] means all groups
      const gr = p.manifest.groups;
      if (gr && !gr.includes('*') && groupFolder && !gr.includes(groupFolder)) return false;
      return true;
    });
  }

  getContainerEnvVars(channel?: string, groupFolder?: string): string[] {
    return collectContainerEnvVars(this.getPluginsForGroup(channel, groupFolder));
  }

  getSkillPaths(channel?: string, groupFolder?: string): Array<{ hostPath: string; name: string }> {
    return collectSkillPaths(this.getPluginsForGroup(channel, groupFolder));
  }

  getContainerHookPaths(channel?: string, groupFolder?: string): Array<{ hostPath: string; name: string }> {
    return collectContainerHookPaths(this.getPluginsForGroup(channel, groupFolder));
  }

  getContainerMounts(channel?: string, groupFolder?: string): Array<{ hostPath: string; containerPath: string }> {
    return collectContainerMounts(this.getPluginsForGroup(channel, groupFolder));
  }

  getMergedMcpConfig(rootMcpPath?: string, channel?: string, groupFolder?: string): { mcpServers: Record<string, any> } {
    const fragments: Array<Record<string, any>> = [];

    // Include root .mcp.json if it exists
    if (rootMcpPath && fs.existsSync(rootMcpPath)) {
      try {
        fragments.push(JSON.parse(fs.readFileSync(rootMcpPath, 'utf-8')));
      } catch (err) {
        logger.warn({ path: rootMcpPath, err }, 'Failed to parse root .mcp.json');
      }
    }

    // Include each scoped plugin's mcp.json
    for (const plugin of this.getPluginsForGroup(channel, groupFolder)) {
      const mcpFile = path.join(plugin.dir, 'mcp.json');
      if (fs.existsSync(mcpFile)) {
        try {
          fragments.push(JSON.parse(fs.readFileSync(mcpFile, 'utf-8')));
        } catch (err) {
          logger.warn({ plugin: plugin.manifest.name, err }, 'Failed to parse plugin mcp.json');
        }
      }
    }

    return mergeMcpConfigs(fragments);
  }
}

/** Discover and load all plugins from the plugins/ directory */
export async function loadPlugins(pluginsDir?: string): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  const dir = pluginsDir || path.join(process.cwd(), 'plugins');

  if (!fs.existsSync(dir)) {
    logger.debug({ dir }, 'No plugins directory found');
    return registry;
  }

  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const pluginDir = path.join(dir, entry);
    const manifestPath = path.join(pluginDir, 'plugin.json');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const manifest = parseManifest(raw);

      let hooks: PluginHooks = {};

      // Load hook implementations if the plugin declares hooks
      if (manifest.hooks && manifest.hooks.length > 0) {
        const indexJs = path.join(pluginDir, 'index.js');
        if (fs.existsSync(indexJs)) {
          const mod = await import(indexJs);
          hooks = {};
          for (const hookName of manifest.hooks) {
            if (typeof mod[hookName] === 'function') {
              (hooks as any)[hookName] = mod[hookName];
            } else {
              logger.warn(
                { plugin: manifest.name, hook: hookName },
                'Declared hook not found in module',
              );
            }
          }
        } else {
          logger.warn(
            { plugin: manifest.name, path: indexJs },
            'Plugin declares hooks but no index.js found',
          );
        }
      }

      registry.add({ manifest, dir: pluginDir, hooks });
    } catch (err) {
      logger.error({ plugin: entry, err }, 'Failed to load plugin');
    }
  }

  logger.info({ count: registry.loaded.length }, 'Plugins loaded');
  return registry;
}
