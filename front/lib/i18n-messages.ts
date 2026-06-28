// 四语界面文案表（简体 / 繁体台湾 / 繁体香港 / 英文）。
// 这是扩展所有「写给人看」的界面字符串的唯一真理处——popup / options / welcome / content 全从这里取。
// TW 与 HK 按地区用词真正区分（如 充值：台湾「儲值」、香港「增值」；网络：台湾「網路」、香港「網絡」）。
//
// 注：目标语言「下拉里的语言名」不在这里，而在 languages-{zh,en}.json（按 locale 取简体/繁体/英文名）。
// 这里只放扩展自身 UI 文案。

import type { UiLocale } from './i18n';

/** welcome 演示页里的「原文 / 译文」对照行。 */
interface DemoLine {
  src: string;
  dst: string;
}

/** 全部界面文案的结构。带 {占位} 的用函数承载插值，保持组件侧干净。 */
export interface Messages {
  /** 品牌名（中文界面用「秒懂翻译」，英文界面用「aha translate」）。 */
  brand: string;
  /** 通用：重试。 */
  retry: string;

  popup: {
    loading: string;
    notTranslatableTitle: string;
    notTranslatableSub: string;
    settings: string; // 设置 ›
    // 账号区
    notLoggedIn: string;
    login: string;
    register: string;
    logout: string;
    emailPlaceholder: string;
    pwPlaceholder: string;
    opFailed: string;
    pleaseWait: string;
    registerAndLogin: string;
    noAccountRegister: string;
    haveAccountLogin: string;
    collapse: string;
    // 额度区
    cantReachServer: string;
    giftNewUser: string; // 新用户赠送 ¥2 翻译额度
    claiming: string;
    claim2: string; // 领取 ¥2
    serverBusy: string;
    netRetry: string;
    giftWord: string; // 余额「赠送」前缀
    balance: (parts: string) => string; // 「余额 …」
    balanceEmpty: string; // 额度已用完
    recharge: string; // 充值 ›
    // 目标语言 + 状态
    targetLang: string;
    translatingThisPage: string;
    segDoneOfTotal: (done: number, total: number) => string; // 「N / M 段」尾巴
    transReady: string; // 译文已就位
    autoOn: string; // 自动翻译已开启
    // 主按钮 + 双语
    cancelTranslate: string;
    translate: string;
    bilingualAria: string;
    bilingualTitleOn: string;
    bilingualTitleOff: string;
  };

  options: {
    docTitle: string; // 标签页标题
    titleSuffix: string; // 「秒懂翻译<设置>」里的「设置」
    lead: string;
    shortcut: string;
    notSet: string;
    shortcutBound: string;
    shortcutUnbound: string;
    modify: string; // 修改 ›
    cacheTitle: string;
    cacheAria: string;
    cacheDesc: string;
    cacheStored: (count: number, size: string) => string; // 已存 N 条 · SIZE
    cacheOff: string;
    clear: string;
    // 界面语言卡
    uiLangTitle: string;
    uiLangDesc: string;
    uiLangAuto: (name: string) => string; // 跟随浏览器（当前：X）
  };

  recharge: {
    title: string;
    balanceZero: string; // 余额 0
    loginRequired: string;
    wechatDesc: string;
    usdLine: (email: string) => string;
    usdBtn: string;
    unconfigured: string;
    loginFirst: string;
    orderFailed: string;
    paidOk: string;
    qrAlt: string;
    qrCaption: (yuan: string | number) => string;
  };

  content: {
    retryTranslate: string;
    retrying: string;
    translatingBubble: string;
    translateFailed: string;
  };

  welcome: {
    docTitle: string;
    skip: string;
    next: string;
    back: string;
    // step1
    s1Title: string;
    s1Lead: [string, string, string];
    s1Field: string;
    s1Hint: string;
    demoTitleSrc: string;
    demoTitleDst: string;
    demoLines: DemoLine[];
    demoCapSrc: string;
    demoCapDst: string;
    // step2
    s2Title: string;
    s2Lead: [string, string, string];
    s2c1: string;
    s2c2: string;
    s2ext: string;
    s2name: string;
    s2List: [string, string];
    s2Hint: string;
    // step3
    s3Title: string;
    s3PopTo: string;
    s3PopPill: string;
    s3PopToggle: string;
    s3Steps: { t: string; d: string }[];
    // step4
    s4Title: string;
    s4Lead: [string, string, string];
    s4Claim: string;
    s4Claiming: string;
    s4Done: string;
    s4DoneTail: string;
    s4Fallback: string;
    s4ErrNet: string;
    s4ErrSrv: string;
    s4CloseHint: string;
  };
}

