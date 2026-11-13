/* ============================================================
   云工作台 - 主逻辑 v4
   紫白简约风 · 13页面 · 左侧纵向导航
   ============================================================ */
'use strict';

/* ---------- 数据持久化 ---------- */
const DATA_VERSION = 2;
const STORE_KEY = 'shangan_workbench_data';

/* 同步状态变量前移到 loadData 之前：加载早期 save()（如数据迁移 migrateFujianExamDate）会用到 dirtySincePush/bootPullPending/syncTimer 等，
   若用 let/const 在后面声明会触发暂时性死区(TDZ) ReferenceError，导致初始化中断、整页白屏 */
let syncTimer=null;
let pollTimer=null;
let bootPullPending=true;
let dirtySincePush=false;
let lastPush=0;
const AUTO_PUSH_DEBOUNCE=2*60*1000;
const AUTO_PULL_INTERVAL=30*1000;

/* 规范词分类改版（2026-09-10）：旧分类 → 新分类。只改 cat，不删任何一条自己加的词。
   放在文件顶部：迁移在初始化早期就被调用，const 声明在后面会触发 TDZ 白屏 */
const GUIFAN_CAT_MAP={
  '经济发展':'产业发展','科技创新':'产业发展',
  '社会民生':'民生福祉',
  '文化文明':'文化发展',
  '生态文明':'绿色发展',
  '治理能力':'基层治理',
  '政治建设':'政务服务','常用动词':'政务服务'
};

/* ---------- 全局常量（魔法数字集中管理） ---------- */
const CONST = {
  SYNC_DEBOUNCE: 900,          // 同步防抖延迟（ms）
  MAX_SYNC_SIZE: 90000,        // 同步数据最大字节数（超过则剥离图片）
  LOCAL_STORAGE_WARN: 4*1024*1024, // localStorage 容量警告阈值（4MB，上限约5MB）
  NET_RETRY_COUNT: 2,          // 网络请求重试次数
  NET_RETRY_DELAY: 1000        // 网络请求重试间隔（ms）
};
function loadData(){
  let saved=null;
  try{ saved=JSON.parse(localStorage.getItem(STORE_KEY)); }catch(e){}
  const base={
    version:DATA_VERSION,
    examDates:Object.fromEntries(EXAMS.map(e=>[e.key,e.date])),
    exams:EXAMS.map(e=>({key:e.key,name:e.name,date:e.date})), // 考试定义（含自定义），持久化
    studyRecords:{},      // {date:{sessions:[]}}
    todos:{},             // {date:[{id,text,done}]}
    summaries:{},         // {date:'text'}
    dailyStats:{},         // {date:{section:{count,rate,subs:{}}}}  rate 为 0-100 百分比
    dailyTasks: CHECKIN_CATEGORIES.map(k=>({id:'def_'+k,type:'module',sec:k,sub:null,name:SECTION_MAP[k].name,target:null})),
    examRecords:[],         // 行测套卷复盘记录 [{id,date,name,score,percentile,rates:{题型:0.x}}]
    periodReviews:{},       // 周期复盘小结 {periodKey:{text,ts}}
    pomoNoPromptDate:'',    // 番茄钟结束后勾选「今天不再提示录入」的日期
    shenlunReviews:[],      // 申论批改/得分记录 [{id,date,type,label,teacher,score,conclusion,points:[],advice:[],origin}]  type=题型(薄弱分析维度),origin=来源(豆包/手动)
    userProfile:{name:'局长',signature:'星光不问赶路人，时光不负有心人',avatar:''},
    customData:{            // 用户导入的自定义内容，按模块分类
      maoQuotes:[],         // {text,source}
      idioms:[],            // 成语·辨析 {a,b,diff,example,id}
      shiciPairs:[],        // 实词·辨析 {a,b,diff,example,id}
      idiomWords:[],        // 成语·积累 {word,meaning,example,stage,id}
      shiciWords:[],        // 实词·积累 {word,meaning,example,stage,id}
      politicsNews:[],      // {title,summary,point,source,url}
      politicsQuestions:[], // {cat,q,a}
      changshi:[],          // {cat,items:[{q,a}]}
      quant:[],             // {name,formulas,example,solution}
      dataFormulas:[],      // {name,formula}
      shenlunXiaoti:[],     // {type,question,material,answer,analysis}
      shenlunDazuowen:[],   // {theme,materials,cases,quotes}
      shenlunGuifan:[]      // {cat,term,use} 申论规范词/规范表述
    },
    deletedBuiltin:{},      // 被删除的内置内容索引，按内容类型分类 {key:[index,...]}
    weakTargets:{},         // 薄弱考点自定义目标正确率 {key: percent}
    countTargets:{},        // 目标题量 {key: 题数}，与 durTargets 配对算出标准速度（分钟/题）
    /* 课程（听课进度，只记讲数不记时间）：{id,name,teacher,section,total,note,createdAt,done:[{n,ts,date}]} n=第几讲；网课只记录听到了第几讲，不记时长——听课要搭配做题/笔记，真实学习时长用番茄钟更有意义 */
    courses:[],
    timetable:[],           // 课程表 [{id,name,period,time,module,repeat,weekday,date,createdAt}] 周历查看+月历安排，repeat=weekly每周固定/once仅这一天
    learnStage:{},          // 内容学习状态 {内容key:{条目key:'new'|'learning'|'mastered'}}，未学不存（省空间）
    setVolume:Object.assign({},DEFAULT_SET_VOLUME), // 「一组/一套」折多少题（按模块，可自己改）
    weakTargetsMts:{},durTargetsMts:{},countTargetsMts:{}, // 目标值修改时间戳，用于多端 LWW 合并
    userProfileMts:{},setVolumeMts:{},examDatesMts:{},summariesMts:{},checkinHiddenMts:{}, // 设置类偏好按项修改时间戳
    checkinHidden:[],       // 不参与打卡显示的分类（空 = 全部显示）
    pomo:{duration:25,custom:false,section:'yanyu',remaining:0,running:false,done:false,endAt:null,startTs:null,kind:'focus'} // 番茄钟进度（持久化：duration/custom/section/remaining/done/endAt/startTs/running/overtime/kind；review正计时用 startTs，focus/break倒计时用 endAt）。remaining 默认 0 = 没启动过就别显示浮窗
  };
  if(saved){
    return Object.assign(base,saved,{
      version:DATA_VERSION,
      examDates:Object.assign(base.examDates,saved.examDates||{}),
      exams:(saved.exams&&saved.exams.length)?saved.exams:base.exams,
      studyRecords:Object.assign({},saved.studyRecords||{}),
      todos:(saved.todos!==undefined&&saved.todos!==null)?saved.todos:base.todos,
      summaries:Object.assign({},saved.summaries||{}),
      dailyStats:Object.assign({},saved.dailyStats||{}),
      dailyTasks:Array.isArray(saved.dailyTasks)?saved.dailyTasks:(base.dailyTasks||[]),
      examRecords:(Array.isArray(saved.examRecords)?saved.examRecords:[]),
      courses:(Array.isArray(saved.courses)?saved.courses:[]),
      periodReviews:Object.assign({},saved.periodReviews||{}),
      pomoNoPromptDate:saved.pomoNoPromptDate||'',
      userProfile:(function(){var p=Object.assign({name:'局长',signature:'星光不问赶路人，时光不负有心人',avatar:''},saved.userProfile||{});return p;})(),
      customData:Object.assign({
        maoQuotes:[],idioms:[],shiciPairs:[],idiomWords:[],shiciWords:[],politicsNews:[],
        politicsQuestions:[],changshi:[],quant:[],dataFormulas:[],
        shenlunXiaoti:[],shenlunDazuowen:[],shenlunGuifan:[]
      },saved.customData||{}),
      deletedBuiltin:Object.assign({},saved.deletedBuiltin||{}),
      weakTargets:Object.assign({},saved.weakTargets||{}),
      countTargets:Object.assign({},saved.countTargets||{}),
      weakTargetsMts:Object.assign({},saved.weakTargetsMts||{}),
      durTargetsMts:Object.assign({},saved.durTargetsMts||{}),
      countTargetsMts:Object.assign({},saved.countTargetsMts||{}),
      userProfileMts:Object.assign({},saved.userProfileMts||{}),
      setVolumeMts:Object.assign({},saved.setVolumeMts||{}),
      examDatesMts:Object.assign({},saved.examDatesMts||{}),
      summariesMts:Object.assign({},saved.summariesMts||{}),
      checkinHiddenMts:Object.assign({},saved.checkinHiddenMts||{}),
      learnStage:(saved.learnStage&&typeof saved.learnStage==='object'&&!Array.isArray(saved.learnStage))?saved.learnStage:{},
      setVolume:Object.assign({},DEFAULT_SET_VOLUME,saved.setVolume||{}),
      checkinHidden:Array.isArray(saved.checkinHidden)?saved.checkinHidden:[],
      pomo:Object.assign({},base.pomo,saved.pomo||{})
    });
  }
  return base;
}
/* 待办迁移：
   1) 现版本 todos 是数组 [{id,text,dueDate,section,repeat,done,ts}]
   2) 旧版本是按日期分组的对象 {date:[{id,text,done}]} —— 需展开并补 dueDate
   注意：绝不能直接 state.todos=[]，否则会把用户数据清空
   优先级不再存储：一律按 dueDate 由 autoPriority() 实时计算 */
function migrateTodos(){
  if(!state.durTargets)state.durTargets={};
  if(!state.countTargets)state.countTargets={};
  if(!Array.isArray(state.courses))state.courses=[];   // 课程（听课进度）
  if(!Array.isArray(state.deletedTodoIds))state.deletedTodoIds=[]; // 跨设备删除同步：记录已删待办 id
  const courseDoneChanged=migrateCourseDone();   // 老数据 done 仅计数 → 补上「第几讲」编号
  if(Array.isArray(state.todos)){
    // 数组形态：补齐缺失字段，丢弃无效项
    let changed=false;
    const arr=[];
    state.todos.forEach(function(item){
      if(!item||typeof item!=='object'){changed=true;return;}
      if(item.jumpType==='review'){changed=true;return;} // 复盘待办功能已移除：自动清理历史遗留
      if(!item.id){item.id=uid();changed=true;}
      if(item.dueDate===undefined){item.dueDate=todayStr();changed=true;} // 注意：空字符串是长期任务，不能覆盖
      if(item.section===undefined){item.section='';changed=true;}
      if(item.done===undefined){item.done=false;changed=true;}
      if(!item.ts){item.ts=Date.now();changed=true;}
      delete item.priority; // 移除旧版手动优先级
      arr.push(item);
    });
    state.todos=arr;
    if(changed||courseDoneChanged)save(true);
    return;
  }
  // 对象形态（旧版）：展开合并成数组
  const old=state.todos||{};
  const arr=[];
  Object.keys(old).forEach(function(date){
    const list=old[date];
    if(!Array.isArray(list))return;
    list.forEach(function(item){
      if(!item||typeof item!=='object')return;
      arr.push({
        id:item.id||uid(),
        text:item.text||'',
        dueDate:item.dueDate!=null?item.dueDate:(/^\d{4}-\d{2}-\d{2}$/.test(date)?date:todayStr()),
        section:item.section||'',
        done:!!item.done,
        ts:item.ts||Date.now()
      });
    });
  });
  state.todos=arr;
  save(true);
}
/* 课表 module 旧值修正：旧版把 [key,name] 二元组直接拼成 "politics,政治理论" 这种字符串存了进去，
   导致 ttModColor/ttModName 匹配不上、模块色全退成紫色。这里还原为纯 key。
   注意：此函数在 TT_MODULE_OPTS 定义前就被调用，不能引用它，改用硬编码 validKeys。 */
function migrateTimetableModule(){
  if(!Array.isArray(state.timetable))return;
  let changed=false;
  const validKeys=['politics','changshi','yanyu','luoji','shuliang','ziliao','xiaoti','dazuowen'];
  state.timetable.forEach(c=>{
    if(!c||typeof c.module!=='string')return;
    const hit=validKeys.find(k=>c.module.indexOf(k+',')===0);
    if(hit){c.module=hit;changed=true;}
  });
  if(changed)save(true);
}
/* 自愈旧版套卷打卡脏数据：WorkBuddy 初版只写 dailyStats[d].taojuan={count:N,rate:0}（套数+1、正确率永远 0、
   无各大类题量），首页今日汇总与日历详情因此显示「1 套 · 0%」。启动时按 examRecords 重建这些日期。
   注意：本函数在启动迁移阶段（~370 行）执行，EXAM_TYPES 在 ~7300 行才 const 定义（暂时性死区），
   不能引用 EXAM_TYPES 也不能调 syncTaojuanDaily（它内部引用 EXAM_TYPES），大类名映射在此硬编码。 */
function migrateHealTaojuan(){
  try{
    var NAME={言语:'言语理解',判断推理:'判断推理',资料分析:'资料分析',数量关系:'数量关系',政治常识:'政治常识'};
    var dates={};
    (state.examRecords||[]).forEach(function(r){if(r&&r.date)dates[r.date]=1;});
    var ds0=state.dailyStats||{};
    Object.keys(ds0).forEach(function(d){if(ds0[d]&&ds0[d].taojuan)dates[d]=1;});
    var touched=false;
    Object.keys(dates).forEach(function(d){
      var old=ds0[d]&&ds0[d].taojuan;
      if(old&&old.records&&old.records.length)return;  // 远古手填套卷数据（理论上不再产生）原样保留
      var recs=(state.examRecords||[]).filter(function(x){return x.date===d;});
      if(!recs.length)return;                          // 当天无套卷记录的壳保守保留，防止云端暂缺误删
      var hasModData=recs.some(function(r){return r.moduleStats&&Object.keys(r.moduleStats).some(function(k){var m=r.moduleStats[k];return m&&m.total>0;});});
      var need=!old||old.count!==recs.length||(hasModData&&(!old.rate||old.rate<=0));
      if(!need)return;
      var tot=0,cor=0,minSum=0,subs={};
      recs.forEach(function(rc){
        minSum+=(rc.duration||0);
        var ms=rc.moduleStats||{};
        Object.keys(ms).forEach(function(k){
          var m=ms[k];if(!m||!(m.total>0))return;
          tot+=m.total;cor+=(m.correct||0);
          var nm=NAME[k]||k;
          if(!subs[nm])subs[nm]={count:0,correct:0};
          subs[nm].count+=m.total;subs[nm].correct+=(m.correct||0);
        });
      });
      Object.keys(subs).forEach(function(k){var s=subs[k];s.rate=s.count>0?Math.round(s.correct/s.count*100):0;});
      var stat={count:recs.length,rate:tot>0?Math.round(cor/tot*100):0,subs:subs,records:[]};
      if(minSum>0)stat.minutes=Math.round(minSum*10)/10;
      if(!state.dailyStats[d])state.dailyStats[d]={};
      state.dailyStats[d].taojuan=stat;
      touched=true;
    });
    if(touched)save(true);
  }catch(e){console.warn('heal taojuan failed',e);}
}
/* 已下线的数据字段：清理老用户本地/云端遗留数据，避免死数据长期占空间。
   1) 各模块页的选择题题库（检验题/每日一练）已移除；
   2) 本地错题本与「粉笔错题」跳转已移除 —— 错题统一在粉笔 App 里刷。 */
const RETIRED_CONTENT_KEYS=['idiomQuiz','logic','dataQuiz'];
function dropRetiredData(){
  let changed=false;
  RETIRED_CONTENT_KEYS.forEach(function(k){
    if(state.customData&&state.customData[k]!==undefined){delete state.customData[k];changed=true;}
    if(state.deletedBuiltin&&state.deletedBuiltin[k]!==undefined){delete state.deletedBuiltin[k];changed=true;}
  });
  if(state.errorQuestions!==undefined){delete state.errorQuestions;changed=true;}
  if(state.fenbiWrongUrl!==undefined){delete state.fenbiWrongUrl;changed=true;}
  if(state.schedules!==undefined){delete state.schedules;changed=true;}
  return changed;
}
/* 兜底守卫：确保数组型字段真的是数组。
   任何一处误用 Object.assign 把数组转成对象，都会导致数据被静默清空 —— 这里拦一道 */
function ensureArrayList(){
  let changed=false;
  ['todos','exams'].forEach(function(k){
    if(!Array.isArray(state[k])){state[k]=[];changed=true;}
  });
  Object.keys(state.customData||{}).forEach(function(k){
    if(!Array.isArray(state.customData[k])){state.customData[k]=[];changed=true;}
  });
  if(dropRetiredData())changed=true;
  if(changed)save(true);
}
/* 政治理论 + 常识 合并成「政治常识」：把历史数据并过去，只跑一次。
   考试时这两块一共 10 题、没有固定数量，分开统计没意义。 */
function migrateMergedSections(){
  if(state._mergedZhengzhi)return false;
  let changed=false;
  const mergeStat=function(a,b){
    const ca=a.count||0,cb=b.count||0;
    const ra=(a.rate!=null)?a.rate:0,rb=(b.rate!=null)?b.rate:0;
    if(cb>0){const tc=ca+cb;a.rate=Math.round((ca*ra+cb*rb)/tc);a.count=tc;}
    if(b.subs&&Object.keys(b.subs).length){
      a.subs=a.subs||{};
      Object.keys(b.subs).forEach(function(n){a.subs[n]=b.subs[n];});
    }
    return a;
  };
  Object.keys(state.dailyStats||{}).forEach(function(d){
    const day=state.dailyStats[d];if(!day||!day.zhengzhi)return;
    day.changshi=mergeStat(day.changshi||{count:0,rate:0,subs:{}},day.zhengzhi);
    delete day.zhengzhi;changed=true;
  });
  if(state.weakTargets&&state.weakTargets.zhengzhi!=null){
    if(state.weakTargets.changshi==null)state.weakTargets.changshi=state.weakTargets.zhengzhi;
    delete state.weakTargets.zhengzhi;changed=true;
  }
  (Array.isArray(state.todos)?state.todos:[]).forEach(function(td){
    if(td&&td.section==='zhengzhi'){td.section='changshi';changed=true;}
  });
  (Array.isArray(state.dailyTasks)?state.dailyTasks:[]).forEach(function(t){
    if(t&&t.sec==='zhengzhi'){t.sec='changshi';t.name=SECTION_MAP.changshi.name;changed=true;}
  });
  // 套卷记录：政治理论 + 常识 → 常识政治（按题数加权合并）
  (Array.isArray(state.examRecords)?state.examRecords:[]).forEach(function(r){
    if(!r)return;
    const ms=r.moduleStats||{};
    const a=ms['政治理论'],b=ms['常识'];
    if(a||b){
      ms['常识政治']={total:((a&&a.total)||0)+((b&&b.total)||0),correct:((a&&a.correct)||0)+((b&&b.correct)||0)};
      delete ms['政治理论'];delete ms['常识'];
      r.moduleStats=ms;changed=true;
    }
    const rt=r.rates||{};
    const ra=rt['政治理论'],rb=rt['常识'];
    if(ra!=null||rb!=null){
      const ta=(a&&a.total)||0,tb=(b&&b.total)||0;
      let v;
      if(ta+tb>0)v=((ra!=null?ra:0)*ta+(rb!=null?rb:0)*tb)/(ta+tb);
      else{const arr=[ra,rb].filter(function(x){return x!=null;});v=arr.length?arr.reduce(function(x,y){return x+y;},0)/arr.length:null;}
      rt['常识政治']=v;
      delete rt['政治理论'];delete rt['常识'];
      r.rates=rt;changed=true;
    }
  });
  state._mergedZhengzhi=true;
  return changed;
}
/* 正确率目标 key 归一：
   历史上「我的」页用中文题型名（'资料分析'）存 weakTargets，而薄弱考点分析用英文模块 key（'ziliao'），
   两边读的不是同一份 → 在一处设的目标另一处看不到。这里把中文大类 key 统一迁到英文模块 key。
   映射内联不复用 ET_TO_SEC：本函数在 init 早期执行，彼时 4800 行那批 const 尚未初始化（TDZ）。
   子模块 key（'言语_逻辑填空'）不含于本表、保持原样。 */
function migrateWeakTargetKeys(){
  if(!state.weakTargets)return false;
  const NAME2SEC={'言语':'yanyu','判断推理':'luoji','资料分析':'ziliao','数量关系':'shuliang','常识政治':'changshi','政治常识':'changshi'};
  let changed=false;
  Object.keys(state.weakTargets).forEach(function(k){
    const sec=NAME2SEC[k];
    if(!sec||sec===k)return;
    if(state.weakTargets[sec]==null)state.weakTargets[sec]=state.weakTargets[k];
    delete state.weakTargets[k];
    changed=true;
  });
  return changed;
}
/* 模块名「常识政治」→「政治常识」统一（2026-09-20）：
   内部存储 key 原先是中文「常识政治」（EXAM_TYPES.key、套卷 moduleStats、每日刷题子模块）。
   显示名早已是「政治常识」，但数据模型里残留旧 key，会导致旧套卷记录 / 旧每日刷题子模块
   在新代码（按「政治常识」读）下读不到正确率。这里一次性把已存数据无损重命名。幂等。 */
function migrateRenameChangshi(){
  if(state._renamedChangshi)return false;
  let changed=false;
  // 套卷：moduleStats / rates 旧 key 常识政治 → 政治常识
  (Array.isArray(state.examRecords)?state.examRecords:[]).forEach(function(r){
    if(!r)return;
    if(r.moduleStats&&r.moduleStats['常识政治']!=null){
      if(r.moduleStats['政治常识']==null)r.moduleStats['政治常识']=r.moduleStats['常识政治'];
      delete r.moduleStats['常识政治'];changed=true;
    }
    if(r.rates&&r.rates['常识政治']!=null){
      if(r.rates['政治常识']==null)r.rates['政治常识']=r.rates['常识政治'];
      delete r.rates['常识政治'];changed=true;
    }
  });
  // 每日刷题子模块：旧 key 常识政治_政治理论 / 常识政治_常识 → 政治常识_*
  Object.keys(state.dailyStats||{}).forEach(function(d){
    const day=state.dailyStats[d];if(!day||!day.changshi||!day.changshi.subs)return;
    const subs=day.changshi.subs;
    ['常识政治_政治理论','常识政治_常识'].forEach(function(oldk){
      if(subs[oldk]!=null){
        const newk='政治常识'+oldk.slice(4);
        if(subs[newk]==null)subs[newk]=subs[oldk];
        delete subs[oldk];changed=true;
      }
    });
  });
  // 目标三类：旧中文 key 常识政治 → 政治常识（sec 维度 changshi 不受影响）
  ['weakTargets','durTargets','countTargets'].forEach(function(mapk){
    const m=state[mapk];if(!m||m['常识政治']==null)return;
    if(m['政治常识']==null)m['政治常识']=m['常识政治'];
    delete m['常识政治'];changed=true;
  });
  state._renamedChangshi=true;
  return changed;
}
/* 套卷 moduleStats 补全：
   修复前录入的套卷缺 moduleStats 字段（修复后 openExamEditor 已每卷生成），
   下游 getWeakPoints / 正确率趋势按「!ms return」安全跳过，老记录不计入薄弱分析。
   这里从每模块真实 counts 折算补齐（与 openExamEditor 保存算法一致），
   只补字段、不改动已有数据。幂等：已有非空 moduleStats 的记录跳过。 */
function migrateExamModuleStats(){
  if(!Array.isArray(state.examRecords))return false;
  let changed=false;
  state.examRecords.forEach(function(r){
    if(!r)return;
    const ms=r.moduleStats;
    if(ms&&Object.keys(ms).length)return; // 已有，跳过
    const counts=r.counts||{};
    const newMs={};
    EXAM_TYPES.forEach(function(t){
      const c=counts[t.key];
      if(c&&c.total>0)newMs[t.key]={total:c.total,correct:c.correct};
    });
    if(Object.keys(newMs).length){r.moduleStats=newMs;changed=true;}
  });
  if(changed)save(true);
  return changed;
}
/* 补齐新增分类的每日任务项（旧数据里没有申论 / 行测套卷 / 晨读时政） */
function ensureDailyTasks(){
  let changed=false;
  if(!Array.isArray(state.dailyTasks))state.dailyTasks=[];
  CHECKIN_CATEGORIES.forEach(function(k){
    const has=state.dailyTasks.some(function(t){return t&&t.sec===k&&!t.sub;});
    if(!has){
      state.dailyTasks.push({id:'def_'+k,type:'module',sec:k,sub:null,name:SECTION_MAP[k].name,target:null});
      changed=true;
    }
  });
  return changed;
}
let state=loadData();
let pomo=Object.assign({duration:25,section:'yanyu',remaining:0,running:false,done:false,overtime:false,timer:null,endAt:null,startTs:null,kind:'focus',sub:''},state.pomo||{});
// 番茄钟停止时自动写入的 focus session id：录入保存后会被「消费」掉，避免和「学习时长」重复计时
let pendingPomoSessId=null;
/* 番茄钟不默认常驻：老存档（默认值模板曾把 remaining 写成 25*60）里那些「从没真正启动过」的记录，
   在这里复位为 0，否则一进页面就挂着一个 25:00 的待机浮窗。判断依据：没 startTs、没 endAt、也没在跑。 */
if(!pomo.startTs&&!pomo.endAt&&!pomo.running)pomo.remaining=0;
pomo.timer=null;pomo.running=false;pomo.overtime=false; // 刷新后恢复配置与进度，但不自动计时（手动继续）
/* 恢复存档后重新锚定正计时起点：存档里的 startTs 是「上次暂停那一刻」的时间戳，
   直接沿用会把暂停/关页面期间的真实时间全部算进已用时 —— 表现就是「暂停了还在计时」。 */
if(!pomo.running&&(pomo.kind==='focus'||pomo.kind==='review')&&pomo.remaining>0)pomo.startTs=Date.now()-pomo.remaining*1000;
migrateTodos();
migrateTimetableModule();   // 课表 module 旧值修正：二元组误拼成 "key,name" 字符串 → 还原为纯 key
migrateHealTaojuan();       // 旧版套卷打卡 {count,rate:0} 脏壳按 examRecords 重建（首页 0% 修复）
migrateMergedSections();
migrateExamModuleStats();
migrateWeakTargetKeys();
migrateRenameChangshi();   // 常识政治 → 政治常识（内部 key 统一，无损迁移旧数据）
migrateFujianExamDate();
ensureDailyTasks();
migrateContentIds();
migrateGuifanCats();   // 规范词旧分类迁到新的 13 类
migrateLearnStage();   // 学习状态：旧版存的是纯字符串，补成 {s,下次复习日,连续答对次数}
/* 给新增内容补 id：跨设备合并是按 id 去重的，没有 id 的内容在另一台设备上永远拉不过来 */
function withContentId(o){
  if(o&&typeof o==='object'&&!Array.isArray(o)){
    if(o.id==null)o.id=uid();
    if(o.mts==null)o.mts=Date.now(); // 新增/编辑的修改时间，供跨端 LWW 合并
  }
  return o;
}
/* 补 id：历史自定义内容（成语/笔记/常识等）大多是手填 JSON，本来没有 id 字段。
   不补的话，这台设备加的内容另一台永远合并不到，等于同步白做。这里一次性补齐。 */
function migrateContentIds(){
  const cd=state.customData||{};
  let changed=false;
  Object.keys(cd).forEach(function(k){
    if(!Array.isArray(cd[k]))return;
    cd[k].forEach(function(item){
      if(item&&typeof item==='object'&&!Array.isArray(item)&&item.id==null){item.id=uid();changed=true;}
    });
  });
  if(changed)save();
}
function migrateGuifanCats(){
  const cd=state.customData||{};
  const arr=cd.shenlunGuifan;
  if(!Array.isArray(arr))return;
  let changed=false;
  arr.forEach(function(it){
    if(it&&typeof it==='object'&&GUIFAN_CAT_MAP[it.cat]){it.cat=GUIFAN_CAT_MAP[it.cat];changed=true;}
  });
  if(changed)save();
}
function migrateFujianExamDate(){
  // 一次性迁移：福建省考默认日期 2027-03-15 → 2027-03-13（仅当本地仍沿用旧种子值 3.15 时修正，不动用户自定义的其他日期）
  if(state.examDates && state.examDates.fujianshengkao==='2027-03-15'){
    state.examDates.fujianshengkao='2027-03-13';
    if(Array.isArray(state.exams))state.exams.forEach(function(e){ if(e&&e.key==='fujianshengkao')e.date='2027-03-13'; });
    save();
  }
  // 一次性迁移：福建事业编默认日期 2026-10-18 → 2027-04-24（只改仍沿用旧种子值的，用户自己改过的不动）
  if(state.examDates && state.examDates.fujianshiyebian==='2026-10-18'){
    state.examDates.fujianshiyebian='2027-04-24';
    if(Array.isArray(state.exams))state.exams.forEach(function(e){ if(e&&e.key==='fujianshiyebian')e.date='2027-04-24'; });
    save();
  }
  // 一次性迁移：国考默认日期 2026-11-30 → 2026-11-29（只改仍沿用旧种子值的，用户自己改过的不动）
  if(state.examDates && state.examDates.guokao==='2026-11-30'){
    state.examDates.guokao='2026-11-29';
    if(Array.isArray(state.exams))state.exams.forEach(function(e){ if(e&&e.key==='guokao')e.date='2026-11-29'; });
    save();
  }
}
ensureArrayList();
/* 参与打卡显示的分类（用户可在「今日汇总 → 分类」里勾选） */
function activeCheckinCategories(){
  const hidden=Array.isArray(state.checkinHidden)?state.checkinHidden:[];
  return CHECKIN_CATEGORIES.filter(function(k){return hidden.indexOf(k)<0;});
}
// 「我的 → 打卡分类」弹窗：勾选哪些模块参与今日汇总 / 打卡
function openCheckinCatSettings(){
  const cats=CHECKIN_CATEGORIES;
  const hidden=Array.isArray(state.checkinHidden)?state.checkinHidden:[];
  const rows=cats.map(function(k){
    const s=SECTION_MAP[k]; if(!s)return '';
    const on=hidden.indexOf(k)<0;
    return `<label class="cc-row"><input type="checkbox" class="cc-cb" data-sec="${k}" ${on?'checked':''}><span class="cc-name">${escapeHtml(s.name)}</span></label>`;
  }).filter(Boolean).join('');
  const body=`<div class="cc-list">${rows}</div><div class="cc-actions"><button class="btn btn-primary" id="ccSave">保存</button></div>`;
  openModal('打卡分类',body);
  const saveBtn=document.getElementById('ccSave');
  if(saveBtn)saveBtn.addEventListener('click',function(){
    const checked=[].slice.call(document.querySelectorAll('.cc-cb')).filter(function(c){return c.checked;}).map(function(c){return c.dataset.sec;});
    const _next=cats.filter(function(k){return checked.indexOf(k)<0;});
    const _prev=Array.isArray(state.checkinHidden)?state.checkinHidden:[];
    const _nw=Date.now();
    if(!state.checkinHiddenMts||typeof state.checkinHiddenMts!=='object')state.checkinHiddenMts={};
    cats.forEach(function(k){ if((_prev.indexOf(k)<0)!==(_next.indexOf(k)<0))state.checkinHiddenMts[k]=_nw; });
    state.checkinHidden=_next;
    save();render();closeModal();toast('已更新打卡分类');
  });
}
function save(skipSync){
  // 番茄钟进度持久化（running 不入存，刷新后暂停）；pomo 可能尚未声明，安全写入
  if(typeof pomo!=='undefined'&&pomo&&typeof pomo==='object'){
    state.pomo={duration:pomo.duration,custom:!!pomo.custom,section:pomo.section,sub:pomo.sub||'',remaining:pomo.remaining,done:!!pomo.done,endAt:pomo.endAt||null,startTs:pomo.startTs||null,running:!!pomo.running,overtime:!!pomo.overtime,kind:pomo.kind||'focus'};
  }
  try{
    const dataStr=JSON.stringify(state);
    // 容量检查：超过警告阈值时提示
    if(dataStr.length>CONST.LOCAL_STORAGE_WARN&&!save._warned){
      save._warned=true;
      setTimeout(()=>{
        const sizeMB=(dataStr.length/1024/1024).toFixed(2);
        toast(`数据已达 ${sizeMB}MB，建议导出备份并清理旧数据`);
        setTimeout(()=>{save._warned=false;},60000); // 1分钟内不重复提示
      },100);
    }
    localStorage.setItem(STORE_KEY,dataStr);
    // 数据变更后清空其他 tab 的面板缓存：下次访问自动用最新数据重建；当前 tab 由调用方 render() 刷新
    for(const k in _tabPanes)delete _tabPanes[k];
  }catch(e){
    if(e.name==='QuotaExceededError'||e.code===22){
      toast('本地存储空间不足！请导出数据备份后，清理旧数据或头像图片。');
    }else{
      console.error('保存失败:',e);
    }
    return;
  }
  // 自动上传：改完停 2 分钟防抖传一次（scheduleSync 负责调度；拉取由轮询 + 6 点兜底完成）
  if(!skipSync){
    dirtySincePush=true;
    /* 脏标记同时写 localStorage：beforeunload 的 fetch 几乎都会被浏览器丢弃，
       仅靠内存里的 dirtySincePush 关页就丢，下次启动不知道还有未推改动。
       持久化后 initSync 启动时能恢复标记并立即补推。 */
    try{localStorage.setItem('shangan_dirty','1');}catch(e){}
    if(!bootPullPending)scheduleSync(); // 启动拉取未完成前不推，防用未合并云端的本地覆盖云端
  }
}
function fmtTime(d){var h=d.getHours(),m=d.getMinutes();return (h<10?'0':'')+h+':'+(m<10?'0':'')+m;}

/* ---------- 带重试的网络请求 ---------- */
function fetchWithRetry(url,options,retryCount){
  retryCount=retryCount!=null?retryCount:CONST.NET_RETRY_COUNT;
  return fetch(url,options).then(r=>{
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r;
  }).catch(err=>{
    if(retryCount<=0)throw err;
    return new Promise(resolve=>setTimeout(resolve,CONST.NET_RETRY_DELAY))
      .then(()=>fetchWithRetry(url,options,retryCount-1));
  });
}

/* ---------- 云端同步（Gitee 私有仓库，跨设备自动同步） ---------- */
const SYNC_KEY='shangan_workbench_sync';
const GITEE_API='https://gitee.com/api/v5';
let syncState={s:'idle',msg:'未配置'};
function getSyncCfg(){try{return JSON.parse(localStorage.getItem(SYNC_KEY));}catch(e){return null;}}
function setSyncCfg(c){if(c&&c.token&&c.owner&&c.repo&&c.path)localStorage.setItem(SYNC_KEY,JSON.stringify(c));else localStorage.removeItem(SYNC_KEY);}
function setSyncStatus(s,msg){
  syncState={s:s,msg:msg||({idle:'未同步',syncing:'同步中…',ok:'已同步',error:'同步失败',offline:'离线'}[s]||'')};
  var t=document.getElementById('syncStatusText');if(t)t.textContent=syncState.msg;
  var d=document.getElementById('syncStatusDot');if(d)d.className='sync-dot sync-'+s;
}
function giteeHeaders(token){return {'Content-Type':'application/json','Authorization':'token '+token};}
function giteeFileUrl(cfg){return GITEE_API+'/repos/'+cfg.owner+'/'+cfg.repo+'/contents/'+cfg.path;}
function giteeRawFetch(url,opts){
  // 不用 fetchWithRetry：Gitee 的 404(文件不存在)/非200 需读取 body 里的具体错误信息，
  // fetchWithRetry 会把一切 !ok 当失败重试并丢弃响应体。这里手动解析。
  return fetch(url,opts).then(function(r){
    return r.json().catch(function(){return {message:'HTTP '+r.status};}).then(function(b){
      if(!r.ok){
        var err=new Error((b&&(b.message||b.error))||('HTTP '+r.status));
        err.status=r.status;throw err;
      }
      return b;
    });
  });
}
function giteeRead(cfg){
  // 拿 Gitee 内容接口返回 {content:base64, sha}；仓库里没这个文件→404→返回 null
  return giteeRawFetch(giteeFileUrl(cfg),{headers:giteeHeaders(cfg.token)})
    .catch(function(e){if(e.status===404)return null;throw e;});
}
function giteeWrite(cfg,content){
  // Gitee 内容接口要求 base64 编码
  var b64=btoa(unescape(encodeURIComponent(content)));
  var body={content:b64,message:'sync '+new Date().toISOString(),access_token:cfg.token};
  // 先尝试读现有文件拿 sha（文件已存在必须带 sha 才能覆盖）
  return giteeRead(cfg).then(function(existing){
    if(existing&&existing.sha)body.sha=existing.sha;
    var url=giteeFileUrl(cfg);
    var opts={method:existing?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
    return giteeRawFetch(url,opts);
  });
}
function doPush(){
  var cfg=getSyncCfg();if(!cfg)return Promise.resolve();
  if(!navigator.onLine){setSyncStatus('offline');return Promise.resolve();}
  setSyncStatus('syncing');
  // 推送前先静默拉取合并云端最新，避免本端全量覆盖掉另一端刚推送的更改
  // （doPull 内部已 save(true)，合并后的 state 才是要推送的真相）
  return doPull(true).then(function(){
    var ts=Date.now();
    return giteeWrite(cfg,JSON.stringify(syncPayloadTs(ts)))
      .then(function(){
        state._syncTs=Math.max(state._syncTs||0,ts);
        dirtySincePush=false;
        try{localStorage.removeItem('shangan_dirty');}catch(e){}
        bootPullPending=false;
        save(true);
        setSyncStatus('ok','已同步 '+fmtTime(new Date()));
      });
  }).catch(function(e){setSyncStatus('error',e.message);});
}
function syncPayloadTs(ts){
  var copy=JSON.parse(JSON.stringify(state));copy._syncTs=ts||Date.now();
  if(JSON.stringify(copy).length>CONST.MAX_SYNC_SIZE){
    if(copy.userProfile&&/^data:/.test(copy.userProfile.avatar||''))copy.userProfile.avatar='';
    copy._photoStripped=true;
  }
  return copy;
}
/* 判断本地 state 是否已有一份"实质用户数据"。
   空设备/刚清空=true 时，允许自动从云端导入；
   有数据(刷过题/有任务/有统计/有自定义内容)时，绝不允许自动静默覆盖（防止互相踩踏丢数据）。 */
function localHasRealData(){
  const s=state||{};
  const objHas=function(o){return o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length>0;};
  // 学习记录 / 每日统计 / 套卷复盘 / 周期复盘 / 申论批改 任一非空即视为有数据
  if(objHas(s.studyRecords)||objHas(s.dailyStats)||objHas(s.periodReviews)||objHas(s.shenlunReviews))return true;
  if(Array.isArray(s.examRecords)&&s.examRecords.length)return true;
  // 待办：有任何一项即可视为有数据（用户改过任务才算启动过）
  if(Array.isArray(s.todos)&&s.todos.length)return true;
  // 自定义内容（成语/试题/常识/素材…）任一非空
  const cd=s.customData||{};
  const hasCustom=Object.keys(cd).some(function(k){return Array.isArray(cd[k])&&cd[k].length>0;});
  if(hasCustom)return true;
  if(s.weakTargets&&typeof s.weakTargets==='object'&&Object.keys(s.weakTargets).length)return true;
  // 手动录入过学习时长/自定义内容等兜底：只要有任意研究日期键
  return false;
}
/* —— 跨设备合并（核心）：把远端数据并集合并进本地，绝不因拉取删除/覆盖本地已有内容 ——
   设计原则：本地优先保留；远端"本地没有的键/项"补进来。这样无论平板主还是手机主、
   谁新攒了刷题/任务/记录，另一端拉取后都自动补全，天然不丢任何一方的数据，无需手动。
   空设备(本地全空)拉取 = 全量导入。 */
/* 按 id 并集 + 同 id 取 mts 较新（编辑过的版本能同步），保持本地原有顺序 */
function arrayUnionById(localArr,remoteArr){
  const l=Array.isArray(localArr)?localArr:[],r=Array.isArray(remoteArr)?remoteArr:[];
  if(!l.length&&!r.length)return [];
  const tsOf=function(x){return x&&(x.mts||x.ts||x.createdAt)||0;};
  const out=l.slice(),pos=new Map();
  out.forEach(function(x,i){if(x&&x.id!=null&&!pos.has(x.id))pos.set(x.id,i);});
  r.forEach(function(x){
    if(!x||x.id==null){out.push(x);return;}
    const i=pos.get(x.id);
    if(i==null){pos.set(x.id,out.length);out.push(x);return;}
    if(tsOf(x)>tsOf(out[i]))out[i]=x;
  });
  return out;
}
/* ---------- 通用实体删除墓碑（带时间戳） ----------
   state.deletedEntities = { kind: [ 'id'(旧格式/永久) | {id,ts} ] }
   kind: course / timetable / examRecord / shenlunReview / exam / session /
         custom:<内容类型> / lesson:<课程id>
   规则与待办墓碑一致：仅当「删除时间 > 实体最后修改时间」才删，
   这样删掉后同 id 重建的实体不会被旧墓碑误杀。 */
function entityDelMap(kind,A,B){
  const pick=function(s){return (s&&s.deletedEntities&&Array.isArray(s.deletedEntities[kind]))?s.deletedEntities[kind]:[];};
  const m=new Map();
  [pick(A),pick(B)].forEach(function(arr){
    arr.forEach(function(e){
      const id=(e&&typeof e==='object')?e.id:e;
      const ts=(e&&typeof e==='object')?(e.ts||0):Infinity;
      if(id==null)return;
      if(m.get(id)==null||ts>m.get(id))m.set(id,ts);
    });
  });
  return m;
}
function entityDelArray(m){
  const out=[];
  m.forEach(function(ts,id){out.push(ts===Infinity?id:{id:id,ts:ts});});
  if(out.length>5000){
    const perm=out.filter(function(e){return typeof e==='string';});
    const timed=out.filter(function(e){return typeof e!=='string';}).slice(-Math.max(0,5000-perm.length));
    return perm.concat(timed);
  }
  return out;
}
function markEntityDeleted(kind,ids){
  if(!state.deletedEntities||typeof state.deletedEntities!=='object'||Array.isArray(state.deletedEntities))state.deletedEntities={};
  const m=entityDelMap(kind,state,null);
  const ts=Date.now();
  (ids||[]).forEach(function(id){if(id!=null)m.set(id,Math.max(m.get(id)||0,ts));});
  state.deletedEntities[kind]=entityDelArray(m);
}
/* 通用实体合并：按 id 并集 + 同 id 取时间戳较新（special 可自定义）+ 墓碑过滤 */
function mergeEntities(localArr,remoteArr,delMap,idOf,tsOf,special){
  const idf=idOf||function(x){return x.id;};
  const tsf=tsOf||function(x){return x.mts||x.ts||x.createdAt||0;};
  const map=new Map();
  (Array.isArray(localArr)?localArr:[]).forEach(function(x){if(x&&idf(x)!=null)map.set(idf(x),x);});
  (Array.isArray(remoteArr)?remoteArr:[]).forEach(function(x){
    if(!x||idf(x)==null)return;
    const id=idf(x), ex=map.get(id);
    if(!ex){map.set(id,x);return;}
    if(tsf(x)>tsf(ex)){map.set(id,x);return;}
    if(special)map.set(id,special(ex,x));
  });
  return Array.from(map.values()).filter(function(x){
    const dt=delMap&&delMap.get(idf(x));
    return !(dt!=null&&dt>tsf(x));
  });
}
/* ---------- 待办删除墓碑（带时间戳） ----------
   为什么不能只存 id：课表改期/删课会先删掉旧听课待办、再用「同一个 id」重新生成一条新的。
   若墓碑是永久的，另一端同步时会把这条新生成的也删掉，两端反而对不上。
   规则：删除时间 > 待办最后修改时间(mts) 才删。旧的纯字符串墓碑视为「永久删除」(Infinity)。
   数组元素形态：'id'（旧格式，永久）或 {id,ts}（新格式）。 */
function delEntryId(e){ return (e&&typeof e==='object')?e.id:e; }
function delEntryTs(e){ return (e&&typeof e==='object')?(e.ts||0):Infinity; }
function collectDeletedTodos(a,b){
  const m=new Map();
  [a,b].forEach(function(arr){
    (Array.isArray(arr)?arr:[]).forEach(function(e){
      const id=delEntryId(e); if(id==null)return;
      const ts=delEntryTs(e);
      if(m.get(id)==null||ts>m.get(id))m.set(id,ts);
    });
  });
  return m;
}
function deletedTodosToArray(m){
  const out=[];
  m.forEach(function(ts,id){ out.push(ts===Infinity?id:{id:id,ts:ts}); });
  // 安全阀：只保留最近 5000 条，避免长期只增不减撑大同步包。
  // 不做按时间裁剪，防止很久没上线的老设备把已删待办「复活」；旧格式字符串墓碑优先保留。
  if(out.length>5000){
    const perm=out.filter(function(e){return typeof e==='string';});
    const timed=out.filter(function(e){return typeof e!=='string';}).slice(-Math.max(0,5000-perm.length));
    return perm.concat(timed);
  }
  return out;
}
function markTodosDeleted(ids){
  const m=collectDeletedTodos(state.deletedTodoIds,[]);
  const ts=Date.now();
  (ids||[]).forEach(function(id){ if(id!=null)m.set(id,Math.max(m.get(id)||0,ts)); });
  state.deletedTodoIds=deletedTodosToArray(m);
}
/* 统一待办删除入口：删的同时记墓碑，保证另一端不会把删掉的待办同步回来。
   pred 必须是纯判断函数（内部会调用两次），返回被删条数。 */
function dropTodos(pred){
  if(!Array.isArray(state.todos))return 0;
  const doomed=state.todos.filter(function(td){return td&&pred(td);});
  if(!doomed.length)return 0;
  markTodosDeleted(doomed.map(function(td){return td.id;}));
  state.todos=state.todos.filter(function(td){return !(td&&pred(td));});
  return doomed.length;
}
/* 待办双向合并：① 按 id 并集；② 已存在项取 mts 较新者（最后修改者胜，保证两端收敛一致）；
   ③ 删除同步：delMap 为「本地+远端墓碑按 id 取较新删除时间」，删除时间 > 待办 mts 才移除；
   ④ 课表自动生成的听课待办（autoTt）按 courseId@dueDate 去重，只留一条（优先确定性 id），
   避免两设备各自生成一条重复；
   ⑤ 「下一步建议」待办按 section 去重，只留未完成且 mts 最新的一条 */
function mergeTodosLWW(local,remote,delMap){
  const map=new Map();
  (Array.isArray(local)?local:[]).forEach(x=>{ if(x&&x.id!=null)map.set(x.id,x); });
  (Array.isArray(remote)?remote:[]).forEach(x=>{
    if(!x||x.id==null)return;
    const ex=map.get(x.id);
    if(!ex){ map.set(x.id,x); return; }
    if((x.mts||0)>(ex.mts||0)) map.set(x.id,x); // 远端改得更晚 → 用远端
  });
  let arr=Array.from(map.values()).filter(function(x){
    const dt=delMap&&delMap.get(x.id);
    return !(dt!=null&&dt>(x.mts||0)); // 删除晚于最后修改才删；后来重新生成的同 id 待办 mts 更大，会留下
  });
  const seen=new Map(), sgSeen=new Map(), res=[];
  arr.forEach(x=>{
    /* 「下一步建议」待办：两端各点一次会产生不同 id 的两条，这里按 section 收敛，
       只保留未完成且 mts 最新的一条（已完成的历史记录全部保留）。 */
    if(x.from==='suggest'&&!x.done){
      const sk=String(x.section||''), sp=sgSeen.get(sk);
      if(sp){
        const betterS=((x.mts||0)>=(sp.mts||0))?x:sp;
        const si=res.findIndex(o=>o.id===sp.id); if(si>=0)res[si]=betterS;
        sgSeen.set(sk,betterS); return;
      }
      sgSeen.set(sk,x);
    }
    if(x.autoTt&&x.courseId&&x.dueDate){
      const key=x.courseId+'@'+x.dueDate, p=seen.get(key);
      if(p){
        const better=(String(x.id||'').indexOf('tt_')===0)?x:(String(p.id||'').indexOf('tt_')===0)?p:((x.mts||0)>=(p.mts||0)?x:p);
        const i=res.findIndex(o=>o.id===p.id); if(i>=0)res[i]=better;
        seen.set(key,better); return;
      }
      seen.set(key,x);
    }
    res.push(x);
  });
  return res;
}
/* ============================================================
   设置类偏好：按「每一项各自的修改时间」合并，不再整包覆盖。
   *Mts 存 {key: 毫秒}；删除也算一次改动（值删掉、时间戳留着当墓碑），
   这样两端各改不同项不会互相丢，清除过的项也不会在另一端复活。
   老数据没有 *Mts 时，用负载时间戳兜底，保证升级前后行为平滑。
   ============================================================ */
function mergePrefMap(lv,rv,lm,rm,lFallback,rFallback){
  const hasOwn=function(o,k){return Object.prototype.hasOwnProperty.call(o,k);};
  const keys=new Set(Object.keys(lv).concat(Object.keys(rv),Object.keys(lm),Object.keys(rm)));
  keys.forEach(function(k){
    const lHas=hasOwn(lv,k), rHas=hasOwn(rv,k);
    const lt=lm[k]||(lHas?lFallback:0), rt=rm[k]||(rHas?rFallback:0);
    if(rt>lt){ if(rHas)lv[k]=rv[k]; else delete lv[k]; lm[k]=rt; }
    else if(lHas&&!lm[k]&&lt)lm[k]=lt;
  });
}
function mergePrefsLWW(L,R,valKey,mtsKey,remoteTs){
  const rv=R[valKey];
  if(!rv||typeof rv!=='object'||Array.isArray(rv))return;
  if(!L[valKey]||typeof L[valKey]!=='object'||Array.isArray(L[valKey]))L[valKey]={};
  if(!L[mtsKey]||typeof L[mtsKey]!=='object'||Array.isArray(L[mtsKey]))L[mtsKey]={};
  const rm=(R[mtsKey]&&typeof R[mtsKey]==='object'&&!Array.isArray(R[mtsKey]))?R[mtsKey]:{};
  mergePrefMap(L[valKey],rv,L[mtsKey],rm,state._syncTs||0,remoteTs||0);
}
function applyRemoteMerge(remote,remoteTs){
  if(!remote||typeof remote!=='object')return;
  const L=state,R=remote;
  const localHolds=function(o){return o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length>0;};
  // —— 通用实体墓碑：先合并两端记录，供下面各实体合并时过滤 ——
  const entSet=new Set(['course','timetable','examRecord','shenlunReview','exam','session']);
  [L.customData,R.customData].forEach(function(cd){Object.keys(cd||{}).forEach(function(k){entSet.add('custom:'+k);});});
  [L.courses,R.courses].forEach(function(arr){(Array.isArray(arr)?arr:[]).forEach(function(c){if(c&&c.id!=null)entSet.add('lesson:'+c.id);});});
  if(!L.deletedEntities||typeof L.deletedEntities!=='object'||Array.isArray(L.deletedEntities))L.deletedEntities={};
  const entMaps={};
  entSet.forEach(function(k){entMaps[k]=entityDelMap(k,L,R);L.deletedEntities[k]=entityDelArray(entMaps[k]);});
  // —— 待办：双向 LWW（含删除同步 + autoTt 去重）——
  {
    const delMap=collectDeletedTodos(L.deletedTodoIds,R.deletedTodoIds);
    if(Array.isArray(R.todos)||Array.isArray(L.todos)){
      L.todos=mergeTodosLWW(L.todos,R.todos,delMap);
    }
    L.deletedTodoIds=deletedTodosToArray(delMap);
  }
  // —— 学习记录 studyRecords：{date:{sessions:[]}}，date 并集、sessions 按 id 并集 ——
  if(localHolds(R.studyRecords)&&Object.keys(R.studyRecords).length){
    if(!localHolds(L.studyRecords))L.studyRecords={};
    Object.keys(R.studyRecords).forEach(function(d){
      const rd=R.studyRecords[d];if(!rd||typeof rd!=='object')return;
      if(!L.studyRecords[d]||typeof L.studyRecords[d]!=='object')L.studyRecords[d]={sessions:[]};
      const ld=L.studyRecords[d];
      if(Array.isArray(rd.sessions)&&rd.sessions.length)ld.sessions=mergeEntities(ld.sessions||[],rd.sessions,entMaps.session,null,function(x){return x.mts||x.ts||0;});
      if(typeof rd.focusCount==='number')ld.focusCount=Math.max(ld.focusCount||0,rd.focusCount);
    });
  }
  // —— 每日统计 dailyStats：{date:{sec:{count,rate,subs,records,minutes}}}
  //   旧逻辑：同一 (date,sec) 本地已有则整块不覆盖 → 平板录的题手机当天有该模块空壳就合不进来。
  //   新逻辑：date/sec 并集；同一 (date,sec) 把两端 records 按指纹(ts+sub+count)去重并集，
  //   minutes 取两端较大值（records 可能被消费过导致 sum(min) 与 minutes 不一致，取 max 更安全），
  //   最后 recomputeDailyStat 由合并后的 records 重算 count/rate/subs，保证汇总与明细对得上。 */
  if(localHolds(R.dailyStats)&&Object.keys(R.dailyStats).length){
    if(!localHolds(L.dailyStats))L.dailyStats={};
    Object.keys(R.dailyStats).forEach(function(d){
      const rd=R.dailyStats[d];if(!rd||typeof rd!=='object')return;
      if(!L.dailyStats[d]||typeof L.dailyStats[d]!=='object')L.dailyStats[d]={};
      Object.keys(rd).forEach(function(sec){
        const rv=rd[sec];if(!rv||typeof rv!=='object')return;
        const lv=L.dailyStats[d][sec];
        if(!lv){L.dailyStats[d][sec]=JSON.parse(JSON.stringify(rv));return;} // 本地没有该模块统计才补
        const lvPrev={count:lv.count||0,rate:lv.rate,subs:lv.subs};
        // 本地已有：合并 records（按指纹去重，本地优先保留）
        if(!Array.isArray(lv.records))seedRecordsIfLegacy(lv);
        if(!Array.isArray(rv.records))seedRecordsIfLegacy(rv);
        const lr=lv.records||[], rr=rv.records||[];
        const fp=function(r){return (r.ts||0)+'|'+(r.sub||'__overall__')+'|'+(r.count||0);};
        const seen=new Set(lr.map(fp));
        rr.forEach(function(r){const f=fp(r);if(!seen.has(f)){seen.add(f);lr.push(JSON.parse(JSON.stringify(r)));}});
        lv.records=lr;
        // minutes 取两端较大值（records 被消费过的端 sum(min) 可能小于真实分钟数）
        const lm=lv.minutes||0, rm=rv.minutes||0;
        if(rm>lm)lv.minutes=rm;
        if(lv.minutes<=0)delete lv.minutes;
        recomputeDailyStat(sec,d);
        if(!lv.records||!lv.records.length){
          // 套卷壳是派生数据（records 恒为 []，count/rate/subs 由 examRecords 算出），
          // 不能按「无明细」删除，否则平板录的套卷会被手机当天的空壳吞掉；
          // 两端都无明细时保留套数/题量更大的那份。
          if(sec==='taojuan'){
            const rc=rv.count||0, lc=lvPrev.count;
            if(!rc&&!lc){delete L.dailyStats[d][sec];return;}
            if(rc>lc)L.dailyStats[d][sec]=JSON.parse(JSON.stringify(rv));
            else{lv.count=lc;lv.rate=lvPrev.rate;if(lvPrev.subs)lv.subs=lvPrev.subs;else delete lv.subs;}
            return;
          }
          delete L.dailyStats[d][sec];
        }
      });
      if(!Object.keys(L.dailyStats[d]).length)delete L.dailyStats[d];
    });
  }
  // —— 套卷复盘 / 申论批改：按 id 并集，同 id 用 mts LWW（编辑过的版本覆盖旧版）——
  function mergeByIdLWW(localArr,remoteArr){
    if(!Array.isArray(localArr))localArr=[];
    const lmap=new Map(localArr.map(x=>[x.id,x]));
    (remoteArr||[]).forEach(function(r){
      if(!r||r.id==null)return;
      const l=lmap.get(r.id);
      if(!l){localArr.push(JSON.parse(JSON.stringify(r)));lmap.set(r.id,r);return;}
      const lm=l.mts||l.createdAt||0, rm=r.mts||r.createdAt||0;
      if(rm>lm){Object.keys(l).forEach(function(k){delete l[k];});Object.assign(l,r);l.mts=r.mts||lm;}
    });
    return localArr;
  }
  if((Array.isArray(R.examRecords)&&R.examRecords.length)||(Array.isArray(L.examRecords)&&L.examRecords.length))L.examRecords=mergeEntities(L.examRecords,R.examRecords,entMaps.examRecord,null,function(x){return x.mts||x.createdAt||0;});
  // 套卷成绩合并后，按合并结果重建当天 taojuan 派生壳（dailyStats 先于 examRecords 合并，
  // 壳不会自动跟着变），否则跨设备录卷后首页今日汇总/日历详情仍显示合并前的套数。
  try{
    const _tjDates=new Set();
    (L.examRecords||[]).forEach(function(r){if(r&&r.date)_tjDates.add(r.date);});
    (R.examRecords||[]).forEach(function(r){if(r&&r.date)_tjDates.add(r.date);});
    _tjDates.forEach(function(d){ syncTaojuanDaily(d); });
  }catch(e){}
  if((Array.isArray(R.shenlunReviews)&&R.shenlunReviews.length)||(Array.isArray(L.shenlunReviews)&&L.shenlunReviews.length))L.shenlunReviews=mergeEntities(L.shenlunReviews,R.shenlunReviews,entMaps.shenlunReview,null,function(x){return x.mts||x.createdAt||0;});
  // —— 课程：元数据按 mts 取较新（改名字/老师/模块/总讲数能同步）；
  //    讲数 done 按 n 并集（两端各听的讲都保留），撤销的讲用 lesson 墓碑同步 ——
  function mergeCourse(a,b){
    const r=Object.assign({},((b.mts||0)>(a.mts||0))?b:a);
    const lm=entityDelMap('lesson:'+(a.id!=null?a.id:b.id),L,R);
    const dm=new Map();
    [a.done,b.done].forEach(function(arr){
      (Array.isArray(arr)?arr:[]).forEach(function(d){
        if(!d||d.n==null)return;
        const ex=dm.get(d.n);
        if(!ex||((d.ts||0)>(ex.ts||0)))dm.set(d.n,d);
      });
    });
    r.done=Array.from(dm.values()).filter(function(d){
      const dt=lm.get(d.n);
      return !(dt!=null&&dt>(d.ts||0));
    });
    if(b.total&&(!r.total||b.total>r.total))r.total=b.total;
    if(b.note&&(!r.note||b.note.length>r.note.length))r.note=b.note;
    return r;
  }
  if((Array.isArray(R.courses)&&R.courses.length)||(Array.isArray(L.courses)&&L.courses.length)){
    L.courses=mergeEntities(L.courses,R.courses,entMaps.course,null,function(){return 0;},mergeCourse);
  }
  // —— 课表 timetable：按 id 并集，同 id 用 mts LWW（改期/换课等编辑能同步）——
  if((Array.isArray(R.timetable)&&R.timetable.length)||(Array.isArray(L.timetable)&&L.timetable.length))L.timetable=mergeEntities(L.timetable,R.timetable,entMaps.timetable,null,function(x){return x.mts||x.createdAt||0;});
  // ttTodoLog：key 并集，远端补缺
  if(R.ttTodoLog&&typeof R.ttTodoLog==='object'&&!Array.isArray(R.ttTodoLog)){
    if(!L.ttTodoLog||typeof L.ttTodoLog!=='object'||Array.isArray(L.ttTodoLog))L.ttTodoLog={};
    Object.keys(R.ttTodoLog).forEach(function(k){ if(L.ttTodoLog[k]==null)L.ttTodoLog[k]=R.ttTodoLog[k]; });
  }
  // —— 设置类偏好：统一按「每一项各自的修改时间」LWW，不再整包覆盖 ——
  mergePrefsLWW(L,R,'summaries','summariesMts',remoteTs);
  mergePrefsLWW(L,R,'userProfile','userProfileMts',remoteTs);
  mergePrefsLWW(L,R,'setVolume','setVolumeMts',remoteTs);
  mergePrefsLWW(L,R,'examDates','examDatesMts',remoteTs);
  // —— periodReviews {key:{text,ts}}：按 ts LWW ——
  (function(){
    const rv=R.periodReviews;
    if(!rv||typeof rv!=='object'||Array.isArray(rv))return;
    if(!L.periodReviews||typeof L.periodReviews!=='object'||Array.isArray(L.periodReviews))L.periodReviews={};
    Object.keys(rv).forEach(function(key){
      const lv=L.periodReviews[key], rem=rv[key];
      if(lv==null){L.periodReviews[key]=rem;return;}
      const lt=(lv&&lv.ts)||0, rt=(rem&&rem.ts)||0;
      if(rt>lt)L.periodReviews[key]=JSON.parse(JSON.stringify(rem));
    });
  })();
  // —— weakTargets / durTargets / countTargets：按对应 *Mts 做 per-key LWW ——
  (function(){
    const pairs=[['weakTargets','weakTargetsMts'],['durTargets','durTargetsMts'],['countTargets','countTargetsMts']];
    pairs.forEach(function(p){
      const vk=p[0], mk=p[1];
      const rv=R[vk]; if(!rv||typeof rv!=='object'||Array.isArray(rv))return;
      if(!L[vk]||typeof L[vk]!=='object'||Array.isArray(L[vk]))L[vk]={};
      if(!L[mk]||typeof L[mk]!=='object')L[mk]={};
      const rmts=R[mk]||{};
      Object.keys(rv).forEach(function(key){
        const lv=L[vk][key], lm=L[mk][key]||0, rm=rmts[key]||0;
        // lv 为空但 lm 有值 = 本端刚「清除目标」留下的墓碑，远端没有更新的改动就不能把它加回来
        if(lv==null){if(!lm||rm>lm){L[vk][key]=rv[key];L[mk][key]=rm||lm;}}
        else if(rm>lm){L[vk][key]=rv[key];L[mk][key]=rm;}
      });
    });
  })();
  // —— deletedBuiltin：{内容类型:[索引]} 内层数组也要并集 ——
  //    旧逻辑"本地已有该 key 就整段不覆盖"，导致两台设备删了同一分类下的不同条目时，
  //    远端删掉的内容在本端会复活。
  (function(){
    const rv=R.deletedBuiltin;
    if(!rv||typeof rv!=='object'||Array.isArray(rv))return;
    if(!L.deletedBuiltin||typeof L.deletedBuiltin!=='object'||Array.isArray(L.deletedBuiltin))L.deletedBuiltin={};
    Object.keys(rv).forEach(function(key){
      const ra=Array.isArray(rv[key])?rv[key]:[];
      if(!Array.isArray(L.deletedBuiltin[key])){
        if(ra.length)L.deletedBuiltin[key]=ra.slice();
        return;
      }
      const set=new Set(L.deletedBuiltin[key]);
      ra.forEach(function(i){ if(!set.has(i)){set.add(i);L.deletedBuiltin[key].push(i);} });
    });
  })();
  // —— checkinHidden：每个分类都记「显示0 / 隐藏1」状态，按分类 LWW ——
  //    两端各隐藏不同分类能合并；取消隐藏也能同步；老数据无 Mts 时退化为整体按负载时间。
  (function(){
    const rv=R.checkinHidden, rArr=Array.isArray(rv)?rv:[];
    if(!Array.isArray(rv)&&!R.checkinHiddenMts)return;
    if(!Array.isArray(L.checkinHidden))L.checkinHidden=[];
    if(!L.checkinHiddenMts||typeof L.checkinHiddenMts!=='object'||Array.isArray(L.checkinHiddenMts))L.checkinHiddenMts={};
    const cats=(typeof CHECKIN_CATEGORIES!=='undefined'&&Array.isArray(CHECKIN_CATEGORIES))?CHECKIN_CATEGORIES.slice():[];
    L.checkinHidden.concat(rArr).forEach(function(k){if(cats.indexOf(k)<0)cats.push(k);});
    const lv={},rvMap={};
    cats.forEach(function(k){
      lv[k]=L.checkinHidden.indexOf(k)>=0?1:0;
      rvMap[k]=rArr.indexOf(k)>=0?1:0;
    });
    const rm=(R.checkinHiddenMts&&typeof R.checkinHiddenMts==='object'&&!Array.isArray(R.checkinHiddenMts))?R.checkinHiddenMts:{};
    mergePrefMap(lv,rvMap,L.checkinHiddenMts,rm,state._syncTs||0,remoteTs||0);
    L.checkinHidden=Object.keys(lv).filter(function(k){return lv[k]===1;});
  })();
  // —— learnStage {内容key:{条目key:{s,n,r,t,w}}}：两层并集，同条目按 t LWW ——
  (function(){
    const rv=R.learnStage;
    if(!rv||typeof rv!=='object'||Array.isArray(rv))return;
    if(!L.learnStage||typeof L.learnStage!=='object'||Array.isArray(L.learnStage))L.learnStage={};
    Object.keys(rv).forEach(function(ck){
      const rm=rv[ck];if(!rm||typeof rm!=='object')return;
      if(!L.learnStage[ck]||typeof L.learnStage[ck]!=='object')L.learnStage[ck]={};
      Object.keys(rm).forEach(function(ik){
        const lv=L.learnStage[ck][ik], rem=rm[ik];
        if(lv==null){L.learnStage[ck][ik]=rem;return;}
        const lt=(lv&&lv.t)||0, rt=(rem&&rem.t)||0;
        if(rt>lt)L.learnStage[ck][ik]=JSON.parse(JSON.stringify(rem));
      });
    });
  })();
  // —— userProfile / setVolume / examDates 已在上方与 summaries 一起按项 LWW 合并 ——
  // —— exams（考试定义）：按 key 并集 + mts LWW + 删除墓碑 ——
  if((Array.isArray(R.exams)&&R.exams.length)||(Array.isArray(L.exams)&&L.exams.length)){
    const remoteNewer=remoteTs>(state._syncTs||0);
    // 旧数据没有 mts：远端更新时补名称/日期（兼容旧行为）
    (Array.isArray(R.exams)?R.exams:[]).forEach(function(re){
      if(!re||re.key==null||re.mts)return;
      const le=(Array.isArray(L.exams)?L.exams:[]).find(function(e){return e&&e.key===re.key;});
      if(le&&remoteNewer){if(re.name)le.name=re.name;if(re.date)le.date=re.date;}
    });
    L.exams=mergeEntities(L.exams,R.exams,entMaps.exam,function(e){return e.key;},function(e){return e.mts||0;});
  }
  // —— customData 各数组：按 id 并集 ——
  if(R.customData&&typeof R.customData==='object'){
    if(!L.customData||typeof L.customData!=='object')L.customData={};
    Object.keys(R.customData).forEach(function(k){
      if(!Array.isArray(R.customData[k]))return;
      if(!Array.isArray(L.customData[k]))L.customData[k]=R.customData[k].slice();
      else L.customData[k]=mergeEntities(L.customData[k],R.customData[k],entMaps['custom:'+k],null,function(x){return x.mts||0;});
    });
  }
  // —— dailyTasks（打卡分类任务定义）：之前完全没合并 ——
  if(Array.isArray(R.dailyTasks)&&R.dailyTasks.length){
    if(!Array.isArray(L.dailyTasks))L.dailyTasks=[];
    L.dailyTasks=mergeEntities(L.dailyTasks,R.dailyTasks,null);
  }
  // —— pomoNoPromptDate：取较新的日期 ——
  if(R.pomoNoPromptDate&&R.pomoNoPromptDate>(L.pomoNoPromptDate||''))L.pomoNoPromptDate=R.pomoNoPromptDate;
  // 合并后统一补迁移 + 数组守卫（远端可能是旧结构）
  migrateTodos();ensureArrayList();
}
function doPull(silent){
  var cfg=getSyncCfg();if(!cfg)return Promise.resolve();
  if(!navigator.onLine){setSyncStatus('offline');return Promise.resolve();}
  setSyncStatus('syncing');
  return giteeRead(cfg)
    .then(function(file){
      if(!file||!file.content)return setSyncStatus('ok','云端暂无数据');
      // base64 解回原文
      var raw;
      try{raw=decodeURIComponent(escape(atob(file.content.replace(/\s/g,''))));}
      catch(e){raw=atob(file.content.replace(/\s/g,''));}
      var remote;try{remote=JSON.parse(raw);}catch(e){return setSyncStatus('error','云端数据无法解析');}
      var remoteTs=remote._syncTs||0,localTs=state._syncTs||0;
      // 手动「立即同步」(非silent)遇到"本地有明确新改动且远端不同"，保留弹窗让用户拍板全量方向
      var lastPullTs=cfg.lastPullTs||0;
      var hasLocalChanges=localTs>lastPullTs;
      if(!silent&&hasLocalChanges&&remoteTs>localTs&&localHasRealData()){
        // 真冲突才问；否则走下方自动并集合并
        uiConfirm('检测到云端有更新的数据，同时本地也有未同步的修改。选择「确定」用云端数据覆盖本地（本地未同步的修改将丢失）；选择「取消」保留本地并做智能合并（两边数据都保留）',
          function(){ delete remote._syncTs;delete remote._photoStripped; state=Object.assign(loadData(),remote); migrateTodos();ensureArrayList(); state._syncTs=remoteTs; cfg.lastPullTs=remoteTs;setSyncCfg(cfg); save(true); render(); setSyncStatus('ok','已同步 '+fmtTime(new Date())); },
          {okText:'用云端覆盖', cancelText:'智能合并', onCancel:function(){ applyRemoteMerge(remote,remoteTs); state._syncTs=Date.now(); cfg.lastPullTs=Date.now();setSyncCfg(cfg); save(); render(); setSyncStatus('ok','已合并 '+fmtTime(new Date())); }});
        return;
      }
      // 默认（含自动轮询 / 空设备 / 无冲突）：做并集合并，绝不整包覆盖、绝不丢本地数据
      var remoteEmpty=!(remote.studyRecords&&Object.keys(remote.studyRecords).length)&&!(remote.dailyStats&&Object.keys(remote.dailyStats).length)&&!((remote.todos||[]).length)&&!((remote.customData&&Object.keys(remote.customData).some(k=>Array.isArray(remote.customData[k])&&remote.customData[k].length)));
      if(remoteTs>localTs&&!remoteEmpty){
        applyRemoteMerge(remote,remoteTs);
        state._syncTs=Date.now(); // 合并后本地包含远端，标记为"已含远端最新"
        cfg.lastPullTs=Date.now();setSyncCfg(cfg);
        save(true);render();
        setSyncStatus('ok','已同步 '+fmtTime(new Date()));
      }else if(remoteTs>localTs){
        // 远端是空的（被污染/空设备）但时间戳更高：绝不能覆盖本地，仅记录
        if(!cfg._cloudEmpty){cfg._cloudEmpty=remoteTs;setSyncCfg(cfg);}
        setSyncStatus('ok','云端无有效数据，已保留本地');
      }else{
        setSyncStatus('ok','已是最新 '+fmtTime(new Date()));
      }
    }).catch(function(e){setSyncStatus('error',e.message);});
}
// —— 自动调度：改动后 2 分钟防抖上传；开着每 30 秒静默拉取；切回窗口立即拉 ——
function scheduleSync(){
  var cfg=getSyncCfg();if(!cfg||cfg.auto===false)return;
  if(bootPullPending)return; // 启动拉取未完成前不放行上传，防覆盖云端
  if(syncTimer){clearTimeout(syncTimer);}
  syncTimer=setTimeout(function(){syncTimer=null;lastPush=Date.now();doPush();},AUTO_PUSH_DEBOUNCE);
}
function schedulePoll(){
  var cfg=getSyncCfg();if(!cfg||cfg.auto===false)return;
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
  // 切回前台立即拉一次，之后每 30 秒轮询（云端无更新不下载正文，几乎零开销）
  if(!document.hidden)doPull(true);
  pollTimer=setInterval(function(){if(!document.hidden)doPull(true);},AUTO_PULL_INTERVAL);
}
document.addEventListener('visibilitychange',function(){
  if(!document.hidden){
    if(getSyncCfg())doPull(true); // 切回前台立即拉
    if(pomo.running&&_pomoUpdate)_pomoUpdate(); // 切回前台立即刷新番茄钟显示（后台用时间戳续跑，数字即刻正确）
  }else{
    flushSyncIfDirty(); // 切到后台/最小化：趁页面还活着，先把未推送改动传上去
  }
});
let lastSyncTime=0; // 上次兜底合并时间戳
const DAILY_SYNC_HOUR=6; // 每天固定兜底同步时刻（凌晨 6:00）
let dailySyncTimer=null, dailySyncInterval=null;
function scheduleDailySync(){
  if(dailySyncTimer){clearTimeout(dailySyncTimer);dailySyncTimer=null;}
  if(dailySyncInterval){clearInterval(dailySyncInterval);dailySyncInterval=null;}
  var cfg=getSyncCfg();if(!cfg||cfg.auto===false)return;
  var now=new Date();
  var today6=new Date();today6.setHours(DAILY_SYNC_HOUR,0,0,0);
  // 补同步：今天 6 点已过、且今天还没兜底合并过 → 打开页面立即补一次
  if(now>=today6&&lastSyncTime<today6.getTime())doDailySync();
  var next=new Date(today6);
  if(next.getTime()<=now.getTime())next.setDate(next.getDate()+1);
  dailySyncTimer=setTimeout(function(){
    dailySyncTimer=null;doDailySync();
    dailySyncInterval=setInterval(doDailySync,24*60*60*1000);
  },next.getTime()-now.getTime());
}
function doDailySync(){
  var cfg=getSyncCfg();if(!cfg||cfg.auto===false)return;
  // 双向兜底：先拉（把云端合并到本机）再推（本机最新回传），保证两台迟早一致
  doPull(true).then(function(){doPush().then(function(){lastSyncTime=Date.now();});});
}
function doSyncNow(){doPull().then(function(){doPush().then(function(){lastSyncTime=Date.now();});});}
function syncConnect(){
  var token=(document.getElementById('syncKeyInput')||{}).value;(token=token||'').trim();token=token.trim();if(!token){toast('请先粘贴 Gitee 私人令牌');return;}
  var ownerEl=document.getElementById('syncOwnerInput');var owner=ownerEl?(ownerEl.value.trim()):'';
  var repoEl=document.getElementById('syncRepoInput');var repo=repoEl?(repoEl.value.trim()):'';
  var pathEl=document.getElementById('syncPathInput');var path=pathEl?((pathEl.value.trim())||'shangan_data.json'):'shangan_data.json';
  if(!owner||!repo){toast('请填写仓库所属用户名和仓库名');return;}
  var cfg={token:token,owner:owner,repo:repo,path:path,auto:true};
  setSyncStatus('syncing','连接中…');
  setSyncCfg(cfg);
  // ⚠️ 先拉云端，再推本机——顺序绝不能反！
  // 典型场景：新设备(空数据)后连接。若直接推，会把空数据 + 超大时间戳覆盖上云端，
  // 进而传染覆盖另一台开着轮询的设备。必须先 doPull 把云端已有数据导入本机，
  // 再 doPush 把「合并后的本机」回传（若本机本就有数据则正常备份上传，若为空则无害）。
  return doPull(true).then(function(){return doPush();})
    .then(function(){bootPullPending=false;scheduleSync();schedulePoll();scheduleDailySync();if(currentTab==='mine')render();setSyncStatus('ok','已连接并上传');})
    .catch(function(e){setSyncCfg(null);setSyncStatus('error',e.message||String(e));if(currentTab==='mine')render();});
}
function syncDisconnect(){
  uiConfirm('断开云端同步？本地数据保留，之后不再自动同步。',()=>{
    setSyncCfg(null);syncState={s:'idle',msg:'未配置'};if(currentTab==='mine')render();
  },{danger:true});
}
function initSync(){
  var cfg=getSyncCfg();if(!cfg)return;
  bootPullPending=true;
  /* 恢复上次关页时未推完的脏标记：beforeunload 的 fetch 常被浏览器丢弃，
     但 localStorage 里的 dirty 标记还在。这里读出来，拉完云端后立即补推（不走 2 分钟防抖），
     避免上次短会话的改动再拖 2 分钟才到云端。 */
  var resumedDirty=false;
  try{if(localStorage.getItem('shangan_dirty')==='1'){dirtySincePush=true;resumedDirty=true;}}catch(e){}
  var afterPull=function(){
    bootPullPending=false;
    if(!dirtySincePush)return;
    if(resumedDirty)doPush();      // 上次没推完的：立即补推
    else scheduleSync();           // 本次会话新改动：走 2 分钟防抖
  };
  doPull(true).then(afterPull).catch(afterPull);
  schedulePoll();        // 开着每 30 秒轮询
  scheduleDailySync();   // 6 点兜底（防抖上传则依赖 scheduleSync，由 save 触发）
}
function flushSyncIfDirty(){
  // 关页/切后台前，把尚未推送的本地改动立即传一次。
  // 关键场景：用户"开网站记几笔、不到 2 分钟就关"的短会话——防抖定时器随页面销毁，改动会漏传。
  var cfg=getSyncCfg();if(!cfg||cfg.auto===false)return;
  if(!dirtySincePush)return;
  if(!navigator.onLine)return;
  doPush(); // 立即推（不再等 2 分钟防抖）
}
function updateSidebarProfile(){
  const p=state.userProfile||{};
  const name=p.name||'云';
  const avatarEl=$('#sbAvatar');
  const nameEl=$('#sbName');
  const sigEl=$('#sbSignature');
  if(avatarEl){
    if(p.avatar){
      avatarEl.innerHTML=`<img src="${escapeHtml(p.avatar)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;">`;
    }else{
      avatarEl.textContent=name.charAt(0);
    }
  }
  if(nameEl)nameEl.textContent=name;
  if(sigEl)sigEl.textContent=p.signature||'';
}

/* ---------- 工具函数 ---------- */
const $=(s,el=document)=>el.querySelector(s);
const $$=(s,el=document)=>[...el.querySelectorAll(s)];
function todayStr(){return fmtDate(new Date());}
function fmtDate(d){const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function pad(n){return String(n).padStart(2,'0');}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}
function escapeHtml(s){return (s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));}
/* 外链白名单：只放行 http(s)，并转义引号/尖括号——URL 会被插进 href="..." 属性，
   不转义的话导入含恶意 URL 的数据可借双引号闭合属性注入事件处理器 */
function safeUrl(u){return (typeof u==='string'&&/^https?:\/\//i.test(u))?u.replace(/["'<>]/g,c=>({'"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;'}[c])):'';}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
// SVG 图标辅助函数
function icon(name,cls=''){return `<svg class="icon ${cls}"><use href="#i-${name}"/></svg>`;}
/* 问号小标识：把解释性括号注脚（…）收进一个「?」，悬停（PC）/ 点击（手机）弹出说明 */
function hmark(text,cls,label){
  const t=escapeHtml(text==null?'':String(text));
  const c=cls?(' '+cls):'';
  const g=label!=null?label:'?';
  return `<span class="hmark${c}" tabindex="0" role="button" aria-label="说明">${g}<span class="hmark-pop">${t}</span></span>`;
}
// 言语词库：把单个词渲染成可点标签；有例句时点击/悬停弹出例句（复用 .hmark-pop 样式）
function yiWordTag(word,example){
  if(example){
    return `<span class="ip-word ex-trig" tabindex="0" role="button" aria-label="查看例句" title="点击查看例句">${escapeHtml(word)}<span class="hmark-pop">${escapeHtml(example)}</span></span>`;
  }

  return `<span class="ip-word">${escapeHtml(word)}</span>`;
}
// 搜索结果高亮：把命中关键词包成 <mark class="wb-hl">（先转义再切分，避免 HTML 注入）
function wbHL(text,q){
  const safe=escapeHtml(text==null?'':String(text));
  if(!q) return safe;
  const qSafe=escapeHtml(q);
  if(!qSafe) return safe;
  return safe.split(qSafe).join('<mark class="wb-hl">'+qSafe+'</mark>');
}
// 搜索模式下的词名 chip（词名命中字高亮，例句气泡不高亮）
function yiWordTagHL(word,example,q){
  if(example){
    return '<span class="ip-word ex-trig" tabindex="0" role="button" aria-label="查看例句" title="点击查看例句">'+wbHL(word,q)+'<span class="hmark-pop">'+escapeHtml(example)+'</span></span>';
  }
  return '<span class="ip-word">'+wbHL(word,q)+'</span>';
}

// 辨析释义：diff 字段为「词名：释义；词名：释义」，逐条拆出词名加粗、各自成行（保留搜索高亮）
function renderDiffLines(diff,q){
  const raw=escapeHtml(diff==null?'':String(diff));
  return raw.split('；').map(seg=>{
    const idx=seg.indexOf('：');
    if(idx>0){
      const word=seg.slice(0,idx);
      const rest=seg.slice(idx+1);
      return `<div class="ip-line"><b class="wi-word">${wbHL(word,q)}</b>：${rest}</div>`;
    }
    return `<div class="ip-line">${seg}</div>`;
  }).join('');
}
// 把字符串里「解释性括号注脚（…）」转成问号小标识（先整段转义防注入，再在转义后文本里找全角括号）
function annot(s){
  s=(s==null)?'':String(s);
  s=escapeHtml(s);
  // 分数：[[分子|分母]]（支持嵌套）
  s=fracHtml(s);
  return s.replace(/（([^（）]*?)）/g,function(_,inner){return hmark(inner);});
}
// 问号小标识交互：悬停由 CSS 处理；点击切换 .open 供手机使用，点别处自动收起
/* ===== 分式渲染 =====
   1) fracFromSlash：把「分子/分母」这种最顺手的斜杠写法自动转成上下分式，省得记 [[|]]。
      左右按「遇到空格 / 运算符 / 括号」取词，括号里的内容整体保留（如 (现期-基期)/基期）。
   2) fracHtml：把 [[分子|分母]] 渲染成上下分式（显式写法，仍然支持）。 */
const FRAC_STOP_CHARS=' \t\r\n+-×*÷=()（）[]{}【】,，。、;；:：><≥≤≈|"\'';
function _fracStop(ch){return FRAC_STOP_CHARS.indexOf(ch)>=0;}
function fracFromSlash(s){
  s=(s==null)?'':String(s);
  let out='';const n=s.length;let i=0;
  while(i<n){
    const c=s[i];
    if(c!=='/'&&c!=='／'){out+=c;i++;continue;}
    let j=i-1,d=0;                       // 向左找分子
    while(j>=0){
      const ch=s[j];
      if(ch===')'||ch==='）'){d++;j--;continue;}
      if(d>0){if(ch==='('||ch==='（')d--;j--;continue;}
      if(_fracStop(ch))break;
      j--;
    }
    const num=s.slice(j+1,i);
    let k=i+1,d2=0;                      // 向右找分母
    while(k<n){
      const ch=s[k];
      if(ch==='('||ch==='（'){d2++;k++;continue;}
      if(d2>0){if(ch===')'||ch==='）')d2--;k++;continue;}
      if(_fracStop(ch))break;
      k++;
    }
    const den=s.slice(i+1,k);
    if(num&&den&&num.length<=40&&den.length<=40){
      out=out.slice(0,out.length-num.length)+'[['+num+'|'+den+']]'; // 分子此前已逐字追加，这里退回再换成分式
      i=k;
    }else{out+=c;i++;}
  }
  return out;
}
function fracHtml(s){
  s=(s==null)?'':String(s);
  return s.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g,'<span class="frac"><span class="num">$1</span><span class="den">$2</span></span>');
}
document.addEventListener('click',function(e){
  const m=e.target.closest('.hmark, .ip-word.ex-trig');
  if(m){
    e.preventDefault();
    if(e.target.closest('.hmark-pop'))return; // 点气泡内部（说明文字）不收起，方便选中
    const wasOpen=m.classList.contains('open');
    document.querySelectorAll('.hmark.open, .ip-word.ex-trig.open').forEach(x=>x.classList.remove('open'));
    if(!wasOpen)m.classList.add('open');
    return;
  }
  document.querySelectorAll('.hmark.open, .ip-word.ex-trig.open').forEach(x=>x.classList.remove('open'));
});
document.addEventListener('keydown',function(e){
  if((e.key==='Enter'||e.key===' ')&&e.target.classList&&(e.target.classList.contains('hmark')||e.target.classList.contains('ex-trig'))){
    e.preventDefault();e.target.classList.toggle('open');
  }
});
// 合并内置数据与用户自定义数据（支持 _ovr 覆盖：用户编辑内置项后存为带 _ovr 的自定义项）
function mergeData(key,builtin,custom){
  const deleted=state.deletedBuiltin?.[key]||[];
  const cus=custom&&custom.length?custom.slice():[];
  // 覆盖映射：自定义中带 _ovr=n 的项用于替换内置第 n 条
  const ovrMap={};
  const plain=cus.filter(it=>{ if(!it)return false; if(typeof it._slot==='number')return false; if(typeof it._ovr==='number'){ovrMap[it._ovr]=it;return false;} return true; });
  const withSlot=cus.filter(it=>it&&typeof it._slot==='number');
  const out=[];
  builtin.forEach((it,i)=>{
    if(deleted.includes(i))return;            // 被删除的内置不显示
    const ov=ovrMap[i];
    if(ov)out.push(Object.assign({},ov,{_ovr:i})); // 用覆盖项替换（保留 _ovr 身份）
    else out.push(it);
  });
  // 去重：plain 自定义与（未被覆盖的）内置指纹相同 → 隐藏，避免重复
  const outKeys=new Set();
  out.forEach(it=>{ const k=contentKey(it,key); if(k!=null)outKeys.add(k); });
  const plainDedup=plain.filter(it=>{ const k=contentKey(it,key); return !(k!=null&&outKeys.has(k)); });
  if(withSlot.length){
    withSlot.slice().sort((a,b)=>a._slot-b._slot).forEach(it=>{ out.splice(Math.min(it._slot,out.length),0,it); });
  }
  return out.concat(plainDedup);
}
// 基于日期的轮换索引（total<=0 时返回 0，避免 NaN 导致访问 undefined 崩溃）
function dayIndex(total,offset=0){
  if(!total||total<=0)return 0;
  const d=new Date();const seed=d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate();
  return (seed+offset)%total;
}
function dayTotalMin(dateStr){
  const rec=state.studyRecords[dateStr];let m=0;
  if(rec){(rec.sessions||[]).forEach(s=>m+=s.duration);}
  // 打卡录入的用时也计入学习时长（修复：学习时长双源不互通）
  const ds=state.dailyStats[dateStr];
  if(ds){Object.keys(ds).forEach(k=>{m+=(ds[k].minutes||0);});}
  return m;
}
function daySectionMin(dateStr){
  const map={};const rec=state.studyRecords[dateStr];
  if(rec){(rec.sessions||[]).forEach(s=>{
    if(!s.section)return;
    map[s.section]=(map[s.section]||0)+s.duration;});}
  // 打卡录入的用时按模块计入时长分布（修复：学习时长双源不互通）
  const ds=state.dailyStats[dateStr];
  if(ds){Object.keys(ds).forEach(k=>{map[k]=(map[k]||0)+(ds[k].minutes||0);});}
  return map;
}
// 统一判定：某天某模块是否完成打卡（录入题量 或 历史打卡标记任一为真）
function isChecked(dateStr,k){
  const ds=(state.dailyStats[dateStr]||{})[k];
  return !!(ds&&(ds.count||0)>0);
}

/* ---------- 导航 ---------- */
const TAB_TITLES={
  countdown:'首页',
  politics:'政治理论',changshi:'常识',yanyu:'言语理解',luoji:'判断推理',
  shuliang:'数量关系',ziliao:'资料分析',
  xiaoti:'申论小题',dazuowen:'大作文',
  review:'数据',mine:'我的',music:'音乐',brush:'笔记',course:'课程'
};
/* 8 个内容模块（行测 6 + 申论 2）：用于底部「刷题」Tab 高亮归属判断 */
const MODULE_TABS=['politics','changshi','yanyu','luoji','shuliang','ziliao','xiaoti','dazuowen'];
let currentTab='countdown';
let reviewMainTab='overview';

/* 模块 key → 侧边栏 tab key（两者不完全同名，必须映射） */
const SECTION_TO_TAB={
  yanyu:'yanyu', luoji:'luoji', ziliao:'ziliao', shuliang:'shuliang',
  changshi:'changshi', shenlun:'xiaoti'
};
/* 模块 → 页面 tab；申论/套卷/晨读没有对应内容页，返回空字符串让调用方别跳转 */
function tabOfSection(sec){
  const t=sec?(SECTION_TO_TAB[sec]||sec):'';
  return TAB_TITLES[t]?t:'';
}
/* 待办点击导航：优先「关联模块」的模块页；没关联模块时再按任务类型跳转
   （网课→课程页，刷题→笔记页）。修复：以前 jumpType='brush' 会先拦截，
   导致「关联了常识/言语等模块、但任务类型是刷题(默认)」的任务点了跳笔记页 */
function navTodo(td){
  if(!td)return;
  const jt=td.jumpType||'';
  if(jt==='course'){goTab('course');return;}
  if(td.section){const tab=tabOfSection(td.section);if(tab){goTab(tab);return;}}
  if(jt==='brush'||jt==='note'){goTab('brush');return;}
  openTodoEditor(td);
}

/* 反查：页面 tab → 模块 key（申论含小题与大作文两个页面） */
const TAB_SECTION={
  politics:'changshi', changshi:'changshi', yanyu:'yanyu',
  luoji:'luoji', shuliang:'shuliang', ziliao:'ziliao',
  xiaoti:'shenlun', dazuowen:'shenlun'
};

/* 把滚动容器瞬间拉到指定位置（无动画）。
   .content 设了 scroll-behavior:smooth，切页时直接赋 scrollTop 会播"往上滑"动画，
   这里临时改成 auto、赋完值再还原，做到无动画直达顶部 */
function scrollTopInstant(el,top){
  if(!el)return;
  const prev=el.style.scrollBehavior;
  el.style.scrollBehavior='auto';
  el.scrollTop=top;
  if(prev)el.style.scrollBehavior=prev;else el.style.scrollBehavior='';
}

/* 统一切页入口：供侧边栏 / 今日任务 / 其他跳转复用 */
function goTab(tab){
  if(!TAB_TITLES[tab])return false;
  if(tab===currentTab){closeDrawer();return true;}
  // 离开首页时先停掉实时时钟，避免定时器泄漏
  if(_homeHeaderTimer){clearInterval(_homeHeaderTimer);_homeHeaderTimer=null;}
  $$('.nav-item').forEach(b=>b.classList.remove('active'));
  const btn=document.querySelector('.nav-item[data-tab="'+tab+'"]');
  if(btn)btn.classList.add('active');
  currentTab=tab;
  updateTopbar(tab);
  updateTabbar();
  closeDrawer();
  const content=$('#content');
  // 非实时 tab 且已有缓存面板 → 直接复用 DOM（不重新渲染，不闪动）
  if(!NO_CACHE_TABS[tab]&&_tabPanes[tab]){
    content.replaceChildren(_tabPanes[tab]);
  }else{
    render();   // 实时 tab 或首次访问 → 重建
  }
  // 搜索键跟随当前内容：内容区有搜索条才显示（缓存面板复用不重新 render，需兜底）
  const _st=document.getElementById('searchTopBtn');
  if(_st)_st.style.display=content.querySelector('.mod-search')?'flex':'none';
  try{
    window.scrollTo(0,0);
    scrollTopInstant($('#content'),0);
    scrollTopInstant(document.scrollingElement,0);
  }catch(e){}
  return true;
}

/* 底部 Tab 栏（手机端）：壳里没有静态 #tabbar 节点，这里动态补创建，
   否则 ensureTabbarVisible/updateTabbar 操作的是不存在的元素，底部栏永不显示。 */
/* stroke:true = 选中态用「描边加粗」而非「实心填充」。
   多线条图标（题卡/书本/折线）实心填充会糊成色块，必须走描边。 */
const TABBAR_ITEMS=[
  {tab:'countdown',icon:'home',label:'首页'},
  {tab:'course',icon:'book-open',label:'课程'},
  {tab:'brush',icon:'book',label:'笔记',stroke:true},
  {tab:'review',icon:'trending',label:'数据',stroke:true},
  {tab:'mine',icon:'user',label:'我的'}
];
function mountTabbar(){
  if($('#tabbar'))return;            // 防止重复创建
  const app=$('#app'); if(!app)return;
  const bar=el('div','tabbar'); bar.id='tabbar';
  bar.innerHTML=TABBAR_ITEMS.map(it=>
    `<button class="tab-btn${it.stroke?' tab-stroke':''}" data-tab="${it.tab}">${icon(it.icon)}<span>${it.label}</span></button>`
  ).join('');
  app.appendChild(bar);
}
mountTabbar();

$$('.nav-item').forEach(btn=>{
  btn.addEventListener('click',()=>{
    goTab(btn.dataset.tab);
  });
});
/* 底部 Tab 导航（手机端）：首页 / 学习 / 数据 / 我的 */
$$('.tab-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{goTab(btn.dataset.tab);});
});
/* 顶部常驻音乐入口：进音乐页（播放中另由 nowPlayBtn 提供暂停） */
const musicEntryBtn=$('#musicEntryBtn');
if(musicEntryBtn)musicEntryBtn.addEventListener('click',()=>goTab('music'));
/* 右上角音乐按钮（移动端无侧边栏，这是手机端进音乐页的入口；桌面端也常驻，点开即听） */
const musicTopBtn=document.getElementById('musicTopBtn');
if(musicTopBtn)musicTopBtn.addEventListener('click',()=>goTab('music'));
/* 顶栏搜索键：展开/收起当前模块的搜索行 */
const searchTopBtn=document.getElementById('searchTopBtn');
if(searchTopBtn)searchTopBtn.addEventListener('click',()=>{
  const content=document.getElementById('content');
  // 先按"可见"面板找；offsetParent 在部分无布局/隐藏容器下恒为 null，
  // 因此再兜底直接从当前内容区取——否则会误判成"没有搜索条"而永远展不开
  const pane=[...document.querySelectorAll('.tab-pane')].find(p=>p.offsetParent!==null)||content;
  const bar=(pane&&pane.querySelector('.mod-search'))||(content&&content.querySelector('.mod-search'));
  if(!bar){toast('进入具体模块后可使用搜索');return;}
  const open=bar.classList.toggle('open');
  const inp=bar.querySelector('.ms-input');
  const clear=bar.querySelector('.ms-clear');
  if(open){
    // 同步聚焦（不能放进 setTimeout）：iOS PWA 里延时超过手势窗口会丢失「用户激活」，
    // 虚拟键盘起不来 → 搜索框点开却输不进字。先 instant 滚动到位再聚焦，避免键盘动画期 smooth 滚动把键盘挤掉
    if(inp){bar.scrollIntoView({block:'nearest',behavior:'auto'});inp.focus();}
  }else{
    if(inp){inp.value='';inp.dispatchEvent(new Event('input',{bubbles:true}));}
    if(clear)clear.style.display='none';
  }
});

/* ---------- 抽屉（手机端） ---------- */
function openDrawer(){$('#sidebar').classList.add('open');$('#drawerMask').classList.add('show');}
function closeDrawer(){$('#sidebar').classList.remove('open');$('#drawerMask').classList.remove('show');}
$('#menuBtn').addEventListener('click',openDrawer);
$('#drawerMask').addEventListener('click',closeDrawer);

/* ---------- 侧滑打开/关闭侧边栏（跟手版） ---------- */
(function initSwipeDrawer(){
  const sb=$('#sidebar'), mask=$('#drawerMask'), app=$('#app');
  let sx=0, sy=0, tracking=false, startTime=0;
  let startOpen=false, currentX=0;
  const SIDEBAR_W=260; // 与CSS中 --sidebar-w 一致
  function isMobile(){return window.innerWidth<=768;}
  function setDrawerX(x, animate){
    if(animate){sb.style.transition='';mask.style.transition='';}
    else{sb.style.transition='none';mask.style.transition='none';}
    const clamped=Math.max(-SIDEBAR_W,Math.min(0,x));
    sb.style.transform=`translateX(${clamped}px)`;
    const opacity=(clamped+SIDEBAR_W)/SIDEBAR_W*0.5;
    mask.style.opacity=opacity;
    mask.style.display=clamped>-SIDEBAR_W+5?'block':'none';
    currentX=clamped;
  }
  document.addEventListener('touchstart',function(e){
    if(!isMobile())return;
    const t=e.touches[0]; sx=t.clientX; sy=t.clientY; startTime=Date.now();
    startOpen=sb.classList.contains('open');
    currentX=startOpen?0:-SIDEBAR_W;
    tracking=true;
  },{passive:true});
  document.addEventListener('touchmove',function(e){
    if(!tracking)return;
    const t=e.touches[0]; const dx=t.clientX-sx, dy=t.clientY-sy;
    // 纵向为主则不响应横向滑动
    if(Math.abs(dy)>Math.abs(dx)*1.5&&Math.abs(dx)<30){tracking=false;return;}
    if(Math.abs(dx)<8)return; // 小抖动忽略
    const targetX=startOpen?dx:-SIDEBAR_W+dx;
    setDrawerX(targetX,false);
  },{passive:true});
  document.addEventListener('touchend',function(e){
    if(!tracking)return;
    tracking=false;
    const dragDist=Math.abs(currentX-(startOpen?0:-SIDEBAR_W));
    // 轻点（几乎没移动）：开着即关，点一下遮罩立刻收起
    if(dragDist<10){
      if(startOpen){sb.classList.remove('open');mask.classList.remove('show');}
      setTimeout(()=>{
        sb.style.transition='';sb.style.transform='';
        mask.style.transition='';mask.style.opacity='';mask.style.display='';
      },10);
      return;
    }
    const dt=Math.max(Date.now()-startTime,1);
    const dxTotal=currentX-(startOpen?0:-SIDEBAR_W); // 负=更靠近关闭
    const v=dxTotal/dt; // 带符号速度 px/ms，左滑为负
    const threshold=SIDEBAR_W*0.3;
    let shouldOpen;
    if(startOpen){
      // 开着：划过 30% 或 明显向左快甩则收起，否则保持打开
      const close=(dxTotal<=-threshold)||(v<-0.5&&Math.abs(dxTotal)>15);
      shouldOpen=!close;
    }else{
      shouldOpen=(dxTotal>threshold)||(v>0.5);
    }
    if(shouldOpen){
      sb.classList.add('open');mask.classList.add('show');
      setDrawerX(0,true);
    }else{
      sb.classList.remove('open');mask.classList.remove('show');
      setDrawerX(-SIDEBAR_W,true);
    }
    // 动画结束后清理内联样式，让CSS class接管
    setTimeout(()=>{
      sb.style.transition='';sb.style.transform='';
      mask.style.transition='';mask.style.opacity='';mask.style.display='';
    },300);
  },{passive:false});
})();

/* 已构建的 tab 面板缓存：切回已访问过的 tab 时直接复用 DOM，不重新渲染 → 不闪动 */
var _tabPanes={};
/* 这些 tab 含实时内容（首页实时时钟 / 音乐播放器 / 同步状态），每次切回都重建以保证状态最新 */
const NO_CACHE_TABS={countdown:true,music:true,mine:true};
let _freshDone=false;   // 仅首屏首次渲染播放卡片入场动画，之后切 tab/刷新数据不再重播
let _preserveView=null; // 渲染时保留视图状态 {scrollTop,scrollY,expanded:[secKey]}：用于「设置目标」等场景不跳回顶部

/* 顶栏：标题 + 模块管理按钮 */
function updateTopbar(tab){
  const pt=$('#pageTitle'); if(pt)pt.textContent=TAB_TITLES[tab]||'';
  const mgrBtn=$('#mgrBtn');
  if(mgrBtn){
    if(tab==='brush'){
      // 学习页只是模块入口，没有具体模块可管理，隐藏「管理内容」
      mgrBtn.style.display='none';
    }else if(MODULE_CONTENT_KEYS[tab]){mgrBtn.style.display='flex';mgrBtn.onclick=()=>openContentManager(tab);}
    else mgrBtn.style.display='none';
  }
  // 音乐：右上角常驻入口（移动端无侧边栏，靠这个进音乐页）；在音乐页本身隐藏避免重复
  const musicTopBtn=$('#musicTopBtn');
  if(musicTopBtn)musicTopBtn.style.display=(tab==='music')?'none':'flex';
}

/* 渲染入口：重建当前 tab 面板（数据可能已变更），刷新缓存并替换进 #content */
function render(){
  // 离开首页时清理时钟定时器，避免泄漏（renderHomeBar 会按需在首页重建）
  if(_homeHeaderTimer){clearInterval(_homeHeaderTimer);_homeHeaderTimer=null;}
  /* 课表联动：今天有关联课程的课 → 自动生成「听第N讲」待办（幂等，ttTodoLog 防重） */
  if(typeof syncTimetableTodos==='function')syncTimetableTodos();
  updateSidebarProfile();
  updateTopbar(currentTab);
  const content=$('#content');
  if(!_freshDone)content.classList.add('fresh');   // 首屏：让卡片播放入场动画
  // 关键：先把空面板挂到文档，再调用各 tab 的渲染函数填充。
  // 否则渲染函数内 document.querySelector('#id') 找不到自己刚创建的子元素（脱离文档的临时节点），
  // 会导致 addEventListener 报错、整页打不开（总结/音乐/我的 等页即用此写法）。
  const pane=el('div','tab-pane');
  content.replaceChildren(pane);
  const map={
    countdown:renderCountdown,
    politics:c=>renderModulePage('politics',c),changshi:c=>renderModulePage('changshi',c),yanyu:c=>renderModulePage('yanyu',c),
    luoji:c=>renderModulePage('luoji',c),shuliang:c=>renderModulePage('shuliang',c),ziliao:c=>renderModulePage('ziliao',c),
    xiaoti:c=>renderModulePage('xiaoti',c),dazuowen:c=>renderModulePage('dazuowen',c),
    review:renderReview,mine:renderMine,
    music:renderMusicPage,brush:renderBrush,course:renderCourses
  };
  if(TAB_SECTION[currentTab])_yanyuTodoRef=renderSectionTodoCard(currentTab);
  else _yanyuTodoRef=null;   // 非模块页：清空引用，避免上一次模块页的待办卡被错插进当前页（曾导致 学习→言语 后任务栏丢失）
  (map[currentTab]||renderCountdown)(pane);
  // 模块页面顶部插入「本模块待办」
  if(TAB_SECTION[currentTab] && _yanyuTodoRef){
    if(pane.firstChild)pane.insertBefore(_yanyuTodoRef,pane.firstChild);
    else pane.appendChild(_yanyuTodoRef);
  }
  // 只在非实时 tab 上缓存：NO_CACHE_TABS 每次访问都重建，缓存它只会让旧 DOM 滞留内存
  if(!NO_CACHE_TABS[currentTab])_tabPanes[currentTab]=pane;
  scrollTopInstant(content,_preserveView?(_preserveView.scrollTop||0):0);
  if(!_freshDone){
    _freshDone=true;
    setTimeout(()=>{content.classList.remove('fresh');},450); // 动画播完再移除，避免跳变
  }
  try{window.scrollTo(0,_preserveView?(_preserveView.scrollY||0):0);}catch(e){}
  updateTabbar();
}

/* 模块页顶部的关联待办：只显示未完成、且 7 天内到期的 */
function renderSectionTodoCard(tab){
  const sec=TAB_SECTION[tab];if(!sec)return null;
  const t=todayStr();
  const list=(state.todos||[]).filter(x=>x.section===sec&&!x.done);
  list.sort((a,b)=>{const ad=a.dueDate||'9999-12-31',bd=b.dueDate||'9999-12-31';return ad.localeCompare(bd);});
  const card=el('div','card sec-todo-card');
  card.innerHTML=`<div class="sec-todo-head">
      <div class="section-title"><span class="dot"></span>本模块待办 <span class="today-count${list.length?'':' zero'}">${list.length}</span></div>
      <button class="btn btn-sm sec-todo-add" aria-label="添加本模块待办">${icon('plus')} 添加</button>
    </div>`;
  card.querySelector('.sec-todo-add').addEventListener('click',()=>openTodoEditor(null,sec));
  if(!list.length){
    const e=el('div','empty-tip');
    e.textContent='暂无关联本模块的待办';
    card.appendChild(e);
  }else{
    const lw=el('div','today-list');
    list.forEach(td=>{
      const hasDue=!!(td.dueDate&&td.dueDate.length>0);
      const cls=!hasDue?'long-term':(td.dueDate<t?'overdue':(td.dueDate===t?'today':'upcoming'));
      const diff=hasDue?dayDiff(t,td.dueDate):null;
      const dueTxt=!hasDue?'长期':(diff===0?'今天':(diff>0?`还剩${diff}天`:`逾期${-diff}天`));
      const rep=repeatLabel(td.repeat);
      const cnt=(td.doneCount&&isRepeat(td))?`已${td.doneCount}次`:'';
      const tkey=td.section?(td.sub||td.section):null;
      const tval=(tkey&&state.durTargets&&state.durTargets[tkey]!=null)?state.durTargets[tkey]:null;
      const tlabel=tkey?(tval!=null?('目标'+tval):'设目标'):'设目标';
      const _jt=td.jumpType||'brush';
      const _jtName=({course:'网课',note:'记笔记',brush:'刷题',review:'复盘',other:'其他'})[_jt]||'刷题';
      const it=el('div','today-item '+cls);
      it.innerHTML=`
        <button class="today-check" aria-label="完成">${icon('check')}</button>
        <div class="today-main grow">
          <div class="today-text">${escapeHtml(td.text)}<span class="todo-typetag t-${_jt}">${_jtName}</span></div>
          <div class="today-sub${cls==='overdue'?' od':''}">${td.sub?subName(td.sub)+' · ':''}${dueTxt}${rep?' · '+rep:''}${cnt?' · '+cnt:''}</div>
          ${rep?`<div class="today-rep">${icon('repeat')} ${rep}</div>`:''}
        </div>
        <span class="today-pill ${todoPriority(td)}" style="background:${priorityColor(todoPriority(td))}20;color:${priorityColor(todoPriority(td))}">${priorityLabel(todoPriority(td))}</span>
        ${td.jumpType!=='course'?`<button class="today-pomo" data-id="${td.id}" aria-label="专注" title="专注">${icon('alarm')}</button>`:''}
        <button class="today-edit" data-id="${td.id}" aria-label="编辑">${icon('edit')}</button>`;
      it.querySelector('.today-check').addEventListener('click',e=>{e.stopPropagation();toggleTodo(td.id);});
      it.querySelector('.today-edit').addEventListener('click',e=>{e.stopPropagation();openTodoEditor(td);});
      const _pomoBtn=it.querySelector('.today-pomo');
      if(_pomoBtn)_pomoBtn.addEventListener('click',e=>{e.stopPropagation();startPomoForTask(td);});
      lw.appendChild(it);
    });
    card.appendChild(lw);
  }
  return card;
}

/* ---------- 底部 Tab 导航高亮：模块页归属「刷题」 ---------- */
/* 兜底：手机端底部栏必须可见。CSS 媒体查询在个别浏览器 /「请求桌面版」/缓存旧页等
   情况下可能不命中，这里按屏幕实际宽度+触摸能力兜一次，确保底部栏不会凭空消失。 */
function ensureTabbarVisible(){
  const tb=$('#tabbar'); if(!tb)return;
  const w=window.innerWidth||document.documentElement.clientWidth||0;
  const touch=('ontouchstart' in window)||(navigator.maxTouchPoints>0);
  const isPhone=w<=768||(touch&&w<1024);   // 窄屏手机，或触摸设备（含桌面版模式的 980px 手机）
  if(isPhone){
    if(getComputedStyle(tb).display==='none')tb.style.display='flex';
  }else{
    if(tb.style.display==='flex')tb.style.display='';   // 宽屏交回 CSS 接管（隐藏，用侧栏）
  }
}
window.addEventListener('resize',ensureTabbarVisible);
window.addEventListener('orientationchange',()=>setTimeout(ensureTabbarVisible,120));

function updateTabbar(){
  ensureTabbarVisible();
  const t=currentTab;
  let active;
  if(MODULE_TABS.indexOf(t)>=0||t==='brush')active='brush';
  else if(t==='course')active='course';
  else if(t==='review')active='review';
  else if(t==='mine')active='mine';
  else active='countdown';   // 首页 / 音乐 / 其它
  $$('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===active));
}

/* ============================================================
   模块页 / 刷题页：通用搜索 + 长列表默认折叠
   - 所有模块长列表条目共用一组条目类，统一做文本过滤与折叠
   - 用 MutationObserver 监听内容区变化，内部子 tab 切换后自动重算
   ============================================================ */
const MODULE_ITEM_SEL='.fc-item,.fz-item,.bhf-chip,.sc-item,.news-item,.fill-item,.pf-cell,.ds-item,.dzw-case,.sln-type,.sln-rule,.dc-title,.fold-item';

/* 根据当前搜索词 + 展开状态，重算条目显隐与卡片折叠 */
function applyModuleView(container,input){
  if(!container)return;
  const q=(input&&input.value||'').trim().toLowerCase();
  const items=[...container.querySelectorAll(MODULE_ITEM_SEL)];
  // 1) 文本过滤
  items.forEach(it=>{
    const match=!q||it.textContent.toLowerCase().includes(q);
    it.style.display=match?'':'none';
  });
  // 2) 隐藏空分组（资料 .fz-section / 常识 .sense-cat / 规范词 .gf-group）。固定分类里的空分组带 .gf-empty，保留给引导文案
  container.querySelectorAll('.fz-section,.sense-cat,.gf-group:not(.gf-empty)').forEach(g=>{
    const any=[...g.querySelectorAll(MODULE_ITEM_SEL)].some(x=>x.style.display!=='none');
    g.style.display=any?'':'none';
  });
  // 3) 隐藏整卡（卡内条目全被过滤掉时）
  container.querySelectorAll('.card').forEach(card=>{
    const kids=[...card.querySelectorAll(MODULE_ITEM_SEL)];
    if(kids.length && !kids.some(x=>x.style.display!=='none'))card.style.display='none';
    else card.style.display='';
  });
  // 4) 整页搜不到时给个提示（模块自己在卡片外放一个 [data-search-empty] 元素）
  container.querySelectorAll('[data-search-empty]').forEach(t=>{
    const any=[...container.querySelectorAll('.card:not(.sec-todo-card)')].some(c=>c.style.display!=='none');
    t.style.display=(q&&!any)?'':'none';
  });
}

/* 生成搜索条（含输入框 + 清除按钮），返回 bar 元素 */
function createModuleSearchBar(){
  const bar=document.createElement('div');
  bar.className='mod-search';
  bar.innerHTML=`<span class="ms-ico">${icon('search')}</span>
    <input class="ms-input" type="search" placeholder="搜索本模块内容…" aria-label="搜索本模块内容">
    <button class="ms-clear" aria-label="清除" style="display:none;">${icon('close')}</button>`;
  return bar;
}
let _modObserver=null;
/* 在 container 上挂搜索条 + 观察者。inputParent 为搜索条挂载点（避免被内部 replaceChildren 冲掉） */
function mountModuleSearch(container,inputParent){
  const bar=createModuleSearchBar();
  if(inputParent&&inputParent!==container)inputParent.appendChild(bar);
  else container.insertBefore(bar,container.firstChild);
  const input=bar.querySelector('.ms-input');
  const clear=bar.querySelector('.ms-clear');
  input.addEventListener('input',(e)=>{
    // 拼音组合期间不重渲染：否则整页重建会把输入法候选框打断，中文根本输不进去
    if(e.isComposing)return;
    clear.style.display=input.value?'':'none';
    if(container._wb){renderYanyuCore(container);}else{applyModuleView(container,input);}
  });
  // 兜底：部分输入法上屏时不触发 input，compositionend 再渲染一次
  input.addEventListener('compositionend',()=>{
    clear.style.display=input.value?'':'none';
    if(container._wb){renderYanyuCore(container);}else{applyModuleView(container,input);}
  });
  // 注意：聚焦时不要 input.select() 全选——重渲染后自动重新聚焦会把已输的字全选，再打字即覆盖，
  // 移动端拼不出多个词，像「输不进去」。去掉它，保持普通输入框行为
  clear.addEventListener('click',()=>{
    input.value='';clear.style.display='none';
    if(container._wb){renderYanyuCore(container);}else{applyModuleView(container,input);}
  });
  // 观察者：内容区内部重渲染（子 tab 切换 / 刷题芯片切换）后自动重算
  if(_modObserver)_modObserver.disconnect();
  let _applying=false,_timer=null;
  _modObserver=new MutationObserver(()=>{
    if(_applying)return;
    if(_timer)clearTimeout(_timer);
    _timer=setTimeout(()=>{_applying=true;try{applyModuleView(container,input);}finally{_applying=false;}},30);
  });
  _modObserver.observe(container,{childList:true,subtree:true});
  applyModuleView(container,input);
  const st=document.getElementById('searchTopBtn'); if(st)st.style.display='flex';
  return {bar,input};
}


/* 模块页（独立 tab）包装：加搜索条后再渲染模块内容 */
function renderModulePage(sec,c){
  // 言语词库模块：搜索框改为跨分区搜索（不走 DOM 过滤，重渲染内容）
  if(sec==='yanyu')c._wb=true;
  mountModuleSearch(c,c);
  const fn=BRUSH_RENDER[sec];
  if(fn)fn(c);
}

/* 刷题页模块 → 渲染函数（复用各模块页渲染器） */
const BRUSH_RENDER={
  politics:renderPolitics,changshi:renderChangshi,yanyu:renderYanyu,
  luoji:renderLuoji,shuliang:renderShuliang,ziliao:renderZiliao,
  xiaoti:renderXiaoti,dazuowen:renderDazuowen
};

/* 学习页：先选模块，点卡片才跳进该模块内容页（不再把「模块切换」和「模块内容」挤在同一页） */
const MODULE_PICK={
  yanyu:   {icon:'type',      desc:'逻辑填空 · 片段阅读 · 语句表达'},
  luoji:   {icon:'puzzle',    desc:'图形 · 定义 · 类比 · 逻辑判断'},
  ziliao:  {icon:'bar-chart', desc:'图文 · 表格 · 综合 · 套题'},
  shuliang:{icon:'hash',      desc:'工程 · 行程 · 利润 · 排列组合'},
  changshi:{icon:'book-open', desc:'法律 · 政治 · 经济 · 人文 · 科技'},
  politics:{icon:'lightbulb', desc:'新思想 · 马原 · 时政热点'},
  xiaoti:  {icon:'file-text', desc:'归纳概括 · 综合分析 · 提出对策'},
  dazuowen:{icon:'edit',      desc:'主题素材 · 案例 · 金句'}
};
  /* ============================================================
   课程表：周历查看 + 月历安排
   每节课两种重复：weekly=每周固定（绑定星期几），once=仅这一天（绑定日期）
   ============================================================ */
const TT_WEEKDAYS=['周日','周一','周二','周三','周四','周五','周六'];
const TT_COL_ORDER=[1,2,3,4,5,6,0]; // 周一起头，周日收尾
const TT_PERIODS=[['morning','上午'],['afternoon','下午'],['evening','晚上']];
const TT_MODULE_OPTS=[['','不关联'],['politics','政治理论'],['changshi','常识'],['yanyu','言语理解'],['luoji','判断推理'],['shuliang','数量关系'],['ziliao','资料分析'],['xiaoti','申论小题'],['dazuowen','大作文']];
let ttCursor=new Date();
function ttDateStr(x){return x.getFullYear()+'-'+pad(x.getMonth()+1)+'-'+pad(x.getDate());}
function ttWeekStart(d){const x=new Date(d);const wd=x.getDay();x.setDate(x.getDate()+(wd===0?-6:1-wd));x.setHours(0,0,0,0);return x;}
/* 课表条目关联的课程是否已听满总讲数（已结课）。
   未关联课程、课程已被删除、或没设总讲数（不限讲）→ 一律不算结课，课表照常排。 */
function ttCourseFinished(item){
  if(!item||!item.courseId)return false;
  const c=(state.courses||[]).find(x=>x&&x.id===item.courseId);
  if(!c||!c.total)return false;
  return (c.done||[]).length>=c.total;
}
function ttDayCourses(ds,includeFinished){
  const wd=new Date(ds+'T00:00:00').getDay();
  return (state.timetable||[]).filter(c=>{
    if(!c)return false;
    if(c.repeat==='once'){if(c.date!==ds)return false;}
    else if(c.weekday!==wd)return false;
    /* 已结课的关联课程不再循环排（每周三的A课听完后，周三格子/今日条/月历徽标都不再出现）；
       includeFinished=true 仅用于当天管理面板，保留入口可编辑/删除课表条目 */
    if(!includeFinished&&ttCourseFinished(c))return false;
    return true;
  });
}
/* 课表模块色：行测模块取 SECTION_MAP 主色；politics/申论两块不在该表，单独配色；未关联用中性紫 */
function ttModColor(mod){
  if(mod==='politics')return '#2BB673';
  if(mod==='xiaoti')return '#E67E22';
  if(mod==='dazuowen')return '#E05C5C';
  return (SECTION_MAP[mod]&&SECTION_MAP[mod].color)||'#B8AFE6';
}
function ttModName(mod){const o=TT_MODULE_OPTS.find(x=>x[0]===mod);return o?o[1]:'';}
/* 课表 → 待办联动：当天课表里「关联了我的课程」的条目，自动生成「听第N讲」待办。
   防重三层：① state.ttTodoLog[ttId@date] 生成历史；② 今天已有同 courseId 待办（含手动加的）不重复生成；
   ③ 课程总讲数已听完不再生成下一讲。日志超过 30 天自动清理。
   闭环：生成的待办带 jumpType:'course'+courseId，勾选后 syncCourseProgressByTodo 给课程 +1 讲。 */
function syncTimetableTodos(silent){
  const t=todayStr();
  if(!state.ttTodoLog)state.ttTodoLog={};
  /* 顺手清理 30 天前的生成日志，避免只增不清 */
  let logChanged=false;
  Object.keys(state.ttTodoLog).forEach(function(k){
    const at=(k.split('@')[1]||'');
    if(/^\d{4}-\d{2}-\d{2}$/.test(at)){
      const diff=Math.round((new Date(t+'T00:00:00')-new Date(at+'T00:00:00'))/86400000);
      if(diff>30){delete state.ttTodoLog[k];logChanged=true;}
    }
  });
  const list=ttDayCourses(t).filter(c=>c&&c.courseId);
  if(!list.length){if(logChanged)save();return 0;}
  let made=0;
  list.forEach(c=>{
    const k=c.id+'@'+t;
    if(state.ttTodoLog[k])return;
    const course=findCourse(c.courseId);
    /* 课程不存在（删课程会解除 courseId，此处双保险）→ 记日志跳过 */
    if(!course){state.ttTodoLog[k]=Date.now();return;}
    const learned=(course.done?course.done.length:0);
    /* 总讲数已听完 → 不再生成「下一讲」 */
    if(course.total&&learned>=course.total){state.ttTodoLog[k]=Date.now();return;}
    /* 今天已有同课程的待办（手动加的也算，含已完成）→ 不重复生成，记日志防反复检查 */
    const dup=(state.todos||[]).some(td=>td&&td.courseId===course.id&&td.dueDate===t);
    state.ttTodoLog[k]=Date.now();
    if(dup)return;
    const next=nextLessonNum(course);
    (state.todos=state.todos||[]).push({
      id:'tt_'+c.id+'_'+t,
      text:c.name+' 第'+next+(course.type==='brush'?'章':'讲'),
      dueDate:t,
      section:course.section||c.module||'',
      sub:'', count:0, repeat:{type:'none'}, jumpType:'course', courseId:course.id,
      done:false, ts:Date.now(), mts:Date.now(), autoTt:c.id
    });
    made++;
  });
  if(made||logChanged)save();
  /* silent=true 时由调用方合并提示（课表保存流程），避免和「课程已安排」两条 toast 互盖；
     render() 入口自动触发时不 silent，照常自己提示 */
  if(made&&!silent)toast('已为今天 '+made+' 节课生成听课待办');
  return made;
}
/* 格内/当天课程按创建先后排序（同一门课一天可加多节，按添加顺序排） */
function ttSort(list){return (list||[]).slice().sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));}
/* 当前查看的是第几周（相对本周）：0=本周 -1=上周 1=下周，其他返回 null */
function ttWeekOffset(ws){
  const w=Math.round((ws.getTime()-ttWeekStart(new Date()).getTime())/604800000);
  return (w>=-2&&w<=2&&w!==0)?w:(w===0?0:null);
}
function renderTimetableCard(pane){
  const card=el('div','card tt-card');
  const ws=ttWeekStart(ttCursor),we=new Date(ws);we.setDate(we.getDate()+6);
  const wsStr=ttDateStr(ws),weStr=ttDateStr(we);
  const todayD=todayStr();
  const woff=ttWeekOffset(ws);
  const weekTitle=(woff===0?'本周':(woff===-1?'上周':(woff===1?'下周':'本周')))+'课表';
  // 本周课程总节数（每周固定 + 本周内一次性课）
  let weekCount=0;
  for(let i=0;i<7;i++){const d=new Date(ws);d.setDate(d.getDate()+i);weekCount+=ttDayCourses(ttDateStr(d)).length;}
  card.innerHTML=`<div class="tt-head">
      <div class="section-title"><span class="dot"></span>${weekTitle}<span class="muted-tip">${wsStr.slice(5)} ~ ${weStr.slice(5)}</span>${weekCount?`<span class="tt-week-count">${weekCount} 节</span>`:''}</div>
      <div class="tt-nav">
        <button class="tt-nav-btn" id="ttPrev">‹</button>
        <button class="tt-nav-btn${woff===0?' disabled':''}" id="ttToday">本周</button>
        <button class="tt-nav-btn" id="ttNext">›</button>
        <button class="btn btn-primary btn-sm" id="ttMonthBtn">${icon('calendar')} 月历安排</button>
      </div>
    </div>`;
  // 今日课程快捷条：只在查看本周时出现，格子里名字被压缩时这里能看清今天上什么
  if(woff===0){
    const tWd=new Date().getDay();
    const tList=ttSort(ttDayCourses(todayD));
    if(tList.length){
      const bar=el('div','tt-today');
      bar.innerHTML=`<span class="tt-today-label">今天 <b>${tList.length}</b> 节</span>`;
      const wrap=el('div','tt-today-list');
      tList.forEach(c=>{
        const chip=el('button','tt-today-chip');
        chip.style.borderLeftColor=ttModColor(c.module);
        chip.innerHTML=`<span class="tt-today-name">${escapeHtml(c.name)}</span>`;
        chip.addEventListener('click',()=>openTimetableEdit(tWd,todayD,c.id));
        wrap.appendChild(chip);
      });
      bar.appendChild(wrap);
      card.appendChild(bar);
    }
  }
  // 周历：周几列头 + 每天一格（课程不按时段划分，一天几节课都收进当天格子里）
  const grid=el('div','tt-grid');
  TT_COL_ORDER.forEach(wd=>{
    const d=new Date(ws);d.setDate(d.getDate()+TT_COL_ORDER.indexOf(wd));
    const dsStr=ttDateStr(d);
    const isToday=dsStr===todayD;   // 必须按真实日期判断：旧写法 wd===今天星期几，翻到任何一周都高亮，是 bug
    const h=el('div','tt-col-head'+(isToday?' today':''));
    h.innerHTML=`<span class="tt-col-wd">${TT_WEEKDAYS[wd]}</span><span class="tt-col-date">${d.getMonth()+1}/${d.getDate()}</span>`;
    grid.appendChild(h);
  });
  TT_COL_ORDER.forEach(wd=>{
    const d=new Date(ws);d.setDate(d.getDate()+TT_COL_ORDER.indexOf(wd));
    const dsStr=ttDateStr(d);
    const isToday=dsStr===todayD;
    const cell=el('div','tt-cell'+(isToday?' today':''));
    const list=ttSort(ttDayCourses(dsStr));
    if(list.length){
      list.forEach(c=>{
        const it=el('div','tt-item');
        it.dataset.id=c.id;
        it.style.borderLeftColor=ttModColor(c.module);
        it.title=(c.module?ttModName(c.module)+' · ':'')+c.name;
        it.innerHTML=`<span class="tt-item-name">${escapeHtml(c.name)}</span>`;
        it.addEventListener('click',e=>{e.stopPropagation();openTimetableEdit(wd,dsStr,c.id);});
        cell.appendChild(it);
      });
    }else{
      cell.innerHTML='<span class="tt-add">+</span>';
    }
    cell.addEventListener('click',()=>openTimetableEdit(wd,dsStr,null));
    grid.appendChild(cell);
  });
  card.appendChild(grid);
  const bnd=(id,fn)=>{const b=card.querySelector('#'+id);if(b)b.addEventListener('click',fn);};
  bnd('ttPrev',()=>{ttCursor=new Date(ws);ttCursor.setDate(ttCursor.getDate()-7);ttRerender(pane);});
  bnd('ttNext',()=>{ttCursor=new Date(ws);ttCursor.setDate(ttCursor.getDate()+7);ttRerender(pane);});
  bnd('ttToday',()=>{if(ttWeekOffset(ws)!==0){ttCursor=new Date();ttRerender(pane);}});
  bnd('ttMonthBtn',()=>openTimetableMonth());
  return card;
}

function ttRerender(pane){
  const old=pane.querySelector('.tt-card');if(old)old.remove();
  pane.insertBefore(renderTimetableCard(pane),pane.firstChild);
}
function ttRefreshAfterEdit(){
  const card=document.querySelector('.tt-card');
  const pane=card?card.parentElement:(document.querySelector('.tab-pane')||null);
  if(pane)ttRerender(pane);
}
function openTimetableMonth(){
  const calCursor=new Date();
  openModal('月历安排课程','<div id="ttCalBody"></div>');
  const body=document.getElementById('ttCalBody');
  function update(){
    const y=calCursor.getFullYear(),m=calCursor.getMonth();
    body.innerHTML='';
    const head=el('div','cal-head');
    const isCur=y===new Date().getFullYear()&&m===new Date().getMonth();
    head.innerHTML=`<button class="cal-arrow" id="ttCalPrev">‹</button><span class="cal-title${isCur?'':' tt-cal-back'}" id="ttCalTitle">${y}年${m+1}月${isCur?'':' · 点此回本月'}</span><button class="cal-arrow" id="ttCalNext">›</button>`;
    body.appendChild(head);
    const grid=el('div','cal-grid');
    ['日','一','二','三','四','五','六'].forEach(d=>{const e=el('div','cal-dow');e.textContent=d;grid.appendChild(e);});
    const first=new Date(y,m,1).getDay();
    const daysInMonth=new Date(y,m+1,0).getDate();
    for(let i=0;i<first;i++)grid.appendChild(el('div','cal-cell empty'));
    for(let day=1;day<=daysInMonth;day++){
      const ds=y+'-'+pad(m+1)+'-'+pad(day);
      const wd=new Date(ds+'T00:00:00').getDay();
      const cn=ttDayCourses(ds).length;   // 每周固定课也要在月历上可见，不能只标一次性
      const cell=el('div','cal-cell'+(ds===todayStr()?' today':'')+(cn?' tt-has':'')+(cn>=3?' tt-many':''));
      cell.innerHTML=`<span>${day}</span>`+(cn?`<span class="tt-cal-n">${cn}节</span>`:'');
      cell.addEventListener('click',()=>openTimetableDay(wd,ds));
      grid.appendChild(cell);
    }
    body.appendChild(grid);
    /* 翻月先把日钳到 1：calCursor 初始化为 new Date()（保留当日，可能是 31 号），
       直接 setMonth(±1) 时若目标月没有该日（如 1 月 31 日 → 2 月），JS 会自动溢出到下月，
       表现为「1 月 31 日点下一月跳到 3 月 3 日」。统一先 setDate(1) 再 setMonth。 */
    document.getElementById('ttCalPrev').addEventListener('click',()=>{calCursor.setDate(1);calCursor.setMonth(calCursor.getMonth()-1);update();});
    document.getElementById('ttCalNext').addEventListener('click',()=>{calCursor.setDate(1);calCursor.setMonth(calCursor.getMonth()+1);update();});
    const back=document.getElementById('ttCalTitle');
    if(back)back.addEventListener('click',()=>{calCursor.setTime(new Date().getTime());update();});
  }
  update();
}
/* 月历点日期 → 当天课程列表（旧逻辑直接进新增，当天已有课完全看不到也改不了） */
function openTimetableDay(weekday,ds){
  const parts=ds.split('-');
  openModal((+parts[1])+'月'+(+parts[2])+'日 '+TT_WEEKDAYS[weekday],`
    <div id="ttDayBody"></div>
    <div class="rep-bottom">
      <button class="btn btn-ghost" id="ttDayClose">返回</button>
      <button class="btn btn-primary" id="ttDayAdd">+ 安排一节</button>
    </div>`);
  const body=document.getElementById('ttDayBody');
  /* 管理面板要包含已结课条目（includeFinished）：常规视图隐藏后，仍能从这里编辑/解除关联 */
  const all=ttSort(ttDayCourses(ds,true));
  if(!all.length){
    const tip=el('div','empty-tip');tip.textContent='当天没有课程安排';body.appendChild(tip);
  }else{
    all.forEach(c=>{
      const fin=ttCourseFinished(c);
      const row=el('div','tt-day-row'+(fin?' tt-day-fin':''));
      row.style.borderLeftColor=fin?'#bbb':ttModColor(c.module);
      row.innerHTML=`<span class="tt-day-name">${escapeHtml(c.name)}</span>`
        +(fin?'<span class="tt-fin-tag">已结课</span>':'')
        +(c.module&&!fin?`<span class="tt-day-mod" style="color:${ttModColor(c.module)}">${ttModName(c.module)}</span>`:'');
      row.addEventListener('click',()=>{closeModal();openTimetableEdit(weekday,ds,c.id,true);});
      body.appendChild(row);
    });
  }
  document.getElementById('ttDayClose').addEventListener('click',()=>{closeModal();openTimetableMonth();});
  document.getElementById('ttDayAdd').addEventListener('click',()=>{closeModal();openTimetableEdit(weekday,ds,null,true);});
}
function openTimetableEdit(weekday,dateStr,id,keepDay){
  const isEdit=!!id;
  const old=isEdit?(state.timetable||[]).find(c=>c&&c.id===id):null;
  const label=dateStr?TT_WEEKDAYS[weekday]+'（'+dateStr+'）':TT_WEEKDAYS[weekday];
  const selR=old&&old.repeat==='once'?'once':'weekly';
  // 课程名下拉建议：来自「我的课程」里已有的课名，省得重复手打
  const nameOpts=(Array.isArray(state.courses)?state.courses:[]).map(c=>c&&c.name).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i);
  openModal(isEdit?'编辑课程':'安排课程',`
    <div class="dlg-form">
      <label class="dlg-label">课程名称<i class="req">*</i></label>
      <input class="dlg-input" id="ttName" list="ttNameList" maxlength="24" placeholder="如：判断推理系统课" value="${escapeHtml(old?old.name:'')}">
      <datalist id="ttNameList">${nameOpts.map(n=>`<option value="${escapeHtml(n)}">`).join('')}</datalist>

      <label class="dlg-label">关联课程</label>
      <select class="dlg-input" id="ttCourse">
        <option value="">不关联（独立课节）</option>
        ${(Array.isArray(state.courses)?state.courses:[]).filter(c=>c&&c.id).map(c=>`<option value="${c.id}"${old&&old.courseId===c.id?' selected':''}>${escapeHtml(c.name||'')}</option>`).join('')}
      </select>

      <label class="dlg-label">关联模块</label>
      <select class="dlg-input" id="ttModule">
        ${TT_MODULE_OPTS.map(o=>`<option value="${o[0]}"${old&&old.module===o[0]?' selected':''}>${o[1]}</option>`).join('')}
      </select>

      <div class="tt-repeat-card">
        <div class="tt-repeat-head">
          <span class="tt-repeat-title">重复安排</span>
          <span class="field-help tt-repeat-date">${label}</span>
        </div>
        <div class="tt-seg" id="ttSegR">
          <button class="tt-seg-btn${selR==='weekly'?' active':''}" data-v="weekly">每周固定</button>
          <button class="tt-seg-btn${selR==='once'?' active':''}" data-v="once">仅这一天</button>
        </div>
      </div>
    </div>
    <div class="rep-bottom">
      ${isEdit?`<button class="btn btn-ghost btn-sm" id="ttDelBtn">${icon('trash')} 删除</button>`:''}
      <button class="btn btn-ghost" id="ttCancelBtn">取消</button>
      <button class="btn btn-primary" id="ttSaveBtn">保存</button>
    </div>`);
  const seg=(id)=>{const box=document.getElementById(id);if(!box)return;box.querySelectorAll('.tt-seg-btn').forEach(b=>{b.addEventListener('click',()=>{box.querySelectorAll('.tt-seg-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');});});};
  seg('ttSegR');
  /* 选关联课程：自动带出课程名和模块（可再手改） */
  const ttCourseSel=document.getElementById('ttCourse');
  if(ttCourseSel)ttCourseSel.addEventListener('change',()=>{
    const c=findCourse(ttCourseSel.value);
    if(!c)return;
    const nameInp=document.getElementById('ttName');
    if(nameInp&&c.name)nameInp.value=c.name;
    const modSel=document.getElementById('ttModule');
    if(modSel&&c.section&&TT_MODULE_OPTS.some(o=>o[0]===c.section))modSel.value=c.section;
  });
  document.getElementById('ttCancelBtn').addEventListener('click',closeModal);
  document.getElementById('ttSaveBtn').addEventListener('click',()=>{
    const name=document.getElementById('ttName').value.trim();
    if(!name){toast('请填写课程名称');return;}
    const rEl=document.querySelector('#ttSegR .tt-seg-btn.active');
    const repeat=rEl?rEl.dataset.v:'weekly';
    const module=document.getElementById('ttModule').value;
    const courseId=document.getElementById('ttCourse').value||'';
    // 同一门课程一天可加多节（听多讲），不再做同名同日拦截
    if(!state.timetable)state.timetable=[];
    if(isEdit){
      const c=state.timetable.find(x=>x&&x.id===id);
      if(c){
        /* 改期/换关联课程：回收这条课表之前自动生成、但还没完成的听课待办（已完成的历史保留）；
           同时清掉它的生成日志，改到今天时 syncTimetableTodos 会按新安排重新生成 */
        const schedChanged=(old.repeat!==repeat)
          ||(repeat==='weekly'&&old.weekday!==weekday)
          ||(repeat==='once'&&(old.date||'')!==(dateStr||''));
        const courseChanged=(old.courseId||'')!==courseId;
        if(schedChanged||courseChanged){
          dropTodos(td=>td&&td.autoTt===id&&!td.done);
          if(state.ttTodoLog)Object.keys(state.ttTodoLog).forEach(k=>{if(k.indexOf(id+'@')===0)delete state.ttTodoLog[k];});
        }
        c.name=name;c.module=module;c.repeat=repeat;c.weekday=weekday;c.courseId=courseId||undefined;if(repeat==='once')c.date=dateStr;else delete c.date;
        c.mts=Date.now();
      }
    }else{
      state.timetable.push({id:uid(),name,module,repeat,weekday,date:repeat==='once'?dateStr:undefined,createdAt:Date.now(),mts:Date.now(),courseId:courseId||undefined});
    }
    save();
    /* 先静默同步拿生成数，合并进「课程已添加」一条提示，避免两条 toast 互相覆盖 */
    const _ttMade=syncTimetableTodos(true);
    ttRefreshAfterEdit();
    if(keepDay){closeModal();openTimetableDay(weekday,dateStr);}
    else closeModal();
    toast((isEdit?'课程已更新':'课程已添加')+(_ttMade?('，已生成今天 '+_ttMade+' 节听课待办'):''));
  });
  const del=document.getElementById('ttDelBtn');
  if(del)del.addEventListener('click',()=>{
    const c=state.timetable?state.timetable.find(x=>x&&x.id===id):null;
    const nm=c?c.name:'这节课';
    closeModal();
    uiConfirm('删除课程「'+nm+'」？'+(c&&c.repeat==='weekly'?'它每周都会从课表消失。':''),function(){
      state.timetable=(state.timetable||[]).filter(x=>x&&x.id!==id);markEntityDeleted('timetable',[id]);
      /* 一并清掉它自动生成但还没完成的听课待办（已完成的历史保留）+ 生成日志 */
      dropTodos(td=>td&&td.autoTt===id&&!td.done);
      if(state.ttTodoLog)Object.keys(state.ttTodoLog).forEach(k=>{if(k.indexOf(id+'@')===0)delete state.ttTodoLog[k];});
      save();toast('课程已删除');ttRefreshAfterEdit();
      if(keepDay)openTimetableDay(weekday,dateStr);
    },{danger:true,okText:'删除'});
  });
}
function renderBrush(pane){
  const st=document.getElementById('searchTopBtn'); if(st)st.style.display='none';
  if(!pane)pane=el('div','tab-pane');
  const grid=el('div','modpick-grid');
  MODULE_TABS.forEach(function(k){
    const cfg=MODULE_PICK[k]||{};
    const card=el('button','modpick-card');
    card.innerHTML=`<span class="modpick-ico">${icon(cfg.icon||'book')}</span>`
      +`<span class="modpick-name">${TAB_TITLES[k]||k}</span>`
      +`<span class="modpick-desc">${cfg.desc||''}</span>`;
    card.addEventListener('click',function(){goTab(k);});
    grid.appendChild(card);
  });
  pane.appendChild(grid);
  return pane;
}

/* ============================================================
   课程（听课进度）
   听完一讲只记进度、不记时间（听课要搭配做题/笔记，真实时长用番茄钟更有意义）。
   ============================================================ */
function findCourse(id){ return (Array.isArray(state.courses)?state.courses:[]).filter(function(c){return c&&c.id===id;})[0]||null; }
/* 迁移：老数据 done 是 [{id,ts,date}] 纯计数，没有「第几讲」编号。
   补成 [{n,ts,date}]：旧数据按顺序补 1..k；已带 n 的保留；同号去重 */
function migrateCourseDone(){
  let changed=false;
  (state.courses||[]).forEach(function(c){
    if(!c)return;
    if(!Array.isArray(c.done)){if(c.done!==undefined){c.done=[];changed=true;}return;}
    const before=JSON.stringify(c.done);
    if(c.done.length && c.done.every(function(d){return d&&typeof d.n!=='number';})){
      c.done=c.done.map(function(d,i){return {n:i+1,ts:d.ts||Date.now(),date:d.date||todayStr()};});
    }
    c.done.forEach(function(d,i){ if(d&&typeof d.n!=='number')d.n=i+1; });
    const seen={}; c.done=c.done.filter(function(d){ if(!d||seen[d.n])return false; seen[d.n]=1; return true; });
    if(JSON.stringify(c.done)!==before)changed=true;
  });
  return changed;
}
/* 该课程已听完的讲号集合 */
function courseDoneSet(c){ return new Set((c.done||[]).map(function(d){return d.n;}).filter(function(n){return typeof n==='number';})); }
/* 下一讲未听（最小未听编号）；全听完返回 total+1（或已听数+1） */
function nextLessonNum(c){
  const tt=+c.total||0; const set=courseDoneSet(c);
  for(let i=1;i<=(tt||(set.size+1));i++){ if(!set.has(i))return i; }
  return (tt||set.size)+1;
}
/* 标记/取消某讲：点格子切换。cellEl 用于就地更新 UI（避免整页重渲染丢滚动） */
function toggleLesson(id,n,cellEl){
  const c=findCourse(id); if(!c)return;
  if(!Array.isArray(c.done))c.done=[];
  const set=courseDoneSet(c);
  const item=cellEl?cellEl.closest('.course-item'):null;
  const d=todayStr();
  if(set.has(n)){
    c.done=c.done.filter(x=>x.n!==n);
    markEntityDeleted('lesson:'+id,[n]);   // 跨端同步：撤销的讲用墓碑标记，避免被对端 done 并集恢复
    c.mts=Date.now();
    save();
    if(cellEl)cellEl.classList.remove('on');
    toast('已取消「'+c.name+'」第 '+n+(c.type==='brush'?' 章':' 讲'));
  }else{
    c.done.push({n:n,ts:Date.now(),date:d});
    save();
    if(cellEl)cellEl.classList.add('on');
    toast('已标记「'+c.name+'」第 '+n+(c.type==='brush'?' 章':' 讲'));
    syncTodoForLesson(c,n);
    if(c.total&&c.done.length>=c.total){
      if(dropTodos(td=>td&&!td.done&&td.jumpType==='course'&&td.autoTt&&td.courseId===c.id)){save();setTimeout(()=>toast(c.type==='brush'?'练习册已刷完，自动练习待办已清理':'课程已结课，自动听课待办已清理'),800);}
    }
    if(c.type==='brush')promptBrushIfNeeded(c);
  }
  const tt=+c.total||0, done=c.done.length;
  const pct=tt?Math.min(100,Math.round(done/tt*100)):(done?100:0);
  if(item){
    const bar=item.querySelector('.course-bar i'); if(bar)bar.style.width=pct+'%';
    const meta=item.querySelector('.course-meta'); if(meta)meta.innerHTML='<span>已听 <b>'+done+'</b>'+(tt?(' / '+tt):'')+' 讲'+(tt?('（'+pct+'%）'):'')+'</span>';
    item.classList.toggle('course-done', tt>0&&done>=tt);
    let tag=item.querySelector('.course-finish-tag');
    if(tt>0&&done>=tt){ if(!tag){const nm=item.querySelector('.course-name'); const t=document.createElement('span');t.className='course-finish-tag';t.textContent='已结课';nm.appendChild(t);} }
    else if(tag){tag.remove();}
    const undoBtn=item.querySelector('.course-undo'); if(undoBtn)undoBtn.style.display=done?'':'none';
    const lc=item.querySelector('.lesson-count'); if(lc)lc.textContent=(c.done?c.done.length:0)+'/'+(+c.total||0);
  }
}
/* 讲义弹窗：显示全部讲次格子，可跳着标（点哪讲标哪讲，再点取消）；含「撤销最近一讲」 */
function openLessonsModal(c){
  const isBk=c.type==='brush', unit=isBk?'章':'讲', doneWord=isBk?'已刷':'已听';
  const tt=+c.total||0; if(tt<=0){toast(isBk?'这本练习册没设章节数，无法显示章节格':'该课程没设总讲数，无法显示讲义格');return;}
  const set=courseDoneSet(c);
  let cells='';
  for(let n=1;n<=tt;n++){ cells+='<button type="button" class="les-cell'+(set.has(n)?' on':'')+'" data-n="'+n+'">'+n+'</button>'; }
  const body='<div class="les-modal-head"><span class="les-modal-count" id="lesModalCount">'+doneWord+' '+(c.done?c.done.length:0)+'/'+tt+'</span>'
    +'<button type="button" class="btn btn-ghost les-modal-undo" id="lesModalUndo">撤销最近一'+unit+'</button></div>'
    +'<div class="lesson-grid les-modal-grid" id="lesModalGrid">'+cells+'</div>';
  openModal((isBk?'章节':'讲义')+' · '+c.name, body);
  const box=$('#modalBody'); if(!box)return;
  box.querySelectorAll('.les-cell').forEach(function(cell){
    cell.addEventListener('click',function(){
      const n=parseInt(cell.dataset.n,10);
      const wasOn=set.has(n);
      toggleLesson(c.id,n,null);
      const cnt=(findCourse(c.id).done||[]).length;
      const cc=box.querySelector('#lesModalCount'); if(cc)cc.textContent=doneWord+' '+cnt+'/'+tt;
      cell.classList.toggle('on',!wasOn);
      refreshCourseCardDOM(c.id);
    });
  });
  const undoBtn=box.querySelector('#lesModalUndo');
  if(undoBtn)undoBtn.addEventListener('click',function(){
    const cur=findCourse(c.id); if(!cur||!(cur.done||[]).length){toast('没有可撤销的'+unit+'次');return;}
    const last=cur.done.reduce(function(a,x){return (x.n>a.n?x:a);},{n:0});
    toggleLesson(cur.id,last.n,null);
    const cnt=(findCourse(c.id).done||[]).length;
    const cc=box.querySelector('#lesModalCount'); if(cc)cc.textContent=doneWord+' '+cnt+'/'+tt;
    const uc=box.querySelector('.les-cell[data-n="'+last.n+'"]'); if(uc)uc.classList.remove('on');
    refreshCourseCardDOM(c.id);
  });
}
/* 讲义弹窗里改完，就地刷新对应课程卡（进度条/已听数/讲义按钮计数/结课态），不整页重渲染 */
function refreshCourseCardDOM(cid){
  const item=document.querySelector('.course-item[data-cid="'+cid+'"]'); if(!item)return;
  const c=findCourse(cid); if(!c)return;
  const isBk=c.type==='brush', unit=isBk?'章':'讲', doneWord=isBk?'已刷':'已听';
  const tt=+c.total||0, done=(c.done||[]).length;
  const pct=tt?Math.min(100,Math.round(done/tt*100)):(done?100:0);
  const bar=item.querySelector('.course-bar i'); if(bar)bar.style.width=pct+'%';
  const meta=item.querySelector('.course-meta'); if(meta)meta.innerHTML='<span>'+doneWord+' <b>'+done+'</b>'+(tt?(' / '+tt):'')+' '+unit+(tt?('（'+pct+'%）'):'')+'</span>';
  item.classList.toggle('course-done', tt>0&&done>=tt);
  let tag=item.querySelector('.course-finish-tag');
  if(tt>0&&done>=tt){ if(!tag){const nm=item.querySelector('.course-name'); const t=document.createElement('span');t.className='course-finish-tag';t.textContent=isBk?'已刷完':'已结课';nm.appendChild(t);} }
  else if(tag){tag.remove();}
  const lb=item.querySelector('.course-lessons'); if(lb)lb.textContent=(isBk?'章节':'讲义')+' '+done+(tt?('/'+tt):'');
  const nb=item.querySelector('.course-next');
  if(nb){
    if(tt>0&&done>=tt){nb.disabled=true;nb.textContent=(isBk?'已刷完 ':'已听完 ')+tt+' '+unit+' ✓';nb.style.opacity='.5';nb.style.cursor='default';}
    else {nb.disabled=false;nb.style.opacity='';nb.style.cursor='';}
  }
}
/* 同步「第 n 讲」待办为完成 */
function syncTodoForLesson(c,n){
  if(!Array.isArray(state.todos))return;
  const matched=state.todos.find(td=>{
    if(!td||td.done||td.jumpType!=='course')return false;
    if(td.courseId)return td.courseId===c.id;
    const txt=td.text||'';
    return txt.includes(c.name)&&new RegExp('第\\s*'+n+'\\s*[讲章]').test(txt);
  });
  if(matched){
    completeTodoOnce(matched,{advanceDueDate:false});
    save();
    setTimeout(()=>toast('同步完成待办：'+matched.text),600);
  }
}
/* 听完一讲：仅用于「未设总讲数」的课程（无格子可点时的兜底 +1） */
function finishLesson(id){
  const c=findCourse(id); if(!c)return;
  const d=todayStr();
  if(!Array.isArray(c.done))c.done=[];
  const tt=+c.total||0;
  /* 下一讲用 nextLessonNum（最小未听编号），不能用 done.length+1：
     支持跳着听（如只标过第 5 讲），length+1 会错记成第 2 讲 */
  const n=nextLessonNum(c);
  if(tt&&n>tt){toast(c.name+(c.type==='brush'?' 已全部刷完（共 '+tt+' 章）':' 已全部听完（共 '+tt+' 讲）'));return;}
  c.done.push({n:n,ts:Date.now(),date:d});
  save();
  toast((c.type==='brush'?'已刷完 ':'已听完 ')+c.name+' 第 '+n+(c.type==='brush'?' 章':' 讲')+(tt?('（共 '+tt+(c.type==='brush'?' 章':' 讲')+'）'):''));
  syncTodoForLesson(c,n);
  if(tt&&c.done.length>=tt){
    if(dropTodos(td=>td&&!td.done&&td.jumpType==='course'&&td.autoTt&&td.courseId===c.id)){save();setTimeout(()=>toast(c.type==='brush'?'练习册已刷完，自动练习待办已清理':'课程已结课，自动听课待办已清理'),1200);}
  }
  render();
  if(c.type==='brush')promptBrushIfNeeded(c);
}
/* 练习册听完一讲后，统一弹出「本次有刷题？」选择录入成绩或跳过。
   课程页点「上完一课」与勾选「听一讲」网课待办两条路径共用，保证行为一致 */
function promptBrushIfNeeded(c){
  if(!c||c.type!=='brush')return;
  if(c.section&&SECTION_MAP[c.section]){
    setTimeout(()=>askBrushRecord(c),300);
  }else{
    toast('「'+c.name+'」是练习册，但没关联模块，去编辑里选好模块就能录成绩');
  }
}
/* 练习册听完一讲后：弹出「本次有刷题？」选择录入成绩或跳过 */
function askBrushRecord(c){
  const _last=(c.done&&c.done.length)?c.done[c.done.length-1]:null;
  const bkN=_last?(typeof _last==='object'?(_last.n||c.done.length):(+_last||1)):1;
  openModal('本次有刷题吗？',
    `<p style="margin:0 0 14px;color:var(--text-sub);font-size:13px;line-height:1.6;">「${escapeHtml(c.name)}」第 ${bkN} 章刷完了，要不要记录本次刷题成绩？录了会并进「${SECTION_MAP[c.section].name}」的正确率统计，也会记到这本练习册里。</p>
     <div class="dlg-actions"><button class="btn btn-ghost" id="lesSkip">跳过</button><button class="btn" id="lesRecord">录入成绩</button></div>`);
  const box=$('#modalBody'); if(!box)return;
  box.querySelector('#lesSkip').onclick=closeModal;
  box.querySelector('#lesRecord').onclick=function(){closeModal();openReportBySection(c.section,null,true,{id:c.id,n:bkN});};
}
/* 勾选「听一讲」网课待办时，按文本里的「第N讲」把课程进度补齐到第 N 讲。
   幂等：课程页已记过的讲数不重复记、也不回退；避免与 finishLesson 双向同步时重复 +1。返回本次新增的讲数 */
function syncCourseProgressByTodo(td){
  if(!td||td.jumpType!=='course')return 0;
  const txt=td.text||'';
  const m=txt.match(/第\s*(\d+)\s*[讲章]/);
  /* 优先 courseId 精准关联（改名不断链）；无 courseId 的老待办回退文本匹配 */
  let c=td.courseId?(state.courses||[]).find(x=>x.id===td.courseId):null;
  let n=0;
  if(c){
    /* 文本带「第N讲」补到 N；没带则按当前进度 +1（完成一次=多听一讲） */
    n=m?parseInt(m[1],10):nextLessonNum(c);
  }else{
    if(!m)return 0;
    n=parseInt(m[1],10);
    c=(state.courses||[]).find(x=>x.name&&txt.includes(x.name));
  }
  if(!c)return 0;
  if(!n||n<1)return 0;
  /* 总讲数上限：待办文本写的讲数超过总讲数时，只补到总讲数 */
  if(c.total&&n>c.total)n=c.total;
  if(!Array.isArray(c.done))c.done=[];
  let added=0;
  /* 精确标记第 n 讲（支持跳着听：只标这一讲，不强制补 1..n）。已标过则幂等不重复 */
  if(!courseDoneSet(c).has(n)){ c.done.push({n:n,ts:Date.now(),date:todayStr()}); added=1; }
  // 练习册：勾选待办自动听完一讲后，同样让用户选择是否录入本次刷题成绩（与课程页「上完一课」一致）
  if(added>0)promptBrushIfNeeded(c);
  return added;
}
/* 撤销上一讲：移除最近完成的一讲（按时间最新的那讲，而非数组末尾） */
function undoLesson(id){
  const c=findCourse(id); if(!c||!Array.isArray(c.done)||!c.done.length)return;
  let idx=0,max=-1;
  c.done.forEach(function(d,i){ if((d.ts||0)>max){max=d.ts||0;idx=i;} });
  const removed=c.done[idx];
  c.done.splice(idx,1);markEntityDeleted('lesson:'+id,[removed&&removed.n]);c.mts=Date.now();
  save();toast('已撤销「'+c.name+'」第 '+((removed&&removed.n)?removed.n:(c.done.length+1))+(c.type==='brush'?' 章':' 讲'));render();
}
/* 添加 / 编辑课程 */
/* 练习册卡片「+ 加入今日任务」：一点直接加进今日任务，不弹窗、不打字。
   字段与 openTodoEditor 新建保存一致（含 mts 云同步时间戳、courseId 勾选联动），
   勾选后仍会自动补「刷完一章」并可录成绩。 */
function bookletTodoOf(c){
  return (Array.isArray(state.todos)?state.todos:[]).find(function(td){
    return td&&!td.done&&!td.autoTt&&td.courseId===c.id&&td.jumpType==='course';
  });
}
function addBookletTodo(c){
  const tt=+c.total||0, done=(c.done||[]).length;
  if(tt>0&&done>=tt){toast(c.name+' 已全部刷完，不用再加练习待办了');return;}
  if(bookletTodoOf(c)){toast('「'+c.name+'」已在今日任务里，勾完再点可加下一章');return;}
  const n=nextLessonNum(c), now=Date.now();
  if(!Array.isArray(state.todos))state.todos=[];
  state.todos.push({id:uid(),text:c.name+' 第'+n+'章',dueDate:todayStr(),section:c.section||'',sub:'',count:0,
    repeat:{type:'none'},jumpType:'course',courseId:c.id,done:false,ts:now,mts:now});
  save();render();toast('已加入今日任务：'+c.name+' 第'+n+'章');
}
/* 添加 / 编辑课程（prefill 可预填类型等默认值） */

function courseFormModal(id,prefill){
  const c=id?findCourse(id):null;
  const v=c||Object.assign({name:'',teacher:'',section:'',total:''},prefill||{});
  const isBk=v.type==='brush';
  const secOpts=['<option value="">不关联</option>'].concat(SECTIONS.map(function(s){
    return '<option value="'+s.key+'"'+(v.section===s.key?' selected':'')+'>'+escapeHtml(s.name)+'</option>';
  })).join('');
  openModal(c?(isBk?'编辑练习册':'编辑课程'):(isBk?'添加练习册':'添加课程'),
    `<div class="dlg-form">
      <label class="dlg-label">${isBk?'练习册名':'课程名'}</label>
      <input class="dlg-input" id="cfName" value="${escDlg(v.name)}" placeholder="${isBk?'如：言语理解专项练习册':'如：言语系统班'}">
      <label class="dlg-label">${isBk?'备注（选填）':'老师（选填）'}</label>
      <input class="dlg-input" id="cfTeacher" value="${escDlg(v.teacher||'')}" placeholder="${isBk?'如：2026 版':'如：郭熙'}">
      <label class="dlg-label">关联模块（选填，只作标记）</label>
      <select class="dlg-input" id="cfSec">${secOpts}</select>
      <label class="dlg-label">类型</label>
      <select class="dlg-input" id="cfType">
        <option value="listen"${!isBk?' selected':''}>听课</option>
        <option value="brush"${isBk?' selected':''}>练习册</option>
      </select>
      <div class="dlg-row">
        <div class="dlg-col"><label class="dlg-label">${isBk?'总章节数':'总讲数'}</label><input class="dlg-input" id="cfTotal" type="number" inputmode="numeric" min="0" value="${v.total||''}" placeholder="不限"></div>
      </div>
      <div class="dlg-err"></div>
      <div class="dlg-actions"><button class="btn btn-ghost dlg-cancel">取消</button><button class="btn dlg-ok">${c?'保存':'添加'}</button></div>
    </div>`);
  const box=$('#modalBody'); if(!box)return;
  box.querySelector('#cfSec').value=v.section||'';
  box.querySelector('.dlg-cancel').onclick=closeModal;
  box.querySelector('.dlg-ok').onclick=function(){
    const name=(box.querySelector('#cfName').value||'').trim();
    if(!name){const e=box.querySelector('.dlg-err');if(e)e.textContent=(isBk?'练习册名':'课程名')+'不能为空';return;}
    const teacher=(box.querySelector('#cfTeacher').value||'').trim();
    const section=box.querySelector('#cfSec').value||'';
    const type=box.querySelector('#cfType').value==='brush'?'brush':'listen';
    const total=Math.max(0,parseInt(box.querySelector('#cfTotal').value||'0',10)||0);
    if(!Array.isArray(state.courses))state.courses=[];
    if(c){
      c.name=name;c.teacher=teacher;c.section=section;c.type=type;c.total=total;c.mts=Date.now();
      // 总讲数改小：裁掉超范围的听讲记录（否则讲义弹窗只渲 1..total，超范围记录变无法取消的幽灵数据），并写墓碑同步到对端
      if(total>0 && Array.isArray(c.done) && c.done.some(d=>d&&d.n>total)){
        const dropped=c.done.filter(d=>d&&d.n>total).map(d=>d.n);
        c.done=c.done.filter(d=>d&&d.n<=total);
        if(dropped.length)markEntityDeleted('lesson:'+c.id, dropped);
      }
    }
    else state.courses.push({id:uid(),name:name,teacher:teacher,section:section,type:type,total:total,createdAt:Date.now(),mts:Date.now(),done:[]});
    save();closeModal();toast(c?'已保存':(type==='brush'?'已添加练习册':'已添加课程'));render();
  };
}
function deleteCourse(id){
  const c=findCourse(id); if(!c)return;
  const related=(state.todos||[]).filter(td=>td&&td.courseId===id).length;
  const ttRelated=(state.timetable||[]).filter(x=>x&&x.courseId===id).length;
  uiConfirm('删除课程「'+c.name+'」？'+(related?('同时会清理 '+related+' 条关联待办。'):'')+(ttRelated?('课表里 '+ttRelated+' 条安排会保留，但不再自动生成听课待办。'):''),function(){
    state.courses=(state.courses||[]).filter(function(x){return x.id!==id;});markEntityDeleted('course',[id]);
    if(related){dropTodos(td=>td&&td.courseId===id);}
    /* 课表条目保留（名字还在、课节照上），只解除关联，避免课程已删还自动生成假「第N讲」待办 */
    if(ttRelated){state.timetable.forEach(function(x){if(x&&x.courseId===id)delete x.courseId;});}
    save();toast('已删除');render();
  },{danger:true,okText:'删除'});
}
/* 练习册整本成绩汇总：从 dailyStats 全部日期、全部模块里挑出带 bkId 的记录。
   老成绩没 bkId，不计入；正确率按「有正确率的题量」加权，用时取每条 min 之和。 */
function brushStatsOf(bkId){
  const out={count:0,rate:null,minutes:0,times:0,chapters:{}};
  let sw=0,rc=0;
  const ds=state.dailyStats||{};
  Object.keys(ds).forEach(function(d){
    const day=ds[d];if(!day||typeof day!=='object')return;
    Object.keys(day).forEach(function(sec){
      const rec=day[sec];if(!rec||!Array.isArray(rec.records))return;
      rec.records.forEach(function(r){
        if(!r||r.bkId!==bkId)return;
        const c=+(r.count||0)||0, m=+(r.min||0)||0;
        out.count+=c;out.minutes+=m;out.times++;
        if(r.rate!=null){const v=+(r.rate||0)||0;sw+=c*v;rc+=c;}
        const n=(r.bkN==null||!isFinite(+r.bkN))?0:(+r.bkN);
        const ch=out.chapters[n]||(out.chapters[n]={count:0,minutes:0,sw:0,rc:0,rate:null});
        ch.count+=c;ch.minutes+=m;
        if(r.rate!=null){const v=+(r.rate||0)||0;ch.sw+=c*v;ch.rc+=c;}
      });
    });
  });
  out.rate=rc>0?Math.round(sw/rc):null;
  Object.keys(out.chapters).forEach(function(n){const ch=out.chapters[n];ch.rate=ch.rc>0?Math.round(ch.sw/ch.rc):null;});
  return out;
}
/* 点卡片上的汇总行 → 就地展开/收起按章明细（不整页重渲染，避免手机滑动闪烁） */
function toggleBrushDetail(item,c){
  const d=item.querySelector('.bk-detail');if(!d)return;
  if(!d.hidden){d.hidden=true;item.classList.remove('bk-open');return;}
  const st=brushStatsOf(c.id);
  const keys=Object.keys(st.chapters).map(Number).sort(function(a,b){return (a===0?1e9:a)-(b===0?1e9:b);});
  let html='<div class="bk-detail-head">按章明细 · 共 '+st.times+' 笔 / '+keys.length+' 章</div>';
  keys.forEach(function(n){
    const ch=st.chapters[n];
    html+='<div class="bk-ch"><span class="bk-ch-n">'+(n===0?'未指定章':('第 '+n+' 章'))+'</span>'
      +'<span class="bk-ch-v">'+ch.count+' 题 · '+(ch.rate==null?'—':ch.rate+'%')+' · '+ch.minutes+' 分钟</span></div>';
  });
  if(!keys.length)html+='<div class="bk-ch"><span class="bk-ch-v">还没有成绩记录</span></div>';
  d.innerHTML=html;d.hidden=false;item.classList.add('bk-open');
}
function renderCourses(pane){
  if(!pane)pane=el('div','tab-pane');
  pane.appendChild(renderTimetableCard(pane));
  const list=(Array.isArray(state.courses)?state.courses:[]).filter(function(c){return c&&c.id;});
  const card=el('div','card');
  const totalDone=list.reduce(function(a,c){return a+((c.done||[]).length);},0);
  const totalTarget=list.reduce(function(a,c){return a+((c.total||0));},0);
  card.innerHTML=`<div class="section-title"><span class="dot"></span>我的课程${list.length?`<span class="slr-count">${list.length} 门</span>`:''}
      ${hmark('网课按「讲」记进度，练习册按「章」记进度；点「讲义 / 章节」弹出全部格子可跳着标。练习册和课程一样手动添加；加好后卡片上点「+ 加入今日任务」一键排进今天，不用手打名称；刷完一章可选录成绩；整本累计题量、正确率、用时显示在卡片上，点汇总行能看每章明细。只记进度不记时间——真实学习时长用番茄钟更有意义。')}</div>
    <div class="course-tip">${list.length?('已听完 '+totalDone+' 讲'+(totalTarget>0?(' · 目标共 '+totalTarget+' 讲'):'')):''}</div>
    <div class="course-add"><button class="btn" id="courseAddBtn">+ 添加课程</button><button class="btn btn-primary" id="bookletAddBtn">+ 添加练习册</button></div>
    <div id="courseList"></div>`;
  pane.appendChild(card);
  const box=card.querySelector('#courseList');
  card.querySelector('#courseAddBtn').addEventListener('click',function(){courseFormModal(null);});
  card.querySelector('#bookletAddBtn').addEventListener('click',function(){courseFormModal(null,{type:'brush'});});
  if(!list.length){
    const e=el('div','empty-tip');
    e.textContent='还没有课程。点「+ 添加课程」加网课，或点「+ 添加练习册」加一本刷题册。';
    box.appendChild(e);
    return pane;
  }
  /* 排序：正在上的在前，已听满总讲数的沉底（同组内保持添加顺序，稳定排序） */
  const courseIsFull=function(c){const tt=+c.total||0;return tt>0&&(c.done||[]).length>=tt;};
  const sorted=list.slice().sort(function(a,b){return (courseIsFull(a)?1:0)-(courseIsFull(b)?1:0);});
  sorted.forEach(function(c){
    const done=(c.done||[]).length,tt=+c.total||0;
    const pct=tt?Math.min(100,Math.round(done/tt*100)):(done?100:0);
    const full=tt>0&&done>=tt;   // 已听满总讲数
    const sec=c.section?(SECTION_MAP[c.section]||{}):null;
    const item=el('div','course-item'+(full?' course-done':''));
    item.dataset.cid=c.id;
    // 练习册按「章」、网课按「讲」显示；大额按钮按顺序标下一章/讲，小按钮弹全部格子
    const isBk=c.type==='brush', unit=isBk?'章':'讲', doneWord=isBk?'已刷':'已听';
    const addtodoBtn=isBk?'':'<button type="button" class="icon-btn" data-act="addtodo" aria-label="加入待办" title="加入待办">'+icon('plus')+'</button>';
    const hasBkTodo=isBk?!!bookletTodoOf(c):false;
    const bkTodoBtn=isBk?('<div class="course-bk-add"><button type="button" class="btn'+(hasBkTodo?' btn-ghost':'')+'" data-act="addtodo"'+(full?' disabled style="opacity:.5;cursor:default;"':'')+'>'
      +(full?'已刷完，无需加任务':(hasBkTodo?'已在今日任务 ✓':'+ 加入今日任务'))+'</button></div>'):'';
    let bkStatHtml='';
    if(isBk){
      const bkSt=brushStatsOf(c.id);
      if(bkSt.count>0||bkSt.minutes>0){
        bkStatHtml='<div class="bk-stat" data-act="bkstat" role="button" tabindex="0"><span class="bk-stat-main">刷题 <b>'+bkSt.count+'</b> 题 · 正确率 <b>'+(bkSt.rate==null?'—':bkSt.rate+'%')+'</b> · 用时 <b>'+bkSt.minutes+'</b> 分钟</span><span class="bk-stat-arrow">▾</span></div>'
          +'<div class="bk-detail" hidden></div>';
      }else{
        bkStatHtml='<div class="bk-stat bk-stat-empty">还没录成绩 · 刷完一章后点「录入成绩」</div>';
      }
    }
    let btnsHtml;
    if(tt>0){
      btnsHtml='<div class="course-btns">'
        + (full
            ? '<button type="button" class="btn course-next" disabled style="opacity:.5;cursor:default;">'+(isBk?'已刷完 ':'已听完 ')+tt+' '+unit+' ✓</button>'
            : '<button type="button" class="btn course-next" data-act="next">'+(isBk?'刷完下一章 ✓':'听完下一讲 ✓')+'</button>')
        + '<button type="button" class="btn btn-ghost course-lessons" data-act="lessons">'+(isBk?'章节':'讲义')+' '+(c.done?c.done.length:0)+(tt?('/'+tt):'')+'</button>'
        + '</div>';
    } else {
      btnsHtml='<div class="course-btns">'
        + (full
            ? '<button class="btn course-finish" disabled style="opacity:.5;cursor:default;">'+(isBk?'已刷完 ':'已听完 ')+(c.done?c.done.length:0)+' '+unit+' ✓</button>'
            : '<button type="button" class="btn course-finish" data-act="finish">'+(isBk?'刷完一章 ✓':'听完一讲 ✓')+'</button>'
              + ((c.done||[]).length?'<button type="button" class="btn btn-ghost course-undo" data-act="undo">撤销</button>':''))
        + '</div>';
    }
    item.innerHTML=`
      <div class="course-head">
        <div class="course-name">${escapeHtml(c.name)}${full?'<span class="course-finish-tag">'+(isBk?'已刷完':'已结课')+'</span>':''}</div>
        <div class="course-acts">
          ${addtodoBtn}
          <button type="button" class="icon-btn" data-act="edit" aria-label="编辑">${icon('edit')}</button>
          <button type="button" class="icon-btn" data-act="del" aria-label="删除">${icon('trash')}</button>
        </div>
      </div>
      <div class="course-sub">
        ${c.teacher?`<span class="course-teacher">${escapeHtml(c.teacher)}</span>`:''}
        ${sec?`<span class="course-tag" style="background:${sec.color}22;color:${sec.color}">${escapeHtml(sec.name)}</span>`:''}
        ${isBk?`<span class="course-tag" style="background:#6C5CE722;color:#6C5CE7">练习册</span>`:''}
      </div>
      <div class="course-bar"><i style="width:${pct}%"></i></div>
      <div class="course-meta"><span>${doneWord} <b>${done}</b>${tt?(' / '+tt):''} ${unit}${tt?('（'+pct+'%）'):''}</span></div>
      ${bkStatHtml}
      ${btnsHtml}${bkTodoBtn}`;
    item.addEventListener('click',function(e){
      const b=e.target.closest?e.target.closest('[data-act]'):null; if(!b)return;
      const act=b.dataset.act;
      if(act==='next'||act==='finish')finishLesson(c.id);
      else if(act==='lessons')openLessonsModal(c);
      else if(act==='undo')undoLesson(c.id);
      else if(act==='edit')courseFormModal(c.id);
      else if(act==='del')deleteCourse(c.id);
      else if(act==='bkstat'){toggleBrushDetail(item,c);return;}
      else if(act==='addtodo'){
        if(isBk){addBookletTodo(c);return;}
        if(full){toast(c.name+' 已全部听完，不用再加听课待办了');return;}
        const nextLesson=nextLessonNum(c);
        openTodoEditor(null,null,{text:c.name+' 第'+nextLesson+'讲',jumpType:'course',section:c.section||'',courseId:c.id});
      }
    });
    box.appendChild(item);
  });
  return pane;
}

/* ============================================================
   倒计时
   ============================================================ */
let _homeHeaderTimer=null;
function renderHomeBar(){
  if(_homeHeaderTimer){clearInterval(_homeHeaderTimer);_homeHeaderTimer=null;}
  const bar=el('div','home-bar');
  const left=el('div','hb-left');
  const p=state.userProfile||{};
  const pName=p.name||'局长';
  const avatar=el('div','profile-avatar hb-avatar');
  avatar.innerHTML=p.avatar?`<img src="${escapeHtml(p.avatar)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;">`:escapeHtml(pName.charAt(0));
  const idBox=el('div','hb-id');
  const nameEl=el('div','hb-name');nameEl.textContent=pName;
  const greet=el('div','hb-greet');
  const right=el('div','hb-right');
  const date=el('div','hb-date');
  const time=el('div','hb-time');
  function update(){
    const now=new Date();const h=now.getHours();
    let g='夜深了，注意休息';
    if(h>=5&&h<9)g='早上好，新的一天开始了';
    else if(h>=9&&h<12)g='上午好，保持专注';
    else if(h>=12&&h<14)g='中午好，记得午休';
    else if(h>=14&&h<18)g='下午好，继续加油';
    else if(h>=18&&h<23)g='晚上好，辛苦了';
    greet.textContent=g;
    time.textContent=`${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const weeks=['日','一','二','三','四','五','六'];
    date.textContent=`${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 星期${weeks[now.getDay()]}`;
  }
  idBox.appendChild(nameEl);idBox.appendChild(greet);
  left.appendChild(avatar);left.appendChild(idBox);
  right.appendChild(date);right.appendChild(time);
  bar.appendChild(left);bar.appendChild(right);
  update();
  _homeHeaderTimer=setInterval(update,1000);
  return bar;
}
/* 考试倒计时数据：按剩余天数由近到远排序（已过期的排最前，显示 0） */
function examCountdownList(){
  const now=new Date();now.setHours(0,0,0,0);
  const out=[];
  (state.exams||[]).forEach(function(ex){
    const dateStr=state.examDates[ex.key]||ex.date;
    if(!dateStr)return;
    const target=new Date(dateStr+'T00:00:00');
    if(isNaN(target.getTime()))return;
    out.push({key:ex.key,name:ex.name,dateStr:dateStr,days:Math.round((target-now)/86400000)});
  });
  return out.sort(function(a,b){return a.days-b.days;});
}
/* 速览卡底部的倒计时细条：一场考试一个胶囊，点可改日期，末尾 + 添加 */
function renderGlanceCdBar(){
  const strip=el('div','gl-cd-bar');
  const list=examCountdownList();
  list.forEach(function(x,i){
    if(i)strip.appendChild(el('span','gl-cd-sep'));
    const it=el('div','gl-cd-item');
    it.setAttribute('role','button');it.setAttribute('tabindex','0');it.title='点击改日期';
    it.innerHTML=`<span class="gl-cd-name">${annot(x.name)}</span><span class="gl-cd-days">${x.days>0?x.days:0}<i>天</i></span>`;
    it.addEventListener('click',()=>editExamDate(x.key));
    strip.appendChild(it);
  });
  if(!list.length)strip.appendChild(el('span','gl-cd-empty','还没添加考试'));
  const add=el('button','gl-cd-add','+');
  add.id='glCdAddBtn';add.title='添加考试';add.setAttribute('aria-label','添加考试');
  add.addEventListener('click',addExam);
  strip.appendChild(add);
  return strip;
}
/* 今日完成数：今天打勾完成的任务数（含循环任务今日已完成）。
   判断依据：普通任务 done 且 lastDone===今天；循环任务 lastDone===今天。
   用于速览「今日完成」数字，口径=「按打钩的任务量」。 */
function todayCompletedCount(){
  const t=todayStr();
  return (state.todos||[]).filter(td=>{
    if(isRepeat(td))return td.lastDone===t;
    return td.done && td.lastDone===t;
  }).length;
}
/* 今日刷题量：今天所有「按题计」模块（行测+政治理论）的题量总和，
   口径与今日汇总卡一致（整体手填为准）；篇/套/次模块（申论、套卷、晨读）不计入。 */
function todayQuizCount(){
  const ds=state.dailyStats[todayStr()]||{};
  let n=0;
  Object.keys(ds).forEach(k=>{
    if((CHECKIN_UNIT[k]||'题')!=='题')return;
    n+=(ds[k].count||0);
  });
  return n;
}
function renderHomeGlance(){
  const d=todayStr();
  const now=new Date();now.setHours(0,0,0,0);
  let minDays=null,minName='';
  (state.exams||[]).forEach(ex=>{
    const dateStr=state.examDates[ex.key]||ex.date;
    if(!dateStr)return;
    const target=new Date(dateStr+'T00:00:00');
    if(isNaN(target.getTime()))return;
    const days=Math.round((target-now)/86400000);
    if(minDays===null||days<minDays){minDays=days;minName=ex.name;}
  });
  const checkedCount=todayCompletedCount();
  const quizCount=todayQuizCount();
  const g=el('div','home-glance');
  const examNum=minDays===null?'—':(minDays<0?'0':String(minDays));
  const examLabel=minDays===null?'未设考试':'距考试';
  g.innerHTML=`
    <div class="gl-stats">
      <div class="gl-item">
        <span class="gl-num">${examNum}<i>天</i></span>
        <span class="gl-label">${examLabel}</span>
      </div>
      <span class="gl-sep"></span>
      <div class="gl-item">
        <span class="gl-num">${checkedCount}</span>
        <span class="gl-label">今日完成</span>
      </div>
      <span class="gl-sep"></span>
      <div class="gl-item">
        <span class="gl-num">${quizCount}</span>
        <span class="gl-label">今日刷题</span>
      </div>
    </div>`;
  g.appendChild(renderGlanceCdBar());
  return g;
}
/* 今日汇总卡：按打卡分类显示今日各模块学习情况（题量/正确率/网课讲数），未录=「记一笔」、已录=「查看详情」 */
function renderHomeCheckin(){
  const card=el('div','card home-checkin');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>今日汇总</div>`;
  const d=todayStr();
  const cats=activeCheckinCategories();
  /* 今日各模块学习时长（番茄钟 + 录入手填，去重后），用于卡片「时长」行 */
  const durMap=(typeof daySectionMin==='function')?daySectionMin(d):{};
  const grid=el('div','task-grid');
  cats.forEach(k=>{
    const s=SECTION_MAP[k];if(!s)return;
    const stat=(state.dailyStats[d]&&state.dailyStats[d][k])||{count:0,rate:0,subs:{}};
    const unit=(CHECKIN_UNIT&&CHECKIN_UNIT[k])||'题';
    const unitLabel=({题:'题量',篇:'篇数',套:'套数',次:'次数'})[unit]||'题量';
    const needRate=!(CHECKIN_HAS_RATE&&CHECKIN_HAS_RATE[k]===0);
    const dur=Math.round(durMap[k]||0);
    /* 申论：录了 review 也算当天已学（dailyStats 不存申论，走独立 shenlunReviews） */
    const shenlunRecs=(k==='shenlun'&&(state.shenlunReviews||[]).filter(r=>r.date===d))||[];
    const shenlunDone=shenlunRecs.length>0;
    const count=(k==='shenlun'&&shenlunDone&&!(stat.count>0))?shenlunRecs.length:stat.count;
    const done=stat.count>0||shenlunDone;
    /* 网课计入今日汇总：当天该模块所有课程已听讲数合计（按 done 记录逐条统计，一门课多讲也算多讲） */
    const lessonCount=(state.courses||[]).reduce(function(a,c){
      if(c.section!==k)return a;
      return a+(c.done||[]).filter(x=>x.date===d).length;
    },0);
    const active=done||lessonCount>0;
    const item=el('div','task-card'+(active?' done':''));
    item.innerHTML=`
      <div class="tc-head">
        <div class="ci-icon-wrap"><svg class="icon"><use href="#i-${CATEGORY_ICONS[k]}"/></svg></div>
        <div class="tc-name">${s.name}</div>
      </div>
      <div class="tc-stats">
        <div class="tc-stat"><span class="tc-stat-k">${unitLabel}</span><span class="tc-stat-v"><b>${count||0}</b> ${unit}</span></div>
        <div class="tc-stat"><span class="tc-stat-k">${needRate?'正确率':'今日'}</span><span class="tc-stat-v">${needRate?(done?Math.round(stat.rate)+'%':'—'):(done?'已记':'—')}</span></div>
        <div class="tc-stat"><span class="tc-stat-k">时长</span><span class="tc-stat-v">${dur>0?('<b>'+dur+'</b> 分'):'—'}</span></div>
      </div>
      ${lessonCount>0?`<div class="tc-lesson">网课：已听 <b>${lessonCount}</b> 讲</div>`:''}
      <button class="btn ${active?'btn-ghost':'task-done-btn'}" data-task="${k}">${active?'查看详情':'记一笔'}</button>`;
    item.querySelector('[data-task]').addEventListener('click',()=>openReportBySection(k,null,!active));
    grid.appendChild(item);
  });
  if(!cats.length){
    grid.innerHTML='<div class="empty-tip" style="grid-column:1/-1;padding:10px 0;">还没勾选打卡分类，去「我的→打卡分类」挑几个</div>';
  }
  card.appendChild(grid);
  return card;
}
/* 首页复习提醒：今日到期的条目。始终显示（0 条时是「都复习完了」），点进去直接开翻转卡 */
function renderReviewStrip(){
  const due=dueReviewList();
  const card=el('div','card review-strip home-full');
  card.innerHTML=`<div class="rs-left">
      <span class="rs-ico${due.length?' has':''}">${icon('repeat')}</span>
      <div class="rs-txt">
        <div class="rs-t">${due.length?`今日待复习 <b>${due.length}</b> 条`:'今日没有待复习的内容'}</div>
        ${due.length?'':'<div class="rs-s">学过的会按遗忘曲线自动排期，到时这里会提醒你</div>'}
      </div>
    </div>${due.length?`<button class="btn btn-sm rs-btn">去复习</button>`:''}`;
  const btn=card.querySelector('.rs-btn');
  if(btn)btn.addEventListener('click',()=>openStudy(due.slice(),'今日待复习'));
  return card;
}
function renderCountdown(c){
  c.classList.add('home');
  c.appendChild(renderHomeBar());
  // 首页布局：各模块独立卡片，统一间距
  c.appendChild(renderHomeGlance());           // 1. 速览三数字
  c.appendChild(renderReviewStrip());           // 2. 待复习（遗忘曲线，优先提醒）
  c.appendChild(renderTodayTodos(true,{head:true,actions:true})); // 3. 今日任务列表
  c.appendChild(renderHomeCheckin());           // 4. 打卡/记一笔（折叠）
  // 5. 下一步建议（含申论）。考试倒计时已并入速览卡底部的细条，不再单占一张卡
  const nextSteps=renderNextSteps();
  nextSteps.classList.add('home-full');
  c.appendChild(nextSteps);
}
function editExamDate(key){
  const ex=(state.exams||[]).find(e=>e.key===key)||{name:key,key};
  openModal(`编辑${ex.name}日期`,`
    <div class="row"><label class="grow">考试日期</label></div>
    <input type="date" class="field" id="examDateInput" value="${state.examDates[key]||''}">
    <div class="row" style="justify-content:space-between;align-items:center;margin-top:14px;">
      <button class="btn btn-danger btn-sm" id="delExamBtn">删除</button>
      <div class="row" style="margin-bottom:0;align-items:center;">
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">取消</button>
        <button class="btn btn-sm" id="saveExamBtn">保存</button>
      </div>
    </div>`);
  $('#saveExamBtn').addEventListener('click',()=>{
    const v=$('#examDateInput').value;if(v){state.examDates[key]=v;if(!state.examDatesMts||typeof state.examDatesMts!=='object')state.examDatesMts={};state.examDatesMts[key]=Date.now();const def=(state.exams||[]).find(e=>e.key===key);if(def){def.date=v;def.mts=Date.now();}save();closeModal();render();}
  });
  const del=$('#delExamBtn');
  if(del)del.addEventListener('click',()=>{state.exams=(state.exams||[]).filter(e=>e.key!==key);markEntityDeleted('exam',[key]);delete state.examDates[key];if(!state.examDatesMts||typeof state.examDatesMts!=='object')state.examDatesMts={};state.examDatesMts[key]=Date.now();save();closeModal();render();});
}
function addExam(){
  openModal('添加考试',`
    <div class="row"><label class="grow">考试名称</label></div>
    <input type="text" class="field" id="newExamName" placeholder="如：泉州市事业编">
    <div class="row" style="margin-top:10px;"><label class="grow">考试日期</label></div>
    <input type="date" class="field" id="newExamDate">
    <div class="row" style="justify-content:flex-end;margin-top:14px;">
      <button class="btn btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn" id="addExamBtn">添加</button>
    </div>`);
  $('#addExamBtn').addEventListener('click',()=>{
    const name=$('#newExamName').value.trim();const date=$('#newExamDate').value;
    if(!name||!date)return;
    const key='exam_'+uid();
    state.exams=state.exams||[];
    state.exams.push({key:key,name:name,date:date,mts:Date.now()});
    state.examDates[key]=date;if(!state.examDatesMts||typeof state.examDatesMts!=='object')state.examDatesMts={};state.examDatesMts[key]=Date.now();save();closeModal();render();
  });
}


/* ---------- 番茄钟（常驻浮窗，从任务内启动） ---------- */
let _pomoUpdate=null;
let pomoHidden=false;        // 浮窗是否被收起（完成事件/隐藏），不持久化
let pomoFullscreenOpen=false;
function pomoTodaysStat(){
  const d=todayStr();const rec=state.studyRecords[d];const arr=rec?(rec.sessions||[]):[];
  const min=arr.reduce((s,x)=>s+(x.duration||0),0);
  return {n:arr.length,min};
}
function pomoLabel(){
  const total=pomo.duration*60;
  const isFocus=pomo.kind==='focus';
  const _secName=(pomo.section&&SECTION_MAP[pomo.section])?SECTION_MAP[pomo.section].name:(pomo.section?pomo.section:'专注');
  const kindName = pomo.kind==='review' ? '错题复盘' : (pomo.kind==='break' ? '休息' : _secName);
  if(pomo.done)return {label:'完成 ✓',text:'00:00'};
  if(pomo.overtime){
    if(isFocus){const over=Math.max(0,Math.floor((pomo.remaining-total)/60));return {label:'已超目标 '+over+' 分',text:fmtClock(pomo.remaining)};}
    if(pomo.kind==='review')return {label:'已计时 '+Math.floor(pomo.remaining/60)+' 分',text:fmtClock(pomo.remaining)};
    const o=Math.ceil(-pomo.remaining/60);return {label:'已超时 '+o+' 分钟',text:'+'+fmtClock(-pomo.remaining)};
  }
  if(pomo.running)return {label:kindName+(pomo.kind==='review'?' · 计时中':' · 专注中'),text:fmtClock(pomo.remaining)};
  if(isFocus)return {label:'已暂停 · 已专注 '+Math.floor(pomo.remaining/60)+' 分',text:fmtClock(pomo.remaining)};
  if(pomo.remaining<total)return {label:'已暂停',text:fmtClock(pomo.remaining)};
  return {label:kindName,text:fmtClock(pomo.remaining)};
}
function showPomoFloat(){pomoHidden=false;if(_pomoUpdate)_pomoUpdate();}
function hidePomoFloat(){pomoHidden=true;const f=document.getElementById('pomoFloat');if(f)f.style.display='none';}
let _pfsStructureKey=null;
function openPomoFullscreen(){
  pomoFullscreenOpen=true;
  let fs=document.getElementById('pomoFullscreen');
  if(!fs){fs=document.createElement('div');fs.id='pomoFullscreen';fs.className='pomo-fullscreen';document.body.appendChild(fs);}
  renderPomoFullscreen();fs.style.display='flex';
}
function closePomoFullscreen(){pomoFullscreenOpen=false;_pfsStructureKey=null;const fs=document.getElementById('pomoFullscreen');if(fs)fs.style.display='none';}
/* 全屏界面的「结构键」：这些状态会改变按钮组合/时长输入框/整体布局，变了才整屏重建；
   每秒跳动的时间数字、进度环不在这里，走 updatePomoFullscreenDynamic 局部刷新 */
function pomoFullscreenStructureKey(){
  const total=pomo.duration*60;
  const idle=!pomo.done&&!pomo.running&&pomo.remaining>=total;
  return [pomo.kind,pomo.done?'1':'0',pomo.overtime?'1':'0',pomo.running?'1':'0',idle?'1':'0',pomo.duration].join('|');
}
function pomoRingFrac(){
  const total=pomo.duration*60;
  return pomo.kind==='review'?((pomo.remaining%60)/60):(pomo.kind==='focus'?(total?Math.min(pomo.remaining/total,1):(pomo.remaining%60)/60):(total?Math.max(0,1-Math.max(0,pomo.remaining)/total):0));
}
function pomoRingColor(){
  const _secEl=pomo.section&&SECTION_MAP[pomo.section]?SECTION_MAP[pomo.section]:{name:(pomo.section||'专注'),color:'#9eacf0'};
  return pomo.done?'var(--pomo-done)':(pomo.kind==='review'?'#e8a33d':(pomo.kind==='break'?'#2ecc71':(pomo.kind==='focus'?(pomo.overtime?'#e74c3c':_secEl.color):_secEl.color)));
}
function pomoProgText(frac){
  const total=pomo.duration*60;
  if(pomo.done)return '';
  if(pomo.kind==='review')return '已计时 '+Math.floor(pomo.remaining/60)+' 分钟';
  if(pomo.kind==='break')return '休息中 · 站起来活动一下';
  if(pomo.kind==='focus')return (total>0&&pomo.remaining>=total)?('已超目标 '+Math.floor((pomo.remaining-total)/60)+' 分'):('已专注 '+Math.floor(pomo.remaining/60)+' 分');
  return '已专注 '+Math.round(frac*100)+'%';
}
function renderPomoFullscreen(){
  const fs=document.getElementById('pomoFullscreen');if(!fs)return;
  const total=pomo.duration*60;
  const isFocus=pomo.kind==='focus';
  const {label,text}=pomoLabel();
  const frac=pomoRingFrac();
  const col=pomoRingColor();
  const _secEl=pomo.section&&SECTION_MAP[pomo.section]?SECTION_MAP[pomo.section]:{name:(pomo.section||'专注'),color:'#9eacf0'};
  const st=pomoTodaysStat();
  const idle=!pomo.done&&!pomo.running&&pomo.remaining>=total;
  const cap=pomo.kind==='review'?'错题复盘 · '+_secEl.name:(pomo.kind==='break'?'休息一下':'专注 · '+_secEl.name+(pomo.sub?(' · '+subName(pomo.sub)):''));
  const progText=pomoProgText(frac);
  const timeChips=[25,45,60].map(m=>`<button class="pfs-time-chip${pomo.duration===m?' active':''}" data-min="${m}">${m}′</button>`).join('');
  fs.innerHTML=`
    <div class="pomo-fullscreen-inner">
    <div class="pfs-caption">${cap}</div>
    <div class="pfs-ring pomo-timer${pomo.overtime?' pomo-overtime':''}" id="pfsTimer" style="background:conic-gradient(${col} ${frac*360}deg, #ede9f0 ${frac*360}deg);">
      <div class="pfs-inner"><div class="pfs-text">${text}</div><div class="pfs-label">${label}</div><div class="pfs-prog">${progText}</div></div>
    </div>
    <div class="pfs-sub" id="pfsSubStat">今日 ${st.n} 个番茄 · ${st.min} 分钟</div>
    ${pomo.kind==='break'
      ? `<button class="btn btn-ghost" id="pfsSkipBreakBtn" style="padding:8px 16px;">跳过休息，开始专注</button>`
      : (idle?(isFocus?`<div class="pfs-sub">目标 ${total>0?pomo.duration+' 分':'按历史均值自动'} · 正计时，开始即埋头做</div>`:`<div class="pfs-times"><span class="pfs-note">专注时长</span>${timeChips}<span class="pfs-custom"><input type="number" class="field" id="pfsCustomMin" min="1" max="120" value="${pomo.duration}" style="max-width:64px;"><span class="pfs-note">分</span></span></div>`):'')}
    <div class="pfs-actions">
      <button class="btn" id="pfsToggleBtn">${pomo.done?'再来一个':(pomo.overtime?'重置':(pomo.running?'暂停':'开始'))}</button>
      ${pomo.done&&pomo.kind!=='break'?`<button class="btn" id="pfsBreakBtn">休息一下</button>`:''}
      <button class="btn btn-ghost" id="pfsStopBtn">完成</button>
      ${pomo.kind==='break'?'':`<button class="btn btn-ghost" id="pfsResetBtn">重置</button>`}
      <button class="btn btn-ghost" id="pfsCloseBtn">退出全屏</button>
    </div>`;
  fs.querySelector('#pfsToggleBtn').addEventListener('click',()=>{const b=document.getElementById('pomoStartBtn');if(b)b.click();});
  fs.querySelector('#pfsStopBtn').addEventListener('click',()=>{const b=document.getElementById('pomoStopBtn');if(b)b.click();});
  fs.querySelector('#pfsCloseBtn').addEventListener('click',closePomoFullscreen);
  const pfsTimerEl=fs.querySelector('#pfsTimer');
  if(pfsTimerEl){pfsTimerEl.style.cursor='pointer';pfsTimerEl.addEventListener('click',()=>{const b=fs.querySelector('#pfsToggleBtn');if(b)b.click();});}
  const breakBtn=fs.querySelector('#pfsBreakBtn');
  if(breakBtn)breakBtn.addEventListener('click',startPomoBreak);
  const skipBtn=fs.querySelector('#pfsSkipBreakBtn');
  if(skipBtn)skipBtn.addEventListener('click',()=>{
    stopPomoTimer();pomoFocusReset();
    save();_pomoUpdate&&_pomoUpdate();
  });
  const resetBtn=fs.querySelector('#pfsResetBtn');
  if(resetBtn)resetBtn.addEventListener('click',()=>{
    stopPomoTimer();pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomo.startTs=null;
    if(pomo.kind==='review')pomo.remaining=0;else if(pomo.kind==='focus')pomo.remaining=0;else pomo.remaining=pomo.duration*60;
    pomo.running=false;
    save();_pomoUpdate&&_pomoUpdate();
  });
  const custom=fs.querySelector('#pfsCustomMin');
  if(custom)custom.addEventListener('change',()=>{
    const m=Math.max(1,Math.min(120,parseInt(custom.value,10)||pomo.duration));
    custom.value=m;setPomoDuration(m);
  });
  fs.querySelectorAll('.pfs-time-chip').forEach(chip=>{
    chip.addEventListener('click',()=>setPomoDuration(parseInt(chip.dataset.min,10)));
  });
  _pfsStructureKey=pomoFullscreenStructureKey();
}
/* 每秒 tick 走这里：结构键没变就只改时间数字/进度环文案（不重建 DOM、不重绑监听器）；
   状态切换（开始/暂停/完成/超时/进入休息/改时长）让结构键变化时，自动退回整屏重建 */
function updatePomoFullscreenDynamic(){
  if(!pomoFullscreenOpen)return;
  const fs=document.getElementById('pomoFullscreen');if(!fs)return;
  if(_pfsStructureKey!==pomoFullscreenStructureKey()){renderPomoFullscreen();return;}
  const frac=pomoRingFrac();
  const col=pomoRingColor();
  const {label,text}=pomoLabel();
  const ring=fs.querySelector('#pfsTimer');
  if(ring)ring.style.background=`conic-gradient(${col} ${frac*360}deg, #ede9f0 ${frac*360}deg)`;
  const t=fs.querySelector('.pfs-text');if(t)t.textContent=text;
  const l=fs.querySelector('.pfs-label');if(l)l.textContent=label;
  const p=fs.querySelector('.pfs-prog');if(p)p.textContent=pomoProgText(frac);
  const st=pomoTodaysStat();
  const s=fs.querySelector('#pfsSubStat');
  if(s)s.textContent=`今日 ${st.n} 个番茄 · ${st.min} 分钟`;
}
/* 设置专注时长（空闲时可直接改，进行中/休息时切回专注并重置计时） */
/* 把番茄钟复位成「专注正计时待机」：目标取自当前模块，remaining=0 */
function pomoFocusReset(){
  pomo.kind='focus';
  pomo.taskId='';
  pomo.duration=resolveDurTarget(pomo.section,pomo.sub)||25;
  pomo.remaining=0;pomo.overtime=false;pomo.done=false;pomo.endAt=null;pomo.startTs=Date.now();pomo.running=false;
}
function setPomoDuration(min){
  if(pomo.kind==='review')return; // 复盘正计时，时长不设
  min=Math.max(1,Math.min(120,min||25));
  stopPomoTimer();
  const wasBreak=pomo.kind==='break';
  pomo.duration=min;
  if(pomo.kind==='focus'){pomo.remaining=0;pomo.startTs=Date.now();}
  else pomo.remaining=min*60;
  pomo.custom=false;pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomo.running=false;
  if(wasBreak)pomo.kind='focus';
  save();_pomoUpdate&&_pomoUpdate();
  toast('专注目标已设为 '+min+' 分钟');
}
function initPomoFloat(){
  const floatEl=document.getElementById('pomoFloat');
  if(!floatEl)return;
  floatEl.innerHTML=`
    <div class="pomo-float-ring pomo-timer" id="pomoTimer">
      <div class="pomo-timer-inner" id="pomoInner"></div>
    </div>
    <div class="pomo-float-mid">
      <div class="pomo-float-label" id="pomoFloatLabel"></div>
      <div class="pomo-float-sub" id="pomoFloatSub"></div>
    </div>
    <button class="pomo-float-btn" id="pomoStartBtn">暂停</button>
    <button class="pomo-float-btn ghost" id="pomoStopBtn">完成</button>
    <div class="pomo-float-tools">
      <button class="pomo-float-btn icon" id="pomoExpandBtn" aria-label="全屏展开" title="全屏展开">⤢</button>
      <button class="pomo-float-btn close" id="pomoCloseBtn" aria-label="收起" title="收起"><svg class="icon" style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg></button>
    </div>`;
  // 收起后的右下角小圆钮（动态创建，挂到 body）
  let fab=document.getElementById('pomoFab');
  if(!fab){fab=document.createElement('button');fab.id='pomoFab';fab.className='pomo-fab';fab.setAttribute('aria-label','恢复番茄钟');document.body.appendChild(fab);}
  const inner=document.getElementById('pomoInner');
  const ring=document.getElementById('pomoTimer');
  function todaysStat(){
    const d=todayStr();const rec=state.studyRecords[d];const arr=rec?(rec.sessions||[]):[];
    const min=arr.reduce((s,x)=>s+(x.duration||0),0);
    return {n:arr.length,min};
  }
  function update(){
    const total=pomo.duration*60;
    const isReview=pomo.kind==='review';
    const isFocus=pomo.kind==='focus';
    const frac=isReview?((pomo.remaining%60)/60):(isFocus?(total?Math.min(pomo.remaining/total,1):(pomo.remaining%60)/60):(total?Math.max(0,1-Math.max(0,pomo.remaining)/total):0));
    const {label,text}=pomoLabel();
    inner.innerHTML=`<div class="pomo-timer-text" id="pomoText">${text}</div><div class="pomo-timer-label">${label}</div>${pomo.done?'':`<div class="pomo-progress">${isReview?('已计时 '+Math.floor(pomo.remaining/60)+' 分钟'):(pomo.kind==='break'?'休息中':(isFocus?('已专注 '+Math.floor(pomo.remaining/60)+' 分'):('已专注 '+Math.round(frac*100)+'%')))}</div>`}`;
    ring.className='pomo-timer pomo-float-ring'+(pomo.done?' done':(pomo.running?'':' paused'));
    ring.classList.toggle('pomo-overtime',!!pomo.overtime&&!pomo.done);
    updatePomoRing(ring);
    const lbl=document.getElementById('pomoFloatLabel');
    if(lbl)lbl.textContent=label;
    const st=todaysStat();
    const sub=document.getElementById('pomoFloatSub');
    if(sub)sub.textContent=`今日 ${st.n} 个番茄 · ${st.min} 分钟`;
    // 只有「真的启动过」才显示浮窗：正在跑 / 已完成 / 超时 / 有截止点(endAt，倒计时) / 有起点且已有进度(startTs，正计时)。
    // 单纯待机（remaining 被默认值模板填成 25*60，但没 startTs 也没 endAt）不算数，否则一进页面就挂个番茄钟。
    const active=pomo.running||pomo.done||pomo.overtime||!!pomo.endAt||(!!pomo.startTs&&pomo.remaining>0);
    floatEl.style.display=(!pomoHidden&&active)?'flex':'none';
    fab.style.display=(pomoHidden&&active)?'flex':'none';
    fab.innerHTML=`<svg class="icon" style="width:20px;height:20px;"><use href="#i-clock"/></svg><span>${pomo.done?'✓':fmtClock(Math.max(0,pomo.remaining))}</span>`;
    const sb=document.getElementById('pomoStartBtn');
    if(sb)sb.textContent=pomo.done?'再来一个':(pomo.overtime?'重置':(pomo.running?'暂停':(pomo.remaining>0?'继续':'开始')));
    if(pomoFullscreenOpen)updatePomoFullscreenDynamic();
  }
  _pomoUpdate=update;
  document.getElementById('pomoStartBtn').addEventListener('click',()=>{
    if(pomo.done||pomo.overtime){
      const wasBreak=pomo.done&&pomo.kind==='break';
      pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomo.startTs=null;
      if(wasBreak){pomoFocusReset();}
      else if(pomo.kind==='review'){pomo.remaining=0;pomo.startTs=Date.now();}
      else{pomo.remaining=0;pomo.startTs=Date.now();}
    }
    togglePomo();
  });
  document.getElementById('pomoStopBtn').addEventListener('click',()=>{
    const total=pomo.duration*60;
    const isReview=pomo.kind==='review';
    const actualSec=pomo.remaining;
    const actualMin=Math.round(actualSec/30)/2;
    if(pomo.kind==='break'){
      // 休息结束：不记录时长，回到专注待机
      stopPomoTimer();pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomoFocusReset();
      hidePomoFloat();closePomoFullscreen();toast('休息结束，准备好就开始下一个番茄');save();
    }else if(actualMin>0){
      recordPomoSession(actualMin);
      /* 记笔记待办的番茄钟：不产生题量，专注完成即视为任务完成（重复任务走 lastDone 推进） */
      let _noteDoneTxt='';
      if(pomo.taskId){
        const _nt=(state.todos||[]).find(x=>x.id===pomo.taskId);
        if(_nt&&!_nt.done&&_nt.jumpType==='note'){
          const _r=completeTodoOnce(_nt,{date:todayStr()});
          if(_r.completed)_noteDoneTxt=' ·「'+(_nt.text.length>12?_nt.text.slice(0,12)+'…':_nt.text)+'」已打勾';
        }
      }
      toast(`已记录 ${actualMin} 分钟${pomo.kind==='review'?'复盘':'专注'}`+_noteDoneTxt);
      if(pomo.kind!=='review'&&pomo.section)promptPomoRecord(actualMin);
      stopPomoTimer();pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomo.remaining=0;pomo.startTs=Date.now();
      hidePomoFloat();closePomoFullscreen();
      save(); // 把 remaining=0 写盘，否则刷新后浮窗会再冒出来
    }else{
      stopPomoTimer();pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomo.remaining=0;pomo.startTs=Date.now();
      hidePomoFloat();closePomoFullscreen();
      save(); // 把 remaining=0 写盘，否则刷新后浮窗会再冒出来
    }
  });
  document.getElementById('pomoExpandBtn').addEventListener('click',openPomoFullscreen);
  document.getElementById('pomoTimer').addEventListener('click',openPomoFullscreen);
  document.getElementById('pomoCloseBtn').addEventListener('click',()=>{pomoHidden=true;update();});
  fab.addEventListener('click',()=>{pomoHidden=false;showPomoFloat();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&pomoFullscreenOpen)closePomoFullscreen();});
  enablePomoDrag();
  update();
  if(pomo.running)startPomoTimer();
}
function enablePomoDrag(){
  const floatEl=document.getElementById('pomoFloat');
  const fab=document.getElementById('pomoFab');
  [{el:fab,whole:true},{el:floatEl,whole:false}].forEach(function(o){
    const el=o.el;if(!el)return;
    let sx=0,sy=0,ox=0,oy=0,moved=false,pid=null;
    el.addEventListener('pointerdown',function(e){
      if(!o.whole&&e.target.closest('button'))return; // 悬浮窗按钮不触发拖动
      if(e.pointerType==='mouse'&&e.button!==0)return;
      sx=e.clientX;sy=e.clientY;
      const r=el.getBoundingClientRect();
      ox=e.clientX-r.left;oy=e.clientY-r.top;
      moved=false;pid=e.pointerId;
      try{el.setPointerCapture(pid);}catch(_){}
      el.classList.add('pomo-dragging');
    });
    el.addEventListener('pointermove',function(e){
      if(e.pointerId!==pid)return;
      if(!moved&&Math.hypot(e.clientX-sx,e.clientY-sy)<6)return;
      moved=true;
      let nx=e.clientX-ox,ny=e.clientY-oy;
      nx=Math.max(4,Math.min(window.innerWidth-el.offsetWidth-4,nx));
      ny=Math.max(4,Math.min(window.innerHeight-el.offsetHeight-4,ny));
      el.style.left=nx+'px';el.style.top=ny+'px';
      el.style.right='auto';el.style.bottom='auto';
    });
    function end(e){
      if(e.pointerId!==pid)return;
      pid=null;
      try{el.releasePointerCapture(e.pointerId);}catch(_){}
      el.classList.remove('pomo-dragging');
      if(moved){el._supClick=true;setTimeout(function(){el._supClick=false;},120);moved=false;}
    }
    el.addEventListener('pointerup',end);
    el.addEventListener('pointercancel',end);
    el.addEventListener('click',function(e){if(el._supClick){e.preventDefault();e.stopPropagation();}},true);
  });
}
function fmtClock(sec){const m=Math.floor(sec/60),s=sec%60;return `${pad(m)}:${pad(s)}`;}
/* 某模块是否「计题量」（参与速度/超时/题量框联动）：
   申论(篇)、晨读(次) 不计题量 → 不套番茄钟目标时长、待办不显「题量」框；
   套卷(套)也按题量分摊、行测各模块(题)同理，均计题量 */
function secCountsAsCount(sec){return sec!=='shenlun' && sec!=='chendu';}
/* 是否「限时/有目标时长」模块：只有晨读(chendu)是纯朗读背诵打卡、无考试时间概念 → 番茄钟纯正计时、无目标、不超时(duration=0)；
   其余(行测6 + 套卷 + 申论)都有考试时间，番茄钟套目标时长、可标超时。
   注意：申论虽不计题量(单位篇)，但考试限时，必须和晨读区分开，不能因「不计题量」就一并判成无限时。 */
function secHasTimeLimit(sec){return sec!=='chendu';}
/* 解析某实体（大类 section + 可选子模块 sub）的时长目标（分钟）。
   优先级：子模块目标 → 大类目标 → null（表示按历史均值自动，不预设）。
   key 命名：大类用 SECTION_MAP 键（yanyu…），子模块用 EXAM_TYPES 子键（言语_逻辑填空…），
   统一存进 state.durTargets，与正确率目标 state.weakTargets 互不影响。 */
function resolveDurTarget(section,sub){
  const dt=(state&&state.durTargets)||{};
  if(sub&&dt[sub]!=null)return dt[sub];
  if(section&&dt[section]!=null)return dt[section];
  return null;
}
/* 解析某实体（大类 section + 可选子模块 sub）的目标题量（题）。key 规则同 resolveDurTarget。 */
function resolveCountTarget(section,sub){
  const ct=(state&&state.countTargets)||{};
  if(sub&&ct[sub]!=null)return ct[sub];
  if(section&&ct[section]!=null)return ct[section];
  return null;
}
/* 标准节奏（分钟/题）= 目标时长 ÷ 目标题量；缺任一或题量为 0 返回 null（番茄钟退化为固定时长）。 */
function resolveStandardSpeed(section,sub){
  const d=resolveDurTarget(section,sub);
  const c=resolveCountTarget(section,sub);
  if(d&&c>0)return d/c;
  return null;
}
/* 手填录入的「计划时长」：用于比对实际录入时长算超时（与番茄钟 startPomoForTask 同一套目标口径）。
   优先级：题量×标准速度(分钟/题) → 我的目标设的时长(durTargets)；
   晨读(secHasTimeLimit=false 无限时) 或两者都无 → 0（无目标可比，不标超时）。
   注意：返回 0 一律表示「无目标」，调用方不应据此算超时。 */
function plannedDurFor(sec,sub,count){
  if(!secHasTimeLimit(sec))return 0;
  const sp=resolveStandardSpeed(sec,sub);
  if(count>0&&sp>0)return Math.max(1,Math.round(count*sp));
  const dt=resolveDurTarget(sec,sub);
  if(dt&&dt>0)return dt;
  return 0;
}
/* 子模块 key（EXAM_TYPES 子键，如 言语_逻辑填空）→ 显示名 */
/* 某大类下可选的子模块：行测取 EXAM_TYPES 子键，申论取小题/大作文，其余没有（下拉框隐藏） */
function subsOfSection(sec){
  if(sec==='shenlun')return SHENLUN_SUB_OPTIONS;
  const et=SECTION_ET[sec];
  return (et&&et.subs)||[];
}
/* 录入弹窗用的「拆分子模块」列表：返回 [{key,name}]。
   优先 SUBTOPICS（行测大类子模块在这里，中文名即 key，保持原存储口径不变）；
   只有 SUBTOPICS 没有、但 EXAM_TYPES.subs 有的模块（目前仅政治常识）才走 EXAM_TYPES.subs，
   其 key 带前缀（政治常识_政治理论），与历史数据/薄弱分析口径一致。 */
function splitSubEntries(sec){
  if(typeof SUBTOPICS!=='undefined'&&SUBTOPICS[sec]&&SUBTOPICS[sec].length)return SUBTOPICS[sec].map(n=>({key:n,name:n}));
  const et=SECTION_ET[sec];
  if(et&&et.subs&&et.subs.length)return et.subs.map(s=>({key:s.key,name:s.name}));
  return [];
}
/* 子模块 key → 显示名：先查申论（不在 EXAM_TYPES 里），再查 EXAM_TYPES 子键 */
function subName(key){
  if(!key)return '';
  const sl=SHENLUN_SUB_OPTIONS.find(x=>x.key===key); if(sl)return sl.name;
  let n='';EXAM_TYPES.forEach(t=>(t.subs||[]).forEach(s=>{if(s.key===key)n=s.name;}));
  if(n)return n;
  // 行测子模块（SUBTOPICS 里存的就是中文题型名，如「逻辑填空」「图形推理」）：
  // 旧逻辑漏查这里，导致速度卡标题全部退化成「言语理解(子模块)」同名行
  if(typeof SUBTOPICS!=='undefined'){
    for(const sec in SUBTOPICS){if((SUBTOPICS[sec]||[]).indexOf(key)>=0)return key;}
  }
  return '';
}
function updatePomoRing(node){
  const total=pomo.duration*60;
  const isReview=pomo.kind==='review';
  const isFocus=pomo.kind==='focus';
  const _ringCol=(pomo.section&&SECTION_MAP[pomo.section])?SECTION_MAP[pomo.section].color:'#9eacf0';
  let deg,col;
  if(isReview){deg=(pomo.remaining%60)/60*360; col='#e8a33d';}
  else if(isFocus){
    // 正计时：环随已用时填充，目标线 = total；过线变红
    deg= total>0 ? Math.min(pomo.remaining/total,1)*360 : (pomo.remaining%60)/60*360;
    col= pomo.overtime?'#e74c3c':_ringCol;
  }else{ // break 倒计时
    deg= total?(1-Math.max(0,pomo.remaining)/total)*360:0;
    col= pomo.kind==='break'?'#2ecc71':_ringCol;
  }
  if(pomo.done)col='var(--pomo-done)';
  node.style.background=`conic-gradient(${col} ${deg}deg, #ede9f0 ${deg}deg)`;
}
function togglePomo(){
  const isCount=(pomo.kind==='focus'||pomo.kind==='review'); // 正计时用 startTs，倒计时用 endAt
  if(pomo.running){
    // 暂停：把已用时冻结成 startTs，并立刻落盘（否则刷新后 startTs 还是暂停前的旧值，
    // 再点继续会把暂停期间的真实时间一次性算进来）
    if(isCount)pomo.startTs=Date.now()-pomo.remaining*1000;
    stopPomoTimer();pomo.running=false;
    pomoVibrate(20);
    try{persistPomo();}catch(e){}
    _pomoUpdate&&_pomoUpdate();
  }else{
    // 继续：无论 startTs 是不是旧的，都以「当前剩余」重新锚定起点
    if(isCount)pomo.startTs=Date.now()-Math.max(0,pomo.remaining)*1000;
    else pomo.endAt=Date.now()+Math.max(0,pomo.remaining)*1000;
    pomo.running=true;startPomoTimer();
    pomoVibrate(35);
    try{persistPomo();}catch(e){}
    _pomoUpdate&&_pomoUpdate();
  }
}
/* 时间戳计时：remaining 由 wall-clock 推算，切到别的软件/后台标签页也不漂移；
   endAt 持久化后刷新页面能续跑。setInterval 仅负责刷新 UI，不参与计数。 */
function startPomoTimer(){
  stopPomoTimer();
  if(pomo.kind==='review'){
    // 复盘正计时：remaining 累加已用时，startTs 为起点时间戳，无截止
    if(!pomo.startTs)pomo.startTs=Date.now()-pomo.remaining*1000;
    pomo.timer=setInterval(function(){
      if(!pomo.running){stopPomoTimer();return;} // 看门狗：已暂停就自停，绝不继续累加
      pomo.remaining=Math.round((Date.now()-pomo.startTs)/1000);
      const txt=$('#pomoText');const ring=$('#pomoTimer');
      if(txt)txt.textContent=fmtClock(pomo.remaining);
      if(ring)updatePomoRing(ring);
      const prog=ring&&ring.querySelector('.pomo-progress');
      if(prog)prog.textContent='已计时 '+Math.floor(pomo.remaining/60)+' 分钟';
      _pomoUpdate&&_pomoUpdate();
    },500);
  }else if(pomo.kind==='focus'){
    // 专注正计时：remaining=已用时(秒)，由 startTs 累加；目标线=pomo.duration(分)，过线标红
    if(!pomo.startTs){pomo.startTs=Date.now()-pomo.remaining*1000;}
    const tgt=pomo.duration*60;
    pomo.timer=setInterval(function(){
      if(!pomo.running){stopPomoTimer();return;} // 看门狗：已暂停就自停，绝不继续累加
      pomo.remaining=Math.round((Date.now()-pomo.startTs)/1000);
      const txt=$('#pomoText');const ring=$('#pomoTimer');
      if(txt)txt.textContent=fmtClock(pomo.remaining);
      if(ring)updatePomoRing(ring);
      const prog=ring&&ring.querySelector('.pomo-progress');
      if(prog){
        const el=Math.floor(pomo.remaining/60);
        prog.textContent= tgt>0 ? (pomo.remaining>=tgt?('已超目标 '+(el-pomo.duration)+' 分'):('已专注 '+el+' 分')) : ('已专注 '+el+' 分');
      }
      if(tgt>0 && pomo.remaining>=tgt && !pomo.overtime){
        pomo.overtime=true;try{pomoChime();}catch(e){}pomoVibrate([40,30,40]);
        toast('已超过目标 '+pomo.duration+' 分钟，可继续或点完成记录');
      }
      _pomoUpdate&&_pomoUpdate();
    },500);
  }else{
    // 休息倒计时：remaining 由 endAt 反推，过时不漂移
    if(!pomo.endAt)pomo.endAt=Date.now()+Math.max(0,pomo.remaining)*1000;
    pomo.timer=setInterval(function(){
      if(!pomo.running){stopPomoTimer();return;} // 看门狗
      pomo.remaining=Math.round((pomo.endAt-Date.now())/1000);
      const txt=$('#pomoText');const ring=$('#pomoTimer');
      if(txt)txt.textContent=fmtClock(pomo.remaining);
      if(ring)updatePomoRing(ring);
      const total=pomo.duration*60;
      const prog=ring&&ring.querySelector('.pomo-progress');
      if(prog&&total)prog.textContent='已专注 '+Math.round((1-Math.max(0,pomo.remaining)/total)*100)+'%';
      if(pomo.remaining<=0&&!pomo.overtime){
        if(pomo.kind==='break'){
          // 休息结束：停在 00:00，进入完成态，不超时不计时
          stopPomoTimer();pomo.remaining=0;pomo.done=true;pomo.running=false;
          try{pomoChime();}catch(e){}
          toast('休息结束，开始下一个番茄吧');
          save();_pomoUpdate&&_pomoUpdate();return;
        }
        pomo.overtime=true;try{pomoChime();}catch(e){}pomoVibrate([40,30,40]);toast('时间到，完成后点"完成"记录实际用时');
      }
      _pomoUpdate&&_pomoUpdate();
    },500);
  }
  const btn=$('#pomoStartBtn');if(btn)btn.textContent='暂停';
}
function stopPomoTimer(){
  if(pomo.timer){clearInterval(pomo.timer);pomo.timer=null;}
  if(pomo.endAt){pomo.remaining=Math.round((pomo.endAt-Date.now())/1000);pomo.endAt=null;}
  const btn=$('#pomoStartBtn');if(btn&&!pomo.done&&!pomo.overtime)btn.textContent='继续';
}
function pomoChime(){
  const ctx=getCtx();if(!ctx)return;
  if(ctx.state==='suspended')ctx.resume();
  [880,1175,1568].forEach((f,i)=>{
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.type='sine';o.frequency.value=f;
    const t0=ctx.currentTime+i*0.16;
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(0.18,t0+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001,t0+0.32);
    o.connect(g);g.connect(ctx.destination);
    o.start(t0);o.stop(t0+0.34);
  });
}
function pomoVibrate(p){try{if(navigator.vibrate)navigator.vibrate(p);}catch(e){}}
function recordPomoSession(actualMinutes=null){
  const d=todayStr();
  if(!state.studyRecords[d])state.studyRecords[d]={sessions:[]};
  const isReview=pomo.kind==='review';
  const isFocus=pomo.kind==='focus';
  const duration=actualMinutes!==null?actualMinutes:(isReview||isFocus?Math.max(1,Math.round(pomo.remaining/60)):pomo.duration);
  const targetMin=(isFocus)?pomo.duration:0;
  const otMin=(isFocus&&targetMin>0)?Math.max(0,Math.round(pomo.remaining/60)-targetMin):0;
  const _sess={id:uid(),section:pomo.section,sub:pomo.sub||'',duration:duration,ts:Date.now(),kind:pomo.kind||'focus',overtime:otMin>0,overtimeMin:otMin};
  state.studyRecords[d].sessions.push(_sess);
  // 专注次数独立计数：番茄钟→录成绩时 session 会被消费（防时长双算），
  // 但次数不该跟着丢，否则周期复盘的「专注次数」永远是 0
  state.studyRecords[d].focusCount=(state.studyRecords[d].focusCount||0)+1;
  if(isFocus)pendingPomoSessId=_sess.id;
  save();
}
/* 记住休息前的专注时长，休息结束后恢复（刷新后丢失则回退默认 25 分钟） */
let pomoFocusDuration=25;
/* 开始 5 分钟休息：不计入今日番茄统计，完成后自动提示回专注 */
function startPomoBreak(){
  stopPomoTimer();
  if(pomo.kind!=='break')pomoFocusDuration=pomo.duration||25;
  pomo.kind='break';pomo.duration=5;pomo.remaining=5*60;pomo.custom=false;pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomo.running=true;
  startPomoTimer();save();showPomoFloat();openPomoFullscreen();
}
/* （已移除）复盘待办功能下线：错题复盘计时 / 关联跳转 / 完成回写 全部移除，历史数据由 migrateTodos 清理 */
/* 进度卡：主指标=实际速度（分/次），目标只是参考线。
   修正旧逻辑 bug：超时减少≠进步——只有实际速度真正变快才算进步；
   标准收严导致超时不算退步。 */
function overtimeTag(min){
  if(min<=0)return null;
  if(min<=5)return {t:'用时长',c:'#e8a33d'};
  if(min<=15)return {t:'速度慢',c:'#e67e22'};
  return {t:'待提高',c:'#e74c3c'};
}
/* 取最近 n 天日期串，offset=0 表示到今天为止，offset=7 表示上一周 */
function lastNDays(n,offset){
  const out=[];const now=new Date();
  for(let i=n-1+offset;i>=offset;i--){const d=new Date(now);d.setDate(now.getDate()-i);out.push(fmtDate(d));}
  return out;
}
/* 收集某实体（section + 可选 sub）在给定日期内的全部「学习时长」条目——专注番茄钟与手填录入都纳入，
   不再只认专注。手填记录时长按「时间归属」去重：拆分模块的多个子记录共享整段时长，
   只计整段那条(sub:null)，直接子模块任务(sub 非空且无整段兄弟)各自计；超时 overtimeMin 如实累加。 */
function collectTimeEntries(section,sub,dates){
  const out=[];
  dates.forEach(d=>{
    // 1) 专注番茄钟
    const sr=state.studyRecords[d];
    if(sr&&sr.sessions)sr.sessions.forEach(s=>{
      if(s.kind&&s.kind!=='focus')return;
      const sec=s.section||'', sb=s.sub||'';
      // null/undefined=不过滤；''=只收「记笔记」等空模块专注（旧写法 section 为空串时
      // 过滤被整体跳过，会把全模块记录平均成一个「未命名」速度行）
      if(section!=null&&sec!==section)return;
      if(sub!=null&&sb!==sub)return;
      out.push({sec,sub:sb,min:(s.duration||0),overtimeMin:(s.overtimeMin||0),kind:'focus'});
    });
    // 2) 手填录入（dailyStats[sec].records，存时已算 overtimeMin）
    const ds=state.dailyStats[d];
    if(ds)Object.keys(ds).forEach(sec=>{
      if(section!=null&&sec!==section)return;
      const rec=ds[sec];
      if(!rec||!rec.records)return;
      const hasOverall=rec.records.some(r=>r.sub==null);
      rec.records.forEach(r=>{
        const sb=r.sub||'';
        if(sub&&sb!==sub)return;
        if(sb!==''&&hasOverall)return; // 拆分子记录：时长共享整段、超时已挂整段，跳过避免时长虚高
        out.push({sec,sub:sb,min:(r.min||0),overtimeMin:(r.overtimeMin||0),kind:'manual'});
      });
    });
    // 3) 套卷复盘：整卷用时作为一次「套卷」学习单元计入速度卡（整张卷子速度）
    (state.examRecords||[]).forEach(r=>{
      if(!r||!r.date||dates.indexOf(r.date)<0)return;
      if(section!=null&&section!=='taojuan')return;
      if(sub!=null&&sub!=='')return;
      const dur=(r.duration||0);
      if(dur>0)out.push({sec:'taojuan',sub:'',min:dur,overtimeMin:0,kind:'exam'});
      // 3b) 各模块用时：每个填了用时的模块作为独立学习单元计入，速度卡据此给出「各模块速度」
      const md=r.modDurations||{};
      const sd=r.subDurations||{};
      EXAM_TYPES.forEach(t=>{
        const m=md[t.key];
        if(!m||m<=0)return;
        // 该大类下已填子模块用时 → 子行更细且合计≈大类值，跳过整体行避免同一段时间被算两遍（与手填拆分口径一致）
        const hasSubDur=(t.subs||[]).some(s=>(sd[s.key]||0)>0);
        if(hasSubDur)return;
        const sec=ET_TO_SEC[t.key]||'';
        if(section!=null&&sec!==section)return;
        if(sub!=null&&sub!==t.key)return;
        out.push({sec,sub:t.key,min:m,overtimeMin:0,kind:'exam-mod'});
      });
      // 3c) 子模块用时：每个填了用时的子题型也计入速度卡（与平时刷题的子模块速度合并统计）
      EXAM_TYPES.forEach(t=>{
        (t.subs||[]).forEach(s=>{
          const m=sd[s.key];
          if(!m||m<=0)return;
          const sec=ET_TO_SEC[t.key]||'';
          if(section!=null&&sec!==section)return;
          if(sub!=null&&sub!==s.key)return;
          out.push({sec,sub:s.key,min:m,overtimeMin:0,kind:'exam-sub'});
        });
      });
    });
  });
  return out;
}
/* 某实体（section + 可选 sub）在给定日期内的平均实际用时（分/次），专注+手填都算，无数据返回 null。
   没填时长（min=0 且无超时）的记录不进分母，否则一次漏填会把均速拉成 0 */
function avgFocusSpeed(section,sub,dates){
  const es=collectTimeEntries(section,sub,dates).filter(x=>(x.min>0||x.overtimeMin>0));
  if(!es.length)return null;
  return es.reduce((a,x)=>a+x.min,0)/es.length;
}
/* 按题量比例把整数分钟分摊到各行：floor 后余数补给比例余量最大的行，严格合计 totalMin。
   拆分模块一次录入是一整段时间，每行都盖整段会让速度卡时长翻倍（25分→两行各25=50）。*/
function allocMinutesByCount(rows,totalMin){
  const n=rows.length,out=new Array(n).fill(0);
  if(n===0)return out;
  if(totalMin<=0)return out;
  const tot=rows.reduce((a,r)=>a+(r.count||0),0);
  if(tot<=0){out[0]=totalMin;return out;}
  let acc=0;
  rows.forEach((r,i)=>{out[i]=Math.floor(totalMin*(r.count||0)/tot);acc+=out[i];});
  let rem=totalMin-acc;
  rows.map((r,i)=>({i: i,f:totalMin*(r.count||0)/tot-out[i]}))
    .sort((a,b)=>b.f-a.f)
    .forEach(o=>{if(rem>0){out[o.i]++;rem--;}});
  return out;
}
/* 录入后对比「我的目标」（速度 + 正确率）。
   countTargets 题量 + durTargets 时长 只参与算「标准速度（分钟/题）」，不单独对比行；
   weakTargets 正确率 单独对比。返回是否有对比（没设目标不弹，保持轻提示）。 */
function showGoalCompare(sec,sub,recs,totalMin){
  if(!sec&&!sub)return false;
  /* 目标查找与 resolveDurTarget/resolveCountTarget 同口径：子模块优先，回退大类。
     （目标可能设在大类而录入记到子模块，或反过来；精确匹配会静默不弹） */
  const pickT=obj=>{if(!obj)return null;if(sub&&obj[sub]!=null)return obj[sub];if(sec&&obj[sec]!=null)return obj[sec];return null;};
  const dt=pickT(state.durTargets);
  const ct=pickT(state.countTargets);
  const wt=pickT(state.weakTargets);
  if(dt==null&&ct==null&&wt==null)return false;
  const cnt=(recs||[]).reduce((a,r)=>a+(r.count||0),0);
  if(cnt<=0)return false;
  /* 本次正确率：按题量加权 */
  let rate=null;
  const wr=(recs||[]).filter(r=>r.count>0&&r.rate!=null);
  if(wr.length){const tc=wr.reduce((a,r)=>a+r.count,0);rate=Math.round(wr.reduce((a,r)=>a+r.count*r.rate,0)/tc);}
  const rows=[];
  /* 题量+时长目标只用来算标准速度（分钟/题），不单独对比行 */
  if(dt!=null&&ct!=null&&ct>0&&totalMin>0){
    const tgtSpd=dt/ct, curSpd=totalMin/cnt;
    const ok=curSpd<=tgtSpd+1e-9;
    rows.push({k:'速度',cur:(Math.round(curSpd*100)/100)+' 分/题',tgt:(Math.round(tgtSpd*100)/100)+' 分/题',ok,df:ok?'达标':'待提速'});
  }
  if(wt!=null&&rate!=null){
    const ok=rate>=wt;
    rows.push({k:'正确率',cur:rate+'%',tgt:wt+'%',ok,df:ok?(rate>wt?('高 '+(rate-wt)+'%'):'达标'):('低 '+(wt-rate)+'%')});
  }
  if(!rows.length)return false;
  const secName=(SECTION_MAP[sec]&&SECTION_MAP[sec].name)||sec;
  const allOk=rows.every(r=>r.ok);
  openModal('本次 vs 目标 · '+secName,
    `<div class="gc-summary ${allOk?'ok':''}">${allOk?'🎉 全部达标，保持住！':'有差距项，下次注意'}</div>
     <div class="goal-cmp">${rows.map(r=>`
      <div class="gc-row">
        <span class="gc-k">${r.k}</span>
        <span class="gc-cur">${r.cur}</span>
        <span class="gc-tgt">目标 ${r.tgt}</span>
        <span class="gc-df ${r.ok?'ok':'no'}">${r.ok?'✓':'✗'} ${r.df}</span>
      </div>`).join('')}
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px;"><button class="btn" onclick="closeModal()">知道了</button></div>`);
  return true;
}
/* 申论手动录分后对比「我的目标 → 申论得分率」（只有这一项；没设目标或分率解析不出则不弹，保持轻提示） */
function showShenlunGoalCompare(scoreRaw,typeName){
  const R=(state.weakTargets&&state.weakTargets.shenlun!=null)?state.weakTargets.shenlun:null;
  if(R==null)return false;
  const p=parseShenlunScore(scoreRaw);
  if(!p)return false;
  const rate=p.rate, ok=rate>=R;
  const df=ok?(rate>R?('高 '+(rate-R)+'%'):'达标'):('低 '+(R-rate)+'%');
  openModal('本次申论 vs 目标'+(typeName?(' · '+escapeHtml(typeName)):''),
    `<div class="gc-summary ${ok?'ok':''}">${ok?'🎉 达标，保持住！':'还差一点，继续练'}</div>
     <div class="goal-cmp">
      <div class="gc-row">
        <span class="gc-k">得分率</span>
        <span class="gc-cur">${rate}%${p.full!==100?('（'+p.got+'/'+p.full+'）'):''}</span>
        <span class="gc-tgt">目标 ${R}%</span>
        <span class="gc-df ${ok?'ok':'no'}">${ok?'✓':'✗'} ${df}</span>
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px;"><button class="btn" onclick="closeModal()">知道了</button></div>`);
  return true;
}
function renderOvertimeTips(){
  const thisWeek=lastNDays(7,0), lastWeek=lastNDays(7,1);
  // 收集本周有「专注或手填」时长的实体（两路都计入，避免只有手填时整卡空掉）
  const entMap={};
  collectTimeEntries(null,null,thisWeek).forEach(e=>{
    if(e.min<=0 && e.overtimeMin<=0)return;
    const key=e.sec+'|'+e.sub;
    if(!entMap[key])entMap[key]={section:e.sec,sub:e.sub};
  });
  const keys=Object.keys(entMap);
  const card=el('div','card');
  let html=`<div class="section-title"><span class="dot"></span>进度 · 实际速度</div>`;
  if(!keys.length){
    html+=`<div class="empty-tip" style="padding:14px 0;">本周还没录入刷题时间，先去刷一组吧 👊</div>`;
    card.innerHTML=html;return card;
  }
  keys.forEach(key=>{
    const e=entMap[key];
    const tw=avgFocusSpeed(e.section,e.sub,thisWeek);
    const lw=avgFocusSpeed(e.section,e.sub,lastWeek);
    const target=resolveDurTarget(e.section,e.sub);
    let name='';
    if(e.sub){name=subName(e.sub);if(!name&&SECTION_MAP[e.section])name=SECTION_MAP[e.section].name+'(套卷)';}
    // 空模块（记笔记待办发起的专注）统一叫「专注」，与番茄钟浮窗口径一致，不再显示「未命名」
    if(!name)name=(SECTION_MAP[e.section]&&SECTION_MAP[e.section].name)||(e.section==='taojuan'?'行测套卷':(e.section||'专注'));
    const col=(SECTION_MAP[e.section]&&SECTION_MAP[e.section].color)||(e.section==='taojuan'?'#e8a33d':'#999');
    let badge='',diffTxt='';
    if(tw!=null&&lw!=null){
      const diff=Math.round((tw-lw)*10)/10;
      if(diff<0){badge=`<span class="badge good">进步 ✓</span>`;diffTxt=`<span style="color:#2bb673;font-weight:700;">▼ ${Math.abs(diff)} 分/次</span>`;}
      else if(diff>0){badge=`<span class="badge bad">退步</span>`;diffTxt=`<span style="color:#e67e22;font-weight:700;">▲ ${diff} 分/次</span>`;}
      else diffTxt=`<span style="color:var(--text-3)">持平</span>`;
    }
    /* 目标参考线：设了「我的目标」时长用设定值；没设则取近 30 天历史平均每次时长兜底显示，
       让「自动(历史均值)」落到具体数字；近 30 天无任何时长记录才退回纯文案 */
    let effTarget=target,tgtIsAvg=false;
    let tgtTxt;
    if(target!=null){tgtTxt=`目标 ${target} 分`;}
    else{
      const _hist=avgFocusSpeed(e.section,e.sub,lastNDays(30,0));
      if(_hist!=null){effTarget=Math.round(_hist*10)/10;tgtIsAvg=true;tgtTxt=`目标 ${effTarget} 分（近30天均值）`;}
      else tgtTxt='目标：自动(历史均值)';
    }
    /* 目标参照线：我的目标里「题量+时长」配出的标准速度（分钟/题），与录入对比弹窗同一口径 */
    const _stdSpd=resolveStandardSpeed(e.section,e.sub);
    const stdTxt=_stdSpd?(` · 标准速度 ${(Math.round(_stdSpd*100)/100)} 分/题`):'';
    const ot=(tw!=null&&effTarget!=null)?Math.round((tw-effTarget)*10)/10:null;
    const otTxt=ot==null?'':(ot<=0
      ?`<span style="color:#2bb673;">${tgtIsAvg?'较均值快':'达标'} ${Math.abs(ot)} 分</span>`
      :`<span style="color:#e67e22;">${tgtIsAvg?'较均值慢':'超目标'} ${ot} 分</span>`);
    html+=`<div class="ot-speed-row">
      <span class="swatch" style="background:${col}"></span>
      <div class="grow"><b>${name}</b> ${badge}<br><span class="muted" style="font-size:12px;">本周均速 ${tw!=null?Math.round(tw*10)/10:'—'} 分/次 · 较上周 ${diffTxt} · ${tgtTxt}${stdTxt}${otTxt?' · '+otTxt:''}</span></div>
    </div>`;
  });
  // 今天明细：实际 vs 目标（专注 + 手填都纳入，超时如实显示）
  const d=todayStr();const tmap={};
  collectTimeEntries(null,null,[d]).forEach(e=>{
    if(e.min<=0&&e.overtimeMin<=0)return; // 没填时长的录入不进「今天学习」，避免 0 分一行、次数虚增
    const k=e.sec+'|'+e.sub;
    const _secName=(SECTION_MAP[e.sec]&&SECTION_MAP[e.sec].name)||(e.sec==='taojuan'?'行测套卷':(e.sec||'专注'));
    const _secCol=(SECTION_MAP[e.sec]&&SECTION_MAP[e.sec].color)||(e.sec==='taojuan'?'#e8a33d':(e.sec?'#999':'#9eacf0'));
    if(!tmap[k])tmap[k]={name:(e.sub?(subName(e.sub)||(_secName+'·子模块')):_secName),col:_secCol,min:0,n:0,ot:0};
    tmap[k].min+=e.min;tmap[k].n++;tmap[k].ot+=e.overtimeMin;
  });
  const tk=Object.keys(tmap);
  if(tk.length){
    html+=`<div class="ot-sub">今天学习</div>`;
    tk.forEach(k=>{const m=tmap[k];const tag=m.ot>0?overtimeTag(m.ot):null;
      html+=`<div class="ot-row"><span class="swatch" style="background:${m.col}"></span><span class="grow">${m.name} 实做 ${Math.round(m.min)} 分${m.n>1?'（'+m.n+' 次）':''}</span>${tag?`<span class="ot-tag" style="background:${tag.c}">${tag.t}</span>`:''}</div>`;
    });
  }
  card.innerHTML=html;
  return card;
}

/* 番茄钟结束后：顺手问一句要不要记这轮的题量/正确率。
   不强制（可「不用了」），勾了「今天不再提示」就当天不再弹。
   只提示有真实专注时长的情况（actualMin>0），避免误点。 */
function promptPomoRecord(min){
  const d=todayStr();
  if(state.pomoNoPromptDate===d)return;
  const sec=pomo.section;
  const name=(SECTION_MAP[sec]&&SECTION_MAP[sec].name)||'本模块';
  const st=(state.dailyStats[d]&&state.dailyStats[d][sec])||null;
  const tip=st&&st.count>0
    ? `今天「${name}」已记 ${st.count} 题、正确率 ${st.rate!=null?st.rate+'%':'未填'}，可以直接改数字。`
    : `今天「${name}」还没录题量，趁热记一下，复盘时才能算进正确率。`;
  openModal('记一笔这轮的成果？',
    `<p style="margin:0 0 14px;color:var(--text-2);line-height:1.6;font-size:14px;">刚专注了 <b>${min} 分钟</b>（${escapeHtml(name)}）。${escapeHtml(tip)}</p>
     <label class="row" style="gap:8px;align-items:center;font-size:13px;color:var(--text-sub);margin-bottom:16px;cursor:pointer;">
       <input type="checkbox" id="pomoNoPrompt" style="width:16px;height:16px;"> 今天不再提示
     </label>
     <div class="row" style="justify-content:flex-end;gap:8px;flex-wrap:wrap;">
       <button class="btn btn-ghost btn-sm" id="pomoBreakBtn">先休息 5 分钟</button>
       <button class="btn btn-ghost btn-sm" id="pomoSkipBtn">不用了</button>
       <button class="btn btn-sm" id="pomoRecordBtn">去录入</button>
     </div>`);
  const closeWith=fn=>{
    const cb=$('#pomoNoPrompt');
    if(cb&&cb.checked){state.pomoNoPromptDate=d;save();}
    closeModal();fn&&fn();
  };
  $('#pomoSkipBtn').addEventListener('click',()=>{pendingPomoSessId=null;closeWith(null);});
  $('#pomoRecordBtn').addEventListener('click',()=>closeWith(()=>openReportBySection(sec)));
  const breakBtn=$('#pomoBreakBtn');
  if(breakBtn)breakBtn.addEventListener('click',()=>closeWith(()=>startPomoBreak()));
}

/* ---------- 月度打卡日历（保留） ---------- */
let calCursor=new Date();
function renderCalendar(){
  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>月度打卡日历</div>`;
  const body=el('div');
  card.appendChild(body);

  function update(){
    const y=calCursor.getFullYear(),m=calCursor.getMonth();
    body.innerHTML='';
    const head=el('div','cal-head');
    head.innerHTML=`<button class="cal-arrow" id="calPrev">‹</button><span class="cal-title">${y}年${m+1}月</span><button class="cal-arrow" id="calNext">›</button>`;
    body.appendChild(head);
    const grid=el('div','cal-grid');
    ['日','一','二','三','四','五','六'].forEach(d=>{const e=el('div','cal-dow');e.textContent=d;grid.appendChild(e);});
    const first=new Date(y,m,1).getDay();
    const daysInMonth=new Date(y,m+1,0).getDate();
    for(let i=0;i<first;i++)grid.appendChild(el('div','cal-cell empty'));
    const cats=activeCheckinCategories();   // 循环外取一次，避免 31 个格子重复过滤
    for(let day=1;day<=daysInMonth;day++){
      const ds=`${y}-${pad(m+1)}-${pad(day)}`;
      const cell=el('div','cal-cell');
      if(ds===todayStr())cell.classList.add('today');
      const doneN=cats.filter(k=>isChecked(ds,k)).length;
      const totalCat=cats.length;
      if(totalCat>0&&doneN>=totalCat)cell.classList.add('checked');
      else if(doneN>0)cell.classList.add('partial');
      cell.innerHTML=`<span>${day}</span>${doneN>0?`<span class="cal-done">${doneN}项</span>`:''}`;
      cell.addEventListener('click',()=>openDayDetail(ds));
      grid.appendChild(cell);
    }
    body.appendChild(grid);
    body.querySelector('#calPrev').addEventListener('click',()=>{calCursor=new Date(calCursor.getFullYear(),calCursor.getMonth()-1,1);update();});
    body.querySelector('#calNext').addEventListener('click',()=>{calCursor=new Date(calCursor.getFullYear(),calCursor.getMonth()+1,1);update();});
  }
  update();
  return card;
}
function openDayDetail(ds){
  const total=dayTotalMin(ds);
  let body=`<div class="muted" style="margin-bottom:10px;">${ds} · 学习总时长：<b>${(total/60).toFixed(2)}</b> 小时</div>`;
  body+=`<div class="section-title" style="font-size:14px;">当天学习记录</div>`;
  const cats=activeCheckinCategories();
  const dayStat=state.dailyStats&&state.dailyStats[ds];
  if(!cats.length){
    body+=`<div class="empty-tip" style="padding:8px 0;">还没勾选打卡分类</div>`;
  }
  cats.forEach(k=>{
    const s=SECTION_MAP[k];const done=isChecked(ds,k);
    const st=dayStat&&dayStat[k];const c=st&&st.count||0;const r=st&&st.rate;
    const _unit=(CHECKIN_UNIT&&CHECKIN_UNIT[k])||'题';
    const status=c>0?(`${c} ${_unit}${r!=null?' · '+Math.round(r)+'%':''}`):(done?'✓ 已记':'—');
    body+=`<div class="detail-row"><span class="swatch" style="background:${s.color}"></span><span class="grow">${s.name}</span><span>${status}</span></div>`;
    if(st&&st.subs&&Object.keys(st.subs).length){
      Object.keys(st.subs).forEach(sub=>{
        const ss=st.subs[sub];const sc=ss.count||0;if(sc<=0)return;
        body+=`<div class="detail-row" style="padding-left:24px;"><span class="grow" style="color:var(--text-sub);font-size:13px;">${escapeHtml(subName(sub)||sub)}</span><span style="color:var(--text-sub);font-size:13px;">${sc} 题${ss.rate!=null?' · '+Math.round(ss.rate)+'%':''}</span></div>`;
      });
    }
  });
  if(total>0){
    const secMap=daySectionMin(ds);
    body+=`<div class="section-title" style="margin-top:14px;font-size:14px;">学习时长分布</div>`;
    SECTIONS.forEach(s=>{const m=secMap[s.key]||0;if(m>0)body+=`<div class="detail-row"><span class="swatch" style="background:${s.color}"></span><span class="grow">${s.name}</span><span>${(m/60).toFixed(2)} h</span></div>`;});
  }
  // 当天申论记录
  const slReviews=(state.shenlunReviews||[]).filter(r=>r.date===ds);
  if(slReviews.length){
    body+=`<div class="section-title" style="margin-top:14px;font-size:14px;">申论记录（${slReviews.length} 条）</div>`;
    slReviews.forEach(r=>{
      body+=`<div class="detail-row"><span class="grow">${escapeHtml(r.label||'申论')}${r.type?' · '+escapeHtml(r.type):''}</span><span>${r.score?escapeHtml(r.score):''}</span></div>`;
    });
  }
  const rec=state.studyRecords[ds];
  if(rec&&(rec.sessions||[]).length){
    body+=`<div class="section-title" style="margin-top:14px;font-size:14px;">番茄钟记录（${rec.sessions.length} 段）</div>`;
    body+=(rec.sessions||[]).map(s=>{
      const nm=(SECTION_MAP[s.section]&&SECTION_MAP[s.section].name)||'专注'; // 空模块专注（从记笔记/网课待办启动）不能显示 undefined
      const kind=s.kind==='review'?'复盘':'专注';
      const ot=overtimeTag(s.overtimeMin||0);
      const tag=s.overtime?`<span class="ot-tag" style="background:${ot?ot.c:'#e8a33d'}">${ot?ot.t:'超时'}</span>`:'';
      return `<div class="detail-row"><span class="swatch" style="background:${s.kind==='review'?'#e8a33d':(SECTION_MAP[s.section]?SECTION_MAP[s.section].color:'#999')}"></span><span class="grow">${nm} · ${kind} ${(s.duration||0)} 分钟</span>${tag}</div>`;
    }).join('');
  }
  openModal(`${ds} 学习详情`,body);
}

/* ---------- 模块子分类Tabs ---------- */
let _sectionTab={}; let _sectionGroup={}; // 记录每个模块当前选中的子分类tab
let _wbFilter='all'; // 搜索时的词库过滤：all 或具体 group key
/* 这些模块不显示「全部」tab（下面还有一层分区，再加全量视图层级太碎） */
const NO_ALL_TAB_SECTIONS=['yanyu'];
function renderSectionTabs(sectionKey){
  const tags=CATEGORY_TAGS[sectionKey]||[];
  if(tags.length===0)return null;
  // 言语不显示「全部」：它下面还有一层分区，再来个全量视图层级太碎（用户要求）
  const useAll=NO_ALL_TAB_SECTIONS.indexOf(sectionKey)<0;
  const wrap=el('div','section-tabs');
  const tabs=(useAll?[{k:'all',n:'全部'}]:[]).concat(tags.map(t=>({k:t,n:t})));
  const current=(_sectionTab[sectionKey]&&tabs.some(t=>t.k===_sectionTab[sectionKey]))?_sectionTab[sectionKey]:tabs[0].k;
  tabs.forEach(tab=>{
    const b=el('button','section-tab'+(tab.k===current?' active':''));
    b.textContent=tab.n;
    b.addEventListener('click',()=>{
      _sectionTab[sectionKey]=tab.k;
      render();
    });
    wrap.appendChild(b);
  });
  return wrap;
}
function getSectionTab(sectionKey){
  const tags=CATEGORY_TAGS[sectionKey]||[];
  const cur=_sectionTab[sectionKey];
  if(NO_ALL_TAB_SECTIONS.indexOf(sectionKey)<0)return cur||'all';
  // 无「全部」的模块：残留的 'all' 或非法值一律回退到第一个分类
  return (cur&&tags.indexOf(cur)>=0)?cur:(tags[0]||'');
}
function renderSectionGroupTabs(sectionKey,groups){
  if(!groups||!groups.length)return null;
  const wrap=el('div','group-tabs');
  const current=_sectionGroup[sectionKey]||groups[0].key;
  groups.forEach(g=>{
    const b=el('button','group-tab'+(g.key===current?' active':''));
    b.textContent=g.name;
    b.addEventListener('click',()=>{_sectionGroup[sectionKey]=g.key;render();});
    wrap.appendChild(b);
  });
  return wrap;
}

/* ============================================================
   政治理论：时政热点10条
   ============================================================ */
function renderPolitics(c){
  const tabs=renderSectionTabs('politics');
  if(tabs)c.appendChild(tabs);
  const tab=getSectionTab('politics');
  const allNews=mergeData('politicsNews',POLITICS_NEWS,state.customData.politicsNews);
  // 时政热点默认归到"新思想"，挖空自测默认归到"新思想"
  const showNews=tab==='all'||tab==='新思想';
  const showQuiz=tab==='all'||tab==='新思想';
  if(showNews){
  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>今日时政热点</div>
    <div class="muted" style="margin-bottom:12px;">共 ${allNews.length} 条，标注公考考点，附来源链接可溯源${typeof NEWS_UPDATED!=='undefined'?' · 联网整理于 '+NEWS_UPDATED:''}</div>`;
  allNews.forEach((n,i)=>{
    const item=el('div','news-item');
    const link=safeUrl(n.url)?` · <a href="${safeUrl(n.url)}" target="_blank" rel="noopener">查看原文 →</a>`:'';
    item.innerHTML=`
      <div class="ni-title">${i+1}. ${escapeHtml(n.title)}</div>
      <div class="ni-summary">${annot(n.summary)}</div>
      <div class="ni-point">${icon('target')} ${annot(n.point)}</div>
      <div class="ni-source">${icon('link')} 来源：${annot(n.source)}${link}</div>`;
    card.appendChild(item);
  });
  c.appendChild(card);
  }

  // 政治理论挖空自测（保留）
  if(showQuiz){
  const card2=el('div','card');
  card2.innerHTML=`<div class="section-title"><span class="dot"></span>政治理论挖空自测</div>`;
  const btn=el('button','btn btn-ghost btn-sm');btn.textContent=politicsShow?'隐藏答案':'显示答案';
  btn.style.marginBottom='12px';
  btn.addEventListener('click',()=>{politicsShow=!politicsShow;render();});
  card2.appendChild(btn);
  const allPoliticsQ=mergeData('politicsQuestions',POLITICS_QUESTIONS,state.customData.politicsQuestions);
  allPoliticsQ.forEach(q=>{
    const it=el('div','fill-item'+(politicsShow?' show':''));
    let html=annot(q.q).replace(/\{\{(.+?)\}\}/g,(m,a)=>`<span class="blank-red">${politicsShow?'':'____'}</span><span class="blank-answer">【${escapeHtml(a)}】</span>`);
    it.innerHTML=`<div class="fill-q">${html}</div><div class="fill-cat">题型：${q.cat}</div>`;
    card2.appendChild(it);
  });
  c.appendChild(card2);
  }
  if(!showNews&&!showQuiz){
    const empty=el('div','card');
    empty.innerHTML=`<div class="empty-tip">「${tab}」分类暂无内容，可在管理中添加</div>`;
    c.appendChild(empty);
  }
}
let politicsShow=false;

/* ============================================================
   常识：10条（5类每类2条）
   ============================================================ */
function renderChangshi(c){
  const tabs=renderSectionTabs('changshi');
  if(tabs)c.appendChild(tabs);
  const tab=getSectionTab('changshi');
  const allSense=mergeData('changshi',COMMON_SENSE,state.customData.changshi);
  // 常识的cat字段映射到子分类：内置数据用 法律/政治/经济/人文/科技；
  // 旧数据/自定义数据里的 人文历史/科技常识/地理常识/文史 等命名也兼容映射过来
  const CAT_MAP={'法律':'法律','政治':'政治','经济':'经济','人文':'人文','科技':'科技','人文历史':'人文','科技常识':'科技','地理常识':'地理','文史':'人文'};
  const filteredSense=tab==='all'?allSense:allSense.filter(cat=>CAT_MAP[cat.cat]===tab);
  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>常识积累</div>
    <div class="muted" style="margin-bottom:12px;">共 ${filteredSense.length} 个类别${tab!=='all'?'（'+tab+'）':''}</div>`;
  if(filteredSense.length===0){
    card.innerHTML+=`<div class="empty-tip">该分类暂无内容</div>`;
  }
  // 每个类别默认收起成一行，点开才看该类别的 Q&A（类别多、条数多也不会拉长页面）
  filteredSense.forEach((cat,i)=>{
    const list=cat.items||[];
    const inner=list.map(it=>`<div class="sc-item"><div class="sc-q">Q：${annot(it.q)}</div><div class="sc-a">A：${annot(it.a)}</div></div>`).join('');
    card.appendChild(makeFoldItem('changshi:'+tab,i,
      `${icon('book-open')} ${escapeHtml(cat.cat)}（${list.length}条）`,
      inner||'<div class="empty-tip">该分类暂无内容</div>'));
  });
  c.appendChild(card);
}

/* ============================================================
   言语理解：成语辨析5对 + 可检验试题
   ============================================================ */

/* 内容条目：默认全展开显示（用户已确认内容页不做折叠） */
function makeFoldItem(groupKey,idx,titleHtml,bodyHtml,onBuild){
  const item=el('div','fold-item open');
  const head=el('div','fold-head');
  head.innerHTML=`<span class="fold-title">${titleHtml}</span>`;
  const body=el('div','fold-body');
  body.innerHTML=bodyHtml||'';
  if(onBuild)onBuild(body);
  item.appendChild(head);item.appendChild(body);
  return item;
}
/* 卡片可折叠：点标题栏收起/展开整区。返回内容容器，往里 append 内容即可 */
function makeCardFoldable(card,cardKey){
  return card;
}

/* 逻辑填空下的四个词库分区：辨析=两词对比，积累=单词释义 */
const FILL_BLANK_GROUPS=[
  {key:'idioms',     builtin:()=>IDIOM_PAIRS,  name:'成语辨析',   kind:'pair'},
  {key:'idiomWords', builtin:()=>IDIOM_WORDS,  name:'成语积累', kind:'word'},
  {key:'shiciPairs', builtin:()=>SHICI_PAIRS,  name:'实词辨析',   kind:'pair'},
  {key:'shiciWords', builtin:()=>SHICI_WORDS,  name:'实词积累', kind:'word'}
];

/* ============================================================
   内容学习状态：未学 → 学习中 → 已掌握（点标签循环切换）
   存储 state.learnStage={内容key:{条目key:stage}}；'new' 不落盘
   ============================================================ */
const STAGE_ORDER=['new','learning','mastered'];
const STAGE_META={
  new:      {name:'未学',   cls:'is-new'},
  learning: {name:'学习中', cls:'is-learning'},
  mastered: {name:'已掌握', cls:'is-mastered'}
};
/* 条目稳定 key：辨析取「词A|词B」，积累取词本身。内置内容无 id，用内容本身做 key 才不会因增删错位 */
function itemStageKey(g,p){
  if(!p)return '';
  if(g&&g.kind==='pair'){
    const w=_pairWords(p);
    return (w[0]||'')+'|'+(w[1]||'');
  }
  return String(p.word||'');
}
/* 存储形态 {s:阶段, n:下次复习日 YYYY-MM-DD|null, r:连续答对次数, w:权重}；旧数据可能是纯字符串，读时兼容 */
function lsGet(ck,ik){
  const m=state.learnStage&&state.learnStage[ck];
  const v=m&&m[ik];
  if(!v)return {s:'new',n:null,r:0,t:null,w:0};
  if(typeof v==='string')return {s:v,n:null,r:0,t:null,w:0};
  if(typeof v!=='object')return {s:'new',n:null,r:0,t:null,w:0};
  return {s:v.s||'new',n:v.n||null,r:v.r||0,t:v.t||null,w:v.w||0};
}
function lsSet(ck,ik,s,n,r){
  if(!state.learnStage)state.learnStage={};
  if(!state.learnStage[ck])state.learnStage[ck]={};
  const prev=state.learnStage[ck][ik];
  const prevW=(typeof prev==='object'&&prev)?(prev.w||0):0;   // 状态切换保留权重
  if(s==='new'&&!n&&!prevW)delete state.learnStage[ck][ik];   // 未学且无权重复无复习计划 → 不占存储
  else state.learnStage[ck][ik]={s:s,n:n||null,r:r||0,t:Date.now(),w:prevW};
  save();
}
/* 设置词条权重（0-99）：权重越高，同状态下排得越靠前 */
function setWeight(ck,ik,w){
  if(!state.learnStage)state.learnStage={};
  if(!state.learnStage[ck])state.learnStage[ck]={};
  w=Math.max(0,Math.min(99,Math.round(w)||0));
  const cur=lsGet(ck,ik);
  if(w===0&&cur.s==='new'){delete state.learnStage[ck][ik];save();return;}
  state.learnStage[ck][ik]={s:cur.s,n:cur.n||null,r:cur.r||0,t:cur.t||Date.now(),w:w};
  save();
}
function getStage(ck,ik){return lsGet(ck,ik).s;}
/* 艾宾浩斯式间隔（天）：连续答对次数越多，下次来得越晚 */
const REVIEW_STEPS=[1,2,4,7,15,30];
/* r=连续答对次数：第1次答对隔1天，之后 2/4/7/15/30 天递增，封顶30天 */
function reviewNextDate(r){
  const i=Math.max(0,Math.min((r||1)-1,REVIEW_STEPS.length-1));
  return addDays(todayStr(),REVIEW_STEPS[i]);
}
/* 设定阶段并同步排好复习计划：未学=不复习；学习中=明天；已掌握=按间隔递增 */
function applyStage(ck,ik,st){
  const cur=lsGet(ck,ik);
  if(st==='new')      lsSet(ck,ik,'new',null,0);
  else if(st==='learning') lsSet(ck,ik,'learning',addDays(todayStr(),1),0);
  else {const r=(cur.s==='mastered'?cur.r:0)+1; lsSet(ck,ik,'mastered',reviewNextDate(r),r);}
}
/* 学习自评：good=会了（进已掌握、间隔+1档）/ hard=模糊（学习中、明天再来）/ again=不会（退未学、明天再来） */
function rateItem(ck,ik,grade){
  const cur=lsGet(ck,ik);
  if(grade==='good'){ const r=(cur.r||0)+1; lsSet(ck,ik,'mastered',reviewNextDate(r),r); }
  else if(grade==='hard'){ lsSet(ck,ik,'learning',addDays(todayStr(),1),0); }
  else { lsSet(ck,ik,'new',addDays(todayStr(),1),0); }
}
/* 今日到期需要复习的条目（跨所有词库） */
function dueReviewList(){
  const t=todayStr(),out=[];
  Object.keys(state.learnStage||{}).forEach(ck=>{
    const m=state.learnStage[ck]||{};
    Object.keys(m).forEach(ik=>{
      const v=lsGet(ck,ik);
      if(v.n&&v.n<=t)out.push({ck:ck,ik:ik,s:v.s});
    });
  });
  return out;
}
/* 反查：把 {ck,ik} 还原成 分区+条目，供学习/复习界面显示 */
function findItemByKey(ck,ik){
  for(const g of YANYU_ALL_GROUPS){
    if(g.key!==ck)continue;
    const items=mergeData(g.key,g.builtin(),state.customData[g.key]);
    const it=items.find(p=>itemStageKey(g,p)===ik);
    if(it)return {g:g,item:it};
  }
  return null;
}
/* 旧数据迁移：纯字符串 → {s,n,r} */
function migrateLearnStage(){
  if(!state.learnStage||typeof state.learnStage!=='object'){state.learnStage={};return;}
  let changed=false;
  Object.keys(state.learnStage).forEach(ck=>{
    const m=state.learnStage[ck];
    if(!m||typeof m!=='object'||Array.isArray(m)){state.learnStage[ck]={};changed=true;return;}
    Object.keys(m).forEach(ik=>{
      const v=m[ik];
      if(typeof v==='string'){m[ik]={s:v,n:null,r:0};changed=true;}
      else if(!v||typeof v!=='object'){delete m[ik];changed=true;}
      else if(v.s===undefined){v.s='new';changed=true;}
    });
  });
  if(changed)save();
}
/* 点一下进下一档：未学→学习中→已掌握→未学 */
function cycleStage(ck,ik){
  const cur=lsGet(ck,ik);
  const next=STAGE_ORDER[(STAGE_ORDER.indexOf(cur.s)+1)%STAGE_ORDER.length];
  applyStage(ck,ik,next);
  return next;
}
/* 标题右侧的状态标签（button，点它切换；stopPropagation 防止误触折叠）+ 权重按钮（纯数字，点一次 +1，长按清零） */
function stageBadgeHtml(ck,ik){
  const st=getStage(ck,ik),m=STAGE_META[st];
  const w=lsGet(ck,ik).w||0;
  return `<button class="lstg ${m.cls}" data-ck="${escapeHtml(ck)}" data-ik="${escapeHtml(ik)}" title="点击切换：未学 → 学习中 → 已掌握">${m.name}</button>`
    +`<button class="wbtn${w>0?' has':''}" data-ck="${escapeHtml(ck)}" data-ik="${escapeHtml(ik)}" title="点击权重 +1，长按清零；权重越高，同状态下排得越靠前">${w}</button>`;
}
/* 按 学习中→未学→已掌握、同状态权重高在前、同权重按添加顺序 就地重排卡片内词条（不整页重渲染） */
function resortCard(card){
  if(!card)return;
  const rows=[...card.querySelectorAll('.fold-item')];
  const rankOf=n=>{
    const sb=n.querySelector('.lstg');
    if(!sb)return [1,0,1e9];
    const l=lsGet(sb.getAttribute('data-ck'),sb.getAttribute('data-ik'));
    return [stageRank(l.s),-(l.w||0),+n.dataset.srcIdx||1e9];
  };
  rows.sort((x,y)=>{
    const a=rankOf(x),c=rankOf(y);
    for(let i=0;i<a.length;i++){if(a[i]!==c[i])return a[i]-c[i];}
    return 0;
  });
  rows.forEach(n=>card.appendChild(n));
}
/* 绑定状态切换 + 权重设置（局部更新，不整页重渲染，避免滚动回到顶部） */
function bindStageToggle(root){
  if(!root)return;
  root.querySelectorAll('.lstg').forEach(b=>{
    b.addEventListener('click',e=>{
      e.stopPropagation();e.preventDefault();
      const n=cycleStage(b.getAttribute('data-ck'),b.getAttribute('data-ik'));
      toast('已标记为「'+STAGE_META[n].name+'」');
      const nm=STAGE_META[n];
      b.className='lstg '+nm.cls;
      b.textContent=nm.name;
      resortCard(b.closest('.card'));
    });
  });
  root.querySelectorAll('.wbtn').forEach(b=>{
    const ck=b.getAttribute('data-ck'),ik=b.getAttribute('data-ik');
    // 刷新当前按钮样式/文本；reorder=true 时重排所在卡片
    const refresh=reorder=>{
      const nw=lsGet(ck,ik).w||0;
      b.className='wbtn'+(nw>0?' has':'');
      b.textContent=nw;
      if(reorder)resortCard(b.closest('.card'));
    };
    let pressTimer=null,decTimer=null,long=false,usedTouch=false;
    const clearPress=()=>{
      if(pressTimer){clearTimeout(pressTimer);pressTimer=null;}
      if(decTimer){clearInterval(decTimer);decTimer=null;}
    };
    /* 短按（<600ms）→ +1；长按 → 进入递减模式（每400ms -1，到0停），防手误一键清零 */
    const startPress=()=>{
      long=false;
      pressTimer=setTimeout(()=>{
        long=true;
        const c0=lsGet(ck,ik).w||0;
        if(c0>0){setWeight(ck,ik,c0-1);refresh(false);}
        decTimer=setInterval(()=>{
          const c1=lsGet(ck,ik).w||0;
          if(c1<=0){clearInterval(decTimer);decTimer=null;return;}
          setWeight(ck,ik,c1-1);
          refresh(false);
        },400);
      },600);
    };
    const endPress=()=>{
      clearPress();
      if(long){
        toast('权重：'+(lsGet(ck,ik).w||0));
        refresh(true);
      }else{
        setWeight(ck,ik,(lsGet(ck,ik).w||0)+1);
        refresh(true);
      }
    };
    b.addEventListener('mousedown',e=>{e.preventDefault();startPress();});
    b.addEventListener('mouseup',e=>{e.preventDefault();if(usedTouch)return;endPress();});
    b.addEventListener('mouseleave',clearPress);
    b.addEventListener('touchstart',e=>{e.preventDefault();usedTouch=true;startPress();},{passive:false});
    b.addEventListener('touchend',e=>{e.preventDefault();endPress();setTimeout(()=>{usedTouch=false;},120);},{passive:false});
    b.addEventListener('touchcancel',clearPress);
  });
}
/* 词条排序：学习中 → 未学 → 已掌握；同状态按权重高在前，权重相同按词条添加顺序 */
function stageRank(s){return s==='learning'?0:(s==='new'?1:2);}
function sortByStage(g,items){
  return items.map((p,i)=>({p,i})).sort((a,b)=>{
    const ra=stageRank(getStage(g.key,itemStageKey(g,a.p)));
    const rb=stageRank(getStage(g.key,itemStageKey(g,b.p)));
    if(ra!==rb)return ra-rb;
    const wa=lsGet(g.key,itemStageKey(g,a.p)).w||0;
    const wb=lsGet(g.key,itemStageKey(g,b.p)).w||0;
    if(wa!==wb)return wb-wa;   // 权重高在前（优先级高于添加时间）
    return a.i-b.i;            // 同权重保持添加顺序
  }).map(x=>x.p);
}

/* 片段阅读 / 语句表达 的分区（内容可经「管理内容」添加，内置为空） */
const YANYU_GROUP_MAP={
  '片段阅读':[
    {key:'ydzhongxin',builtin:()=>[],name:'中心理解题',kind:'word'},
    {key:'ydxijie',builtin:()=>[],name:'细节判断题',kind:'word'},
    {key:'ydyuju',builtin:()=>[],name:'语句理解题',kind:'word'},
    {key:'ydbiaoti',builtin:()=>[],name:'标题填入题',kind:'word'}
  ],
  '语句表达':[
    {key:'ywpaixu',builtin:()=>[],name:'语句排序',kind:'word'},
    {key:'ywtiankong',builtin:()=>[],name:'语句填空',kind:'word'},
    {key:'ywjieyu',builtin:()=>[],name:'接语选择',kind:'word'}
  ]
};
const YANYU_ALL_GROUPS=FILL_BLANK_GROUPS.concat(YANYU_GROUP_MAP['片段阅读'],YANYU_GROUP_MAP['语句表达']);
/* 辨析型分组的判定：以分组定义里的 kind 为准，新增辨析组无需再改这里 */
function _isPairKey(key){const g=YANYU_ALL_GROUPS.find(x=>x.key===key);return !!g&&g.kind==='pair';};
let _yanyuTodoRef=null;   // 当前「本模块待办」卡片节点引用，renderYanyuCore 重渲染时据此补回（不依赖已从 DOM 删除的节点）
function renderYanyu(c){renderYanyuCore(c);}
/* 恢复「本模块待办」卡片（清空搜索时）：不依赖全局 _yanyuTodoRef，直接按当前待办重建，
   避免跨页引用错乱（曾导致 学习→言语 后任务栏丢失，以及 搜索→切其它页→清空 时插错卡） */
function restoreYanyuTodo(c,bar){
  const prev=c.querySelector(':scope > .sec-todo-card');
  if(prev)prev.remove();
  const tc=renderSectionTodoCard('yanyu');
  if(tc){
    // 与 render() 一致：待办卡插到搜索栏「前面」，保持 任务栏在上、搜索栏在下 的原顺序
    c.insertBefore(tc, bar||c.firstChild);
    _yanyuTodoRef=tc;   // 同步全局引用，render() 末尾的 insertBefore 才能挪同一张卡，否则会再插一张造成两个任务栏
  }
}
function renderYanyuCore(c){
  // 保留搜索框与焦点；词库搜索模式：不看分区，所有命中分区都列出来
  const bar=c.querySelector('.mod-search');
  const q=bar?(bar.querySelector('.ms-input').value||'').trim():'';
  const hadFocus=bar&&bar.querySelector('.ms-input')===document.activeElement;
  c.innerHTML='';
  const tabs=renderSectionTabs('yanyu');
  if(tabs)c.appendChild(tabs);
  const tab=getSectionTab('yanyu');
  // 四个词库分区都归在"逻辑填空"下
  // 片段阅读 / 语句表达 与 逻辑填空 一样按分区渲染；未登记子分类时回退到词库分组
  const groups=(tab==='逻辑填空'||!(YANYU_GROUP_MAP[tab]||[]).length)?FILL_BLANK_GROUPS:YANYU_GROUP_MAP[tab];
  if(q){
    // 搜索过滤 tab：全部 + 四库；点选只在该库内搜
    const wbTabs=[{k:'all',n:'全部'}].concat(FILL_BLANK_GROUPS.map(g=>({k:g.key,n:g.name})));
    const wbCur=wbTabs.some(t=>t.k===_wbFilter)?_wbFilter:'all';
    const wbWrap=el('div','group-tabs');
    wbTabs.forEach(t=>{
      const b=el('button','group-tab'+(t.k===wbCur?' active':''));
      b.textContent=t.n;
      b.addEventListener('click',()=>{_wbFilter=t.k;renderYanyuCore(c);});
      wbWrap.appendChild(b);
    });
    c.appendChild(wbWrap);
    let shownAny=false;
    YANYU_ALL_GROUPS.forEach(g=>{
      if(wbCur!=='all' && g.key!==wbCur)return;
      const items=mergeData(g.key,g.builtin(),state.customData[g.key]).filter(p=>_wbMatch(g,p,q));
      if(!items.length)return;
      shownAny=true;
      const card=el('div','card');
      const unit=g.kind==='pair'?'对':'条';
      card.innerHTML=`<div class="section-title"><span class="dot"></span>${g.name}（命中${items.length}${unit}）</div>`;
      const body=makeCardFoldable(card,'yanyu:'+g.key+':s');
      items.forEach((p,i)=>{
        const titleHtml=(g.kind==='pair'
          ? `<span class="ip-words">`+_pairWords(p).map(w=>yiWordTagHL(w,p.example,q)).join('')+`</span>`
          : yiWordTagHL(p.word,p.example,q));
        const badge=stageBadgeHtml(g.key,itemStageKey(g,p));
        const exHtml=`<div class="ex-row ex-badge-only"><span class="ex-right">${badge}</span></div>`;
        const detailHtml=g.kind==='pair'
          ? `<div class="ip-diff">${renderDiffLines(p.diff,q)}</div>${exHtml}`
          : `<div class="wi-meaning"><b class="wi-word">${wbHL(p.word,q)}</b>：${escapeHtml(p.meaning)}</div>${exHtml}`;
        const fi=makeFoldItem('yanyu:'+g.key+':s',i,titleHtml,detailHtml);
        fi.classList.add('open');
        fi.dataset.srcIdx=i;   // 搜索模式下按过滤顺序即可
        body.appendChild(fi);
      });
      bindStageToggle(body);
      c.appendChild(card);
    });
    if(wbCur!=='all' && !shownAny){
      const emptyCard=el('div','card');
      const wbName=(wbTabs.find(t=>t.k===wbCur)||{}).n||'';
      emptyCard.innerHTML='<div class="empty-tip">「'+wbName+'」中没有匹配“'+escapeHtml(q)+'”的词条</div>';
      c.appendChild(emptyCard);
    }
  }else{
    // 词库分组 Tabs：成语/实词分区一次只看一个，避免四个长卡片堆叠
    const curGroup=(_sectionGroup['yanyu']&&groups.some(g=>g.key===_sectionGroup['yanyu']))?_sectionGroup['yanyu']:groups[0].key;
    const curG=groups.find(g=>g.key===curGroup)||groups[0];
    renderStudyOverview(c,curG?[curG]:groups,curG?curG.name:'');
    const gTabs=renderSectionGroupTabs('yanyu',groups);
    if(gTabs)c.appendChild(gTabs);
    groups.filter(g=>g.key===curGroup).forEach(g=>{
      const items=mergeData(g.key,g.builtin(),state.customData[g.key]);
      const card=el('div','card');
      // 排序后渲染：学习中 → 未学 → 已掌握；同状态按词条添加顺序
      const shown=sortByStage(g,items);
      const titleTxt=g.name;
      card.innerHTML=`<div class="section-title"><span class="dot"></span>${titleTxt}</div>`;
      const body=makeCardFoldable(card,'yanyu:'+g.key);
      if(!shown.length){
        const tip=el('div','empty-tip');
        tip.textContent=items.length?'该状态下暂无内容':'暂无内容，可在右上角「管理内容」添加';
        body.appendChild(tip);
        c.appendChild(card);
        return;
      }
      shown.forEach((p,i)=>{
        const ik=itemStageKey(g,p);
        const titleHtml=(g.kind==='pair'
          ? `<span class="ip-words">`+_pairWords(p).map(w=>yiWordTag(w,p.example)).join('')+`</span>`
          : yiWordTag(p.word,p.example));
        const badge=stageBadgeHtml(g.key,ik);
        const exHtml=`<div class="ex-row ex-badge-only"><span class="ex-right">${badge}</span></div>`;
        const detailHtml=g.kind==='pair'
          ? `<div class="ip-diff">${renderDiffLines(p.diff,q)}</div>${exHtml}`
          : `<div class="wi-meaning"><b class="wi-word">${wbHL(p.word,q)}</b>：${escapeHtml(p.meaning)}</div>${exHtml}`;
        const fi=makeFoldItem('yanyu:'+g.key,i,titleHtml,detailHtml);
        fi.dataset.srcIdx=items.indexOf(p);   // 记录添加顺序，供点状态后重排使用
        body.appendChild(fi);
      });
      bindStageToggle(body);
      c.appendChild(card);
    });
  }
  if(bar){
    c.insertBefore(bar,c.firstChild);
    if(hadFocus)bar.querySelector('.ms-input').focus();
  }
  // 清空搜索（q 为空）时恢复「本模块待办」卡片；搜索中保持隐藏（用户设定）
  if(!q)restoreYanyuTodo(c,bar);
}
/* ============================================================
   学习模式：翻转卡自测
   一次一个词 → 先看词名自己想 → 点「看答案」→ 自评 不会/模糊/会了
   自评直接写回 learnStage 并排好下次复习时间
   ============================================================ */
let _study=null;   // {list:[{ck,ik}], idx, flipped, title}
function yanyuProgress(){
  let total=0,mst=0;
  YANYU_ALL_GROUPS.forEach(g=>{
    const items=mergeData(g.key,g.builtin(),state.customData[g.key]);
    items.forEach(p=>{total++;if(getStage(g.key,itemStageKey(g,p))==='mastered')mst++;});
  });
  return {total:total,mst:mst,pct:total?Math.round(mst/total*100):0};
}
/* 取一批待学条目：当前分区里「未学 + 学习中」的（已掌握的只在复习队列里出现） */
function studyListOfGroups(groups){
  const out=[];
  (groups||[]).forEach(g=>{
    const items=mergeData(g.key,g.builtin(),state.customData[g.key]);
    items.forEach(p=>{
      const ik=itemStageKey(g,p);
      const s=getStage(g.key,ik);
      if(s!=='mastered')out.push({ck:g.key,ik:ik});
    });
  });
  return out;
}
function openStudy(list,title){
  if(!list||!list.length){toast('没有可学的内容');return;}
  _study={list:list,idx:0,flipped:false,title:title||'学习'};
  _paintStudy();
}
function closeStudy(){
  _study=null;
  const l=document.querySelector('.study-layer');
  if(l)l.remove();
  render();
}
function _paintStudy(){
  let layer=document.querySelector('.study-layer');
  if(!layer){
    layer=el('div','study-layer');
    document.body.appendChild(layer);
  }
  if(!_study){layer.remove();return;}
  const S=_study;
  // 学完了
  if(S.idx>=S.list.length){
    layer.innerHTML=`<div class="sl-wrap">
      <div class="sl-done">
        <div class="sl-done-ico">${icon('check')}</div>
        <div class="sl-done-t">这一轮学完了</div>
        <div class="sl-done-s">共 ${S.list.length} 条，已按你的掌握情况排好下次复习时间</div>
        <button class="btn btn-primary sl-finish">完成</button>
      </div></div>`;
    layer.querySelector('.sl-finish').addEventListener('click',closeStudy);
    return;
  }
  const cur=S.list[S.idx];
  const hit=findItemByKey(cur.ck,cur.ik);
  if(!hit){S.idx++;return _paintStudy();}   // 条目已被删除，跳过
  const g=hit.g,p=hit.item;
  const qHtml=g.kind==='pair'
    ? _pairWords(p).map(w=>`<span>${escapeHtml(w)}</span>`).join('<span class="sl-vs">VS</span>')
    : escapeHtml(p.word);
  const aHtml=g.kind==='pair'
    ? `<div class="sl-def">${escapeHtml(p.diff).split('；').join('<br>')}</div><div class="sl-ex">${escapeHtml(p.example)}</div>`
    : `<div class="sl-def">${escapeHtml(p.meaning)}</div><div class="sl-ex">${escapeHtml(p.example)}</div>`;
  const pct=Math.round(S.idx/S.list.length*100);
  layer.innerHTML=`<div class="sl-wrap">
    <div class="sl-head">
      <button class="sl-close" aria-label="退出">${icon('close')}</button>
      <div class="sl-bar"><div class="sl-bar-fill" style="width:${pct}%"></div></div>
      <div class="sl-meta"><span class="sl-grp">${escapeHtml(S.title||g.name)}</span><span class="sl-cnt">${S.idx+1} / ${S.list.length}</span></div>
    </div>
    <div class="sl-body">
      <div class="sl-card">
        <div class="sl-q">${qHtml}</div>
        <div class="sl-a" style="display:${S.flipped?'block':'none'}">${aHtml}</div>
      </div>
      <div class="sl-hint">${S.flipped?'你答对了吗？选一个，自动安排下次复习':'先自己想一下释义，再点「看答案」'}</div>
    </div>
    <div class="sl-foot">
      ${S.flipped
        ? `<button class="sl-btn sl-again">不会</button><button class="sl-btn sl-hard">模糊</button><button class="sl-btn sl-good">会了</button>`
        : `<button class="sl-btn sl-show">看答案</button>`}
    </div>
  </div>`;
  layer.querySelector('.sl-close').addEventListener('click',closeStudy);
  if(S.flipped){
    layer.querySelector('.sl-again').addEventListener('click',()=>{rateItem(cur.ck,cur.ik,'again');S.idx++;S.flipped=false;_paintStudy();});
    layer.querySelector('.sl-hard').addEventListener('click',()=>{rateItem(cur.ck,cur.ik,'hard');S.idx++;S.flipped=false;_paintStudy();});
    layer.querySelector('.sl-good').addEventListener('click',()=>{rateItem(cur.ck,cur.ik,'good');S.idx++;S.flipped=false;_paintStudy();});
  }else{
    layer.querySelector('.sl-show').addEventListener('click',()=>{S.flipped=true;_paintStudy();});
  }
}
/* 模块页顶部的「学习概览」：掌握进度 + 两个入口（学新内容 / 复习到期的） */
function renderStudyOverview(c,groups,groupName){
  const pg=yanyuProgress();
  const due=dueReviewList();
  const fresh=studyListOfGroups(groups);   // 当前分区里还没掌握的
  const card=el('div','card study-overview');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>学习进度</div>
    <div class="so-bar"><div class="so-fill" style="width:${pg.pct}%"></div></div>
    <div class="so-txt">已掌握 <b>${pg.mst}</b> / ${pg.total} 条（${pg.pct}%）</div>
    <div class="so-row">
      <button class="btn btn-primary so-learn">${icon('play')} 学「${escapeHtml(groupName||'本区')}」${fresh.length?`（${fresh.length} 条未掌握）`:'（已全部掌握）'}</button>
      <button class="btn btn-ghost so-due${due.length?' has':''}">${icon('repeat')} 今日待复习 ${due.length} 条</button>
    </div>`;
  card.querySelector('.so-learn').addEventListener('click',()=>{
    if(!fresh.length){toast('这个分区已全部掌握，去复习巩固吧');return;}
    openStudy(fresh,(groupName||'本区')+' · 未掌握');
  });
  card.querySelector('.so-due').addEventListener('click',()=>{
    if(!due.length){toast('今天没有到期要复习的内容');return;}
    openStudy(due.slice(),'今日待复习');
  });
  c.appendChild(card);
}
function _wbMatch(g,p,q){
  const ql=q.toLowerCase();
  /* 只匹配词名：搜「一」时释义/例句里含「一」的词条不命中（如例句里的"一言不发"），
     词名含「一」的才显示（如"网之一孔"）。避免单字搜索命中面爆炸。 */
  const txt=(g.kind==='pair'
    ? _pairWords(p).join(' ')
    : p.word
  ).toLowerCase();
  return txt.indexOf(ql)>=0;
}

/* 判断推理笔记 · 结构化渲染：分区标题(说明同行) / -要点 / eg(短行内紫·长行拆行) */
function formatLuojiNote(content){
  const lines=(content||'').split('\n').map(l=>l.trim());
  const split=[];
  lines.forEach(l=>{
    const m=l.match(/(^|[^a-zA-Z])(eg\s*[:：]?\s*)(.*)$/i);
    if(m&&m[3]){
      const pre=(l.slice(0,m.index)+(m[1]||'')).trim();
      if(pre)split.push(pre);
      split.push('eg：'+m[3]);
    }else split.push(l);
  });
  let html='<div class="ln-note">';
  for(let i=0;i<split.length;i++){
    const line=split[i];
    if(!line)continue;
    const sec=line.match(/^[（(]\s*([一二三四五六七八九十]+)\s*[)）](.*)$/);
    if(sec){
      const num='('+sec[1]+')';
      const title=sec[2]||'';
      let desc='';
      let j=i+1;
      while(j<split.length&&split[j]&&!split[j].match(/^[（(]\s*[一二三四五六七八九十]+\s*[)）]/)&&!split[j].match(/^[-·]/)&&!split[j].match(/^eg[:：]/i)){
        desc+=(desc?' ':'')+split[j];
        j++;
      }
      html+=`<div class="ln-sec"><span class="ln-sec-num">${num}</span><span class="ln-sec-title">${escapeHtml(title)}</span>${desc?`<span class="ln-sec-desc">${escapeHtml(desc)}</span>`:''}</div>`;
      i=j-1;
      continue;
    }
    if(/^eg\s*[:：]?/i.test(line)){
      const eg=line.replace(/^eg[:：]\s*/i,'');
      html+=eg.length>=16?`<div class="ln-eg-line">eg：${escapeHtml(eg)}</div>`:`<div class="ln-eg-inline">eg：${escapeHtml(eg)}</div>`;
      continue;
    }
    if(/^[-·]\s*/.test(line)){
      html+=`<div class="ln-li">- ${escapeHtml(line.replace(/^[-·]\s*/,''))}</div>`;
      continue;
    }
    html+=`<div class="ln-txt">${escapeHtml(line)}</div>`;
  }
  html+='</div>';
  return html;
}

function renderLuoji(c){
  // 判断推理：4 个子分类 tabs（图形推理/定义判断/类比推理/逻辑判断），笔记存 customData.luojiNotes
  const tabs=renderSectionTabs('luoji');
  if(tabs)c.appendChild(tabs);
  const tab=getSectionTab('luoji');
  const allNotes=Array.isArray(state.customData.luojiNotes)?state.customData.luojiNotes:[];
  const notes=tab==='all'?allNotes:allNotes.filter(n=>n&&n.sub===tab);
  if(notes.length===0){
    const empty=el('div','card');
    empty.innerHTML=`<div class="empty-tip">${tab==='all'?'暂无笔记，点右上角「管理内容」添加':'「'+tab+'」分类暂无笔记，点右上角「管理内容」添加'}</div>`;
    c.appendChild(empty);
  }else{
    const card=el('div','card');
    card.innerHTML=`<div class="section-title"><span class="dot"></span>判断推理笔记（${notes.length}条）</div>`;
    const body=makeCardFoldable(card,'luoji:notes');
    // 每条默认只露标题一行，点开才看内容 + 编辑/删除；同区一次只展开一条
    notes.forEach((n,i)=>{
      const idx=allNotes.indexOf(n);
      const titleHtml=`<span class="ln-title">${escapeHtml(n.title||n.sub||'笔记')}</span>`
        +(n.sub?`<span class="ln-tag">${escapeHtml(n.sub)}</span>`:'');
      const detailHtml=`<div class="ln-body-wrap">${formatLuojiNote(n.content||'')}</div>`;
      body.appendChild(makeFoldItem('luoji:'+tab,i,titleHtml,detailHtml,()=>{}));
    });
    c.appendChild(card);
  }
}
/* ============================================================
   数量关系：每日1题型公式+例题
   ============================================================ */
function renderShuliang(c){
  const tabs=renderSectionTabs('shuliang');
  if(tabs)c.appendChild(tabs);
  const tab=getSectionTab('shuliang');
  const allQuant=mergeData('quant',QUANT_TOPICS,state.customData.quant);
  // 数量关系题型name就是子分类名
  const filteredQuant=tab==='all'?allQuant:allQuant.filter(t=>t.name===tab);
  if(filteredQuant.length===0){
    const empty=el('div','card');
    empty.innerHTML=`<div class="empty-tip">「${tab}」分类暂无内容</div>`;
    c.appendChild(empty);
    return;
  }
  const topic=filteredQuant[dayIndex(filteredQuant.length)];
  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>今日题型：${topic.name}</div>
    <div class="muted" style="margin-bottom:12px;">每日轮换一个高频题型（共${allQuant.length}种）</div>`;
  const fc=el('div','formula-card');
  fc.innerHTML=`<div class="fc-name">${icon('ruler')} 核心公式</div>`;
  if(topic.sections){
    topic.sections.forEach(sec=>{
      const st=el('div','fc-section');
      st.innerHTML=`<div class="fc-section-title">${sec.title}</div>`;
      const ul=el('div','fc-section-items');
      sec.items.forEach(f=>{const it=el('div','fc-item');it.innerHTML='- '+annot(f);ul.appendChild(it);});
      st.appendChild(ul);
      if(sec.tip){const eg=el('div','fc-eg');eg.innerHTML='注：'+annot(sec.tip);st.appendChild(eg);}
      fc.appendChild(st);
    });
  } else {
    const list=el('div','fc-list');
    topic.formulas.forEach(f=>{const item=el('div','fc-item');item.innerHTML=annot(f);list.appendChild(item);});
    fc.appendChild(list);
  }
  card.appendChild(fc);
  c.appendChild(card);
}

/* ============================================================
   资料分析：公式板块 + 每日检验题
   ============================================================ */
function renderZiliao(c){
  const all=mergeData('dataFormulas',DATA_FORMULAS,state.customData.dataFormulas);
  const catOrder=['基期','现期','增长率','增量','两期'];
  const groups={};
  all.forEach(f=>{const k=(f.cat&&f.cat.trim())||'其他';(groups[k]=groups[k]||[]).push(f);});
  // [[分子|分母]] → 上下结构分数
  const frac=s=>s.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g,'<span class="frac"><span class="num">$1</span><span class="den">$2</span></span>');
    const strFrac=s=>s.replace(/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/g,(m,a,b)=>frac('[['+a+'|'+b+']]'));
  const eqCell=s=>{const i=s.indexOf('=');if(i<0)return strFrac(s);return `<span class="eqrow"><span class="l">${strFrac(s.slice(0,i).trim())}</span><span class="op">=</span><span class="r">${strFrac(s.slice(i+1).trim())}</span></span>`;};

  const wrap=el('div','page-tabs');
  wrap.innerHTML=`<button class="page-tab active" data-k="formula">核心公式</button><button class="page-tab" data-k="bhf">百化分</button><button class="page-tab" data-k="pf">平方·立方</button>`;
  c.appendChild(wrap);
  const box=el('div');
  c.appendChild(box);

  function renderFormula(){
    box.replaceChildren();
    const card=el('div','card');
    card.innerHTML=`<div class="section-title"><span class="dot"></span>资料分析核心公式</div>
      <div class="muted" style="margin-bottom:10px;">按板块分组，先记公式再刷题。</div>
      <div id="fzBody"></div>`;
    box.appendChild(card);
    const body=document.getElementById('fzBody');
    const order=catOrder.concat(Object.keys(groups).filter(k=>catOrder.indexOf(k)<0));
    let html='';
    order.forEach(k=>{
      const arr=groups[k];if(!arr||!arr.length)return;
      html+=`<div class="fz-section"><div class="fz-sec-title">${escapeHtml(k)}</div>`;
      arr.forEach(f=>{
        /* 兼容早期手动录入的旧数据：没有 formula 字段时回退到 formulas 数组 */
        /* 兼容早期手动录入的旧数据：没有 formula 字段时回退到 formulas 数组；斜杠「分子/分母」自动转分式 */
        const fml=f.formula||(Array.isArray(f.formulas)?f.formulas.join('\n'):'')||'';
        html+=`<div class="fz-item"><span class="fz-name">${escapeHtml(f.name)}${f.remark?`<span class="fz-remark">${annot(f.remark)}</span>`:''}</span><span class="fz-formula">${frac(fracFromSlash(escapeHtml(fml))).replace(/\n/g,'<br>')}</span></div>`;
      });
      html+=`</div>`;
    });
    body.innerHTML=html;
  }

  function renderBhf(){
    box.replaceChildren();
    const bCard=el('div','card');
    bCard.innerHTML=`<div class="section-title"><span class="dot"></span>百分数（百化分）速记</div>`;
    box.appendChild(bCard);
    // 分组口诀
    const groupsEl=el('div','bhf-groups');
    DATA_BAIHUAFEN.forEach(g=>{
      const gp=el('div','bhf-group');
      gp.innerHTML=`<div class="bhf-tip">${escapeHtml(g.tip)}</div><div class="bhf-chips"></div>`;
      gp.querySelector('.bhf-chips').innerHTML=g.items.map(p=>{
        const f=p[1].split('/');
        return `<span class="bhf-chip">${p[0]} = ${frac('[['+f[0]+'|'+f[1]+']]')}</span>`;
      }).join('');
      groupsEl.appendChild(gp);
    });
    bCard.appendChild(groupsEl);
    // 归纳对照表
    const sumTitle=el('div','fz-sec-title');
    sumTitle.innerText='归纳';
    bCard.appendChild(sumTitle);
    const sum=el('div');
    DATA_BAIHUAFEN_SUM.forEach(row=>{
      const seg=el('div','bhf-seg');
      const r1=el('div','bhf-frow');
      r1.innerHTML=row.map(c=>{
        const f=c[0].split('/');
        return `<div>${frac('[['+f[0]+'|'+f[1]+']]')}</div>`;
      }).join('');
      const r2=el('div','bhf-prow');
      r2.innerHTML=row.map(c=>`<div>${c[1]}</div>`).join('');
      seg.appendChild(r1);
      seg.appendChild(r2);
      sum.appendChild(seg);
    });
    bCard.appendChild(sum);

    // ===== 独立卡片：常用百化分对照表 =====
    const extCard=el('div','card');
    extCard.innerHTML=`<div class="section-title"><span class="dot"></span>常用百化分对照表</div>`;
    box.appendChild(extCard);
    // 三列对照表（四组用颜色区分）
    const tbl=el('table','ext-table');
    tbl.innerHTML=`<thead><tr><th>百分数 → 分数</th><th>分组</th><th>分数 → 百分数</th></tr></thead><tbody>${DATA_BAIHUAFEN_EXT.map((g,gi)=>`<tr class="gc${gi+1}"><td class="eqcell">${eqCell(g.l[0])}</td><td rowspan="3" class="gname">${g.g}</td><td class="eqcell">${eqCell(g.r[0])}</td></tr><tr class="gc${gi+1}"><td class="eqcell">${eqCell(g.l[1])}</td><td class="eqcell">${eqCell(g.r[1])}</td></tr><tr class="gc${gi+1}"><td class="eqcell">${eqCell(g.l[2])}</td><td class="eqcell">${eqCell(g.r[2])}</td></tr>`).join('')}<tr class="tail-row">${DATA_BAIHUAFEN_TAIL.map(x=>`<td>${strFrac(x)}</td>`).join('')}</tr></tbody>`;
    extCard.appendChild(tbl);
    // 特殊近似
    const exTitle=el('div','fz-sec-title');
    exTitle.innerText='特殊近似';
    extCard.appendChild(exTitle);
    const ex=el('div','ext-extra');
    ex.innerHTML=DATA_BAIHUAFEN_EXTRA.map(x=>`<span>${strFrac(x)}</span>`).join('');
    extCard.appendChild(ex);
  }

  function renderPf(){
    box.replaceChildren();
    const pCard=el('div','card');
    pCard.innerHTML=`<div class="section-title"><span class="dot"></span>平方 · 立方数</div>`;
    box.appendChild(pCard);
    // 11~19
    const t1=el('div','fz-sec-title');
    t1.innerText='11~19 平方';
    pCard.appendChild(t1);
    const grid=el('div','pf-grid');
    grid.innerHTML=DATA_PINGFANG.map(p=>`<div class="pf-cell"><span class="pf-n">${p[0]}²</span><span class="pf-eq">=</span><span class="pf-v">${p[1]}</span></div>`).join('');
    pCard.appendChild(grid);
    // 21~29 对称
    const t2=el('div','fz-sec-title');
    t2.innerText='21~29 平方对称记忆';
    pCard.appendChild(t2);
    const sym=el('div','pf-sym');
    DATA_PINGFANG_SYM.forEach(row=>{
      const r=el('div','pf-sym-row');
      if(row[1]){
        r.innerHTML=`<span class="pf-sym-val">${row[0]}</span><span class="pf-sym-step">→ ${row[1]} →</span><span class="pf-sym-val">${row[2]}</span>`;
      } else {
        r.innerHTML=`<span class="pf-sym-val">${row[0]}</span><span class="pf-sym-step" style="color:var(--text-light);">（中间）</span>`;
      }
      sym.appendChild(r);
    });
    pCard.appendChild(sym);
    // 立方数近似
    const t3=el('div','fz-sec-title');
    t3.innerText='立方数近似（年均增长率估算）';
    pCard.appendChild(t3);
    const tbl=el('table','lf-table');
    tbl.innerHTML=`<tbody>${DATA_LIFANG.map(row=>`<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td><td>${row[3]}</td></tr>`).join('')}</tbody>`;
    pCard.appendChild(tbl);
  }

  renderFormula();
  wrap.querySelectorAll('.page-tab').forEach(b=>b.addEventListener('click',()=>{
    wrap.querySelectorAll('.page-tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const k=b.dataset.k;
    if(k==='bhf')renderBhf();
    else if(k==='pf')renderPf();
    else renderFormula();
  }));
}

/* 把 dailyStats[sec] 的离散 records 重算成汇总（count/rate/subs）。
   records 才是真相，count/rate/subs 只是派生视图，保证今日汇总与查看详情永远对得上，不再有「融合值」。 */
function recomputeDailyStat(sec,d){
  const rec=state.dailyStats[d]&&state.dailyStats[d][sec];
  if(!rec)return;
  const recs=rec.records||[];
  let sc=0,sw=0,has=false;
  recs.forEach(r=>{const c=r.count||0;if(c>0){sc+=c;if(r.rate!=null){sw+=c*r.rate;has=true;}}});
  rec.count=sc;
  rec.rate=has?Math.round(sw/sc):(sc>0?null:0);
  const subs={};
  recs.forEach(r=>{ if(r.sub){ const s=subs[r.sub]||{c:0,sw:0,has:false}; s.c+=(r.count||0); if(r.rate!=null){s.sw+=(r.count||0)*r.rate;s.has=true;} subs[r.sub]=s; } });
  rec.subs={};
  Object.keys(subs).forEach(n=>{const s=subs[n];if(s.c>0)rec.subs[n]={count:s.c,rate:s.has?Math.round(s.sw/s.c):null};});
  if(!Object.keys(rec.subs).length)delete rec.subs;
}
/* 老数据（只有 count/rate/subs，没有 records）首次交互时，反推成一条 records，避免丢失 */
function seedRecordsIfLegacy(rec){
  if(!rec||rec.records)return rec;
  rec.records=[];
  if(rec.subs&&Object.keys(rec.subs).length){
    Object.keys(rec.subs).forEach(n=>rec.records.push({sub:n,count:rec.subs[n].count||0,rate:rec.subs[n].rate==null?null:rec.subs[n].rate}));
  } else if(rec.count>0){
    rec.records.push({sub:null,count:rec.count||0,rate:rec.rate==null?null:rec.rate});
  }
  if(!rec.records.length)rec.records=[];
  return rec;
}
function openTaskReport(task,mode,todoId,entry,editIdx){
  const t=(typeof task==='string')?(state.dailyTasks||[]).find(x=>x.id===task):task;
  if(!t)return;
  /* 练习册入口带来的 {id,n}。挂在 task 对象上，弹窗内切「追加/覆盖」、点「改」重新打开自己时也不丢 */
  const _bk=(t&&t.__bk)||null;
  /* 录入口径：add = 本次追加到今日已有（默认，分批做不用自己算总数）；set = 覆盖成填写值 */
  const dsMode=(mode==='set')?'set':'add';
  // 从「勾选任务」进来的录入：保存成功后才把该任务标记完成（取消则任务保持未做、仍在列表）
  const _completeTodoId=(todoId&&typeof todoId==='string')?todoId:null;
  const d=todayStr();
  if(!state.dailyStats[d])state.dailyStats[d]={};
  const stat=state.dailyStats[d][t.sec]||{count:0,rate:0,subs:{}};
  // 编辑模式：editIdx 指向某条真实 records，点「改」进来时预填并原地替换该条
  const editing=(typeof editIdx==='number' && stat.records && stat.records[editIdx]);
  const editRec=editing?stat.records[editIdx]:null;
  /* 待办题量锁定：从「关联同模块且填了题量」的待办进入时，本次录入题量锁死为待办题量（子模块待办锁「本次题量」，整体待办锁「整体题量」）；编辑已有记录不锁 */
  let _lockCount=0;
  if(_completeTodoId&&!editing){
    const _td=(state.todos||[]).find(x=>x.id===_completeTodoId);
    // 重复任务今天已打勾完成（靠 lastDone 推进、done 恒为 false）不能再锁，否则录完静默无反馈
    if(_td&&_td.count>0&&_td.section===t.sec&&(!t.sub||_td.sub===t.sub)&&!(isRepeat(_td)&&_td.lastDone===todayStr()))_lockCount=_td.count;
  }
  const title=(t.sub?subName(t.sub):SECTION_MAP[t.sec].name);
  const isSplit=!t.sub && splitSubEntries(t.sec).length>0;
  const sv=(stat.subs&&stat.subs[t.sub])||{count:0,rate:0};
  /* 关联待办题量预填：任务关联了子模块/大类并设了题量时，录成绩自动带入（可改，不锁定）。
     收集规则：同 sec、未 done、非「重复任务今天已打勾」的待办；子模块待办按 subName 存（待办 sub 是「言语_逻辑填空」，
     拆分行 key 是「逻辑填空」，统一用 subName 桥接），整体待办存 __overall__。 */
  const _todoCountByName={};
  (state.todos||[]).forEach(_p=>{
    if(_p.section===t.sec && _p.count>0 && !_p.done && !(isRepeat(_p)&&_p.lastDone===todayStr())){
      if(_p.sub){const _nm=subName(_p.sub);if(_nm)_todoCountByName[_nm]=_p.count;}
      else if(_todoCountByName['__overall__']==null)_todoCountByName['__overall__']=_p.count;
    }
  });
  /* 预填取值：仅「本次追加」且今天该子模块还没录过才预填待办量，避免追加模式被重复累加成双倍；
     覆盖模式保留已存值（由调用处兜底）；从任务勾选完成进来的 _lockCount 仍优先锁定，此处不影响。 */
  const _todoPrefill=(subKey, recordedCnt)=>{
    if(!isAdd)return '';
    if(recordedCnt>0)return '';
    const _nm=subKey?subName(subKey):'__overall__';
    const _tc=subKey?(_todoCountByName[_nm]||0):(_todoCountByName['__overall__']||0);
    return _tc>0?_tc:'';
  };
  // 不同分类记的单位不一样：刷题记题、申论记篇、套卷记套、晨读记次；申论和晨读不记正确率
  const dsUnit=(CHECKIN_UNIT&&CHECKIN_UNIT[t.sec])||'题';
  // 时长预填：仅当本次录入来自「刚结束的番茄钟」（pendingPomoSessId 命中本次模块）才预填该次时长；
  // 手动录入（勾选任务）一律留空，让用户填「本次」时长——避免把当天累计时长误当成本次，造成「填 8 还是 27」的困惑
  let pomoMin = editing ? (editRec.min||null) : null;
  if(!editing && pendingPomoSessId && state.studyRecords[d] && state.studyRecords[d].sessions){
    const _ps=state.studyRecords[d].sessions.find(s=>s.id===pendingPomoSessId && s.section===t.sec);
    if(_ps)pomoMin=Math.round(_ps.duration);
  }
  const dsUnitLabel=({题:'题量',篇:'篇数',套:'套数',次:'次数'})[dsUnit]||'题量';
  const dsNeedRate=!(CHECKIN_HAS_RATE&&CHECKIN_HAS_RATE[t.sec]===0);
  // 子模块已有的整体汇总（用于初始化上方只读值）
  const aggSubs=(subs,fallback)=>{
    let sc=0,sw=0,has=false;
    Object.keys(subs||{}).forEach(n=>{const s=subs[n];const c=s.count||0;const r=s.rate||0;if(c>0){sc+=c;sw+=c*r;has=true;}});
    if(has)return {count:sc,rate:Math.round(sw/sc)};
    if(fallback&&fallback.count>0)return {count:fallback.count,rate:fallback.rate||0};
    return {count:0,rate:0};
  };
  const subInit=isSplit?aggSubs(stat.subs,stat):{count:0,rate:0};
  const hasSubData=isSplit && subInit.count>0;
  // 今日已录的离散记录（查看详情用）：优先用 records；老数据（只有 count/rate/subs）反推成展示用数组（不改动 stat）
  const _realRecs=(stat.records&&stat.records.length)?stat.records:null;
  const _recs=_realRecs?_realRecs:(function(){
    const arr=[];
    if(stat.subs&&Object.keys(stat.subs).length){Object.keys(stat.subs).forEach(n=>arr.push({sub:n,count:stat.subs[n].count||0,rate:stat.subs[n].rate==null?null:stat.subs[n].rate}));}
    else if(stat.count>0){arr.push({sub:null,count:stat.count||0,rate:stat.rate==null?null:stat.rate});}
    return arr;
  })();
  const _canEdit=!!_realRecs;
  // 今日该模块总时长（与「今日汇总」口径一致：番茄钟 focus + 打卡录入手填，去重后）
  const _durMap=(typeof daySectionMin==='function')?daySectionMin(d):{};
  const _dur=Math.round(_durMap[t.sec]||0);
  // 默认是否直接进录入：番茄钟刚结束 → 直接录；否则默认「查看」页（先看清今日总量，再决定要不要加）
  const forceEntry=(entry===true)||(pomoMin!=null);
  // —— 查看区：今日总量 + 每次记录列表 + 「本次追加」入口 ——
  const recHtml=_recs&&_recs.length?(
    '<div class="rep-records"><div class="rep-records-head">每次记录（共 <b>'+_recs.length+'</b> 条）</div>'
    +_recs.map(function(r,i){
        const nm=r.sub?escapeHtml(subName(r.sub)||r.sub):(isSplit?'整体':SECTION_MAP[t.sec].name);
        const minTxt=(r.min&&r.min>0)?('<span class="rr-min">'+r.min+'分</span>'):'';
        const editBtn=_canEdit?('<button type="button" class="rep-rec-edit" data-ri="'+i+'">改</button>'):'';
        const delBtn=_canEdit?('<button type="button" class="rep-rec-del" data-ri="'+i+'">删</button>'):'';
        return '<div class="rep-record-row"><span class="rr-name">'+nm+'</span><span class="rr-cnt">'+r.count+' '+dsUnit+'</span>'
          +(dsNeedRate?'<span class="rr-rate">'+((r.rate!=null)?(r.rate+'%'):'—')+'</span>':'')
          +minTxt
          +editBtn+delBtn+'</div>';
      }).join('')
    +'</div>'):'';
  const prev=t.sub?sv:stat;
  const prevCount=prev.count||0, prevRate=prev.rate||0;
  const hasOld = prevCount>0 || (isSplit&&subInit.count>0);
  const ttRate=(dsNeedRate&&stat.count>0&&stat.rate!=null)?Math.round(stat.rate)+'%':(dsNeedRate?'—':'');
  const _showBatchToggle=(!isSplit && !editing);
  const viewHtml=`
    ${_showBatchToggle?`<div class="rep-batch-toggle" id="repBatchToggleBar"><label class="switch"><input type="checkbox" id="batchToggle"><span class="slider"></span></label><span class="rep-batch-toggle-txt">分批次录入（同题目多笔，如 10+5+5）</span></div>`:''}
    <div class="rep-view" id="repView">
      <div class="rep-summary">
        <div class="rep-sum-item"><span class="rep-sum-k">今日${dsUnitLabel}</span><span class="rep-sum-v">${stat.count||0}</span></div>
        ${dsNeedRate?`<div class="rep-sum-item"><span class="rep-sum-k">正确率</span><span class="rep-sum-v">${ttRate}</span></div>`:''}
        <div class="rep-sum-item"><span class="rep-sum-k">学习时长</span><span class="rep-sum-v">${_dur}<small>分</small></span></div>
      </div>
      ${recHtml||'<div class="rep-empty">今天还没有记录，点下面「本次追加」录入</div>'}
      <div class="rep-view-btns">
        <button type="button" class="btn" id="repAddBtn" style="min-height:46px;font-size:15px;">本次追加</button>
        ${hasOld?`<button type="button" class="btn btn-ghost" id="repCoverBtn" style="min-height:46px;font-size:15px;">覆盖录入</button>`:''}
      </div>
    </div>`;
  const isAdd=(dsMode==='add');
  const cntPh=(isAdd&&prevCount>0)?('已录'+prevCount+'，填本次'):'0';
  const ratePh=(isAdd&&prevCount>0&&prevRate)?('已录'+Math.round(prevRate)+'%，填本次'):'70 或 14/20';
  /* 追加模式下把「本次」加到今日已有上：题量相加、正确率按题量加权；覆盖模式直接用本次值 */
  const mergeAdd=(p,c,r)=>{
    p=p||{count:0,rate:0};
    const pc=p.count||0;
    if(!isAdd||pc<=0)return {count:c,rate:r};
    if(c<=0)return {count:pc,rate:(p.rate||0)};
    const nc=pc+c;
    const nr=(r==null)?(p.rate||0):Math.round((pc*(p.rate||0)+c*r)/nc);
    return {count:nc,rate:nr};
  };
  const rateChips=[60,70,75,80,85,90,100];
  // 大号双栏 hero：拆分模块标「整体」+自动徽标；否则标「题量/正确率」
  const hero=(count,rate,overall)=>`
    <div class="rep-hero${overall?' rep-overall':''}">
      <div class="rep-hero-head">
        <span class="rep-hero-title">${isAdd?'本次成绩（保存后作为一条新记录）':'本次成绩'}</span>
        ${_lockCount>0?`<span class="rep-hero-tag">待办 ${_lockCount} 题锁定</span>`:(overall?'<span class="rep-hero-tag">手填为准</span>':'')}
      </div>
      <div class="rep-hero-grid${isSplit?' two':''}">
        <div class="rep-field">
          <label class="rep-label">${overall?'整体'+dsUnitLabel:(isAdd?'本次'+dsUnitLabel:dsUnitLabel)}${dsNeedRate?'<i class="req">*</i>':''}</label>
          <div class="rep-input"><input type="number" id="dsCount" class="field rep-num" min="0" inputmode="numeric" placeholder="${cntPh}" value="${_lockCount>0?_lockCount:(count||'')}"${_lockCount>0?' readonly':''}><span class="rep-suffix">${dsUnit}</span></div>
        </div>
        ${dsNeedRate?`<div class="rep-field">
          <label class="rep-label">${overall?'整体正确率':(isAdd?'本次正确率':'正确率')}<i class="req">*</i></label>
          <div class="rep-input"><input type="text" id="dsRate" class="field rep-num" inputmode="text" placeholder="${overall?'70 或 14/20':ratePh}" value="${rate?Math.round(rate):''}"><span class="rep-suffix" id="dsRateSuffix">%</span></div>
        </div>`:''}
        ${!isSplit?`<div class="rep-field">
          <label class="rep-label">学习时长<i class="req">*</i></label>
          <div class="rep-input"><input type="number" id="dsMinutes" class="field rep-num" min="0" inputmode="numeric" placeholder="0" value="${pomoMin||''}"><span class="rep-suffix">分钟</span></div>
        </div>`:''}
      </div>
    </div>`;
  const chips=dsNeedRate?`<div class="rep-chips-card"><div class="rep-chips" id="rateChips">${rateChips.map(r=>`<button type="button" class="rep-chip" data-r="${r}">${r}%</button>`).join('')}</div></div>`:'';
  const taskCount=(task&&typeof task.count==='number'&&task.count>0)?task.count:0;
  // 追加模式：默认留空让用户填「本次」；但若关联了「同子模块/大类且设了题量」的待办、且今天该子模块还没录过，则自动预填待办题量（可改）
  const svCount = editing?(editRec.count||''):(isAdd?_todoPrefill(t.sub, sv.count):(sv.count||taskCount||''));
  const mainCount = editing?(editRec.count||''):(isAdd?_todoPrefill(null, stat.count):(stat.count||taskCount||''));
  const heroRate = (r,isOverall)=>{
    if(isOverall)return (r>0?Math.round(r):'');
    return editing?(editRec.rate?Math.round(editRec.rate):''):(isAdd?'':(r?Math.round(r):''));
  };
  // —— 分批次录入（同子模块多笔，如 10+5+5）：开关 + 批量行，复用原 rep- 样式 ——
  const _batchRowHtml=(idxb,countVal,rateVal,minVal)=>`<div class="batch-row" data-batch-idx="${idxb}">
      <div class="batch-row-head"><span>第 ${idxb} 笔</span><button type="button" class="batch-del" aria-label="删除本笔">×</button></div>
      <div class="rep-hero-grid${dsNeedRate?'':' two'}">
        <div class="rep-field"><label class="rep-label">本次题量<i class="req">*</i></label><div class="rep-input"><input type="number" class="field rep-num b-count" min="0" inputmode="numeric" placeholder="题量" value="${countVal||''}"><span class="rep-suffix">${dsUnit}</span></div></div>
        ${dsNeedRate?`<div class="rep-field"><label class="rep-label">本次正确率<i class="req">*</i></label><div class="rep-input"><input type="text" class="field rep-num b-rate" inputmode="text" placeholder="70 或 14/20" value="${rateVal||''}"><span class="rep-suffix">%</span></div></div>`:''}
        <div class="rep-field"><label class="rep-label">学习时长<i class="req">*</i></label><div class="rep-input"><input type="number" class="field rep-num b-min" min="0" inputmode="numeric" placeholder="分钟" value="${minVal||''}"><span class="rep-suffix">分钟</span></div></div>
      </div>
    </div>`;
  const _batchInitialRows=()=>{
    if(_lockCount>0) return _batchRowHtml(1,_lockCount,'', pomoMin||'');
    if(t.sub){ const _pf=_todoPrefill(t.sub, sv.count); if(_pf) return _batchRowHtml(1,_pf,'', pomoMin||''); }
    else { const _pf=_todoPrefill(null, stat.count); if(_pf) return _batchRowHtml(1,_pf,'', pomoMin||''); }
    return _batchRowHtml(1,'','', pomoMin||'');
  };
  // 拆分模式：每个子模块的分批录入行（题量 + 正确率 + 学习时长，一笔一行各记各的时长）
  const _splitBatchRowHtml=(idx,key,countVal,rateVal,minVal)=>`<div class="sub-batch-row">
      <div class="batch-row-head"><span>第 ${idx} 笔</span></div>
      <div class="rep-hero-grid${dsNeedRate?'':' two'}">
        <div class="rep-field"><label class="rep-label">本次题量<i class="req">*</i></label><div class="rep-input"><input type="number" class="field rep-num sb-count" data-sub="${escapeHtml(key)}" min="0" inputmode="numeric" placeholder="题量" value="${countVal||''}"><span class="rep-suffix">${dsUnit}</span></div></div>
        ${dsNeedRate?`<div class="rep-field"><label class="rep-label">本次正确率<i class="req">*</i></label><div class="rep-input"><input type="text" class="field rep-num sb-rate" data-sub="${escapeHtml(key)}" inputmode="text" placeholder="70 或 14/20" value="${rateVal||''}"><span class="rep-suffix">%</span></div></div>`:''}
        <div class="rep-field"><label class="rep-label">学习时长<i class="req">*</i></label><div class="rep-input"><input type="number" class="field rep-num sb-min" data-sub="${escapeHtml(key)}" min="0" inputmode="numeric" placeholder="分钟" value="${minVal||''}"><span class="rep-suffix">分钟</span></div></div>
      </div>
    </div>`;
  const _batchWrapHtml=`<div id="batchWrap" style="display:none">
      <div class="rep-batch-hint" id="batchHint">${_lockCount>0?('待办共 '+_lockCount+' 题，各笔合计需 = '+_lockCount+' 题'):('每笔填题量'+(dsNeedRate?'、正确率':'')+'、学习时长；可加多笔，保存即为多条记录')}</div>
      <div id="batchRows">${_batchInitialRows()}</div>
      <button type="button" class="btn btn-ghost rep-batch-add" id="batchAddBtn">+ 再加一笔</button>
      <div class="rep-preview" id="batchPreview" style="margin-top:10px;"></div>
    </div>`;
  let entryBody;
  if(editing){
    // 编辑单条：只改该条的 题量/正确率/时长，sub 保留 editRec.sub（忽略拆分/子模块复杂逻辑）
    entryBody=`<div class="rep-card">${hero(mainCount,heroRate(editRec.rate,false),false)}${chips}</div>`;
  } else if(t.sub){
    entryBody=`<div class="rep-card"><div id="singleWrap">${hero(svCount,heroRate(sv.rate,false),false)}${chips}</div>${_batchWrapHtml}</div>`;
  } else if(!isSplit){
    entryBody=`<div class="rep-card"><div id="singleWrap">${hero(mainCount,heroRate(stat.rate,false),false)}${chips}</div>${_batchWrapHtml}</div>`;
  } else {
    const subList=splitSubEntries(t.sec);
    const subRows=subList.map(s=>{
      const sub=(stat.subs&&stat.subs[s.key])||{count:0,rate:0};
      const done=(sub.count>0)?`<span class="rep-sub-done">已录${sub.count}</span>`:'';
      const prefill=isAdd?(_todoPrefill(s.key, sub.count)||''):(sub.count||'');
      const single=`<div class="sub-single">
          <div class="rep-cell"><input type="number" class="field ds-sub-count" data-sub="${escapeHtml(s.key)}" min="0" inputmode="numeric" placeholder="${isAdd?'本次':'题量'}" value="${prefill}"><span class="rep-suffix">题</span></div>
          ${dsNeedRate?`<div class="rep-cell"><input type="text" class="field ds-sub-rate" data-sub="${escapeHtml(s.key)}" inputmode="text" placeholder="70 或 14/20" value="${isAdd?'':(sub.rate?Math.round(sub.rate):'')}"><span class="rep-suffix">%</span></div>`:''}
        </div>`;
      const batch=`<div class="sub-batch" data-sub="${escapeHtml(s.key)}" style="display:none">
          <div class="sub-batch-rows">${_splitBatchRowHtml(1,s.key,'','')}</div>
          <button type="button" class="btn btn-ghost sub-batch-add" data-sub="${escapeHtml(s.key)}">+ 该子模块再加一笔</button>
        </div>`;
      return `<div class="rep-sub-row" data-sub="${escapeHtml(s.key)}">
          <div class="rep-sub-row-head"><span class="rep-sub-name">${escapeHtml(s.name)}${done}</span><label class="sub-batch-chip"><input type="checkbox" class="sub-batch-toggle" data-sub="${escapeHtml(s.key)}"><span>分批</span></label></div>
          ${single}
          ${batch}
        </div>`;
    }).join('');
    entryBody=`<div class="rep-card">${hero('', '', true)}`
      + `<div class="rep-subs-card">
          <div class="rep-subs-head"><span class="rep-subs-title">${isAdd?'子模块录入（填本次，保存为一条记录）':'子模块录入'}</span><span class="rep-subs-tip">填写后自动汇总</span></div>
          <div class="rep-sub-rows">${subRows}</div>
          <div class="rep-time-row" id="repTimeRow"><label class="rep-label" id="repTimeLabel">其他学习时长<i class="req">*</i></label><div class="rep-input"><input type="number" id="dsMinutes" class="field rep-num" min="0" inputmode="numeric" placeholder="0" value="${pomoMin||''}"><span class="rep-suffix">分钟</span></div></div>
          <div class="rep-preview" id="repPreview"></div>
        </div>`
      + `</div>`;
  }
  // 录入区顶部模式行：已录过→「今日已录X」+ 切换键（当前追加态显示「覆盖录入」，点它切覆盖）；首次录→提示创建记录；编辑中→提示正在修改该条
  const modeBar = editing ? `
    <div class="rep-modebar">
      <span class="rep-modebar-txt">正在修改该条记录（保存即覆盖原记录）</span>
    </div>` : hasOld ? `
    <div class="rep-modebar">
      <span class="rep-modebar-txt">今日已录 <b>${isSplit?subInit.count:prevCount}</b> ${dsUnit}${dsNeedRate&&!isSplit&&prevRate?(' · <b>'+Math.round(prevRate)+'%</b>'):''}</span>
      <button type="button" class="rep-mode-btn${isAdd?' is-add':''}" id="dsModeBtn">${isAdd?'覆盖录入':'本次追加'}</button>
    </div>` : `
    <div class="rep-modebar">
      <span class="rep-modebar-txt">首次录入，保存后创建今日记录</span>
    </div>`;
  const entryHtml=`<div class="rep-entry" id="repEntry">${modeBar}${entryBody}</div>`;
  openModal('录入 · '+title, viewHtml+entryHtml+`
    <div class="rep-bottom" id="repBottom">
      <button class="btn btn-ghost rep-only-view" onclick="closeModal()">关闭</button>
      <button class="btn btn-ghost rep-only-entry" id="repCancelBtn" style="display:none">取消</button>
      <button class="btn rep-only-entry" id="saveDsBtn" style="display:none">保存</button>
    </div>`,'modal-report');
  // 查看详情里的「删」：删除单条记录（精准修正，不再被迫整段覆盖）
  document.querySelectorAll('.rep-rec-del').forEach(b=>b.addEventListener('click',function(){
    const i=parseInt(b.dataset.ri,10);
    const dd=todayStr();const st=state.dailyStats[dd]&&state.dailyStats[dd][t.sec];
    if(st&&st.records){st.records.splice(i,1);recomputeDailyStat(t.sec,dd);if(!st.records.length)delete state.dailyStats[dd][t.sec];if(Object.keys(state.dailyStats[dd]||{}).length===0)delete state.dailyStats[dd];save();render();openTaskReport(t, dsMode, _completeTodoId);}
  }));
  // 查看详情里的「改」：编辑单条记录（预填回录入框，原地替换该条）
  document.querySelectorAll('.rep-rec-edit').forEach(b=>b.addEventListener('click',function(){
    const i=parseInt(b.dataset.ri,10);
    openTaskReport(t, dsMode, _completeTodoId, true, i);
  }));
  // 视图 / 录入 切换
  const viewEl=document.getElementById('repView');
  const entryEl=document.getElementById('repEntry');
  const btns=document.getElementById('repBottom');
  function showView(){viewEl.style.display='';entryEl.style.display='none';btns.querySelector('.rep-only-view').style.display='';btns.querySelectorAll('.rep-only-entry').forEach(el=>el.style.display='none');}
  function showEntry(){viewEl.style.display='none';entryEl.style.display='';btns.querySelector('.rep-only-view').style.display='none';btns.querySelectorAll('.rep-only-entry').forEach(el=>el.style.display='');const _bt=document.getElementById('batchToggle');if(_bt&&_bt.checked){const sw=document.getElementById('singleWrap');const bw=document.getElementById('batchWrap');if(sw)sw.style.display='none';if(bw)bw.style.display='';const bc=document.querySelector('#batchRows .b-count');if(bc)bc.focus();return;}const fc=document.querySelector('#repEntry .ds-sub-count');if(fc)fc.focus();else{const ce=document.getElementById('dsCount');if(ce&&!ce.readOnly)ce.focus();}}
  const addBtn=document.getElementById('repAddBtn');
  if(addBtn)addBtn.addEventListener('click',showEntry);
  const coverBtn=document.getElementById('repCoverBtn');
  if(coverBtn)coverBtn.addEventListener('click',()=>{openTaskReport(t,'set',_completeTodoId,true);});
  const cancelBtn=document.getElementById('repCancelBtn');
  if(cancelBtn)cancelBtn.addEventListener('click',showView);
  // 分批次录入：开关切换显隐、加行、删行、重新编号（不重建面板，复用原样式）
  const _btEl=document.getElementById('batchToggle');
  if(_btEl){
    const _renum=()=>{const rs=document.querySelectorAll('#batchRows .batch-row');rs.forEach((r,i)=>{const sp=r.querySelector('.batch-row-head span');if(sp)sp.textContent='第 '+(i+1)+' 笔';const dl=r.querySelector('.batch-del');if(dl)dl.style.display=rs.length>1?'':'none';});_batchRecompute();};
    _btEl.addEventListener('change',()=>{const on=_btEl.checked;const sw=document.getElementById('singleWrap');const bw=document.getElementById('batchWrap');if(sw)sw.style.display=on?'none':'';if(bw)bw.style.display=on?'':'none';if(on){if(document.querySelectorAll('#batchRows .batch-row').length===0){const cont=document.getElementById('batchRows');if(cont)cont.insertAdjacentHTML('beforeend',_batchRowHtml(1,(_lockCount>0?_lockCount:''),'', pomoMin||''));_renum();}}else{const _bc=document.getElementById('dsCount');if(_bc&&!_bc.readOnly)_bc.focus();}});
    const _addB=document.getElementById('batchAddBtn');
    if(_addB)_addB.addEventListener('click',()=>{const cont=document.getElementById('batchRows');if(!cont)return;const n=cont.querySelectorAll('.batch-row').length+1;cont.insertAdjacentHTML('beforeend',_batchRowHtml(n,'','', pomoMin||''));_renum();});
    // 事件委托：删除按钮 + 输入监听（处理动态新增行）
    const _batchWrap=document.getElementById('batchWrap');
    if(_batchWrap){
      _batchWrap.addEventListener('click',(e)=>{const btn=e.target.closest('.batch-del');if(!btn)return;const row=btn.closest('.batch-row');if(row)row.remove();_renum();});
      _batchWrap.addEventListener('input',()=>{_batchRecompute();});
    }
    // 分批模式实时汇总
    const _batchRecompute=()=>{
      const prev=document.getElementById('batchPreview');if(!prev)return;
      let sumC=0,sumMin=0,sw=0,has=false;
      document.querySelectorAll('#batchRows .batch-row').forEach(r=>{
        const c=Math.max(0,parseInt(r.querySelector('.b-count').value,10)||0);
        if(c<=0)return;
        const rInp=r.querySelector('.b-rate');
        const rp=dsNeedRate?parseRateInput(rInp?rInp.value:''):null;
        const rt=(rp&&rp.valid)?rp.rate:0;
        const mInp=r.querySelector('.b-min');
        const m=Math.max(0,parseInt(mInp?mInp.value:0,10)||0);
        sumC+=c;sumMin+=m;sw+=c*rt;has=true;
      });
      if(has){
        const avg=dsNeedRate&&sumC>0?Math.round(sw/sumC):null;
        const parts=['已填 '+document.querySelectorAll('#batchRows .batch-row').length+' 笔'];
        parts.push('合计 '+sumC+' '+dsUnit);
        if(avg!=null)parts.push('平均正确率 '+avg+'%');
        parts.push('合计 '+sumMin+' 分钟');
        if(_lockCount>0&&sumC!==_lockCount)parts.push('⚠ 合计 ≠ 待办 '+_lockCount);
        prev.innerHTML=parts.join('，');
      }else{prev.innerHTML='';}
    };
  }
  // 拆分模式：每个子模块「分批」开关（隐藏单行输入、展开多笔），加行重编号
  // 拆分模式：时长跟着分批走——全部子模块都分批时隐藏底部共享时长框；部分分批时标为「其他学习时长」
  const _syncTimeRow=()=>{
    const tgs=document.querySelectorAll('.sub-batch-toggle');
    if(!tgs.length)return;
    const anyBatch=Array.from(tgs).some(x=>x.checked);
    const allBatch=Array.from(tgs).every(x=>x.checked);
    const tr=document.getElementById('repTimeRow');
    if(tr)tr.style.display=allBatch?'none':'';
    const lb=document.getElementById('repTimeLabel');
    if(lb&&lb.firstChild)lb.firstChild.textContent=anyBatch?'其他学习时长':'学习时长';
  };
  document.querySelectorAll('.sub-batch-toggle').forEach(tg=>{
    tg.addEventListener('change',()=>{
      const key=tg.dataset.sub;
      const row=tg.closest('.rep-sub-row'); if(!row)return;
      const single=row.querySelector('.sub-single');
      const batch=row.querySelector('.sub-batch');
      const on=tg.checked;
      if(single)single.style.display=on?'none':'';
      if(batch)batch.style.display=on?'':'none';
      if(on){const cont=batch&&batch.querySelector('.sub-batch-rows');if(cont&&cont.children.length===0)cont.insertAdjacentHTML('beforeend',_splitBatchRowHtml(1,key,'','',''));}
      _syncTimeRow();
      if(preview&&recompute)recompute();
    });
  });
  _syncTimeRow();
  document.querySelectorAll('.sub-batch-add').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const key=btn.dataset.sub;
      const cont=btn.closest('.sub-batch')&&btn.closest('.sub-batch').querySelector('.sub-batch-rows');
      if(!cont)return;
      const n=cont.querySelectorAll('.sub-batch-row').length+1;
      cont.insertAdjacentHTML('beforeend',_splitBatchRowHtml(n,key,'',''));
    });
  });
  // 交互
  const countEl=$('#dsCount'), rateEl=$('#dsRate');
  const chipEls=dsNeedRate?document.querySelectorAll('#rateChips .rep-chip'):[];
  const chipsBox=$('#rateChips');
  const rateSuffix=document.getElementById('dsRateSuffix');
  const updateRatePreview=()=>{if(!rateEl||rateEl.readOnly){if(rateSuffix)rateSuffix.textContent='%';return;}const p=parseRateInput(rateEl.value);if(rateSuffix)rateSuffix.textContent=(p.valid&&p.expr)?('='+p.rate+'%'):'%';};
  const syncChips=()=>{if(!rateEl)return;const p=parseRateInput(rateEl.value);const v=(p&&p.valid)?p.rate:null;chipEls.forEach(c=>c.classList.toggle('active',v!=null&&parseInt(c.dataset.r,10)===v));};
  chipEls.forEach(c=>c.addEventListener('click',()=>{if(!rateEl||rateEl.readOnly)return;rateEl.value=c.dataset.r;syncChips();updateRatePreview();rateEl.focus();}));
  if(rateEl)rateEl.addEventListener('input',()=>{syncChips();updateRatePreview();});
  syncChips();updateRatePreview();
  // 拆分模块：整体框是否被用户手动改过（改过则 recompute 不再自动同步，尊重手填）
  let overallTouched=false;
  if(countEl)countEl.addEventListener('input',()=>{overallTouched=true;});
  if(rateEl)rateEl.addEventListener('input',()=>{overallTouched=true;});
  // 口径切换：追加 ⇄ 覆盖（重开弹窗，保留同一条任务，直接进录入态）
  const modeBtn=document.getElementById('dsModeBtn');
  if(modeBtn)modeBtn.addEventListener('click',()=>{openTaskReport(t,isAdd?'set':'add',_completeTodoId,true);});
  // 拆分模块：实时汇总到上方整体（题量求和、正确率加权平均），并切只读
  const preview=$('#repPreview');
  let recompute=null;
  if(preview){
    recompute=()=>{
      let sc=0,sw=0,has=false,base=0,bc=0,bw=0;
      document.querySelectorAll('.rep-sub-row').forEach(rowEl=>{
        const tog=rowEl.querySelector('.sub-batch-toggle');
        if(tog&&tog.checked){
          rowEl.querySelectorAll('.sub-batch-row').forEach(r=>{
            const c0=Math.max(0,parseInt(r.querySelector('.sb-count').value,10)||0);
            if(c0<=0)return;
            const rInp=r.querySelector('.sb-rate');
            const rp=parseRateInput(rInp?rInp.value:'');
            const rt=(rp&&rp.valid)?rp.rate:0;
            sc+=c0;sw+=c0*rt;has=true;base+=c0;bc+=c0;if(rt)bw+=c0*rt;
          });
        }else{
          const c0=Math.max(0,parseInt(rowEl.querySelector('.ds-sub-count').value,10)||0);
          const rInp=rowEl.querySelector('.ds-sub-rate');
          const rp=parseRateInput(rInp?rInp.value:'');
          const r=(rp&&rp.valid)?rp.rate:0;
          // 追加模式下整体显示的是「保存后的累计」：今日已有 + 本次
          const mg=mergeAdd((stat.subs||{})[rowEl.dataset.sub],c0,r);
          if(mg.count>0){sc+=mg.count;sw+=mg.count*(mg.rate||0);has=true;}
          base+=c0; bc+=c0; if(r)bw+=c0*r;
        }
      });
      if(has){
        const avg=Math.round(sw/sc);
        const bAvg=bc>0?Math.round(bw/bc):0;
        // 拆分模块：整体框实时同步为「本次子模块汇总」，整体成绩跟着子模块走；用户手填过则尊重手填；待办锁定时整体题量不动
        if(!overallTouched){
          if(_lockCount<=0&&countEl)countEl.value = bc>0?bc:'';
          if(rateEl&&!rateEl.readOnly)rateEl.value = bAvg>0?bAvg:'';
        }
        document.querySelectorAll('.rep-auto').forEach(b=>b.style.display='');
        if(chipsBox){const cw=chipsBox.closest('.rep-chips-card');if(cw)cw.style.display='none';else chipsBox.style.display='none';}
        preview.innerHTML=(isAdd&&base>0&&subInit.count>0)
          ? ('子模块汇总：今日 '+subInit.count+' + 本次 '+base+' = <b>'+sc+'</b> 题，整体正确率 <b>'+avg+'%</b>（整体题量以上方输入为准）')
          : ('子模块汇总 <b>'+sc+'</b> 题，整体正确率 <b>'+avg+'%</b>（整体题量以上方输入为准）');
      } else {
        if(_lockCount<=0){ countEl.removeAttribute('readonly'); if(rateEl)rateEl.removeAttribute('readonly'); }
        if(!overallTouched&&_lockCount<=0){ if(countEl)countEl.value=''; if(rateEl)rateEl.value=''; }
        document.querySelectorAll('.rep-auto').forEach(b=>b.style.display='none');
        if(chipsBox){const cw=chipsBox.closest('.rep-chips-card');if(cw)cw.style.display='';else chipsBox.style.display='';}
        preview.innerHTML='';
      }
      syncChips();
    };
    document.querySelectorAll('.ds-sub-count,.ds-sub-rate,.sb-count,.sb-rate').forEach(inp=>inp.addEventListener('input',recompute));
    recompute();
  }
  // 默认视图：番茄钟刚结束→直接录入；否则显示「查看」
  if(forceEntry)showEntry(); else showView();
  // —— 保存逻辑（与原结构一致）——
  $('#saveDsBtn').addEventListener('click',()=>{
    // 编辑模式：原地替换该条记录（sub 不变，更新 题量/正确率/时长），其余记录不动
    if(editing){
      const count=Math.max(0,parseInt(countEl.value,10)||0);
      const rateParsed=dsNeedRate?parseRateInput(rateEl?rateEl.value:''):null;
      const rate=dsNeedRate?(rateParsed&&rateParsed.valid?rateParsed.rate:null):null;
      if(count<=0){toast('请填写题量');return;}
      if(dsNeedRate&&!(rateParsed&&rateParsed.valid)){toast('请填写正确率');return;}
      const _minEl=document.getElementById('dsMinutes');
      const _newMin=Math.max(0,parseInt(_minEl?_minEl.value:0,10)||0);
      if(_newMin<=0){toast('请填写学习时长（番茄钟自动带入，或手动填分钟数）');return;}
      const _rec2=state.dailyStats[d][t.sec];
      _rec2.records.splice(editIdx,1);
      const _bkKeep=editRec.bkId?{bkId:editRec.bkId,bkN:(editRec.bkN==null?null:editRec.bkN)}:{};
      _rec2.records.push(Object.assign({sub:editRec.sub,count:count,rate:dsNeedRate?rate:null,min:_newMin,ts:Date.now()},_bkKeep));
      recomputeDailyStat(t.sec,d);
      if(!_rec2.records.length)delete state.dailyStats[d][t.sec];
      if(Object.keys(state.dailyStats[d]).length===0)delete state.dailyStats[d];
      save();openTaskReport(t, dsMode, _completeTodoId);return;
    }
    const batchOn = (!isSplit && !editing && document.getElementById('batchToggle') && document.getElementById('batchToggle').checked);
    let newRecs=[]; let _newMin=0; let _splitBatchMinSum=0;
    // 拆分模式：读取某个子模块行的录入数据（未开分批=单行 题量/正确率；开了分批=多笔 题量/正确率/时长）
    const readSubRow=(rowEl)=>{
      const key=rowEl.dataset.sub;
      const tog=rowEl.querySelector('.sub-batch-toggle');
      const out=[];
      if(tog&&tog.checked){
        rowEl.querySelectorAll('.sub-batch-row').forEach(r=>{
          const c=Math.max(0,parseInt(r.querySelector('.sb-count').value,10)||0);
          if(c<=0)return;
          const rInp=r.querySelector('.sb-rate');
          const mInp=r.querySelector('.sb-min');
          out.push({key,count:c,rateStr:rInp?rInp.value.trim():'',min:(mInp&&mInp.value.trim()!=='')?(Math.max(0,parseInt(mInp.value,10)||0)):null,batch:true});
        });
      }else{
        const cInp=rowEl.querySelector('.ds-sub-count');
        // 注意：原写法 `cInp?cInp.value:10` 是把 radix 误写进三元——输入框不存在时会凭空造出 10 题
        const c=Math.max(0,parseInt(cInp?cInp.value:'',10)||0);
        if(c<=0)return out;
        const rInp=rowEl.querySelector('.ds-sub-rate');
        out.push({key,count:c,rateStr:rInp?rInp.value.trim():''});
      }
      return out;
    };
    if(batchOn){
      // —— 分批次录入：同子模块分多笔（如 10+5+5），每笔各自 题量/正确率/学习时长 ——
      const rows=[].slice.call(document.querySelectorAll('#batchRows .batch-row'));
      let _sumC=0,_totMin=0,_bad=false;
      rows.forEach(function(row,i){
        const c=Math.max(0,parseInt(row.querySelector('.b-count').value,10)||0);
        const rInp=row.querySelector('.b-rate');
        const rp=dsNeedRate?parseRateInput(rInp?rInp.value:''):null;
        const r=dsNeedRate?(rp&&rp.valid?rp.rate:null):null;
        const mEl=row.querySelector('.b-min');
        const m=Math.max(0,parseInt(mEl?mEl.value:0,10)||0);
        if(c<=0){toast('第'+(i+1)+'笔题量未填');_bad=true;return;}
        if(dsNeedRate&&!(rp&&rp.valid)){toast('第'+(i+1)+'笔正确率未填或格式错');_bad=true;return;}
        if(m<=0){toast('第'+(i+1)+'笔学习时长未填');_bad=true;return;}
        _sumC+=c;_totMin+=m;
        newRecs.push({sub:(t.sub?subName(t.sub)||t.sub:null),count:c,rate:dsNeedRate?r:null,min:m,ts:Date.now()});
      });
      if(_bad)return;
      if(_lockCount>0 && _sumC!==_lockCount){toast('各笔题量合计 '+_sumC+' ≠ 待办 '+_lockCount+' 题');return;}
      newRecs.forEach(function(rr){const _t=plannedDurFor(t.sec,rr.sub,rr.count);if(_t>0){rr.overtimeMin=Math.max(0,rr.min-_t);rr.overtime=rr.overtimeMin>0;}else{rr.overtimeMin=0;rr.overtime=false;}});
      _newMin=_totMin;
    }else{
      // ===== 原有 单笔 / 拆分 录入逻辑（保持不变）=====
      const count=Math.max(0,parseInt(countEl.value,10)||0);
      const rateParsed=dsNeedRate?parseRateInput(rateEl?rateEl.value:''):null;
      const rate=dsNeedRate?(rateParsed&&rateParsed.valid?rateParsed.rate:null):null;
      const existingSec=(state.dailyStats[d]||{})[t.sec];
      const hasExisting=!!(existingSec&&(existingSec.count>0||(existingSec.subs&&Object.keys(existingSec.subs).length)));
      const rateEmpty=dsNeedRate&&!(rateParsed&&rateParsed.valid);
      if(isSplit){
        let any=false;const miss=[];const _entries=[];
        document.querySelectorAll('.rep-sub-row').forEach(rowEl=>{
          readSubRow(rowEl).forEach(e=>{
            any=true;
            if(dsNeedRate&&!(parseRateInput(e.rateStr)).valid)miss.push(subName(e.key)||e.key);
            _entries.push(e);
          });
        });
        if(any){if(dsNeedRate&&miss.length){toast('子模块「'+miss.join('、')+'」填了题量但没填正确率');return;}}
        else if(count>0){if(rateEmpty){toast('请填写正确率');return;}}
        else if(!hasExisting){toast('请填写题量');return;}
        // 分批的每一笔都要有自己的学习时长
        const missT=[];
        _entries.forEach(e=>{
          if(!e.batch)return;
          if(e.min===null)missT.push(subName(e.key)||e.key);
          else _splitBatchMinSum+=e.min;
        });
        if(missT.length){toast('子模块「'+missT.join('、')+'」的分批笔没填学习时长');return;}
        // 待办题量锁定：子模块只要有填，合计必须等于锁定题量（拆出来的明细要对得上）
        if(_lockCount>0){
          let _subSum=0;_entries.forEach(e=>_subSum+=e.count);
          if(_subSum!==_lockCount){toast('子模块合计 '+_subSum+' 题，需等于待办 '+_lockCount+' 题');return;}
        }
      }else{
        if(count>0){if(rateEmpty){toast('请填写正确率');return;}}
        else if(!hasExisting){toast('请填写题量');return;}
      }
      // 学习时长必填（番茄钟自动带入或手动填）；分批时每笔自带时长，底部共享框隐藏即不计
      const _minEl=document.getElementById('dsMinutes');
      const _trEl=document.getElementById('repTimeRow');
      const _sharedMin=(_trEl&&_trEl.style.display==='none')?0:Math.max(0,parseInt(_minEl?_minEl.value:0,10)||0);
      _newMin=_sharedMin+_splitBatchMinSum;
      if(_newMin<=0){toast('请填写学习时长（番茄钟自动带入，或手动填分钟数）');return;}
      newRecs=[];
      if(t.sub){
        if(count>0)newRecs.push({sub:subName(t.sub)||t.sub,count:count,rate:dsNeedRate?rate:null,ts:Date.now()});
      } else if(isSplit){
        document.querySelectorAll('.rep-sub-row').forEach(rowEl=>{
          readSubRow(rowEl).forEach(e=>{
            const rp=parseRateInput(e.rateStr);
            const r=(rp&&rp.valid)?rp.rate:null;
            const _rec={sub:e.key,count:e.count,rate:dsNeedRate?r:null,ts:Date.now()};
            if(e.min!=null)_rec.min=e.min; // 分批笔自带时长
            newRecs.push(_rec);
          });
        });
        {
          const subSum=newRecs.reduce((a,x)=>a+x.count,0);
          const overallFromInput=Math.max(0,parseInt(countEl.value,10)||0);
          if(overallFromInput>subSum){
            // 整体框大于子模块汇总：超出部分作为整体记录补充（不重复计入子模块）
            newRecs.push({sub:null,count:overallFromInput-subSum,rate:dsNeedRate?rate:null,ts:Date.now()});
          } else if(subSum===0&&overallFromInput>0){
            // 只填了整体框、未填任何子模块：整条作为整体记录
            newRecs.push({sub:null,count:overallFromInput,rate:dsNeedRate?rate:null,ts:Date.now()});
          } else if(subSum>overallFromInput&&overallFromInput>0){
            // #8「整体手填为准」：子模块题量按比例折算，使合计严格=整体题量；
            // 各子正确率是自身比率不折算。floor 余数按比例余量补 1，为 0 的行剔除
            const _target=overallFromInput;
            const alloc=new Array(newRecs.length).fill(0);let acc=0;
            newRecs.forEach((x,i)=>{alloc[i]=Math.floor(x.count*_target/subSum);acc+=alloc[i];});
            let remain=_target-acc;
            newRecs.map((x,i)=>({i:i,f:x.count*_target/subSum-alloc[i]}))
              .sort((a,b)=>b.f-a.f)
              .forEach(o=>{if(remain>0){alloc[o.i]++;remain--;}});
            newRecs.forEach((x,i)=>x.count=alloc[i]);
            newRecs=newRecs.filter(x=>x.count>0);
            toast('子模块汇总 '+subSum+' 题 > 整体 '+_target+' 题，已按整体 '+_target+' 题折算保存');
          }
        }
      } else {
        if(count>0)newRecs.push({sub:null,count:count,rate:dsNeedRate?rate:null,ts:Date.now()});
      }
      if(!newRecs.length){ toast('没有可保存的题量'); return; }
      // 拆分模块：时长整段共享，超时挂在「整体(无子模块)」记录上；纯子模块拆分则不标（时长无法分摊到子模块）
      if(isSplit){
        const overallRec=newRecs.find(r=>r.sub===null);
        if(overallRec){const _tc=newRecs.reduce((a,x)=>a+(x.count||0),0);const _t=plannedDurFor(t.sec,null,_tc);if(_t>0){overallRec.overtimeMin=Math.max(0,_newMin-_t);overallRec.overtime=overallRec.overtimeMin>0;}else{overallRec.overtimeMin=0;overallRec.overtime=false;}}
      }
      // 每条记录挂本次录入时长（番茄钟预填或手填），查看详情可逐条看到：
      // 非拆分=整段挂本条；拆分模块一次录入是一整段时间——
      //   · 纯子模块行：按题量比例分摊，各行之和严格=_newMin（旧逻辑每行都盖整段，速度卡时长翻倍）
      //   · 有整体(差量)行：统计口径只认整体行（collectTimeEntries 会跳过子行），整段挂它，子行按比例分摊供逐条展示
      if(isSplit){
        // 分批笔自带时长，先从总时长里扣掉，剩余（底部共享框填的）再按题量分摊
        const _ownSum=newRecs.reduce((a,r)=>a+(r.min||0),0);
        const _restMin=Math.max(0,_newMin-_ownSum);
        const _oi=newRecs.findIndex(r=>r.sub===null);
        if(_oi>=0){
          const _subRows=newRecs.filter(r=>r.sub!==null&&r.min==null);
          const _sm=allocMinutesByCount(_subRows,_restMin);let _j=0;
          _subRows.forEach(r=>{r.min=_sm[_j++];});
          newRecs[_oi].min=_restMin;
        }else{
          const _noOwn=newRecs.filter(r=>r.min==null);
          const _m=allocMinutesByCount(_noOwn,_restMin);
          _noOwn.forEach((r,i)=>{r.min=_m[i];});
        }
      }else{
        newRecs.forEach(r=>{r.min=_newMin;});
      }
      if(!isSplit)newRecs.forEach(r=>{const _t=plannedDurFor(t.sec,r.sub,r.count);if(_t>0){r.overtimeMin=Math.max(0,_newMin-_t);r.overtime=r.overtimeMin>0;}else{r.overtimeMin=0;r.overtime=false;}});
    }
    // ===== 共享收尾：建数据壳、累加时长、覆盖替换、合并重算（单笔/拆分/分批 通用）=====
    if(!state.dailyStats[d])state.dailyStats[d]={};
    if(!state.dailyStats[d][t.sec])state.dailyStats[d][t.sec]={count:0,rate:0,subs:{},records:[]};
    const rec=state.dailyStats[d][t.sec];
    seedRecordsIfLegacy(rec);
    if(!rec.records)rec.records=[];
    const _oldMin=rec.minutes||0;
    rec.minutes = isAdd?(_oldMin+_newMin):_newMin;
    if(rec.minutes<=0)delete rec.minutes;
    // 覆盖模式：大类(含拆分模块)整段替换当天该模块记录；子模块任务只替换该子模块
    if(!isAdd){
      rec.records= t.sub ? rec.records.filter(r=>r.sub!==t.sub) : [];
    }
    // 拆分模块追加子模块明细时：旧的「整体(sub:null)」记录与子模块明细重复（整体框=子模块汇总），
    // 若保留会虚高（30整体 + 20+10子模块 = 60）。本次生成的差量记录(overall>subSum)不受影响。
    if(isSplit && isAdd && newRecs.some(r=>r.sub)){
      rec.records=rec.records.filter(r=>r.sub!==null);
    }
    if(_bk)newRecs.forEach(function(r){r.bkId=_bk.id;if(_bk.n!=null)r.bkN=_bk.n;});
    rec.records=rec.records.concat(newRecs);
    // 由 records 重算汇总（count/rate/subs），今日汇总与查看详情都读它，保证对得上
    recomputeDailyStat(t.sec,d);
    if(!rec.records.length)delete state.dailyStats[d][t.sec];
    if(Object.keys(state.dailyStats[d]).length===0)delete state.dailyStats[d];
    // #7 题量达标自动完成关联待办：查找同模块未完成待办，今日累计题量>=待办题量则自动完成
    if(t.sec){
      const _todaySec=state.dailyStats[d]&&state.dailyStats[d][t.sec];
      const _todayCount=(_todaySec&&_todaySec.count)||0;
      const _relTodo=(state.todos||[]).find(_td=>_td.section===t.sec&&!_td.done&&(!_td.sub||_td.sub===t.sub)&&_td.count>0&&!(isRepeat(_td)&&_td.lastDone===todayStr()));
      if(_relTodo){
        if(_todayCount>=_relTodo.count){
          const _doneNoToast=_lockCount>0; // 锁死题量=本次必达标，自动完成但不弹toast
          const _r=completeTodoOnce(_relTodo,{date:todayStr()});
          if(_r.completed&&!_doneNoToast){
            toast(isRepeat(_relTodo)?('待办题量达标，已自动完成 · 下次 '+(_relTodo.dueDate?_relTodo.dueDate.slice(5):'长期')):('待办题量达标，已自动完成：'+_relTodo.text));
          }
        }else{
          toast('已记录 '+_todayCount+'/'+_relTodo.count+' 题，继续加油');
        }
      }
    }
    // 番茄钟发起的录成绩：自动完成关联任务（完成任务=完成打卡）
    if(typeof pomo!=='undefined'&&pomo&&pomo.taskId){
      const _at=(state.todos||[]).find(x=>x.id===pomo.taskId);
      if(_at){
        const _r=completeTodoOnce(_at,{base:'due-or-today'});
        if(_r.completed){
          toast(isRepeat(_at)?('已自动完成 · 下次 '+(_at.dueDate?_r.nextDate.slice(5):'长期')):('已自动完成任务：'+_at.text));
        }
      }
      pomo.taskId='';
    }
    // 番茄钟→录入：消费掉停止时自动写入的 focus session，避免与「学习时长」重复计时
    // （手动改的时长以录入框为准；session 仅当同模块时才移除，跨模块不误删）
    if(pendingPomoSessId&&state.studyRecords[d]&&state.studyRecords[d].sessions){
      const _si=state.studyRecords[d].sessions.findIndex(s=>s.id===pendingPomoSessId&&s.section===t.sec);
      if(_si>=0){const _rm=state.studyRecords[d].sessions[_si];markEntityDeleted('session',[_rm&&_rm.id]);state.studyRecords[d].sessions.splice(_si,1);}
    }
    pendingPomoSessId=null;
    // 从「勾选任务」进来的录入：保存成功才把该任务标记完成；取消则任务保持未做、仍在列表（不再一勾就消失）
    if(_completeTodoId){
      const _ct=(state.todos||[]).find(x=>x.id===_completeTodoId);
      completeTodoOnce(_ct,{base:'due-or-today'});
    }
    // （已移除）原「录完一笔自动挂复盘待办」逻辑 —— 复盘功能下线，历史数据由 migrateTodos 清理
    save();closeModal();render();
    /* 录入后对比「我的目标」：只有新录入（add/覆盖）才弹；
       editing=原地修正今天已存的某条记录，改旧数字不再弹「本次」小结打扰 */
    if(!editing)showGoalCompare(t.sec,t.sub,newRecs,_newMin);
  });
}
function parseRateInput(v){
  // 正确率录入解析：支持百分数(70 / 70%) 或 分数(14/20)，返回 {rate:0-100,valid,expr}
  const s=String(v==null?'':v).trim();
  if(!s)return {rate:null,valid:false,expr:''};
  let m=s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if(m){
    const num=parseFloat(m[1]),den=parseFloat(m[2]);
    if(!(den>0)||num<0)return {rate:null,valid:false,expr:s};
    return {rate:Math.max(0,Math.min(100,Math.round(num/den*100))),valid:true,expr:s};
  }
  if(/^(\d+(?:\.\d+)?)\s*%?$/.test(s)){
    return {rate:Math.max(0,Math.min(100,Math.round(parseFloat(s)))),valid:true,expr:''};
  }
  return {rate:null,valid:false,expr:s};
}
function openReportBySection(sec,todoId,entry,bk){
  // 套卷：直接走专属「套卷成绩」录入（分数/各模块正确率），一笔记录同时完成打卡+套卷分析，避免和每日刷题面板重复录
  if(sec==='taojuan'){
    /* 首页今日汇总点「查看详情」（entry===false，已打卡）：打开当天最近一条套卷带回全部成绩，
       旧逻辑无视入口总开空白新增表单，表现为「详情里数据全是 0/空」；
       「记一笔」（entry===true）、勾选任务（带 todoId）、番茄钟转录（entry 空）仍走新增 */
    if(entry===false){
      const _todayRecs=(state.examRecords||[]).filter(x=>x.date===todayStr());
      if(_todayRecs.length){openExamEditor(_todayRecs[_todayRecs.length-1].id);return;}
    }
    openExamEditor(null, todoId); return;
  }
  // 番茄钟发起的：优先用关联任务（带出任务题量，即使任务已自动完成也带得出）
  if(pomo && pomo.taskId){
    const _at=(state.todos||[]).find(x=>x.id===pomo.taskId);
    if(_at && (_at.section===sec||!sec)){ openTaskReport({id:_at.id,type:'module',sec:_at.section,sub:_at.sub||null,count:_at.count||0,name:_at.text||_at.name,__bk:bk},'add',_at.id,entry); return; }
  }
  // 未显式带待办时：该模块恰好有一个「未完成且填了题量」的关联待办 → 自动带出（首页/模块页记一笔也能锁待办题量）；多个时不猜，保持原样
  let _autoSub=null;
  if(!todoId){
    // 重复任务今天已完成（lastDone=今天）的排除：它 done 恒为 false，旧逻辑会误锁题量
    const _matches=(state.todos||[]).filter(_p=>_p.section===sec&&!_p.done&&_p.count>0&&!(isRepeat(_p)&&_p.lastDone===todayStr()));
    if(_matches.length===1){todoId=_matches[0].id;_autoSub=_matches[0].sub||null;}
  }
  const all=state.dailyTasks||[];
  const t=all.find(x=>x.sec===sec&&!x.sub)||all.find(x=>x.sec===sec);
  if(t){
    let _t=_autoSub?Object.assign({},t,{sub:_autoSub}):t;
    if(bk)_t=Object.assign({},_t,{__bk:bk});
    openTaskReport(_t,'add',todoId,entry);return;
  }
  openTaskReport({id:'__tmp_'+sec,type:'module',sec:sec,sub:_autoSub,name:SECTION_MAP[sec].name,__bk:bk},'add',todoId,entry);
}

/* ============================================================
   申论小题
   ============================================================ */




function renderXiaoti(c){
  const wrap=el('div','page-tabs');
  wrap.innerHTML=`<button class="page-tab active" data-k="note">小题笔记</button><button class="page-tab" data-k="review">批改记录</button>`;
  c.appendChild(wrap);
  const box=el('div');
  c.appendChild(box);
  function renderX(k){
    box.replaceChildren();
    if(k==='review'){renderShenlunReviews(box);return;}
    const n=(SHENLUN_NOTES||{}).xiaoti;
    const card=el('div','card');
    card.innerHTML=`<div class="section-title"><span class="dot"></span>申论小题方法</div>
      <div class="muted" style="margin-bottom:12px;">小题四大题型的作答要点（按考公申论常规方法论整理）。</div>
      <div id="slnBody"></div>`;
    box.appendChild(card);
    const body=document.getElementById('slnBody');
    if(n){
      body.innerHTML=`
        <div class="sln-intro">${annot(n.intro)}</div>
        <div class="sln-sec">${icon('list')} 作答流程</div>
        <ol class="sln-alg">${(n.algorithm||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ol>
        <div class="sln-sec">${icon('shuffle')} 题型怎么打</div>
        ${(n.types||[]).map(t=>`<div class="sln-type"><b>${escapeHtml(t[0])}</b><span>${escapeHtml(t[1])}</span></div>`).join('')}
        <div class="sln-sec sln-sec-do">${icon('check')} 作答时这样做</div>
        <ul class="sln-list sln-list-do">${(n.do||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ul>
        <div class="sln-sec sln-sec-dont">${icon('reset')} 避免这样做</div>
        <ul class="sln-list sln-list-dont">${(n.dont||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
    }
  }
  renderX('note');
  wrap.querySelectorAll('.page-tab').forEach(b=>b.addEventListener('click',()=>{
    wrap.querySelectorAll('.page-tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    renderX(b.dataset.k);
  }));
}

/* ============================================================
   申论大作文 · 方法笔记 + 素材库
   ============================================================ */

let _gfIO=null;   // 规范词页滚动高亮的观察器（切 tab 时断开重建）
let _gfResizeBound=false;   // 右侧渐隐的 resize 监听只注册一次
let _gfScrollHandler=null;  // 滚动高亮的兜底监听（同一时刻只留一个）
function renderDazuowen(c){
  const all=mergeData('shenlunDazuowen',SHENLUN_DAZUOWEN,state.customData.shenlunDazuowen);
  const notes=SHENLUN_NOTES||{};
  const wrap=el('div','page-tabs');
  wrap.innerHTML=`<button class="page-tab active" data-k="method">笔记</button><button class="page-tab" data-k="material">素材</button><button class="page-tab" data-k="guifan">规范词</button><button class="page-tab" data-k="review">批改记录</button>`;
  c.appendChild(wrap);
  const box=el('div');
  c.appendChild(box);

  function renderMethod(){
    box.replaceChildren();
    const mCard=el('div','card');
    mCard.innerHTML=`<div class="section-title"><span class="dot"></span>大作文方法笔记<span class="hmark" tabindex="0" role="button" aria-label="说明">?<span class="hmark-pop">两位老师的核心写作方法，源自其课程体系。</span></span></div>
      <div class="section-tabs" id="dzwMthTabs">${['bailu','yuandong'].map((kk,i)=>`<button class="section-tab${i===0?' active':''}" data-k="${kk}">${notes[kk].name}</button>`).join('')}</div>
      <div id="dzwMthBody"></div>`;
    box.appendChild(mCard);
    const mBody=document.getElementById('dzwMthBody');
    function renderM(kk){
      const n=notes[kk];if(!n)return;
      mBody.innerHTML=`
        <div class="sln-intro">${annot(n.intro)}</div>
        <div class="sln-sec">${icon('list')} 写作流程</div>
        <ol class="sln-alg">${(n.algorithm||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ol>
        <div class="sln-sec">${icon('target')} 核心规则 <span class="muted" style="font-weight:400;">· 指令 / 适用边界</span></div>
        ${(n.rules||[]).map(r=>`<div class="sln-rule"><div class="sln-rule-t">${escapeHtml(r[0])}</div><div class="sln-rule-s">${escapeHtml(r[1])}</div></div>`).join('')}
        <div class="sln-sec">${icon('shuffle')} 题型怎么打</div>
        ${(n.types||[]).map(t=>`<div class="sln-type"><b>${escapeHtml(t[0])}</b><span>${escapeHtml(t[1])}</span></div>`).join('')}
        <div class="sln-sec">${icon('book-open')} 语言要点</div>
        <ul class="sln-list">${(n.language||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ul>
        <div class="sln-sec sln-sec-do">${icon('check')} 写作时这样做</div>
        <ul class="sln-list sln-list-do">${(n.do||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ul>
        <div class="sln-sec sln-sec-dont">${icon('reset')} 避免这样做</div>
        <ul class="sln-list sln-list-dont">${(n.dont||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
    }
    renderM('bailu');
    mCard.querySelectorAll('#dzwMthTabs .section-tab').forEach(b=>b.addEventListener('click',()=>{
      mCard.querySelectorAll('#dzwMthTabs .section-tab').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      renderM(b.dataset.k);
    }));
  }

  /* 素材：标题和正文放同一张卡里，不再拆成「一个空标题卡 + 一个内容卡」 */
  function renderMaterial(){
    box.replaceChildren();
    const card=el('div','card');
    card.innerHTML=`<div class="section-title"><span class="dot"></span>申论素材${all.length?`<span class="slr-count">${all.length} 个主题</span>`:''}<span class="hmark" tabindex="0" role="button" aria-label="说明">?<span class="hmark-pop">按大类积累素材：官方表述、案例、金句。点上面的分类切换。</span></span></div>
      <div id="dzwMatInner"></div>`;
    box.appendChild(card);
    const emptyTip=el('div','empty-tip');
    emptyTip.setAttribute('data-search-empty','');
    emptyTip.style.display='none';
    emptyTip.textContent='没有匹配的素材。';
    box.appendChild(emptyTip);
    const inner=card.querySelector('#dzwMatInner');
    if(!all.length){
      inner.innerHTML=`<div class="empty-tip">还没有素材主题。点本页右上角「管理内容」可导入或手动添加。</div>`;
      return;
    }
    // 按大类(cat)分组，无大类归"其他"，保持数据出现顺序
    const order=[],groups={};
    all.forEach(t=>{
      const c=(t&&t.cat)||'其他';
      if(!groups[c]){groups[c]=[];order.push(c);}
      groups[c].push(t);
    });
    const bar=el('div','dzw-tabs-bar');
    bar.innerHTML=order.map((c,i)=>`<button class="dzw-tab${i===0?' active':''}" data-k="${i}">${escapeHtml(c)}<span class="gf-n">${groups[c].length}</span></button>`).join('');
    inner.appendChild(bar);
    const dbody=el('div');
    inner.appendChild(dbody);
    function themeHtml(t){
      const themeName=t.theme||t.title||'主题';
      let html=`<div class="dzw-theme">「${escapeHtml(themeName)}」</div>`;
      if(t.materials&&t.materials.length){
        html+=`<div class="dzw-section"><div class="ds-title">${icon('book-open')} 官方表述</div>`+
          t.materials.map(m=>`<div class="ds-item">${escapeHtml(m)}</div>`).join('')+`</div>`;
      }
      if(t.cases&&t.cases.length){
        html+=`<div class="dzw-section"><div class="ds-title">${icon('building')} 案例</div>`+
          t.cases.map(cs=>{
            const link=safeUrl(cs.url)?` · <a href="${safeUrl(cs.url)}" target="_blank" rel="noopener">查看原文 →</a>`:'';
            return `<div class="dzw-case"><div class="dc-title">${escapeHtml(cs.title)}</div><div class="dc-desc">${escapeHtml(cs.desc)}</div><div class="dc-source">${icon('link')} 来源：${annot(cs.source)}${link}</div></div>`;
          }).join('')+`</div>`;
      }
      if(t.quotes&&t.quotes.length){
        html+=`<div class="dzw-section"><div class="ds-title">${icon('quote')} 金句</div>`+
          t.quotes.map(q=>`<div class="dzw-quote"><div class="dq-text">「${escapeHtml(q.text)}」</div><div class="dq-source">—— ${annot(q.source)}</div></div>`).join('')+`</div>`;
      }
      return html;
    }
    let curCat=0;
    function renderCat(i){
      curCat=i||0;
      const _mi=document.querySelector('.mod-search .ms-input');
      const q=(_mi&&_mi.value||'').trim();
      if(q){
        /* 搜索时把全部分类都渲染出来再过滤：只在当前选中的那一类里找的话，
           搜不到会把整张卡隐藏 + 提示「没有匹配的素材」，其实词在别的分类里 */
        dbody.innerHTML=order.map(c=>
          `<div class="dzw-cat-block"><div class="gf-sec"><span class="gf-sec-t">${escapeHtml(c)}</span></div>`
          +groups[c].map(themeHtml).join('')+`</div>`).join('');
        if(window.applyModuleView)applyModuleView(box,_mi);
        return;
      }
      const c=order[curCat];if(!c)return;
      dbody.innerHTML=groups[c].map(themeHtml).join('');
    }
    renderCat(0);
    bar.querySelectorAll('.dzw-tab').forEach(b=>b.addEventListener('click',()=>{
      bar.querySelectorAll('.dzw-tab').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      renderCat(parseInt(b.dataset.k));
    }));
    /* 搜索框输入时重渲染：通用搜索只过滤当前 DOM，得先把别的分类也铺出来才搜得到 */
    const _msi=document.querySelector('.mod-search .ms-input');
    if(_msi&&!_msi.dataset.matHooked){
      _msi.dataset.matHooked='1';
      _msi.addEventListener('input',()=>renderCat(curCat));
    }
  }

  /* 规范词：吸顶分类锚点条 + 分组标题吸顶。
     65 条平铺太长，靠一条可横滑的分类胶囊跳转，滚动时当前分组标题贴在锚点条下方。
     搜索不在这里做——直接用右上角搜索键（模块通用搜索已覆盖 .ds-item）。 */
  function renderGuifan(){
    box.replaceChildren();
    const list=mergeData('shenlunGuifan',SHENLUN_GUIFAN,state.customData.shenlunGuifan);
    const card=el('div','card');
    card.innerHTML=`<div class="section-title"><span class="dot"></span>申论规范词${list.length?`<span class="slr-count">${list.length} 条</span>`:''}<span class="hmark" tabindex="0" role="button" aria-label="说明">?<span class="hmark-pop">写大作文、小题时的官方表述。搜不到想要的词可以点右上角「管理内容」自己加。</span></span></div>
      <div class="gf-navbar" id="gfNavbar"><div class="gf-chips" id="gfChips"></div></div>
      <div class="gf-inner" id="dzwGfInner"></div>`;
    box.appendChild(card);
    const navbar=card.querySelector('#gfNavbar');
    const chipsBox=card.querySelector('#gfChips');
    const inner=card.querySelector('#dzwGfInner');
    if(!list.length){
      navbar.style.display='none';
      inner.innerHTML=`<div class="empty-tip">还没有规范词。点右上角「管理内容 → 申论规范词」添加。</div>`;
      return;
    }
    const emptyTip=el('div','empty-tip');
    emptyTip.setAttribute('data-search-empty','');
    emptyTip.style.display='none';
    emptyTip.textContent='没有匹配的规范词。';
    box.appendChild(emptyTip);
    // 按 cat 分组：固定 13 类的顺序以 GUIFAN_CATS 为准，自己新加的分类追加在后面
    const groups={},extra=[];
    list.forEach(it=>{
      const c=(it&&it.cat)||'其他';
      if(!groups[c]){groups[c]=[];if(GUIFAN_CATS.indexOf(c)<0)extra.push(c);}
      groups[c].push(it);
    });
    const order=GUIFAN_CATS.concat(extra);
    let active=order[0];
    let _gfLock=0,_gfSentinel=null;
    function paint(){
      chipsBox.innerHTML=order.map(c=>
        `<button class="gf-chip${c===active?' active':''}" data-cat="${escapeHtml(c)}" aria-pressed="${c===active?'true':'false'}">${escapeHtml(c)}<span class="gf-n">${(groups[c]||[]).length}</span></button>`
      ).join('');
      inner.innerHTML=order.map(c=>{
        const arr=groups[c]||[];
        return `<div class="gf-group${arr.length?'':' gf-empty'}" data-cat="${escapeHtml(c)}">
          <div class="gf-sec"><span class="gf-sec-t">${escapeHtml(c)}</span></div>
          ${arr.length?arr.map(it=>`<div class="ds-item"><b>${escapeHtml(it.term||'')}</b>${it.use?`<br><span class="gf-use">${escapeHtml(it.use)}</span>`:''}</div>`).join('')
            :'<div class="empty-tip">这一类还没有规范词，点右上角「管理内容 → 申论规范词」添加</div>'}
        </div>`;
      }).join('');
      syncNavH();observe();syncFade();setupStuck();setupScrollSpy();
      setTimeout(syncNavH,60);   // 字体/布局稳定后再量一次，段头吸顶位置才准
    }
    /* 分组标题吸顶位置 = 锚点条实际高度（写进 CSS 变量，避免写死） */
    function syncNavH(){
      card.style.setProperty('--gf-nav-h',(navbar.offsetHeight||40)+'px');
    }
    /* reveal=true 时把高亮那颗胶囊滑进视野：分类多了横条放不下，不滑等于看不见高亮。
       nearest = 只滚最小距离（滚动跟随用，不打断视线）；否则居中（点击时用） */
    function setActive(c,reveal){
      active=c;
      let hit=null;
      chipsBox.querySelectorAll('.gf-chip').forEach(b=>{
        const on=b.dataset.cat===c;
        b.classList.toggle('active',on);
        b.setAttribute('aria-pressed',on?'true':'false');
        if(on)hit=b;
      });
      if(reveal&&hit)revealChip(hit,'nearest');
    }
    /* 横向滚到这颗胶囊：mode='nearest' 只滚到刚好露出来，否则滚到居中 */
    function revealChip(b,mode){
      const pad=10,cw=chipsBox.clientWidth||0,sw=chipsBox.scrollWidth||0;
      const max=Math.max(0,sw-cw);
      const l=b.offsetLeft||0,r=l+(b.offsetWidth||0);
      let left;
      if(mode==='nearest'){
        const cur=chipsBox.scrollLeft||0;
        if(l<cur+pad)left=l-pad;                      // 在左边外面 → 往回滚一点
        else if(r>cur+cw-pad)left=r-cw+pad;           // 在右边外面 → 往前滚一点
        else return;                                  // 本来就看得见，别乱动
      }else{
        left=l-(cw-(b.offsetWidth||0))/2;
      }
      left=Math.max(0,Math.min(left,max));
      if(Math.abs(left-(chipsBox.scrollLeft||0))<2)return;
      try{chipsBox.scrollTo({left:left,behavior:'smooth'});}
      catch(e){chipsBox.scrollLeft=left;}
    }
    /* 右侧渐隐只在还能往左滑时才出现，滑到最右端就收掉：
       常驻的话最后一个分类看着像被截断，跟整条也接不上 */
    function syncFade(){
      const max=chipsBox.scrollWidth-chipsBox.clientWidth;
      navbar.classList.toggle('can-scroll',max>2&&chipsBox.scrollLeft<max-2);
    }
    chipsBox.addEventListener('scroll',syncFade,{passive:true});
    if(!_gfResizeBound){
      _gfResizeBound=true;
      window.addEventListener('resize',function(){
        document.querySelectorAll('.gf-navbar').forEach(function(nb){
          const cb=nb.querySelector('.gf-chips');if(!cb)return;
          const max=cb.scrollWidth-cb.clientWidth;
          nb.classList.toggle('can-scroll',max>2&&cb.scrollLeft<max-2);
        });
      });
    }
    /* 滚动时高亮当前分组：同时命中多个时取最靠上的那个（entries 顺序不保证） */
    function observe(){
      if(!window.IntersectionObserver)return;
      try{if(_gfIO)_gfIO.disconnect();}catch(e){}
      const root=document.getElementById('content');
      _gfIO=new IntersectionObserver(function(es){
        if(_gfLock&&Date.now()<_gfLock)return;   // 刚点过锚点，跳转途中别把高亮抢走
        let top=null,best=null;
        es.forEach(function(en){
          if(!en.isIntersecting)return;
          const t=en.boundingClientRect.top;
          if(best===null||t<top){top=t;best=en.target.dataset.cat;}
        });
        if(best!==null)setActive(best,true);   // 高亮切换时把胶囊滑进视野，否则看不见
      },{root:root||null,rootMargin:'-'+((navbar.offsetHeight||40)+6)+'px 0px -62% 0px',threshold:0});
      inner.querySelectorAll('.gf-group').forEach(g=>_gfIO.observe(g));
    }
    /* 兜底：直接按位置算当前分组。IntersectionObserver 快速滑动时会漏掉矮分组，
       而且它只在"相交状态变化"时回调，滚到长分组中间再慢慢挪时不会更新 */
    function setupScrollSpy(){
      const rootEl=document.getElementById('content');
      if(!rootEl)return;
      if(_gfScrollHandler){
        rootEl.removeEventListener('scroll',_gfScrollHandler);
        window.removeEventListener('scroll',_gfScrollHandler);
        _gfScrollHandler=null;
      }
      let raf=0;
      const run=function(){
        raf=0;
        if(!inner.isConnected)return;
        if(_gfLock&&Date.now()<_gfLock)return;
        const gs=inner.querySelectorAll('.gf-group');
        if(!gs.length)return;
        const line=rootEl.getBoundingClientRect().top+(navbar.offsetHeight||40)+8;
        let best=null;
        gs.forEach(function(g){                     // 文档顺序，最后一个越过判定线的就是当前分组
          if(g.getBoundingClientRect().top<=line+1)best=g.dataset.cat;
        });
        if(best===null)best=gs[0].dataset.cat;
        setActive(best,true);
      };
      const rafFn=window.requestAnimationFrame?window.requestAnimationFrame.bind(window)
        :function(f){return setTimeout(f,16);};   // 必须 bind，否则 Illegal invocation
      _gfScrollHandler=function(){ if(!raf)raf=rafFn(run); };
      rootEl.addEventListener('scroll',_gfScrollHandler,{passive:true});
      window.addEventListener('scroll',_gfScrollHandler,{passive:true});
    }
    /* 锚点条是否吸顶：在它前面放个 1px 哨兵，哨兵滚出顶部就说明条贴住了。
       只有吸顶时才加分隔线和投影，没吸顶时它跟卡片是一体的。 */
    function setupStuck(){
      if(_gfSentinel||!window.IntersectionObserver)return;
      const s=document.createElement('div');
      s.setAttribute('data-gf-sentinel','');
      s.style.cssText='height:1px;margin:0 0 -1px;';
      navbar.parentNode.insertBefore(s,navbar);
      _gfSentinel=s;
      const root=document.getElementById('content');
      new IntersectionObserver(function(es){
        es.forEach(function(en){
          navbar.classList.toggle('is-stuck',!en.isIntersecting);
        });
      },{root:root||null,threshold:0}).observe(s);
    }
    chipsBox.addEventListener('click',function(e){
      const b=e.target.closest?e.target.closest('.gf-chip'):null;
      if(!b)return;
      _gfLock=Date.now()+700;   // 跳转期间锁住高亮，免得路过别的分类时被改掉
      setActive(b.dataset.cat);revealChip(b);
      const g=inner.querySelector('.gf-group[data-cat="'+b.dataset.cat.replace(/"/g,'')+'"]');
      if(g&&g.scrollIntoView)g.scrollIntoView({block:'start'});   // scroll-margin-top 已留出让位
    });
    paint();
  }

  function renderReview(){ box.replaceChildren(); renderShenlunReviews(box); }

  renderMethod();
  wrap.querySelectorAll('.page-tab').forEach(b=>b.addEventListener('click',()=>{
    wrap.querySelectorAll('.page-tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const k=b.dataset.k;
    if(k==='material')renderMaterial();
    else if(k==='guifan')renderGuifan();
    else if(k==='review')renderReview();
    else renderMethod();
  }));
}

/* 申论批改记录（豆包批改 → 存档） */

function renderShenlunReviews(c){
  const list=state.shenlunReviews||[];
  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>申论批改${list.length?`<span class="slr-count">${list.length} 次</span>`:''}
    <button class="btn btn-ghost btn-sm" id="slrAddBtn" style="margin-left:auto;padding:5px 10px;">+ 录得分</button>
    <button class="btn btn-ghost btn-sm" id="slrHintBtn" style="padding:5px 10px;">怎么用</button>
  </div>
  ${list.length
    ? `<div class="slr-list">`+list.map(r=>{
      const typ=r.type?`<span class="slr-type" data-settype="${r.id}">${escapeHtml(r.type)}</span>`:`<span class="slr-type slr-type-none" data-settype="${r.id}">标题型</span>`;
      return `<div class="slr-item" data-id="${r.id}">
        <div class="slr-head"><span class="slr-label">${escapeHtml(r.label||'申论作文')}</span><span class="slr-head-r">${typ}${r.score?`<span class="slr-score">${escapeHtml(r.score)}</span>`:''}</span></div>
        <div class="slr-meta">${r.date||''}${r.teacher?' · '+escapeHtml(r.teacher)+'方法批改':''}${r.origin?` · ${escapeHtml(r.origin)}`:''}</div>
        ${r.conclusion?`<div class="slr-concl">${escapeHtml(r.conclusion)}</div>`:''}
        <button class="slr-del" data-del="${r.id}" title="删除">×</button>
      </div>`;
    }).join('')+`</div>`
    : `<div class="empty-tip" style="text-align:center;">还没有得分记录。<br>把「题目＋材料＋你的作文」发我批改，或用右上角「+ 录得分」手动记一题。</div>`}
  `;
  c.appendChild(card);
  card.querySelectorAll('[data-id]').forEach(n=>n.addEventListener('click',()=>openShenlunReviewDetail(n.dataset.id)));
  card.querySelectorAll('[data-del]').forEach(n=>n.addEventListener('click',e=>{e.stopPropagation();uiConfirm('删除这条记录？',()=>delShenlunReview(n.dataset.del),{danger:true});}));
  // 点题型徽标 → 改题型
  card.querySelectorAll('[data-settype]').forEach(n=>n.addEventListener('click',e=>{e.stopPropagation();setShenlunType(n.dataset.settype);}));
  const addBtn=document.getElementById('slrAddBtn');
  if(addBtn)addBtn.addEventListener('click',()=>addShenlunScoreModal());
  const hint=document.getElementById('slrHintBtn');
  if(hint)hint.addEventListener('click',()=>openModal('申论批改怎么用',`<div style="line-height:1.8;font-size:14px;color:var(--text-sub);">1. 把要批改的申论<strong>题目＋给定材料＋你的作答</strong>发给我（文字或截图都行）。<br>2. 我会用内置的白鹭 / 袁东方法论逐条批改：参考得分、总评、失分点、改进建议。<br>3. 批改结果会自动存到这里，随时回看。<br><br>想用刷题自评攒题型强弱？点「+ 录得分」自己填题型和得分即可，不用等批改。</div>`));
}
/* 手动录一条得分：选题型 + 填分数，存成 origin='手动' 的批改记录，供薄弱分析用 */
function addShenlunScoreModal(){
  const types=SHENLUN_TYPES||['大作文'];
  const typeOpts=types.map(t=>`<option value="${t}">${t}</option>`).join('');
  openModal('录一条申论得分',`
    <label class="field-label">题型</label>
    <select class="field" id="ssType">${typeOpts}</select>
    <div style="margin-top:10px;"><label class="field-label">得分（可填 "12" 或 "18/25"，推荐带满分）</label>
      <input type="text" class="field" id="ssScore" placeholder="如 18/25"></div>
    <div style="margin-top:10px;"><label class="field-label">这篇做了什么（可选）</label>
      <input type="text" class="field" id="ssLabel" placeholder="如 2026国考地市级第1题"></div>
    <div style="margin-top:6px;font-size:12px;color:var(--text-light);">带满分的记录才能算得分率；只填整数会当满分 100 折算。</div>
    <div class="row" style="justify-content:flex-end;margin-top:14px;">
      <button class="btn btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn" id="ssSave">保存</button>
    </div>`);
  const saveBtn=$('#ssSave');
  if(!saveBtn)return;
  saveBtn.addEventListener('click',()=>{
    const type=$('#ssType').value;
    const score=($('#ssScore').value||'').trim();
    const label=($('#ssLabel').value||'').trim();
    if(!score){toast('请填得分');return;}
    // 校验格式：整数 或 数字/数字
    const v=score.replace(/\s+/g,'');
    const ok=/^\d+(\.\d+)?(\/\d+(\.\d+)?)?$/.test(v);
    if(!ok){toast('得分格式不对：填 "12" 或 "18/25"');return;}
    // 记录当前模块和页内tab，保存后恢复（避免 addShenlunReview 内 render() 跳错页面）
    const _curTab=currentTab;
    const _curPageTab=document.querySelector('.page-tab.active')?.dataset.k;
    addShenlunReview({type,score,label,origin:'手动',conclusion:'（手动录入）'});
    closeModal(); // 保存成功后关闭弹窗（否则需手动 ×/取消）
    if(_curTab&&currentTab!==_curTab)goTab(_curTab);
    if(_curPageTab)setTimeout(()=>{const t=document.querySelector('.page-tab[data-k="'+_curPageTab+'"]');if(t)t.click();},30);
    toast('已录入：'+type+' '+score);
    /* 设了申论得分率目标：页面恢复后再弹「本次 vs 目标」（modal 独立于 render，但要等 goTab/页内 tab 恢复完） */
    setTimeout(()=>showShenlunGoalCompare(score,type),90);
  });
}
/* 给一条记录标注/修改题型 */
function setShenlunType(id){
  const r=(state.shenlunReviews||[]).find(x=>x.id===id);if(!r)return;
  const types=SHENLUN_TYPES||['大作文'];
  const typeOpts=types.map(t=>`<option value="${t}" ${r.type===t?'selected':''}>${t}</option>`).join('');
  openModal('标记题型',`
    <p style="font-size:13px;color:var(--text-sub);margin:0 0 10px;">把这条记录归到哪个题型？标记后会计入该题型的得分率统计。</p>
    <select class="field" id="stType">${typeOpts}</select>
    <div class="row" style="justify-content:flex-end;margin-top:14px;">
      <button class="btn btn-ghost" id="stClear" style="margin-right:auto;">清除题型</button>
      <button class="btn btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn" id="stSave">保存</button>
    </div>`);
  const saveBtn=$('#stSave');
  if(saveBtn)saveBtn.addEventListener('click',()=>{r.type=$('#stType').value;r.mts=Date.now();save();render();closeModal();toast('已标记题型：'+r.type);});
  const clr=document.getElementById('stClear');
  if(clr)clr.addEventListener('click',()=>{delete r.type;r.mts=Date.now();save();render();closeModal();toast('已清除题型');});
}
function openShenlunReviewDetail(id){
  const r=(state.shenlunReviews||[]).find(x=>x.id===id);if(!r)return;
  const pts=(r.points||[]).map(p=>`<div class="slr-li">• ${escapeHtml(p)}</div>`).join('')||'<div class="muted" style="margin:0;">—</div>';
  const adv=(r.advice||[]).map(a=>`<div class="slr-li">• ${escapeHtml(a)}</div>`).join('')||'<div class="muted" style="margin:0;">—</div>';
  openModal('申论批改详情',`
    <div class="slr-detail">
      <div class="slr-d-meta">${r.date||''}${r.teacher?' · '+escapeHtml(r.teacher)+'方法批改':''}</div>
      ${r.label?`<div class="slr-d-label">${escapeHtml(r.label)}</div>`:''}
      ${r.type?`<div class="slr-d-sec">题型</div><div class="slr-d-body">${escapeHtml(r.type)}</div>`:''}
      ${r.score?`<div class="slr-d-score">参考得分 <b>${escapeHtml(r.score)}</b></div>`:''}
      <div class="slr-d-sec">总评</div><div class="slr-d-body">${escapeHtml(r.conclusion||'')}</div>
      <div class="slr-d-sec">失分点</div><div class="slr-d-body">${pts}</div>
      <div class="slr-d-sec">改进建议</div><div class="slr-d-body">${adv}</div>
      ${r.origin?`<div class="slr-d-sec">备注</div><div class="slr-d-body muted">${escapeHtml(r.origin)}</div>`:''}
    </div>`);
}
/* 写入一条批改记录（由豆包批改后调用；也兼容手工录入） */
function addShenlunReview(d){
  if(!state.shenlunReviews)state.shenlunReviews=[];
  const rec=Object.assign({id:uid(),date:todayStr(),type:'',label:'',teacher:'',score:'',conclusion:'',points:[],advice:[],origin:'',mts:Date.now()},d||{});
  state.shenlunReviews.unshift(rec);
  /* 申论录分 → 自动完成同模块未完成待办（申论按「条」计，录一条算完成一次练习；优先匹配文本含题型的） */
  const typ=(rec.type||'').toString();
  const cand=(state.todos||[]).filter(t=>t.section==='shenlun'&&!t.done);
  const match=typ?(cand.find(t=>t.text&&t.text.indexOf(typ)>=0)||cand[0]):cand[0];
  if(match){
    const _r=completeTodoOnce(match);
    if(_r.completed)setTimeout(()=>toast('已自动完成申论待办：'+(match.text||'')),600);
  }
  save();render();
  return state.shenlunReviews[0].id;
}
function delShenlunReview(id){
  state.shenlunReviews=(state.shenlunReviews||[]).filter(x=>x.id!==id);markEntityDeleted('shenlunReview',[id]);
  save();render();
}

/* ============================================================
   复盘（合并页）：总结 + 复盘 合一
   主子 tab：数据概览 / 行测复盘 / 套卷
   ============================================================ */

/* 申论批改的「平均得分率」：按 parseShenlunScore 统一解析，折算成 0~100 */
/* 申论得分统一解析（雷达 / 首页建议 / 题型薄弱三处必须共用，避免两处口径打架）：
   - 18/25、"18 / 25"、前后带文字（如"大作文 45/60"）都能识别
   - 纯整数按满分 100 折算
   - 含数字但非分数字符串（如"第3题"）不再误当成 3 分
   返回 {got,full,rate}，无法解析返回 null */
function parseShenlunScore(raw){
  const s=String(raw==null?'':raw).trim();
  if(!s)return null;
  let m=s.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if(m){
    const got=parseFloat(m[1]),full=parseFloat(m[2]);
    if(!(full>0))return null;
    return {got:got,full:full,rate:Math.min(100,Math.round(got/full*100))};
  }
  m=s.match(/^(\d+(?:\.\d+)?)$/);
  if(m)return {got:parseFloat(m[1]),full:100,rate:Math.min(100,Math.round(parseFloat(m[1])))};
  return null;
}
function getShenlunScoreRate(){
  const list=state.shenlunReviews||[];
  let sum=0,n=0;
  list.forEach(r=>{
    const p=parseShenlunScore(r&&r.score);
    if(!p)return;
    sum+=p.rate;n++;
  });
  return {rate:n>0?Math.round(sum/n):null,n,total:list.length};
}

/* 纯内联 SVG 六维能力雷达（不引任何外部库，铁律 3）。
   dims[i].value = 实际正确率（紫实线多边形）；dims[i].target = 目标正确率（绿虚线，可空） */
function drawRadar(dims){
  const N=dims.length;
  const size=300,cx=150,cy=150,R=100;
  const levels=[0.2,0.4,0.6,0.8,1.0];
  const ang=i=>(-90+i*360/N)*Math.PI/180;
  let svg=`<svg viewBox="0 0 ${size} ${size}" class="radar-svg" role="img" aria-label="六维能力雷达">`;
  levels.forEach(lv=>{
    let pts=[];
    for(let i=0;i<N;i++){const a=ang(i);pts.push((cx+R*lv*Math.cos(a)).toFixed(1)+','+(cy+R*lv*Math.sin(a)).toFixed(1));}
    svg+=`<polygon points="${pts.join(' ')}" fill="none" stroke="#e6e2f5" stroke-width="1"/>`;
  });
  for(let i=0;i<N;i++){
    const a=ang(i),ex=cx+R*Math.cos(a),ey=cy+R*Math.sin(a);
    svg+=`<line x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#e6e2f5" stroke-width="1"/>`;
    const lx=cx+(R+26)*Math.cos(a),ly=cy+(R+26)*Math.sin(a);
    let anchor='middle';const c=Math.cos(a);
    if(c>0.3)anchor='start';else if(c<-0.3)anchor='end';
    const v=dims[i].value;const vtxt=v==null?'—':v+'%';
    svg+=`<text x="${lx.toFixed(1)}" y="${(ly-2).toFixed(1)}" text-anchor="${anchor}" font-size="12" font-weight="600" fill="#5b5470">${dims[i].label}</text>`;
    svg+=`<text x="${lx.toFixed(1)}" y="${(ly+11).toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="#9b93b5">${vtxt}</text>`;
  }
  /* 目标层：绿色虚线。某轴没设目标时跳过该点，只把相邻两个都有目标的轴连起来（不会抄近路穿心） */
  const tpt=i=>{const a=ang(i);const t=dims[i].target;return {x:cx+R*t/100*Math.cos(a),y:cy+R*t/100*Math.sin(a)};};
  for(let i=0;i<N;i++){
    const j=(i+1)%N;
    if(dims[i].target!=null&&dims[j].target!=null){
      const p1=tpt(i),p2=tpt(j);
      svg+=`<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="#2bb673" stroke-width="1.6" stroke-dasharray="4 3" opacity="0.85"/>`;
    }
  }
  for(let i=0;i<N;i++){
    if(dims[i].target==null)continue;
    const p=tpt(i);
    svg+=`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#fff" stroke="#2bb673" stroke-width="1.8"/>`;
  }
  let dpts=[];
  for(let i=0;i<N;i++){const a=ang(i);const v=(dims[i].value==null?0:dims[i].value);dpts.push((cx+R*v/100*Math.cos(a)).toFixed(1)+','+(cy+R*v/100*Math.sin(a)).toFixed(1));}
  svg+=`<polygon points="${dpts.join(' ')}" fill="rgba(124,108,217,0.18)" stroke="#7c6cd9" stroke-width="2" stroke-linejoin="round"/>`;
  for(let i=0;i<N;i++){const a=ang(i);const v=(dims[i].value==null?0:dims[i].value);const px=cx+R*v/100*Math.cos(a),py=cy+R*v/100*Math.sin(a);svg+=`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="#7c6cd9"/>`;}
  svg+=`</svg>`;
  return svg;
}

/* 六维能力雷达卡：行测5类正确率 + 申论批改得分率；目标层来自「我的目标」weakTargets */
function renderCapabilityRadar(){
  const wt=state.weakTargets||{};
  const dims=[
    {key:'yanyu',label:'言语'},{key:'luoji',label:'判断'},{key:'ziliao',label:'资料'},
    {key:'shuliang',label:'数量'},{key:'changshi',label:'政常'}
  ];
  dims.forEach(d=>{
    let v=getModuleAccuracy(d.key);
    if(d.key==='yanyu'&&v!=null)v=Math.min(100,v+10); // 用户要求：言语正确率显示值调高一点，避免和政常轴在雷达上点太近（仅雷达显示用，不动真实数据）
    d.value=v;
    d.target=(wt[d.key]!=null)?wt[d.key]:null;
  });
  const sl=getShenlunScoreRate();
  dims.push({key:'shenlun',label:'申论',value:sl.rate,target:(wt.shenlun!=null)?wt.shenlun:null});
  const hasTarget=dims.some(d=>d.target!=null);
  const legend=`<span class="trend-legend"><i style="background:#7c6cd9"></i>实际${hasTarget?'<i style="background:#2bb673"></i>目标':''}</span>`;
  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>六维能力雷达${legend} ${hmark(hasTarget?'紫=实际正确率，绿虚线=目标（去「我的→目标」设置）':'行测5类正确率 + 申论批改得分率；设了目标会叠加绿色虚线')}</div>`;
  card.innerHTML+=drawRadar(dims);
  return card;
}

/* 申论题型得分率聚合：批改/手动记录按 type 归类，score → 0~100 得分率。
   返回 [{type,rate,n,recs}] 只含有数据的题型，按得分率升序（最弱在前）。 */
function shenlunTypeRates(){
  const list=state.shenlunReviews||[];
  const map={};   // type -> {sum,n}
  list.forEach(r=>{
    const typ=(r&&r.type)?String(r.type).trim():'';
    if(!typ)return;
    const p=parseShenlunScore(r&&r.score);
    if(!p)return;
    if(!map[typ])map[typ]={sum:0,n:0};
    map[typ].sum+=p.rate;map[typ].n++;
  });
  return Object.keys(map).map(typ=>({type:typ,rate:Math.round(map[typ].sum/map[typ].n),n:map[typ].n}))
    .sort((a,b)=>a.rate-b.rate||b.n-a.n);
}

/* 申论题型薄弱分析卡：按题型得分率看哪类最弱（放数据概览，跟雷达同一数据源） */
function renderShenlunWeakCard(){
  const card=el('div','card');
  const rates=shenlunTypeRates();
  const withRate=rates.filter(r=>r.n>0);
  const minSample=2;   // 少于 2 条样本的题型，给提示不下结论
  if(!withRate.length){
    card.innerHTML=`<div class="section-title"><span class="dot"></span>申论题型得分率 ${hmark('小题/大作文分题型看强弱 · 需给记录标记题型并填带满分得分')}</div>
      <div class="empty-tip" style="padding:18px 0;">还没有带题型 + 得分的申论记录。<br>去申论页把作文发我批改，或点「+ 录得分」手动记几题（记得带满分，如 18/25）。</div>`;
    return card;
  }
  // 得分率配色：越弱越红、中段黄、强绿
  const barColor=r=>r<55?'#E24B4A':(r<68?'#EF9F27':'#639922');
  const txtColor=r=>r<55?'#A32D2D':(r<68?'#854F0B':'#3B6D11');
  const rows=withRate.map(r=>{
    const flag=(r.n<minSample)?' · 样本不足':(withRate[0]===r?' · 最薄弱':'');
    return `<div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px;margin-bottom:4px;">
        <span style="font-weight:500;color:${txtColor(r.rate)}">${escapeHtml(r.type)}${flag}<span style="color:var(--text-light);font-weight:400;">（${r.n}篇）</span></span>
        <span style="font-weight:600;color:${txtColor(r.rate)}">${r.rate}%</span>
      </div>
      <div style="height:8px;border-radius:5px;background:var(--primary-soft);overflow:hidden;"><div style="width:${r.rate}%;height:100%;border-radius:5px;background:${barColor(r.rate)};transition:width .3s;"></div></div>
    </div>`;
  }).join('');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>申论题型得分率</div>
    <div style="margin-bottom:10px;">${rows}</div>`;
  return card;
}

function renderReview(c){
  // 包 try/catch 捕获 buildBlendModel 抛错并上抛 toast，便于现场排查
  var model;
  try{
    model=buildBlendModel();
  }catch(e1){
    console.error('buildBlendModel error:', e1);
    if(typeof toast==='function')toast('复盘数据出错：'+(e1.message||e1),'error',6000);
    // 仍继续渲染，确保子 tab 与历史等不依赖 model 的部分能用
  }
  const d=todayStr();
  const t=d;

  const gOverview=el('div','subtab-pane');
  gOverview.appendChild(renderPeriodReview()); // 学习数据概览（周期复盘合并）置顶
  const gType=el('div','subtab-pane');
  const gExam=el('div','subtab-pane');
  const gShenlun=el('div','subtab-pane');

  // 主子 tab 切换（仅切显隐，不重渲染，保留各 pane 内的输入/展开状态）
  function switchReviewMain(k){
    reviewMainTab=k;
    [gOverview,gType,gExam,gShenlun].forEach(p=>p.style.display='none');
    ({overview:gOverview,type:gType,exam:gExam,shenlun:gShenlun}[k]).style.display='';
    mtabs.querySelectorAll('.subtab').forEach(x=>x.classList.remove('active'));
    const act=mtabs.querySelector('.subtab[data-k="'+k+'"]');if(act)act.classList.add('active');
    // A3：把该 tab 的关键内容滚进视野，省得手动往下翻
    requestAnimationFrame(()=>{
      let tgt=null;
      if(k==='overview') tgt=gOverview.querySelector('#learningOverviewCard'); // 学习数据概览（顶部）
      else if(k==='type') tgt=gType.querySelector('.block-subtitle'); // 薄弱考点分析
      else if(k==='exam'){const b=gExam.querySelector('.blend-row');tgt=b?b.closest('.card'):gExam.querySelector('.card');}
      if(tgt)tgt.scrollIntoView({behavior:'smooth',block:'start'});
    });
  }

  // --- 数据概览：学习数据概览 + 正确率趋势（三线）---
  {

    // 六维能力雷达（行测5类 + 申论），能力快照

    // 申论题型薄弱（按题型得分率看哪类弱），雷达的申论轴是整体、这里是分题型明细
    gShenlun.appendChild(renderShenlunWeakCard());

    const WINDOW=14;
    const trendDates=model.dates.slice(-WINDOW);
    const trendLabels=trendDates.map(dd=>dd.slice(5).replace('-','/'));
    const accCard=el('div','card');
    accCard.id='reviewTrendCard';
    accCard.innerHTML=`<div class="section-title"><span class="dot"></span>正确率趋势<span class="trend-legend"><i style="background:#4a90d9"></i>平时<i style="background:#e8a33d"></i>套卷<i style="background:#2bb673"></i>综合</span></div>`;
    if(trendDates.length<2){
      accCard.innerHTML+=`<div class="empty-tip" style="padding:22px 0;">至少录入 2 天数据${hmark('平时刷题或套卷')}后才会显示趋势曲线</div>`;
    }else{
      const series=[
        {data:trendDates.map(dd=>model.dailyRate[dd]),color:'#4a90d9',label:'平时'},
        {data:trendDates.map(dd=>model.examRate[dd]),color:'#e8a33d',label:'套卷'},
        {data:trendDates.map(dd=>model.blendedRate[dd]),color:'#2bb673',label:'综合'}
      ];
      accCard.innerHTML+=drawLineChart(series,trendLabels,'%');
    }
    gOverview.appendChild(accCard);
    gOverview.appendChild(renderCapabilityRadar());
  }

  // --- 数据概览：综合正确率 + 刷题记录（套卷+每日刷题的合并视角）---
  {
    const ov=model.overall;
    const fR=v=>v!=null?Math.round(v*100)+'%':'—';
    const blendedAll=ov.exam.t+ov.daily.t>0?(ov.exam.c+ov.daily.c)/(ov.exam.t+ov.daily.t):null;
    const examAll=ov.exam.t>0?ov.exam.c/ov.exam.t:null;
    const dailyAll=ov.daily.t>0?ov.daily.c/ov.daily.t:null;
    const sumCard=el('div','card');
    sumCard.innerHTML=`<div class="section-title"><span class="dot"></span>综合正确率</div>
      <div class="blend-row">
        <div class="blend-cell"><div class="blend-num" style="color:#2bb673">${fR(blendedAll)}</div><div class="blend-lbl">综合</div></div>
        <div class="blend-cell"><div class="blend-num" style="color:#e8a33d">${fR(examAll)}</div><div class="blend-lbl">套卷</div></div>
        <div class="blend-cell"><div class="blend-num" style="color:#4a90d9">${fR(dailyAll)}</div><div class="blend-lbl">平时</div></div>
      </div>`;
    gOverview.appendChild(sumCard);
  }
  gOverview.appendChild(renderOvertimeTips());
  gOverview.appendChild(renderExamLogCard(model));

  // --- 行测复盘：题型看板 + 薄弱分析 + 下一步建议 ---
  gType.appendChild(renderTypeWeakCard(model));

  // --- 套卷：套卷速览 + 成绩趋势 + 套卷记录（只套卷，不掺每日刷题）---
  gExam.appendChild(renderExamOverviewCard(model));
  gExam.appendChild(renderExamTrendCard());
  gExam.appendChild(renderExamOnlyCard());


  // ===== 月度打卡日历（点某天看当天详情）=====
  c.appendChild(renderCalendar());

  // ===== 主子 tab 栏 =====
  const mtabs=el('div','subtabs review-mtabs');
  [['overview','综合'],['type','行测'],['shenlun','申论'],['exam','套卷']].forEach(([k,label])=>{
    const b=el('button','subtab'+(reviewMainTab===k?' active':''));
    b.dataset.k=k;b.textContent=label;
    b.addEventListener('click',()=>switchReviewMain(k));
    mtabs.appendChild(b);
  });
  c.appendChild(mtabs);
  c.appendChild(gOverview);c.appendChild(gType);c.appendChild(gShenlun);c.appendChild(gExam);
  [gOverview,gType,gExam,gShenlun].forEach(p=>p.style.display='none');
  ({overview:gOverview,type:gType,exam:gExam,shenlun:gShenlun}[reviewMainTab]).style.display='';
  // 渲染 4 主 tab 内容并激活 reviewMainTab
}

/* 统一的「今日数据」概览卡片：首页 / 每日计划 / 复盘 三处共用，避免同数据多套名字 */
/* 按「题」记的模块才算进做题总数和正确率（申论记篇、晨读记次，不混进来） */
function isQSec(sec){return ((CHECKIN_UNIT&&CHECKIN_UNIT[sec])||'题')==='题';}
/* ============================================================
   我的
   ============================================================ */
/* ---------- 导入数据预览与执行 ---------- */
const IMPORT_MODULE_NAMES={
  maoQuotes:'毛选金句',idioms:'成语辨析',shiciPairs:'实词辨析',idiomWords:'成语积累',shiciWords:'实词积累',
  politicsNews:'时政热点',politicsQuestions:'政治理论挖空题',
  changshi:'常识条目',quant:'数量关系题型',dataFormulas:'资料分析公式',
  shenlunDazuowen:'申论大作文主题',
  luojiNotes:'判断推理笔记'
};
function showImportPreview(data,fileName){
  const cd=data.customData||{};
  const cdKeys=Object.keys(IMPORT_MODULE_NAMES);
  let customRows='';
  let customTotal=0;
  cdKeys.forEach(k=>{
    if(Array.isArray(cd[k])&&cd[k].length>0){
      customRows+=`<div class="detail-row"><span class="grow">${IMPORT_MODULE_NAMES[k]}</span><span style="font-weight:700;color:var(--primary);">${cd[k].length} 条</span></div>`;
      customTotal+=cd[k].length;
    }
  });
  // 其他数据统计
  let otherRows='';
  const otherFields=[
    ['studyRecords','学习记录'],
    ['todos','待办事项'],['summaries','学习总结'],
    ['dailyStats','每日统计'],['examDates','考试日期'],
    ['examRecords','套卷复盘']
  ];
  otherFields.forEach(([k,name])=>{
    if(data[k]){
      const cnt=typeof data[k]==='object'?Object.keys(data[k]).length:0;
      if(cnt>0)otherRows+=`<div class="detail-row"><span class="grow">${name}</span><span style="font-weight:600;">${cnt} 条</span></div>`;
    }
  });
  let body=`<div class="muted" style="margin-bottom:12px;">文件：<b>${escapeHtml(fileName)}</b></div>`;
  if(customTotal>0){
    body+=`<div class="section-title" style="font-size:14px;margin-bottom:8px;">将导入以下自定义内容（追加到对应模块）</div>${customRows}`;
  }else{
    body+=`<div class="muted" style="margin-bottom:10px;">未检测到自定义内容（成语/试题/常识等）</div>`;
  }
  if(otherRows){
    body+=`<div class="section-title" style="font-size:14px;margin:14px 0 8px;">同时包含以下数据（将合并覆盖）</div>${otherRows}`;
  }
  body+=`<div class="row" style="justify-content:flex-end;margin-top:18px;gap:8px;">
    <button class="btn btn-ghost btn-sm" onclick="closeModal()">取消</button>
    <button class="btn btn-sm" id="confirmImportBtn">确认导入</button></div>`;
  openModal('导入数据预览',body);
  $('#confirmImportBtn').addEventListener('click',()=>{doImport(data);});
}
function doImport(data){
  // 结构校验：确保导入的数据是合法的对象
  if(!data||typeof data!=='object'||Array.isArray(data)){
    toast('导入失败：文件格式不正确，不是有效的数据文件。');
    return;
  }
  // 检查是否包含至少一个可识别的字段
  const validFields=['version','examDates','studyRecords','todos','summaries','dailyStats','customData','userProfile','courses'];
  const hasValidField=validFields.some(k=>data[k]!==undefined);
  if(!hasValidField){
    toast('导入失败：未找到可识别的数据字段，请确认是从本应用导出的文件。');
    return;
  }
  // 校验 customData 结构
  if(data.customData&&typeof data.customData==='object'){
    Object.keys(data.customData).forEach(k=>{
      if(!Array.isArray(data.customData[k])){
        delete data.customData[k]; // 非法字段直接忽略
      }
    });
  }
  // 合并前先留一份本地快照作为去重基准。
  // 关键：不能先 Object.assign 再合并 —— 那样 state.todos/customData 已被导入数据整体覆盖，
  // 下面的去重基准会变成"导入数据自身"，导致本地数据静默丢失、去重计数恒为 0。
  const localTodos=Array.isArray(state.todos)?state.todos.slice():[];
  const localTT=Array.isArray(state.timetable)?state.timetable.slice():[];
  const localExams=Array.isArray(state.exams)?state.exams.slice():[];
  const localCourses=Array.isArray(state.courses)?state.courses.slice():[];
  const localCustom={};
  Object.keys(state.customData||{}).forEach(k=>{
    if(Array.isArray(state.customData[k]))localCustom[k]=state.customData[k].slice();
  });
  const importCustom=(data.customData&&typeof data.customData==='object')?data.customData:null;
  // 待办可能有两种形态：现版本是数组，老版本是按日期分组的对象 —— 后者需先展开，
  // 否则旧备份的待办会被静默忽略（原来只认数组形态）
  let importTodos=null;
  if(Array.isArray(data.todos))importTodos=data.todos;
  else if(data.todos&&typeof data.todos==='object'){
    importTodos=[];
    Object.keys(data.todos).forEach(date=>{
      (data.todos[date]||[]).forEach(function(item){
        if(!item||typeof item!=='object')return;
        importTodos.push({
          id:item.id||uid(),
          text:item.text||'',
          dueDate:(item.dueDate!=null)?item.dueDate:(/^\d{4}-\d{2}-\d{2}$/.test(date)?date:todayStr()),
          section:item.section||'',
          done:!!item.done,
          ts:item.ts||Date.now()
        });
      });
    });
  }
  // 待合并字段先剔除，避免被整体覆盖
  const plain=Object.assign({},data);
  delete plain.todos;delete plain.customData;delete plain.timetable;delete plain.courses;
  state=Object.assign(state,plain,{version:DATA_VERSION});
  // 兜底：对象型字段用 {}，数组型字段用 []。
  // 注意 todos 是数组，误赋 {} 会让后续 (state.todos||[]).filter 抛 TypeError 导致白屏
  ['examDates','studyRecords','summaries','dailyStats'].forEach(k=>{
    if(!state[k]||typeof state[k]!=='object'||Array.isArray(state[k]))state[k]={};
  });
  if(!Array.isArray(state.todos))state.todos=[];
  if(!Array.isArray(state.examRecords))state.examRecords=[];
  if(!Array.isArray(state.courses))state.courses=[];
  if(!state.customData||typeof state.customData!=='object')state.customData={};
  if(!Array.isArray(state.exams)||!state.exams.length)state.exams=EXAMS.map(e=>({key:e.key,name:e.name,date:e.date}));
  if(!state.periodReviews||typeof state.periodReviews!=='object')state.periodReviews={};
  const cdKeys=Object.keys(IMPORT_MODULE_NAMES);
  cdKeys.forEach(k=>{if(!state.customData[k])state.customData[k]=[];});
  let dedupCount=0;
  if(importCustom){
    cdKeys.forEach(k=>{
      const incoming=Array.isArray(importCustom[k])?importCustom[k]:null;
      if(incoming&&incoming.length>0){
        // 去重：以本地快照为基准，有id按id去重，无id按内容JSON去重
        const existing=(localCustom[k]&&localCustom[k].length)?localCustom[k].slice():(Array.isArray(state.customData[k])?state.customData[k].slice():[]);
        const existingIds=new Set(existing.map(x=>x.id).filter(Boolean));
        const existingContent=new Set(existing.map(x=>JSON.stringify(x)));
        const newItems=data.customData[k].filter(x=>{
          if(x.id&&existingIds.has(x.id)){dedupCount++;return false;}
          if(existingContent.has(JSON.stringify(x))){dedupCount++;return false;}
          return true;
        });
        state.customData[k]=existing.concat(newItems);
      }
    });
  }
  // 待办也按 id 去重，同样以本地快照为基准合并
  if(importTodos&&importTodos.length>0){
    const existingIds=new Set(localTodos.map(x=>x&&x.id).filter(Boolean));
    const newTodos=importTodos.filter(x=>{
      if(x&&x.id&&existingIds.has(x.id)){dedupCount++;return false;}
      return true;
    });
    /* 导入旧备份时，已被删除的待办不能「复活」：按当前墓碑过滤一遍 */
    const _delMap=collectDeletedTodos(state.deletedTodoIds,[]);
    state.todos=localTodos.concat(newTodos).filter(function(x){
      const dt=_delMap.get(x&&x.id);
      return !(dt!=null&&dt>(x.mts||0));
    });
  }
  // 课表也按 id 并集合并（本地 + 导入都保留；导入备份通常含全量课表，不做整体覆盖避免丢本地排课）
  const importTT=Array.isArray(data.timetable)?data.timetable:[];
  if(importTT.length){
    const ttIds=new Set((state.timetable||[]).map(x=>x&&x.id).filter(Boolean));
    const newTT=importTT.filter(x=>!(x&&x.id&&ttIds.has(x.id)));
    state.timetable=(state.timetable||[]).concat(newTT);
  }
  // 课表生成日志 ttTodoLog：key 并集，导入补缺
  if(data.ttTodoLog&&typeof data.ttTodoLog==='object'&&!Array.isArray(data.ttTodoLog)){
    if(!state.ttTodoLog||typeof state.ttTodoLog!=='object'||Array.isArray(state.ttTodoLog))state.ttTodoLog={};
    Object.keys(data.ttTodoLog).forEach(function(k){ if(state.ttTodoLog[k]==null)state.ttTodoLog[k]=data.ttTodoLog[k]; });
  }
  /* 课程按 id 并集合并：同 id 的课程保留本地（含已听进度），导入里的新 id 追加。
     修复：原来 courses 没从 plain 剔除，Object.assign 会用导入数据整体覆盖本地课程，
     导致本地已听进度丢失。done 数组不做并集（导入备份的 done 可能是旧的），以本地为准。 */
  const importCourses=Array.isArray(data.courses)?data.courses.filter(c=>c&&c.id):[];
  if(importCourses.length){
    const localIds=new Set(localCourses.map(c=>c&&c.id).filter(Boolean));
    const newCourses=importCourses.filter(c=>!localIds.has(c.id));
    if(newCourses.length)state.courses=(state.courses||[]).concat(newCourses);
  }
  // 考试定义按 key 并集：导入文件若只含旧数据，本地新增的自定义考试不会被覆盖丢失
  if(localExams.length&&Array.isArray(state.exams)){
    const exSeen=new Set(state.exams.map(x=>x&&x.key));
    localExams.forEach(function(x){ if(x&&x.key!=null&&!exSeen.has(x.key)){state.exams.push(x);exSeen.add(x.key);} });
  }
  // 导入后补跑迁移与数组守卫：老版本备份可能是对象形态 todos，
  // 启动时的守卫不会在导入后重跑，这里补一次避免 .filter 崩溃
  migrateTodos();ensureArrayList();
  // 关键：导入备份后，让「刚导入的完整数据」成为时间戳最新的数据源。
  // 否则本地 _syncTs 还是旧的（可能被污染成很低的值），另台开着的轮询一发现云端更高
  // 就会用旧/空数据把刚导入的覆盖掉 —— 这正是"导入了又被吞"的根源。
  state._syncTs=Date.now();
  save();closeModal();render();
  // 若已连同步，立刻把导入的完整数据推上云端，确立它为新数据源
  try{ if(getSyncCfg()) doPush(); }catch(e){}
  toast(dedupCount>0?`数据导入成功！已自动跳过 ${dedupCount} 条重复数据。`:'数据导入成功！');
}

/* ---------- 我的页面 ---------- */
function renderMine(c){
  c.id='mine';  // 给「我的」页容器加 id，供专属卡片样式作用域使用（仅本页，不动其他页）
  // 个人资料
  const p=state.userProfile||{};
  const pName=p.name||'局长';
  const avatarContent=p.avatar?`<img src="${escapeHtml(p.avatar)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;">`:escapeHtml(pName.charAt(0));
  const pCard=el('div','card profile-card');
  pCard.innerHTML=`
    <div class="profile-row">
      <div class="profile-avatar">${avatarContent}</div>
      <div class="profile-info grow">
        <div class="profile-name">${escapeHtml(pName)}</div>
        <div class="profile-signature">${escapeHtml(p.signature||'')}</div>
      </div>
      <button class="icon-btn" id="editProfileBtn" title="编辑资料" aria-label="编辑资料">${icon('edit')}</button>
    </div>`;
  c.appendChild(pCard);
  $('#editProfileBtn').addEventListener('click',openProfileEditor);

  // 使用说明：点击弹出屏幕居中弹窗（不再内联展开）
  const GUIDE_BODY=`<div class="guide-list">
    <div class="guide-item"><b>怎么切页面</b> 手机端底部 5 个 tab（首页 / 笔记 / 课程 / 数据 / 我的）直接切换；左上角 ☰ 抽屉菜单进各模块页（言语、判断、资料…）。电脑端用左侧栏。</div>
    <div class="guide-item"><b>首页</b> 从上到下：速览三数字（距考试 / 今日完成 / 今日刷题）、待复习、今日任务（可打勾）、今日汇总（各模块打卡 / 记一笔）、考试倒计时与下一步建议。</div>
    <div class="guide-item"><b>笔记</b> 各模块学习页（言语 / 判断 / 资料 / 数量 / 常识 / 申论小题 / 大作文），分科刷题、记薄弱点、设目标；进具体模块后点顶栏搜索键可搜索素材。</div>
    <div class="guide-item"><b>课程</b> 管理网课：添加课程、记录进度，听完一讲会自动完成对应「网课」待办，并计入今日汇总。</div>
    <div class="guide-item"><b>数据</b> 月度打卡日历（点某天看当天学习详情）、六维能力雷达、行测复盘、套卷表现、申论题型得分率。</div>
    <div class="guide-item"><b>待办</b> 分「刷题」「网课」「记笔记」三类：刷题填题量，录够题量自动完成；网课不填题量，去课程页听完一讲自动完成；记笔记不填题量，点击直接去学习页记录。重复任务按周期滚动。</div>
    <div class="guide-item"><b>今日汇总</b> 每练完一项点「记一笔」录入题量和正确率（可填 70 或 14/20）；有子模块可逐项填，自动汇总到整体；学习时长番茄钟会自动带入，可改。</div>
    <div class="guide-item"><b>番茄钟</b> 在模块页点专注开始，按「我的目标」时长预设；计时结束自动记入当日时长。</div>
    <div class="guide-item"><b>我的</b> 个人资料、学习概览、目标设置、数据备份与云端同步。</div>
  </div>`;
  const guide=el('div','card guide-card');
  guide.innerHTML=`<div class="section-title guide-toggle" id="guideToggle" role="button" tabindex="0"><span class="dot"></span>使用说明 <span class="guide-caret">查看 ›</span></div>`;
  guide.querySelector('#guideToggle').addEventListener('click',()=>openModal('使用说明',GUIDE_BODY,'modal-center'));

  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>学习概览</div>`;
  // 学习天数：只统计有实际学习记录的日期（番茄钟记录 或 题量>0的打卡）
  const validDates=new Set();
  Object.keys(state.studyRecords||{}).forEach(d=>{
    const r=state.studyRecords[d]||{};
    if((r.sessions||[]).length>0)validDates.add(d);
  });
  Object.keys(state.dailyStats||{}).forEach(d=>{
    const day=state.dailyStats[d]||{};
    const hasCount=Object.values(day).some(s=>(s.count||0)>0);
    if(hasCount)validDates.add(d);
  });
  const learnDays=validDates.size;
  const totalMin=[...validDates].reduce((a,d)=>a+dayTotalMin(d),0);
  const totalQuestions=Object.values(state.dailyStats||{}).reduce((a,ds)=>a+Object.values(ds).reduce((b,s)=>b+(s.count||0),0),0);
  const stat=el('div','mine-stat');
  stat.innerHTML=`
    <div class="ms-cell"><div class="ms-num">${learnDays}</div><div class="ms-label">学习天数</div></div>
    <div class="ms-cell"><div class="ms-num">${(totalMin/60).toFixed(1)}h</div><div class="ms-label">累计学习</div></div>
    <div class="ms-cell"><div class="ms-num">${totalQuestions}</div><div class="ms-label">累计做题</div></div>`;
  card.appendChild(stat);
  c.appendChild(card);

  // 我的目标（正确率 + 专注时长，合并到一行；始终显示；大类可展开子模块）
  const tcard=el('div','card');
  tcard.innerHTML=`<div class="section-title"><span class="dot"></span>我的目标 ${hmark('点任意一项设置：行测三项（正确率/时长/题量）一起填，时长÷题量=每题标准速度；大类可展开子模块')}</div>`;
  const tlist=el('div','mine-target-list');
  const wt=state.weakTargets||{};
  const dt=state.durTargets||{};
  const ct=state.countTargets||{};
  let anySet=false;
  // 目标页大类顺序：政治常识、言语理解、数量关系、判断推理、资料分析（子模块随大类）
  const TARGET_TYPES_ORDER=['政治常识','言语','数量关系','判断推理','资料分析'];
  const targetTypes=TARGET_TYPES_ORDER.map(k=>EXAM_TYPES.find(t=>t.key===k)).filter(Boolean);
  targetTypes.forEach(t=>{
    const wAcc=getModuleAccuracy(t.key);
    const dKey=ET_TO_SEC[t.key];
    const wHas=wt[dKey]!=null; if(wHas)anySet=true;
    const wDiff=(wAcc!=null&&wHas)?(wt[dKey]-wAcc):null;
    const dHas=dt[dKey]!=null; if(dHas)anySet=true;
    const cHas=ct[dKey]!=null; if(cHas)anySet=true;
    const hasSubs=!!(t.subs&&t.subs.length)&&!t.goalNoSubs;
    const mrow=el('div','mt-row mt-main'+(hasSubs?' mt-expandable':''));
    mrow.innerHTML=`
      <div class="mt-toggle">
        <span class="mt-name">${escapeHtml(t.name)}</span>
        ${hasSubs?'<span class="mt-caret">▸</span>':''}
      </div>
      <div class="mt-pills">
        <button class="mt-pill${wHas?' is-set':''}" data-weak="${dKey}" data-n="${escapeHtml(t.name)}">
          <span class="mt-pill-label">正确率</span>
          <span class="mt-pill-val">${wHas?('<b>'+wt[dKey]+'%</b>'):'设'}</span>
        </button>
        <button class="mt-pill${dHas?' is-set':''}" data-dur="${dKey}" data-n="${escapeHtml(t.name)}">
          <span class="mt-pill-label">时长</span>
          <span class="mt-pill-val">${dHas?('<b>'+dt[dKey]+'分</b>'):'设'}</span>
        </button>
        <button class="mt-pill${cHas?' is-set':''}" data-count="${dKey}" data-n="${escapeHtml(t.name)}">
          <span class="mt-pill-label">题量</span>
          <span class="mt-pill-val">${cHas?('<b>'+ct[dKey]+'题</b>'):'设'}</span>
        </button>
      </div>`;
    tlist.appendChild(mrow);
    if(hasSubs){
      const subWrap=el('div','mt-subs');
      subWrap.style.display='none';
      t.subs.forEach(sub=>{
        const sAcc=getModuleAccuracy(sub.key);
        const sHas=wt[sub.key]!=null; if(sHas)anySet=true;
        const sDiff=(sAcc!=null&&sHas)?(wt[sub.key]-sAcc):null;
        const sdHas=dt[sub.key]!=null; if(sdHas)anySet=true;
        const scHas=ct[sub.key]!=null; if(scHas)anySet=true;
        const srow=el('div','mt-row mt-subrow');
        srow.innerHTML=`
          <div class="mt-toggle"><span class="mt-name">${escapeHtml(sub.name)}</span></div>
          <div class="mt-pills">
            <button class="mt-pill${sHas?' is-set':''}" data-weak="${sub.key}" data-n="${escapeHtml(sub.name)}">
              <span class="mt-pill-label">正确率</span>
              <span class="mt-pill-val">${sHas?('<b>'+wt[sub.key]+'%</b>'):'设'}</span>
            </button>
            <button class="mt-pill${sdHas?' is-set':''}" data-dur="${sub.key}" data-n="${escapeHtml(sub.name)}">
              <span class="mt-pill-label">时长</span>
              <span class="mt-pill-val">${sdHas?('<b>'+dt[sub.key]+'分</b>'):'设'}</span>
            </button>
            <button class="mt-pill${scHas?' is-set':''}" data-count="${sub.key}" data-n="${escapeHtml(sub.name)}">
              <span class="mt-pill-label">题量</span>
              <span class="mt-pill-val">${scHas?('<b>'+ct[sub.key]+'题</b>'):'设'}</span>
            </button>
          </div>`;
        subWrap.appendChild(srow);
      });
      tlist.appendChild(subWrap);
      mrow.querySelector('.mt-toggle').addEventListener('click',()=>{
        const open=subWrap.style.display!=='none';
        subWrap.style.display=open?'none':'block';
        mrow.classList.toggle('mt-open',!open);
        const caret=mrow.querySelector('.mt-caret');
        if(caret)caret.style.transform=open?'':'rotate(90deg)';
      });
    }
  });
  /* 申论：只有「得分率」目标（没有时长/题量概念；存在 weakTargets.shenlun） */
  (function(){
    const k='shenlun';
    const sHas=wt[k]!=null; if(sHas)anySet=true;
    const srow=el('div','mt-row mt-main');
    srow.innerHTML=`
      <div class="mt-toggle"><span class="mt-name">申论</span></div>
      <div class="mt-pills">
        <button class="mt-pill${sHas?' is-set':''}" data-weak="${k}" data-n="申论" data-sl="1">
          <span class="mt-pill-label">得分率</span>
          <span class="mt-pill-val">${sHas?('<b>'+wt[k]+'%</b>'):'设'}</span>
        </button>
      </div>`;
    tlist.appendChild(srow);
  })();
  if(!anySet){
    const hint=el('div','mine-target-hint');
    hint.textContent='尚未设置任何目标——点任意「设」即可在此设置（正确率 / 专注时长）';
    tlist.appendChild(hint);
  }
  tcard.appendChild(tlist);
  c.appendChild(tcard);
  /* 所有目标 pill 统一打开同一个弹窗（行测三必填 / 申论仅得分率，弹窗内按模块自适应） */
  tcard.querySelectorAll('.mt-pill[data-weak],.mt-pill[data-dur],.mt-pill[data-count]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openTargetModal(b.dataset.weak||b.dataset.dur||b.dataset.count);}));

  // 打卡分类（勾选哪些模块参与今日汇总 / 打卡）
  const catCard=el('div','card');
  catCard.innerHTML=`<div class="section-title"><span class="dot"></span>打卡分类 <span class="muted-tip">参与今日汇总的模块</span></div>
    <div class="row"><button class="btn btn-ghost btn-sm" id="openCatSettingsBtn">${icon('list')} 管理打卡分类</button></div>`;
  c.appendChild(catCard);
  const catBtn=$('#openCatSettingsBtn'); if(catBtn)catBtn.addEventListener('click',openCheckinCatSettings);

  // 数据管理
  const card2=el('div','card');
  card2.innerHTML=`<div class="section-title"><span class="dot"></span>数据管理 ${hmark('数据自动保存于本设备。导出可备份，导入可从备份文件恢复（将合并覆盖当前数据）。清空将删除全部数据并恢复到初始状态（云端同步配置保留）。')}</div>`;
  const row=el('div','row wrap');
  const exportBtn=el('button','btn btn-ghost btn-sm');exportBtn.innerHTML=`${icon('upload')} 导出数据`;
  exportBtn.addEventListener('click',()=>{
    // 导出时删除敏感信息（云端同步令牌/Key）
    const exportData=JSON.parse(JSON.stringify(state));
    delete exportData._syncCfg;
    delete exportData.pomo;  // 番茄钟运行态：导出冗余，不携带
    const syncCfg=getSyncCfg();
    if(syncCfg&&(syncCfg.apiKey||syncCfg.token)){
      // 如果同步配置存在于其他字段，也删除
      Object.keys(exportData).forEach(k=>{
        if(exportData[k]&&(exportData[k].apiKey||exportData[k].token))delete exportData[k].apiKey;
      });
    }
    const blob=new Blob([JSON.stringify(exportData,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`云工作台_${todayStr()}.json`;a.click();
  });
  const importBtn=el('button','btn btn-ghost btn-sm');importBtn.innerHTML=`${icon('download')} 导入数据`;
  importBtn.addEventListener('click',()=>{
    const inp=document.createElement('input');inp.type='file';inp.accept='.json,application/json';
    inp.style.display='none';document.body.appendChild(inp);
    inp.addEventListener('change',()=>{
      const f=inp.files[0];
      if(inp.parentNode)inp.parentNode.removeChild(inp);
      if(!f)return;
      const r=new FileReader();
      r.onload=()=>{
        try{
          const data=JSON.parse(r.result);
          showImportPreview(data,f.name);
        }catch(e){
          toast('导入失败：文件格式不正确，请选择从本应用导出的 JSON 文件。');
        }
      };
      r.readAsText(f);
    });
    inp.click();
  });
  row.appendChild(exportBtn);row.appendChild(importBtn);
  const restoreBtn=el('button','btn btn-ghost btn-sm');restoreBtn.innerHTML=`${icon('reset')} 恢复内置内容`;
  restoreBtn.addEventListener('click',()=>{
    const total=Object.values(state.deletedBuiltin||{}).reduce((a,arr)=>a+arr.length,0);
    if(total===0){toast('没有已删除的内置内容');return;}
    uiConfirm(`确定恢复全部 ${total} 条已删除的内置内容？`,()=>{
      state.deletedBuiltin={};
      save();render();
      toast('已恢复全部内置内容');
    },{danger:true});
  });
  row.appendChild(restoreBtn);
  const clearBtn=el('button','btn btn-danger btn-sm');
  clearBtn.innerHTML=`${icon('trash')} 清空数据`;
  clearBtn.addEventListener('click',()=>{
    uiConfirm('此操作将清空全部本地数据（打卡、复盘、待办、题库内容等），恢复到初始状态，且不可恢复。确定继续？',()=>{
      uiConfirm('最后确认：真的要清空所有数据吗？',()=>{
        window.__CLEARING=true; // 标记清空中，阻止 beforeunload/pagehide 的 persistPomo 写回旧数据
        try{localStorage.removeItem(STORE_KEY);}catch(e){}
        location.reload();
      },{danger:true});
    },{danger:true});
  });
  row.appendChild(clearBtn);
  card2.appendChild(row);
  c.appendChild(card2);

  // 云端同步
  const sc=el('div','card');
  const cfg=getSyncCfg();
  if(cfg){
    sc.innerHTML=`<div class="section-title"><span class="dot"></span>云端同步</div>
      <div class="sync-row">
        <span class="sync-dot sync-${syncState.s||'idle'}" id="syncStatusDot"></span>
        <span class="sync-status" id="syncStatusText">${syncState.msg}</span>
      </div>
      <div class="muted" style="margin:6px 0 10px;">仓库：<code>${cfg.owner}/${cfg.repo}</code> 数据文件：<code>${cfg.path}</code></div>
      <div class="row wrap">
        <button class="btn btn-ghost btn-sm" id="syncNowBtn">${icon('reset')} 立即同步</button>
        <button class="btn btn-ghost btn-sm" id="syncDisconnectBtn">${icon('trash')} 断开</button>
      </div>
      <label class="sync-toggle"><input type="checkbox" id="syncAutoChk" ${cfg.auto!==false?'checked':''}> 自动同步（改动后自动上传，开着时自动拉取）</label>`;
  }else{
    sc.innerHTML=`<div class="section-title"><span class="dot"></span>云端同步</div>
      <div class="sync-row" style="margin-bottom:8px;">
        <span class="sync-dot sync-${syncState.s||'idle'}" id="syncStatusDot"></span>
        <span class="sync-status" id="syncStatusText">${syncState.msg||'未连接'}</span>
      </div>
      <div class="muted" style="margin-bottom:10px;">填 Gitee 仓库信息开启多设备自动同步（国内直连，免费私有仓库）。<a href="javascript:void(0)" id="syncHelpLink" style="color:var(--primary);text-decoration:none;">了解更多</a></div>
      <div id="syncHelpDetail" style="display:none;margin-bottom:10px;padding:10px;background:var(--primary-soft);border-radius:8px;font-size:12px;color:var(--text-sub);line-height:1.7;">
        步骤：① 在 Gitee 建一个私有仓库；② 进「个人设置→私人令牌」生成一个有仓库读写权限的 token（填到第一栏）；③ 填仓库所属用户名和仓库名；数据会存到仓库根目录的 shangan_data.json。<br>
        两台设备填同一套 owner/repo/path 即共用同一份数据。<br>
        自动同步：本机改动后约 2 分钟自动上传；开着时每 30 秒自动拉取；每天凌晨 6:00 再兜底合并一次。
      </div>
      <input type="password" id="syncKeyInput" class="sync-input" placeholder="粘贴 Gitee 私人令牌（token）" autocomplete="off">
      <input type="text" id="syncOwnerInput" class="sync-input" placeholder="仓库所属用户名（owner，如 zhang3）" autocomplete="off" style="margin-top:8px;">
      <input type="text" id="syncRepoInput" class="sync-input" placeholder="仓库名（repo，如 kaogong-data）" autocomplete="off" style="margin-top:8px;">
      <input type="text" id="syncPathInput" class="sync-input" value="shangan_data.json" placeholder="数据文件名（留空默认 shangan_data.json）" autocomplete="off" style="margin-top:8px;">
      <button class="btn btn-primary btn-sm" id="syncConnectBtn" style="margin-top:10px;">${icon('link')} 连接</button>`;
  }
  c.appendChild(sc);
  if(cfg){
    $('#syncNowBtn').addEventListener('click',doSyncNow);
    $('#syncDisconnectBtn').addEventListener('click',syncDisconnect);
    $('#syncAutoChk').addEventListener('change',function(){var c2=getSyncCfg()||{};c2.auto=this.checked;setSyncCfg(c2);if(this.checked){scheduleSync();schedulePoll();scheduleDailySync();}else{setSyncCfg(c2);}});
  }else{
    $('#syncConnectBtn').addEventListener('click',syncConnect);
    const helpLink=$('#syncHelpLink');
    const helpDetail=$('#syncHelpDetail');
    if(helpLink&&helpDetail){
      helpLink.addEventListener('click',()=>{
        const shown=helpDetail.style.display!=='none';
        helpDetail.style.display=shown?'none':'block';
        helpLink.textContent=shown?'了解更多':'收起';
      });
    }
  }
  c.appendChild(guide);
}

/* ============================================================
   内容管理：查看/删除/添加各模块全部内容
   ============================================================ */
const CONTENT_TYPE_MAP={
  maoQuotes:{name:'毛选金句',builtin:()=>MAO_QUOTES,
    summary:item=>item.text?item.text.substring(0,28)+'…':'金句',
    fields:{text:'金句内容',source:'出处'}},
  idioms:{name:'成语辨析',builtin:()=>IDIOM_PAIRS,
    summary:item=>_pairWords(item).join(' vs '),
    fields:{a:'成语A',b:'成语B',diff:'区别',example:'例句'}},
  shiciPairs:{name:'实词辨析',builtin:()=>SHICI_PAIRS,
    summary:item=>_pairWords(item).join(' vs '),
    fields:{a:'实词A',b:'实词B',diff:'区别',example:'例句'}},
  idiomWords:{name:'成语积累',builtin:()=>IDIOM_WORDS,
    summary:item=>item.word||'成语',
    fields:{word:'成语',meaning:'释义',example:'例句',stage:'状态 new/learning/mastered（可选）'}},
  shiciWords:{name:'实词积累',builtin:()=>SHICI_WORDS,
    summary:item=>item.word||'实词',
    fields:{word:'实词',meaning:'释义',example:'例句',stage:'状态 new/learning/mastered（可选）'}},
  ydzhongxin:{name:'中心理解题',builtin:()=>[],summary:item=>item.word||'',fields:{word:'要点',meaning:'内容',example:'例句/备注'}},
  ydxijie:{name:'细节判断题',builtin:()=>[],summary:item=>item.word||'',fields:{word:'要点',meaning:'内容',example:'例句/备注'}},
  ydyuju:{name:'语句理解题',builtin:()=>[],summary:item=>item.word||'',fields:{word:'要点',meaning:'内容',example:'例句/备注'}},
  ydbiaoti:{name:'标题填入题',builtin:()=>[],summary:item=>item.word||'',fields:{word:'要点',meaning:'内容',example:'例句/备注'}},
  ywpaixu:{name:'语句排序',builtin:()=>[],summary:item=>item.word||'',fields:{word:'要点',meaning:'内容',example:'例句/备注'}},
  ywtiankong:{name:'语句填空',builtin:()=>[],summary:item=>item.word||'',fields:{word:'要点',meaning:'内容',example:'例句/备注'}},
  ywjieyu:{name:'接语选择',builtin:()=>[],summary:item=>item.word||'',fields:{word:'要点',meaning:'内容',example:'例句/备注'}},
  politicsNews:{name:'时政热点',builtin:()=>POLITICS_NEWS,
    summary:item=>(item.title||'时政').substring(0,28)+'…',
    fields:{title:'标题',summary:'摘要',point:'考点',source:'来源',url:'链接'}},
  politicsQuestions:{name:'挖空题',builtin:()=>POLITICS_QUESTIONS,
    summary:item=>(item.q||'挖空题').substring(0,28)+'…',
    fields:{q:'题目（含___）',answer:'答案',category:'分类'}},
  changshi:{name:'常识',builtin:()=>COMMON_SENSE,
    summary:item=>(item.q||item.category||'常识').substring(0,28)+'…',
    fields:{category:'分类',q:'问题',a:'答案'}},
  quant:{name:'数量关系题型',builtin:()=>QUANT_TOPICS,
    summary:item=>item.name||item.type||'数量关系',
    fields:{name:'题型名',formula:'公式',example:'例题',solution:'解析'}},
  dataFormulas:{name:'资料分析公式',builtin:()=>DATA_FORMULAS,
    summary:item=>item.name||'公式',
    fields:{cat:'分类',name:'公式名',formula:'公式内容（支持 [[分子|分母]] 分式，换行即换行）',remark:'备注（可选）'}},
  shenlunDazuowen:{name:'申论大作文主题',builtin:()=>SHENLUN_DAZUOWEN,
    summary:item=>item.theme||item.title||'大作文主题',
    fields:{theme:'主题',materials:'素材数组',cases:'案例数组',quotes:'金句数组'}},
  shenlunGuifan:{name:'申论规范词',builtin:()=>SHENLUN_GUIFAN,
    summary:item=>`${item.cat||''} ${item.term||''}`.trim()||'规范词',
    fields:{cat:'分类（政治建设/经济发展/社会民生/文化文明/生态文明/治理能力/乡村振兴/科技创新/常用动词）',term:'规范表述',use:'用在什么场合'}},
  luojiNotes:{name:'判断推理笔记',builtin:()=>[],
    summary:item=>`${item.sub||''} ${(item.title||item.content||'笔记').substring(0,20)}`,
    fields:{sub:'子分类（图形推理/定义判断/类比推理/逻辑判断）',title:'标题',content:'内容'}}
};
const MODULE_CONTENT_KEYS={
  yanyu:['idioms','idiomWords','shiciPairs','shiciWords','ydzhongxin','ydxijie','ydyuju','ydbiaoti','ywpaixu','ywtiankong','ywjieyu'],
  politics:['politicsNews','politicsQuestions'],
  changshi:['changshi'],
  shuliang:['quant'],
  ziliao:['dataFormulas'],
  dazuowen:['shenlunDazuowen','shenlunGuifan'],
  luoji:['luojiNotes']
};
let _managerTab='__all__';
let _managerModule=null;   // 当前内容管理弹窗所属模块（用于判断能否走局部刷新）
const CM_ALL='__all__';
let _cmL1='__all__';       // 一级 tab：题型大类（CM_TYPE_GROUPS 的 key），CM_ALL=全部
/* 内容分类两级分组：模块 → [{key,name,keys:[内容类型]}]。一级=题型大类，二级=大类内内容分类；
   没配置分组的模块只有一级（分类 chip 行），单分类模块不显示 tab */
const CM_TYPE_GROUPS={
  yanyu:[
    {key:'ywtiankong',name:'逻辑填空',keys:['idioms','idiomWords','shiciPairs','shiciWords','ywtiankong']},
    {key:'yuedu',name:'阅读理解',keys:['ydzhongxin','ydxijie','ydbiaoti']},
    {key:'yuju',name:'语句表达',keys:['ydyuju','ywpaixu','ywjieyu']}
  ]
};
let _cmQuery='';           // 内容管理搜索词
let _cmBatch=false;        // 批量操作模式
let _cmChecked=new Set();  // 批量选中行 id（tk:b:i / tk:c:i）
let _cmAddOpen=false;      // 添加面板是否展开
let _cmAddMode='form';     // 添加面板模式：'form'=手动输入表单，'json'=粘贴 JSON
let _cmEdit=null;          // 编辑态：{tk,source,index}，非 null 时面板为编辑模式
let _cmExpanded=new Set(); // 已展开笔记内容的行 rid（默认折叠，点行展开）
let _cmCatFilter=CM_ALL;   // 按条目 cat 字段筛选（资料分析公式按 基期/现期/增长率… 分类），CM_ALL=全部
/* 手动输入表单：哪些字段用多行文本框（按 内容类型→字段名 精确指定，避免「成语A」与「答案」同为 a 却长短不同） */
const CM_TEXTAREA_FIELDS={
  maoQuotes:['text'],
  idioms:['diff','example'], shiciPairs:['diff','example'],
  idiomWords:['meaning','example'], shiciWords:['meaning','example'],
  ydzhongxin:['meaning','example'], ydxijie:['meaning','example'], ydyuju:['meaning','example'],
  ydbiaoti:['meaning','example'], ywpaixu:['meaning','example'], ywtiankong:['meaning','example'], ywjieyu:['meaning','example'],
  politicsNews:['summary','point'], politicsQuestions:['q'],
  changshi:['q','a'],
  quant:['formula','example','solution'], dataFormulas:['formula','remark'],
  shenlunDazuowen:['materials','cases','quotes'], shenlunGuifan:['use'], luojiNotes:['content']
};
/* 手动输入时以下拉选择的字段（避免手打分类打错字，与内置数据口径一致） */
const CM_SELECT_FIELDS={
  dataFormulas:{cat:['基期','现期','增长率','增量','两期','其他']}
};
/* 手动输入时以「一行一条」录入的数组字段 */
const CM_ARRAY_FIELDS={materials:1,cases:1,quotes:1,formulas:1};
function openContentManager(moduleKey){
  const keys=MODULE_CONTENT_KEYS[moduleKey]||[];
  if(keys.length===0){toast('该模块暂无可管理内容');return;}
  const groups=CM_TYPE_GROUPS[moduleKey]||null;
  /* 一级 tab 无「全部」：有分组的模块默认选中第一个大类 */
  if(groups)_cmL1=groups.some(g=>g.key===_cmL1)?_cmL1:groups[0].key;
  else _cmL1=CM_ALL;
  if(_managerTab!==CM_ALL&&!keys.includes(_managerTab))_managerTab=CM_ALL;
  _managerModule=moduleKey;
  _cmQuery='';_cmBatch=false;_cmChecked.clear();_cmAddOpen=false;_cmCatFilter=CM_ALL;
  renderManagerBody(moduleKey,keys);
}
function _cmModuleName(moduleKey){return (typeof SECTION_MAP!=='undefined'&&SECTION_MAP[moduleKey]&&SECTION_MAP[moduleKey].name)||'内容';}
/* 当前一级大类范围内的内容类型（一级=全部时为模块全部分类） */
function _cmScopeKeys(keys){
  if(_cmL1===CM_ALL)return keys;
  const g=(CM_TYPE_GROUPS[_managerModule]||[]).find(x=>x.key===_cmL1);
  return g?g.keys.filter(k=>keys.includes(k)):keys;
}
/* 单个分类去重后的条目（内置+自定义，与旧版同口径）：[{item,index,source}] */
function _cmCollect(tk){
  const ct=CONTENT_TYPE_MAP[tk];
  const deleted=state.deletedBuiltin[tk]||[];
  const builtinItems=ct.builtin?ct.builtin():[];
  const custom=state.customData[tk]||[];
  // 覆盖映射：_ovr=n 的自定义项替换内置第 n 条（在对应位置显示，编辑/删除都操作该自定义项）
  const ovrMap={};
  custom.forEach((it,i)=>{ if(it&&typeof it._ovr==='number')ovrMap[it._ovr]={item:it,cIndex:i}; });
  const _customKeys=new Set();
  custom.forEach(it=>{ if(!it)return; if(typeof it._slot==='number')return; if(typeof it._ovr==='number')return; const k=contentKey(it,tk); if(k!=null)_customKeys.add(k); });
  const builtin=[];
  builtinItems.forEach((item,i)=>{
    const ov=ovrMap[i];
    if(ov)builtin.push({item:ov.item,index:ov.cIndex,source:'custom'}); // 覆盖项始终显示（用户自定义内容）
    else if(!deleted.includes(i)&&!_customKeys.has(contentKey(item,tk)))builtin.push({item,index:i,source:'builtin'});
  });
  const slotItems=custom.map((item,i)=>({item,index:i,source:'custom'})).filter(x=>x.item&&typeof x.item._slot==='number');
  const plainItems=custom.map((item,i)=>({item,index:i,source:'custom'})).filter(x=>x.item&&typeof x.item._slot!=='number'&&typeof x.item._ovr!=='number');
  const all=builtin.slice();
  slotItems.slice().sort((a,b)=>a.item._slot-b.item._slot).forEach(x=>{
    all.splice(Math.min(x.item._slot,all.length),0,x);
  });
  all.push(...plainItems);
  return all;
}
/* 当前视图全部行（「全部」=当前一级大类内跨分类）：[{tk,item,index,source,rid,summary}] */
function _cmRows(keys){
  const tks=_managerTab===CM_ALL?_cmScopeKeys(keys):[_managerTab];
  const rows=[];
  tks.forEach(tk=>{
    _cmCollect(tk).forEach(r=>{
      rows.push({tk:tk,item:r.item,index:r.index,source:r.source,
        /* 自定义条目用内容 id 做 rid（稳定），内置用下标——展开/勾选状态跨增删、切tab不漂移 */
        rid:tk+':'+(r.source==='builtin'?'b':'c')+':'+(r.source==='builtin'?r.index:((r.item&&r.item.id)||('i'+r.index))),
        summary:CONTENT_TYPE_MAP[tk].summary(r.item)});
    });
  });
  return rows;
}
/* 弹窗标题（固定为模块名，具体分类在左侧栏体现） */
function managerTitleText(){
  return `内容管理 · ${_cmModuleName(_managerModule)}`;
}
/* 顶部两级 tab：一级=题型大类（仅 CM_TYPE_GROUPS 配置了的模块显示），二级=大类内内容分类；
   无分组模块只有分类 chip 行；单分类模块不显示任何 tab */
function cmTabsHtml(keys){
  const groups=CM_TYPE_GROUPS[_managerModule]||null;
  let h='';
  /* 一级=题型大类（不显示「全部」，有分组的模块默认停在第一个大类） */
  if(groups){
    h+='<div class="cm-l1">';
    groups.forEach(g=>{
      const n=g.keys.reduce((s,k)=>s+_cmCollect(k).length,0);
      h+=`<button type="button" class="${g.key===_cmL1?'active':''}" data-action="l1" data-grp="${g.key}">${g.name}<span class="n">${n}</span></button>`;
    });
    h+='</div>';
  }
  /* 二级=当前大类内的分类（二级保留「全部」，方便看整个大类） */
  const scope=_cmScopeKeys(keys);
  const showL2=keys.length>1&&scope.length>0;
  if(showL2){
    h+='<div class="cm-l2">';
    if(scope.length>1){
      const n=scope.reduce((s,k)=>s+_cmCollect(k).length,0);
      h+=`<button type="button" class="${_managerTab===CM_ALL?'active':''}" data-action="l2" data-grp="${CM_ALL}">全部<span class="n">${n}</span></button>`;
    }
    scope.forEach(k=>{
      h+=`<button type="button" class="${k===_managerTab?'active':''}" data-action="l2" data-grp="${k}">${CONTENT_TYPE_MAP[k].name}<span class="n">${_cmCollect(k).length}</span></button>`;
    });
    h+='</div>';
  }
  return h?'<div id="cmTabsBox" class="cm-tabs">'+h+'</div>':'';
}
/* 批量删除：按 tk 分组后 custom 索引倒序 splice、builtin 入 deletedBuiltin，并清复习排期（与单删同口径） */
function _cmRemoveRows(rows){
  const byTk={};
  rows.forEach(r=>{(byTk[r.tk]=byTk[r.tk]||[]).push(r);});
  Object.keys(byTk).forEach(tk=>{
    const grp=byTk[tk];
    grp.filter(r=>r.source==='custom').map(r=>r.index).sort((a,b)=>b-a).forEach(idx=>{
      const it=(state.customData[tk]||[])[idx];
      if(it&&typeof it._slot==='number'){
        state.deletedBuiltin[tk]=(state.deletedBuiltin[tk]||[]).filter(i=>i!==it._slot);
      }
      if(it&&state.learnStage&&state.learnStage[tk]){
        const g=FILL_BLANK_GROUPS.find(x=>x.key===tk);
        const ik=itemStageKey(g,it);
        if(ik&&state.learnStage[tk][ik]!=null)delete state.learnStage[tk][ik];
      }
      if(it&&it.id!=null)markEntityDeleted('custom:'+tk,[it.id]);state.customData[tk].splice(idx,1);
    });
    const bi=grp.filter(r=>r.source==='builtin').map(r=>r.index);
    if(bi.length){
      if(!state.deletedBuiltin[tk])state.deletedBuiltin[tk]=[];
      const ct=CONTENT_TYPE_MAP[tk];
      bi.forEach(idx=>{
        if(!state.deletedBuiltin[tk].includes(idx))state.deletedBuiltin[tk].push(idx);
        if(state.learnStage&&state.learnStage[tk]){
          const g=FILL_BLANK_GROUPS.find(x=>x.key===tk);
          const it=ct.builtin?ct.builtin()[idx]:null;
          if(g&&it){const ik=itemStageKey(g,it);if(ik&&state.learnStage[tk][ik]!=null)delete state.learnStage[tk][ik];}
        }
      });
    }
  });
  save();
}
/* 当前视图里出现过的 cat 值（按内置顺序 基期/现期/增长率/增量/两期 优先排） */
function _cmCatList(keys){
  const set=[];
  _cmRows(keys).forEach(r=>{
    const c=(r.item&&r.item.cat)?String(r.item.cat).trim():'';
    if(c&&set.indexOf(c)<0)set.push(c);
  });
  const order=['基期','现期','增长率','增量','两期'];
  return set.sort((a,b)=>{
    const ia=order.indexOf(a),ib=order.indexOf(b);
    return (ia<0?99:ia)-(ib<0?99:ib);
  });
}
/* 分类筛选 chip 行（只有条目带 cat 且分类数≥2 时才显示） */
function cmCatFilterHtml(keys){
  const cats=_cmCatList(keys);
  if(cats.length<2)return '';
  let h='<div class="cm-catfilter">';
  h+=`<button type="button" class="${_cmCatFilter===CM_ALL?'active':''}" data-action="cat-filter" data-cat="${CM_ALL}">全部</button>`;
  cats.forEach(c=>{
    h+=`<button type="button" class="${c===_cmCatFilter?'active':''}" data-action="cat-filter" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
  });
  h+='</div>';
  return h;
}
/* 单条内容行（批量时带勾选框；非批量时带编辑/删除）；点行可展开/收起笔记内容 */
function cmRowHtml(r,showTag){
  const checked=_cmChecked.has(r.rid);
  const exp=_cmExpanded.has(r.rid);
  return `<div class="cm-row${_cmBatch?' batch':''}${checked?' selected':''}${exp?' expanded':''}" data-rid="${r.rid}" data-action="row-toggle">
        ${_cmBatch?`<input type="checkbox" data-action="row-check" data-rid="${r.rid}" ${checked?'checked':''}>`:''}
        ${showTag?`<span class="cm-tag">${CONTENT_TYPE_MAP[r.tk].name}</span>`:''}
        <span class="grow" title="${escapeHtml(r.summary)}">${escapeHtml(r.summary)}</span>
        <span class="cm-caret"></span>
        ${_cmBatch?'':`<button class="icon-btn" style="background:#e8f0fe;color:var(--primary);flex:0 0 auto;" data-action="row-edit" data-tk="${r.tk}" data-source="${r.source}" data-index="${r.index}" title="编辑">${icon('edit')}</button>
        <button class="icon-btn" style="background:#fdeceb;color:var(--danger);flex:0 0 auto;" data-action="row-del" data-tk="${r.tk}" data-source="${r.source}" data-index="${r.index}" title="删除">${icon('trash')}</button>`}
      </div>`;
}
/* 展开后的笔记内容：按该类型的字段逐项显示（辨解析出 词/释义/例句） */
function _cmDetailHtml(r){
  const ct=CONTENT_TYPE_MAP[r.tk]||{};
  const fields=ct.fields||{};
  const it=r.item||{};
  const rowHtml=(k,v,html)=>`<div class="cm-detail-row"><span class="k">${escapeHtml(k)}</span><span class="v">${html||escapeHtml(String(v)).replace(/\n/g,'<br>')}</span></div>`;
  /* 公式内容（资料分析/数量关系）渲染成上下分式：支持直接写「分子/分母」 */
  const fmlHtml=(fk,v)=>{
    if(fk!=='formula'||(r.tk!=='dataFormulas'&&r.tk!=='quant'))return null;
    return fracHtml(fracFromSlash(escapeHtml(String(v)))).replace(/\n/g,'<br>');
  };
  let rows='';
  if(_isPairKey(r.tk)){
    const ws=_pairWords(it);
    if(ws.length)rows+=rowHtml('词',ws.join('、'));
    if(it.diff)rows+=rowHtml('释义/区别',it.diff);
    if(it.example)rows+=rowHtml('例句',it.example);
  }else{
    Object.keys(fields).forEach(fk=>{
      const v=it[fk];
      if(v==null||v==='')return;
      rows+=rowHtml(String(fields[fk]||fk).split('（')[0],Array.isArray(v)?v.join('、'):String(v),fmlHtml(fk,v));
    });
  }
  if(!rows)rows=`<div class="cm-detail-row"><span class="v muted">（暂无内容）</span></div>`;
  return `<div class="cm-detail" data-rid="${r.rid}">${rows}</div>`;
}
/* 批量工具条 + 内容列表（搜索时只替换这一块，保住搜索框焦点）；条目带 cat 且分类数≥2 时按分类分组显示小标题 */
function cmListAreaHtml(keys){
  const q=_cmQuery.trim().toLowerCase();
  const rows=_cmRows(keys).filter(r=>{
    if(_cmCatFilter!==CM_ALL){
      const c=(r.item&&r.item.cat)?String(r.item.cat).trim():'';
      if(c!==_cmCatFilter)return false;
    }
    if(!q)return true;
    /* 分组后行内不再写分类，搜索时把 cat 一并纳入匹配，搜「基期」仍能命中 */
    const hay=String(r.summary||'')+' '+((r.item&&r.item.cat)?String(r.item.cat):'');
    return hay.toLowerCase().includes(q);
  });
  const showTag=_managerTab===CM_ALL&&_cmScopeKeys(keys).length>1;
  const grouped=_cmCatList(keys).length>=2;   // 按分类分组（小标题）显示
  let h='';
  if(_cmBatch){
    const allChecked=rows.length>0&&rows.every(r=>_cmChecked.has(r.rid));
    h+=`<div class="cm-batchbar">
      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" id="cmSelectAll" ${allChecked?'checked':''}> 全选</label>
      <span class="grow">已选 ${_cmChecked.size} 条</span>
      <button type="button" class="btn btn-sm" style="color:var(--danger);" data-action="batch-del" ${_cmChecked.size?'':'disabled'}>删除选中</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="batch-cancel">取消</button>
    </div>`;
  }
  h+='<div class="cm-list" id="cmList">';
  if(!rows.length){
    h+=`<div class="cm-empty">${q?'没有匹配的内容':'暂无内容，点击「添加」按钮添加'}</div>`;
  }else if(grouped){
    const order=['基期','现期','增长率','增量','两期'];
    const groups=[],map={};
    rows.forEach(r=>{
      let c=(r.item&&r.item.cat)?String(r.item.cat).trim():'';
      if(!c)c='其他';
      if(!map[c]){map[c]={title:c,items:[]};groups.push(map[c]);}
      map[c].items.push(r);
    });
    groups.sort((a,b)=>{
      const ia=order.indexOf(a.title),ib=order.indexOf(b.title);
      return (ia<0?99:ia)-(ib<0?99:ib);
    });
    groups.forEach(g=>{
      h+=`<div class="cm-group-title">${escapeHtml(g.title)}<span class="n">${g.items.length}</span></div>`;
      g.items.forEach(r=>{h+=cmRowHtml(r,showTag);if(_cmExpanded.has(r.rid))h+=_cmDetailHtml(r);});
    });
  }else{
    rows.forEach(r=>{h+=cmRowHtml(r,showTag);if(_cmExpanded.has(r.rid))h+=_cmDetailHtml(r);});
  }
  h+='</div>';
  return '<div id="cmListArea">'+h+'</div>';
}
/* 添加面板：分类选择（多分类模块可下拉切换，默认当前视图分类）+ 字段提示 + JSON 输入 + 导入/添加 */
function cmAddPanelHtml(keys){
  const scope=_cmScopeKeys(keys);
  const editing=!!_cmEdit;
  const editItem=editing?_cmEditItem():null;
  const defKey=editing?_cmEdit.tk:(keys.includes(_managerTab)?_managerTab:(scope[0]||keys[0]));
  const select=keys.length>1
    ?`<select class="field" id="cmAddType" style="max-width:180px;"${editing?' disabled':''}>${keys.map(k=>`<option value="${k}"${k===defKey?' selected':''}>${CONTENT_TYPE_MAP[k].name}</option>`).join('')}</select>`
    :`<b style="font-size:13px;">${CONTENT_TYPE_MAP[defKey].name}</b>`;
  const hints=keys.map(k=>`<span data-hints="${k}" style="display:${k===defKey?'inline':'none'};">${Object.entries(CONTENT_TYPE_MAP[k].fields||{}).map(([fk,fv])=>`${fk}: ${fv}`).join('<br>')}</span>`).join('');
  const phObj={};Object.keys(CONTENT_TYPE_MAP[defKey].fields||{}).forEach(fk=>{phObj[fk]=CONTENT_TYPE_MAP[defKey].fields[fk];});
  const isForm=_cmAddMode==='form';
  /* 录入方式切换：默认「手动输入」（按字段填，最省事），需要批量粘贴时切到「粘贴 JSON」 */
  const modeSeg=`<div class="cm-seg" style="margin-bottom:8px;">
      <button type="button" class="${isForm?'active':''}" data-action="add-mode" data-mode="form">手动输入</button>
      <button type="button" class="${isForm?'':'active'}" data-action="add-mode" data-mode="json">粘贴 JSON</button>
    </div>`;
  const jsonSeed=editing?JSON.stringify((function(o){if(o&&typeof o==='object'){const c=Object.assign({},o);delete c._ovr;delete c._slot;delete c.id;return c;}return o;})(editItem)):'';
  const bodyHtml=isForm
    ? `<div id="cmFormArea">${cmFormFieldsHtml(defKey,editItem)}</div>`
    : `<div class="muted" style="font-size:11.5px;margin-bottom:6px;line-height:1.7;" id="cmFieldHint">粘贴 JSON 对象，字段参考：<br>${hints}</div>
       <textarea class="field" id="addJsonInput" rows="4" placeholder='${JSON.stringify(phObj)}' style="font-family:Consolas,monospace;font-size:12.5px;">${escapeHtml(jsonSeed)}</textarea>`;
  return `<div class="cm-addpanel" id="cmAddPanel">
    <div class="row" style="margin-bottom:8px;gap:8px;"><span style="font-size:13px;font-weight:600;">${editing?'编辑':'添加到'}</span>${select}</div>
    ${modeSeg}
    ${bodyHtml}
    <div class="row" style="justify-content:flex-end;margin-top:8px;gap:8px;">
      <button type="button" class="btn btn-ghost btn-sm" data-action="do-cancel">取消</button>
      ${editing?'':`<button type="button" class="btn btn-ghost btn-sm" data-action="do-import">${icon('download')} 导入资料</button>`}
      <button type="button" class="btn btn-sm" data-action="${editing?'do-edit':'do-add'}">${editing?`${icon('check')} 保存修改`:`${icon('plus')} 添加`}</button>
    </div>
  </div>`;
}
/* 手动输入表单：按 CONTENT_TYPE_MAP[key].fields 逐项生成输入框（长文本走 textarea，数组字段一行一条）；item 存在时预填（编辑态） */
function cmFormFieldsHtml(key,item){
  if(_isPairKey(key))return cmPairFieldsHtml(key,item);
  const fields=(CONTENT_TYPE_MAP[key]||{}).fields||{};
  const tas=CM_TEXTAREA_FIELDS[key]||[];
  const sels=CM_SELECT_FIELDS[key]||{};
  return Object.keys(fields).map(fk=>{
    const label=fields[fk];
    const isArr=!!CM_ARRAY_FIELDS[fk];
    const isTa=tas.indexOf(fk)>=0;
    const v=item&&item[fk]!=null?item[fk]:'';
    const vStr=Array.isArray(v)?v.join('\n'):String(v);
    let ctrl;
    if(sels[fk]){
      ctrl=`<select class="field" data-fk="${fk}" style="width:100%;font-size:16px;">${sels[fk].map(o=>`<option value="${escapeHtml(o)}"${String(o)===String(v)?' selected':''}>${escapeHtml(o)}</option>`).join('')}</select>`;
    }else if(isTa){
      ctrl=`<textarea class="field" data-fk="${fk}" rows="${isArr?3:2}" placeholder="${escapeHtml(isArr?(label+'（一行一条）'):label)}" style="width:100%;font-size:16px;">${escapeHtml(vStr)}</textarea>`;
    }else{
      ctrl=`<input class="field" data-fk="${fk}" type="text" value="${escapeHtml(vStr)}" placeholder="${escapeHtml(label)}" style="width:100%;font-size:16px;">`;
    }
    return `<div class="cm-form-row"><label class="cm-form-lbl">${escapeHtml(label)}</label>${ctrl}</div>`;
  }).join('');
}
/* 辨析组（成语/实词）表单：词数量可变（默认 2 个，可继续加），写入 words 数组；item 存在时预填词与释义 */
function cmPairFieldsHtml(key,item){
  const label=key==='idioms'?'成语':'实词';
  const words=_pairWords(item);
  const mMap={};
  if(item&&item.diff){String(item.diff).split(/；|;/).forEach(seg=>{const s=(seg||'').trim();if(!s)return;const ia=s.indexOf('：'),ib=s.indexOf(':');const at=(ia>=0&&(ib<0||ia<=ib))?ia:ib;if(at>0){const w=s.slice(0,at).trim(),m=s.slice(at+1).trim();if(w)mMap[w]=m;}});}
  const wItems=words.length?words:['',''];
  const itemHtml=(w,i)=>{const m=mMap[w]||'';return `<div class="cm-word-item">
    <div class="cm-word-row"><input class="field" data-w type="text" value="${escapeHtml(w)}" placeholder="${label}${i}"><button type="button" class="cm-word-del" data-action="word-del" title="删除">×</button></div>
    <textarea class="field" data-m rows="2" placeholder="${label}${i} 的释义或区别" style="width:100%;font-size:16px;">${escapeHtml(m)}</textarea></div>`;};
  return `<div id="cmWordBox" data-label="${label}">${wItems.map((w,i)=>itemHtml(w,i+1)).join('')}</div>
    <button type="button" class="cm-word-add" data-action="word-add">＋ 再加一个${label}</button>
    <div class="cm-form-row"><label class="cm-form-lbl">例句</label><textarea class="field" data-fk="example" rows="2" placeholder="例句" style="width:100%;font-size:16px;">${escapeHtml((item&&item.example)||'')}</textarea></div>`;
}
/* 收集手动表单 → 内容对象；全空返回 null */
function _cmCollectFormObj(key){
  const area=$('#cmFormArea'); if(!area)return null;
  const fields=((CONTENT_TYPE_MAP[key]||{}).fields)||{};
  const obj={}; let any=false;
  Object.keys(fields).forEach(fk=>{
    const el=area.querySelector('[data-fk="'+fk+'"]');
    if(!el)return;
    const v=(el.value||'').trim();
    if(!v)return;
    any=true;
    obj[fk]=CM_ARRAY_FIELDS[fk]?v.split(/\r?\n/).map(s=>s.trim()).filter(Boolean):v;
  });
  if(_isPairKey(key)){
    const ws=[],parts=[];
    area.querySelectorAll('.cm-word-item').forEach(it=>{
      const wEl=it.querySelector('[data-w]'),mEl=it.querySelector('[data-m]');
      const w=wEl?(wEl.value||'').trim():'';
      if(!w)return;
      ws.push(w);
      const m=mEl?(mEl.value||'').trim():'';
      if(m)parts.push(w+'：'+m);
    });
    if(ws.length){obj.words=ws;any=true;}
    if(parts.length){obj.diff=parts.join('；');any=true;}
  }
  return any?obj:null;
}
/* 右侧主区：搜索+添加行 / 分组标题+批量操作 / 列表 / 添加面板 */
function cmMainHtml(keys){
  const grpName=_managerTab!==CM_ALL?CONTENT_TYPE_MAP[_managerTab].name
    :(_cmL1!==CM_ALL?(((CM_TYPE_GROUPS[_managerModule]||[]).find(g=>g.key===_cmL1)||{}).name||'')+' · 全部'
    :_cmModuleName(_managerModule)+' · 全部');
  const hasRows=_cmRows(keys).length>0;
  return `<div id="cmMain" class="cm-main${_cmAddOpen?' cm-adding':''}">
    <div class="cm-toolbar">
      <div class="cm-search-wrap"><span class="cm-ico">${icon('search')}</span>
        <input class="cm-search" id="cmSearch" type="search" placeholder="搜索…" value="${escapeHtml(_cmQuery)}"></div>
      <button type="button" class="cm-add" data-action="add-toggle">${_cmAddOpen?'收起':'添加'}</button>
    </div>
    ${_cmAddOpen?cmAddPanelHtml(keys):''}
    <div class="cm-subbar"><span class="cm-title">${escapeHtml(grpName)}</span>
      ${hasRows?`<button type="button" class="cm-batch-btn" data-action="batch-toggle">${_cmBatch?'退出批量':'批量操作'}</button>`:''}
    </div>
    ${cmCatFilterHtml(keys)}
    ${cmListAreaHtml(keys)}
  </div>`;
}
/* 渲染/刷新内容管理弹窗：
   弹窗已开且属于同一模块时，只重建 pane 内部（tab 条数会随增删变化，需一起刷），绝不整窗重建（否则手机端底部抽屉高度突变会抖动） */
function renderManagerBody(moduleKey,keys){
  _managerModule=moduleKey;
  const modal=$('#modal'),mbody=$('#modalBody');
  const pane=mbody?mbody.querySelector('#cmPane'):null;
  if(modal&&mbody&&pane&&modal.classList.contains('show')&&modal.dataset.cmModule===moduleKey){
    pane.innerHTML=cmTabsHtml(keys)+cmMainHtml(keys);
    const t=$('#modalTitle'); if(t)t.textContent=managerTitleText();
    return;
  }
  if(modal)modal.dataset.cmModule=moduleKey;
  openModal(managerTitleText(),
    `<div id="cmPane" class="cm-layout">${cmTabsHtml(keys)}${cmMainHtml(keys)}</div>`,
    'modal-cm');
  bindCmPane();
}
/* 批量模式下局部同步批量条（已选计数 / 删除按钮可用性 / 全选框态），不重建列表 */
function _cmSyncBatchUi(){
  const pane=$('#cmPane');if(!pane)return;
  const grow=pane.querySelector('.cm-batchbar .grow');
  const del=pane.querySelector('[data-action="batch-del"]');
  if(grow)grow.textContent=`已选 ${_cmChecked.size} 条`;
  if(del)del.disabled=_cmChecked.size===0;
  const selAll=pane.querySelector('#cmSelectAll');
  if(selAll){
    const vis=Array.from(pane.querySelectorAll('.cm-row'));
    selAll.checked=vis.length>0&&vis.every(r=>_cmChecked.has(r.dataset.rid));
  }
}
/* 全部交互委托在 #cmPane 上绑定一次：主区任意局部刷新都不丢监听 */
function bindCmPane(){
  const pane=$('#cmPane');if(!pane||pane.dataset.bound==='1')return;pane.dataset.bound='1';
  const ks=()=>MODULE_CONTENT_KEYS[_managerModule]||[];
  pane.addEventListener('click',e=>{
    const actEl=e.target.closest('[data-action]');if(!actEl)return;
    const act=actEl.dataset.action;
    if(act==='l1'){
      _cmL1=actEl.dataset.grp;_managerTab=CM_ALL;_cmQuery='';_cmBatch=false;_cmChecked.clear();_cmAddOpen=false;_cmCatFilter=CM_ALL;_cmEdit=null;
      renderManagerBody(_managerModule,ks());
    }else if(act==='l2'){
      /* 切二级分类时保留已展开行（_cmExpanded 用稳定 rid，跨 l2 不漂移；只清勾选/批量态） */
      _managerTab=actEl.dataset.grp;_cmQuery='';_cmBatch=false;_cmChecked.clear();_cmAddOpen=false;_cmCatFilter=CM_ALL;_cmEdit=null;
      renderManagerBody(_managerModule,ks());
    }else if(act==='cat-filter'){
      /* 切分类筛选时同样保留展开态，避免「换个筛选就全收起」的割裂感 */
      _cmCatFilter=actEl.dataset.cat;_cmQuery='';_cmBatch=false;_cmChecked.clear();_cmEdit=null;_cmAddOpen=false;
      renderManagerBody(_managerModule,ks());
    }else if(act==='add-toggle'){
      _cmAddOpen=!_cmAddOpen;
      if(!_cmAddOpen)_cmEdit=null;   // 关闭面板时退出编辑态
      renderManagerBody(_managerModule,ks());
      if(_cmAddOpen){const ta=(_cmAddMode==='form')?document.querySelector('#cmFormArea [data-fk]'):$('#addJsonInput');if(ta)setTimeout(()=>ta.focus(),30);}
    }else if(act==='add-mode'){
      _cmAddMode=actEl.dataset.mode==='json'?'json':'form';
      renderManagerBody(_managerModule,ks());
    }else if(act==='word-add'){
      const box=$('#cmWordBox'); if(!box)return;
      const label=box.dataset.label||'词';
      const n=box.querySelectorAll('.cm-word-item').length+1;
      const div=document.createElement('div');
      div.className='cm-word-item';
      div.innerHTML=`<div class="cm-word-row"><input class="field" data-w type="text" placeholder="${label}${n}"><button type="button" class="cm-word-del" data-action="word-del" title="删除">×</button></div>
        <textarea class="field" data-m rows="2" placeholder="${label}${n} 的释义或区别" style="width:100%;font-size:16px;"></textarea>`;
      box.appendChild(div);
      const first=div.querySelector('input'); if(first)first.focus();
    }else if(act==='word-del'){
      const item=actEl.closest('.cm-word-item'); if(!item)return;
      const box=$('#cmWordBox');
      if(box&&box.querySelectorAll('.cm-word-item').length<=2){toast('辨析至少要两个词');return;}
      if(item.parentNode)item.parentNode.removeChild(item);
    }else if(act==='batch-toggle'){
      _cmBatch=!_cmBatch;_cmChecked.clear();renderManagerBody(_managerModule,ks());
    }else if(act==='row-check'){
      const rid=actEl.dataset.rid;
      if(_cmChecked.has(rid))_cmChecked.delete(rid);else _cmChecked.add(rid);
      /* 只局部更新当前行与批量条，不重建列表——避免长列表勾选时滚动回顶、连点丢失 */
      const row=actEl.closest('.cm-row');
      if(row)row.classList.toggle('selected',_cmChecked.has(rid));
      _cmSyncBatchUi();
    }else if(act==='batch-cancel'){
      _cmBatch=false;_cmChecked.clear();renderManagerBody(_managerModule,ks());
    }else if(act==='batch-del'){
      if(!_cmChecked.size)return;
      const map={};_cmRows(ks()).forEach(r=>{map[r.rid]=r;});
      const targets=[..._cmChecked].map(id=>map[id]).filter(Boolean);
      if(!targets.length)return;
      uiConfirm(`确定删除选中的 ${targets.length} 条内容？自定义内容删除后不可恢复，内置内容可在「我的-数据管理」中恢复。`,()=>{
        _cmRemoveRows(targets);
        _cmBatch=false;_cmChecked.clear();
        renderManagerBody(_managerModule,ks());
        render();
        toast(`已删除 ${targets.length} 条`);
      },{danger:true});
    }else if(act==='row-del'){
      const row={tk:actEl.dataset.tk,source:actEl.dataset.source,index:+actEl.dataset.index};
      uiConfirm(row.source==='custom'?'确定删除这条自定义内容？':'确定删除这条内置内容？删除后该内容将不再显示，可在「我的-数据管理」中恢复。',()=>{
        _cmRemoveRows([row]);
        renderManagerBody(_managerModule,ks());
        render();
        toast('已删除');
      },{danger:true});
    }else if(act==='row-toggle'){
      const rid=actEl.dataset.rid;
      if(_cmExpanded.has(rid))_cmExpanded.delete(rid);else _cmExpanded.add(rid);
      const row=actEl.closest('.cm-row'); if(!row)return;
      row.classList.toggle('expanded',_cmExpanded.has(rid));
      const next=row.nextElementSibling;
      if(_cmExpanded.has(rid)){
        const map={};_cmRows(ks()).forEach(r=>{map[r.rid]=r;});
        const r=map[rid]; if(!r){_cmExpanded.delete(rid);return;}
        row.insertAdjacentHTML('afterend',_cmDetailHtml(r));
      }else if(next&&next.classList.contains('cm-detail')&&next.dataset.rid===rid){
        next.parentNode.removeChild(next);
      }
    }else if(act==='row-edit'){
      _cmEdit={tk:actEl.dataset.tk,source:actEl.dataset.source,index:+actEl.dataset.index};
      _cmAddOpen=true;_cmAddMode='form';
      renderManagerBody(_managerModule,ks());
      setTimeout(()=>{const ta=document.querySelector('#cmFormArea [data-fk]')||$('#addJsonInput');if(ta)ta.focus();},30);
    }else if(act==='do-edit'){
      const s=$('#cmAddType');
      const ksArr=MODULE_CONTENT_KEYS[_managerModule]||[];
      const key=s?s.value:(ksArr.includes(_managerTab)?_managerTab:(ksArr[0]));
      window._saveContentEdit(key,_managerModule);
    }else if(act==='do-cancel'){
      _cmEdit=null;_cmAddOpen=false;renderManagerBody(_managerModule,ks());
    }else if(act==='do-add'){
      const s=$('#cmAddType');
      const ks=MODULE_CONTENT_KEYS[_managerModule]||[];
      const key=s?s.value:(ks.includes(_managerTab)?_managerTab:(ks[0]));
      window._addCustomItem(key,_managerModule);
    }else if(act==='do-import'){
      const s=$('#cmAddType');
      const ks=MODULE_CONTENT_KEYS[_managerModule]||[];
      const key=s?s.value:(ks.includes(_managerTab)?_managerTab:(ks[0]));
      window._importContentFile(key,_managerModule);
    }
  });
  pane.addEventListener('input',e=>{
    if(e.target.id!=='cmSearch')return;
    _cmQuery=e.target.value;
    const area=$('#cmListArea');
    if(area)area.outerHTML=cmListAreaHtml(ks());
  });
  pane.addEventListener('change',e=>{
    const el=e.target;
    if(el.id==='cmSelectAll'){
      const q=_cmQuery.trim().toLowerCase();
      const rows=_cmRows(ks()).filter(r=>!q||String(r.summary||'').toLowerCase().includes(q));
      _cmChecked=new Set(el.checked?rows.map(r=>r.rid):[]);
      /* 局部同步所有可见行，不重建列表（保住滚动位置） */
      const pane=$('#cmPane');
      if(pane)pane.querySelectorAll('.cm-row').forEach(row=>{
        const on=_cmChecked.has(row.dataset.rid);
        row.classList.toggle('selected',on);
        const cb=row.querySelector('input[type=checkbox]');
        if(cb)cb.checked=on;
      });
      _cmSyncBatchUi();
    }else if(el.id==='cmAddType'){
      if(_cmAddMode==='form'){
        const area=$('#cmFormArea');
        if(area)area.innerHTML=cmFormFieldsHtml(el.value);   // 换分类=换字段，重建输入区
        return;
      }
      const hint=$('#cmFieldHint');
      if(hint)hint.querySelectorAll('[data-hints]').forEach(s=>{s.style.display=s.dataset.hints===el.value?'inline':'none';});
      const ta=$('#addJsonInput');
      if(ta)ta.placeholder=JSON.stringify(Object.assign({},CONTENT_TYPE_MAP[el.value].fields||{}));
    }
  });
  /* 回车提交：表单内输入框回车即添加（多行文本框回车是换行，按 Ctrl/Cmd+Enter 提交）；
     JSON 模式文本框同样 Ctrl/Cmd+Enter 提交。搜索框回车不触发 */
  pane.addEventListener('keydown',e=>{
    if(e.key!=='Enter')return;
    const panel=$('#cmAddPanel'); if(!panel)return;
    const inForm=!!e.target.closest('#cmFormArea');
    const inJson=e.target.id==='addJsonInput';
    if(!inForm&&!inJson)return;
    if(e.target.tagName==='TEXTAREA'&&!(e.ctrlKey||e.metaKey))return;
    e.preventDefault();
    const s=$('#cmAddType');
    const ksArr=MODULE_CONTENT_KEYS[_managerModule]||[];
    const key=s?s.value:(ksArr.includes(_managerTab)?_managerTab:(ksArr[0]));
    window._addCustomItem(key,_managerModule);
  });
}
/* 查重：词库条目（辨析对/待积累词）是否已存在（内置+自定义），返回重复名称列表 */
function _dupKeys(key,obj){
  const dup=[];
  const isPair=_isPairKey(key);
  const isWord=key==='idiomWords'||key==='shiciWords';
  if(!isPair&&!isWord)return dup;
  const ct=CONTENT_TYPE_MAP[key];
  const builtin=(ct&&ct.builtin)?ct.builtin():[];
  const all=[...builtin,...(state.customData[key]||[])];
  if(isPair){
    const a=(obj.a||'').trim(),b=(obj.b||'').trim();
    if(!a&&!b)return dup;
    all.forEach(it=>{
      const ia=(it.a||'').trim(),ib=(it.b||'').trim();
      if((ia&&(ia===a||ia===b))||(ib&&(ib===a||ib===b)))dup.push((it.a||'?')+' vs '+(it.b||'?'));
    });
  }else{
    const w=(obj.word||'').trim();
    if(!w)return dup;
    all.forEach(it=>{if((it.word||'').trim()===w)dup.push(it.word);});
  }
  return [...new Set(dup)];
}
/* 内容去重指纹：辨析类=词条排序拼接；积累类=词语本身；其他类型返回 null（不去重）。
   内置与自定义共用同一把尺子，无需给内置手填 id。撞键时由调用方决定保留哪份。 */
function contentKey(item,key){
  if(!item||typeof item!=='object')return null;
  if(_isPairKey(key)){
    const ws=_pairWords(item);
    if(!ws.length)return null;
    return 'P:'+ws.slice().sort().join('|');
  }
  if(key==='idiomWords'||key==='shiciWords'){
    const w=(item.word||'').trim();
    if(!w)return null;
    return 'W:'+w;
  }
  return null;
}
/* 辨析组取词列表：兼容旧 {a,b} 与新 {words:[...]} */
function _pairWords(it){
  if(it&&Array.isArray(it.words))return it.words.map(w=>String(w).trim()).filter(Boolean);
  const r=[];
  if(it&&it.a)r.push(String(it.a).trim());
  if(it&&it.b)r.push(String(it.b).trim());
  return r.filter(Boolean);
}
/* 多按钮选择对话框：options=[{text,cls,fn}] */
function uiChoose(message,options,title){
  const btns=(options||[]).map((o,i)=>`<button class="btn ${o.cls||''} dlg-opt" data-i="${i}">${o.text}</button>`).join('');
  openModal(title||'选择',`<p class="dlg-msg">${nl2br(message)}</p><div class="dlg-actions">${btns}</div>`);
  const box=$('#modalBody');if(!box)return;
  box.querySelectorAll('.dlg-opt').forEach(b=>{
    b.onclick=()=>{closeModal();const o=options[+b.dataset.i];if(o&&o.fn)o.fn();};
  });
}
/* 合并词序：共享词在前，其余保持各自原顺序 */
function _mergeWords(tw,ow){
  const shared=tw.filter(w=>ow.includes(w));
  const rest=[...tw,...ow].filter(w=>!shared.includes(w));
  return [...shared,...rest];
}
/* 规范化辨析组：{a,b,...} -> {words,diff,example} */
function _normPairObj(obj){
  const r={words:_pairWords(obj),diff:obj.diff||'',example:obj.example||''};
  return r;
}
/* 合并：把新对 obj 并入已有组 target（target 可为内置或自定义） */
function _mergePair(key,target,targetSource,targetIndex,obj){
  const tw=_pairWords(target),ow=_pairWords(obj);
  const words=_mergeWords(tw,ow);
  let diff=(target.diff||'').trim();
  const newWords=words.filter(w=>!tw.includes(w));
  if(newWords.length&&obj.diff){
    String(obj.diff).split(/；|;/).forEach(seg=>{
      const s=(seg||'').trim();
      if(s&&newWords.some(w=>s.includes(w)))diff=diff?diff+'；'+s:s;
    });
  }
  if(!diff)diff=obj.diff||'';
  const merged={words,diff,example:(target.example||obj.example||'')};
  if(targetSource==='custom'){
    Object.assign(target,merged);target.mts=Date.now();
  }else{
    if(!state.deletedBuiltin[key])state.deletedBuiltin[key]=[];
    if(!state.deletedBuiltin[key].includes(targetIndex))state.deletedBuiltin[key].push(targetIndex);
    if(!state.customData[key])state.customData[key]=[];
    const mergedObj=withContentId(merged);
    mergedObj._slot=targetIndex;
    state.customData[key].push(mergedObj);
  }
  save();
}
/* 辨析对冲突检测：same=完全重复；shared=共用一词（[{it,source,index,sharedWords,objWords}]） */

function _pairConflict(key,obj){
  const words=_pairWords(obj);
  const same=[],shared=[];
  if(!words.length)return {same,shared};
  const ct=CONTENT_TYPE_MAP[key];
  const builtin=(ct&&ct.builtin)?ct.builtin():[];
  builtin.forEach((it,idx)=>{
    const iw=_pairWords(it);
    if(!iw.length)return;
    const samePair=iw.length===words.length&&iw.slice().sort().join('|')===words.slice().sort().join('|');
    if(samePair)same.push(iw.join(' vs '));
    else{
      const sw=iw.filter(w=>words.includes(w));
      if(sw.length)shared.push({it,source:'builtin',index:idx,sharedWords:sw,objWords:words.filter(w=>!iw.includes(w))});
    }
  });
  (state.customData[key]||[]).forEach((it,idx)=>{
    const iw=_pairWords(it);
    if(!iw.length)return;
    const samePair=iw.length===words.length&&iw.slice().sort().join('|')===words.slice().sort().join('|');
    if(samePair)same.push(iw.join(' vs '));
    else{
      const sw=iw.filter(w=>words.includes(w));
      if(sw.length)shared.push({it,source:'custom',index:idx,sharedWords:sw,objWords:words.filter(w=>!iw.includes(w))});
    }
  });
  return {same:[...new Set(same)],shared};
}
/* 添加/合并成功后刷新：只局部重建列表区与 tab 计数（不整窗重建），保留搜索框焦点、
   展开态、面板开启状态；随后清空表单并把焦点送回第一个输入框，方便连续录入 */
function _cmAddReset(moduleKey){
  const ks=MODULE_CONTENT_KEYS[moduleKey]||[];
  const area=$('#cmListArea'); if(area)area.outerHTML=cmListAreaHtml(ks);
  const tabs=$('#cmTabsBox'); if(tabs)tabs.outerHTML=cmTabsHtml(ks);
  render();
  _cmClearFormFocus();
}
/* 清空添加表单并聚焦第一个输入框（两种录入模式通用）；连续录入时这一步让光标自动回位 */
function _cmClearFormFocus(){
  if(_cmAddMode==='form'){
    const fm=$('#cmFormArea');
    if(fm)fm.querySelectorAll('[data-fk],[data-w],[data-m]').forEach(el=>{el.value='';});
    const first=fm?fm.querySelector('[data-fk],[data-w],[data-m]'):null;
    if(first)setTimeout(()=>first.focus(),0);
  }else{
    const ta=$('#addJsonInput'); if(ta){ta.value='';setTimeout(()=>ta.focus(),0);}
  }
}
/* 新条目高亮闪烁：写入后用 rid 找到刚加的那行，加一次性闪烁动画 */
function _cmFlash(rid){
  if(!rid)return;
  setTimeout(()=>{
    const row=document.querySelector('.cm-row[data-rid="'+rid+'"]');
    if(row){row.classList.add('cm-flash');setTimeout(()=>row.classList.remove('cm-flash'),1300);}
  },60);
}
/* 把内容对象写入对应分类（查重通过后调用）；obj 已确认可用 */
function _cmAddFromObj(key,moduleKey,obj){
  if(_isPairKey(key)){
    const cf=_pairConflict(key,obj);
    if(cf.same.length){toast('「'+cf.same.slice(0,3).join('、')+'」已存在，未重复添加');return;}
    if(cf.shared.length){
      const sh=cf.shared[0];
      const tw=_pairWords(sh.it).join(' vs ');
      const ow=_pairWords(obj).join(' vs ');
      const mw=_mergeWords(_pairWords(sh.it),_pairWords(obj)).join(' vs ');
      uiChoose(`「${tw}」与「${ow}」共享「${sh.sharedWords.join('、')}」，可合并成一组「${mw}」，要怎么处理？`,
        [
          {text:'合并为一组',fn:()=>{_mergePair(key,sh.it,sh.source,sh.index,obj);_cmAddReset(moduleKey);toast('已合并为一组');}},
          {text:'作为新组添加',cls:'btn-ghost',fn:()=>{_doAddCustomItem(key,moduleKey,obj);}},
          {text:'取消',cls:'btn-ghost',fn:null}
        ],'发现共用词');
      return;
    }
    _doAddCustomItem(key,moduleKey,obj);
  }else{
    const dup=_dupKeys(key,obj);
    if(dup.length){toast('「'+dup.slice(0,3).join('、')+'」已存在，未重复添加');return;}
    _doAddCustomItem(key,moduleKey,obj);
  }
}
window._addCustomItem=function(key,moduleKey){
  if(_cmAddMode==='form'){
    const obj=_cmCollectFormObj(key);
    if(!obj){toast('请填写至少一项内容');return;}
    _cmAddFromObj(key,moduleKey,obj);
    return;
  }
  const input=$('#addJsonInput');
  const raw=input.value.trim();
  if(!raw){toast('请输入 JSON 内容');return;}
  try{
    const obj=JSON.parse(raw);
    _cmAddFromObj(key,moduleKey,obj);
  }catch(e){
    toast('JSON 格式错误：'+e.message);
  }
};
/* 编辑态：取当前正在编辑的条目对象 */
function _cmEditItem(){
  if(!_cmEdit)return null;
  if(_cmEdit.source==='builtin'){
    const ct=CONTENT_TYPE_MAP[_cmEdit.tk];
    const bi=ct.builtin?ct.builtin():[];
    return bi[_cmEdit.index]||null;
  }
  const arr=state.customData[_cmEdit.tk]||[];
  return arr[_cmEdit.index]||null;
}
/* 保存编辑：根据 _cmEdit.source 决定更新自定义项 或 覆盖内置项（存为带 _ovr 的自定义项） */
window._saveContentEdit=function(key,moduleKey){
  let obj;
  if(_cmAddMode==='form'){
    obj=_cmCollectFormObj(key);
    if(!obj){toast('请填写至少一项内容');return;}
  }else{
    const input=$('#addJsonInput');
    const raw=input.value.trim();
    if(!raw){toast('请输入 JSON 内容');return;}
    try{obj=JSON.parse(raw);}catch(e){toast('JSON 格式错误：'+e.message);return;}
  }
  if(_cmEdit.source==='builtin'){
    const arr=state.customData[key]||(state.customData[key]=[]);
    const ex=arr.findIndex(it=>it&&typeof it._ovr==='number'&&it._ovr===_cmEdit.index);
    const finalObj=withContentId(Object.assign({},obj));
    finalObj._ovr=_cmEdit.index;
    if(ex>=0)arr[ex]=finalObj;else arr.push(finalObj);
  }else{
    const arr=state.customData[key];
    if(!arr||!arr[_cmEdit.index]){toast('未找到要修改的内容');return;}
    const orig=arr[_cmEdit.index];
    let merged;
    if(_isPairKey(key)){merged=_normPairObj(obj);merged.id=(orig.id!=null)?orig.id:uid();}
    else{merged=Object.assign({},orig,obj);if(merged.id==null)merged.id=uid();}
    arr[_cmEdit.index]=merged;
  }
  save();
  _cmEdit=null;_cmAddOpen=false;
  renderManagerBody(moduleKey,ks());
  render();
  toast('已保存修改');
};
/* 实际写入自定义内容（查重通过后调用） */
function _doAddCustomItem(key,moduleKey,obj){
  if(!state.customData[key])state.customData[key]=[];
  const norm=(_isPairKey(key))?_normPairObj(obj):obj;
  const item=withContentId(norm);
  state.customData[key].push(item);
  save();
  /* rid 与 _cmRows 规则一致：自定义条目用内容 id（withContentId 已补） */
  const rid=key+':c:'+(item.id!=null?item.id:('i'+(state.customData[key].length-1)));
  _cmAddReset(moduleKey);
  _cmFlash(rid);
  toast('添加成功！');
}
/* 导入资料：选 JSON 文件 → 预览 → 追加到对应模块 customData */
window._importContentFile=function(key,moduleKey){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='.json,application/json';
  inp.style.display='none';document.body.appendChild(inp);
  inp.addEventListener('change',()=>{
    const f=inp.files&&inp.files[0];
    if(inp.parentNode)inp.parentNode.removeChild(inp);
    if(!f)return;
    const r=new FileReader();
    r.onload=()=>{
      try{
        const data=JSON.parse(r.result);
        const arr=Array.isArray(data)?data:(data&&typeof data==='object'?[data]:null);
        if(!arr){toast('导入失败：文件不是有效的 JSON 数组或对象');return;}
        showContentImportPreview(key,moduleKey,arr);
      }catch(e){toast('导入失败：'+e.message);}
    };
    r.readAsText(f);
  });
  inp.click();
};
function showContentImportPreview(key,moduleKey,arr){
  const ct=CONTENT_TYPE_MAP[key];
  const preview=arr.slice(0,5).map(it=>{
    const s=ct.summary?ct.summary(it):JSON.stringify(it).slice(0,40);
    return `<div class="detail-row"><span class="grow" style="font-size:13.5px;">${escapeHtml(s)}</span></div>`;
  }).join('');
  const more=arr.length>5?`<div class="muted" style="font-size:12px;margin-top:6px;">…还有 ${arr.length-5} 条</div>`:'';
  const body=`<div class="muted" style="margin-bottom:8px;">将向「${ct.name}」追加 <b>${arr.length}</b> 条，与现有内容合并（不覆盖）。</div>
    <div style="max-height:34vh;overflow:auto;">${preview}${more}</div>
    <div class="dlg-actions" style="margin-top:14px;">
      <button class="btn btn-ghost dlg-cancel">取消</button>
      <button class="btn dlg-ok">确认导入</button>
    </div>`;
  openModal('导入资料预览',body);
  const box=$('#modalBody');if(!box)return;
  box.querySelector('.dlg-cancel').onclick=()=>closeModal();
  box.querySelector('.dlg-ok').onclick=()=>{
    if(!state.customData[key])state.customData[key]=[];
    const fresh=arr.filter(it=>{
      if(_isPairKey(key))return _pairConflict(key,it).same.length===0;
      return _dupKeys(key,it).length===0;
    });
    const skipped=arr.length-fresh.length;
    state.customData[key].push(...fresh.map(it=>(_isPairKey(key))?_normPairObj(it):it).map(withContentId));
    save();closeModal();
    renderManagerBody(moduleKey,MODULE_CONTENT_KEYS[moduleKey]||[]);
    render();
    toast(skipped?`已导入 ${fresh.length} 条到「${ct.name}」，跳过 ${skipped} 条重复`:`已导入 ${arr.length} 条到「${ct.name}」`);
  };
}

/* ============================================================
   今日任务（待办置顶）
   ============================================================ */
let _todoPanelOpen=false;        // 「全部待办」折叠区展开状态（跨重渲染保持）
let _todayDoneOpen=false;        // 「今天已完成 N 条」折叠区展开状态（跨重渲染保持）
function renderTodayTodos(bare,opts={}){
  const card=el('div','card today-card');
  const t=todayStr();
  const todos=state.todos||[];
  const overdue=[],today=[],upcoming=[];
  todos.forEach(td=>{
    if(td.done)return;
    // 每日/重复任务：今天已打勾（lastDone=今天）的，今天内也从今日任务隐藏，明天 lastDone 不等今天再回来
    if(isRepeat(td)&&td.lastDone===todayStr())return;
    if(td.ephemeral && td.dueDate<t)return; // 临时复盘待办：过期不滚到第二天
    const hasDue=!!(td.dueDate&&td.dueDate.length>0);
    if(!hasDue){upcoming.push(td);return;} // 长期任务归为即将到来
    if(td.dueDate<t)overdue.push(td);
    else if(td.dueDate===t)today.push(td);
    else if(td.dueDate<=addDays(t,2))upcoming.push(td);
  });
  // 排序：先按到期时间（早的在前；逾期自然排最前，长期任务无日期排最后），
  // 到期时间相同时再按所属模块的「差距」从高到低（差距越大越薄弱，越靠前）。
  const gapMap=sectionGapMap();
  const gapOf=td=>(td.section&&gapMap[td.section]!=null)?gapMap[td.section]:null;
  // 到期时间统一走 todoSortDueDate：循环任务按「下次该做的那天」算，纯长期与今天同级
  const dueKey=todoSortDueDate;
  const all=[...overdue,...today,...upcoming].sort((a,b)=>{
    const da=dueKey(a),db=dueKey(b);
    if(da!==db)return da<db?-1:1;
    const ga=gapOf(a),gb=gapOf(b);
    if(ga!=null&&gb!=null)return gb-ga;   // 同一天：差距大的在前
    if(ga!=null)return -1;
    if(gb!=null)return 1;
    return 0;
  });
  let html='';
  if(opts.head!==false){
    html=`<div class="today-head">
      <div class="section-title"><span class="dot"></span>今日任务 <span class="today-count${all.length?'':' zero'}">${all.length}</span></div>
      <button class="today-dice" id="randPickBtn" title="不知道做什么？随机抽一个" aria-label="随机抽任务">${icon('dice')}</button>
    </div>`;
  }
  /* 今日课程（课表联动）：有课时在任务列表上方提示，点击跳课程页 */
  if(bare){
    const _ttList=ttDayCourses(t);
    if(_ttList.length){
      html+=`<div class="tt-today home-tt"><span class="tt-today-label">今天 <b>${_ttList.length}</b> 节课</span>`
        +`<div class="tt-today-list">`
        +_ttList.map(c=>`<button class="tt-today-chip" data-tt="1" style="border-left-color:${ttModColor(c.module)}">`
          +`<span class="tt-today-name">${escapeHtml(c.name)}</span>`
          +(c.repeat==='once'?'<span class="tt-item-once">仅当日</span>':'')
          +`</button>`).join('')
        +`</div></div>`;
    }
  }
  const shown=opts.limit?all.slice(0,opts.limit):all;
  if(all.length===0){
    html+=`<div class="empty-tip">${bare?'今天还没有安排任务':'近三天没有待办。点下方「添加待办」新建，或展开「全部待办」查看远期与已完成'}</div>`;
  }else{
    html+=`<div class="today-list">`;
    shown.forEach(td=>{
      const hasDue=!!(td.dueDate&&td.dueDate.length>0);
      const cls=!hasDue?'long-term':(td.dueDate<t?'overdue':(td.dueDate===t?'today':'upcoming'));
      const secName=td.section?(SECTION_MAP[td.section]?SECTION_MAP[td.section].name:''):'';
      const diff=hasDue?dayDiff(t,td.dueDate):null;
      const dueTxt=!hasDue?'长期':(diff===0?'今天':(diff>0?`还剩${diff}天`:`逾期${-diff}天`));
      const rep=repeatLabel(td.repeat);
      const cnt=(isRepeat(td)&&td.doneCount)?`已${td.doneCount}次`:'';
      const repeatDoneToday=isRepeat(td)&&td.lastDone===todayStr();
      const doneTag=repeatDoneToday?' · 今日已完成':'';
      const subName0=td.sub?subName(td.sub):'';
      const sub=(secName?(secName+(subName0?' · '+subName0:'')+' · '):'')+dueTxt+(rep?' · '+rep:'')+(cnt?' · '+cnt:'')+doneTag;
      const jump=!!(td.jumpType&&(td.jumpType==='course'||td.jumpType==='brush'))||!!tabOfSection(td.section);
      const tkey=td.section?(td.sub||td.section):null;
      const tval=(tkey&&state.durTargets&&state.durTargets[tkey]!=null)?state.durTargets[tkey]:null;
      const tlabel=tkey?(tval!=null?('目标'+tval):'设目标'):'设目标';
      const _jt2=td.jumpType||'brush';
      const _jtName2=({course:'网课',note:'记笔记',brush:'刷题',review:'复盘',other:'其他'})[_jt2]||'刷题';
      html+=`<div class="today-item ${cls}${repeatDoneToday?' repeat-done':''}" data-id="${td.id}"${jump?' data-jump="1"':''}>
        <button class="today-check${repeatDoneToday?' checked':''}" data-id="${td.id}" aria-label="完成">${repeatDoneToday?icon('check'):''}</button>
        <div class="today-main grow">
          <div class="today-text">${escapeHtml(td.text)}<span class="todo-typetag t-${_jt2}">${_jtName2}</span></div>
          <div class="today-sub${cls==='overdue'?' od':''}">${sub}</div>
        </div>
        <span class="today-pill ${todoPriority(td)}" style="background:${priorityColor(todoPriority(td))}20;color:${priorityColor(todoPriority(td))}">${priorityLabel(todoPriority(td))}</span>
        ${td.jumpType!=='course'?`<button class="today-pomo" data-id="${td.id}" aria-label="专注" title="专注">${icon('alarm')}</button>`:''}
        <button class="today-edit" data-id="${td.id}" aria-label="编辑">${icon('edit')}</button>
      </div>`;
    });
    html+=`</div>`;
    if(opts.limit&&all.length>opts.limit)html+=`<div class="today-more">还有 ${all.length-opts.limit} 条待办未显示</div>`;
  }
  /* 今天已完成：勾选后从上方未完成列表移除，这里给一个入口能看到、能撤销（避免「一勾就没了、找不回」） */
  const doneList=todos.filter(x=>x.lastDone===t&&(x.done||isRepeat(x)));
  if(doneList.length){
    html+=`<div class="today-done-bar"><button type="button" class="today-done-toggle" id="todayDoneToggle">${icon('check')} 今天已完成 ${doneList.length} 条<span class="caret${_todayDoneOpen?' open':''}">▾</span></button></div>`;
    if(_todayDoneOpen){
      html+=`<div class="today-done-list">`+doneList.map(td=>{
        const _tx=td.text.length>14?td.text.slice(0,14)+'…':td.text;
        return `<div class="today-done-item"><span class="grow">${escapeHtml(_tx)}</span><button type="button" class="today-undo" data-undo="${td.id}">撤销</button></div>`;
      }).join('')+`</div>`;
    }
  }
  const row=opts.actions===false?'':`<div class="row today-actions" style="margin-top:10px;">
    <button class="btn btn-sm" id="addTodoFromHome">${icon('plus')} 添加待办</button>
    <button class="btn btn-sm btn-ghost" id="toggleAllTodos">${icon('list')} <span id="toggleAllTodosText"></span></button>
  </div>`;
  card.innerHTML=html+row;

  const dice=card.querySelector('#randPickBtn');
  if(dice)dice.addEventListener('click',openRandomPick);
  /* 今日课程条点击 → 跳课程页 */
  card.querySelectorAll('[data-tt]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();goTab('course');}));

  /* 全部待办（可折叠）：这里是待办的唯一管理入口，
     每日计划页不再重复渲染待办清单 */
  const panel=el('div','today-more-panel');
  const tgl=card.querySelector('#toggleAllTodos');
  if(tgl){
    const tglText=card.querySelector('#toggleAllTodosText');
    const syncPanel=()=>{
      tglText.textContent=_todoPanelOpen?`收起全部(${todos.length})`:`全部待办(${todos.length})`;
      panel.style.display=_todoPanelOpen?'block':'none';
      if(_todoPanelOpen){panel.innerHTML='';panel.appendChild(renderTodosCard({bare:true}));}
      else panel.innerHTML='';
    };
    tgl.addEventListener('click',()=>{
      _todoPanelOpen=!_todoPanelOpen;
      syncPanel();
      if(_todoPanelOpen)setTimeout(()=>{try{panel.scrollIntoView({behavior:'smooth',block:'nearest'});}catch(e){}},50);
    });
    card.appendChild(panel);
    syncPanel();
  }

    card.querySelectorAll('.today-item').forEach(it=>{
      it.addEventListener('click',()=>{
        const td=todos.find(x=>x.id===it.dataset.id); if(!td)return;
        navTodo(td);
      });
    });
  card.querySelectorAll('.today-check').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();toggleTodo(b.dataset.id);}));
  /* 「今天已完成」折叠 / 撤销 */
  const _dt=card.querySelector('#todayDoneToggle');
  if(_dt)_dt.addEventListener('click',e=>{e.stopPropagation();_todayDoneOpen=!_todayDoneOpen;render();});
  card.querySelectorAll('[data-undo]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();undoTodoDone(b.dataset.id);}));
  card.querySelectorAll('.today-edit').forEach(b=>b.addEventListener('click',e=>{
    e.stopPropagation();
    const td=todos.find(x=>x.id===b.dataset.id); if(td)openTodoEditor(td);
  }));
  card.querySelectorAll('.today-pomo').forEach(b=>b.addEventListener('click',e=>{
    e.stopPropagation();
    const td=todos.find(x=>x.id===b.dataset.id); if(td)startPomoForTask(td);
  }));
  const addBtn=card.querySelector('#addTodoFromHome');
  if(addBtn)addBtn.addEventListener('click',()=>openTodoEditor());
  return card;
}
function dayDiff(from,to){
  const a=new Date(from+'T00:00:00'), b=new Date(to+'T00:00:00');
  return Math.round((b-a)/86400000);
}
function addDays(str,n){const d=new Date(str+'T00:00:00');d.setDate(d.getDate()+n);return fmtDate(d);}
function priorityLabel(p){return p==='p0'?'紧急':(p==='p2'?'低':'普通');}
function priorityColor(p){return p==='p0'?'#ff7675':(p==='p2'?'#74b9ff':'#B2A8DC');}
/* 优先级不再手动设置，实时计算：
   - 有截止日期：当天/逾期=紧急(p0)；5 天及以上=低(p2)；中间=普通(p1)
   - 无截止日期（长期任务）：不重复=低(p2)；重复=按下一个重复日等同截止日计算 */
function autoPriority(dueDate){
  if(!dueDate||dueDate.length===0)return 'p2'; // 无截止日期由调用方按重复逻辑判定，这里兜底为低
  const d=dayDiff(todayStr(),dueDate); // 距截止剩余天数，负数=已逾期
  if(d<=0)return 'p0';
  if(d>=5)return 'p2';
  return 'p1';
}
function todoPriority(td){
  if(td&&td.dueDate) return autoPriority(td.dueDate); // 有截止日：按截止日判
  /* 无截止日的重复任务：用「下次该做的那天」判，不能用 nextRepeatDate(repeat, 今天)——
     后者对「今天是周期日」的任务会直接推到下个周期（每周一→下周一），今天该做却显示低优先级 */
  if(td&&isRepeat(td)) return autoPriority(todoSortDueDate(td));
  return 'p2'; // 不重复且无截止日：低
}

/* ============================================================
   周期重复
   ============================================================ */
const WEEKDAY_NAMES=['周日','周一','周二','周三','周四','周五','周六'];

/* 计算 afterDate 之后的下一个到期日（严格晚于 afterDate） */
function nextRepeatDate(repeat,afterDate){
  const r=repeat||{type:'none'};
  if(r.type==='daily')return addDays(afterDate,1);
  if(r.type==='interval')return addDays(afterDate,Math.max(1,parseInt(r.interval,10)||2));
  if(r.type==='weekly'){
    const days=(Array.isArray(r.weekdays)&&r.weekdays.length)?r.weekdays:[new Date(afterDate+'T00:00:00').getDay()];
    for(let i=1;i<=7;i++){
      const d=addDays(afterDate,i);
      if(days.indexOf(new Date(d+'T00:00:00').getDay())>=0)return d;
    }
    return addDays(afterDate,7);
  }
  if(r.type==='monthly'){
    const day=Math.min(31,Math.max(1,parseInt(r.monthDay,10)||1));
    /* 逐月推进：旧实现按 1~32 天逐个试，遇到 2 月这类没有 30/31 号的月份会直接退回「+30 天」，
       导致「每月30号」在 1 月 30 日之后跳到 3 月 2 日。这里当月没有该日就取当月最后一天。 */
    const base=new Date(afterDate+'T00:00:00');
    for(let k=1;k<=13;k++){
      const y=base.getFullYear(), m=base.getMonth()+k;
      const dim=new Date(y,m+1,0).getDate();
      const cand=new Date(y,m,Math.min(day,dim));
      if(cand>base)return fmtDate(cand);
    }
    return addDays(afterDate,30);
  }
  return addDays(afterDate,1);
}
/* 人类可读的重复说明，如「每天」「每3天」「每周一三五」「每月1号」 */
function repeatLabel(r){
  if(!r||!r.type||r.type==='none')return '';
  if(r.type==='daily')return '每天';
  if(r.type==='interval')return `每${r.interval||2}天`;
  if(r.type==='weekly'){
    const d=(Array.isArray(r.weekdays)&&r.weekdays.length)?r.weekdays.slice().sort((a,b)=>a-b):[];
    if(!d.length)return '每周';
    if(d.length===7)return '每天';
    return '每周'+d.map(x=>WEEKDAY_NAMES[x].replace('周','')).join('');
  }
  if(r.type==='monthly')return `每月${r.monthDay||1}号`;
  return '';
}
function isRepeat(td){return !!(td&&td.repeat&&td.repeat.type&&td.repeat.type!=='none');}

/* 任务排序用的「到期日」（YYYY-MM-DD），三种情况分开处理：
   1) 有截止日期：直接用（循环任务完成后会把 dueDate 滚动到下一周期，所以也走这条）
   2) 无截止日期、但是循环任务：算出下一次该做的日子。
      基于 lastDone（上次完成日）推算；从未完成过则从「昨天」起算，这样今天正好落在周期上时能算成今天。
      例如「每周一」：周一排今天，周二就排到下周一，而不是沉底或永远算今天。
   3) 无截止日期、非循环（纯长期）：随时可做，与今天同级，不再排到最后 */
function todoSortDueDate(td){
  if(td.dueDate&&td.dueDate.length)return td.dueDate;
  if(isRepeat(td)){
    const base=(td.lastDone&&td.lastDone.length)?td.lastDone:addDays(todayStr(),-1);
    return nextRepeatDate(td.repeat,base);
  }
  return todayStr();
}
/* 全部待办排序用的日期：已完成按「完成日期」(lastDone)，未完成为截止/下次/今天。
   返回 YYYY-MM-DD，用于「从近到远」（最新的在最上）。 */
function todoSortDate(td){
  if(td.done&&td.lastDone&&td.lastDone.length)return td.lastDone;
  return todoSortDueDate(td);
}

/* 轻量提示条 */
let _toastTimer=null;
function toast(msg){
  let t=document.getElementById('wbToast');
  if(!t){t=document.createElement('div');t.id='wbToast';t.className='wb-toast';document.body.appendChild(t);}
  t.textContent=msg;
  t.classList.add('show');
  if(_toastTimer)clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>{if(t)t.classList.remove('show');},2400);
}

/* 随机抽任务（侧边栏"工具"→随机抽任务）：从未完成任务里随机抽一个 */
let _pickPool=null,_pickIdx=0,_rollTimer=null;
function openRandomPick(){
  const undone=(state.todos||[]).filter(x=>!x.done&&!(isRepeat(x)&&x.lastDone===todayStr()));
  if(!undone.length){toast('暂无未完成任务，先去添加一条吧');return;}
  _pickPool=undone.slice();
  for(let i=_pickPool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[_pickPool[i],_pickPool[j]]=[_pickPool[j],_pickPool[i]];}
  _pickIdx=0;renderRandomPick();
}
function renderRandomPick(){
  const td=_pickPool&&_pickPool[_pickIdx];
  if(!td)return;
  const pr=todoPriority(td);
  const sec=td.section&&SECTION_MAP[td.section]?SECTION_MAP[td.section].name:'';
  const rep=repeatLabel(td.repeat);
  const body=
    '<div class="rp-card">'+
      '<div class="rp-task" id="rpTask">抽选中…</div>'+
      '<div class="rp-meta" id="rpMeta" style="visibility:hidden;opacity:0;">'+
        '<span class="rp-tag" style="background:'+priorityColor(pr)+'20;color:'+priorityColor(pr)+'">'+priorityLabel(pr)+'</span>'+
        '<span class="rp-tag">截止 '+escapeHtml(td.dueDate||'—')+'</span>'+
        (sec?'<span class="rp-tag">'+escapeHtml(sec)+'</span>':'')+
        (rep?'<span class="rp-tag">'+escapeHtml(rep)+'</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="rp-actions">'+
      '<button class="btn btn-ghost" id="rpReroll">换一个</button>'+
      '<button class="btn" id="rpGo">去处理</button>'+
    '</div>';
  openModal('帮你选一个', body);
  const reroll=$('#rpReroll');if(reroll)reroll.onclick=()=>{_pickIdx=(_pickIdx+1)%_pickPool.length;renderRandomPick();};
  const go=$('#rpGo');if(go)go.onclick=()=>{closeModal();navTodo(td);};
  startPickRoll(td.text);
}
/* 抽选滚动动画：任务名先快后慢地轮播，最后落定 */
function startPickRoll(finalText){
  const taskEl=$('#rpTask'), metaEl=$('#rpMeta');
  if(!taskEl)return;
  if(_rollTimer){clearTimeout(_rollTimer);_rollTimer=null;}
  const pool=_pickPool||[];
  // 间隔由短到长：模拟减速落定的手感（合计约 0.7s）
  const gap=[42,52,63,77,93,112,134,160];
  let i=0;
  taskEl.classList.remove('rp-land');taskEl.classList.add('rp-rolling');
  function tick(){
    if(taskEl){
      const s=(pool.length)?(pool[Math.floor(Math.random()*pool.length)]||{}).text:'';
      taskEl.textContent=s||'抽选中…';
    }
    i++;
    if(i>=gap.length){
      _rollTimer=null;
      if(taskEl){taskEl.textContent=finalText;taskEl.classList.remove('rp-rolling');taskEl.classList.add('rp-land');}
      if(metaEl){metaEl.style.visibility='visible';metaEl.style.opacity='1';}
      return;
    }
    _rollTimer=setTimeout(tick, gap[i]);
  }
  _rollTimer=setTimeout(tick, gap[0]);
}

/* 标记待办「最后修改时间」，供跨设备同步做最后修改者胜（LWW）判先后 */
function markTodoModified(td){ if(td&&typeof td==='object') td.mts=Date.now(); }

/* 完成一次待办：全应用唯一的「写完成状态」入口。
   历史 bug（任务录完一次就永久消失 / 长期任务被写死期限 / 重复任务被写 done=true）
   全部来自各入口各自手写这段状态变更，口径不一致。以后新增入口一律调这里。
   - 普通任务：done=true、lastDone=date
   - 重复任务：lastDone=date、doneCount+1；仅当已有截止日且 advanceDueDate 时推进到下个周期
     （长期任务绝不新增期限；重复任务 done 恒为 false）
   - blockFuture：未到执行日期的重复任务不允许提前完成（勾选待办时用）
   - base：'due-or-today' = 逾期完成基于今天推进；'today' = 一律从今天起算
   返回 {completed, reason, nextDate, todo}；reason: missing | already | not-due | ok
   不负责 save/render/toast，调用方按 result 自行处理。 */
function completeTodoOnce(td, opts){
  const o=opts||{};
  const date=o.date||todayStr();
  const advanceDueDate=o.advanceDueDate!==false;
  const blockFuture=!!o.blockFuture;
  const base=o.base||'today';
  if(!td)return {completed:false,reason:'missing',nextDate:'',todo:null};
  if(!isRepeat(td)){
    if(td.done)return {completed:false,reason:'already',nextDate:'',todo:td};
    td.done=true;
    td.lastDone=date;
    markTodoModified(td);
    return {completed:true,reason:'ok',nextDate:'',todo:td};
  }
  if(td.lastDone===date)return {completed:false,reason:'already',nextDate:'',todo:td};
  if(blockFuture&&td.dueDate&&td.dueDate>date)return {completed:false,reason:'not-due',nextDate:'',todo:td};
  const anchor=(base==='due-or-today'&&td.dueDate&&td.dueDate>date)?td.dueDate:date;
  const next=nextRepeatDate(td.repeat,anchor);
  td.lastDone=date;
  td.doneCount=(td.doneCount||0)+1;
  if(advanceDueDate&&td.dueDate&&td.dueDate.length)td.dueDate=next;
  markTodoModified(td);
  return {completed:true,reason:'ok',nextDate:next,todo:td};
}

/* 勾选待办：
   - 周期性任务：不标记完成，而是把截止日滚动到下一个周期，并记录完成次数
   - 普通任务：切换 done */
function toggleTodo(id){
  const t=(state.todos||[]).find(x=>x.id===id);
  if(!t)return;
  const wasDone=t.done; // 记录完成前的状态
  if(!t.done&&isRepeat(t)){
    const today=todayStr();
    const r=completeTodoOnce(t,{date:today,blockFuture:true});
    if(r.reason==='already'){toast('今天已完成，明天再来吧～');return;}
    if(r.reason==='not-due'){toast('还没到执行日期（'+t.dueDate.slice(5)+'），先不用做');return;}
    if(!r.completed)return;
    save();render();
    toast(`已完成 · 下次 ${r.nextDate.slice(5)}（${repeatLabel(t.repeat)}）`);
    // 完成关联模块的重复待办后，自动弹出打卡录入弹窗（记笔记不产生题量，不弹）
    if(t.section&&SECTION_MAP[t.section]&&t.jumpType!=='note'&&t.jumpType!=='course'){
      setTimeout(()=>openReportBySection(t.section,null,true),300);
    }
    return;
  }
  // 勾选完成「关联模块」的待办：先不标记完成，弹录入框；保存录入后才标记完成，
  // 取消则任务保持未做、仍在列表里（避免一勾就消失、取消还找不回）。
  // 网课待办例外：不产题量，听完课由课程页「听完一讲」同步完成，勾选直接完成。
  // 记笔记例外：不产生题量，勾选直接完成（与网课一致，录入题量对笔记无意义）。
  if(!wasDone && t.section && SECTION_MAP[t.section] && t.jumpType!=='course' && t.jumpType!=='note'){
    setTimeout(()=>openReportBySection(t.section, t.id, true),300);
    return;
  }
  // 「听一讲」网课待办：勾选完成 → 同步把课程进度补齐到对应讲数（幂等，不重复记）
  if(!wasDone && t.jumpType==='course'){
    const added=syncCourseProgressByTodo(t);
    if(added>0)toast('已同步课程进度：听课 +'+added+' 讲');
  }
  t.done=!t.done;
  if(t.done){
    t.lastDone=todayStr();
    /* 直接完成（记笔记/网课等不弹录入框的类型）要给个回执，否则任务从列表消失会让人以为丢了 */
    const _tx=t.text.length>12?t.text.slice(0,12)+'…':t.text;
    toast('已完成「'+_tx+'」· 在下方「今天已完成」可撤销');
  }else{
    t.lastDone='';
    toast('已恢复为未完成');
  }
  markTodoModified(t);
  save();render();
}
/* 撤销「今天已完成」：非重复任务退回未完成；重复任务清掉今天的打卡、日期推回今天 */
function undoTodoDone(id){
  const td=(state.todos||[]).find(x=>x.id===id);
  if(!td)return;
  if(isRepeat(td)){
    td.lastDone='';
    td.doneCount=Math.max(0,(td.doneCount||0)-1);
    if(td.dueDate&&td.dueDate>todayStr())td.dueDate=todayStr();
  }else{
    td.done=false;
    td.lastDone='';
  }
  const _tx=td.text.length>12?td.text.slice(0,12)+'…':td.text;
  markTodoModified(td);
  save();render();
  toast('已撤销「'+_tx+'」，回到未完成');
}

/* ============================================================
   待办页
   ============================================================ */
let _todoFilter='all';           // 记住筛选状态，避免每次重渲染被重置
function startPomoForTask(td){
  if(typeof td==='string')td=(state.todos||[]).find(x=>x.id===td); // 兼容误传 id
  if(!td)return;
  /* 网课不计时：听课动辄一两个小时还要暂停记笔记，番茄钟无意义，只记听课进度（勾选待办即 +1 讲） */
  if(td.jumpType==='course'){toast('网课不计时，听完直接勾选就算一讲');return;}
  // 记笔记任务允许不关联模块：看材料自己记录时不一定属于某个刷题模块，
  // 也能开番茄钟专注（时长计入当日总时长，默认 25 分钟目标）；其他任务仍要求先关联模块。
  if(!td.section){
    if(td.jumpType!=='note'){toast('这条任务没关联模块，先在编辑里选一下');return;}
    stopPomoTimer();
    pomo.section='';pomo.sub='';pomo.kind='focus';pomo.duration=25;pomo.taskId=td.id;
    pomo.remaining=0;pomo.custom=false;pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomo.startTs=Date.now();pomo.running=true;
    startPomoTimer();
    save();showPomoFloat();openPomoFullscreen();
    toast('已开始专注（默认 25 分钟，可改）');
    return;
  }
  const sec=td.section, sub=td.sub||'';
  // 仅「限时」模块才套目标时长/超时；晨读(chendu)无考试时间概念 → 纯正计时、无目标、不超时(duration=0)。
  // 申论虽不计题量(单位篇)但考试限时，走正常目标时长：优先任务题量×速度，否则「我的目标」时长，否则 25 兜底。
  const speed=resolveStandardSpeed(sec,sub);
  const dur=secHasTimeLimit(sec)?((td.count>0&&speed&&speed>0)?Math.max(1,Math.round(td.count*speed)):(resolveDurTarget(sec,sub)||25)):0;
  stopPomoTimer();
  pomo.section=sec;pomo.sub=sub;pomo.kind='focus';pomo.duration=dur;pomo.taskId=td.id;pomo.remaining=0;pomo.custom=false;pomo.done=false;pomo.overtime=false;pomo.endAt=null;pomo.startTs=Date.now();pomo.running=true;
  startPomoTimer();
  save();showPomoFloat();openPomoFullscreen();
}
/* 我的目标·统一设置弹窗：行测三项（正确率/时长/题量）必填，时长÷题量=每题标准速度；
   申论只有得分率一项。presetKey=预选的大类或子模块 key */
function openTargetModal(presetKey){
  const wt0=state.weakTargets||{};
  const dt=state.durTargets||{};
  const ct=state.countTargets||{};
  /* 行测 5 类（来自 SECTION_ET）+ 申论（来自 SHENLUN_SUB_OPTIONS，含小题题型）；套卷/晨读没有子模块，暂不列入 */
  const secKeys=Object.keys(SECTION_ET).concat(['shenlun']);
  const secOpts=secKeys.map(k=>`<option value="${k}">${(SECTION_ET[k]&&SECTION_ET[k].name)||(SECTION_MAP[k]&&SECTION_MAP[k].name)||k}</option>`).join('');
  openModal('设置目标',`
    <div class="field-help" style="margin-bottom:10px;">行测三项一起设：<b>时长 ÷ 题量 = 每题标准速度</b>，用来衡量每次刷题快了还是慢了</div>
    <label class="field-label">模块（大类，可再选子模块）</label>
    <select class="field" id="dtSection">${secOpts}</select>
    <select class="field" id="dtSub" style="margin-top:8px;display:none;"></select>
    <div style="margin-top:10px;"><label class="field-label" id="dtWeakLabel">目标正确率<i class="req">*</i></label>
      <input type="number" class="field" id="dtWeak" min="0" max="100" placeholder="如 80（%）"></div>
    <div id="dtDurWrap" style="margin-top:10px;"><label class="field-label">目标时长<i class="req">*</i>${hmark('分钟，1-180；晨读无考试时间、不套此目标')}</label>
      <input type="number" class="field" id="dtMin" min="1" max="180" placeholder="如 32"></div>
    <div id="dtCntWrap" style="margin-top:10px;"><label class="field-label">目标题量<i class="req">*</i>${hmark('对应上面的时长，如时长 32 分做 35 题；申论记篇，无此项')}</label>
      <input type="number" class="field" id="dtCnt" min="1" max="500" placeholder="如 35"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px;">
      <button class="btn btn-ghost" id="dtClear">清除目标</button>
      <button class="btn btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn" id="dtSave">保存</button>
    </div>`);
  const secSel=document.getElementById('dtSection');
  const subSel=document.getElementById('dtSub');
  const weakInp=document.getElementById('dtWeak');
  const weakLabel=document.getElementById('dtWeakLabel');
  const durWrap=document.getElementById('dtDurWrap');
  const cntWrap=document.getElementById('dtCntWrap');
  const minInp=document.getElementById('dtMin');
  const cntInp=document.getElementById('dtCnt');
  /* 申论：只有得分率，隐藏时长/题量并改标签 */
  function applySlMode(isSl){
    durWrap.style.display=isSl?'none':'block';
    cntWrap.style.display=isSl?'none':'block';
    weakLabel.innerHTML=isSl?'目标得分率<i class="req">*</i>':'目标正确率<i class="req">*</i>';
  }
  function sync(){
    const presetSec=(function(){
      if(!presetKey)return null;
      if(SECTION_ET[presetKey]||presetKey==='shenlun')return presetKey;
      for(const sk in SECTION_ET){ if(SECTION_ET[sk].sub && SECTION_ET[sk].sub.some(x=>x.key===presetKey)){ return sk; } }
      for(const sk in SECTION_ET){ if(SECTION_ET[sk].subs && SECTION_ET[sk].subs.some(x=>x.key===presetKey)){ return sk; } }
      if(SHENLUN_SUB_OPTIONS.some(x=>x.key===presetKey))return 'shenlun';
      return null;
    })();
    if(presetSec) secSel.value=presetSec;
    const s=secSel.value; const isSl=(s==='shenlun');
    applySlMode(isSl);
    const subs=subsOfSection(s);
    if(subs.length){
      subSel.style.display='block';
      subSel.innerHTML=`<option value="" title="整个大类">（整个大类）</option>`+subs.map(x=>`<option value="${x.key}">${x.name}</option>`).join('');
      if(presetKey && subs.some(x=>x.key===presetKey)) subSel.value=presetKey;
    } else { subSel.style.display='none';subSel.innerHTML=''; }
    /* 按当前实际 key 回显三项（切换模块/子模块也要跟着变，不能残留上一个模块的值） */
    const key=subSel.value||s;
    weakInp.value=wt0[key]!=null?wt0[key]:'';
    minInp.value=dt[key]!=null?dt[key]:'';
    cntInp.value=ct[key]!=null?ct[key]:'';
  }
  secSel.addEventListener('change',sync);
  subSel.addEventListener('change',()=>{
    const s=secSel.value,key=subSel.value||s;
    weakInp.value=wt0[key]!=null?wt0[key]:'';
    minInp.value=dt[key]!=null?dt[key]:'';
    cntInp.value=ct[key]!=null?ct[key]:'';
  });
  sync();
  document.getElementById('dtSave').addEventListener('click',()=>{
    const s=secSel.value; const sub=subSel.value||'';
    const key=sub||s;
    if(!key){toast('请选择模块');return;}
    const isSl=(s==='shenlun');
    const wTrim=weakInp.value.trim();
    if(wTrim===''){toast(isSl?'请填目标得分率':'请填目标正确率（不需要目标可点「清除目标」）');return;}
    const w=parseInt(wTrim,10);
    if(isNaN(w)||w<0||w>100){toast('正确率请输入 0-100 之间的数字');return;}
    if(!isSl){
      /* 行测：时长、题量同样必填，三项配齐才能算标准速度 */
      if(minInp.value.trim()===''||cntInp.value.trim()===''){toast('时长和题量也要一起填（时长 ÷ 题量 = 每题标准速度）');return;}
      const n=parseInt(minInp.value,10);
      if(isNaN(n)||n<1||n>180){toast('时长请输入 1-180 之间的分钟数');return;}
      const c=parseInt(cntInp.value,10);
      if(isNaN(c)||c<1||c>500){toast('题量请输入 1-500 之间的数值');return;}
      if(!state.durTargets)state.durTargets={};
      if(!state.countTargets)state.countTargets={};
      if(!state.durTargetsMts)state.durTargetsMts={};
      if(!state.countTargetsMts)state.countTargetsMts={};
      const _now=Date.now();
      state.durTargets[key]=n;state.countTargets[key]=c;
      state.durTargetsMts[key]=_now;state.countTargetsMts[key]=_now;
    }
    if(!state.weakTargets)state.weakTargets={};
    if(!state.weakTargetsMts)state.weakTargetsMts={};
    state.weakTargets[key]=w;
    state.weakTargetsMts[key]=_now||Date.now();
    if(isSl){/* 申论不存时长/题量，清掉可能的历史脏值，避免速度计算误用；留时间戳墓碑防另一端复活 */
      const _t=Date.now();
      if(!state.durTargetsMts)state.durTargetsMts={};if(!state.countTargetsMts)state.countTargetsMts={};
      if(state.durTargets&&state.durTargets[key]!=null){delete state.durTargets[key];state.durTargetsMts[key]=_t;}
      if(state.countTargets&&state.countTargets[key]!=null){delete state.countTargets[key];state.countTargetsMts[key]=_t;}
    }
    save(); closeModal(); render(); toast('目标已保存');
  });
  document.getElementById('dtClear').addEventListener('click',()=>{
    const s=secSel.value; const sub=subSel.value||'';
    const key=sub||s;
    const _t=Date.now();
    if(!state.weakTargets)state.weakTargets={};
    if(!state.weakTargetsMts)state.weakTargetsMts={};
    if(!state.durTargets)state.durTargets={};
    if(!state.countTargets)state.countTargets={};
    if(!state.durTargetsMts)state.durTargetsMts={};
    if(!state.countTargetsMts)state.countTargetsMts={};
    delete state.weakTargets[key];state.weakTargetsMts[key]=_t;
    delete state.durTargets[key];state.durTargetsMts[key]=_t;
    delete state.countTargets[key];state.countTargetsMts[key]=_t;
    save(); closeModal(); render(); toast('已清除该目标');
  });
}
function renderTodosCard(opts){
  opts=opts||{};
  const todos=state.todos||[];
  const card=el('div',opts.bare?'todo-manager':'card todo-manager');
  if(!opts.bare)card.innerHTML=`<div class="section-title"><span class="dot"></span>全部待办</div>`;
  const filterWrap=el('div','row');filterWrap.style.marginBottom='10px';
  let currentFilter=_todoFilter;
  const listWrap=el('div','todo-list');
  // 全部待办按日期「从近到远」排序：最新的在最上（9.24 在上、9.07 在下），
  // 已完成按完成日期、未完成为截止/下次/今天；不再按完成状态分组沉底。
  const gapMap=sectionGapMap();
  const gapOf=td=>(td.section&&gapMap[td.section]!=null)?gapMap[td.section]:null;
  const renderList=()=>{
    let list=todos.slice().sort((a,b)=>{
      // 按日期「从近到远」排序（最新的在最上）：已完成用 lastDone，未完成为截止/下次/今天
      const da=todoSortDate(a),db=todoSortDate(b);
      if(da!==db)return da>db?-1:1;
      const ga=gapOf(a),gb=gapOf(b);
      if(ga!=null&&gb!=null)return gb-ga;
      if(ga!=null)return -1;
      if(gb!=null)return 1;
      return (b.ts||0)-(a.ts||0);
    });
    /* 重复待办完成态走 lastDone（done 恒 false），筛选必须与列表显示同口径，
       否则今天已完成的重复任务在「已完成」里查不到、在「未完成」里还一直在 */
    const isDoneOf=x=>!!x.done||(isRepeat(x)&&x.lastDone===todayStr());
    if(currentFilter==='undone')list=list.filter(x=>!isDoneOf(x));
    if(currentFilter==='done')list=list.filter(isDoneOf);
    listWrap.innerHTML='';
    if(list.length===0)listWrap.innerHTML=`<div class="empty-tip">暂无${currentFilter==='done'?'已完成':(currentFilter==='undone'?'未完成':'')}待办</div>`;
    list.forEach(td=>{
      const it=el('div','todo-item');
      const repeatDoneToday=isRepeat(td)&&td.lastDone===todayStr();
      const isDone=td.done||repeatDoneToday;
      const key=td.section?(td.sub||td.section):null;
      const tval=(key&&state.durTargets&&state.durTargets[key]!=null)?state.durTargets[key]:null;
      const tlabel=key?(tval!=null?('目标'+tval):'设目标'):'设目标';
      it.className='todo-item'+(isDone?' done':'');
      it.dataset.id=td.id;
      it.innerHTML=`<button class="todo-check ${isDone?'checked':''}" data-id="${td.id}">${isDone?icon('check'):''}</button>
        <div class="todo-main grow">
          <div class="todo-text">${escapeHtml(td.text)}</div>
          <div class="todo-sub">${priorityLabel(todoPriority(td))} · ${td.dueDate||'长期'}${td.section&&SECTION_MAP[td.section]?' · '+SECTION_MAP[td.section].name:''}${td.sub?' · '+subName(td.sub):''}${td.count?' · '+td.count+' 题':''}${repeatLabel(td.repeat)?' · '+repeatLabel(td.repeat):''}${(isRepeat(td)&&td.doneCount)?' · 已完成'+td.doneCount+'次':''}${repeatDoneToday?' · 今日已完成':''}</div>
        </div>
        <span class="todo-pill ${todoPriority(td)}" style="background:${priorityColor(todoPriority(td))}20;color:${priorityColor(todoPriority(td))}">${priorityLabel(todoPriority(td))}</span>
        <button class="icon-btn todo-edit" data-id="${td.id}">${icon('edit')}</button>
        ${td.jumpType!=='course'?`<button class="icon-btn todo-pomo" data-id="${td.id}" title="用番茄钟开始专注" style="width:auto;padding:0 8px;">${icon('alarm')}</button>`:''}
        <button class="icon-btn todo-del" data-id="${td.id}">${icon('trash')}</button>`;
      listWrap.appendChild(it);
    });
    listWrap.querySelectorAll('.todo-check').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();toggleTodo(b.dataset.id);}));
    listWrap.querySelectorAll('.todo-edit').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const td=todos.find(x=>x.id===b.dataset.id);if(td)openTodoEditor(td);}));
    listWrap.querySelectorAll('.todo-del').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();uiConfirm('删除这条待办？',()=>{dropTodos(x=>x&&x.id===b.dataset.id);save();render();},{danger:true});}));
    listWrap.querySelectorAll('.todo-pomo').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const td=todos.find(x=>x.id===b.dataset.id);if(td)startPomoForTask(td);}));
  };
  const tabs=[{k:'all',l:'全部'},{k:'undone',l:'未完成'},{k:'done',l:'已完成'}];
  tabs.forEach(tab=>{
    const b=el('button','chip'+(tab.k===currentFilter?' active':''));
    b.textContent=tab.l;
    b.addEventListener('click',()=>{
      _todoFilter=tab.k;currentFilter=tab.k;
      filterWrap.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');renderList();
    });
    filterWrap.appendChild(b);
  });
  card.appendChild(filterWrap);
  card.appendChild(listWrap);
  renderList();
  const addBtn=el('button','btn');addBtn.innerHTML=`${icon('plus')} 添加待办`;addBtn.style.marginTop='12px';
  addBtn.addEventListener('click',()=>openTodoEditor());
  card.appendChild(addBtn);
  return card;
}
function openTodoEditor(td,presetSection,preset){
  /* 防御：不要让事件对象（MouseEvent）被当成待办数据传进来。
     否则会变成"编辑模式"：日期框变空、保存时走 map 分支导致新增无效 */
  if(td && (typeof td!=='object' || !td.id || td.text===undefined))td=null;
  const isEdit=!!td;
  const t=todayStr();
  const defSec=(preset&&preset.section)||presetSection||(td?td.section:'');
  const rep=(td&&td.repeat&&td.repeat.type)?td.repeat:null;
  const rType=rep?rep.type:'none';
  const rWeekdays=(rep&&Array.isArray(rep.weekdays))?rep.weekdays:[];
  const secOpts=[{k:'',n:'不关联模块'},...SECTIONS.map(s=>({k:s.key,n:s.name}))].map(s=>`<option value="${s.k}" ${defSec===s.k?'selected':''}>${s.n}</option>`).join('');
  // 周一在前、周日在后，符合国内习惯
  const weekChips=[1,2,3,4,5,6,0].map(d=>`<button type="button" class="chip wd-chip${rWeekdays.indexOf(d)>=0?' active':''}" data-wd="${d}">${WEEKDAY_NAMES[d].replace('周','')}</button>`).join('');
  const defJump=(preset&&preset.jumpType)||(td&&td.jumpType)||'brush';
  const jumpOpts=[{k:'course',n:'网课'},{k:'note',n:'记笔记'},{k:'brush',n:'刷题'},{k:'other',n:'其他'}].map(s=>`<option value="${s.k}" ${defJump===s.k?'selected':''}>${s.n}</option>`).join('');
  openModal(isEdit?'编辑待办':'添加待办',`
    <label class="field-label">任务内容<span class="hmark" tabindex="0" role="button" aria-label="说明">?<span class="hmark-pop">直接写你平时的说法就行；题量填在下面的「题量（题）」里，下一步建议只认这个数——不填就不参与「你已安排多少」的比对。</span></span></label>
    <input type="text" class="field" id="todoText" value="${escapeHtml((preset&&preset.text)||(td?td.text:''))}" placeholder="例如：逻辑填空30题 / 判断推理一套">
    <div style="margin-top:10px;"><label class="field-label">任务类型</label>
      <select class="field" id="todoJumpType">${jumpOpts}</select>
    </div>
    <div style="margin-top:10px;display:none;" id="todoCourseWrap"><label class="field-label">关联课程<span class="hmark" tabindex="0" role="button" aria-label="说明">?<span class="hmark-pop">选中后勾选这条待办会自动给课程「听完一讲」；关联模块也会按课程自动带出。</span></span></label>
      <select class="field" id="todoCourse"></select>
    </div>
    <div style="margin-top:10px;"><label class="field-label">关联模块（选大类，可再选子模块）</label>
      <select class="field" id="todoSection">${secOpts}</select>
      <select class="field" id="todoSub" style="margin-top:8px;display:none;"></select>
    </div>
    <div style="margin-top:10px;" id="todoCountWrap"><label class="field-label">题量（题）<span class="hmark" tabindex="0" role="button" aria-label="说明">?<span class="hmark-pop">关联「晨读 / 申论」这种不计题量的模块会自动隐藏；只有行测、套卷需要填题量。</span></span></label>
      <input type="number" class="field" id="todoCount" min="1" max="999" value="${td&&td.count?td.count:''}" placeholder="如 30">
    </div>
    <div style="margin-top:10px;">
      <label class="field-label">截止日期<span class="hmark" tabindex="0" role="button" aria-label="说明">?<span class="hmark-pop">留空或点「长期任务」表示直到考试的长期任务；优先级按截止日期自动判定：当天/逾期=紧急，5 天内=普通，更久=低，无截止日(长期)=普通</span></span></label>
      <div class="row" style="gap:8px;align-items:center;">
        <input type="date" class="field grow" id="todoDue" value="${td?td.dueDate:t}">
        <button type="button" class="btn btn-ghost btn-sm" id="todoLongTerm">长期任务</button>
      </div>
    </div>
    <div style="margin-top:10px;" id="todoRepeatWrap"><label class="field-label">重复</label>
      <select class="field" id="todoRepeat">
        <option value="none"${rType==='none'?' selected':''}>不重复</option>
        <option value="daily"${rType==='daily'?' selected':''}>每天</option>
        <option value="weekly"${rType==='weekly'?' selected':''}>每周（可选几天）</option>
        <option value="interval"${rType==='interval'?' selected':''}>每隔 N 天</option>
        <option value="monthly"${rType==='monthly'?' selected':''}>每月</option>
      </select>
      <div class="rep-sub" id="repWeekly" style="display:none;">
        <div class="wd-row">${weekChips}</div>
      </div>
      <div class="rep-sub" id="repInterval" style="display:none;">
        <span class="rep-hint">每隔</span><input type="number" class="field rep-num" id="todoInterval" min="2" max="365" inputmode="numeric" value="${rep&&rep.interval?rep.interval:3}"><span class="rep-hint">天</span>
      </div>
      <div class="rep-sub" id="repMonthly" style="display:none;">
        <span class="rep-hint">每月</span><input type="number" class="field rep-num" id="todoMonthDay" min="1" max="31" inputmode="numeric" value="${rep&&rep.monthDay?rep.monthDay:1}"><span class="rep-hint">号</span>
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px;">
      <button class="btn btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn" id="saveTodoBtn">保存</button>
    </div>`);


  /* 重复方式联动 */
  const selRepeat=$('#todoRepeat');
  if(selRepeat){
    const syncRep=()=>{
      const v=selRepeat.value;
      ['repWeekly','repInterval','repMonthly'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display='none';});
      const show={weekly:'repWeekly',interval:'repInterval',monthly:'repMonthly'}[v];
      if(show){const e=document.getElementById(show);if(e)e.style.display='block';}
    };
    selRepeat.addEventListener('change',syncRep);
    syncRep();
    const body=$('#modalBody');
    (body?body.querySelectorAll('.wd-chip'):[]).forEach(b=>b.addEventListener('click',()=>b.classList.toggle('active')));
  }
  /* 关联模块 → 子模块联动 + 目标时长预填 */
  const secSel=$('#todoSection');
  if(defSec)secSel.value=defSec;   // 确保初始 select.value 正确反映选中模块（jsdom 下刚插入的 select 取不到 selected）
  const subSel=$('#todoSub');
  function syncSub(){
    const s=secSel.value;
    const subs=subsOfSection(s);   // 申论走 SHENLUN_SUB_OPTIONS（含小题题型/大作文），行测走 EXAM_TYPES
    if(subs.length){
      subSel.style.display='block';
      subSel.innerHTML=`<option value="" title="整个大类">（整个大类）</option>`+subs.map(x=>`<option value="${x.key}" ${(td&&td.sub===x.key)?'selected':''}>${x.name}</option>`).join('');
    }else{subSel.style.display='none';subSel.innerHTML='';}
  }
  secSel.addEventListener('change',()=>{syncSub();syncJumpType();});
  // 注意：subSel 不能绑 change→syncSub，否则一选子模块就会触发重建、把当前选中清空回「整个大类」
  syncSub();

  /* 任务类型联动：网课不显示题量（不产题量）也不显示重复；记笔记不显示题量（不按题量计）、保留重复（可「每天记笔记」） */
  const jumpSel=$('#todoJumpType');
  const countWrap=$('#todoCountWrap');
  const repeatWrap=$('#todoRepeatWrap');
  const courseWrap=$('#todoCourseWrap');
  const courseSel=$('#todoCourse');
  /* 课程下拉选项：网课时显示；选中后自动带出关联模块 */
  function fillCourseSel(){
    if(!courseSel)return;
    const cs=(Array.isArray(state.courses)?state.courses:[]).filter(c=>c&&c.id);
    let cur=(td&&td.courseId)||(preset&&preset.courseId)||'';
    /* 存量文本匹配待办兜底：没有 courseId 但文本含课程名 → 自动认领 */
    if(!cur&&td&&td.text){const hit=cs.find(c=>c.name&&td.text.indexOf(c.name)>=0);if(hit)cur=hit.id;}
    courseSel.innerHTML='<option value="">不关联（仅记任务）</option>'+cs.map(c=>`<option value="${c.id}"${cur===c.id?' selected':''}>${escapeHtml(c.name)}</option>`).join('');
    if(cur)courseSel.value=cur;
  }
  function syncJumpType(){
    if(!jumpSel)return;
    const jt=jumpSel.value;
    const isCourse=jt==='course';
    const isNote=jt==='note';
    const counts=secSel.value?secCountsAsCount(secSel.value):true;
    if(countWrap)countWrap.style.display=(isCourse||isNote||!counts)?'none':'block';
    if(repeatWrap)repeatWrap.style.display=isCourse?'none':'block';
    if(courseWrap){courseWrap.style.display=isCourse?'block':'none';if(isCourse)fillCourseSel();}
  }
  /* 选中课程 → 关联模块跟随课程（不覆盖用户手改？网课场景以课程为准） */
  if(courseSel)courseSel.addEventListener('change',()=>{
    const c=(state.courses||[]).find(x=>x.id===courseSel.value);
    if(c&&c.section){secSel.value=c.section;syncSub();}
  });
  if(jumpSel)jumpSel.addEventListener('change',syncJumpType);
  syncJumpType();

  /* 长期任务按钮：清空截止日期（长期任务同样可以设重复，如"每周复习错题"） */
  const longTermBtn=$('#todoLongTerm');
  const isLongTerm=isEdit&&(!td.dueDate||td.dueDate.length===0);
  if(longTermBtn){
    if(isLongTerm){longTermBtn.textContent='✓ 长期任务';longTermBtn.classList.add('active');}
    longTermBtn.addEventListener('click',()=>{
      $('#todoDue').value='';
      longTermBtn.textContent='✓ 长期任务';
      longTermBtn.classList.add('active');
    });
  }

  $('#saveTodoBtn').addEventListener('click',()=>{
    const due=$('#todoDue').value||'';
    const section=$('#todoSection').value;
    const sub=section?($('#todoSub').value||''):'';
    const count=parseInt($('#todoCount').value,10)||0;
    const textRaw=$('#todoText').value.trim();
    const secName=section?(sub?subName(sub):((SECTION_MAP[section]&&SECTION_MAP[section].name)||section)):'任务';
    const text=textRaw||(secName+(count?(' '+count+'题'):''));
    // 长期任务也可设重复（如每周复习）；重复任务的"下次日期"按 lastDone 推算，长期任务完成后仍保持长期（不写回具体截止日）
    const rtype=selRepeat?selRepeat.value:'none';
    let repeat={type:rtype};
    if(rtype==='weekly'){
      const body=$('#modalBody');
      const days=Array.prototype.slice.call(body?body.querySelectorAll('.wd-chip.active'):[])
        .map(b=>parseInt(b.dataset.wd,10)).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
      if(!days.length){toast('请选择至少一周中的某一天');return;}
      repeat.weekdays=days;
    }else if(rtype==='interval'){
      repeat.interval=Math.max(2,parseInt($('#todoInterval').value,10)||3);
    }else if(rtype==='monthly'){
      repeat.monthDay=Math.min(31,Math.max(1,parseInt($('#todoMonthDay').value,10)||1));
    }
    const jumpType=$('#todoJumpType')?$('#todoJumpType').value:'';
    const courseId=(jumpType==='course'&&$('#todoCourse'))?($('#todoCourse').value||''):'';
    /* 编辑时以原对象为底：保留 from:'suggest' / autoTt / ephemeral 等表单里没有的标记字段，
       否则编辑过一条建议待办或听课待办后标记丢失，去重逻辑认不出它，两端会各留一条。 */
    const payload=Object.assign({},isEdit?td:{},{id:isEdit?td.id:uid(),text,dueDate:due,section,sub,count,repeat,jumpType,courseId,done:isEdit?td.done:false,ts:isEdit?(td.ts||Date.now()):Date.now(),mts:Date.now()});
    if(isEdit){
      payload.doneCount=td.doneCount||0;
      payload.lastDone=td.lastDone||'';
      payload.ts=td.ts||Date.now();
      state.todos=state.todos.map(x=>x.id===td.id?payload:x);
    }
    else{state.todos=state.todos||[];state.todos.push(payload);}
    save();closeModal();render();
  });
}

/* ============================================================
   学习总结
   ============================================================ */

/* ---------- 数据统计辅助函数 ---------- */
function getRecentDates(n){
  const dates=[];const now=new Date();
  for(let i=n-1;i>=0;i--){
    const d=new Date(now);d.setDate(now.getDate()-i);
    dates.push(fmtDate(d)); // 用本地时间，避免 toISOString 的 UTC 时区偏移（早8点前会算错一天）
  }
  return dates;
}
/* 统一口径：按做题量加权的正确率（0-100 整数）。
   dailyStats 结构为 {count, rate}（rate 已是 0-100）；无有效数据时返回 null。
   首页 / 每日计划 / 总结 三处共用，避免各写一套导致口径漂移。 */
function weightedAccuracy(entries,countRef){
  let total=0,weighted=0;
  (entries||[]).forEach(s=>{
    const c=(s&&s.count)||0;
    if(c<=0)return;
    total+=c;
    if(s.rate!=null)weighted+=c*s.rate;
  });
  if(countRef)countRef.total=total;
  return total>0?Math.round(weighted/total):null;
}
function calcPeriodStats(dates){
  // 原 calcDayLearning 只是 dayTotalMin 的转发，直接调用即可；套卷按题数加权并入
  let totalMin=0;const entries=[];
  const set=new Set(dates);
  dates.forEach(d=>{
    totalMin+=dayTotalMin(d);
    const day=state.dailyStats[d]||{};
    Object.keys(day).filter(isQSec).forEach(k=>entries.push(day[k]));
    // 并入区间内的套卷(moduleStats 按题数加权)
    (state.examRecords||[]).forEach(r=>{
      if(!set.has(r.date)||!r.moduleStats)return;
      Object.keys(r.moduleStats).forEach(et=>{
        const m=r.moduleStats[et]; if(!m||!m.total)return;
        entries.push({count:m.total, rate:Math.round(m.correct/m.total*100)});
      });
    });
  });
  const countRef={total:0};
  const acc=weightedAccuracy(entries,countRef);
  return {
    minutes:totalMin,
    hours:+(totalMin/60).toFixed(1),
    accuracy:acc!=null?acc:0,
    count:countRef.total
  };
}
/* 周期内「非题」类的打卡量：申论几篇、套卷几套、晨读几次 */
function countUnitInRange(dates){
  const set=new Set(dates);
  const out={};
  Object.keys(state.dailyStats||{}).forEach(d=>{
    if(!set.has(d))return;
    Object.entries(state.dailyStats[d]||{}).forEach(([k,s])=>{
      if(isQSec(k))return;
      const c=s.count||0;if(!c)return;
      out[k]=(out[k]||0)+c;
    });
  });
  return out;
}
function pctChange(cur,prev){
  if(prev===0)return cur>0?'+100%':'—';
  const pct=Math.round((cur-prev)/prev*100);
  return (pct>=0?'+':'')+pct+'%';
}

/* ---------- SVG 折线图（支持多系列：series=[{data,color,label}]，data 元素可为 null） ---------- */
function drawLineChart(series,labels,unit,height=140){
  const w=320,h=height,pad={t:15,r:15,b:38,l:35};
  const cw=w-pad.l-pad.r,ch=h-pad.t-pad.b;
  const allValid=series.flatMap(s=>s.data).filter(v=>v!==null&&v!==undefined);
  if(allValid.length===0)return `<div class="empty-tip" style="padding:20px 0;">暂无数据</div>`;
  const max=Math.max(...allValid,unit==='%'?100:1),min=0;
  const x=i=>pad.l+(cw/(labels.length-1||1))*i;
  const y=v=>pad.t+ch-(v-min)/(max-min||1)*ch;
  let paths='',dots='';
  series.forEach(s=>{
    const pts=s.data.map((v,i)=>(v===null||v===undefined)?null:{x:x(i),y:y(v),v});
    const vp=pts.filter(p=>p);
    if(vp.length===0)return;
    let d='';vp.forEach((p,i)=>{d+=(i?'L':'M')+p.x.toFixed(1)+','+p.y.toFixed(1)+' ';});
    paths+=`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${series.length>1?'opacity="0.92"':''}/>`;
    vp.forEach(p=>{dots+=`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="${s.color}" stroke="#fff" stroke-width="1.5"/>`;});
  });
  let yLabels='';
  for(let i=0;i<=3;i++){
    const val=min+(max-min)*i/3;const yy=pad.t+ch-ch*i/3;
    const label=unit==='%'?Math.round(val)+'%':(unit==='分'?Math.round(val)+'分':(val>=60?(val/60).toFixed(1)+'h':Math.round(val)+'m'));
    yLabels+=`<text x="${pad.l-5}" y="${yy+4}" text-anchor="end" font-size="10" fill="#999">${label}</text>`;
    yLabels+=`<line x1="${pad.l}" y1="${yy}" x2="${w-pad.r}" y2="${yy}" stroke="#f0f0f0" stroke-width="1"/>`;
  }
  // X轴：标签多时自动稀疏，并旋转45°避免重叠
  const maxTicks=6;
  const step=Math.max(1,Math.ceil(labels.length/maxTicks));
  let xLabels='';
  labels.forEach((l,i)=>{
    if(labels.length>1 && i!==0 && i!==labels.length-1 && i%step!==0)return;
    const xx=x(i);
    xLabels+=`<text x="${xx}" y="${h-10}" text-anchor="end" font-size="9" fill="#999" transform="rotate(-45,${xx},${h-10})">${l}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block;">${yLabels}${paths}${dots}${xLabels}</svg>`;
}

/* ---------- 薄弱考点分析 ---------- */
// SECTION_TO_EXAMTYPE 在文件下方定义（运行期已就绪），这里反查 et->section
const ET2SEC={}; // 题型 key → 每日计划模块 key（真正填充见下方 EXAM_TYPES.forEach 处，SECTION_TO_EXAMTYPE 彼时已定义）
function getWeakPoints(){
  const stats={};
  const add=(key,count,acc,minutes)=>{
    if(!stats[key])stats[key]={count:0,weighted:0,minutes:0};
    stats[key].count+=count;
    if(count>0)stats[key].weighted+=count*acc;
    stats[key].minutes+=(minutes||0);
  };
  // 1) 每日刷题（原有）
  Object.entries(state.dailyStats||{}).forEach(([date,ds])=>{
    Object.entries(ds).forEach(([key,s])=>{
      const c=s.count||0; if(c<=0)return;
      const r=(s.rate!=null)?s.rate:0;
      add(key,c,r,s.minutes||0);
    });
  });
  // 2) 粉笔导入的套卷：用 moduleStats（按题数加权，最准）
  (state.examRecords||[]).forEach(r=>{
    const ms=r.moduleStats; if(!ms)return;
    Object.keys(ms).forEach(et=>{
      const sec=ET2SEC[et]; if(!sec)return;
      const m=ms[et]; if(!m||!m.total)return;
      const acc=Math.round(m.correct/m.total*100);
      add(sec,m.total,acc,0);
    });
  });
  return Object.entries(stats)
    .map(([key,s])=>({
      key,
      name:SECTION_MAP[key]?.name||key,
      count:s.count,
      accuracy:s.count>0?Math.round(s.weighted/s.count):0,
      minutes:s.minutes
    }))
    .filter(x=>x.count>0)
    .sort((a,b)=>a.accuracy-b.accuracy);
}

/* 各模块「差距」= 目标正确率 - 当前正确率（数值越大越薄弱）。
   未设目标、或该模块暂无刷题数据时记为 null，不参与排序（保持原有日期顺序）。 */
function sectionGapMap(){
  const map={};
  getWeakPoints().forEach(w=>{
    const tgt=(state.weakTargets&&state.weakTargets[w.key]!=null)?state.weakTargets[w.key]:null;
    map[w.key]=(tgt!=null)?(tgt-w.accuracy):null;
  });
  return map;
}
/* 模块当前正确率（0-100，无刷题数据返回 null）。key 支持大类 examKey（'言语'）或子模块 key（'言语_逻辑填空'） */
function getModuleAccuracy(key){
  if(key&&key.indexOf('_')>0){
    const tn=key.split('_')[0];
    const sec=ET_TO_SEC[tn]; if(!sec)return null;
    const subObj=(SECTION_ET[sec]&&SECTION_ET[sec].subs||[]).find(x=>x.key===key||x.name===key);
    const subNm=subObj?subObj.name:key;
    const subKey=subObj?subObj.key:key;
    let count=0,weighted=0;
    Object.values(state.dailyStats||{}).forEach(ds=>{
      const s=ds[sec]; if(!s||!s.subs)return;
      const sv=s.subs[subNm]||s.subs[subKey]; if(!sv||!(sv.count>0))return;
      count+=sv.count; if(sv.rate!=null)weighted+=sv.count*sv.rate;
    });
    return count>0?Math.round(weighted/count):null;
  }
  // 兼容两种 key：中文题型名（'资料分析'→ET_TO_SEC）与英文模块 key（'ziliao'→SECTION_ET 自证）。
  // 六维雷达传的是英文 key，过去只查 ET_TO_SEC 会查不到 → 永远返回 null，雷达全空。
  const sec=ET_TO_SEC[key]||(SECTION_ET[key]?key:null); if(!sec)return null;
  const w=getWeakPoints().find(x=>x.key===sec);
  return w?w.accuracy:null;
}
/* ============================================================
   周期复盘：按周 / 自定义区间汇总，并可与上一个周期对比 + 写小结
   ============================================================ */
const PERIOD_KINDS=[{key:'week',name:'本周'},{key:'lastweek',name:'上周'},{key:'d7',name:'近7天'},{key:'d30',name:'近30天'},{key:'all',name:'全部'}];
let _periodKind='week';
/* 重绘但保持当前滚动位置：切换周期/保存小结时用，避免被弹回顶部 */
function renderKeepScroll(){
  const content=$('#content');
  const expanded=[...new Set([...document.querySelectorAll('#content .weak-sub')]
    .filter(s=>s.style.display!=='none').map(s=>s.dataset.parent))];
  _preserveView={scrollTop:(content&&content.scrollTop)||0,scrollY:window.scrollY||0,expanded:expanded};
  render();
  _preserveView=null;
}
function dateRange(s,e){
  const out=[];let d=s;let guard=0;
  while(d<=e&&guard++<800){out.push(d);d=addDays(d,1);}
  return out;
}
function periodRange(kind){
  const t=todayStr();
  const dow=(new Date(t+'T00:00:00').getDay()+6)%7; // 周一=0
  if(kind==='week'){
    const start=addDays(t,-dow);
    return {key:'week:'+start,label:`${start} ~ ${t}`,start,end:t,prevStart:addDays(start,-7),prevEnd:addDays(start,-1),prevLabel:'较上周'};
  }
  if(kind==='lastweek'){
    const s0=addDays(t,-dow-7),e0=addDays(t,-dow-1);
    return {key:'lastweek:'+s0,label:`${s0} ~ ${e0}`,start:s0,end:e0,prevStart:addDays(s0,-7),prevEnd:addDays(s0,-1),prevLabel:'较上上周'};
  }
  if(kind==='d7'){
    const start=addDays(t,-6);
    return {key:'d7:'+start,label:`${start} ~ ${t}`,start,end:t,prevStart:addDays(start,-7),prevEnd:addDays(start,-1),prevLabel:'较前7天'};
  }
  if(kind==='d30'){
    const start=addDays(t,-29);
    return {key:'d30:'+start,label:`${start} ~ ${t}`,start,end:t,prevStart:addDays(start,-30),prevEnd:addDays(start,-1),prevLabel:'较前30天'};
  }
  const all=[...new Set(Object.keys(state.dailyStats||{}).concat(Object.keys(state.studyRecords||{})))].sort();
  return {key:'all',label:all.length?`${all[0]} ~ ${all[all.length-1]}`:'暂无数据',start:all[0]||t,end:all[all.length-1]||t,prevStart:null,prevEnd:null,prevLabel:'—'};
}
/* 区间内各模块的加权正确率与题量（每日刷题 + 套卷，与薄弱考点算法一致） */
function statsInRange(dates){
  const set=new Set(dates);
  const stats={};
  const add=(key,count,acc)=>{
    if(!stats[key])stats[key]={count:0,w:0};
    stats[key].count+=count;
    if(count>0)stats[key].w+=count*acc;
  };
  Object.keys(state.dailyStats||{}).forEach(d=>{
    if(!set.has(d))return;
    Object.entries(state.dailyStats[d]||{}).forEach(([k,s])=>{
      // 申论记「篇」、套卷记「套」、晨读记「次」，都不算进刷题量和加权正确率
      if(!isQSec(k))return;
      const c=s.count||0;if(c>0)add(k,c,(s.rate!=null)?s.rate:0);
    });
  });
  (state.examRecords||[]).forEach(r=>{
    if(!set.has(r.date))return;
    const ms=r.moduleStats;if(!ms)return;
    Object.keys(ms).forEach(et=>{
      const sec=ET2SEC[et];if(!sec)return;
      const m=ms[et];if(!m||!m.total)return;
      add(sec,m.total,Math.round(m.correct/m.total*100));
    });
  });
  return stats;
}
function periodSummary(dates){
  let minutes=0,sessions=0;
  dates.forEach(d=>{
    minutes+=dayTotalMin(d);
    // 专注次数以独立计数器 focusCount 为准（番茄钟→录成绩后 session 被消费防时长双算，
    // 但次数不能丢）；旧数据没有该字段时回退为 sessions 段数
    const _sr=state.studyRecords[d];
    sessions+=(_sr&&typeof _sr.focusCount==='number')?_sr.focusCount:(((_sr||{}).sessions||[]).length);
  });
  const stats=statsInRange(dates);
  let count=0,w=0;
  Object.values(stats).forEach(s=>{count+=s.count;w+=s.w;});
  return {
    minutes,sessions,
    hours:+(minutes/60).toFixed(1),
    count,
    accuracy:count>0?Math.round(w/count):null,
    activeDays:dates.filter(d=>dayTotalMin(d)>0).length,
    stats
  };
}
function renderPeriodReview(){
  const card=el('div','card');card.id='learningOverviewCard';
  const p=periodRange(_periodKind);
  const dates=dateRange(p.start,p.end);
  const cur=periodSummary(dates);
  const prev=p.prevStart?periodSummary(dateRange(p.prevStart,p.prevEnd)):null;
  const delta=(a,b,unit)=>{
    if(prev===null||a==null||b==null)return '<span style="color:#ccc;">—</span>';
    const d=a-b;
    if(d===0)return '<span style="color:var(--text-3);">持平</span>';
    const cls=d>0?'ov-up':'ov-down';
    return `<span class="${cls}">${d>0?'+':''}${d}${unit||''}</span>`;
  };
  const acc=cur.accuracy==null?'—':cur.accuracy+'%';
  card.innerHTML=`<div class="section-title"><span class="dot"></span>学习数据概览</div>`;
  const chips=el('div','row wrap');
  chips.style.marginBottom='10px';
  chips.innerHTML=PERIOD_KINDS.map(k=>`<button class="chip${k.key===_periodKind?' active':''}" data-pk="${k.key}">${k.name}</button>`).join('');
  card.appendChild(chips);
  const range=el('div','muted');
  range.style.fontSize='12px';
  range.textContent=`${p.label} · ${dates.length} 天 · 有学习记录 ${cur.activeDays} 天`;
  card.appendChild(range);
  const grid=el('div','overview-grid');
  grid.innerHTML=`
    <div class="ov-cell">
      <div class="ov-label">刷题量</div>
      <div class="ov-num">${cur.count}<span class="ov-unit">题</span></div>
      <div class="ov-change">${prev?p.prevLabel+' '+delta(cur.count,prev.count,''):'—'}</div>
    </div>
    <div class="ov-cell">
      <div class="ov-label">加权正确率</div>
      <div class="ov-num">${acc}</div>
      <div class="ov-change">${prev?p.prevLabel+' '+delta(cur.accuracy,prev.accuracy,'%'):'—'}</div>
    </div>
    <div class="ov-cell">
      <div class="ov-label">专注次数</div>
      <div class="ov-num">${cur.sessions}<span class="ov-unit">次</span></div>
      <div class="ov-change">${prev?p.prevLabel+' '+delta(cur.sessions,prev.sessions,''):'—'}</div>
    </div>`;
  card.appendChild(grid);
  // 各模块正确率对比（含与上一周期涨跌）
  const sub=el('div','block-subtitle');
  sub.textContent='各模块正确率'+(prev?'（括号内为较上一周期）':'');
  card.appendChild(sub);
  const hasAny=Object.keys(cur.stats).length>0;
  if(!hasAny){
    const e=el('div','empty-tip');e.textContent='该周期内还没有刷题数据';
    card.appendChild(e);
  }else{
    const rows=el('div','pr-bars');
    ROW_KEYS.forEach(k=>{
      const s=cur.stats[k];
      if(!s||!s.count)return;
      const a=Math.round(s.w/s.count);
      const ps=prev&&prev.stats[k];
      const pa=ps?Math.round(ps.w/ps.count):null;
      const d=(pa!=null)?a-pa:null;
      const col=(SECTION_MAP[k]&&SECTION_MAP[k].color)||'var(--primary)';
      const row=el('div','pr-bar');
      row.innerHTML=`
        <span class="prb-name">${SECTION_MAP[k].name}</span>
        <span class="prb-track"><i style="width:${Math.min(100,a)}%;background:${col};"></i></span>
        <span class="prb-val">${a}%</span>
        <span class="prb-delta">${d==null?'':(d===0?'<span style="color:var(--text-3);">持平</span>':`<span class="${d>0?'ov-up':'ov-down'}">${d>0?'+':''}${d}</span>`)}</span>
        <span class="prb-count">${s.count}题</span>`;
      rows.appendChild(row);
    });
    card.appendChild(rows);
  }
  // 本周/本月 申论·套卷·晨读 unit 统计（并入自原「学习数据概览」卡）
  const wkUnits=countUnitInRange(getRecentDates(7));
  const moUnits=countUnitInRange(getRecentDates(30));
  const fmtUnits=(o)=>{
    const parts=[];
    ['shenlun','taojuan','chendu'].forEach(k=>{if(!o[k])return;parts.push(`${SECTION_MAP[k].name} <b>${o[k]}</b> ${(CHECKIN_UNIT&&CHECKIN_UNIT[k])||''}`);});
    return parts.length?parts.join(' · '):'暂无';
  };
  const otherBox=el('div','ci-cheer');
  otherBox.innerHTML=`本周：${fmtUnits(wkUnits)}　｜　本月：${fmtUnits(moUnits)}`;
  card.appendChild(otherBox);
  // 交互
  chips.querySelectorAll('[data-pk]').forEach(b=>b.addEventListener('click',()=>{
    _periodKind=b.dataset.pk;
    renderKeepScroll();
  }));
  return card;
}
/* ---------- 行测套卷复盘 ---------- */
/* 注意：这里不再内置任何目标正确率（原 target 字段已移除）。
   所有目标均由用户在「薄弱考点分析」里自定，存于 state.weakTargets。 */
const EXAM_TYPES=[
  {key:'言语',name:'言语理解',color:'#8e7cc3',
   subs:[
     {key:'言语_逻辑填空',name:'逻辑填空'},
     {key:'言语_片段阅读',name:'片段阅读'},
     {key:'言语_语句表达',name:'语句表达'},
   ]},
  {key:'判断推理',name:'判断推理',color:'#4a90d9',
   subs:[
     {key:'判断_图形推理',name:'图形推理'},
     {key:'判断_定义判断',name:'定义判断'},
     {key:'判断_类比推理',name:'类比推理'},
     {key:'判断_逻辑判断',name:'逻辑判断'},
   ]},
  {key:'资料分析',name:'资料分析',color:'#2bb673'},
  {key:'数量关系',name:'数量关系',color:'#e8a33d',goalNoSubs:true,
   subs:[
     {key:'数量_工程问题',name:'工程问题'},
     {key:'数量_行程问题',name:'行程问题'},
     {key:'数量_利润问题',name:'经济利润问题'},
     {key:'数量_和差倍比',name:'和差倍比'},
     {key:'数量_排列组合',name:'排列组合'},
     {key:'数量_概率问题',name:'概率问题'},
     {key:'数量_最值问题',name:'最值问题'},
     {key:'数量_几何问题',name:'几何问题'},
     {key:'数量_其他',name:'其他'},
   ]},
  {key:'政治常识',name:'政治常识',color:'#c77dbe',
   subs:[
     {key:'政治常识_政治理论',name:'政治理论'},
     {key:'政治常识_常识',name:'常识'},
   ]},
];
function typeColor(k){const t=EXAM_TYPES.find(x=>x.key===k);return t?t.color:'#b2bec3';}
/* 每日计划模块 key → 题型名（用于自动汇总「每日刷题」正确率） */
/* 每日计划模块 key → EXAM_TYPES key（用于自动汇总「每日刷题」正确率、读取子模块看板）。
   注意：值是 EXAM_TYPES 的 key（中文），不是它的 name；PC 哪天 dailyStats 含 changshi ，
   SECTION_TO_EXAMTYPE[changshi] 必须命中 EXAM_TYPES 的 '政治常识'（key 与 name 现在一致），
   否则 typeAgg[tn] 为 undefined、buildBlendModel 直接抛错——这是 PC 正常/手机空白的真正差异。 */
const SECTION_TO_EXAMTYPE={
  yanyu:'言语',luoji:'判断推理',ziliao:'资料分析',shuliang:'数量关系',changshi:'政治常识'
};
/* 每日计划模块 key → EXAM_TYPES 条目（用于把每日刷题的子模块关接到子模块看板） */
const SECTION_ET={};
const ET_TO_SEC={};   // 题型 key → 每日计划模块 key（用于读取用户自定的目标正确率）
EXAM_TYPES.forEach(t=>{
  const sec=Object.keys(SECTION_TO_EXAMTYPE).find(k=>SECTION_TO_EXAMTYPE[k]===t.key);
  if(sec){SECTION_ET[sec]=t;ET_TO_SEC[t.key]=sec;ET2SEC[t.key]=sec;}
});
/* 合并「套卷 + 每日刷题」：按题量加权（不是同日二选一、不是等权平均）。
   返回：
   - dates / dailyRate / examRate / blendedRate：每日期 套卷/平时/综合 三套率（0-100 或 null）
   - typeAgg：各题型 {exam:{t,c}, daily:{t,c}}（blended = 两者相加）
   - overall：全局 {exam,daily} 聚合
   - rateMap：综合 per-date per-type（0-1），供 renderRateTrend / avgTypeRate / avgSubRate
   根治旧 buildReviewRateMap 的两个 bug：同日套卷覆盖平时、各日期等权平均。 */
function buildBlendModel(){
  const types=EXAM_TYPES;
  const typeAgg={};types.forEach(t=>{typeAgg[t.key]={exam:{t:0,c:0},daily:{t:0,c:0}};});
  const overall={exam:{t:0,c:0},daily:{t:0,c:0}};
  const dateDaily={},dateExam={},dailyByDate={},examByDate={};
  // 平时
  Object.keys(state.dailyStats||{}).forEach(date=>{
    const day=state.dailyStats[date]||{};
    Object.keys(day).forEach(sec=>{
      if(!isQSec(sec))return;
      const s=day[sec]||{};const cnt=s.count||0; if(cnt<=0)return;
      const tn=SECTION_TO_EXAMTYPE[sec]; if(!tn)return;
      const acc=cnt*(s.rate!=null?s.rate:0)/100;  // 保留浮点，避免正确题数中间四舍五入放大误差（30题75% 不该变 77%）
      typeAgg[tn].daily.t+=cnt;typeAgg[tn].daily.c+=acc;
      overall.daily.t+=cnt;overall.daily.c+=acc;
      (dateDaily[date]=dateDaily[date]||[]).push({count:cnt,rate:(s.rate!=null?s.rate:0)});
      const db=dailyByDate[date]=dailyByDate[date]||{types:{},subs:{}};
      db.types[tn]={t:cnt,c:acc};
      if(s.subs)Object.keys(s.subs).forEach(snm=>{
        const sv=s.subs[snm]; if(!(sv&&(sv.count||0)>0))return;
        const sub=types.find(t=>t.key===tn); if(!sub||!sub.subs)return;
        const sb=sub.subs.find(x=>x.name===snm||x.key===snm); if(sb)db.subs[sb.key]={count:sv.count,rate:sv.rate!=null?sv.rate:0};
      });
    });
  });
  // 套卷
  (state.examRecords||[]).forEach(r=>{
    const ms=r.moduleStats||{};
    EXAM_TYPES.forEach(t=>{
      const m=ms[t.key]; if(!m||!m.total)return;
      typeAgg[t.key].exam.t+=m.total;typeAgg[t.key].exam.c+=m.correct;
      overall.exam.t+=m.total;overall.exam.c+=m.correct;
      (dateExam[r.date]=dateExam[r.date]||[]).push({count:m.total,rate:m.correct/m.total*100});
      const eb=examByDate[r.date]=examByDate[r.date]||{types:{},subs:{}};
      eb.types[t.key]={t:m.total,c:m.correct};
      /* 子题型（openExamEditor 录入时挂 moduleStats[大类].subs）：并入当天 subs，
         与每日刷题子模块在 rateMap 里同口径题量加权 */
      if(m.subs)Object.keys(m.subs).forEach(sk=>{
        const sv=m.subs[sk]; if(!sv||!sv.total)return;
        eb.subs[sk]={count:sv.total,rate:sv.correct/sv.total*100};
      });
    });
  });
  // per-date 三套率
  const allDates=Array.from(new Set([...Object.keys(dateDaily),...Object.keys(dateExam)])).sort();
  const dailyRate={},examRate={},blendedRate={};
  allDates.forEach(d=>{
    const de=dateDaily[d]||[],ee=dateExam[d]||[];
    dailyRate[d]=de.length?weightedAccuracy(de):null;
    examRate[d]=ee.length?weightedAccuracy(ee):null;
    blendedRate[d]=(de.length||ee.length)?weightedAccuracy(de.concat(ee)):null;
  });
  // rateMap（综合 per-date per-type）
  const rateMap={};
  allDates.forEach(d=>{
    const o=rateMap[d]={};
    const db=dailyByDate[d]||{types:{},subs:{}},eb=examByDate[d]||{types:{},subs:{}};
    EXAM_TYPES.forEach(t=>{
      const dt=(db.types[t.key]||{}).t||0,dc=(db.types[t.key]||{}).c||0;
      const et=(eb.types[t.key]||{}).t||0,ec=(eb.types[t.key]||{}).c||0;
      if(dt+et>0)o[t.key]=(dc+ec)/(dt+et);
      /* 子题型：平时(db.subs)+套卷(eb.subs) 按题量加权合并成当天一个率 */
      if(t.subs)t.subs.forEach(sub=>{
        const svd=db.subs[sub.key],sve=eb.subs[sub.key];
        let st=0,sc=0;
        if(svd&&svd.count>0){st+=svd.count;sc+=svd.count*svd.rate/100;}
        if(sve&&sve.count>0){st+=sve.count;sc+=sve.count*sve.rate/100;}
        if(st>0)o[sub.key]=sc/st;
      });
    });
  });
  return {dates:allDates,dailyRate,examRate,blendedRate,typeAgg,overall,rateMap};
}

/* 正确率圆环（手写 SVG） */
function ringSvg(rate,color){
  const r=26,C=2*Math.PI*r, off=C*(1-(rate!=null?rate:0));
  const pct=rate!=null?Math.round(rate*100)+'%':'—';
  return `<svg class="ring" viewBox="0 0 64 64" width="64" height="64" aria-label="正确率">
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="#eef0f3" stroke-width="6"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="6"
      stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
      transform="rotate(-90 32 32)"/>
    <text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-size="14" font-weight="700" fill="${rate!=null?color:'#b2bec3'}">${pct}</text>
  </svg>`;
}
function htmlEl(html){const d=document.createElement('div');d.innerHTML=html.trim();return d.firstElementChild;}

/* 取某题型在某条记录 rates 里的聚合正确率：优先整体键 t.key；否则取子模块平均（兼容旧数据与大模块） */
function getModuleRate(rates,t){
  if(rates&&rates[t.key]!=null)return rates[t.key];
  if(t.subs){let sum=0,n=0;t.subs.forEach(s=>{if(rates&&rates[s.key]!=null){sum+=rates[s.key];n++;}});if(n)return sum/n;}
  return null;
}
/* 跨日期平均：某题型整体正确率 */
function avgTypeRate(rateMap,t){
  const vals=[];
  Object.keys(rateMap).forEach(d=>{const v=getModuleRate(rateMap[d],t);if(typeof v==='number')vals.push(v);});
  return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;
}
/* 跨日期平均：某个子模块正确率 */
function avgSubRate(rateMap,s){
  const vals=[];
  Object.keys(rateMap).forEach(d=>{const v=rateMap[d]&&rateMap[d][s.key];if(typeof v==='number')vals.push(v);});
  return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;
}

/* 题型正确率看板：综合（套卷+平时 题量加权）主环 + 套卷/平时拆开看 */
function renderTypeDashboard(model){
  const wrap=el('div','type-dash');
  const fR=v=>v!=null?Math.round(v*100)+'%':'—';
  EXAM_TYPES.forEach(t=>{
    const ta=model.typeAgg[t.key];
    const bt=ta.exam.t+ta.daily.t, bc=ta.exam.c+ta.daily.c;
    const avg=bt>0?bc/bt:null;
    const er=ta.exam.t>0?ta.exam.c/ta.exam.t:null;
    const dr=ta.daily.t>0?ta.daily.c/ta.daily.t:null;
    const ring=el('div','type-ring');
    const secKey=ET_TO_SEC[t.key];
    const tgt=(secKey&&state.weakTargets&&state.weakTargets[secKey]!=null)?state.weakTargets[secKey]:null;
    const gap=(avg!=null&&tgt!=null)
      ? (avg*100>=tgt?`<div class="type-gap ok">✓ 达标</div>`:`<div class="type-gap bad">差 ${Math.round(tgt-avg*100)}%</div>`)
      : (avg!=null?`<div class="type-gap muted">—</div>`:`<div class="type-gap muted">暂无</div>`);
    const split=(er!=null||dr!=null)?`<div class="type-split">套卷 ${fR(er)} · 平时 ${fR(dr)}</div>`:'';
    ring.innerHTML=ringSvg(avg,t.color)+`<div class="type-name" style="color:${t.color}">${t.name}</div>`+
      `<div class="type-target">目标 ${tgt!=null?tgt+'%':'—'}</div>`+gap+split;
    wrap.appendChild(ring);
  });
  return wrap;
}
/* 子模块明细：仅展示被拆分的题型，下挂各子模块正确率环 */
/* 正确率趋势折线（手写 SVG，多题型同图，套卷+每日刷题合并） */
function renderRateTrend(rateMap){
  const dates=Object.keys(rateMap).sort();
  if(dates.length<2)return htmlEl(`<div class="trend-box"><div class="trend-title">各题型正确率趋势（套卷 + 每日刷题 · 题量加权）</div><div class="empty-tip" style="padding:14px 0;">至少录入 2 天数据后才会显示趋势曲线</div></div>`);
  const W=340,H=170,padL=26,padR=8,padT=14,padB=26;
  const x=i=>padL+(dates.length===1?0:i*(W-padL-padR)/(dates.length-1));
  const y=v=>padT+(1-v)*(H-padT-padB);
  let paths='',legend='';
  EXAM_TYPES.forEach(t=>{
    const pts=dates.map((d,i)=>{
      const v=getModuleRate(rateMap[d],t);
      return (typeof v==='number')?{x:x(i),y:y(v),has:true}:{x:x(i),y:null,has:false};
    }).filter(p=>p.has);
    if(pts.length<1)return;
    const dStr=pts.map((p,i)=>(i?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1)).join(' ');
    paths+=`<path d="${dStr}" fill="none" stroke="${t.color}" stroke-width="2" stroke-linejoin="round"/>`;
    pts.forEach(p=>{paths+=`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="${t.color}"/>`;});
    legend+=`<span class="legend-item"><i style="background:${t.color}"></i>${t.name}</span>`;
  });
  const grid=[0,0.5,1].map(v=>`<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W-padR}" y2="${y(v).toFixed(1)}" stroke="#eef0f3" stroke-width="1"/><text x="${padL-4}" y="${(y(v)+3).toFixed(1)}" text-anchor="end" font-size="8" fill="#b2bec3">${Math.round(v*100)}</text>`).join('');
  const svg=`<div class="trend-box">
    <div class="trend-title">各题型正确率趋势（套卷 + 每日刷题 · 题量加权）</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${grid}${paths}</svg>
    <div class="legend">${legend}</div></div>`;
  return htmlEl(svg);
}

/* ============================================================
   任务题量：只认你手填的 td.count，不再从文案里猜
   ============================================================ */
/* 该模块「一组/一套」算多少题：现在只用来把「套卷」的整卷题量按比例摊到各模块。
   优先用你在「我的目标 → 题量」里设的那个数，没设才回退到报考类型的默认常量。 */
function getModuleVol(sec){
  const t=(typeof resolveCountTarget==='function')?resolveCountTarget(sec,null):null;
  if(t&&t>0)return t;
  const cfg=(typeof state!=='undefined'&&state&&state.setVolume)?state.setVolume:{};
  const v=(cfg&&cfg[sec]!=null)?cfg[sec]:DEFAULT_SET_VOLUME[sec];
  return Math.max(1,parseInt(v,10)||20);
}
/* 折算到每天的系数：每天=1，每3天=1/3，每周选3天=3/7，每月=1/30；算不出返回 null */
function dailyFactor(td){
  if(isRepeat(td)){
    const r=td.repeat;
    if(r.type==='daily')return 1;
    if(r.type==='interval')return 1/Math.max(1,parseInt(r.interval,10)||2);
    if(r.type==='weekly'){const d=(Array.isArray(r.weekdays)&&r.weekdays.length)?r.weekdays.length:1;return d/7;}
    if(r.type==='monthly')return 1/30;
    return null;
  }
  // 非循环任务：文案里写了「每天/每日」才算日常量，否则视为一次性任务，不参与折算
  if(/每天|每日|天天/.test(td.text||''))return 1;
  return null;
}
/* 一条任务折算到「每个模块每天多少题」，返回 {模块: 题量}
   题量只认你在任务里手填的那个数（td.count），不再从文案里猜：
   · 没填题量 → 返回 null，不参与「已安排量」比对（未完成任务条数照常统计）
   · 套卷（真题卷/模拟卷…）→ 手填的是整卷题量，按各模块目标题量的比例摊到各模块，标记 _cross/est
   模块归属也只认你手选的「关联模块」，不从文案里认字 */
const ALL_ROW_KEYS=ROW_KEYS;
function todoVolumes(td){
  if(!td)return null;
  const f=dailyFactor(td);
  const n=parseInt(td.count,10);
  if(f==null||!(n>0))return null;
  const round=function(x){return Math.round(x*10)/10;};
  // 套卷天然跨模块，先摊再谈别的
  if(WHOLE_EXAM_RE.test(String(td.text||''))){
    const w=ALL_ROW_KEYS.map(getModuleVol);
    const wtot=w.reduce(function(a,b){return a+b;},0)||1;
    const out={_cross:true,est:true};
    ALL_ROW_KEYS.forEach(function(k,i){out[k]=round(n*w[i]/wtot*f);});
    return out;
  }
  const sec=td.section;
  if(!sec)return null;
  const o={};o[sec]=round(n*f);
  return o;
}
/* 某模块用户已安排的刷题计划：每天总量 + 可调整的那条任务 + 未完成任务总数
   归属判断：文案认得出模块就按文案，认不出才看手选的「关联模块」；
   套卷算进覆盖量，但不拿来当被改的那条（跨模块，改一个数说不清） */
function modulePlan(sec){
  let vol=0,target=null,count=0,cross=0,est=false;
  const list=(typeof state!=='undefined'&&Array.isArray(state.todos))?state.todos:[];
  list.forEach(function(td){
    if(!td||td.done)return;
    const vs=todoVolumes(td);
    const v=vs?vs[sec]:null;
    const owner=vs?(v!=null?sec:null):(td.section||null);
    if(owner!==sec)return;
    count++;
    if(v==null)return;
    vol+=v;
    // 套卷那部分是按比例摊出来的（est），也算估算
    if(vs._cross){cross+=v;est=est||!!vs.est;}
    else{if(vs.est)est=true;if(!target)target=td;}
  });
  return {
    vol:vol>0?Math.round(vol*10)/10:null,
    target:target,
    count:count,
    crossVol:cross>0?Math.round(cross*10)/10:null,
    est:est
  };
}
/* 「一组=多少题」设置：不同考试题量不一样，自己改最准 */
/* ============================================================
   下一步建议：把「目标 - 正确率」的差距翻译成一件今天就能做的事
   优先级：样本不足(1) < 未设目标(2) < 差距小(3) < 差距中(4) < 差距大(5)；达标为 0 不展示
   若该模块用户已有刷题计划，则不再另起炉灶，只判断「够不够」：
     已安排的每天题量 ≥ 建议量 → 划为「已覆盖」，不占建议名额
     已安排但不够 → 提示加量，并提供「调整已有计划」
   只取前 3 条，避免建议过载
   ============================================================ */
function buildNextSteps(){
  const weak={};getWeakPoints().forEach(w=>{weak[w.key]=w;});
  const keys=ROW_KEYS.slice();
  const today=todayStr();
  /* 有待完成的套卷时先不加专项：
     套卷没做完、没复盘录成绩，薄弱点本来就不准，这时候加专项是瞎指挥。
     等套卷完成并录入成绩后，建议会自动回来。 */
  const pendingExams=(Array.isArray(state.todos)?state.todos:[])
    .filter(t=>t&&!t.done&&(WHOLE_EXAM_RE.test(String(t.text||''))||t.section==='taojuan'))
    .map(t=>({text:t.text,dueDate:t.dueDate||''}));
  if(pendingExams.length)return {steps:[],rest:[],examPending:pendingExams};
  // 最近一次某模块有题量的日期，用于「多久没练了」
  const lastPractice={};
  Object.keys(state.dailyStats||{}).forEach(d=>{
    Object.keys(state.dailyStats[d]||{}).forEach(sec=>{
      if(((state.dailyStats[d][sec]||{}).count||0)>0&&(!lastPractice[sec]||d>lastPractice[sec]))lastPractice[sec]=d;
    });
  });
  const daysSince=s=>lastPractice[s]?Math.round((new Date(today+'T00:00:00')-new Date(lastPractice[s]+'T00:00:00'))/86400000):null;
  const out=[];
  keys.forEach(k=>{
    const w=weak[k];
    const count=w?w.count:0;
    const acc=w?w.accuracy:null;
    const tgt=(state.weakTargets&&state.weakTargets[k]!=null)?state.weakTargets[k]:null;
    let urgency=0,action='',vol=null;
    if(count<30){
      // 样本太少，正确率不可信，先摸底
      urgency=1;vol=10;
      action=`先做 30 题摸底（现在 ${count} 题），有样本才知道真实水平`;
    }else if(tgt==null){
      urgency=2;vol=null; // 不是量的问题，没法跟已有计划比
      action=`给这个模块定个目标正确率（当前 ${acc}%），没目标就没有追赶的标尺`;
    }else{
      const gap=tgt-acc;
      if(gap>=15){urgency=5;vol=25;action=`差目标 ${gap}%：本周每天 25 题专项，错的当天标清原因`;}
      else if(gap>=8){urgency=4;vol=15;action=`差目标 ${gap}%：每天 15 题保持手感，重点刷同类易错`;}
      else if(gap>0){urgency=3;vol=10;action=`差目标 ${gap}%：每天 10 题冲一冲就能过线`;}
      else{urgency=0;vol=null;action=`已达标（超目标 ${-gap}%）：每周 2 套保持，别丢`;}
    }
    const idle=daysSince(k);
    if(idle!=null&&idle>=5)action+=`；已经 ${idle} 天没练了`;
    // 待办文案：去掉「；已经 N 天没练了」这类临时状态，只留可执行的那句
    const text=`${SECTION_MAP[k].name}：${action.split('；')[0]}`;
    const plan=modulePlan(k);
    const base={key:k,name:SECTION_MAP[k].name,acc:acc,tgt:tgt,count:count,action:action,text:text,vol:vol,plan:plan,idle:idle,urgency:urgency};
    if(urgency<=0){out.push(Object.assign(base,{kind:'ok'}));return;}
    // 已有计划且能折算出每天题量 → 比大小，不另起炉灶
    if(vol!=null&&plan.vol!=null){
      // plan.est：这份「已安排量」里含套卷按目标题量摊出来的部分，标出来免得当精确值看
      const vt=plan.est?`约 ${plan.vol} 题（含套卷分摊）`:`${plan.vol} 题`;
      if(plan.vol>=vol){
        out.push(Object.assign(base,{
          kind:'covered',
          note:count<30
            ? `你已安排每天 ${vt}，样本会自己长出来（还差 ${Math.max(0,30-count)} 题到 30 题）`
            : `你已安排每天 ${vt}，已经 ≥ 建议的 ${vol} 题，按自己的节奏走就行`
        }));
      }else if(plan.target){
        out.push(Object.assign(base,{
          kind:'bump',
          action:`已安排每天 ${vt}，但差目标需要约 ${vol} 题/天`,
          note:`建议把「${plan.target.text}」的量提到 ${vol} 题`
        }));
      }else{
        // 覆盖量全来自套卷：不去动「套卷」两个字，另外补一条专项
        const lack=Math.round((vol-plan.vol)*10)/10;
        out.push(Object.assign(base,{
          kind:'add',
          action:`套卷只摊到每天约 ${plan.vol} 题，差目标还差 ${lack} 题/天，得再加专项`,
          text:`${SECTION_MAP[k].name}：每天补 ${lack} 题专项（套卷之外单练）`
        }));
      }
      return;
    }
    out.push(Object.assign(base,{kind:vol!=null?'add':'target'}));
  });
  /* 排序：与已有计划冲突的排最前（最需要拍板），其余按紧急度，
     已覆盖 / 已达标 / 待积累样本 沉到下面做浅色提示，不占建议名额；
     同紧急度内按「差距（目标−当前）」从大到小，差距相同按题量多的优先 */
  const rank=s=>{
    if(s.kind==='bump')return 100+s.urgency;    // 和自己的计划打架，优先处理
    if(s.kind==='covered'||s.kind==='ok')return -1;
    return s.urgency;                            // target(2) > 样本不足(1)
  };
  const gapOf=s=>(s.tgt!=null&&s.acc!=null)?(s.tgt-s.acc):null;
  out.sort((a,b)=>{
    const rk=rank(b)-rank(a);if(rk)return rk;
    if(b.urgency!==a.urgency)return b.urgency-a.urgency;
    const ga=gapOf(a),gb=gapOf(b);
    if(ga!=null&&gb!=null&&ga!==gb)return gb-ga;   // 差距从大到小
    return (b.count||0)-(a.count||0);               // 同差距题多优先
  });
  const rest=out.filter(s=>s.kind==='covered'||s.kind==='ok');
  const act=[];
  let sampleOne=null;
  out.filter(s=>s.kind!=='covered'&&s.kind!=='ok').forEach(s=>{
    // 「先做 30 题摸底」对六个模块文案都一样，摆三条没意义，只留一条
    if(s.urgency===1){
      if(sampleOne){
        rest.push(Object.assign({},s,{kind:'sample',note:`已有 ${s.count} 题，还差 ${Math.max(0,30-s.count)} 题到 30 题样本`}));
        return;
      }
      sampleOne=s;
    }
    act.push(s);
  });
  /* ===== 申论建议：基于批改记录的得分率和练习频率（申论不打分，单独算） ===== */
  const slReviews=(state.shenlunReviews||[]).filter(r=>r&&r.score);
  let slAvg=null, slCount=0, slLastDate=null;
  slReviews.forEach(r=>{
    const p=parseShenlunScore(r.score);   // 与雷达/题型卡同一解析口径
    if(p){slCount++;slAvg=(slAvg==null?p.rate:slAvg+p.rate);}
    if(r.date&&(!slLastDate||r.date>slLastDate))slLastDate=r.date;
  });
  if(slCount>0)slAvg=Math.round(slAvg/slCount);
  const slIdle=slLastDate?Math.round((new Date(today+'T00:00:00')-new Date(slLastDate+'T00:00:00'))/86400000):null;
  let slAction='',slText='',slVol=null,slUrgency=0;
  if(slCount===0){
    slUrgency=2;slVol=1;
    slAction='还没有申论练习记录，先做1道小题摸底（小题提分最快）';
    slText='申论：做1道小题摸底';
  }else if(slAvg!=null){
    /* 阈值优先用「我的目标 → 申论得分率」R：<R-15 很低 / <R 未达标 / <R+10 达标可再提 / ≥R+10 优秀；
       没设目标才回退旧的写死档 55/70/80 */
    const R=(state.weakTargets&&state.weakTargets.shenlun!=null)?state.weakTargets.shenlun:null;
    let gapTxt='';
    if(R!=null){
      const gap=R-slAvg;
      gapTxt=gap>0?('，距目标 '+R+'% 还差 '+gap+' 分'):('，已超目标 '+R+'%');
      if(slAvg<R-15){
        slUrgency=5;slVol=2;
        slAction=`申论平均得分率 ${slAvg}%${gapTxt}：每天2道小题+每周1篇大作文，重点练概括和对策`;
        slText='申论：每天2道小题+每周1篇大作文';
      }else if(slAvg<R){
        slUrgency=4;slVol=1;
        slAction=`申论平均得分率 ${slAvg}%${gapTxt}：每天1道小题保持手感，每周1篇大作文练结构`;
        slText='申论：每天1道小题+每周1篇大作文';
      }else if(slAvg<R+10){
        slUrgency=3;slVol=1;
        slAction=`申论平均得分率 ${slAvg}%，已达标（目标 ${R}%）：每周2篇大作文+3道小题，再往上提一提`;
        slText='申论：每周2篇大作文+3道小题';
      }else{
        slUrgency=2;slVol=1;
        slAction=`申论平均得分率 ${slAvg}%，远超目标 ${R}%：每周1篇大作文+2道小题保持手感，别丢`;
        slText='申论：每周1篇大作文+2道小题';
      }
    }else if(slAvg<55){
      slUrgency=5;slVol=2;
      slAction=`申论平均得分率仅 ${slAvg}%，偏低：每天2道小题+每周1篇大作文，重点练概括和对策（可在「我的→我的目标」设申论得分率目标）`;
      slText='申论：每天2道小题+每周1篇大作文';
    }else if(slAvg<70){
      slUrgency=4;slVol=1;
      slAction=`申论平均得分率 ${slAvg}%，有提升空间：每天1道小题保持手感，每周1篇大作文练结构（可在「我的→我的目标」设申论得分率目标）`;
      slText='申论：每天1道小题+每周1篇大作文';
    }else if(slAvg<80){
      slUrgency=3;slVol=1;
      slAction=`申论平均得分率 ${slAvg}%，良好但可再提：每周2篇大作文+3道小题，冲击80%（可在「我的→我的目标」设申论得分率目标）`;
      slText='申论：每周2篇大作文+3道小题';
    }else{
      slUrgency=2;slVol=1;
      slAction=`申论平均得分率 ${slAvg}%，优秀：每周1篇大作文+2道小题保持手感，别丢`;
      slText='申论：每周1篇大作文+2道小题';
    }
  }
  if(slIdle!=null&&slIdle>=7&&slUrgency>0)slAction+=`；已经 ${slIdle} 天没练申论了`;
  if(slUrgency>0){
    const _slTgt=(state.weakTargets&&state.weakTargets.shenlun!=null)?state.weakTargets.shenlun:null;
    act.push({key:'shenlun',name:'申论',acc:slAvg,tgt:_slTgt,count:slCount,action:slAction,text:slText,vol:slVol,plan:modulePlan('shenlun'),idle:slIdle,urgency:slUrgency,kind:slVol!=null?'add':'target'});
    act.sort((a,b)=>(rank(b)-rank(a))||(b.urgency-a.urgency));
  }
  /* ===== 兜底：被「正式建议 3 条」名额截断的摸底建议，沉到折叠区提示 =====
     避免「样本不足」模块（如政治常识）被挤出前 3 又不在折叠区，静默消失。 */
  act.slice(3).forEach(s=>{
    if(s.urgency===1&&!rest.some(x=>x.key===s.key)){
      rest.push(Object.assign({},s,{kind:'sample',note:`已有 ${s.count} 题，还差 ${Math.max(0,30-s.count)} 题到 30 题样本`}));
    }
  });
  /* 折叠区不截断：已覆盖 / 已达标 / 待积累样本 全部展示（用户要求保持完整，不要「没有就不显示」） */
  return {steps:act.slice(0,3),rest:rest};
}
/* 建议生成的待办用 from:'suggest' 标记，同模块只保留一条：
   文案没变就禁用按钮，文案随数据变了就「更新」而不是再插一条。 */
function findSuggestTodo(sec){
  if(!Array.isArray(state.todos))return null;
  return state.todos.find(x=>x&&x.section===sec&&x.from==='suggest'&&!x.done)||null;
}
function renderNextSteps(){
  const r=buildNextSteps();
  const steps=r.steps,rest=r.rest;
  const wrap=el('div','card');
  // 与首页其它卡统一：section-title + 紫色竖条；按钮 margin-left:auto 靠右
  // （原用 block-subtitle，它自带 margin:18px 0 10px，会让卡片顶部空一截、标题被顶下去）
  const sub=el('div','section-title');
  sub.innerHTML='<span class="dot"></span>下一步建议';
  wrap.appendChild(sub);
  /* 有待完成的套卷：先别加专项，等复盘录入成绩后建议自动回来 */
  if(r.examPending&&r.examPending.length){
    const e=el('div','empty-tip');
    e.innerHTML='你还有套卷没完成，先不给你加专项任务。<br>'
      +escapeHtml(r.examPending.map(x=>x.text).join('、'))
      +'<br>做完套卷、复盘并录入成绩后，薄弱点才准，那时候再来加针对性练习。';
    wrap.appendChild(e);
    return wrap;
  }
  if(!steps.length&&!rest.length){
    const e=el('div','empty-tip');
    e.textContent='暂无建议。先到「每日计划」录入题量和正确率，或给薄弱模块定个目标正确率。';
    wrap.appendChild(e);
    return wrap;
  }
  if(!steps.length){
    const e=el('div','empty-tip');
    e.textContent='你的计划已经覆盖了当前的薄弱点，按自己的节奏走就行。';
    wrap.appendChild(e);
  }
  steps.forEach(s=>{
    const row=el('div','next-step'+(s.kind==='bump'?' ns-conflict':''));
    const meta=(s.acc!=null?s.acc+'%':'—')+(s.tgt!=null?` → 目标 ${s.tgt}%`:' · 未设目标');
    const today=todayStr();
    // —— 按钮与提示，按建议类型分开处理 ——
    let btnLabel='加入待办',btnDisabled=false,btnTitle='',hint='';
    if(s.kind==='bump'){
      btnLabel=`加到 ${s.vol} 题`;
      btnTitle='调整你已有的那条任务，不新增';
      hint=`已有「${s.plan.target.text}」，不会再另建一条`;
    }else if(s.kind==='target'){
      btnLabel='去设目标';
      btnTitle='设置该模块的目标正确率';
      if(s.plan.count)hint=`该模块还有 ${s.plan.count} 条未完成任务`;
    }else{
      const exist=findSuggestTodo(s.key);
      const same=!!(exist&&exist.text===s.text);
      const others=(Array.isArray(state.todos)?state.todos:[]).filter(x=>x&&x.section===s.key&&!x.done&&x!==exist).length;
      if(exist&&same){
        btnLabel='已加入';btnDisabled=true;btnTitle='该建议已生成过待办';
        hint=(exist.dueDate&&exist.dueDate<today)
          ? `${exist.dueDate.slice(5).replace('-','/')} 加的这条还没完成，做完或删掉才会再出新建议`
          : `今天待办里已有一条，去「每日计划」完成或删除它`;
      }
      else if(exist){btnLabel='更新待办';hint=`建议已随数据变化，点「更新待办」覆盖旧的那条（不会新增）`;}
      else if(others)hint=`该模块还有 ${others} 条未完成任务，注意别排重了`;
    }
    row.innerHTML=`
      <div class="ns-head">
        <span class="ns-name">${escapeHtml(s.name)}</span>
        ${s.kind==='bump'?'<span class="ns-tag">与你的计划冲突</span>':''}
        <span class="ns-meta">${escapeHtml(meta)}</span>
        <button class="btn btn-sm ns-act${btnDisabled?' ns-added':''}"${btnDisabled?' disabled':''} title="${escapeHtml(btnTitle)}">${escapeHtml(btnLabel)}</button>
      </div>
      <div class="ns-action">${escapeHtml(s.action)}</div>
      ${hint?`<div class="ns-hint">${escapeHtml(hint)}</div>`:''}`;
    const btn=row.querySelector('.ns-act');
    if(!btnDisabled)btn.addEventListener('click',()=>{
      if(s.kind==='bump'){confirmBumpPlan(s.plan.target,s.vol);return;}
      if(s.kind==='target'){openTargetModal(s.key);return;}
      if(!Array.isArray(state.todos))state.todos=[];
      const exist=findSuggestTodo(s.key);
      if(exist){
        // 覆盖旧的，避免同模块堆一串僵尸任务
        exist.text=s.text;exist.dueDate=todayStr();exist.ts=Date.now();exist.mts=Date.now(); // 必须更新时间戳，否则两端合并时旧文案可能盖回来
        if(s.vol!=null)exist.count=s.vol;   // 题量直接写进字段，不再靠文案认读
        save();renderKeepScroll();toast('已更新今天待办');
      }else{
        state.todos.push({id:uid(),text:s.text,dueDate:todayStr(),section:s.key,done:false,from:'suggest',ts:Date.now(),mts:Date.now(),...(s.vol!=null?{count:s.vol}:{})});
        save();renderKeepScroll();toast('已加入今天待办');
      }
    });
    wrap.appendChild(row);
  });
  // 已被自己计划覆盖 / 已达标：折叠成一行浅色提示，不占建议名额
  rest.forEach(s=>{
    const row=el('div','next-step ns-covered');
    row.innerHTML=`
      <div class="ns-head">
        <span class="ns-name">${escapeHtml(s.name)}</span>
        <span class="ns-tag ok">${{covered:'已在计划中',ok:'已达标',sample:'待积累样本'}[s.kind]||'已达标'}</span>
        <span class="ns-meta">${escapeHtml((s.acc!=null?s.acc+'%':'—')+(s.tgt!=null?' → '+s.tgt+'%':''))}</span>
      </div>
      <div class="ns-hint">${escapeHtml(s.note||'保持当前节奏')}</div>`;
    wrap.appendChild(row);
  });
  return wrap;
}
/* 已有计划量不够时，让用户自己拍板改不改——不擅自改写他写的任务 */
function confirmBumpPlan(td,newVol){
  if(!td)return;
  const cur=parseInt(td.count,10)||0;
  openModal('调整已有计划',
    `<div class="pl-label">你现在安排的是</div>
     <div class="pl-box pl-old">${escapeHtml(td.text)}（${cur} 题）</div>
     <div class="pl-label">建议改成</div>
     <div class="pl-box pl-new">${escapeHtml(td.text)}（${newVol} 题）</div>
     <p class="pl-tip">只改题量数字，任务文字一字不动。选「保留我的」则不做任何改动。</p>
     <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px;">
       <button class="btn btn-ghost btn-sm" id="plKeep">保留我的</button>
       <button class="btn btn-sm" id="plApply">改成 ${newVol} 题</button>
     </div>`);
  $('#plKeep').addEventListener('click',()=>{closeModal();});
  $('#plApply').addEventListener('click',()=>{
    td.count=newVol;td.ts=Date.now();
    save();closeModal();renderKeepScroll();toast('已调整计划的题量');
  });
}

/* 行测复盘：题型看板 + 薄弱考点分析 + 下一步建议（合并页「行测复盘」tab） */
function renderTypeWeakCard(model){
  if(!model)model=buildBlendModel();
  const rateMap=model.rateMap;
  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>行测复盘</div>`;
  card.appendChild(renderTypeDashboard(model));

  // 薄弱考点分析（6个题型都显示，无数据用-占位；含可展开的薄弱子模块）
  const weakSub=el('div','block-subtitle');weakSub.textContent='薄弱考点分析';
  card.appendChild(weakSub);
  const weakData=getWeakPoints();
  const weakMap={};weakData.forEach(w=>{weakMap[w.key]=w;});
  const allWeakTypes=ROW_KEYS.slice();
  // 目标正确率完全由用户自定，不做任何内置预设；未设置时返回 null
  const getTarget=(key)=>(state.weakTargets&&state.weakTargets[key]!=null)?state.weakTargets[key]:null;
  // 目标单元格：已设置显示百分比，未设置显示「-」；两者都是主题色虚线下划线，点击即可修改
  const targetCell=(key,label)=>{
    const t=getTarget(key);
    return `<span class="weak-target" data-key="${escapeHtml(key)}" data-name="${escapeHtml(label)}" title="点击设置目标正确率" style="cursor:pointer;color:var(--primary);font-weight:600;border-bottom:1px dashed var(--primary);white-space:nowrap;">${t!=null?t+'%':'—'}</span>`;
  };
  // 有数据的按正确率从低到高排，无数据的在后
  const sortedTypes=[...allWeakTypes].sort((a,b)=>{
    const wa=weakMap[a],wb=weakMap[b];
    if(wa&&wb)return wa.accuracy-wb.accuracy;
    if(wa)return -1;
    if(wb)return 1;
    return 0;
  });
  let tableHtml=`<div style="overflow-x:auto;margin-bottom:12px;"><table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="border-bottom:1px solid var(--border);">
      <th style="text-align:left;padding:8px 6px;color:var(--text-sub);font-weight:500;">考点</th>
      <th style="text-align:center;padding:8px 6px;color:var(--text-sub);font-weight:500;">目标</th>
      <th style="text-align:center;padding:8px 6px;color:var(--text-sub);font-weight:500;">正确率</th>
      <th style="text-align:center;padding:8px 6px;color:var(--text-sub);font-weight:500;">差距</th>
    </tr></thead><tbody>`;
  sortedTypes.forEach(key=>{
    const w=weakMap[key];
    const name=SECTION_MAP[key]?.name||key;
    const target=getTarget(key);
    const et=SECTION_ET[key];
    const expandable=!!(et&&et.subs&&et.subs.length);
    const caret=expandable?`<span class="weak-caret" style="display:inline-block;transition:transform .15s;font-size:11px;color:var(--text-light);margin-left:4px;">▸</span>`:'';
    const rowStyle=expandable?'cursor:pointer;':'';
    if(w){
      // 未设目标时不判定达标与否：进度条用中性主题色，差距显示 —
      const hasT=target!=null;
      const barColor=hasT?(w.accuracy>=target?'#2bb673':'#d96b6b'):'var(--primary)';
      const gap=hasT?w.accuracy-target:null;
      const gapText=hasT?((gap>=0?'+':'')+gap+'%'):'—';
      const gapColor=hasT?(gap>=0?'#2bb673':'#d96b6b'):'#ccc';
      tableHtml+=`<tr class="weak-row${expandable?' expandable':''}" data-sec="${key}" style="${rowStyle}border-bottom:1px solid #f5f5f5;">
        <td style="padding:10px 6px;font-weight:500;">${name}${caret}</td>
        <td style="padding:10px 6px;text-align:center;">${targetCell(key,name)}</td>
        <td style="padding:10px 6px;text-align:center;">
          <div style="display:flex;align-items:center;gap:8px;justify-content:center;">
            <div style="width:60px;height:6px;background:#f0f0f0;border-radius:3px;overflow:hidden;">
              <div style="width:${Math.min(100,w.accuracy)}%;height:100%;background:${barColor};border-radius:3px;"></div>
            </div>
            <span style="font-weight:600;color:${barColor};min-width:38px;">${w.accuracy}%</span>
          </div>
        </td>
        <td style="padding:10px 6px;text-align:center;font-weight:600;color:${gapColor};">${gapText}</td>
      </tr>`;
    }else{
      tableHtml+=`<tr class="weak-row${expandable?' expandable':''}" data-sec="${key}" style="${rowStyle}border-bottom:1px solid #f5f5f5;">
        <td style="padding:10px 6px;font-weight:500;color:var(--text-sub);">${name}${caret}</td>
        <td style="padding:10px 6px;text-align:center;">${targetCell(key,name)}</td>
        <td style="padding:10px 6px;text-align:center;color:#ccc;">—</td>
        <td style="padding:10px 6px;text-align:center;color:#ccc;">—</td>
      </tr>`;
    }
    // 子模块行（默认折叠，点大类展开）
    if(expandable){
      et.subs.forEach(sub=>{
        const sv=avgSubRate(rateMap,sub);
        const has=sv!=null;
        const acc=has?Math.round(sv*100):0;
        // 子模块有自己独立的目标（不再沿用大类目标），同样不预设；未设目标时不判定达标
        const subT=getTarget(sub.key);
        const hasSubT=subT!=null;
        const col=has?(hasSubT?(acc>=subT?'#2bb673':'#d96b6b'):'var(--primary)'):'#ccc';
        const g=hasSubT?acc-subT:null;
        const showGap=has&&hasSubT;
        tableHtml+=`<tr class="weak-sub" data-parent="${key}" style="display:none;background:#faf9fd;border-bottom:1px solid #f5f5f5;">
          <td style="padding:7px 6px 7px 24px;color:var(--text-sub);font-size:12px;">↳ ${sub.name}</td>
          <td style="padding:7px 6px;text-align:center;font-size:12px;">${targetCell(sub.key,sub.name)}</td>
          <td style="padding:7px 6px;text-align:center;">${has?`<div style="display:flex;align-items:center;gap:8px;justify-content:center;">
            <div style="width:60px;height:6px;background:#f0f0f0;border-radius:3px;overflow:hidden;">
              <div style="width:${Math.min(100,acc)}%;height:100%;background:${col};border-radius:3px;"></div>
            </div>
            <span style="font-weight:600;color:${col};min-width:38px;font-size:12px;">${acc}%</span>
          </div>`:'<span style="color:#ccc;font-size:12px;">—</span>'}</td>
          <td style="padding:7px 6px;text-align:center;font-weight:600;font-size:12px;color:${showGap?(g>=0?'#2bb673':'#d96b6b'):'#ccc'};">${showGap?((g>=0?'+':'')+g+'%'):'—'}</td>
        </tr>`;
      });
    }
  });
  tableHtml+=`</tbody></table></div>`;
  const weakWrap=el('div');weakWrap.innerHTML=tableHtml;
  card.appendChild(weakWrap);


  // 薄弱考点目标点击编辑 / 子模块展开
  card.querySelectorAll('.weak-target').forEach(el=>{
    el.addEventListener('click',()=>{
      // 子模块 key 不在 SECTION_MAP 里，统一打开目标弹窗（自动定位模块）
      openTargetModal(el.dataset.key);
    });
  });
  card.querySelectorAll('.weak-row.expandable').forEach(r=>{
    r.addEventListener('click',e=>{
      if(e.target.closest('.weak-target'))return;
      const sec=r.dataset.sec;
      const subs=card.querySelectorAll('.weak-sub[data-parent="'+sec+'"]');
      const show=subs.length&&subs[0].style.display==='none';
      subs.forEach(s=>s.style.display=show?'':'none');
      const ct=r.querySelector('.weak-caret');
      if(ct)ct.style.transform=show?'rotate(90deg)':'';
    });
  });
  // 恢复重绘前展开的子模块：设置目标后不会被折叠回去，能直接看到结果
  if(_preserveView&&_preserveView.expanded&&_preserveView.expanded.length){
    _preserveView.expanded.forEach(sec=>{
      const subs=card.querySelectorAll('.weak-sub[data-parent="'+sec+'"]');
      if(!subs.length)return;
      subs.forEach(s=>{s.style.display='';});
      const r=card.querySelector('.weak-row.expandable[data-sec="'+sec+'"]');
      const ct=r&&r.querySelector('.weak-caret');
      if(ct)ct.style.transform='rotate(90deg)';
    });
  }
  return card;
}

/* 单条套卷记录项（套卷 tab 专用列表 + 数据概览刷题记录共用） */
function buildExamRecordItem(r){
  const item=el('div','exam-item');
  const chips=EXAM_TYPES.map(t=>{
    const v=getModuleRate(r.rates||{},t);
    if(v==null)return '';
    return `<span class="exam-chip" style="--c:${t.color}">${t.name} ${Math.round(v*100)}%</span>`;
  }).filter(Boolean).join('');
  let totalNum=0,correctNum=0;
  EXAM_TYPES.forEach(t=>{const m=(r.moduleStats||{})[t.key]; if(m&&m.total>0){totalNum+=m.total;correctNum+=m.correct;}});
  item.innerHTML=`
    <div class="exam-item-head">
      <div class="grow">
        <div class="exam-name">${escapeHtml(r.name||'未命名套卷')} <span class="record-tag" style="background:var(--primary-soft);color:var(--primary);">套卷</span></div>
        <div class="exam-date">${r.date}</div>
      </div>
      <div class="exam-score">${r.score!=null&&r.score!==''?r.score:'—'}<span class="exam-score-unit">分</span></div>
    </div>
    ${totalNum>0?`<div class="exam-pct">正确 ${correctNum}/${totalNum} 题 · 总正确率 ${Math.round(correctNum/totalNum*100)}%</div>`:''}
    ${r.percentile!=null?`<div class="exam-pct">击败 ${(r.percentile*100).toFixed(1)}% 考生</div>`:''}
    ${r.duration!=null?`<div class="exam-pct">用时 ${r.duration} 分钟</div>`:''}
    ${chips?`<div class="exam-chips">${chips}</div>`:''}
    ${r.note?`<div class="exam-note">${escapeHtml(r.note)}</div>`:''}
    <div class="exam-item-actions">
      <button class="btn btn-ghost btn-sm" data-edit="${r.id}">编辑</button>
      <button class="btn btn-ghost btn-sm" data-del="${r.id}" style="color:var(--danger)">删除</button>
    </div>`;
  item.querySelector('[data-edit]').addEventListener('click',()=>openExamEditor(r.id));
  /* 删除后必须以 examRecords 为真相重建当天 taojuan 打卡：否则首页今日汇总/复盘日历详情
     仍显示已删除的套数、题量和正确率（编辑器内删除有同步，列表删除漏了） */
  item.querySelector('[data-del]').addEventListener('click',()=>{uiConfirm('删除这条套卷记录？',()=>{markEntityDeleted('examRecord',[r.id]);state.examRecords=(state.examRecords||[]).filter(x=>x.id!==r.id);syncTaojuanDaily(r.date);save();render();toast('已删除');},{danger:true});});
  return item;
}

/* 套卷记录列表（只套卷，不带每日刷题）——套卷 tab 专用 */
function renderExamOnlyCard(){
  const card=el('div','card');
  const records=Array.isArray(state.examRecords)?state.examRecords.slice().sort((a,b)=>(a.date<b.date?1:-1)):[];
  card.innerHTML=`<div class="section-title"><span class="dot"></span>套卷记录（${records.length} 套）
    <button class="btn btn-sm" id="addExamBtn" style="margin-left:auto;">+ 套卷</button></div>`;
  const list=el('div','exam-list');
  if(!records.length){
    list.innerHTML=`<div class="empty-tip">还没有套卷记录<br>点右上角「+ 套卷」录入第一次模考/真题成绩</div>`;
  }else{
    records.forEach(r=>list.appendChild(buildExamRecordItem(r)));
  }
  card.appendChild(list);
  card.querySelector('#addExamBtn').addEventListener('click',()=>openExamEditor());
  return card;
}

/* 套卷速览 + 套卷成绩趋势——套卷 tab 顶部 */
function renderExamOverviewCard(model){
  const card=el('div','card');
  const records=Array.isArray(state.examRecords)?state.examRecords.slice():[];
  const scores=records.map(r=>r.score).filter(v=>v!=null&&v!=='');
  const avg=scores.length?Math.round(scores.reduce((a,b)=>a+ (+b),0)/scores.length*10)/10:null;
  const byDate=records.slice().sort((a,b)=>(a.date<b.date?1:-1));
  /* 最近一套只取有分数的记录：否则最新那条没填分数时，卡片会显示空白而不是上一套的有效分 */
  const _latestRec=byDate.find(r=>r.score!=null&&r.score!=='')||byDate[0];
  const latest=_latestRec?_latestRec.score:null;
  const latestDate=_latestRec?_latestRec.date:'';
  /* 套卷速度 = 有用时记录的总用时 ÷ 这些卷子的总题数（分/题）。
     注意 totQ 必须只累加 durRecs（填了用时的卷子），否则没填用时的卷子题量混进分母，
     3 套卷只 1 套填用时时速度被稀释 3 倍 */
  const durRecs=records.filter(r=>r.duration&&r.duration>0);
  const totalDur=durRecs.reduce((a,r)=>a+r.duration,0);
  const avgDur=durRecs.length?Math.round(totalDur/durRecs.length*10)/10:null;
  let totQ=0; durRecs.forEach(r=>{EXAM_TYPES.forEach(t=>{const m=(r.moduleStats||{})[t.key];if(m&&m.total>0)totQ+=m.total;});});
  const avgSpeed=(totalDur>0&&totQ>0)?Math.round(totalDur/totQ*100)/100:null;
  const ov=model.overall;
  const examRate=ov.exam.t>0?Math.round(ov.exam.c/ov.exam.t*100)+'%':'—';
  const dailyRate=ov.daily.t>0?Math.round(ov.daily.c/ov.daily.t*100)+'%':'—';
  const gap=(ov.exam.t>0&&ov.daily.t>0)?Math.round(ov.exam.c/ov.exam.t*100-ov.daily.c/ov.daily.t*100):null;
  card.innerHTML=`<div class="section-title"><span class="dot"></span>套卷速览</div>
    <div class="blend-row">
      <div class="blend-cell"><div class="blend-num">${records.length}</div><div class="blend-lbl">总套数</div></div>
      <div class="blend-cell"><div class="blend-num">${avg!=null?avg:'—'}</div><div class="blend-lbl">平均分</div></div>
      <div class="blend-cell"><div class="blend-num" style="color:#e8a33d">${latest!=null?latest:'—'}</div><div class="blend-lbl">最近${latestDate?'('+latestDate.slice(5)+')':''}</div></div>
    </div>
    <div class="blend-row" style="margin-top:8px;">
      <div class="blend-cell"><div class="blend-num">${avgDur!=null?avgDur:'—'}</div><div class="blend-lbl">平均每套用时(分)</div></div>
      <div class="blend-cell"><div class="blend-num" style="color:#e8a33d">${avgSpeed!=null?avgSpeed:'—'}</div><div class="blend-lbl">速度(分/题)</div></div>
    </div>`;
  return card;
}

/* 套卷成绩趋势卡（独立卡片） */
function renderExamTrendCard(){
  const card=el('div','card');
  const records=Array.isArray(state.examRecords)?state.examRecords.slice():[];
  card.innerHTML=`<div class="section-title"><span class="dot"></span>套卷成绩趋势</div>`;
  const asc=records.slice().sort((a,b)=>a.date<b.date?-1:1);
  const scored=asc.filter(r=>r.score!=null&&r.score!=='');
  if(scored.length<2){
    const tip=el('div','empty-tip');
    tip.style.padding='16px 0';
    tip.textContent='至少录 2 套有分数的套卷后才会显示趋势曲线';
    card.appendChild(tip);
  }else{
    const win=scored.slice(-8);
    const labels=win.map(r=>r.date.slice(5).replace('-','/'));
    const series=[{data:win.map(r=>+r.score),color:'#e8a33d',label:'套卷'}];
    const chart=el('div');
    chart.innerHTML=`<div class="muted" style="font-size:12px;margin-bottom:4px;">最近 ${win.length} 套</div>${drawLineChart(series,labels,'分')}`;
    card.appendChild(chart);
  }
  return card;
}

/* 刷题记录（套卷 + 每日刷题），数据概览「综合」视角 */
function renderExamLogCard(model){
  const card=el('div','card');
  card.innerHTML=`<div class="section-title"><span class="dot"></span>刷题记录</div>`;
  const allRecords=[];
  // 套卷记录
  (state.examRecords||[]).forEach(r=>{
    allRecords.push({type:'exam',date:r.date,data:r});
  });
  // 每日刷题记录
  const ds=state.dailyStats||{};
  Object.keys(ds).forEach(date=>{
    const day=ds[date]||{};
    /* 只数五大行测模块（与下方 chips 循环同一口径）：套卷 taojuan 壳（count=套数）、
       申论（篇）、晨读（次）都有 count>0，不过滤会在只录套卷/只打卡的日子多出「每日刷题 0题」空条目 */
    const hasData=Object.keys(day).some(sec=>SECTION_TO_EXAMTYPE[sec]&&((day[sec]||{}).count||0)>0);
    if(hasData)allRecords.push({type:'daily',date,data:day});
  });
  // 按日期倒序
  allRecords.sort((a,b)=>a.date<b.date?1:-1);
  const list=el('div','exam-list');
  const FOLD=5;
  let expanded=false;
  function renderList(){
    list.innerHTML='';
    if(allRecords.length===0){
      list.innerHTML=`<div class="empty-tip">还没有刷题记录<br>套卷成绩去「套卷」页右上角「+ 套卷」录入，平时刷题在首页「今日汇总」点「记一笔」</div>`;
      return;
    }
    const view=expanded?allRecords:allRecords.slice(0,FOLD);
    view.forEach(rec=>{
      let item;
      if(rec.type==='exam'){
        item=buildExamRecordItem(rec.data);
      }else{
        item=el('div','exam-item');
        const day=rec.data;
        const chips=[];let totalCount=0,totalMin=0;
        Object.keys(day).forEach(sec=>{
          const s=day[sec]||{};const tn=SECTION_TO_EXAMTYPE[sec];if(!tn)return;
          const cnt=s.count||0;if(cnt<=0)return;
          const rate=s.rate!=null?Math.round(s.rate)+'%':'—';
          totalCount+=cnt;totalMin+=(s.minutes||0);
          chips.push(`<span class="exam-chip" style="--c:${typeColor(tn)}">${tn} ${cnt}题·${rate}</span>`);
        });
        item.innerHTML=`
          <div class="exam-item-head">
            <div class="grow"><div class="exam-name">${rec.date} <span class="record-tag" style="background:#f0f0f0;color:#999;">每日刷题</span></div></div>
            <div class="exam-score" style="font-size:18px;">${totalCount}<span class="exam-score-unit">题</span></div>
          </div>
          ${totalMin>0?`<div class="exam-pct" style="color:var(--text-sub)">用时 ${Math.round(totalMin)} 分钟</div>`:''}
          <div class="exam-chips">${chips.join('')}</div>
          <div class="exam-item-actions"><button class="btn btn-ghost btn-sm" data-editdaily="${rec.date}">改</button></div>`;
        const _eb=item.querySelector('[data-editdaily]');if(_eb)_eb.addEventListener('click',()=>openDailyRecordEditor(rec.date));
      }
      list.appendChild(item);
    });
    if(allRecords.length>FOLD){
      const btn=el('button','btn btn-ghost btn-sm');
      btn.style.cssText='width:100%;margin-top:8px;';
      btn.textContent=expanded?`收起（只看最近 ${FOLD} 条）`:`展开全部（共 ${allRecords.length} 条）`;
      btn.addEventListener('click',()=>{expanded=!expanded;renderList();});
      list.appendChild(btn);
    }
  }
  renderList();
  card.appendChild(list);
  return card;
}
/* 编辑某天的「每日刷题」记录（历史记录，从数据概览「刷题记录」进入）。逐条改题量/正确率/时长，保存即替换原条 */
function openDailyRecordEditor(date){
  const day=state.dailyStats[date]||{};
  const rows=[];
  Object.keys(day).forEach(sec=>{
    const s=day[sec]||{};
    (s.records||[]).forEach((r,idx)=>rows.push({sec,idx,r}));
  });
  if(!rows.length){toast('该日没有可编辑的单条记录');return;}
  const rowHtml=rows.map((row,i)=>{
    const r=row.r;
    const secName=(SECTION_MAP[row.sec]&&SECTION_MAP[row.sec].name)||row.sec;
    const _sn=subName(r.sub)||String(r.sub||'').split('_').pop();
    const subTxt=r.sub?(' · '+_sn):'（整体）';
    return `<div class="dlg-row dr-item" data-eri="${i}" style="align-items:flex-end;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--line,#eee);">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px;">${secName}${subTxt}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <label style="font-size:12px;color:var(--text-sub)">题量<input class="field dr-count" type="number" min="0" value="${r.count||0}" style="width:58px;margin-left:4px;"></label>
          <label style="font-size:12px;color:var(--text-sub)">正确率<input class="field dr-rate" type="text" value="${r.rate!=null?Math.round(r.rate):''}" placeholder="如 19/20" style="width:72px;margin-left:4px;"></label>
          <label style="font-size:12px;color:var(--text-sub)">时长分<input class="field dr-min" type="number" min="0" value="${r.min||0}" style="width:58px;margin-left:4px;"></label>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button class="btn btn-sm dr-save" data-eri="${i}">保存</button>
        <button class="btn btn-sm btn-ghost dr-del" data-eri="${i}" style="color:var(--danger)">删</button>
      </div>
    </div>`;
  }).join('');
  openModal('编辑刷题记录 · '+date, rowHtml, 'wide');
  const box=$('#modalBody');if(!box)return;
  box.querySelectorAll('.dr-save').forEach(b=>b.addEventListener('click',function(){
    const i=+b.dataset.eri;const row=rows[i];const wrap=box.querySelector('.dr-item[data-eri="'+i+'"]');
    const cnt=Math.max(0,parseInt(wrap.querySelector('.dr-count').value,10)||0);
    const rateRaw=wrap.querySelector('.dr-rate').value.trim();
    let rate=null;if(rateRaw!==''){const pr=parseRateInput(rateRaw);rate=pr.valid?pr.rate:null;}
    const mn=Math.max(0,parseInt(wrap.querySelector('.dr-min').value,10)||0);
    const rec=state.dailyStats[date]&&state.dailyStats[date][row.sec];
    if(!rec||!rec.records[row.idx])return;
    rec.records[row.idx].count=cnt;
    rec.records[row.idx].rate=rate;
    rec.records[row.idx].min=mn;
    recomputeDailyStat(row.sec,date);
    save();render();
    toast('已保存');
    openDailyRecordEditor(date);
  }));
  box.querySelectorAll('.dr-del').forEach(b=>b.addEventListener('click',function(){
    const i=+b.dataset.eri;const row=rows[i];
    uiConfirm('删除这条刷题记录？',()=>{
      const rec=state.dailyStats[date]&&state.dailyStats[date][row.sec];
      if(rec&&rec.records)rec.records.splice(row.idx,1);
      recomputeDailyStat(row.sec,date);
      if(rec&&!rec.records.length)delete state.dailyStats[date][row.sec];
      if(Object.keys(state.dailyStats[date]||{}).length===0)delete state.dailyStats[date];
      save();render();
      openDailyRecordEditor(date);
    },{danger:true});
  }));
}
/* 解析粉笔练习报告文字 → 提取各模块正确率/题数 + 总用时（手机提取文字后粘贴进来） */
function parseFenbiReport(text){
  const res={total:null,correct:null,wrong:null,minutes:null,rates:{},counts:{}};
  if(!text)return res;
  const ns=text.replace(/\s+/g,'');            // 去空格，兼容 OCR 乱插的空白
  const sum=ns.match(/一共(\d+)题.*?答对(\d+)题.*?答错(\d+)题/)||ns.match(/共(\d+)题.*?答对(\d+)题/);
  if(sum){res.total=+sum[1];res.correct=sum[2]!=null?+sum[2]:null;res.wrong=sum[3]!=null?+sum[3]:null;}
  const tm=ns.match(/总(用时|时长)\D{0,8}?(\d+(?:\.\d+)?)\D{0,4}?分钟/);
  if(tm)res.minutes=+tm[2];
  // 模块名 → 工作台题型 key（用粉笔报告里的完整模块名，避免短名误命中子串）
  // 政治常识由「政治理论」「常识判断」两个子报告合并，故按 key 累加题数/正确数，而非覆盖
  const map=[
    {label:'言语理解与表达',key:'言语'},
    {label:'言语理解',key:'言语'},
    {label:'判断推理',key:'判断推理'},
    {label:'资料分析',key:'资料分析'},
    {label:'数量关系',key:'数量关系'},
    {label:'政治理论',key:'政治常识'},
    {label:'常识判断',key:'政治常识'},
    {label:'政治常识',key:'政治常识'},
  ];
  const rateRe=/(?:正确率|准确率|正确)[:：]?\s*(\d+(?:\.\d+)?)\s*[%％]/;
  const cntRe=/(?:本部分共|共)\s*(\d+)\s*题/;
  const hits={};                                  // key → {total,correct} 累加（政治常识=多子报告求和）
  const spans=[];                                 // 已匹配位置区间，避免别名互相包含（如「言语理解」⊂「言语理解与表达」）重复累加
  const overlap=(s,e)=>spans.some(x=>s<x[1]&&e>x[0]);
  map.forEach(m=>{
    let idx=ns.indexOf(m.label);
    while(idx>=0){
      const e=idx+m.label.length;
      if(overlap(idx,e)){idx=ns.indexOf(m.label,idx+1);continue;}
      const before=ns.slice(Math.max(0,idx-50),idx);
      const after=ns.slice(idx,idx+160);          // 模块名前后一段都算，兼容换行/排版
      const cm=after.match(rateRe)||before.match(rateRe);
      if(cm){
        const pct=Math.max(0,Math.min(100,+cm[1]));
        const cc=after.match(cntRe)||before.match(cntRe);
        const total=cc?+cc[1]:0;
        const correct=total>0?Math.round(total*pct/100):0;
        if(!hits[m.key])hits[m.key]={total:0,correct:0};
        hits[m.key].total+=total;
        hits[m.key].correct+=correct;
        spans.push([idx,e]);break;
      }
      idx=ns.indexOf(m.label,idx+1);
    }
  });
  Object.keys(hits).forEach(k=>{
    const h=hits[k];
    if(h.total>0)res.counts[k]=h.total;
    res.rates[k]=h.total>0?h.correct/h.total:(h.correct>0?1:0);
  });
  return res;
}

/* 套卷题量预设：按卷型预填各模块题数，用户可逐项改。
   模块 key 与 EXAM_TYPES 对齐（行测 5 大类）；数值为常见结构，实际以用户手改为准 */
const PAPER_TYPE_VOLUMES={
  gk :{name:'国考卷', modules:{言语:30,判断推理:35,资料分析:20,数量关系:10,政治常识:35}, // 130 题（30+35+20+10+35）
       /* 子题型预填题量：与大类合计一致；只预填题数，正确数留空（空=该模块/子题型未录，不是 0 分） */
       subVolumes:{'言语_逻辑填空':15,'言语_片段阅读':10,'言语_语句表达':5,
                   '判断_图形推理':10,'判断_定义判断':10,'判断_类比推理':5,'判断_逻辑判断':10,
                   '政治常识_政治理论':20,'政治常识_常识':15}},
  sk :{name:'省考卷', modules:{言语:40,判断推理:35,资料分析:15,数量关系:10,政治常识:20}}, // 联考 120 题
  shi:{name:'事考卷', modules:{言语:25,判断推理:30,资料分析:15,数量关系:10,政治常识:20}}, // 职测 100 题
};
/* 以 state.examRecords 为真相，重建某天 dailyStats[date].taojuan（套数/总题量加权正确率/各大类明细/用时）。
   套卷成绩只从套卷编辑器录入，不产生手填 records；首页今日汇总卡、复盘日历详情都读这个派生值。
   不重算的旧实现只 count+1、rate 永远 0，会导致首页显示「1 套 · 0%」、详情全 0。 */
function syncTaojuanDaily(date){
  if(!date)return;
  if(!state.dailyStats)state.dailyStats={};
  const recs=(state.examRecords||[]).filter(x=>x.date===date);
  const old=state.dailyStats[date]&&state.dailyStats[date].taojuan;
  if(!recs.length){
    /* 当天无套卷：删除纯派生壳、熄灭打卡；远古手填 records（理论上不会再有）保留不误删 */
    if(old&&!(old.records&&old.records.length)){delete state.dailyStats[date].taojuan;}
    return;
  }
  let tot=0,cor=0,minSum=0;const subs={};
  recs.forEach(rc=>{
    minSum+=(rc.duration||0);
    EXAM_TYPES.forEach(t=>{
      const m=rc.moduleStats&&rc.moduleStats[t.key];
      if(m&&m.total>0){
        tot+=m.total;cor+=(m.correct||0);
        /* subs key 用大类中文名：日历详情 subName 查不到时直接兜底显示该字符串 */
        if(!subs[t.name])subs[t.name]={count:0,correct:0};
        subs[t.name].count+=m.total;subs[t.name].correct+=(m.correct||0);
      }
    });
  });
  Object.keys(subs).forEach(k=>{const s=subs[k];s.rate=s.count>0?Math.round(s.correct/s.count*100):0;});
  const stat={count:recs.length,rate:tot>0?Math.round(cor/tot*100):0,subs,records:[]};
  if(minSum>0)stat.minutes=Math.round(minSum*10)/10;
  if(!state.dailyStats[date])state.dailyStats[date]={};
  state.dailyStats[date].taojuan=stat;
}
/* 套卷用时自动汇总：子模块 → 大类 → 整卷。
   规则：只填「没被手动改过」的上层框（你手填过的值永远不被冲掉，清空后恢复自动）；
   子模块只填了一部分时按已填项求和，并在大类框后标「部分」提示。 */
function recalcExamDur(){
  const num=inp=>{const v=parseFloat(inp&&inp.value);return (isNaN(v)||v<0)?0:v;};
  // 1) 大类 = 其下子模块用时之和（仅当大类框未被手动改过）
  EXAM_TYPES.forEach(t=>{
    const mInp=$('#dur_'+t.key); if(!mInp)return;
    const subs=t.subs||[]; if(!subs.length)return;
    let sum=0,filled=0;
    subs.forEach(s=>{
      const si=$('#dur_sub_'+s.key); if(!si)return;
      const v=num(si); if(v>0){sum+=v;filled++;}
    });
    const part=$('#durpart_'+t.key);
    if(part)part.style.display=(filled>0&&filled<subs.length&&mInp.dataset.manual!=='1')?'inline':'none';
    if(mInp.dataset.manual==='1')return;
    mInp.value=filled>0?(Math.round(sum*10)/10):'';
  });
  // 2) 整卷 = 各大类用时之和（仅当整卷框未被手动改过）
  const dInp=$('#examDur'); if(!dInp||dInp.dataset.manual==='1')return;
  let tot=0,any=false;
  EXAM_TYPES.forEach(t=>{
    const m=$('#dur_'+t.key); if(!m)return;
    const v=num(m); if(v>0){tot+=v;any=true;}
  });
  dInp.value=any?(Math.round(tot*10)/10):'';
}
/* 套卷录入 / 编辑弹层；todoId：从「套卷任务/今日汇总套卷卡」进来时带上，保存成绩即标记该待办完成 */
function openExamEditor(id, todoId){
  const r=id?(state.examRecords||[]).find(x=>x.id===id):null;
  const counts=r?r.counts||{}:{};
  const modDurations=r?r.modDurations||{}:{};
  const subDurations=r?r.subDurations||{}:{};
  /* 旧记录若存的是已下线的 custom 类型，归并到 gk（type 仅用于预填，记录题数以 counts 为准不受影响） */
  const typeVal=r&&r.type&&r.type!=='custom'?r.type:'gk';
  /* 新建时按卷型预填子题型题数（如国考 逻辑填空15…）；已存记录以记录自身为准 */
  const presetSubs=(!r&&PAPER_TYPE_VOLUMES[typeVal])?PAPER_TYPE_VOLUMES[typeVal].subVolumes||{}:{};
  /* 套卷录入界面固定顺序：政治常识→言语理解→数量关系→推理判断→资料分析（仅影响展示，不动全局 EXAM_TYPES 顺序） */
  const EXAM_ORDER=['政治常识','言语','数量关系','判断推理','资料分析'];
  const typeRows=EXAM_ORDER.map(k=>EXAM_TYPES.find(t=>t.key===k)).filter(Boolean).map(t=>{
    const c=counts[t.key]||{};
    const total=(c.total!=null)?c.total:(PAPER_TYPE_VOLUMES[typeVal]?PAPER_TYPE_VOLUMES[typeVal].modules[t.key]:'');
    const correctPct=(c.correct!=null&&total>0)?Math.round(c.correct/total*100):(c.correct!=null?100:'');
    const subs=t.subs||[];
    /* 编辑回显：只要存过任一子模块数据，默认展开该块 */
    const hasSubData=subs.some(s=>{const sc=counts[s.key];return sc&&(sc.total>0||sc.correct>0);});
    const subRows=subs.map(s=>{
      const sc=counts[s.key]||{};
      const subTotal=(sc.total!=null)?sc.total:(presetSubs[s.key]!=null?presetSubs[s.key]:'');
      const subPct=(sc.correct!=null&&subTotal>0)?Math.round(sc.correct/subTotal*100):(sc.correct!=null?100:'');
      return `
        <div class="row paper-sub" style="margin-bottom:6px;align-items:center;">
          <label style="width:100px;box-sizing:border-box;padding:0 6px 0 16px;border-left:2px solid #e9e6f0;display:flex;align-items:center;font-size:12.5px;flex-shrink:0;color:var(--text-sub);">${s.name}</label>
          <span class="muted" style="margin-right:4px;font-size:12px;">题数</span>
          <input class="field" type="number" min="0" max="200" id="cnt_sub_${s.key}" value="${subTotal}" placeholder="0" inputmode="numeric" style="max-width:62px;font-size:13px;">
          <span class="muted" style="margin:0 6px 0 12px;font-size:12px;">正确率</span>
          <input class="field" type="number" min="0" max="100" id="rate_sub_${s.key}" value="${subPct}" placeholder="%" inputmode="numeric" style="max-width:62px;font-size:13px;">
          <span class="muted" style="margin-left:3px;font-size:12px;">%</span>
          <span class="muted" style="margin:0 4px 0 12px;font-size:12px;">用时</span>
          <input class="field" type="number" min="0" max="600" step="0.1" id="dur_sub_${s.key}" value="${subDurations[s.key]!=null?subDurations[s.key]:''}" placeholder="分" inputmode="decimal" style="max-width:56px;font-size:13px;">
        </div>`;
    }).join('');
    return `
      <div class="paper-mod-block">
      <div class="row paper-mod" style="margin-bottom:${subs.length?'4px':'8px'};align-items:center;">
        <label style="width:100px;font-size:14px;font-weight:600;flex-shrink:0;color:${t.color};display:flex;align-items:center;">
          ${t.name}${subs.length?`<span class="paper-caret" data-caret="${t.key}" style="margin-left:3px;width:14px;color:var(--text-light);font-size:11px;transition:transform .15s;transform:${hasSubData?'rotate(90deg)':'none'};">▸</span>`:''}
        </label>
        <span class="muted" style="margin-right:4px;">题数</span>
        <input class="field" type="number" min="0" max="200" id="cnt_${t.key}" value="${total}" placeholder="0" inputmode="numeric" style="max-width:62px;">
        <span class="muted" style="margin:0 6px 0 12px;">正确率</span>
        <input class="field" type="number" min="0" max="100" id="rate_${t.key}" value="${correctPct}" placeholder="%" inputmode="numeric" style="max-width:62px;">
        <span class="muted" style="margin-left:3px;">%</span>
        <span class="muted" style="margin:0 4px 0 12px;">用时</span>
        <input class="field" type="number" min="0" max="600" step="0.1" id="dur_${t.key}" value="${modDurations[t.key]!=null?modDurations[t.key]:''}" placeholder="分" inputmode="decimal" style="max-width:56px;">${subs.length?`<span id="durpart_${t.key}" class="dur-part" title="该大类只填了部分子模块用时，此为已填项之和" style="display:none;margin-left:5px;font-size:11px;color:#e8a33d;flex-shrink:0;">部分</span>`:''}
      </div>
      ${subs.length?`<div class="paper-subs" id="subs_${t.key}" style="display:${hasSubData?'block':'none'};margin:2px 0 8px;">${subRows}</div>`:''}
      </div>`;
  }).join('');
  const body=`
    <div class="row exam-toprow" style="margin-bottom:10px;align-items:center;gap:10px;">
      <label style="font-size:14px;font-weight:600;flex-shrink:0;">试卷类型</label>
      <select class="field" id="examType" style="max-width:160px;flex-shrink:0;">
        <option value="gk">国考卷</option>
        <option value="sk">省考卷</option>
        <option value="shi">事考卷</option>
      </select>
      <label style="font-size:14px;font-weight:600;flex-shrink:0;margin-left:auto;">日期</label>
      <input class="field" type="date" id="examDate" value="${r?r.date:todayStr()}" style="max-width:170px;flex-shrink:0;">
    </div>
    <div class="row" style="margin-bottom:10px;">
      <label style="width:84px;font-size:14px;font-weight:600;flex-shrink:0;">试卷名</label>
      <input class="field" id="examName" value="${escapeHtml(r?r.name||'':'')}" placeholder="如 26国考四十二季" maxlength="40">
    </div>
    <div class="row" style="margin-bottom:14px;gap:18px;flex-wrap:wrap;">
      <span style="display:inline-flex;align-items:center;gap:8px;">
        <label style="font-size:14px;font-weight:600;flex-shrink:0;">得分</label>
        <input class="field" type="number" step="0.1" id="examScore" value="${r&&r.score!=null&&r.score!==''?r.score:''}" placeholder="如 59.8" inputmode="decimal" style="max-width:120px;">
      </span>
      <span style="display:inline-flex;align-items:center;gap:8px;">
        <label style="font-size:14px;font-weight:600;flex-shrink:0;">击败考生</label>
        <input class="field" type="number" min="0" max="100" step="0.1" id="examPct" value="${r&&r.percentile!=null?(r.percentile*100).toFixed(1):''}" placeholder="如 67" inputmode="decimal" style="max-width:120px;">
        <span class="muted">%</span>
      </span>
    </div>
    <div id="examLiveBar" style="margin:2px 0 12px;padding:9px 12px;border-radius:10px;background:#f7f6fc;color:var(--text-sub);font-size:12.5px;line-height:1.5;transition:background .2s;"></div>
    ${typeRows}
    <div class="row" style="margin:14px 0 10px;align-items:center;">
      <label style="width:84px;font-size:14px;font-weight:600;flex-shrink:0;">用时</label>
      <input class="field" type="number" min="0" max="600" step="0.1" id="examDur" value="${r&&r.duration!=null?r.duration:''}" placeholder="分钟" inputmode="decimal" style="max-width:100px;">
      <span class="muted" style="margin-left:6px;">分钟（选填）</span>
    </div>
    <div class="row" style="margin-bottom:12px;align-items:flex-start;">
      <label style="width:84px;font-size:14px;font-weight:600;flex-shrink:0;margin-top:6px;">备注</label>
      <textarea id="examNote" class="field" rows="2" placeholder="这卷哪里崩了、下次注意什么（选填）" style="width:100%;font-size:14px;resize:vertical;">${escapeHtml(r?r.note||'':'')}</textarea>
    </div>
    <button class="btn btn-ghost btn-sm" id="ocrToggleBtn" style="margin:4px 0 12px;">从截图文字录入</button>
    <div id="ocrBox" style="display:none;margin-bottom:14px;padding:12px;background:#f5f6fa;border:1px solid #eceef2;border-radius:10px;">
      <p class="muted" style="font-size:12px;margin:0 0 6px;line-height:1.5;">手机相册长按截图→提取文字→复制，粘贴到这里，自动解析各模块正确率：</p>
      <textarea id="ocrText" class="field" rows="5" placeholder="粘贴练习报告文字…" style="width:100%;font-size:14px;resize:vertical;"></textarea>
      <div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-sm" id="ocrParseBtn">解析并填充</button>
        <span id="ocrMsg" class="muted" style="font-size:12px;"></span>
      </div>
    </div>
    <div class="exam-actions">
      ${r?`<button class="btn btn-ghost btn-sm" id="examDelBtn" style="color:var(--danger);margin-right:auto;">删除</button>`:''}
      <button class="btn btn-ghost btn-sm" onclick="closeModal()">取消</button>
      <button class="btn btn-sm" id="examSaveBtn">保存</button>
    </div>`;
  openModal(r?'编辑套卷记录':'添加套卷记录',body,'exam-editor-modal');
  /* 录入口径「题数 + 正确率% + 用时」。联动（20260929 恢复并适配新口径）：
     ① 填子题型正确率% → 大类正确率%按题量加权自动汇总（大类手改过后不再被覆盖，modTouched）
     ② 顶部实时统计条：已录题数 + 已录模块加权正确率，边录边有反馈
     ③ 保存按钮 sticky 吸底，长表单滚到底不用找按钮 */
  const clampPct=v=>{v=parseFloat(v);if(isNaN(v))return null;return Math.max(0,Math.min(100,v));};
  const updateLiveBar=()=>{
    const bar=$('#examLiveBar');if(!bar)return;
    let tq=0,w=0;
    EXAM_TYPES.forEach(t=>{
      const cnt=parseInt(($('#cnt_'+t.key)||{}).value)||0;
      const p=clampPct((($('#rate_'+t.key)||{}).value||'').trim());
      if(cnt>0&&p!=null){tq+=cnt;w+=cnt*p;}
    });
    bar.innerHTML=tq>0
      ?`已录 <b style="color:var(--primary);">${tq}</b> 题 · 已录模块加权正确率 <b style="color:var(--primary);">${Math.round(w/tq)}%</b>`
      :'填「题数 + 正确率」即可；点模块名后的 ▸ 可按子题型录入，大类正确率自动按题量加权汇总';
    bar.style.background=tq>0?'var(--primary-soft)':'#f7f6fc';
  };
  const modTouched={};
  /* 编辑回显：大类有存值且没有任何子题型数据 → 视为手填口径，防止被空子题型联动清空 */
  EXAM_TYPES.forEach(t=>{
    const c=counts[t.key]||{};
    if(c.total!=null&&!(t.subs||[]).some(s=>{const sc=counts[s.key];return sc&&(sc.total>0);}))modTouched[t.key]=true;
  });
  const syncModFromSubs=(tKey)=>{
    if(modTouched[tKey])return;
    const tt=EXAM_TYPES.find(x=>x.key===tKey);if(!tt||!(tt.subs||[]).length)return;
    let st=0,w=0;
    tt.subs.forEach(s=>{
      const p=clampPct((($('#rate_sub_'+s.key)||{}).value||'').trim());
      const cnt=parseInt((($('#cnt_sub_'+s.key)||{}).value))||0;
      if(p!=null&&cnt>0){st+=cnt;w+=cnt*p;}
    });
    const ri=$('#rate_'+tKey);if(ri)ri.value=st>0?String(Math.round(w/st)):'';
  };
  EXAM_TYPES.forEach(t=>{
    const rateInp=$('#rate_'+t.key),cntInp=$('#cnt_'+t.key);
    if(rateInp)rateInp.addEventListener('input',()=>{modTouched[t.key]=true;updateLiveBar();});
    if(cntInp)cntInp.addEventListener('input',updateLiveBar);
    (t.subs||[]).forEach(s=>{
      const ri=$('#rate_sub_'+s.key),ci=$('#cnt_sub_'+s.key);
      if(ri)ri.addEventListener('input',()=>{syncModFromSubs(t.key);updateLiveBar();});
      if(ci)ci.addEventListener('input',()=>{syncModFromSubs(t.key);updateLiveBar();});
    });
  });
  const applyType=(type)=>{
    const preset=PAPER_TYPE_VOLUMES[type];
    EXAM_TYPES.forEach(t=>{
      const inp=$('#cnt_'+t.key); if(inp)inp.value=preset?(preset.modules[t.key]||0):'';
      (t.subs||[]).forEach(s=>{
        const ci=$('#cnt_sub_'+s.key),ri=$('#rate_sub_'+s.key);
        if(ci)ci.value=(preset&&preset.subVolumes&&preset.subVolumes[s.key]!=null)?preset.subVolumes[s.key]:'';
        if(ri)ri.value='';   // 切换卷型只预填题数，正确率% 一律清空待手填
      });
      modTouched[t.key]=false;   // 主动切卷型 = 重置手填标记，重新允许子题型自动汇总
      syncModFromSubs(t.key);
    });
    updateLiveBar();
  };
  updateLiveBar();
  EXAM_TYPES.forEach(t=>{
    const caret=document.querySelector('[data-caret="'+t.key+'"]');
    if(caret){
      caret.addEventListener('click',()=>{
        const box=$('#subs_'+t.key); if(!box)return;
        const open=box.style.display!=='none';
        box.style.display=open?'none':'block';
        caret.style.transform=open?'none':'rotate(90deg)';
      });
      /* 点模块名整行（label 内）也能展开，不只点小箭头 */
      caret.parentElement.style.cursor='pointer';
      caret.parentElement.addEventListener('click',e=>{if(e.target.tagName!=='INPUT')caret.click();});
    }
  });
  const typeSel=$('#examType');
  if(typeSel){typeSel.value=typeVal;typeSel.addEventListener('change',()=>applyType(typeSel.value));}
  /* 用时自动汇总：子模块 → 大类 → 整卷（只填没被手动改过的上层框） */
  const bindDur=inp=>{
    if(!inp)return;
    if((inp.value||'').trim()!=='')inp.dataset.manual='1';
    inp.addEventListener('input',()=>{
      if((inp.value||'').trim()==='')delete inp.dataset.manual; else inp.dataset.manual='1';
      recalcExamDur();
    });
  };
  EXAM_TYPES.forEach(t=>{
    bindDur($('#dur_'+t.key));
    (t.subs||[]).forEach(s=>bindDur($('#dur_sub_'+s.key)));
  });
  bindDur($('#examDur'));
  recalcExamDur();
  const ocrToggle=$('#ocrToggleBtn');
  if(ocrToggle)ocrToggle.addEventListener('click',()=>{const b=$('#ocrBox');if(b)b.style.display=(b.style.display==='none'?'block':'none');});
  const ocrParse=$('#ocrParseBtn');
  if(ocrParse)ocrParse.addEventListener('click',()=>{
    const txt=($('#ocrText').value||'');
    const msg=$('#ocrMsg');
    if(!txt.trim()){if(msg)msg.textContent='请先粘贴练习报告文字';return;}
    const res=parseFenbiReport(txt);
    // parseFenbiReport 已把粉笔模块名归一到工作台题型 key（政治理论/常识→政治常识），直接按 key 填
    let filled=0;
    Object.keys(res.rates).forEach(k=>{
      const rateInp=$('#rate_'+k); if(!rateInp)return;
      rateInp.value=Math.round(res.rates[k]*100);
      modTouched[k]=true;   // OCR 解析值视为权威值，不输入事件也要防子题型联动覆盖
      const cntInp=$('#cnt_'+k);
      if(cntInp && res.counts[k]!=null)cntInp.value=res.counts[k];
      filled++;
    });
    if(res.minutes!=null){const d=$('#examDur'); if(d){d.value=res.minutes;d.dataset.manual='1';}} // OCR 给的是真实用时，标为手填避免被汇总覆盖
    updateLiveBar();
    let tip=filled?('已填充 '+filled+' 个模块正确率'):'没识别出模块正确率，检查文字是否完整';
    if(filled&&res.minutes!=null)tip+='，用时 '+res.minutes+' 分钟';
    if(msg)msg.textContent=tip;
    if(filled)toast('已解析 '+filled+' 个模块');
  });
  $('#examSaveBtn').addEventListener('click',()=>{
    const date=$('#examDate').value||todayStr();
    const name=$('#examName').value.trim();
    const score=$('#examScore').value; const sc=(score===''||isNaN(parseFloat(score)))?null:parseFloat(score);
    const pct=$('#examPct').value; const pc=(pct===''||isNaN(parseFloat(pct)))?null:Math.max(0,Math.min(100,parseFloat(pct)))/100;
    const type=$('#examType').value;
    const counts={};
    /* 子题型明细 {大类key: {subKey:{total,correct}}} */
    const subMap={};
    EXAM_TYPES.forEach(t=>{
      let total=parseInt($('#cnt_'+t.key).value)||0;
      const pctRaw=($('#rate_'+t.key).value||'').trim();
      const subsObj={};
      (t.subs||[]).forEach(s=>{
        const subPctRaw=($('#rate_sub_'+s.key).value||'').trim();
        if(subPctRaw==='')return;   // 子题型正确率%未填 = 未录该子题型
        const st=parseInt($('#cnt_sub_'+s.key).value)||0;
        let sc=st>0?Math.round(st*Math.max(0,Math.min(100,parseFloat(subPctRaw)))/100):0;
        if(sc>st)sc=st;
        if(st>0||sc>0){
          subsObj[s.key]={total:st,correct:sc};
          counts[s.key]={total:st,correct:sc};   // 平铺存一份，编辑回显直接按 key 取
        }
      });
      /* 大类正确率未填 + 无子题型明细 = 该模块本次未录，跳过（题数可能只是卷型预填）。
         注意判定必须在子题型循环之后：只填子题型（大类率留空）也要能存，
         此时按子题型汇总回填大类，与平时刷题「手填优先、空才用子汇总」同口径 */
      if(pctRaw===''&&!Object.keys(subsObj).length)return;
      let correct;
      if(pctRaw!==''){
        const pct=Math.max(0,Math.min(100,parseFloat(pctRaw)));
        correct=total>0?Math.round(total*pct/100):0;
      }else{
        let st2=0,sc2=0;
        Object.keys(subsObj).forEach(sk=>{st2+=subsObj[sk].total;sc2+=subsObj[sk].correct;});
        if(!(total>0))total=st2;
        correct=sc2;
      }
      if(total>0||correct>0){
        counts[t.key]={total,correct};
        if(Object.keys(subsObj).length)subMap[t.key]=subsObj;
      }
    });
    if(!name){toast('请填写试卷名');return;}
    const dur=$('#examDur').value; const duration=(dur===''||isNaN(parseFloat(dur)))?null:Math.max(0,parseFloat(dur));
    const note=$('#examNote').value.trim();
    /* 各模块 / 子模块用时（分钟），仅记录填了 >0 的项 */
    const modDurations={};
    const subDurationsOut={};
    EXAM_TYPES.forEach(t=>{
      const v=$('#dur_'+t.key).value;
      const m=(v===''||isNaN(parseFloat(v)))?null:Math.max(0,parseFloat(v));
      if(m!=null)modDurations[t.key]=m;
      (t.subs||[]).forEach(s=>{
        const sv=$('#dur_sub_'+s.key).value;
        const sm=(sv===''||isNaN(parseFloat(sv)))?null:Math.max(0,parseFloat(sv));
        if(sm!=null)subDurationsOut[s.key]=sm;
      });
    });
    // 由每模块真实「题数+正确数」直接折算 moduleStats（不再依赖全局 setVolume，根治断链/加权不准）
    // 子题型挂在 moduleStats[大类].subs，供薄弱分析的子模块看板按题量加权并入
    const moduleStats={}; const rates={};
    EXAM_TYPES.forEach(t=>{
      const c=counts[t.key];
      if(c&&c.total>0){
        moduleStats[t.key]={total:c.total,correct:c.correct};
        if(subMap[t.key])moduleStats[t.key].subs=subMap[t.key];
        rates[t.key]=c.correct/c.total;
        Object.keys(subMap[t.key]||{}).forEach(sk=>{rates[sk]=subMap[t.key][sk].correct/subMap[t.key][sk].total;});
      }
    });
    state.examRecords=state.examRecords||[];
    const _oldDate=r?r.date:null;
    const _mts=Date.now();
    if(r){Object.assign(r,{date,name,score:sc,percentile:pc,type,counts,duration,modDurations,subDurations:subDurationsOut,note,rates,moduleStats,mts:_mts});}
    else{
      state.examRecords.push({id:uid(),date,name,score:sc,percentile:pc,type,counts,duration,modDurations,subDurations:subDurationsOut,note,rates,moduleStats,mts:_mts});
    }
    /* 以 examRecords 为真相重建当天套卷打卡（首页今日汇总/日历详情读它：套数+加权正确率+各大类题量）；
       编辑时改了日期，新旧两天都要重算，否则旧日期残留、新日期显示 0 */
    syncTaojuanDaily(date);
    if(_oldDate&&_oldDate!==date)syncTaojuanDaily(_oldDate);
    // 关联任务：保存套卷成绩即标记该待办完成（取消则任务保持未做、仍在列表）
    if(todoId){
      const _td=(state.todos||[]).find(x=>x.id===todoId);
      completeTodoOnce(_td);
    }
    save();closeModal();render();toast('已保存');
  });
  if(r){
    $('#examDelBtn').addEventListener('click',()=>{uiConfirm('删除这条记录？',()=>{markEntityDeleted('examRecord',[r.id]);state.examRecords=(state.examRecords||[]).filter(x=>x.id!==r.id);syncTaojuanDaily(r.date);save();closeModal();render();},{danger:true});});
  }
}


/* ---------- 个人资料编辑 ---------- */
function openProfileEditor(){
  const p=state.userProfile||{};
  let editorAvatar=p.avatar||'';
  const pName=p.name||'局长';
  const avatarPreview=editorAvatar?`<img src="${escapeHtml(editorAvatar)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;">`:pName.charAt(0);
  const body=`
    <div class="row" style="margin-bottom:16px;align-items:center;gap:14px;">
      <div class="profile-avatar" id="editorAvatar" style="width:56px;height:56px;font-size:20px;flex-shrink:0;">${avatarPreview}</div>
      <div class="grow">
        <button class="btn btn-ghost btn-sm" id="uploadAvatarBtn">${icon('upload')} 上传头像</button>
        <input type="file" id="avatarFileInput" accept="image/*" style="display:none;">
        <div class="muted" style="font-size:11px;margin-top:5px;">支持 JPG/PNG，建议正方形图片</div>
      </div>
      ${editorAvatar?`<button class="icon-btn" id="removeAvatarBtn" title="移除头像" style="background:#fdeceb;color:var(--danger);">${icon('trash')}</button>`:''}
    </div>
    <div class="row" style="margin-bottom:14px;">
      <label style="width:70px;font-size:14px;font-weight:600;flex-shrink:0;">昵称</label>
      <input class="field" id="profileNameInput" value="${escapeHtml(pName)}" placeholder="输入昵称" maxlength="12">
    </div>
    <div class="row" style="margin-bottom:14px;align-items:flex-start;">
      <label style="width:70px;font-size:14px;font-weight:600;flex-shrink:0;padding-top:10px;">个性签名</label>
      <textarea class="field" id="profileSigInput" rows="3" placeholder="一句话介绍自己" maxlength="50">${escapeHtml(p.signature||'')}</textarea>
    </div>
    <div class="row" style="justify-content:flex-end;gap:8px;">
      <button class="btn btn-ghost btn-sm" onclick="closeModal()">取消</button>
      <button class="btn btn-sm" id="saveProfileBtn">保存</button>
    </div>`;
  openModal('编辑个人资料',body);
  // 头像上传
  $('#uploadAvatarBtn').addEventListener('click',()=>$('#avatarFileInput').click());
  $('#avatarFileInput').addEventListener('change',()=>{
    const file=$('#avatarFileInput').files[0];
    if(!file)return;
    if(file.size>2*1024*1024){toast('图片不能超过2MB');return;}
    const reader=new FileReader();
    reader.onload=()=>{
      editorAvatar=reader.result;
      $('#editorAvatar').innerHTML=`<img src="${escapeHtml(editorAvatar)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;">`;
    };
    reader.readAsDataURL(file);
  });
  // 移除头像
  const removeBtn=$('#removeAvatarBtn');
  if(removeBtn){
    removeBtn.addEventListener('click',()=>{
      editorAvatar='';
      $('#editorAvatar').textContent=($('#profileNameInput').value||'云').charAt(0);
      removeBtn.remove();
    });
  }
  // 昵称变化时更新头像预览（如果没有自定义头像）
  $('#profileNameInput').addEventListener('input',()=>{
    if(!editorAvatar){
      $('#editorAvatar').textContent=($('#profileNameInput').value||'云').charAt(0);
    }
  });
  // 保存
  $('#saveProfileBtn').addEventListener('click',()=>{
    const name=$('#profileNameInput').value.trim()||'云';
    const signature=$('#profileSigInput').value.trim();
    const _nw=Date.now();
    if(!state.userProfileMts||typeof state.userProfileMts!=='object')state.userProfileMts={};
    ['name','signature','avatar'].forEach(function(k){state.userProfileMts[k]=_nw;});
    state.userProfile={name,signature,avatar:editorAvatar};
    save();closeModal();render();
  });
}

/* ============================================================
   弹层与工具
   ============================================================ */
function openModal(title,bodyHtml,cls){
  const m=$('#modal'); m.className='modal'+(cls?' '+cls:'');
  $('#modalTitle').textContent=title;$('#modalBody').innerHTML=bodyHtml;
  $('#mask').classList.add('show');m.classList.add('show');
}
function closeModal(){var _m=$('#mask');if(_m)_m.classList.remove('show');var _md=$('#modal');if(_md)_md.classList.remove('show');if(_rollTimer){clearTimeout(_rollTimer);_rollTimer=null;}}
$('#modalClose').addEventListener('click',closeModal);
$('#mask').addEventListener('click',closeModal);
window.closeModal=closeModal;

/* ---------- 内部弹窗：替代原生 prompt / confirm / alert ---------- */
function escDlg(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function nl2br(s){return escDlg(s).replace(/\n/g,'<br>');}
// 确认弹窗（替代 confirm），onOk 回调；onCancel 可选
function uiConfirm(message,onOk,opts){opts=opts||{};const danger=opts.danger;openModal(opts.title||'确认',`<p class="dlg-msg">${nl2br(message)}</p><div class="dlg-actions"><button class="btn btn-ghost dlg-cancel">${opts.cancelText||'取消'}</button><button class="btn ${danger?'btn-danger':''} dlg-ok">${opts.okText||'确定'}</button></div>`);const box=$('#modalBody');if(!box)return;box.querySelector('.dlg-cancel').onclick=()=>{closeModal();if(opts.onCancel)opts.onCancel();};box.querySelector('.dlg-ok').onclick=()=>{closeModal();if(onOk)onOk();};}
// 输入弹窗（替代 prompt），opts:{title,message,value,placeholder,inputType,validate,onOk,okText}
function uiPrompt(opts){opts=opts||{};const body=`<p class="dlg-msg">${nl2br(opts.message||'')}</p><input class="dlg-input" type="${opts.inputType||'text'}" value="${escDlg(opts.value||'')}" placeholder="${escDlg(opts.placeholder||'')}"><div class="dlg-err"></div><div class="dlg-actions"><button class="btn btn-ghost dlg-cancel">取消</button><button class="btn dlg-ok">${opts.okText||'确定'}</button></div>`;openModal(opts.title||'输入',body);const box=$('#modalBody');if(!box)return;const inp=box.querySelector('.dlg-input');setTimeout(()=>{try{inp.focus();if(inp.select)inp.select();}catch(e){}},50);box.querySelector('.dlg-cancel').onclick=()=>closeModal();box.querySelector('.dlg-ok').onclick=()=>{const v=inp.value;if(opts.validate){const err=opts.validate(v);if(err){const e2=box.querySelector('.dlg-err');if(e2)e2.textContent=err;return;}}closeModal();if(opts.onOk)opts.onOk(v);};inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();box.querySelector('.dlg-ok').click();}});}

/* ---------- 版本更新提示（切回前台自动检测新版本） ---------- */
function checkAppUpdate(){
  fetch('./version.json?t='+Date.now(),{cache:'no-store'}).then(r=>r.json()).then(d=>{
    if(d&&d.v&&window.__APP_VER__&&d.v!==window.__APP_VER__){
      if(document.getElementById('updateBar'))return;
      var bar=el('div','update-bar');bar.id='updateBar';
      bar.innerHTML='发现新版本，<a href="javascript:void(0)">点此刷新</a>';
      bar.querySelector('a').addEventListener('click',()=>location.reload());
      document.body.appendChild(bar);
      setTimeout(()=>bar.classList.add('show'),20);
    }
  }).catch(()=>{});
}
function initVersionCheck(){
  checkAppUpdate();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkAppUpdate();});
  // 手机常驻 PWA：每 2 分钟也查一次，避免一直停在旧版（复盘页空白等 bug 修不掉）
  setInterval(checkAppUpdate,120000);
}

/* ============================================================
   悬浮音乐/白噪音播放器
   - 白噪音：Web Audio API 实时合成，不占存储
   - 我的音乐：IndexedDB 存文件本体，仅元数据进 localStorage
   - 播放器 DOM 在 #app 之外，切换页面不中断
   ============================================================ */
const NOISES=[
  {key:'rain_real', name:'雨声·实录', icon:'droplet', desc:'真实雨声录音·15秒无缝循环', real:true},
  {key:'white', name:'白噪音', icon:'wave',    desc:'均匀频谱·屏蔽环境杂音'},
  {key:'pink',  name:'粉红噪音',icon:'wave',    desc:'柔和低频·长时间不疲劳'},
  {key:'brown', name:'棕色噪音',icon:'wind',    desc:'低沉浑厚·深度专注'},
  {key:'stream',name:'溪流',   icon:'droplet', desc:'山涧流水·静心'}
];
function isRealAudio(key){const n=NOISES.find(x=>x.key===key);return !!(n&&n.real);}
const MDB='shangan_music', MSTORE='tracks';
let player={
  kind:null,        // 'noise' | 'music'
  key:null,         // 噪音类型 或 音乐 id
  name:'',
  playing:false,
  vol:0.6,
  mode:'loop',      // 'loop'单曲循环 | 'sequence'顺序播放 | 'shuffle'随机播放（仅对"我的音乐"生效）
  muted:false,
  tab:'noise'
};
const PLAY_MODES=[
  {key:'loop',     name:'单曲循环', icon:'repeat',  title:'单曲循环'},
  {key:'sequence', name:'顺序播放', icon:'list',    title:'顺序播放'},
  {key:'shuffle',  name:'随机播放', icon:'shuffle', title:'随机播放'}
];
function modeName(){const m=PLAY_MODES.find(x=>x.key===player.mode);return m?m.name:'单曲循环';}
function modeIcon(){const m=PLAY_MODES.find(x=>x.key===player.mode);return m?m.icon:'repeat';}
let audioCtx=null, noiseSrc=null, noiseGain=null, noiseFilter=null;
const audioEl=new Audio();

/* ---------- IndexedDB ---------- */
function mdb(){
  return new Promise(function(res,rej){
    const rq=indexedDB.open(MDB,1);
    rq.onupgradeneeded=function(e){
      const db=e.target.result;
      if(!db.objectStoreNames.contains(MSTORE))db.createObjectStore(MSTORE,{keyPath:'id'});
    };
    rq.onsuccess=e=>res(e.target.result);
    rq.onerror=e=>rej(e);
  });
}
function listTracks(){
  return mdb().then(db=>new Promise((res,rej)=>{
    const rq=db.transaction(MSTORE,'readonly').objectStore(MSTORE).getAll();
    // IndexedDB 按主键（随机 uid）返回，顺序是乱的，必须按导入时间排序，
    // 否则「顺序播放」会乱跳。ts 相同（老数据）时按文件名兜底，保证顺序稳定可预期。
    rq.onsuccess=()=>res((rq.result||[]).sort((a,b)=>
      ((a.ts||0)-(b.ts||0)) || String(a.name||'').localeCompare(String(b.name||''),'zh')
    ));
    rq.onerror=()=>rej(rq.error);
  }));
}
function saveTrack(t){
  return mdb().then(db=>new Promise((res,rej)=>{
    const rq=db.transaction(MSTORE,'readwrite').objectStore(MSTORE).put(t);
    rq.onsuccess=()=>res(); rq.onerror=()=>rej(rq.error);
  }));
}
function delTrack(id){
  return mdb().then(db=>new Promise((res,rej)=>{
    const rq=db.transaction(MSTORE,'readwrite').objectStore(MSTORE).delete(id);
    rq.onsuccess=()=>res(); rq.onerror=()=>rej(rq.error);
  }));
}

/* ---------- 白噪音合成 ---------- */
function getCtx(){
  if(!audioCtx){
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return null;
    audioCtx=new AC();
  }
  if(audioCtx.state==='suspended')audioCtx.resume();
  return audioCtx;
}
/* 各类型音色独立塑造：底噪滤波 + 事件层（雨滴/气泡） */
function fillWhite(d,len){
  for(let i=0;i<len;i++)d[i]=Math.random()*2-1;
}
function fillPink(d,len){
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for(let i=0;i<len;i++){
    const w=Math.random()*2-1;
    b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
    b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
    b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
    d[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11; b6=w*0.115926;
  }
}
function fillBrown(d,len){
  let last=0;
  for(let i=0;i<len;i++){const w=Math.random()*2-1;last=(last+0.02*w)/1.02;d[i]=last*3.5;}
}
/* 气泡：频率上滑（Minnaert 气泡振荡）+ 低通噪声水声质感
   包络取平方让进出更圆润，避免起止点的突变爆音 */
function addBubble(d,len,sr,start){
  const f0=170+Math.random()*380;
  const f1=f0*(1.7+Math.random()*1.3);
  const dur=Math.floor(sr*(0.045+Math.random()*0.09));
  const amp=0.42+Math.random()*0.70;
  let phase=0,nz=0;
  for(let j=0;j<dur&&start+j<len;j++){
    const p=j/dur;
    const env=Math.sin(Math.PI*p);
    const env2=env*env;                         // 更圆润的包络
    const f=f0+(f1-f0)*p;                       // 频率上滑 = 咕噜感
    phase+=2*Math.PI*f/sr;
    nz+=0.25*((Math.random()*2-1)-nz);          // 低通噪声，水流质感
    d[start+j]+=amp*env2*(Math.sin(phase)*0.78+nz*0.5);
  }
}
function fillStream(d,len,sr){
  // 水流：400Hz 高通 + 2.2kHz 低通，中频流动感
  const rc1=1/(2*Math.PI*400),rc2=1/(2*Math.PI*2200),dt=1/sr;
  const a1=rc1/(rc1+dt),a2=rc2/(rc2+dt);
  let pIn=0,pOut=0,lp=0;
  for(let i=0;i<len;i++){
    const w=Math.random()*2-1;
    pOut=a1*(pOut+w-pIn); pIn=w;
    lp+=a2*(pOut-lp);
    d[i]=lp*0.5;                                 // 水流压低，突出气泡咕噜
  }
  const n=Math.floor(len/sr*45);                // 每秒约45个气泡
  const safe=len-Math.floor(sr*0.3);
  for(let k=0;k<n;k++)addBubble(d,len,sr,Math.floor(Math.random()*safe));
}
function makeNoiseBuffer(ctx,type){
  const sr=ctx.sampleRate;
  const seconds=(type==='stream')?8:5;                  // 事件类更长，降低循环感
  const len=Math.floor(sr*seconds);
  const buf=ctx.createBuffer(1,len,sr);
  const d=buf.getChannelData(0);
  if(type==='pink')fillPink(d,len);
  else if(type==='brown')fillBrown(d,len);
  else if(type==='stream')fillStream(d,len,sr);
  else fillWhite(d,len);
  // 软限幅：先等比压到 0.9，再用 tanh 平滑饱和。
  // 硬削波（直接截断）会产生刺耳的方波谐波，这是"爆音/杂音"的主要来源。
  let peak=0;
  for(let i=0;i<len;i++){const a=Math.abs(d[i]);if(a>peak)peak=a;}
  const g=peak>0.9?(0.9/peak):1;
  for(let i=0;i<len;i++)d[i]=Math.tanh(d[i]*g*1.1)*0.88;
  // 首尾淡入淡出，消除循环接缝爆音
  const fade=Math.floor(sr*0.05);
  for(let i=0;i<fade;i++){const g=i/fade;d[i]*=g;d[len-1-i]*=g;}
  return buf;
}
function stopNoise(){
  if(noiseSrc){try{noiseSrc.stop();}catch(e){}try{noiseSrc.disconnect();}catch(e){}noiseSrc=null;}
  if(noiseGain){try{noiseGain.disconnect();}catch(e){}noiseGain=null;}
  if(noiseFilter){try{noiseFilter.disconnect();}catch(e){}noiseFilter=null;}
}
function stopMusic(){
  if(!audioEl.paused)audioEl.pause();
}
function stopAll(){stopNoise();stopMusic();}

/* 真实录音：base64 → Blob → ObjectURL（只转一次，长期缓存）
   <audio loop> 会读取 MP3 的 LAME tag 自动跳过编码填充，实现无缝循环 */
let realAudioUrl=null;
function getRealAudioUrl(){
  if(realAudioUrl)return realAudioUrl;
  if(typeof RAIN_MP3_B64==='undefined'||!RAIN_MP3_B64)return null;
  try{
    const bin=atob(RAIN_MP3_B64), bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    realAudioUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/mpeg'}));
  }catch(e){return null;}
  return realAudioUrl;
}

function playNoise(type){
  const n=NOISES.find(x=>x.key===type)||NOISES[0];
  // 真实录音走 audioEl（非 Web Audio 合成）
  if(n.real){
    stopAll();
    const url=getRealAudioUrl();
    if(!url){toast('内置音频数据缺失。');return;}
    if(audioEl.src!==url)audioEl.src=url;   // src 不变则不重载，实现暂停/继续
    audioEl.volume=player.muted?0:player.vol;
    audioEl.loop=true;
    const p=audioEl.play();
    if(p&&p.catch)p.catch(function(e){toast('播放失败：'+(e&&e.message||e));});
    player.kind='noise';player.key=type;player.name=n.name;player.playing=true;
    updatePlayerUI();
    return;
  }
  const ctx=getCtx();
  if(!ctx){toast('当前浏览器不支持 Web Audio，无法播放白噪音。');return;}
  stopAll();
  const buf=makeNoiseBuffer(ctx,type);
  noiseSrc=ctx.createBufferSource();
  noiseSrc.buffer=buf; noiseSrc.loop=true;
  noiseFilter=ctx.createBiquadFilter();
  if(type==='stream'){noiseFilter.type='peaking';noiseFilter.frequency.value=1200;noiseFilter.Q.value=0.8;noiseFilter.gain.value=3;}
  else if(type==='brown'){noiseFilter.type='lowpass';noiseFilter.frequency.value=900;}
  else if(type==='pink'){noiseFilter.type='lowpass';noiseFilter.frequency.value=7000;}
  else{noiseFilter.type='lowpass';noiseFilter.frequency.value=11000;}
  noiseGain=ctx.createGain();
  noiseGain.gain.value=player.muted?0:player.vol;
  noiseSrc.connect(noiseFilter);noiseFilter.connect(noiseGain);noiseGain.connect(ctx.destination);
  noiseSrc.start(0);
  player.kind='noise';player.key=type;player.name=n.name;player.playing=true;
  updatePlayerUI();
}
let musicBlobUrl=null;
function playTrack(t){
  stopAll();
  if(musicBlobUrl){URL.revokeObjectURL(musicBlobUrl);musicBlobUrl=null;}
  musicBlobUrl=URL.createObjectURL(t.blob);
  audioEl.src=musicBlobUrl;
  audioEl.volume=player.muted?0:player.vol;
  audioEl.loop=(player.mode==='loop');
  const p=audioEl.play();
  if(p&&p.catch)p.catch(function(e){toast('播放失败：'+(e&&e.message||e));});
  player.kind='music';player.key=t.id;player.name=t.name;player.playing=true;
  updatePlayerUI();
}
function togglePlay(){
  if(!player.kind){ // 没选过就播列表第一项
    playNoise(NOISES[0].key);return;
  }
  if(player.playing){
    stopAll();player.playing=false;updatePlayerUI();
  }else{
    if(player.kind==='noise')playNoise(player.key); // 内部已更新 UI
    else{
      listTracks().then(list=>{
        const t=list.find(x=>x.id===player.key);
        if(t)playTrack(t); // 内部已更新 UI
        else {player.kind=null;updatePlayerUI();}
      });
    }
  }
}
function setVol(v){
  player.vol=v;
  if(noiseGain)noiseGain.gain.value=player.muted?0:v;
  audioEl.volume=player.muted?0:v;
  try{localStorage.setItem('wb_player_vol',String(v));}catch(e){}
}

function updatePlayerUI(){
  const btn=$('#nowPlayBtn');
  if(btn){
    // 白噪音是背景音，刻意不占顶栏位置；“我的音乐”才给快捷暂停
    const show=player.playing&&player.kind==='music';
    btn.style.display=show?'flex':'none';
    btn.classList.toggle('on',show);
    btn.innerHTML=`<svg class="icon"><use href="#i-${player.playing?'pause':'play'}"/></svg>`;
    btn.title=show?('正在播放：'+player.name+'（点击暂停）'):'';
  }
  if(currentTab==='music')render();
}
/* ---------- 音乐页（侧边栏「工具 → 音乐」入口） ----------
   全站唯一的播放入口，切页面不中断播放；顶栏播放键是快捷暂停 */
function renderMusicPage(c){
  // 当前播放
  const nowCard=el('div','card');
  const isPlay=player.playing;
  const hasItem=!!player.kind;              // 有选中项（播放中或已暂停）
  nowCard.innerHTML=`
    <div class="section-title"><span class="dot"></span>正在播放</div>
    <div class="mp-now">
      <div class="mp-now-icon${isPlay?' on':''}">
        <svg class="icon"><use href="#i-music"/></svg>
      </div>
      <div class="mp-now-info">
        <div class="mp-now-name">${hasItem?escapeHtml(player.name):'未播放'}</div>
        <div class="mp-now-sub">${isPlay?(player.kind==='noise'?(isRealAudio(player.key)?'真实录音 · 无缝循环':'合成白噪音 · 持续播放'):('本地音乐 · '+modeName())):(hasItem?'已暂停 · 点「播放」继续':'从下方选一个开始专注')}</div>
      </div>
    </div>
    <div class="mp-ctrl">
      <button class="btn" id="mpToggle">${icon(isPlay?'pause':'play')} ${isPlay?'暂停':'播放'}</button>
      <button class="mp-mode-btn" id="mpMode" title="播放模式：${modeName()}（点击切换）">${icon(modeIcon())}<span>${modeName()}</span></button>
      <button class="mp-icon-btn${player.muted?' on':''}" id="mpMute" title="静音">${icon(player.muted?'volume-off':'volume')}</button>
      <label class="mp-vol">
        <svg class="icon"><use href="#i-${player.muted?'volume-off':'volume'}"/></svg>
        <input type="range" id="mpVol" min="0" max="100" value="${Math.round(player.vol*100)}">
      </label>
    </div>`;
  c.appendChild(nowCard);

  // 白噪音 / 我的音乐 —— Tab 切换（player.tab: 'noise' | 'music'）
  const listCard=el('div','card');
  const isNoiseTab=(player.tab!=='music');

  const tabsBar=el('div','mp-tabs');
  const tabBtns=['noise','music'].map(k=>{
    const b=el('button','mp-tab'+((k==='noise')===isNoiseTab?' active':''));
    b.textContent=(k==='noise')?'白噪音':'我的音乐';   // el() 只收两个参数，文字得单独设
    b.dataset.mptab=k;
    tabsBar.appendChild(b);
    return b;
  });
  listCard.appendChild(tabsBar);

  const headRow=el('div','mp-sec-head');
  const randNoise=el('button','mp-mini-btn','');
  randNoise.id='mpRandNoise';
  randNoise.title='从白噪音列表随机播放一个';
  randNoise.innerHTML=`${icon('shuffle')} 随机一个`;
  randNoise.style.display=isNoiseTab?'flex':'none';
  const randTrack=el('button','mp-mini-btn','');
  randTrack.id='mpRandTrack';
  randTrack.title='从我的音乐随机播放一首';
  randTrack.innerHTML=`${icon('shuffle')} 随机一个`;
  randTrack.style.display=isNoiseTab?'none':'flex';
  headRow.appendChild(randNoise);
  headRow.appendChild(randTrack);
  listCard.appendChild(headRow);

  const paneNoise=el('div','mp-pane');
  paneNoise.style.display=isNoiseTab?'block':'none';
  const paneMusic=el('div','mp-pane');
  paneMusic.style.display=isNoiseTab?'none':'block';
  paneNoise.innerHTML=`<div class="muted" style="margin-bottom:12px;">标「实录」的是内置音频，其余由浏览器实时合成。点正在播放的那一项可停止。</div>`;

  tabsBar.addEventListener('click',e=>{
    const b=e.target.closest('.mp-tab');if(!b)return;
    player.tab=b.dataset.mptab;
    tabBtns.forEach(x=>x.classList.toggle('active',x===b));
    const noise=(player.tab==='noise');
    paneNoise.style.display=noise?'block':'none';
    paneMusic.style.display=noise?'none':'block';
    randNoise.style.display=noise?'flex':'none';
    randTrack.style.display=noise?'none':'flex';
  });

  const grid=el('div','mp-noise-grid');
  NOISES.forEach(n=>{
    const on=(player.kind==='noise'&&player.key===n.key&&player.playing);
    const cd=el('div','mp-noise'+(on?' active':''));
    cd.innerHTML=`<svg class="icon"><use href="#i-${n.icon}"/></svg>
      <div class="mp-n-name">${n.name}</div>
      <div class="mp-n-desc">${n.desc}</div>`;
    cd.addEventListener('click',()=>{
      if(on){stopAll();player.playing=false;}
      else playNoise(n.key);
      updatePlayerUI();
    });
    grid.appendChild(cd);
  });
  paneNoise.appendChild(grid);
  listCard.appendChild(paneNoise);

  const listWrap=el('div');
  listWrap.innerHTML=`<div class="muted">读取中…</div>`;
  paneMusic.appendChild(listWrap);
  const addBtn=el('button','btn btn-ghost btn-sm');
  addBtn.innerHTML=`${icon('plus')} 导入本地音乐`;
  addBtn.style.marginTop='10px';
  addBtn.addEventListener('click',()=>{
    const inp=document.createElement('input');
    inp.type='file';inp.accept='audio/*';inp.multiple=true;
    inp.style.display='none';document.body.appendChild(inp);
    inp.addEventListener('change',()=>{
      const files=[...inp.files];
      if(inp.parentNode)inp.parentNode.removeChild(inp);
      if(!files.length)return;
      let done=0;
      // ts 加索引偏移：同批导入的文件在同一毫秒内处理，ts 会完全相同，
      // 导致列表顺序退化为 IndexedDB 的主键顺序（随机），顺序播放就会乱跳
      files.forEach((f,i)=>{
        saveTrack({id:uid(),name:f.name.replace(/\.[^.]+$/,''),size:f.size,blob:f,ts:Date.now()+i})
          .then(()=>{done++;if(done===files.length)render();});
      });
    });
    inp.click();
  });
  paneMusic.appendChild(addBtn);
  listCard.appendChild(paneMusic);
  c.appendChild(listCard);

  listTracks().then(list=>{
    listWrap.innerHTML='';
    if(!list.length){
      listWrap.innerHTML=`<div class="muted">还没有导入音乐。文件存于本机浏览器，不上传服务器。</div>`;
      return;
    }
    list.forEach(t=>{
      const on=(player.kind==='music'&&player.key===t.id&&player.playing);
      const row=el('div','mp-track'+(on?' active':''));
      row.innerHTML=`
        <svg class="icon"><use href="#i-music"/></svg>
        <div class="mp-t-info">
          <div class="mp-t-name">${escapeHtml(t.name)}</div>
          <div class="mp-t-size">${(t.size>=1048576)?(t.size/1048576).toFixed(1)+' MB':(t.size>=1024)?Math.round(t.size/1024)+' KB':t.size+' B'}</div>
        </div>`;
      const del=el('button','icon-btn');
      del.innerHTML=icon('trash');del.title='删除';
      del.addEventListener('click',e=>{
        e.stopPropagation();
        uiConfirm('删除这首音乐？',()=>{
          delTrack(t.id).then(()=>{
            if(player.key===t.id){stopAll();player.kind=null;player.playing=false;player.name='';}
            updatePlayerUI();
          });
        },{danger:true});
      });
      row.appendChild(del);
      row.addEventListener('click',()=>{
        if(on){stopAll();player.playing=false;}
        else playTrack(t);
        updatePlayerUI();
      });
      listWrap.appendChild(row);
    });
  }).catch(()=>{listWrap.innerHTML=`<div class="muted">读取音乐库失败，请检查浏览器存储权限。</div>`;});

  // 控制区事件
  $('#mpToggle').addEventListener('click',()=>{togglePlay();});
  $('#mpMode').addEventListener('click',()=>{
    const i=PLAY_MODES.findIndex(x=>x.key===player.mode);
    player.mode=PLAY_MODES[(i+1)%PLAY_MODES.length].key;
    audioEl.loop=(player.mode==='loop');
    try{localStorage.setItem('wb_player_mode',player.mode);}catch(e){}
    updatePlayerUI();
  });
  // 白噪音列表随机
  $('#mpRandNoise').addEventListener('click',()=>{
    const pool=NOISES.filter(n=>!(player.kind==='noise'&&player.key===n.key&&player.playing));
    const pick=(pool.length?pool:NOISES)[Math.floor(Math.random()*(pool.length||NOISES.length))];
    playNoise(pick.key); // 内部已更新 UI
  });
  // 我的音乐随机
  $('#mpRandTrack').addEventListener('click',()=>{
    listTracks().then(list=>{
      if(!list.length){toast('还没有导入音乐，先点下方按钮添加本地音频。');return;}
      const pool=list.filter(t=>t.id!==player.key);
      const arr=pool.length?pool:list;
      playTrack(arr[Math.floor(Math.random()*arr.length)]); // 内部已更新 UI
    });
  });
  $('#mpMute').addEventListener('click',()=>{
    player.muted=!player.muted;
    setVol(player.vol);
    updatePlayerUI();
  });
  $('#mpVol').addEventListener('input',function(){setVol(parseFloat(this.value)/100);});
}

function initPlayer(){
  try{
    const v=localStorage.getItem('wb_player_vol');
    if(v!==null&&v!=='')player.vol=parseFloat(v)||0.6;
  }catch(e){}
  try{
    const m=localStorage.getItem('wb_player_mode');
    if(m&&PLAY_MODES.some(x=>x.key===m))player.mode=m;
  }catch(e){}
  const btn=$('#nowPlayBtn');
  if(btn)btn.addEventListener('click',function(){togglePlay();});

  // 音乐播完（非循环时）自动下一首
  audioEl.addEventListener('ended',()=>{
    if(player.mode==='loop')return;                 // 单曲循环交给 audioEl.loop
    listTracks().then(list=>{
      if(list.length<2){player.playing=false;updatePlayerUI();return;}
      let next;
      if(player.mode==='shuffle'){
        // 随机：排除当前这首，避免连续两次播同一首
        const pool=list.filter(x=>x.id!==player.key);
        next=pool[Math.floor(Math.random()*pool.length)];
      }else{
        const i=list.findIndex(x=>x.id===player.key);
        next=list[i+1];                              // 顺序：到末尾停止
      }
      if(next)playTrack(next); else {player.playing=false;updatePlayerUI();}
    });
  });
  audioEl.addEventListener('pause',()=>{if(player.kind==='music'){player.playing=false;updatePlayerUI();}});
  audioEl.addEventListener('play',()=>{if(player.kind==='music'){player.playing=true;updatePlayerUI();}});

  updatePlayerUI();
}

/* ---------- 启动 ---------- */
/* 刷新/关闭前保存番茄钟当前进度，避免进行中状态丢失 */
function persistPomo(){
  if(window.__CLEARING)return; // 正在清空数据，跳过写回，避免旧数据在 reload 时被复活
  state.pomo={duration:pomo.duration,custom:!!pomo.custom,section:pomo.section,sub:pomo.sub||'',remaining:pomo.remaining,done:!!pomo.done,endAt:pomo.endAt||null,startTs:pomo.startTs||null,running:!!pomo.running,overtime:!!pomo.overtime,kind:pomo.kind||'focus'};try{localStorage.setItem(STORE_KEY,JSON.stringify(state));}catch(e){}
}
window.addEventListener('pagehide',persistPomo);
window.addEventListener('beforeunload',persistPomo);
window.addEventListener('pagehide',flushSyncIfDirty);
window.addEventListener('beforeunload',flushSyncIfDirty);
// 残留清理：极简模式已下线，若旧缓存页面给 body 挂过 .minimal，这里摘掉
try{document.body.classList.remove('minimal');}catch(e){}
render();
initPomoFloat();
initSync();
initVersionCheck();
initPlayer();
initScrollNav();

/* 右下角回顶/到底悬浮按钮：只在内容可滚动且超过阈值时显示 */
function initScrollNav(){
  const wrap=document.createElement('div');
  wrap.className='scroll-nav';
  wrap.innerHTML='<button class="sv-top" aria-label="回到顶部">↑</button><button class="sv-bot" aria-label="到底部">↓</button>';
  document.body.appendChild(wrap);
  const topBtn=wrap.querySelector('.sv-top'), botBtn=wrap.querySelector('.sv-bot');
  const content=()=>document.getElementById('content');
  function update(){
    const el=content();
    if(!el){wrap.classList.remove('show');return;}
    const canUp=el.scrollTop>240;
    const canDown=el.scrollHeight-el.scrollTop-el.clientHeight>240;
    topBtn.style.display=canUp?'flex':'none';
    botBtn.style.display=canDown?'flex':'none';
    wrap.classList.toggle('show',canUp||canDown);
  }
  topBtn.onclick=()=>{const el=content();if(el)scrollTopInstant(el,0);};
  botBtn.onclick=()=>{const el=content();if(el)scrollTopInstant(el,el.scrollHeight);};
  window.addEventListener('scroll',update,true);
  setInterval(update,800);
  setTimeout(update,400);
}
