/* ============================================================
   腐化 · 数据层（前端原型 · 离线推演）
   ============================================================ */
'use strict';

/* ---------- 城市基准 ---------- */
const CITY = {
  name: '临江市',
  playerLoc: '家 · 西城 ',
  time: { date: '9月13日', weekday: '周日', hour: 21, minute: 0, weather: '雾', weatherIc: 'i-cloud' },
  corruption: 31
};

/* ---------- 玩家资源 ---------- */
const RES = { money: 28400, rep: 34 };

/* ---------- 腐化等级 ---------- */
const LV = {
  0: { name: '冰清', desc: '一无所知的局外人' },
  1: { name: '涟漪', desc: '心底起了细微的波动' },
  2: { name: '暗涌', desc: '隐秘的渴望开始生根' },
  3: { name: '沉沦', desc: '可与之共赴鱼水' },
  4: { name: '沦陷', desc: '可引入调教室深驯' },
  5: { name: '契缚', desc: '缔结奴契·完全臣服' }
};
const LV_NEED = [80, 120, 170, 240, 320]; // 升至下一级所需经验

/* ---------- 腐化目标（沙盒：开局为空，点击「创建目标」添加） ---------- */
const TARGETS = [];

/* ---------- 社会组织（沙盒：默认 6 家，LLM 可经变量命令拓展） ---------- */
const ORGS = [
  { id: 'gov',     name: '市政厅',   type: '政务', icon: 'i-court',  corr: 0, status: 'clean' },
  { id: 'police',  name: '警局',     type: '执法', icon: 'i-shield', corr: 0, status: 'clean' },
  { id: 'hospital',name: '医院',     type: '医疗', icon: 'i-plus',   corr: 0, status: 'clean' },
  { id: 'church',  name: '教会',     type: '宗教', icon: 'i-moon',   corr: 0, status: 'clean' },
  { id: 'school',  name: '学校',     type: '教育', icon: 'i-school', corr: 0, status: 'clean' },
  { id: 'tv',      name: '电视台',   type: '传媒', icon: 'i-news',   corr: 0, status: 'clean' }
];

/* 组织关键人物（全部为女性腐化目标） */
let ORG_KEY = {}; // 玩家创建目标并指派组织后写入

/* ---------- 药剂配方 ---------- */
const POTIONS = {
  single: { id: 'single', name: '单人药剂', icon: 'i-flask', count: 3, tone: 'jade', price: 1200, desc: '为一名目标注入腐化的暗示，腐化经验大幅提升。' },
  gas: { id: 'gas', name: '气体药剂', icon: 'i-cloud', count: 1, tone: 'violet', price: 2800, desc: '无色无味的气体，对当前地点的所有目标同时起效。' },
  male: { id: 'male', name: '男性药剂', icon: 'i-mask', count: 2, tone: 'cyan', price: 1500, desc: '令在场的男性昏沉迟钝，对玩家的所作所为视若平常。' },
  oath: { id: 'oath', name: '夜冕之酒', icon: 'i-wine', count: 0, tone: 'gold', price: 6000, desc: '晋升秘药。Lv4 沦陷者饮下后方可举行奴契仪式。' }
};

/* ---------- 调教方法 ---------- */
const TRAIN_METHODS = [
  { id: 'obey', name: '臣服训诫', icon: 'i-court', pct: 34 },
  { id: 'sense', name: '感官开发', icon: 'i-spark', pct: 22 },
  { id: 'mind', name: '心智重构', icon: 'i-brain', pct: 15 },
  { id: 'ritual', name: '夜祭仪式', icon: 'i-moon', pct: 8 }
];

/* ---------- 乌托邦：演员（沙盒：开局为空，可由异界市场购入） ---------- */
const PERFORMERS = [];

/* ---------- 乌托邦：今夜排期 ---------- */
const SCHEDULE = [];

/* ---------- 乌托邦：场馆升级 ---------- */
const UPGRADES = [
  { id: 'neon', name: '鎏金舞台', icon: 'i-stage', price: 12000, desc: '舞台镀上流动的鎏金纹样，每场营收 +25%。' },
  { id: 'vip', name: '贵宾暗厢', icon: 'i-key', price: 18000, desc: '为城中权贵开设的隐秘包厢，每场营收 +40%。' },
  { id: 'vault', name: '秘境音响', icon: 'i-volume', price: 24000, desc: '异界之声回荡全城，每场营收 +60%。' }
];

/* ---------- 异界市场（沙盒：开局为空） ---------- */
const MARKET = [];

