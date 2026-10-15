/* 爱莉希雅主题 · 装饰层
 * ------------------------------------------------------------------
 * 只在背景层撒一些飘落花瓣：粉色的花瓣 + 少量水晶蓝花瓣，
 * 位置、大小、速度、漂移全随机，纯 CSS 动画驱动（见 style.css 的 petalFall）。
 * 不参与任何交互：容器 pointer-events:none，元素本身也不接收事件。
 * 系统开了「减少动态效果」就一片都不生成，只留静态光晕与星光。
 */
(function () {
  const field = document.getElementById('petalField');
  if (!field) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const COUNT = 16;
  const rand = (a, b) => a + Math.random() * (b - a);

  for (let i = 0; i < COUNT; i++) {
    const p = document.createElement('span');
    const size = rand(9, 20);
    // 三成是水晶蓝，其余是她的粉
    p.className = 'petal' + (Math.random() < 0.3 ? ' crystal' : '');
    p.style.left = rand(1, 98).toFixed(1) + '%';
    p.style.width = size.toFixed(1) + 'px';
    p.style.height = (size * rand(0.72, 0.95)).toFixed(1) + 'px';
    p.style.setProperty('--drift', rand(-90, 90).toFixed(0) + 'px');
    p.style.animationDuration = rand(13, 26).toFixed(1) + 's';
    p.style.animationDelay = (-rand(0, 24)).toFixed(1) + 's';  // 负延迟：开场就已经在飘
    p.style.opacity = rand(0.28, 0.55).toFixed(2);
    field.appendChild(p);
  }
})();
