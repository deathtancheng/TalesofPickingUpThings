/**
 * 《拾物奇谭》—— 服务入口
 * ------------------------------------------------------------------
 * 这个文件只做一件事：**组装**。
 *
 *   读配置 → 建共享上下文 → 建 HTTP 服务 → 监听端口
 *
 * 业务一律不写在这里：
 *   · 规则与数值   → src/game/rules/
 *   · 智能体内核   → src/harness/
 *   · 工具与推理   → src/agent/、src/vision/
 *   · 路由与传输   → src/http/
 *
 * 想加新接口，去 src/http/routes/ 加一个文件，再在 router.js 里登记，
 * 这个文件一个字都不用动。
 */

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const {
  PORT, SANDBOX_DIR, OLLAMA, YOLO_ENGINE, YOLO_WEIGHTS, YOLO_CONF, CAMERA_URL,
} = require('./src/config');
const { ctx, startAutomationScheduler } = require('./src/http/context');
const { createServer } = require('./src/http/server');

// 沙箱是智能体能读写的唯一目录，先确保它存在
fs.mkdirSync(SANDBOX_DIR, { recursive: true });

/**
 * 全局防崩兜底（v4.5.4）
 * ------------------------------------------------------------------
 * 任何一个没接住的异步异常都会让整个进程静默退出——game.bat 用
 * start /min 启动，窗口一闪人根本看不见，玩家只会看到"连不上后端"。
 * 这里改成：记进 logs/crash.log，进程继续活着。
 */
const CRASH_LOG = path.join(__dirname, 'logs', 'crash.log');
function noteCrash(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${(err && (err.stack || err.message)) || err}\n`;
  try { fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true }); fs.appendFileSync(CRASH_LOG, line); } catch {}
  console.error(line);
}
process.on('uncaughtException', (err) => noteCrash('uncaughtException', err));
process.on('unhandledRejection', (err) => noteCrash('unhandledRejection', err));

/**
 * 摄像头服务自愈（v4.5.1）
 * ------------------------------------------------------------------
 * camera_server.py 是个独立进程，以前只能靠 start.bat 手动拉起；
 * 它一死（机器重启、会话回收），页面上的取景框就永远"未连接"，
 * 玩家还以为是游戏坏了。现在 Web 服务启动时探一下 5179，
 * 没人应答就自动把摄像头服务拉起来（best-effort，拉不起来也不影响玩——
 * 还有"手动举物"兜底）。
 */
function probeCamera(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function ensureCamera() {
  const base = CAMERA_URL.replace(/\/$/, '');
  if (await probeCamera(`${base}/stats`)) {
    console.log('  摄像头服务：已在运行 ✓');
    return;
  }
  // python 解释器：优先 YOLO 专用 venv，其次 WorkBuddy 自带的
  const venvPy = 'D:\\yolo-venv\\Scripts\\python.exe';
  const fbPy = path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
  const py = fs.existsSync(venvPy) ? venvPy : (fs.existsSync(fbPy) ? fbPy : 'python');
  // 权重路径：config 里存的是相对 yolo/ 目录的，这里统一解析成绝对路径
  const camScript = path.join(__dirname, 'yolo', 'camera_server.py');
  const weightCandidates = [
    YOLO_WEIGHTS,
    path.join(__dirname, YOLO_WEIGHTS),
    path.join(__dirname, 'yolo', YOLO_WEIGHTS),
  ];
  const weights = weightCandidates.find((p) => p && fs.existsSync(p))
    || (() => {
      // 还找不到就照 start.bat 的办法扫一遍 runs
      try {
        const dir = path.join(__dirname, 'yolo', 'runs');
        const stack = [dir];
        while (stack.length) {
          const d = stack.pop();
          for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, f.name);
            if (f.isDirectory()) stack.push(full);
            else if (f.name === 'best.pt') return full;
          }
        }
      } catch { /* 没有权重目录 */ }
      return null;
    })();
  if (!fs.existsSync(camScript) || !weights) {
    console.log('  摄像头服务：缺少 camera_server.py 或权重，跳过自启（手动举物可玩）');
    return;
  }
  try {
    const child = spawn(py, [camScript, '--weights', weights], {
      cwd: path.join(__dirname, 'yolo'),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.log(`  摄像头服务：已自动拉起（pid ${child.pid}，模型加载约 15 秒）`);
  } catch (err) {
    console.log('  摄像头服务：自动拉起失败（' + err.message + '）——手动举物可玩');
  }
}

const server = createServer(ctx);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  本地智能体已就绪 → http://127.0.0.1:${PORT}`);
  console.log(`  Ollama 上游：${OLLAMA}`);
  console.log(`  YOLO 引擎　：${YOLO_ENGINE} | 权重 ${YOLO_WEIGHTS} | 置信度 ${YOLO_CONF}`);
  console.log(`  沙箱目录　：${SANDBOX_DIR}`);
  ensureCamera().catch(() => {});
  startAutomationScheduler(); // 自动化任务：每 30 秒查一次到期任务
  console.log('');
});
