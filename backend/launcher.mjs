// launcher.mjs —— 由 launcher.vbs（隐藏窗口）调用
// 职责：探测后端是否已在线；没在线就以「托管模式」(WEBCHAT_MANAGED=1) 静默拉起 server.js，
//   然后立即退出。后端生命周期不再由本进程看门狗管，而是交给「扩展心跳」：
//     浏览器开着 → 扩展的 background.js 周期性 ping /api/heartbeat → 后端存活；
//     浏览器关闭 → 扩展服务线程被回收、心跳断 → 后端在宽限期内自行优雅退出。
// 这样做彻底摆脱「写死浏览器进程名」的做法，千问/Edge/Chrome/夸克/任意 Chromium 内核通用。
// 放在 backend/ 目录下，自动以自身所在目录作为后端目录，便于整体拷贝/部署。
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 与 server.js / panel.js 保持一致的端口（优先读 .env 的 PORT）
let PORT = 3000;
try {
  const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  const m = txt.match(/^\s*PORT\s*=\s*(\d+)/m);
  if (m) PORT = parseInt(m[1], 10);
} catch (_) {}

function probe() {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: PORT });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        s.destroy();
      } catch (_) {}
      resolve(v);
    };
    s.setTimeout(700);
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    s.on("timeout", () => done(false));
  });
}

const already = await probe();
if (already) {
  console.log("backend already running on port " + PORT);
  process.exit(0);
}

// 拉起 server.js：托管模式（靠扩展心跳续命），detached 脱离启动器独立运行
const child = spawn(process.execPath, ["server.js"], {
  cwd: __dirname,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: { ...process.env, WEBCHAT_MANAGED: "1" },
});
child.unref(); // 不阻止本进程退出；后端作为独立进程继续运行

console.log("backend launched (managed mode), pid=" + child.pid);
process.exit(0);