/* ───────────────────────── 简体中文（zh-CN） ───────────────────────── */

const zhCN: Messages = {
  brand: '秒懂翻译',
  retry: '重试',
  popup: {
    loading: '读取中…',
    notTranslatableTitle: '当前页面不可翻译',
    notTranslatableSub: '仅在普通 http / https 页面生效。',
    settings: '设置 ›',
    notLoggedIn: '未登录',
    login: '登录',
    register: '注册',
    logout: '登出',
    emailPlaceholder: '邮箱',
    pwPlaceholder: '密码（至少 6 位）',
    opFailed: '操作失败',
    pleaseWait: '请稍候…',
    registerAndLogin: '注册并登录',
    noAccountRegister: '没有账号？注册',
    haveAccountLogin: '已有账号？登录',
    collapse: '收起',
    cantReachServer: '连不上服务器',
    giftNewUser: '新用户赠送 ¥2 翻译额度',
    claiming: '领取中…',
    claim2: '领取 ¥2',
    serverBusy: '服务器繁忙，请稍后重试',
    netRetry: '连不上服务器，请检查网络后重试',
    giftWord: '赠送',
    balance: (parts) => `余额 ${parts}`,
    balanceEmpty: '额度已用完',
    recharge: '充值 ›',
    targetLang: '目标语言',
    translatingThisPage: '正在翻译此页',
    segDoneOfTotal: (done, total) => `${done} / ${total} 段`,
    transReady: '译文已就位',
    autoOn: '自动翻译已开启',
    cancelTranslate: '取消翻译',
    translate: '翻译',
    bilingualAria: '双语对照',
    bilingualTitleOn: '双语对照：原文 + 译文（点击改为仅译文）',
    bilingualTitleOff: '仅译文（替换原文，点击改为双语对照）',
  },
  options: {
    docTitle: '秒懂翻译 · 设置',
    titleSuffix: '设置',
    lead: '在网页点工具栏图标即可开关整页翻译——图标变青绿＝已开启。',
    shortcut: '快捷键',
    notSet: '未设置',
    shortcutBound: '一键翻译 / 还原当前网站',
    shortcutUnbound: 'Chrome 尚未绑定，去设置一个顺手的组合',
    modify: '修改 ›',
    cacheTitle: '翻译缓存',
    cacheAria: '翻译缓存开关',
    cacheDesc: '译文只存本机、不上传服务器；重访同页秒出，且不再消耗额度。',
    cacheStored: (count, size) => `已存 ${count} 条 · ${size}`,
    cacheOff: '已关闭',
    clear: '清空',
    uiLangTitle: '界面语言',
    uiLangDesc: '扩展界面（弹窗 / 设置 / 引导）显示的语言。默认跟随浏览器首选语言。',
    uiLangAuto: (name) => `跟随浏览器（当前：${name}）`,
  },
  recharge: {
    title: '充值额度',
    balanceZero: '余额 0',
    loginRequired: '充值需登录——请先在扩展弹窗登录，余额跨设备通用。',
    wechatDesc: '微信扫码（人民币），¥1 = ¥1 翻译额度，支付后自动到账。',
    usdLine: (email) => `海外信用卡 $9.9——须用注册邮箱（${email}）付款`,
    usdBtn: '充值 $9.9 ›',
    unconfigured: '充值暂未开通',
    loginFirst: '请先在弹窗登录',
    orderFailed: '下单失败，请重试',
    paidOk: '充值成功，额度已到账。',
    qrAlt: '微信支付二维码',
    qrCaption: (yuan) => `微信扫码支付 ¥${yuan} · 支付后自动到账`,
  },
  content: {
    retryTranslate: '重试翻译',
    retrying: '重试中…',
    translatingBubble: '翻译中…',
    translateFailed: '翻译失败',
  },
  welcome: {
    docTitle: '探索秒懂翻译更多功能',
    skip: '跳过',
    next: '下一步 →',
    back: '← 上一步',
    s1Title: '打开网页，整页秒变中文',
    s1Lead: ['导航、正文、按钮、页脚——所有看得见的文字都翻。译文干净、不打扰，', '像这页本来就是中文写的', '。'],
    s1Field: '我想把网页翻成',
    s1Hint: '随时可在弹窗里改。',
    demoTitleSrc: 'A long-form essay',
    demoTitleDst: '一篇英文长文',
    demoLines: [
      { src: 'The real cost of AI is being paid', dst: 'AI 的真实成本，正由远离硅谷的人' },
      { src: 'by experts far from Silicon Valley.', dst: '在硅谷之外默默承担。' },
      { src: 'Below is an extract from the report.', dst: '以下是该报告的节选内容。' },
    ],
    demoCapSrc: '原文先垫着…',
    demoCapDst: '译文逐块淡入替换',
    s2Title: '先把图标固定到工具栏',
    s2Lead: ['秒懂翻译', '只有一个常驻接触点', '——工具栏上的图标。点一下开、再点一下关，图标自身就告诉你当前站点翻没翻。'],
    s2c1: '① 点这个拼图图标',
    s2c2: '② 点图钉固定到工具栏',
    s2ext: '扩展程序',
    s2name: '秒懂翻译 · aha translate',
    s2List: ['点浏览器右上角的拼图（扩展）图标', '在「秒懂翻译」一行点图钉，固定到工具栏'],
    s2Hint: '固定后图标常驻，照着左图操作即可。',
    s3Title: '就这么用',
    s3PopTo: '翻译为',
    s3PopPill: '简体中文',
    s3PopToggle: '翻译此页',
    s3Steps: [
      { t: '自动翻译', d: '打开网页就整页变成你选的语言——原文先垫着，译文逐块淡入替换，无需任何设置。' },
      { t: '一键开 / 关', d: '点工具栏图标开、再点一下关；关掉即刻还原原文，无需重译。也可用快捷键 ⌘ / Alt+Shift+A。' },
      { t: '随时看原文', d: 'Ctrl / ⌘ + 点击任意一段，就地在原文 ↔ 译文间切换，核对不打断阅读。' },
    ],
    s4Title: '准备好了，送你 ¥2 体验额度',
    s4Lead: ['翻译按用量从额度扣费、用完即停（没有匿名免费额度）。新装用户可免费领取', ' ¥2 ', '体验额度，用完可在弹窗里充值。'],
    s4Claim: '领取 ¥2 体验额度',
    s4Claiming: '领取中…',
    s4Done: '已到账',
    s4DoneTail: '，打开任意网页就会自动翻译。',
    s4Fallback: '检测不到浏览器标识时，会以设备标识防重领取——不影响领取。',
    s4ErrNet: '连不上服务器，请检查网络后重试。',
    s4ErrSrv: '服务器繁忙，请稍后重试。',
    s4CloseHint: '关掉本页即可开始使用。',
  },
};

