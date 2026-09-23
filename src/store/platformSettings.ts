import { create } from 'zustand';

export const CHATBOT_PLATFORMS = ['suri', 'evolution_api', 'kommo', 'take_blip', 'manychat', 'weni'] as const;
export const ECOMMERCE_PLATFORMS = ['shopify', 'woocommerce', 'tray', 'nuvemshop', 'olist', 'vtex', 'maxdata', 'custom'] as const;

export type PlatformKey = typeof CHATBOT_PLATFORMS[number] | typeof ECOMMERCE_PLATFORMS[number];

interface PlatformSettingsState {
  platforms: Record<string, boolean>;
  loaded: boolean;
  isPlatformEnabled: (key: string) => boolean;
  setSettings: (platforms: Record<string, boolean>) => void;
  reset: () => void;
}

export const usePlatformSettingsStore = create<PlatformSettingsState>()((set: (partial: Partial<PlatformSettingsState>) => void, get: () => PlatformSettingsState) => ({
  platforms: {},
  loaded: false,
  isPlatformEnabled: (key: string) => {
    const { platforms, loaded } = get();
    // While not yet loaded, show all (optimistic)
    if (!loaded) return true;
    // If a key was never explicitly set in DB → enabled by default
    return platforms[key] !== false && platforms[key] !== "false";
  },
  setSettings: (platforms) => set({ platforms, loaded: true }),
  reset: () => set({ platforms: {}, loaded: false }),
}));
