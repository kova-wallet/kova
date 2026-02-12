import DefaultTheme from "vitepress/theme";
import Term from "./components/Term.vue";
import type { Theme } from "vitepress";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Term", Term);
  },
} satisfies Theme;
