/**
 * seed 用的静态语料：昵称与足迹文案模板。纯数据，不含随机逻辑（抽取顺序由调用方的 Rng 决定），
 * 内容均为占位性质，不对应真实用户或真实事件。
 */

export const NICKNAMES: readonly string[] = [
  "阿彪", "小满", "远山", "闲云", "拾光", "青禾", "旧巷", "望舒", "知了", "南栀",
  "北渚", "浮生", "落雪", "听雨", "归鸿", "旅笔", "拾贝", "晚风", "长亭", "半程",
  "云归", "尘游", "浅笑", "行者", "灯火", "石桥", "青川", "暮雪", "初晴", "野渡",
];

/** {place} 会被替换为落脚地点名称。 */
export const STORY_TEMPLATES: readonly string[] = [
  "在{place}走了很久，风很好。",
  "路过{place}，随手记一笔。",
  "{place}的傍晚意外地安静。",
  "又来{place}了，还是喜欢这里。",
  "{place}人不多，逛得很松弛。",
  "在{place}吃了顿饭，味道不错。",
  "{place}的光线很适合拍照。",
  "临时起意，去了趟{place}。",
  "{place}比想象中好逛。",
  "在{place}坐了一下午。",
  "{place}的老房子很有味道。",
  "路线临时改到{place}，值得。",
];

export function fillStory(template: string, placeName: string): string {
  return template.replace("{place}", placeName);
}
