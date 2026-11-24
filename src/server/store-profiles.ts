import type {
  AgentKind,
  AgentSelection,
  OmpProfileInitialization,
  OmpRoleDefault,
  Profile,
  ProfileMode,
  ProfileName,
  Project,
  Settings,
} from '../shared/types.ts';
import { profileSetSchema, settingsSchema } from './schemas.ts';
import { Fault, type RunOptions, type StoreContext } from './store-core.ts';

export const profileNames = ['backend', 'frontend', 'fullstack', 'complex', 'pm', 'review'] as const;
export type ProfileMap = Record<(typeof profileNames)[number], Profile>;

export const codexProfiles: ProfileMap = {
  backend: { providerId: 'codex', model: 'gpt-5.6-luna', effort: 'max' },
  frontend: { providerId: 'codex', model: 'gpt-6-astra', effort: 'low' },
  fullstack: { providerId: 'codex', model: 'gpt-6-astra', effort: 'low' },
  complex: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
  pm: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
  review: { providerId: 'codex', model: 'gpt-6-astra', effort: 'medium' },
};

// Role names are a one-time snapshot of OMP's modelRoles config. The actual model IDs are loaded
// by agent-settings.ts from OMP at startup; Store must not invent or persist a user model seed.
export const ompProfileInitialization: OmpProfileInitialization = {
  source: 'omp.modelRoles',
  roleDefaults: {
    backend: 'default',
    frontend: 'default',
    fullstack: 'default',
    complex: 'slow',
    pm: 'slow',
    review: 'slow',
  },
};

const ompConfigRequired: Profile = {
  providerId: 'config-required',
  model: 'config-required',
  effort: 'config-required',
};
const ompRoleProfiles: Record<OmpRoleDefault, Profile> = {
  default: ompConfigRequired,
  slow: ompConfigRequired,
  advisor: ompConfigRequired,
};
const ompSecondaryReviewProfile: Profile = structuredClone(ompConfigRequired);

/** Shape an OMP role mapping; model IDs are replaced by agent-settings bootstrap. */
export function initializeOmpProfiles(
  roleDefaults: Partial<Record<ProfileName, OmpRoleDefault>> = {},
): ProfileMap {
  return Object.fromEntries(
    profileNames.map((role) => {
      const roleDefault = roleDefaults[role] ?? ompProfileInitialization.roleDefaults[role];
      return [role, structuredClone(ompRoleProfiles[roleDefault])];
    }),
  ) as ProfileMap;
}

export const defaults: Settings = {
  globalDevLimit: 4,
  reviewLimit: 2,
  defaultAgent: 'omp',
  profiles: structuredClone(codexProfiles),
  ompProfiles: initializeOmpProfiles(),
  ompProfileInitialization: structuredClone(ompProfileInitialization),
  secondaryReviewProfiles: { omp: structuredClone(ompSecondaryReviewProfile) },
};

export function pinnedModes(): Record<ProfileName, ProfileMode> {
  return Object.fromEntries(profileNames.map((name) => [name, 'pinned'])) as Record<
    ProfileName,
    ProfileMode
  >;
}

export function inheritedModes(): Record<ProfileName, ProfileMode> {
  return Object.fromEntries(profileNames.map((name) => [name, 'inherit'])) as Record<
    ProfileName,
    ProfileMode
  >;
}

export function normalizeProfileMap(
  value: Partial<ProfileMap> | undefined,
  fallback: ProfileMap,
): ProfileMap {
  return Object.fromEntries(
    profileNames.map((name) => [name, structuredClone({ ...fallback[name], ...value?.[name] })]),
  ) as ProfileMap;
}

export function normalizeSettings(value: Settings): Settings {
  return {
    ...value,
    profiles: normalizeProfileMap(value.profiles, codexProfiles),
    ompProfiles: normalizeProfileMap(value.ompProfiles, initializeOmpProfiles()),
    ompProfileInitialization: value.ompProfileInitialization
      ? structuredClone(value.ompProfileInitialization)
      : structuredClone(ompProfileInitialization),
    defaultAgent: value.defaultAgent ?? 'omp',
    secondaryReviewProfiles: {
      ...(value.secondaryReviewProfiles ? structuredClone(value.secondaryReviewProfiles) : {}),
      ...(value.secondaryReviewProfile && !value.secondaryReviewProfiles?.codex
        ? { codex: structuredClone(value.secondaryReviewProfile) }
        : {}),
      ...(value.secondaryReviewProfiles?.omp
        ? {}
        : { omp: structuredClone(ompSecondaryReviewProfile) }),
    },
  };
}

export function validateProfiles(
  ctx: StoreContext,
  profiles: Settings['profiles'],
  agent: AgentKind = 'codex',
) {
  profileSetSchema.parse(profiles);
  if (agent === 'omp') return;
  for (const [role, profile] of Object.entries(profiles))
    validateCodexProvider(ctx, profile, role);
}

