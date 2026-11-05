// i18n-search.js — 系统设置「联网搜索」区块的文案(四种语言)。
// 单独成文件: i18n.js 已过 500 行上限, 同 i18n-quit.js 的做法。
module.exports = (UI) => {
  const add = (loc, s) => { if (UI[loc]) Object.assign(UI[loc], s); };

  add('zh-CN', {
    sys_search: '联网搜索',
    sys_search_hint: '只对用 Butler 引擎的人格有效。默认先用模型服务端自带的搜索, 搜不了再在本机搜。配了 key 并选它优先, 就只用这把 key 搜。',
    sys_search_prefer: '优先用',
    sys_search_prefer_auto: '服务端优先(默认)',
    sys_search_need_key: '要优先用 {name}, 先填它的 key',
    sys_search_get_key: 'key 在这里申请: Brave https://brave.com/search/api/ · Tavily https://tavily.com',
  });

  add('zh-TW', {
    sys_search: '聯網搜尋',
    sys_search_hint: '只對用 Butler 引擎的人格有效。預設先用模型服務端內建的搜尋, 搜不了再在本機搜。配了 key 並選它優先, 就只用這把 key 搜。',
    sys_search_prefer: '優先用',
    sys_search_prefer_auto: '服務端優先(預設)',
    sys_search_need_key: '要優先用 {name}, 先填它的 key',
    sys_search_get_key: 'key 在這裡申請: Brave https://brave.com/search/api/ · Tavily https://tavily.com',
  });

  add('en', {
    sys_search: 'Web search',
    sys_search_hint: 'Applies to personas on the Butler engine. By default the model provider\'s own search is tried first, with a local search as fallback. Add a key and mark it preferred to search only with that key.',
    sys_search_prefer: 'Prefer',
    sys_search_prefer_auto: 'Provider search first (default)',
    sys_search_need_key: 'Enter a {name} key before preferring it',
    sys_search_get_key: 'Get a key: Brave https://brave.com/search/api/ · Tavily https://tavily.com',
  });

  add('ja', {
    sys_search: 'ウェブ検索',
    sys_search_hint: 'Butler エンジンで動く人格にだけ効きます。既定ではモデル提供側の検索を先に使い、だめなら手元で検索します。key を入れて優先にすると、その key だけで検索します。',
    sys_search_prefer: '優先',
    sys_search_prefer_auto: '提供側の検索を優先(既定)',
    sys_search_need_key: '{name} を優先するには、先にその key を入力してください',
    sys_search_get_key: 'key の取得先: Brave https://brave.com/search/api/ · Tavily https://tavily.com',
  });
};
