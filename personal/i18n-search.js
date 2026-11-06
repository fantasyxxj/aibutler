// i18n-search.js — 系统设置「联网搜索」与「使用文档」两块的文案(四种语言)。
// 单独成文件: i18n.js 已过 500 行上限, 同 i18n-quit.js 的做法。
module.exports = (UI) => {
  const add = (loc, s) => { if (UI[loc]) Object.assign(UI[loc], s); };

  add('zh-CN', {
    sys_docs: '使用文档',
    sys_docs_link: '打开使用文档 ↗',
    sys_docs_hint: '安装、接模型、配通道都在里面。不想翻文档, 直接问人格也行。',
    sys_search: '联网搜索',
    sys_search_hint: '只对用 Butler 引擎的人格有效。一个都不加, 就只用模型自带的搜索(有的模型没有)。加了就只用这里的, 从上往下试, 一家不通换下一家。',
    sys_search_engines: '搜索引擎',
    sys_search_empty: '还没加, 现在只用模型自带的搜索。',
    sys_search_disable: '禁用这些引擎, 只用模型自带的搜索(配置保留)',
    sys_search_add: '＋ 添加',
    sys_search_no_key: '不用 key',
    sys_search_test: '测一下',
    sys_search_testing: '正在搜…',
    sys_search_test_ok: '能用 · {ms}ms · {n} 条 · 第一条: {first}',
    sys_search_test_fail: '不能用: {err}',
    sys_search_need_key: '{name} 要先填 key',
    sys_search_get_key: '在中国大陆: Bing、Tavily 能直连, DuckDuckGo、Brave 要代理。key 在这里申请: Brave https://brave.com/search/api/ · Tavily https://tavily.com',
  });

  add('zh-TW', {
    sys_docs: '使用文件',
    sys_docs_link: '開啟使用文件 ↗',
    sys_docs_hint: '安裝、接模型、配通道都在裡面。不想翻文件, 直接問人格也行。',
    sys_search: '聯網搜尋',
    sys_search_hint: '只對用 Butler 引擎的人格有效。一個都不加, 就只用模型內建的搜尋(有的模型沒有)。加了就只用這裡的, 從上往下試, 一家不通換下一家。',
    sys_search_engines: '搜尋引擎',
    sys_search_empty: '還沒加, 現在只用模型內建的搜尋。',
    sys_search_disable: '停用這些引擎, 只用模型內建的搜尋(設定保留)',
    sys_search_add: '＋ 新增',
    sys_search_no_key: '不用 key',
    sys_search_test: '測一下',
    sys_search_testing: '正在搜…',
    sys_search_test_ok: '能用 · {ms}ms · {n} 筆 · 第一筆: {first}',
    sys_search_test_fail: '不能用: {err}',
    sys_search_need_key: '{name} 要先填 key',
    sys_search_get_key: '在中國大陸: Bing、Tavily 能直連, DuckDuckGo、Brave 要代理。key 在這裡申請: Brave https://brave.com/search/api/ · Tavily https://tavily.com',
  });

  add('en', {
    sys_docs: 'Docs',
    sys_docs_link: 'Open the user guide ↗',
    sys_docs_hint: 'Installing, connecting models and setting up channels are all covered (in Chinese for now). Or just ask your persona.',
    sys_search: 'Web search',
    sys_search_hint: 'Applies to personas on the Butler engine. With none added, only the model\'s built-in search is used (some models have none). Once you add engines, only these are used, top to bottom; if one fails the next is tried.',
    sys_search_engines: 'Engines',
    sys_search_empty: 'None added — only the model\'s built-in search is used.',
    sys_search_disable: 'Disable these engines and use only the model\'s built-in search (settings are kept)',
    sys_search_add: '＋ Add',
    sys_search_no_key: 'no key needed',
    sys_search_test: 'Test',
    sys_search_testing: 'Searching…',
    sys_search_test_ok: 'Works · {ms}ms · {n} results · first: {first}',
    sys_search_test_fail: 'Not working: {err}',
    sys_search_need_key: '{name} needs a key first',
    sys_search_get_key: 'In mainland China, Bing and Tavily connect directly; DuckDuckGo and Brave need a proxy. Get a key: Brave https://brave.com/search/api/ · Tavily https://tavily.com',
  });

  add('ja', {
    sys_docs: '使い方',
    sys_docs_link: '使い方ガイドを開く ↗',
    sys_docs_hint: 'インストール、モデル接続、チャネル設定をまとめています(いまは中国語のみ)。人格に直接聞いても構いません。',
    sys_search: 'ウェブ検索',
    sys_search_hint: 'Butler エンジンで動く人格にだけ効きます。何も追加しなければ、モデル内蔵の検索だけを使います(ないモデルもあります)。追加するとここのものだけを上から順に使い、だめなら次へ進みます。',
    sys_search_engines: '検索エンジン',
    sys_search_empty: 'まだありません。いまはモデル内蔵の検索だけを使います。',
    sys_search_disable: 'これらのエンジンを止めて、モデル内蔵の検索だけを使う(設定は残ります)',
    sys_search_add: '＋ 追加',
    sys_search_no_key: 'key 不要',
    sys_search_test: 'テスト',
    sys_search_testing: '検索中…',
    sys_search_test_ok: '使えます · {ms}ms · {n} 件 · 1 件目: {first}',
    sys_search_test_fail: '使えません: {err}',
    sys_search_need_key: '{name} は先に key を入力してください',
    sys_search_get_key: '中国大陸では Bing と Tavily は直接つながり、DuckDuckGo と Brave はプロキシが必要です。key の取得先: Brave https://brave.com/search/api/ · Tavily https://tavily.com',
  });
};