/* ───────────────────────── 繁体中文·台湾（zh-TW） ───────────────────────── */
// 用词取向：充值→儲值、网络→網路、扩展程序→擴充功能、缓存→快取、设置→設定、默认→預設、服务器→伺服器。

const zhTW: Messages = {
  brand: '秒懂翻譯',
  retry: '重試',
  popup: {
    loading: '讀取中…',
    notTranslatableTitle: '目前頁面無法翻譯',
    notTranslatableSub: '僅在一般 http / https 頁面生效。',
    settings: '設定 ›',
    notLoggedIn: '未登入',
    login: '登入',
    register: '註冊',
    logout: '登出',
    emailPlaceholder: '電子郵件',
    pwPlaceholder: '密碼（至少 6 位）',
    opFailed: '操作失敗',
    pleaseWait: '請稍候…',
    registerAndLogin: '註冊並登入',
    noAccountRegister: '沒有帳號？註冊',
    haveAccountLogin: '已有帳號？登入',
    collapse: '收合',
    cantReachServer: '連不上伺服器',
    giftNewUser: '新使用者贈送 ¥2 翻譯額度',
    claiming: '領取中…',
    claim2: '領取 ¥2',
    serverBusy: '伺服器忙碌，請稍後再試',
    netRetry: '連不上伺服器，請檢查網路後再試',
    giftWord: '贈送',
    balance: (parts) => `餘額 ${parts}`,
    balanceEmpty: '額度已用完',
    recharge: '儲值 ›',
    targetLang: '目標語言',
    translatingThisPage: '正在翻譯此頁',
    segDoneOfTotal: (done, total) => `${done} / ${total} 段`,
    transReady: '譯文已就緒',
    autoOn: '自動翻譯已開啟',
    cancelTranslate: '取消翻譯',
    translate: '翻譯',
    bilingualAria: '雙語對照',
    bilingualTitleOn: '雙語對照：原文 + 譯文（點一下改為僅譯文）',
    bilingualTitleOff: '僅譯文（取代原文，點一下改為雙語對照）',
  },
  options: {
    docTitle: '秒懂翻譯 · 設定',
    titleSuffix: '設定',
    lead: '在網頁點工具列圖示即可開關整頁翻譯——圖示變青綠＝已開啟。',
    shortcut: '快捷鍵',
    notSet: '未設定',
    shortcutBound: '一鍵翻譯 / 還原目前網站',
    shortcutUnbound: 'Chrome 尚未綁定，去設定一組順手的組合',
    modify: '修改 ›',
    cacheTitle: '翻譯快取',
    cacheAria: '翻譯快取開關',
    cacheDesc: '譯文只存本機、不上傳伺服器；重訪同頁秒出，且不再消耗額度。',
    cacheStored: (count, size) => `已存 ${count} 筆 · ${size}`,
    cacheOff: '已關閉',
    clear: '清空',
    uiLangTitle: '介面語言',
    uiLangDesc: '擴充功能介面（彈出視窗 / 設定 / 導覽）顯示的語言。預設跟隨瀏覽器偏好語言。',
    uiLangAuto: (name) => `跟隨瀏覽器（目前：${name}）`,
  },
  recharge: {
    title: '儲值額度',
    balanceZero: '餘額 0',
    loginRequired: '儲值需登入——請先在擴充功能彈出視窗登入，餘額跨裝置通用。',
    wechatDesc: '微信掃碼（人民幣），¥1 = ¥1 翻譯額度，付款後自動入帳。',
    usdLine: (email) => `海外信用卡 $9.9——須用註冊電子郵件（${email}）付款`,
    usdBtn: '儲值 $9.9 ›',
    unconfigured: '儲值尚未開通',
    loginFirst: '請先在彈出視窗登入',
    orderFailed: '下單失敗，請重試',
    paidOk: '儲值成功，額度已入帳。',
    qrAlt: '微信支付 QR Code',
    qrCaption: (yuan) => `微信掃碼支付 ¥${yuan} · 付款後自動入帳`,
  },
  content: {
    retryTranslate: '重試翻譯',
    retrying: '重試中…',
    translatingBubble: '翻譯中…',
    translateFailed: '翻譯失敗',
  },
  welcome: {
    docTitle: '探索秒懂翻譯更多功能',
    skip: '略過',
    next: '下一步 →',
    back: '← 上一步',
    s1Title: '打開網頁，整頁秒變中文',
    s1Lead: ['導覽、內文、按鈕、頁尾——所有看得見的文字都翻。譯文乾淨、不打擾，', '像這頁本來就是中文寫的', '。'],
    s1Field: '我想把網頁翻成',
    s1Hint: '隨時可在彈出視窗裡改。',
    demoTitleSrc: 'A long-form essay',
    demoTitleDst: '一篇英文長文',
    demoLines: [
      { src: 'The real cost of AI is being paid', dst: 'AI 的真實成本，正由遠離矽谷的人' },
      { src: 'by experts far from Silicon Valley.', dst: '在矽谷之外默默承擔。' },
      { src: 'Below is an extract from the report.', dst: '以下是該報告的節選內容。' },
    ],
    demoCapSrc: '原文先墊著…',
    demoCapDst: '譯文逐塊淡入取代',
    s2Title: '先把圖示固定到工具列',
    s2Lead: ['秒懂翻譯', '只有一個常駐接觸點', '——工具列上的圖示。點一下開、再點一下關，圖示本身就告訴你目前站點翻了沒。'],
    s2c1: '① 點這個拼圖圖示',
    s2c2: '② 點圖釘固定到工具列',
    s2ext: '擴充功能',
    s2name: '秒懂翻譯 · aha translate',
    s2List: ['點瀏覽器右上角的拼圖（擴充功能）圖示', '在「秒懂翻譯」一列點圖釘，固定到工具列'],
    s2Hint: '固定後圖示常駐，照著左圖操作即可。',
    s3Title: '就這麼用',
    s3PopTo: '翻譯為',
    s3PopPill: '簡體中文',
    s3PopToggle: '翻譯此頁',
    s3Steps: [
      { t: '自動翻譯', d: '打開網頁就整頁變成你選的語言——原文先墊著，譯文逐塊淡入取代，無需任何設定。' },
      { t: '一鍵開 / 關', d: '點工具列圖示開、再點一下關；關掉即刻還原原文，無需重譯。也可用快捷鍵 ⌘ / Alt+Shift+A。' },
      { t: '隨時看原文', d: 'Ctrl / ⌘ + 點擊任一段，就地在原文 ↔ 譯文間切換，核對不打斷閱讀。' },
    ],
    s4Title: '準備好了，送你 ¥2 體驗額度',
    s4Lead: ['翻譯按用量從額度扣費、用完即停（沒有匿名免費額度）。新安裝使用者可免費領取', ' ¥2 ', '體驗額度，用完可在彈出視窗裡儲值。'],
    s4Claim: '領取 ¥2 體驗額度',
    s4Claiming: '領取中…',
    s4Done: '已入帳',
    s4DoneTail: '，打開任意網頁就會自動翻譯。',
    s4Fallback: '偵測不到瀏覽器識別碼時，會以裝置識別碼防重複領取——不影響領取。',
    s4ErrNet: '連不上伺服器，請檢查網路後再試。',
    s4ErrSrv: '伺服器忙碌，請稍後再試。',
    s4CloseHint: '關掉本頁即可開始使用。',
  },
};