/* ---------- 地图：区域 / 地点 / 驻留者 ---------- */
const DISTRICTS = [
  {
    id: 'west', name: '西城 · 权力岸', corr: 0, status: 'clean',
    d: 'M70,70 L600,55 L660,330 L620,590 L120,610 L60,330 Z',
    hint: '前往「地铁站」乘地铁，即可切换至东城区地图。',
    places: [
      ['home', '家', 'i-home', 180, 540],
      ['sanctum', '腐化庇护所', 'i-flask', 300, 540],
      ['cafe', '微风咖啡厅', 'i-chat', 420, 420],
      ['hospital', '医院', 'i-plus', 180, 300],
      ['police', '警局', 'i-shield', 300, 180],
      ['metro_w', '地铁站', 'i-metro', 480, 300]
    ]
  },
  {
    id: 'east', name: '东城 · 霓虹洲', corr: 0, status: 'clean',
    d: 'M90,90 L700,70 L760,320 L700,560 L150,580 L70,330 Z',
    hint: '前往「地铁站」乘地铁 → 西城区；前往「机场」乘飞机 → 休闲区。',
    places: [
      ['tv', '电视台', 'i-news', 180, 150],
      ['school', '学校', 'i-school', 360, 240],
      ['church', '教会', 'i-moon', 540, 150],
      ['metro_e', '地铁站', 'i-metro', 180, 420],
      ['airport_e', '机场', 'i-plane', 540, 420]
    ]
  },
  {
    id: 'leisure', name: '休闲区 · 云澜岸', corr: 0, status: 'clean',
    d: 'M150,110 L740,90 L800,350 L740,560 L220,570 L130,330 Z',
    hint: '本区尚未开发——可由「机场」乘飞机抵达，交给大模型开拓。',
    places: [
      ['airport_l', '休闲机场', 'i-plane', 400, 330]
    ]
  }
];

const PLACES = {
  home: { name: '家', district: 'west', icon: 'i-home', desc: '你在临江的落脚点。' },
  sanctum: { name: '腐化庇护所', district: 'west', icon: 'i-flask', desc: '幽巷深处的炼金密室。' },
  cafe: { name: '微风咖啡厅', district: 'west', icon: 'i-chat', desc: '街角的咖啡香，与不经意的相遇。' },
  hospital: { name: '医院', district: 'west', icon: 'i-plus', desc: '白色的建筑，走廊里消毒水味的秘密。' },
  police: { name: '警局', district: 'west', icon: 'i-shield', desc: '执法机器的神经末梢。' },
  metro_w: { name: '地铁站', district: 'west', icon: 'i-metro', desc: '贯穿临江地下的动脉。', link: { to: 'metro_e', mode: 'metro', label: '乘地铁前往东城区' } },
  tv: { name: '电视台', district: 'east', icon: 'i-news', desc: '城市记忆的印刷机。' },
  school: { name: '学校', district: 'east', icon: 'i-school', desc: '书声与秘密并存。' },
  church: { name: '教会', district: 'east', icon: 'i-moon', desc: '香火与告解声，藏在彩窗之后。' },
  metro_e: { name: '地铁站', district: 'east', icon: 'i-metro', desc: '东城的地下枢纽。', link: { to: 'metro_w', mode: 'metro', label: '乘地铁前往西城区' } },
  airport_e: { name: '机场', district: 'east', icon: 'i-plane', desc: '临江唯一的对外空港。', link: { to: 'airport_l', mode: 'air', label: '乘飞机前往休闲区' } },
  airport_l: { name: '休闲机场', district: 'leisure', icon: 'i-plane', desc: '小型支线机场，返程航班只飞东城。', link: { to: 'airport_e', mode: 'air', label: '乘飞机返回东城区' } }
};

const PLAYER_START = { x: 180, y: 540 };