export function validateCodexProvider(ctx: StoreContext, profile: Profile, role: string) {
  if (profile.providerId !== 'codex' && !ctx.get('provider', profile.providerId))
    throw new Fault(`${role}: Provider 不存在：${profile.providerId}`, 409);
}

export function effectiveAgent(
  ctx: StoreContext,
  project: Project,
  settings = ctx.settings(),
): AgentKind {
  return project.agentSelection?.mode === 'override'
    ? project.agentSelection.agent
    : (settings.defaultAgent ?? 'codex');
}

export function secondaryReviewProfile(
  project: Project,
  agent: AgentKind,
  settings: Settings,
) {
  return (
    project.secondaryReviewProfiles?.[agent] ??
    settings.secondaryReviewProfiles?.[agent] ??
    project.secondaryReviewProfile ??
    settings.secondaryReviewProfile
  );
}

export function validateEffectiveSecondaryReview(
  ctx: StoreContext,
  project: Project,
  settings = ctx.settings(),
) {
  const agent = effectiveAgent(ctx, project, settings);
  const profile = secondaryReviewProfile(project, agent, settings);
  if (agent === 'codex' && profile) validateCodexProvider(ctx, profile, 'secondaryReview');
}

export function invalidateInheritedThreads(
  ctx: StoreContext,
  previous: Settings,
  next: Settings,
) {
  for (const project of ctx.list('project')) {
    const selection = project.agentSelection ?? { mode: 'override', agent: 'codex' as const };
    const beforeAgent =
      selection.mode === 'override' ? selection.agent : (previous.defaultAgent ?? 'codex');
    const afterAgent =
      selection.mode === 'override' ? selection.agent : (next.defaultAgent ?? 'codex');
    const modes = project.profileModes ?? pinnedModes();
    const changedRoles = profileNames.filter((role) => {
      if (modes[role] !== 'inherit') return false;
      const before =
        beforeAgent === 'omp' ? previous.ompProfiles?.[role] : previous.profiles[role];
      const after = afterAgent === 'omp' ? next.ompProfiles?.[role] : next.profiles[role];
      return beforeAgent !== afterAgent || JSON.stringify(before) !== JSON.stringify(after);
    });
    if (!changedRoles.length) continue;
    project.profileVersion = (project.profileVersion ?? 0) + 1;
    if (changedRoles.includes('pm')) {
      delete project.pmThreadId;
      delete project.pmThreadProviderId;
      delete project.pmThreadAgentKind;
      delete project.pmThreadProfileVersion;
      delete project.pmThreadProfile;
    }
    if (changedRoles.some((role) => ['backend', 'frontend', 'fullstack', 'complex'].includes(role))) {
      for (const task of ctx.list('task')) {
        if (task.projectId !== project.id) continue;
        const mode = modes[task.profile];
        if (mode !== 'inherit') continue;
        delete task.devThreadId;
        delete task.devThreadProviderId;
        delete task.devThreadAgentKind;
        delete task.devThreadProfileVersion;
        delete task.devThreadProfile;
        ctx.put('task', task.id, task);
      }
    }
    ctx.put('project', project.id, project);
  }
}

export function saveSettings(ctx: StoreContext, settings: Settings) {
  const previous = ctx.settings();
  settings = normalizeSettings(settingsSchema.parse(settings) as Settings);
  validateProfiles(ctx, settings.profiles, 'codex');
  if (settings.secondaryReviewProfiles?.codex)
    validateCodexProvider(ctx, settings.secondaryReviewProfiles.codex, 'secondaryReview.codex');
  // OMP profile provider IDs are resolved by OMP and are deliberately not required to exist in
  // the local Provider table. Validate the shape, but never ask Providers for credentials here.
  profileSetSchema.parse(settings.ompProfiles);
  for (const project of ctx.list('project'))
    validateEffectiveSecondaryReview(ctx, project, settings);
  ctx.transaction(() => {
    ctx.put('settings', 'global', settings);
    invalidateInheritedThreads(ctx, previous, settings);
  });
  ctx.event('settings', '运行配置已更新');
  return settings;
}

