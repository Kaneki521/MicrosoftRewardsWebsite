import { defineConfig } from 'wxt';

// The reading task talks to these two origins from the background. MV3 keeps
// cross-origin grants in `host_permissions`; MV2 (Firefox) has no such key and
// expects the same origins inside `permissions`, so the manifest is built per
// target instead of guessing.
const READ_HOST_PERMISSIONS = [
  'https://login.live.com/*',
  'https://prod.rewardsplatform.microsoft.com/*',
];

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  alias: { '@': '.' },
  manifest: ({ manifestVersion }) => ({
    name: 'Rewards 助手',
    description: '按当前设置自动完成 Microsoft Rewards 的搜索、每日活动、积分领取和阅读任务。',
    permissions: manifestVersion === 2
      ? ['storage', 'alarms', ...READ_HOST_PERMISSIONS]
      : ['storage', 'alarms'],
    ...(manifestVersion === 3 ? { host_permissions: READ_HOST_PERMISSIONS } : {}),
    icons: { 16: 'imgs/logo.png', 32: 'imgs/logo32.png', 48: 'imgs/logo2.png', 128: 'imgs/logo3.png' },
    action: {
      default_icon: { 16: 'imgs/logo.png', 32: 'imgs/logo32.png', 48: 'imgs/logo2.png', 128: 'imgs/logo3.png' },
      default_title: 'Rewards 助手',
    },
    browser_specific_settings: {
      gecko: { id: 'microsoft_automatic_rewards@example.com', strict_min_version: '91.0' },
    },
  }),
});
