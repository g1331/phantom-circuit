import type { TeamInstructionSections } from './types.ts';

/** Total UTF-16 code units across the three sections, matching textarea length. */
export const TEAM_INSTRUCTIONS_LIMIT = 16000;
export const teamInstructionKeys = ['repository', 'engineering', 'delivery'] as const;
export function teamInstructionsLength(sections: TeamInstructionSections) {
  return teamInstructionKeys.reduce((length, key) => length + sections[key].length, 0);
}
