<script setup lang="ts">
import { computed } from "vue";
import { glossary } from "../data/glossary";

const props = defineProps<{
  /** Glossary lookup ID (e.g., "rpc", "policy-engine") */
  id?: string;
  /** Inline definition override — takes precedence over glossary */
  t?: string;
}>();

const entry = computed(() => (props.id ? glossary[props.id] : undefined));

const definition = computed(() => {
  if (props.t) return props.t;
  return entry.value?.definition ?? "";
});

const hasDefinition = computed(() => definition.value.length > 0);
</script>

<template>
  <span
    v-if="hasDefinition"
    class="term-tooltip"
    tabindex="0"
    role="button"
    :aria-label="`Definition: ${definition}`"
  >
    <slot>{{ entry?.term ?? "" }}</slot>
    <span class="term-tooltip__popup" role="tooltip" aria-hidden="true">
      {{ definition }}
    </span>
  </span>
  <slot v-else />
</template>

<style scoped>
@import "../styles/tooltip.css";
</style>
