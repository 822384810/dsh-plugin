/** Locale namespace and dictionaries owned by this plugin's browser half. */

/** Namespace registered with `ctx.locale` and declared on the slot registration. */
export const NS = 'session-persona-manager'

/** Chinese dictionary; also the key set every other locale must cover. */
export const zh = {
  'action.open': '人格设定',
  'panel.title': '会话人格',
  'panel.current': '当前',
  'panel.default': '默认人格',
  'panel.empty': '还没有定义人格',
  'panel.failed': '读取人格失败',
  'panel.manage': '管理人格',
  'panel.add': '新增',
  'panel.edit': '编辑',
  'panel.delete': '删除',
  'panel.confirm': '确认',
  'panel.cancel': '取消',
  'panel.save': '保存',
  'panel.done': '完成',
  'panel.close': '关闭',
  'panel.name': '名称',
  'panel.content': '内容',
  'panel.namePlaceholder': '人格名称',
  'panel.contentPlaceholder': '请输入你的人格内容',
  'panel.nameRequired': '名称不能为空',
  'panel.defaultTag': '默认',
}

/** English dictionary. */
export const en: Record<PersonaKey, string> = {
  'action.open': 'Persona Settings',
  'panel.title': 'Session persona',
  'panel.current': 'Current',
  'panel.default': 'Default persona',
  'panel.empty': 'No persona defined',
  'panel.failed': 'Could not load personas',
  'panel.manage': 'Manage personas',
  'panel.add': 'Add',
  'panel.edit': 'Edit',
  'panel.delete': 'Delete',
  'panel.confirm': 'Confirm',
  'panel.cancel': 'Cancel',
  'panel.save': 'Save',
  'panel.done': 'Done',
  'panel.close': 'Close',
  'panel.name': 'Name',
  'panel.content': 'Content',
  'panel.namePlaceholder': 'Persona name',
  'panel.contentPlaceholder': 'Enter your persona content',
  'panel.nameRequired': 'Name is required',
  'panel.defaultTag': 'Default',
}

/** Translation keys this plugin owns. */
export type PersonaKey = keyof typeof zh
