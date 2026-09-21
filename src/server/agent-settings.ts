import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Profile, ProfileName, Settings } from '../shared/types.ts';
import { defaults, Store } from './store.ts';

const profileNames: ProfileName[] = ['backend', 'frontend', 'fullstack', 'complex', 'pm', 'review'];
const configRequired: Profile = {
  providerId: 'config-required',
  model: 'config-required',
  effort: 'config-required',
};

export interface OmpModelRole {
  providerId: string;
  model: string;
  effort: string;
}

export interface AgentSettingsBootstrapResult {
  updated: boolean;
  source: string;
  missing: string[];
}

const roleCache = new Map<string, Promise<Record<string, OmpModelRole>>>();
let bootstrappedStores = new WeakSet<Store>();

function defaultConfigPath() {
  return join(homedir(), '.omp', 'agent', 'config.yml');
}

function parseRoleValue(value: string): OmpModelRole | undefined {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '');
  const separator = normalized.lastIndexOf(':');
  if (separator <= 0 || separator === normalized.length - 1) return undefined;
  const modelRef = normalized.slice(0, separator);
  const effort = normalized.slice(separator + 1).trim();
  const slash = modelRef.indexOf('/');
  if (slash <= 0 || slash === modelRef.length - 1 || !/^[\w.-]+$/.test(effort)) return undefined;
  const providerId = modelRef.slice(0, slash).trim();
  const model = modelRef.slice(slash + 1).trim();
  if (!providerId || !model) return undefined;
  return { providerId, model, effort };
}

/**
 * Read only the `modelRoles` block from OMP's config. The line reader intentionally never stores,
 * returns or logs any other config field (which may contain authentication material).
 */
export async function readOmpModelRoles(configPath = defaultConfigPath()) {
  const cached = roleCache.get(configPath);
  if (cached) return cached;
  const result = (async () => {
    const roles: Record<string, OmpModelRole> = {};
    const input = createReadStream(configPath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let inRoles = false;
    let roleIndent = 0;
    try {
      for await (const line of lines) {
        if (!inRoles) {
          if (/^\s*modelRoles\s*:\s*(?:#.*)?$/.test(line)) {
            inRoles = true;
            roleIndent = 0;
          }
          continue;
        }
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const indentation = line.match(/^\s*/)?.[0].length ?? 0;
        if (indentation === 0) break;
        roleIndent ||= indentation;
        if (indentation < roleIndent) break;
        const match = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
        if (!match) continue;
        const parsed = parseRoleValue(match[2]);
        if (parsed) roles[match[1]] = parsed;
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return roles;
  })();
  roleCache.set(configPath, result);
  return result;
}

function sameProfiles(a: Settings['ompProfiles'], b: Settings['ompProfiles']) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function profilesFromRoles(
  settings: Settings,
  roles: Record<string, OmpModelRole>,
): {
  profiles: NonNullable<Settings['ompProfiles']>;
  secondary?: Profile;
  missing: string[];
} {
  const roleDefaults: Partial<Record<ProfileName, string>> =
    settings.ompProfileInitialization?.roleDefaults ?? {};
  const missing: string[] = [];
  const profiles = Object.fromEntries(
    profileNames.map((profileName) => {
      const roleName = roleDefaults[profileName];
      const profile = roleName ? roles[roleName] : undefined;
      if (!profile) missing.push(`${profileName}:${roleName ?? 'role'}`);
      return [profileName, profile ? { ...profile } : structuredClone(configRequired)];
    }),
  ) as NonNullable<Settings['ompProfiles']>;
  return {
    profiles,
    secondary: roles.advisor ? { ...roles.advisor } : structuredClone(configRequired),
    missing,
  };
}

/**
 * Bootstrap OMP defaults once for a Store, and only while it still contains the software seed.
 * A user-edited settings snapshot is never overwritten on a later host restart.
 */
export async function bootstrapAgentSettings(
  store: Store,
  options: { configPath?: string } = {},
): Promise<AgentSettingsBootstrapResult> {
  const source = options.configPath ?? defaultConfigPath();
  if (bootstrappedStores.has(store)) return { updated: false, source, missing: [] };
  bootstrappedStores.add(store);
  const settings = store.settings();
  if (!sameProfiles(settings.ompProfiles, defaults.ompProfiles))
    return { updated: false, source, missing: [] };
  let roles: Record<string, OmpModelRole>;
  try {
    roles = await readOmpModelRoles(source);
  } catch {
    roles = {};
  }
  const { profiles, secondary, missing } = profilesFromRoles(settings, roles);
  store.saveSettings({
    ...settings,
    ompProfiles: profiles,
    ...(secondary
      ? {
          secondaryReviewProfiles: {
            ...(settings.secondaryReviewProfiles ?? {}),
            omp: secondary,
          },
        }
      : {}),
  });
  return { updated: true, source, missing };
}

/** Test/embedding hook; it does not touch credentials or persisted state. */
export function clearAgentSettingsCache() {
  roleCache.clear();
  bootstrappedStores = new WeakSet<Store>();
}
