// 轻量埋点。按 config 注入第三方统计 + 统一 track() 自定义事件。provider 为空则全部 no-op。
import { CONFIG } from './config.js';
let inited = false;

export function initAnalytics() {
  const a = CONFIG.analytics;
  if (inited || !a.provider) return;
  inited = true;
  try {
    if (a.provider === 'baidu' && a.id) {
      window._hmt = window._hmt || [];
      const s = document.createElement('script'); s.async = true;
      s.src = 'https://hm.baidu.com/hm.js?' + a.id;
      document.head.appendChild(s);
    } else if (a.provider === '51la' && a.id) {
      const s = document.createElement('script'); s.async = true; s.charset = 'UTF-8'; s.id = 'LA_COLLECT';
      s.src = '//sdk.51.la/js-sdk-pro.min.js';
      s.onload = () => window.LA && window.LA.init({ id: a.id, ck: a.id });
      document.head.appendChild(s);
    } else if (a.provider === 'umami' && a.id && a.umamiSrc) {
      const s = document.createElement('script'); s.async = true; s.defer = true;
      s.src = a.umamiSrc; s.setAttribute('data-website-id', a.id);
      document.head.appendChild(s);
    } else if (a.provider === 'custom' && a.endpoint) {
      track('pageview');   // 第三方会自动记 PV，custom 手动记一次
    }
  } catch (e) { /* 埋点失败不影响功能 */ }
}

export function track(event, props) {
  const a = CONFIG.analytics;
  try {
    if (a.provider === 'baidu' && window._hmt)
      window._hmt.push(['_trackEvent', 'beadgo', event, JSON.stringify(props || {})]);
    else if (a.provider === 'umami' && window.umami) window.umami.track(event, props);
    else if (a.provider === '51la' && window.LA && window.LA.track) window.LA.track(event, props);
    else if (a.provider === 'custom' && a.endpoint && navigator.sendBeacon)
      navigator.sendBeacon(a.endpoint, JSON.stringify(
        { event, props: props || {}, t: Date.now(), path: location.pathname, ref: document.referrer }));
  } catch (e) { /* ignore */ }
  if (!a.provider) console.debug('[track]', event, props || '');
}
