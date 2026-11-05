// 这个文件跑在沙箱里 —— 没有 require / fs / fetch / 宿主的 DOM。
// 能往外做的事只有 butlerUI.call(目录里的一条命令) 和 butlerUI.setState(存自己的东西)。
// 所以这里想怎么写就怎么写: 动画、状态机、随便。
var car = document.getElementById('car');
var countEl = document.getElementById('count');
var runs = 0;

butlerUI.onInit(function (d) {
  // 上次存的东西回来了(重开 app 也还在)
  runs = (d.state && d.state.runs) || 0;
  paint();
});

function paint() {
  countEl.textContent = runs ? '跑了 ' + runs + ' 次' : '';
}

document.getElementById('go').onclick = function () {
  car.classList.toggle('run');
  if (car.classList.contains('run')) {
    runs++;
    paint();
    butlerUI.setState({ runs: runs });   // 宿主替我存, 下次 onInit 带回来
  }
};

document.getElementById('say').onclick = function () {
  // 目录里没有的名字会被宿主拒掉 —— 这里挑的是 meta.json 里声明过的那条
  butlerUI.call('demo.say', { text: '小车跑起来了' }).then(function (r) {
    if (!r.ok) countEl.textContent = '念不了: ' + (r.message || '');
  });
};
