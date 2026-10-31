/** Copy dictionaries for the host-wide and Session pause surfaces. */

/** Locale namespace owned by this plugin's browser surfaces. */
export const NS = 'sessionPause'

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  locale: 'zh-CN',
  pause: '暂停全部',
  resume: '恢复全部',
  'pause.hint': '暂停所有会话、子 agent 和 goal 的模型活动',
  'resume.hint': '结束全局暂停；单独暂停的会话保持暂停',
  'session.pause': '暂停此会话',
  'session.resume': '恢复此会话',
  'session.pause.hint': '暂停此会话及其子 agent 的模型活动',
  'dock.title': '此会话已暂停',
  unavailable: '暂停状态不可用',
  'banner.title': '已暂停',
  'banner.since': '{time} 起',
  'banner.held': '{count} 项在等待',
  'banner.resume': '恢复',
  'error.pause': '暂停失败：{message}',
  'error.resume': '恢复失败：{message}',
  'error.pause-session': '暂停此会话失败：{message}',
  'error.resume-session': '恢复此会话失败：{message}',
} as const

/** Keys of the dictionaries. */
export type SessionPauseLocaleKey = keyof typeof zh

/** English dictionary. */
export const en: Record<SessionPauseLocaleKey, string> = {
  locale: 'en-US',
  pause: 'Pause all',
  resume: 'Resume all',
  'pause.hint': 'Pause model activity of every session, subagent, and goal',
  'resume.hint': 'End the host-wide pause; sessions paused one by one stay paused',
  'session.pause': 'Pause this session',
  'session.resume': 'Resume this session',
  'session.pause.hint': 'Pause model activity of this session and its subagents',
  'dock.title': 'This session is paused',
  unavailable: 'Pause status unavailable',
  'banner.title': 'Paused',
  'banner.since': 'since {time}',
  'banner.held': '{count} waiting',
  'banner.resume': 'Resume',
  'error.pause': 'Could not pause: {message}',
  'error.resume': 'Could not resume: {message}',
  'error.pause-session': 'Could not pause this session: {message}',
  'error.resume-session': 'Could not resume this session: {message}',
}
