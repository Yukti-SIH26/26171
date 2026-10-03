import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';

/**
 * Background orchestrator.
 *
 * On Chrome this is an MV3 service worker: ephemeral, killed after ~30s idle,
 * no DOM. On Firefox MV3 it is a non-persistent event page. Neither can hold
 * long-lived state or run a model, so this file stays an orchestrator only.
 * Anything stateful belongs in storage; anything heavy belongs in the model host.
 *
 * The side panel is opened two different ways because the APIs differ:
 *   Chrome  - sidePanel.setPanelBehavior, so the toolbar icon opens it natively
 *   Firefox - sidebarAction.toggle() from an action click handler
 */
export default defineBackground({
  type: 'module',

  main() {
    const api = browser as unknown as {
      sidePanel?: {
        setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>;
      };
      sidebarAction?: { toggle?: () => Promise<void> };
      action?: { onClicked?: { addListener: (cb: () => void) => void } };
    };

    if (api.sidePanel?.setPanelBehavior !== undefined) {
      // Chrome: let the toolbar button open the panel without a click handler,
      // which also preserves the user-gesture needed for activeTab.
      api.sidePanel
        .setPanelBehavior({ openPanelOnActionClick: true })
        .catch((error: unknown) => {
          console.error('[yukti] failed to set side panel behavior', error);
        });
    } else if (api.action?.onClicked !== undefined && api.sidebarAction?.toggle !== undefined) {
      // Firefox: sidebarAction has no equivalent auto-open behaviour.
      api.action.onClicked.addListener(() => {
        api.sidebarAction?.toggle?.().catch((error: unknown) => {
          console.error('[yukti] failed to toggle sidebar', error);
        });
      });
    }

    browser.runtime.onInstalled.addListener((details) => {
      console.warn(
        `[yukti] installed (${details.reason}) on ${import.meta.env.BROWSER} ` +
          `MV${String(import.meta.env.MANIFEST_VERSION)}`,
      );
    });
  },
});
