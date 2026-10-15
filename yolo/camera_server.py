"""
摄像头实时检测服务：把 YOLO 推理结果以 MJPEG 流喂给浏览器。

启动：
    python camera_server.py --weights runs/coco128_yolo11n/weights/best.pt
    python camera_server.py --engine onnx --weights yolo11n.onnx
    python camera_server.py --source test.mp4      # 没有摄像头时用视频文件代替

对外接口（默认 http://127.0.0.1:5179）：
    GET /video      MJPEG 实时流（已画框），可直接塞进 <img src="...">
    GET /snapshot   当前帧的 JPEG（已画框）
    GET /detect     当前帧的检测结果 JSON，给智能体当工具用
    GET /stats      引擎、延迟、帧率
"""

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
from infer import Detector  # noqa: E402

# COCO 17 关键点顺序（yolo11n-pose 的输出顺序）
POSE_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]


class PoseEstimator:
    """姿态估计：给前端「立绘模仿动作」供关键点。

    懒加载——只有第一次访问 /pose 时才把 yolo11n-pose.pt 拉起来
    （本地没有会自动下载，约 6MB），纯检测场景完全不受影响。
    自带锁：姿态推理跑在 HTTP 线程里，跟摄像头线程的检测模型互不阻塞。
    """

    def __init__(self):
        self.model = None
        self.lock = threading.Lock()

    def infer(self, bgr):
        with self.lock:
            if self.model is None:
                from ultralytics import YOLO  # noqa: PLC0415
                # 权重跟脚本放一起（yolo/yolo11n-pose.pt），别依赖进程的 cwd
                w = Path(__file__).resolve().parent / "yolo11n-pose.pt"
                self.model = YOLO(str(w) if w.exists() else "yolo11n-pose.pt")
            res = self.model.predict(bgr, imgsz=320, conf=0.3, verbose=False)[0]
        if res.keypoints is None or res.boxes is None or len(res.boxes) == 0:
            return None
        confs = [float(c) for c in res.boxes.conf.tolist()]
        i = max(range(len(confs)), key=lambda k: confs[k])   # 人多时只跟最像的那个
        h, w = bgr.shape[:2]
        kpts = {}
        for name, (x, y) in zip(POSE_NAMES, res.keypoints.xy[i].tolist()):
            kpts[name] = [round(x / w, 4), round(y / h, 4)]  # 归一化，前端不关心分辨率
        return {
            "score": round(confs[i], 3),
            "box": [round(float(v), 1) for v in res.boxes.xyxy[i].tolist()],
            "kpts": kpts,
        }


class CameraWorker(threading.Thread):
    """后台线程不断抓帧 + 推理，主线程只负责把最新结果发出去。"""

    def __init__(self, source, detector):
        super().__init__(daemon=True)
        self.source = source
        self.det = detector
        self.cap = None
        self.lock = threading.Lock()
        self.raw = None
        self.annotated = None
        self.items = []
        self.latency = 0.0
        self.fps = 0.0
        self.error = None
        self.running = True
        # 画面尺寸。游戏要用"物件占画面的比例"当威力，坐标光有绝对值不够，
        # 前端画框也需要归一化，所以这里一并对外给出。
        self.width = 0
        self.height = 0

    def open(self):
        src = self.source
        cap = cv2.VideoCapture(int(src) if str(src).isdigit() else src)
        if not cap.isOpened():
            self.error = f"打不开视频源：{self.source}"
            return False
        self.cap = cap
        return True

    def run(self):
        if not self.open():
            return
        last = time.perf_counter()
        misses = 0
        while self.running:
            ok, frame = self.cap.read()
            if not ok:
                if str(self.source).isdigit():
                    # 摄像头偶发读失败（被别的程序抢占、USB 抖动）先试着重开，
                    # 别一枪毙命——5 次都救不回来才认输。
                    misses += 1
                    if misses > 5:
                        self.error = "摄像头读取失败（重开 5 次仍未恢复，可能被其他程序占用）"
                        return
                    self.error = f"摄像头读取中断，第 {misses}/5 次尝试重开……"
                    try:
                        self.cap.release()
                    except Exception:
                        pass
                    time.sleep(1.0)
                    if not self.open():
                        continue  # open 失败会写 error，下一轮接着试
                    self.error = None
                    continue
                self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # 视频文件循环播放
                continue
            misses = 0
            items, ms = self.det.detect(frame)
            anno = self.det.draw(frame, items)
            now = time.perf_counter()
            fps = 1.0 / max(now - last, 1e-6)
            last = now
            with self.lock:
                self.raw = frame
                self.annotated = anno
                self.items = items
                self.latency = ms
                self.fps = fps
                if frame is not None:
                    self.height, self.width = frame.shape[:2]

    def snapshot(self):
        with self.lock:
            return (self.annotated.copy() if self.annotated is not None else None,
                    list(self.items), self.latency, self.fps)