/* ───────────────────────── 繁体中文·香港（zh-HK） ───────────────────────── */
// 与台湾的用词差异：充值→增值（台：儲值）、网络→網絡（台：網路）；其余繁体写法大体一致。

const zhHK: Messages = {
  brand: '秒懂翻譯',
  retry: '重試',
  popup: {
    loading: '讀取中…',
    notTranslatableTitle: '目前頁面無法翻譯',
    notTranslatableSub: '僅在一般 http / https 頁面生效。',
    settings: '設定 ›',
    notLoggedIn: '未登入',
    login: '登入',
    register: '註冊',
    logout: '登出',
    emailPlaceholder: '電郵',
    pwPlaceholder: '密碼（至少 6 位）',
    opFailed: '操作失敗',
    pleaseWait: '請稍候…',
    registerAndLogin: '註冊並登入',
    noAccountRegister: '沒有帳戶？註冊',
    haveAccountLogin: '已有帳戶？登入',
    collapse: '收合',
    cantReachServer: '連不上伺服器',
    giftNewUser: '新用戶贈送 ¥2 翻譯額度',
    claiming: '領取中…',
    claim2: '領取 ¥2',
    serverBusy: '伺服器繁忙，請稍後再試',
    netRetry: '連不上伺服器，請檢查網絡後再試',
    giftWord: '贈送',
    balance: (parts) => `餘額 ${parts}`,
    balanceEmpty: '額度已用完',
    recharge: '增值 ›',
    targetLang: '目標語言',
    translatingThisPage: '正在翻譯此頁',
    segDoneOfTotal: (done, total) => `${done} / ${total} 段`,
    transReady: '譯文已就緒',
    autoOn: '自動翻譯已開啟',
    cancelTranslate: '取消翻譯',
    translate: '翻譯',
    bilingualAria: '雙語對照',
    bilingualTitleOn: '雙語對照：原文 + 譯文（按一下改為僅譯文）',
    bilingualTitleOff: '僅譯文（取代原文，按一下改為雙語對照）',
  },
  options: {
    docTitle: '秒懂翻譯 · 設定',
    titleSuffix: '設定',
    lead: '在網頁按工具列圖示即可開關整頁翻譯——圖示變青綠＝已開啟。',
    shortcut: '快捷鍵',
    notSet: '未設定',
    shortcutBound: '一鍵翻譯 / 還原目前網站',
    shortcutUnbound: 'Chrome 尚未綁定，去設定一組順手的組合',
    modify: '修改 ›',
    cacheTitle: '翻譯快取',
    cacheAria: '翻譯快取開關',
    cacheDesc: '譯文只存本機、不上載伺服器；重訪同頁秒出，且不再消耗額度。',
    cacheStored: (count, size) => `已存 ${count} 條 · ${size}`,
    cacheOff: '已關閉',
    clear: '清空',
    uiLangTitle: '介面語言',
    uiLangDesc: '擴充功能介面（彈出視窗 / 設定 / 導覽）顯示的語言。預設跟隨瀏覽器偏好語言。',
    uiLangAuto: (name) => `跟隨瀏覽器（目前：${name}）`,
  },
  recharge: {
    title: '增值額度',
    balanceZero: '餘額 0',
    loginRequired: '增值需登入——請先在擴充功能彈出視窗登入，餘額跨裝置通用。',
    wechatDesc: '微信掃碼（人民幣），¥1 = ¥1 翻譯額度，付款後自動入帳。',
    usdLine: (email) => `海外信用卡 $9.9——須用註冊電郵（${email}）付款`,
    usdBtn: '增值 $9.9 ›',
    unconfigured: '增值尚未開通',
    loginFirst: '請先在彈出視窗登入',
    orderFailed: '下單失敗，請重試',
    paidOk: '增值成功，額度已入帳。',
    qrAlt: '微信支付 QR Code',
    qrCaption: (yuan) => `微信掃碼支付 ¥${yuan} · 付款後自動入帳`,
  },
  content: {
    retryTranslate: '重試翻譯',
    retrying: '重試中…',
    translatingBubble: '翻譯中…',
    translateFailed: '翻譯失敗',
  },
  welcome: {
    docTitle: '探索秒懂翻譯更多功能',
    skip: '略過',
    next: '下一步 →',
    back: '← 上一步',
    s1Title: '打開網頁，整頁秒變中文',
    s1Lead: ['導覽、內文、按鈕、頁尾——所有看得見的文字都翻。譯文乾淨、不打擾，', '像這頁本來就是中文寫的', '。'],
    s1Field: '我想把網頁翻成',
    s1Hint: '隨時可在彈出視窗裡改。',
    demoTitleSrc: 'A long-form essay',
    demoTitleDst: '一篇英文長文',
    demoLines: [
      { src: 'The real cost of AI is being paid', dst: 'AI 的真實成本，正由遠離矽谷的人' },
      { src: 'by experts far from Silicon Valley.', dst: '在矽谷之外默默承擔。' },
      { src: 'Below is an extract from the report.', dst: '以下是該報告的節選內容。' },
    ],
    demoCapSrc: '原文先墊著…',
    demoCapDst: '譯文逐塊淡入取代',
    s2Title: '先把圖示固定到工具列',
    s2Lead: ['秒懂翻譯', '只有一個常駐接觸點', '——工具列上的圖示。按一下開、再按一下關，圖示本身就告訴你目前站點翻了沒。'],
    s2c1: '① 按這個拼圖圖示',
    s2c2: '② 按圖釘固定到工具列',
    s2ext: '擴充功能',
    s2name: '秒懂翻譯 · aha translate',
    s2List: ['按瀏覽器右上角的拼圖（擴充功能）圖示', '在「秒懂翻譯」一列按圖釘，固定到工具列'],
    s2Hint: '固定後圖示常駐，照著左圖操作即可。',
    s3Title: '就這麼用',
    s3PopTo: '翻譯為',
    s3PopPill: '簡體中文',
    s3PopToggle: '翻譯此頁',
    s3Steps: [
      { t: '自動翻譯', d: '打開網頁就整頁變成你選的語言——原文先墊著，譯文逐塊淡入取代，無需任何設定。' },
      { t: '一鍵開 / 關', d: '按工具列圖示開、再按一下關；關掉即刻還原原文，無需重譯。亦可用快捷鍵 ⌘ / Alt+Shift+A。' },
      { t: '隨時看原文', d: 'Ctrl / ⌘ + 按任一段，就地在原文 ↔ 譯文間切換，核對不打斷閱讀。' },
    ],
    s4Title: '準備好了，送你 ¥2 體驗額度',
    s4Lead: ['翻譯按用量從額度扣費、用完即停（沒有匿名免費額度）。新安裝用戶可免費領取', ' ¥2 ', '體驗額度，用完可在彈出視窗裡增值。'],
    s4Claim: '領取 ¥2 體驗額度',
    s4Claiming: '領取中…',
    s4Done: '已入帳',
    s4DoneTail: '，打開任意網頁就會自動翻譯。',
    s4Fallback: '偵測不到瀏覽器識別碼時，會以裝置識別碼防重複領取——不影響領取。',
    s4ErrNet: '連不上伺服器，請檢查網絡後再試。',
    s4ErrSrv: '伺服器繁忙，請稍後再試。',
    s4CloseHint: '關掉本頁即可開始使用。',
  },
};

