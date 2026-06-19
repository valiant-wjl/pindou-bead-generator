// 站点配置（控制 AI 模式 + 埋点）。商业试水 / 开源版只改这一个文件。
export const CONFIG = {
  // AI 转绘模式：
  //  'disabled' = 关闭，仅展示 demo 效果 + 「感兴趣」按钮收集需求（商业试水 v1，不扣你的钱）
  //  'byok'     = 访客填自己的 OpenRouter key，谁用谁付费（开源版推荐）
  //  'enabled'  = 用站点自带 key（会扣你的钱，需配合后端限流/计费，暂不建议）
  aiMode: 'disabled',
  aiDemo: './assets/ai-demo.png',   // AI 关闭时展示的 demo 效果图

  // 埋点。开源版留空即全关；商业部署时填你自己的统计 ID。
  analytics: {
    provider: '',   // 'baidu' | '51la' | 'umami' | 'custom' | '' (关闭)
    id: '',         // 百度统计 hm id / 51.la id / umami websiteId
    umamiSrc: '',   // umami 自部署脚本地址
    endpoint: '',   // custom: 你自己的埋点接收地址（用 sendBeacon 上报）
  },
};