class Handler(BaseHTTPRequestHandler):
    worker: CameraWorker = None
    pose: PoseEstimator = None
    engine_name = "pt"

    def log_message(self, *a):
        pass  # 静音，别刷屏

    def handle_one_request(self):
        """客户端关掉页面、或切走视频流时会强断连接。

        Windows 上这时抛的是 ConnectionAbortedError（WinError 10053），
        不属于 BrokenPipeError / ConnectionResetError，所以光在推流循环里
        捕获那两个是不够的——异常会一路冒泡到 socketserver.handle_error，
        每次断开往日志里甩一整个 traceback。这里统一兜住。
        """
        try:
            super().handle_one_request()
        except OSError:
            self.close_connection = True

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ("/", "/video"):
            if self.worker.error:
                self._json({"error": self.worker.error}, 503)
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=--frame")
            self._cors()
            self.end_headers()
            try:
                while True:
                    anno, _, _, _ = self.worker.snapshot()
                    if anno is None:
                        time.sleep(0.05)
                        continue
                    ok, buf = cv2.imencode(".jpg", anno, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if not ok:
                        continue
                    data = buf.tobytes()
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(data)}\r\n\r\n".encode())
                    self.wfile.write(data + b"\r\n")
                    time.sleep(0.03)
            except OSError:
                return  # 客户端断开，正常退出

        elif path == "/snapshot":
            anno, _, _, _ = self.worker.snapshot()
            if anno is None:
                self._json({"error": self.worker.error or "还没有帧"}, 503)
                return
            ok, buf = cv2.imencode(".jpg", anno, [cv2.IMWRITE_JPEG_QUALITY, 90])
            data = buf.tobytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        elif path == "/detect":
            if self.worker.error:
                self._json({"error": self.worker.error}, 503)
                return
            _, items, ms, fps = self.worker.snapshot()
            self._json({
                "detections": items,
                "summary": Detector.summarize(items),
                "latency_ms": round(ms, 1),
                "fps": round(fps, 1),
                "width": self.worker.width,
                "height": self.worker.height,
            })

        elif path == "/stats":
            self._json({
                "engine": self.engine_name,
                "latency_ms": round(self.worker.latency, 1),
                "fps": round(self.worker.fps, 1),
                "error": self.worker.error,
            })

        elif path == "/pose":
            # 姿态关键点：给立绘模仿动作用。帧来自检测线程的最新原帧，
            # 推理在本线程做——前端按需轮询（开模仿才轮询），平时零开销
            if self.worker.error:
                self._json({"error": self.worker.error}, 503)
                return
            with self.worker.lock:
                frame = None if self.worker.raw is None else self.worker.raw.copy()
            if frame is None:
                self._json({"error": "还没有帧"}, 503)
                return
            try:
                found = self.pose.infer(frame)
            except Exception as err:  # noqa: BLE001  权重下载失败等
                self._json({"error": f"姿态估计失败：{err}"}, 500)
                return
            self._json({
                "person": found is not None,
                "pose": found,
                "width": self.worker.width,
                "height": self.worker.height,
                "fps": round(self.worker.fps, 1),
            })

        else:
            self._json({"error": "not found"}, 404)


def already_running(port):
    """端口上已有同类服务就别再起第二个——两个实例会抢同一个摄像头，
    输的那个 read 失败，前端就一直「摄像头读取失败」。"""
    import urllib.request
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/stats", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--engine", default="pt", choices=["pt", "onnx"])
    ap.add_argument("--source", default="0")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--port", type=int, default=5179)
    args = ap.parse_args()

    if already_running(args.port):
        print(f"\n  [!] 端口 {args.port} 已有摄像头服务在跑，本次直接退出。")
        print("      如需重启：先结束旧进程（或换 --port）。\n", flush=True)
        return 0

    det = Detector(args.weights, args.engine, args.imgsz, args.conf)
    worker = CameraWorker(args.source, det)
    worker.start()

    Handler.worker = worker
    Handler.pose = PoseEstimator()
    Handler.engine_name = args.engine

    # 等第一帧，顺便确认摄像头真的能用
    for _ in range(60):
        if worker.annotated is not None or worker.error:
            break
        time.sleep(0.2)

    print(f"\n  摄像头检测服务 → http://127.0.0.1:{args.port}")
    print(f"  实时流: /video    快照: /snapshot    检测: /detect    姿态: /pose    状态: /stats")
    print(f"  状态: {worker.error or '就绪'}\n", flush=True)

    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