/* ───────────────────────── English（en） ───────────────────────── */

const en: Messages = {
  brand: 'aha translate',
  retry: 'Retry',
  popup: {
    loading: 'Loading…',
    notTranslatableTitle: 'This page can’t be translated',
    notTranslatableSub: 'Only works on regular http / https pages.',
    settings: 'Settings ›',
    notLoggedIn: 'Not signed in',
    login: 'Sign in',
    register: 'Sign up',
    logout: 'Sign out',
    emailPlaceholder: 'Email',
    pwPlaceholder: 'Password (min 6 chars)',
    opFailed: 'Something went wrong',
    pleaseWait: 'Please wait…',
    registerAndLogin: 'Sign up & sign in',
    noAccountRegister: 'No account? Sign up',
    haveAccountLogin: 'Have an account? Sign in',
    collapse: 'Collapse',
    cantReachServer: 'Can’t reach the server',
    giftNewUser: '¥2 free credit for new users',
    claiming: 'Claiming…',
    claim2: 'Claim ¥2',
    serverBusy: 'Server is busy, please try again later',
    netRetry: 'Can’t reach the server. Check your connection and try again',
    giftWord: 'Gift',
    balance: (parts) => `Balance ${parts}`,
    balanceEmpty: 'Credit used up',
    recharge: 'Top up ›',
    targetLang: 'Translate to',
    translatingThisPage: 'Translating this page',
    segDoneOfTotal: (done, total) => `${done} / ${total} blocks`,
    transReady: 'Translation ready',
    autoOn: 'Auto-translate is on',
    cancelTranslate: 'Undo',
    translate: 'Translate',
    bilingualAria: 'Bilingual view',
    bilingualTitleOn: 'Bilingual: original + translation (click for translation only)',
    bilingualTitleOff: 'Translation only (replaces original; click for bilingual)',
  },
  options: {
    docTitle: 'aha translate · Settings',
    titleSuffix: 'Settings',
    lead: 'Click the toolbar icon on any page to turn whole-page translation on or off — a teal icon means it’s on.',
    shortcut: 'Shortcut',
    notSet: 'Not set',
    shortcutBound: 'Translate / restore the current site in one press',
    shortcutUnbound: 'Chrome hasn’t bound it yet — set a combo you like',
    modify: 'Change ›',
    cacheTitle: 'Translation cache',
    cacheAria: 'Translation cache toggle',
    cacheDesc: 'Translations are stored only on your device, never uploaded; revisits are instant and cost no credit.',
    cacheStored: (count, size) => `${count} stored · ${size}`,
    cacheOff: 'Off',
    clear: 'Clear',
    uiLangTitle: 'Interface language',
    uiLangDesc: 'Language for the extension UI (popup / settings / onboarding). Follows your browser’s preferred language by default.',
    uiLangAuto: (name) => `Follow browser (now: ${name})`,
  },
  recharge: {
    title: 'Top up credit',
    balanceZero: 'Balance 0',
    loginRequired: 'Top-up requires sign-in — sign in from the popup first; your balance works across devices.',
    wechatDesc: 'WeChat QR (CNY), ¥1 = ¥1 of translation credit, credited automatically after payment.',
    usdLine: (email) => `Card $9.9 — must pay with your registered email (${email})`,
    usdBtn: 'Top up $9.9 ›',
    unconfigured: 'Top-up not available yet',
    loginFirst: 'Please sign in from the popup first',
    orderFailed: 'Order failed, please try again',
    paidOk: 'Payment received, credit added.',
    qrAlt: 'WeChat Pay QR code',
    qrCaption: (yuan) => `Scan with WeChat to pay ¥${yuan} · credited automatically`,
  },
  content: {
    retryTranslate: 'Retry translation',
    retrying: 'Retrying…',
    translatingBubble: 'Translating…',
    translateFailed: 'Translation failed',
  },
  welcome: {
    docTitle: 'Explore aha translate',
    skip: 'Skip',
    next: 'Next →',
    back: '← Back',
    s1Title: 'Open any page — read it in your language',
    s1Lead: ['Nav, body, buttons, footer — every visible word is translated. Clean and unobtrusive, ', 'as if the page were written in your language', '.'],
    s1Field: 'Translate pages into',
    s1Hint: 'You can change this anytime in the popup.',
    demoTitleSrc: '一篇中文长文',
    demoTitleDst: 'A long-form essay',
    demoLines: [
      { src: '人工智能的真实成本，', dst: 'The real cost of AI is being paid' },
      { src: '正由远离硅谷的人默默承担。', dst: 'by experts far from Silicon Valley.' },
      { src: '以下是该报告的节选内容。', dst: 'Below is an extract from the report.' },
    ],
    demoCapSrc: 'Original shown first…',
    demoCapDst: 'Translation fades in, block by block',
    s2Title: 'First, pin the icon to your toolbar',
    s2Lead: ['aha translate has ', 'just one place you touch', ' — the toolbar icon. Click to turn on, click again to turn off; the icon itself tells you whether the current site is translated.'],
    s2c1: '① Click the puzzle icon',
    s2c2: '② Click the pin to add it',
    s2ext: 'Extensions',
    s2name: 'aha translate · 秒懂翻译',
    s2List: ['Click the puzzle (Extensions) icon at the top-right', 'Click the pin next to “aha translate” to add it to the toolbar'],
    s2Hint: 'Once pinned the icon stays put — just follow the picture on the left.',
    s3Title: 'How it works',
    s3PopTo: 'Translate to',
    s3PopPill: 'Simplified Chinese',
    s3PopToggle: 'Translate this page',
    s3Steps: [
      { t: 'Automatic translation', d: 'Open a page and the whole thing turns into your language — original shown first, translation fading in block by block. No setup needed.' },
      { t: 'One click on / off', d: 'Click the toolbar icon to turn on, click again to turn off; the original is restored instantly, no re-translation. Shortcut: ⌘ / Alt+Shift+A.' },
      { t: 'See the original anytime', d: 'Ctrl / ⌘ + click any paragraph to toggle between original and translation in place, without breaking your reading.' },
    ],
    s4Title: 'You’re all set — here’s ¥2 to start',
    s4Lead: ['Translation is billed by usage from your balance and stops when it runs out (no anonymous free tier). New users can claim', ' ¥2 ', 'to get started; top up in the popup when it runs out.'],
    s4Claim: 'Claim ¥2 credit',
    s4Claiming: 'Claiming…',
    s4Done: 'Added',
    s4DoneTail: ' — open any web page and it translates automatically.',
    s4Fallback: 'If a browser identifier isn’t available, your device identifier guards against duplicate claims — claiming still works.',
    s4ErrNet: 'Can’t reach the server. Check your connection and try again.',
    s4ErrSrv: 'Server is busy. Please try again in a moment.',
    s4CloseHint: 'Close this page to start using.',
  },
};

export const MESSAGES: Record<UiLocale, Messages> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  en,
};