export function assertProviderUnused(ctx: StoreContext, providerId: string) {
  const references: string[] = [];
  const inspect = (name: string, profiles: Settings['profiles']) => {
    for (const [role, profile] of Object.entries(profiles))
      if (profile.providerId === providerId) references.push(`${name} / ${role}`);
  };
  inspect('全局默认值', ctx.settings().profiles);
  if (ctx.settings().secondaryReviewProfile?.providerId === providerId)
    references.push('全局默认值 / secondaryReview');
  if (ctx.settings().secondaryReviewProfiles?.codex?.providerId === providerId)
    references.push('全局默认值 / secondaryReviewProfiles.codex');
  for (const project of ctx.list('project')) {
    inspect(`Project ${project.name} (${project.id})`, project.profiles);
    if (project.secondaryReviewProfile?.providerId === providerId)
      references.push(`Project ${project.name} (${project.id}) / secondaryReview`);
    if (project.secondaryReviewProfiles?.codex?.providerId === providerId)
      references.push(`Project ${project.name} (${project.id}) / secondaryReviewProfiles.codex`);
  }
  for (const run of ctx.activeRuns())
    if (run.profileConfig?.providerId === providerId)
      references.push(`进行中的 Run ${run.id} / ${run.role}`);
  if (references.length) throw new Fault(`Provider 仍被引用：${references.join('；')}`, 409);
}

export function saveProjectProfiles(
  ctx: StoreContext,
  projectId: string,
  profiles: Settings['profiles'],
) {
  validateProfiles(ctx, profiles, 'codex');
  return ctx.transaction(() => {
    const project = ctx.project(projectId);
    const changed = profileNames.filter(
      (role) => JSON.stringify(profiles[role]) !== JSON.stringify(project.profiles[role]),
    );
    if (changed.length) project.profileVersion = (project.profileVersion ?? 0) + 1;
    if (changed.includes('pm')) {
      delete project.pmThreadId;
      delete project.pmThreadProviderId;
      delete project.pmThreadAgentKind;
      delete project.pmThreadProfileVersion;
      delete project.pmThreadProfile;
    }
    for (const task of ctx.list('task')) {
      if (task.projectId === projectId && changed.includes(task.profile)) {
        delete task.devThreadId;
        delete task.devThreadProviderId;
        delete task.devThreadAgentKind;
        delete task.devThreadProfileVersion;
        delete task.devThreadProfile;
        ctx.put('task', task.id, task);
      }
    }
    project.profiles = structuredClone(profiles);
    project.profileModes = {
      ...(project.profileModes ?? pinnedModes()),
      ...Object.fromEntries(changed.map((role) => [role, 'pinned'])),
    } as Record<ProfileName, ProfileMode>;
    ctx.put('project', projectId, project);
    ctx.event('project', '项目模型分配已更新', { projectId });
    return project;
  });
}

export function saveProjectOmpProfiles(
  ctx: StoreContext,
  projectId: string,
  profiles: NonNullable<Settings['ompProfiles']>,
) {
  profileSetSchema.parse(profiles);
  return ctx.transaction(() => {
    const project = ctx.project(projectId);
    const changed = profileNames.filter(
      (role) => JSON.stringify(profiles[role]) !== JSON.stringify(project.ompProfiles?.[role]),
    );
    if (changed.length) project.profileVersion = (project.profileVersion ?? 0) + 1;
    if (changed.includes('pm')) {
      delete project.pmThreadId;
      delete project.pmThreadProviderId;
      delete project.pmThreadAgentKind;
      delete project.pmThreadProfileVersion;
      delete project.pmThreadProfile;
    }
    for (const task of ctx.list('task')) {
      if (task.projectId === projectId && changed.includes(task.profile)) {
        delete task.devThreadId;
        delete task.devThreadProviderId;
        delete task.devThreadAgentKind;
        delete task.devThreadProfileVersion;
        delete task.devThreadProfile;
        ctx.put('task', task.id, task);
      }
    }
    project.ompProfiles = structuredClone(profiles);
    project.profileModes = {
      ...(project.profileModes ?? pinnedModes()),
      ...Object.fromEntries(changed.map((role) => [role, 'pinned'])),
    } as Record<ProfileName, ProfileMode>;
    ctx.put('project', projectId, project);
    ctx.event('project', '项目 OMP 模型分配已更新', { projectId });
    return project;
  });
}

export function applyProjectAgentSelection(
  ctx: StoreContext,
  projectId: string,
  selection: AgentSelection,
) {
  if (selection.mode === 'override' && !['omp', 'codex'].includes(selection.agent))
    throw new Fault('Agent 类型无效');
  return ctx.transaction(() => {
    const project = ctx.project(projectId);
    if (JSON.stringify(project.agentSelection) === JSON.stringify(selection)) return project;
    project.agentSelection = structuredClone(selection);
    project.profileVersion = (project.profileVersion ?? 0) + 1;
    delete project.pmThreadId;
    delete project.pmThreadProviderId;
    delete project.pmThreadAgentKind;
    delete project.pmThreadProfileVersion;
    delete project.pmThreadProfile;
    for (const task of ctx.list('task')) {
      if (task.projectId !== projectId) continue;
      delete task.devThreadId;
      delete task.devThreadProviderId;
      delete task.devThreadAgentKind;
      delete task.devThreadProfileVersion;
      delete task.devThreadProfile;
      ctx.put('task', task.id, task);
    }
    ctx.put('project', projectId, project);
    ctx.event('project', '项目 Agent 分配已更新', { projectId });
    return project;
  });
}