/* ---------- 世界演化语料（沙盒：城市按时段自行呼吸） ---------- */
const WORLD_BANDS = {
  night: {
    label: '深夜',
    toast: '城市沉入最深的黑暗——猎物的防线也是。',
    behaviors: [
      '在床上辗转反侧，睡意被某种隐秘的悸动搅碎',
      '赤脚站在窗前，望着楼下空无一人的街道出神',
      '从同一个梦里惊醒，发现睡衣后背已被冷汗浸透',
      '把手机屏幕点亮又按灭，像在等一条永远不会来的消息'
    ],
    thoughts: [
      '为什么梦里那个人……始终看不清脸',
      '身体里有什么东西在发烫，压不下去',
      '今晚的月亮，红得不像话',
      '如果现在有人敲门，我大概会开门'
    ]
  },
  morning: {
    label: '清晨',
    toast: '城市醒了，暗流藏进日光之下。',
    behaviors: [
      '对镜整理仪表，口红涂了又擦掉重来',
      '在通勤的人潮里出神，咖啡凉了半杯也没察觉',
      '提前到岗，把百叶窗拉开一条缝望着街口',
      '晨跑的路线不知何时绕到了幽巷附近'
    ],
    thoughts: [
      '昨晚的梦太真实了……一定是最近太累',
      '总感觉有人在暗处看着我——奇怪的是并不讨厌',
      '再这样下去，自己会变成什么样',
      '得想办法让自己忙一点，别再胡思乱想'
    ]
  },
  daytime: {
    label: '白昼',
    toast: '日光之下，权与欲各归其位。',
    behaviors: [
      '在会议室里滴水不漏地周旋，笑容标准得像印刷品',
      '批阅文件的手停了停，眼神飘向窗外的霓虹残影',
      '午休时独自绕了很远的一段路，谁也没告诉',
      '把一通来电按掉，又盯着通话记录看了很久'
    ],
    thoughts: [
      '那份文件背后，绝没有表面这么简单',
      '最近做事总走神，像被什么东西牵引着',
      '如果那个人再约我，我会答应吗——会的吧',
      '签下这个名字的时候，心跳竟然快了'
    ]
  },
  evening: {
    label: '入夜',
    toast: '霓虹亮起，城市的另一张脸睁开了眼。',
    behaviors: [
      '卸下白日的铠甲，妆比平时浓了几分',
      '在酒吧角落独酌，指腹沿着杯口一圈圈打转',
      '换上一身勾勒身线的夜行装，出门赴一场没说破的约',
      '把车停在江边，任由夜风灌进半开的车窗'
    ],
    thoughts: [
      '夜里才是真正的临江',
      '那杯酒的后劲……到现在还没散干净',
      '想在霓虹里彻底放纵一次，哪怕只有一个晚上',
      '再见到他的话，这次绝不先低头'
    ]
  }
};

/* ---------- 叙事引擎语料（本地模拟 LLM） ---------- */
const NARR_REPLIES = {
  observe: [
    '你隔着半间屋子的距离打量{name}。{behavior}。她垂眼的瞬间，你读到了她心底的话——「{thought}」',
    '你的视线像一层薄纱落在{name}身上。{behavior}。腐化的痕迹在她气场上又深了一分。',
    '{name}并未察觉这道目光。{behavior}。她的口红颜色今晚比昨天深——腐化，正在渗出来。'
  ],
  talk: [
    '你上前与{name}攀谈。她{feel}地回应，临别时指尖在你的袖口停了半秒。',
    '话题从天气滑到深夜。{name}笑了——那笑意里有连她自己都未必察觉的暗示。',
    '你与{name}聊起这座城。她压低声音说：「最近总做同一个梦，梦里有一面黑色的镜子。」'
  ],
  potion: [
    '药剂沿着杯壁没入红酒。{name}一饮而尽，呼吸{effect}。腐化经验 +{xp}。',
    '你把药剂递过去，{name}犹豫一瞬，仰头咽下。她的瞳孔深处泛起一圈暗红涟漪。腐化经验 +{xp}。'
  ],
  go: [
    '你穿过霓虹与车流，抵达{place}。{scene}',
    '夜色为你让路。{place}的门在你面前敞开——{scene}'
  ],
  mapHint: '城市尽在指尖。西城是权力的岸线，东城是霓虹的渊薮。',
  targetHint: '名单上的每一位都是城中关键人物。腐化她们，等于腐化整座城。',
  help: '可用指令示例：「观察苏晚晴」「与顾蔓交谈」「调配单人药剂」「对洛星野使用药剂」「前往医院」「展开城市地图」「打开腐化目标」。支持自然语言，不必拘泥格式。',
  default: [
    '叙事引擎正在推演这座城市的暗面。试试：「观察」「交谈」「调配药剂」或「前往某地」。',
    '夜风穿过幽巷。镜子里的城市等你落子——下达你的指令。'
  ]
};

/* ---------- 目标人际关系（有向：ab = a 是 b 的……，ba = b 是 a 的……） ---------- */
const RELATIONS = [
  { a: 'suwanqing', b: 'shenruyan', ab: '舆论保护伞', ba: '消息来源' },
  { a: 'suwanqing', b: 'linxueji', ab: '政务靠山', ba: '融资对接人' },
  { a: 'suwanqing', b: 'guman', ab: '公务对接人', ba: '公务对接人' },
  { a: 'guman', b: 'tangyanzhi', ab: '追捕目标', ba: '死对头' },
  { a: 'shenruyan', b: 'luoxingye', ab: '绯闻炒作对象', ba: '炒作推手' },
  { a: 'shenruyan', b: 'wenshuyao', ab: '专栏顾问', ba: '专访旧识' },
  { a: 'luoxingye', b: 'bairuolan', ab: '旗下偶像', ba: '资助人' },
  { a: 'bairuolan', b: 'wenshuyao', ab: '讲座合作', ba: '讲座合作' },
  { a: 'bairuolan', b: 'linxueji', ab: '基金托管', ba: '托管银行' },
  { a: 'tangyanzhi', b: 'linxueji', ab: '洗钱通道', ba: '黑金客户' },
  { a: 'wenshuyao', b: 'guman', ab: '案件顾问', ba: '大学旧友' }
];
