export const priorityLevels = ['low', 'normal', 'high', 'urgent'] as const;
export type PriorityLevel = (typeof priorityLevels)[number];
export const priorityValues: Record<PriorityLevel, number> = {
  low: -5,
  normal: 0,
  high: 5,
  urgent: 10,
};
export type PriorityLocale = 'zh-CN' | 'en';
export const priorityNames = {
  'zh-CN': { low: '低', normal: '普通', high: '高', urgent: '紧急' },
  en: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
};
export function priorityLabel(value: number, locale: PriorityLocale) {
  const level = priorityLevels.find((level) => priorityValues[level] === value);
  return level
    ? priorityNames[locale][level]
    : locale === 'en'
      ? `Legacy priority ${value} (higher numbers first)`
      : `旧版优先级 ${value}（数值越大越优先）`;
}
type PriorityOrder = {
  priority: number;
  createdAt: string;
  id: string;
  legacyPriorityOrder?: number;
};
export function comparePriority(a: PriorityOrder, b: PriorityOrder) {
  const primary = b.priority - a.priority || a.createdAt.localeCompare(b.createdAt);
  if (primary) return primary;
  if (a.legacyPriorityOrder !== undefined || b.legacyPriorityOrder !== undefined) {
    if (a.legacyPriorityOrder === undefined) return 1;
    if (b.legacyPriorityOrder === undefined) return -1;
    const legacy = a.legacyPriorityOrder - b.legacyPriorityOrder;
    if (legacy) return legacy;
  }
  return a.id.localeCompare(b.id);
}
export interface PriorityChange {
  requestId: string;
  expectedVersion: number;
  oldValue: number | null;
  newValue: number;
  reason: string;
  actor: 'user' | 'pm';
  sourceMessageId?: string;
  runId?: string;
  at: string;
}