export function saveProjectProfileModes(
  ctx: StoreContext,
  projectId: string,
  modes: Record<ProfileName, ProfileMode>,
) {
  for (const role of profileNames)
    if (!['inherit', 'pinned'].includes(modes[role])) throw new Fault('Profile 模式无效');
  return ctx.transaction(() => {
    const project = ctx.project(projectId);
    const old = project.profileModes ?? pinnedModes();
    const changed = profileNames.filter((role) => old[role] !== modes[role]);
    if (changed.length) project.profileVersion = (project.profileVersion ?? 0) + 1;
    if (changed.includes('pm')) {
      delete project.pmThreadId;
      delete project.pmThreadProviderId;
      delete project.pmThreadAgentKind;
      delete project.pmThreadProfileVersion;
      delete project.pmThreadProfile;
    }
    if (changed.some((role) => ['backend', 'frontend', 'fullstack', 'complex'].includes(role)))
      for (const task of ctx.list('task')) {
        if (task.projectId !== projectId || !changed.includes(task.profile)) continue;
        delete task.devThreadId;
        delete task.devThreadProviderId;
        delete task.devThreadAgentKind;
        delete task.devThreadProfileVersion;
        delete task.devThreadProfile;
        ctx.put('task', task.id, task);
      }
    project.profileModes = structuredClone(modes);
    ctx.put('project', projectId, project);
    return project;
  });
}

export type ProjectRuntimePatch = Partial<
  Pick<
    Project,
    | 'agentSelection'
    | 'profileModes'
    | 'profiles'
    | 'ompProfiles'
    | 'secondaryReviewProfiles'
    | 'recoveryPolicy'
  >
> & { secondaryReviewProfile?: Profile | null };

export function saveProjectRuntimeConfig(
  ctx: StoreContext,
  projectId: string,
  patch: ProjectRuntimePatch,
) {
  const previous = ctx.project(projectId);
  const project = {
    ...previous,
    ...patch,
    secondaryReviewProfile:
      patch.secondaryReviewProfile === null
        ? undefined
        : (patch.secondaryReviewProfile ?? previous.secondaryReviewProfile),
  };
  validateEffectiveSecondaryReview(ctx, project);
  if (patch.secondaryReviewProfiles?.codex)
    validateCodexProvider(ctx, patch.secondaryReviewProfiles.codex, 'secondaryReview.codex');
  return ctx.transaction(() => {
    if (patch.profiles) saveProjectProfiles(ctx, projectId, patch.profiles);
    if (patch.ompProfiles) saveProjectOmpProfiles(ctx, projectId, patch.ompProfiles);
    if (patch.agentSelection) applyProjectAgentSelection(ctx, projectId, patch.agentSelection);
    if (patch.profileModes) saveProjectProfileModes(ctx, projectId, patch.profileModes);
    const current = ctx.project(projectId);
    if (patch.secondaryReviewProfile === null) delete current.secondaryReviewProfile;
    else if (patch.secondaryReviewProfile !== undefined)
      current.secondaryReviewProfile = structuredClone(patch.secondaryReviewProfile);
    if (patch.secondaryReviewProfiles !== undefined)
      current.secondaryReviewProfiles = structuredClone(patch.secondaryReviewProfiles);
    if (patch.recoveryPolicy !== undefined) current.recoveryPolicy = patch.recoveryPolicy;
    ctx.put('project', projectId, current);
    return current;
  });
}

export function resolveEffectiveProfile(
  ctx: StoreContext,
  projectId: string,
  profile: ProfileName,
  options: Pick<
    RunOptions,
    'secondaryReview' | 'secondaryProfile' | 'secondaryReviewProfile'
  > = {},
): { agentKind: AgentKind; profile: Profile } {
  const project = ctx.project(projectId);
  const settings = ctx.settings();
  const agentKind = effectiveAgent(ctx, project, settings);
  const secondaryProfile =
    options.secondaryProfile ??
    options.secondaryReviewProfile ??
    secondaryReviewProfile(project, agentKind, settings);
  if (options.secondaryReview && secondaryProfile)
    return {
      agentKind,
      profile: structuredClone(secondaryProfile),
    };
  const mode = project.profileModes?.[profile] ?? 'pinned';
  const profiles =
    mode === 'inherit'
      ? agentKind === 'omp'
        ? settings.ompProfiles
        : settings.profiles
      : agentKind === 'omp'
        ? project.ompProfiles
        : project.profiles;
  const selected = profiles?.[profile];
  if (!selected) throw new Fault(`缺少 ${agentKind} / ${profile} 模型配置`, 409);
  return { agentKind, profile: structuredClone(selected) };
}
