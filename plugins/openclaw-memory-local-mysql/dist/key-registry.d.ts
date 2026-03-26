export type MemoryScope = 'global' | 'project' | 'session';
export type KeyUniqueness = 'single_active' | 'multi_active';
export interface MemoryKeyRule {
    key: string;
    domain: 'user' | 'plugin' | 'project' | 'environment' | 'deployment' | 'workflow' | 'session';
    scopeDefault: MemoryScope;
    uniqueness: KeyUniqueness;
}
export declare const MEMORY_KEY_RULES: MemoryKeyRule[];
export declare function getMemoryKeyRule(key?: string | null): MemoryKeyRule | null;
export declare function isSingleActiveKey(key?: string | null): boolean;
