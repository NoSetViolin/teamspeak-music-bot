<template>
  <div v-if="sources.length >= 2" class="source-tabs">
    <button
      v-for="src in sources"
      :key="src"
      type="button"
      class="source-tab"
      :class="{ active: src === modelValue }"
      @click="$emit('update:modelValue', src)"
    >
      {{ LABELS[src] }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { Source } from '../stores/player.js';

const LABELS: Record<Source, string> = {
  netease: '网易云',
  qq: 'QQ',
};

defineProps<{
  modelValue: Source;
  sources: Source[];
}>();

defineEmits<{
  'update:modelValue': [value: Source];
}>();
</script>

<style lang="scss" scoped>
.source-tabs {
  display: inline-flex;
  gap: 4px;
  margin-left: 12px;
  align-items: center;
}

.source-tab {
  padding: 4px 10px;
  min-height: 28px;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--hover-bg);
  }

  &.active {
    color: var(--color-primary);
    background: var(--color-primary-12);
    font-weight: var(--fw-semi);
  }
}

@media (max-width: 768px) {
  .source-tabs {
    margin-left: 8px;
    gap: 2px;
  }

  .source-tab {
    padding: 6px 10px;
    min-height: 36px; // larger touch target on mobile
    font-size: var(--fs-xs);
  }
}
</style>
