import { AsyncLocalStorage } from 'node:async_hooks';
import type { LearningPolicy } from '../learning/learning.policy.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { PromptContent } from './admin.prompt-config.js';

export const adminRuntimeContext = new AsyncLocalStorage<
  ProfileScope & {
    requestId: string;
    policy?: LearningPolicy;
    prompts: Record<string, PromptContent & { id: string }>;
  }
>();
// One immutable context per request. No mutable process-wide policy or user scope.
export function runtimeLearningPolicy(base: LearningPolicy): LearningPolicy {
  return new Proxy(base, {
    get(target, key, receiver) {
      const selected = adminRuntimeContext.getStore()?.policy ?? target;
      return Reflect.get(selected, key, selected === target ? receiver : selected);
    },
  });
}
